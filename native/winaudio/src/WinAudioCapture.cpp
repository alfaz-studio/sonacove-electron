// Heavy logging is intentional — the API doesn't exist on Win10 so each
// test cycle on a Win11 box needs to surface maximum diagnostic info in
// one run.
//
// Reference: Windows-classic-samples/Samples/ApplicationLoopback.

#include "WinAudioCapture.h"

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <tlhelp32.h>
#include <wrl/implements.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

#pragma comment(lib, "Ole32.lib")
#pragma comment(lib, "Mmdevapi.lib")
#pragma comment(lib, "Avrt.lib")

// Compile-time field-existence checks. If any of these names disappear
// from the SDK (struct renames, enum value renames), we catch it on the
// Win10 dev box instead of on the Win11 test cycle. We don't bother
// asserting sizes — those vary slightly with packing/alignment and
// produce false positives across SDK versions.
static_assert(
    sizeof(decltype(AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS{}.TargetProcessId))
        == sizeof(DWORD),
    "TargetProcessId should be DWORD-shaped");
static_assert(
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK == 1,
    "AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK value changed; review API");

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;

namespace sonacove {

namespace {

void log(const char* fmt, ...) {
    va_list args;

    va_start(args, fmt);
    std::fprintf(stderr, "[winaudio] ");
    std::vfprintf(stderr, fmt, args);
    std::fprintf(stderr, "\n");
    std::fflush(stderr);
    va_end(args);
}

const char* hresultName(HRESULT hr) {
    switch (hr) {
        case S_OK:                                return "S_OK";
        case E_NOTIMPL:                           return "E_NOTIMPL";
        case E_NOINTERFACE:                      return "E_NOINTERFACE";
        case E_POINTER:                          return "E_POINTER";
        case E_INVALIDARG:                       return "E_INVALIDARG";
        case E_OUTOFMEMORY:                      return "E_OUTOFMEMORY";
        case E_FAIL:                             return "E_FAIL";
        case E_ACCESSDENIED:                     return "E_ACCESSDENIED";
        case AUDCLNT_E_NOT_INITIALIZED:          return "AUDCLNT_E_NOT_INITIALIZED";
        case AUDCLNT_E_ALREADY_INITIALIZED:      return "AUDCLNT_E_ALREADY_INITIALIZED";
        case AUDCLNT_E_WRONG_ENDPOINT_TYPE:      return "AUDCLNT_E_WRONG_ENDPOINT_TYPE";
        case AUDCLNT_E_DEVICE_INVALIDATED:       return "AUDCLNT_E_DEVICE_INVALIDATED";
        case AUDCLNT_E_NOT_STOPPED:              return "AUDCLNT_E_NOT_STOPPED";
        case AUDCLNT_E_BUFFER_TOO_LARGE:         return "AUDCLNT_E_BUFFER_TOO_LARGE";
        case AUDCLNT_E_OUT_OF_ORDER:             return "AUDCLNT_E_OUT_OF_ORDER";
        case AUDCLNT_E_UNSUPPORTED_FORMAT:       return "AUDCLNT_E_UNSUPPORTED_FORMAT";
        case AUDCLNT_E_INVALID_SIZE:             return "AUDCLNT_E_INVALID_SIZE";
        case AUDCLNT_E_DEVICE_IN_USE:            return "AUDCLNT_E_DEVICE_IN_USE";
        case AUDCLNT_E_BUFFER_OPERATION_PENDING: return "AUDCLNT_E_BUFFER_OPERATION_PENDING";
        case AUDCLNT_E_THREAD_NOT_REGISTERED:    return "AUDCLNT_E_THREAD_NOT_REGISTERED";
        case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED: return "AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED";
        case AUDCLNT_E_ENDPOINT_CREATE_FAILED:   return "AUDCLNT_E_ENDPOINT_CREATE_FAILED";
        case AUDCLNT_E_SERVICE_NOT_RUNNING:      return "AUDCLNT_E_SERVICE_NOT_RUNNING";
        case AUDCLNT_E_EVENTHANDLE_NOT_EXPECTED: return "AUDCLNT_E_EVENTHANDLE_NOT_EXPECTED";
        case AUDCLNT_E_EVENTHANDLE_NOT_SET:      return "AUDCLNT_E_EVENTHANDLE_NOT_SET";
        case AUDCLNT_E_INCORRECT_BUFFER_SIZE:    return "AUDCLNT_E_INCORRECT_BUFFER_SIZE";
        case AUDCLNT_E_BUFFER_SIZE_ERROR:        return "AUDCLNT_E_BUFFER_SIZE_ERROR";
        case AUDCLNT_E_CPUUSAGE_EXCEEDED:        return "AUDCLNT_E_CPUUSAGE_EXCEEDED";
        case AUDCLNT_E_BUFFER_ERROR:             return "AUDCLNT_E_BUFFER_ERROR";
        case AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED:  return "AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED";
        case AUDCLNT_S_BUFFER_EMPTY:             return "AUDCLNT_S_BUFFER_EMPTY";
        case AUDCLNT_S_THREAD_ALREADY_REGISTERED: return "AUDCLNT_S_THREAD_ALREADY_REGISTERED";
        case AUDCLNT_S_POSITION_STALLED:         return "AUDCLNT_S_POSITION_STALLED";
        default:                                 return nullptr;
    }
}

void logHr(const char* what, HRESULT hr) {
    const char* name = hresultName(hr);

    if (name) {
        log("%s: %s (0x%08lX)", what, name, hr);
    } else {
        log("%s: 0x%08lX", what, hr);
    }
}

std::string formatChildrenBfs(DWORD rootPid, int maxDepth);

// Signals an event when ActivateAudioInterfaceAsync completes, so start()
// can wait synchronously on the otherwise-async activation.
class ActivateCompleter
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
  public:
    ActivateCompleter() : doneEvent_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

    ~ActivateCompleter() {
        if (doneEvent_) {
            CloseHandle(doneEvent_);
        }
    }

    HANDLE doneEvent() const {
        return doneEvent_;
    }

    HRESULT activationResult() const {
        return activationResult_;
    }

    ComPtr<IUnknown> activatedInterface() const {
        return activatedInterface_;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(
            IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activationHr = E_FAIL;
        ComPtr<IUnknown> activatedInterface;

        const HRESULT getResultHr =
            operation->GetActivateResult(&activationHr, &activatedInterface);

        if (FAILED(getResultHr)) {
            activationResult_ = getResultHr;
            logHr("GetActivateResult failed", getResultHr);
        } else {
            activationResult_ = activationHr;
            logHr("Activation result", activationHr);

            if (SUCCEEDED(activationHr)) {
                activatedInterface_ = activatedInterface;
            }
        }

        SetEvent(doneEvent_);

        return S_OK;
    }

  private:
    HANDLE doneEvent_ = nullptr;
    HRESULT activationResult_ = E_PENDING;
    ComPtr<IUnknown> activatedInterface_;
};

} // namespace

struct WinAudioCapture::Impl {
    std::atomic<bool> running{false};
    std::atomic<bool> stopRequested{false};

    HANDLE audioReadyEvent = nullptr;
    HANDLE stopEvent = nullptr;

    ComPtr<IAudioClient> audioClient;
    ComPtr<IAudioCaptureClient> captureClient;
    WAVEFORMATEX* mixFormat = nullptr; // CoTaskMemFree on cleanup

    std::thread captureThread;
    mutable std::mutex stateMu;

    AudioBufferCallback onAudio;
    ErrorCallback onError;

    // True iff THIS Impl owns a CoInitializeEx that hasn't been matched
    // by a CoUninitialize yet. start() sets it on a successful S_OK
    // init; stop() honors it. Without the flag, a failed start (returns
    // false before stop is ever called) would leak the COM reference,
    // and a stop after RPC_E_CHANGED_MODE would un-init COM that
    // someone else owned.
    bool comInitOwned = false;

    void cleanup();
    void captureLoop();
    void emitError(int code, const char* message);

    bool formatIsFloat32 = false;
};

void WinAudioCapture::Impl::cleanup() {
    captureClient.Reset();

    if (audioClient) {
        audioClient->Stop();
        audioClient.Reset();
    }

    if (mixFormat) {
        CoTaskMemFree(mixFormat);
        mixFormat = nullptr;
    }

    if (audioReadyEvent) {
        CloseHandle(audioReadyEvent);
        audioReadyEvent = nullptr;
    }

    if (stopEvent) {
        CloseHandle(stopEvent);
        stopEvent = nullptr;
    }
}

void WinAudioCapture::Impl::emitError(int code, const char* message) {
    if (onError) {
        onError(code, message);
    }
}

void WinAudioCapture::Impl::captureLoop() {
    // Pro Audio MMCSS scheduling class — audio-thread priority boost so
    // the capture thread doesn't get starved by V8 work. RAII guard
    // guarantees AvRevertMmThreadCharacteristics on every exit path
    // (including the `return` cases below where we bail on stream error).
    struct MmcssGuard {
        HANDLE h;

        ~MmcssGuard() {
            if (h) {
                AvRevertMmThreadCharacteristics(h);
            }
        }
    };
    DWORD mmcssTaskIndex = 0;
    MmcssGuard mmcss{ AvSetMmThreadCharacteristicsW(L"Pro Audio",
                                                    &mmcssTaskIndex) };

    if (!mmcss.h) {
        log("AvSetMmThreadCharacteristics failed (GLE=%lu) — running at "
            "default priority", GetLastError());
    }

    log("capture thread started");

    HANDLE waitHandles[2] = { audioReadyEvent, stopEvent };

    // Reusable Float32 staging buffer so we don't reallocate every callback.
    // Size grows monotonically to fit the largest packet we see — packets
    // are typically ~480 frames (10ms at 48kHz) for shared-mode streams.
    std::vector<float> stagingF32;

    uint64_t buffersDelivered = 0;
    uint64_t framesDelivered = 0;
    const uint64_t kLogEveryNBuffers = 100;

    while (!stopRequested.load(std::memory_order_acquire)) {
        const DWORD waitResult =
            WaitForMultipleObjects(2, waitHandles, FALSE, 2000);

        if (waitResult == WAIT_OBJECT_0 + 1) {
            // stopEvent
            log("stop event signaled, exiting capture loop");
            break;
        }

        if (waitResult == WAIT_TIMEOUT) {
            log("capture wait timeout (2s) — no audio events; mixer may be "
                "idle or stream is starved");
            continue;
        }

        if (waitResult != WAIT_OBJECT_0) {
            log("WaitForMultipleObjects unexpected result %lu (GLE=%lu); "
                "exiting capture loop", waitResult, GetLastError());
            emitError(static_cast<int>(GetLastError()), "wait-failed");
            break;
        }

        // Drain all packets currently available; the event fires per-buffer
        // but the device can backlog multiple buffers while we were busy.
        UINT32 packetSize = 0;
        HRESULT hr = captureClient->GetNextPacketSize(&packetSize);

        if (FAILED(hr)) {
            logHr("GetNextPacketSize failed", hr);
            emitError(static_cast<int>(hr), "get-next-packet-size-failed");
            break;
        }

        while (packetSize > 0) {
            BYTE* data = nullptr;
            UINT32 framesInPacket = 0;
            DWORD flags = 0;

            hr = captureClient->GetBuffer(&data, &framesInPacket, &flags,
                                          nullptr, nullptr);

            if (FAILED(hr)) {
                logHr("GetBuffer failed", hr);
                emitError(static_cast<int>(hr), "get-buffer-failed");

                return;
            }

            const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

            const size_t totalSamples =
                static_cast<size_t>(framesInPacket) * mixFormat->nChannels;

            stagingF32.resize(totalSamples);

            if (silent || !formatIsFloat32) {
                // SILENT flag is set by the endpoint when no app is
                // producing audio. Non-Float32 should never happen for
                // process-loopback per MSDN, but if it ever does, emit
                // silence rather than risk a wrong-conversion noise
                // burst (which could be unexpectedly loud and confuse
                // the test signal).
                std::memset(stagingF32.data(), 0,
                            totalSamples * sizeof(float));
            } else {
                std::memcpy(stagingF32.data(), data,
                            totalSamples * sizeof(float));
            }

            hr = captureClient->ReleaseBuffer(framesInPacket);
            if (FAILED(hr)) {
                logHr("ReleaseBuffer failed", hr);
                emitError(static_cast<int>(hr), "release-buffer-failed");

                return;
            }

            if (onAudio) {
                AudioFormat fmt;

                fmt.sampleRate = mixFormat->nSamplesPerSec;
                fmt.channelCount = mixFormat->nChannels;
                onAudio(stagingF32.data(),
                        static_cast<size_t>(framesInPacket), fmt);
            }

            buffersDelivered++;
            framesDelivered += framesInPacket;

            if (buffersDelivered % kLogEveryNBuffers == 0) {
                const float firstSample =
                    stagingF32.empty() ? 0.0f : stagingF32[0];

                log("delivered %llu buffers, %llu frames; last packet=%u "
                    "frames silent=%d first-sample=%.6f",
                    static_cast<unsigned long long>(buffersDelivered),
                    static_cast<unsigned long long>(framesDelivered),
                    framesInPacket, silent ? 1 : 0, firstSample);
            }

            hr = captureClient->GetNextPacketSize(&packetSize);
            if (FAILED(hr)) {
                logHr("GetNextPacketSize (drain) failed", hr);
                emitError(static_cast<int>(hr), "get-next-packet-drain-failed");

                return;
            }
        }
    }

    log("capture loop exiting; delivered %llu buffers / %llu frames",
        static_cast<unsigned long long>(buffersDelivered),
        static_cast<unsigned long long>(framesDelivered));

    // MMCSS reverts via the MmcssGuard destructor on scope exit.
}

WinAudioCapture::WinAudioCapture() : impl_(std::make_unique<Impl>()) {}

WinAudioCapture::~WinAudioCapture() {
    stop();
    // impl_ destroys here — definition of Impl is visible in this .cpp
    // so unique_ptr can call ~Impl().
}

bool WinAudioCapture::start(StartOptions opts,
                            AudioBufferCallback onAudio,
                            ErrorCallback onError) {
    std::lock_guard<std::mutex> lock(impl_->stateMu);

    if (impl_->running.load(std::memory_order_acquire)) {
        log("start: already running");

        return true;
    }

    impl_->onAudio = std::move(onAudio);
    impl_->onError = std::move(onError);
    impl_->stopRequested.store(false, std::memory_order_release);

    if (opts.verboseProcessTree) {
        // Dump the full descendant PID list so the test session log
        // shows whether Chromium's audio service is discoverable from
        // our tree. If it isn't, EXCLUDE_TARGET_PROCESS_TREE can't
        // catch it regardless of what mode we pass.
        const std::string descendants =
            formatChildrenBfs(GetCurrentProcessId(), 6);

        log("start: verboseProcessTree — our PID %lu, descendants (BFS d=6): %s",
            GetCurrentProcessId(), descendants.c_str());
    }

    // MTA so the capture thread doesn't need its own apartment. S_OK
    // means we initialized; S_FALSE means already initialized in the
    // same mode (we DO own a ref still); RPC_E_CHANGED_MODE means
    // somebody else owns the apartment and we don't.
    const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    if (FAILED(coHr) && coHr != RPC_E_CHANGED_MODE) {
        logHr("CoInitializeEx failed", coHr);
        impl_->emitError(static_cast<int>(coHr), "coinit-failed");

        return false;
    }
    impl_->comInitOwned = (coHr == S_OK || coHr == S_FALSE);

    // Every early-return from this point on must release the COM init
    // reference we took above (if we own one). Otherwise a failed
    // start() leaks the ref and a subsequent stop() never gets called
    // to pair it. Capture impl_ explicitly so future Impl-splitting
    // refactors stay obvious — `[&]` would silently follow whatever
    // happens to the surrounding scope.
    auto* implPtr = impl_.get();
    auto failStart = [implPtr]() -> bool {
        if (implPtr->comInitOwned) {
            CoUninitialize();
            implPtr->comInitOwned = false;
        }

        return false;
    };

    // Process-loopback excluding our PID tree — captures system audio
    // minus what Chromium is playing back, cutting the feedback loop.
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};

    activationParams.ActivationType =
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId =
        GetCurrentProcessId();
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    log("start: PID=%lu, requesting EXCLUDE_TARGET_PROCESS_TREE",
        activationParams.ProcessLoopbackParams.TargetProcessId);

    PROPVARIANT activationProp = {};

    activationProp.vt = VT_BLOB;
    activationProp.blob.cbSize = sizeof(activationParams);
    activationProp.blob.pBlobData =
        reinterpret_cast<BYTE*>(&activationParams);

    ComPtr<ActivateCompleter> completer =
        Microsoft::WRL::Make<ActivateCompleter>();

    if (!completer) {
        log("Failed to allocate ActivateCompleter");
        impl_->emitError(static_cast<int>(E_OUTOFMEMORY),
                         "completer-alloc-failed");

        return failStart();
    }

    ComPtr<IActivateAudioInterfaceAsyncOperation> activationOp;
    const HRESULT activateHr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
        &activationProp, completer.Get(), &activationOp);

    if (FAILED(activateHr)) {
        logHr("ActivateAudioInterfaceAsync failed", activateHr);
        impl_->emitError(static_cast<int>(activateHr),
                         "activate-async-failed");

        return failStart();
    }

    // Wait synchronously for activation to complete. Activation should
    // settle within tens of ms; a 2s ceiling guards against the OS hanging.
    const DWORD waitResult =
        WaitForSingleObject(completer->doneEvent(), 2000);

    if (waitResult != WAIT_OBJECT_0) {
        log("activation wait failed/timed out: result=%lu GLE=%lu",
            waitResult, GetLastError());
        impl_->emitError(static_cast<int>(GetLastError()),
                         "activation-wait-failed");

        return failStart();
    }

    const HRESULT actResult = completer->activationResult();

    if (FAILED(actResult)) {
        logHr("activation result failed", actResult);
        impl_->emitError(static_cast<int>(actResult), "activation-failed");

        return failStart();
    }

    ComPtr<IUnknown> activated = completer->activatedInterface();

    if (!activated) {
        log("activation succeeded but no interface returned");
        impl_->emitError(static_cast<int>(E_NOINTERFACE), "no-interface");

        return failStart();
    }

    HRESULT hr = activated.As(&impl_->audioClient);
    if (FAILED(hr)) {
        logHr("QueryInterface(IAudioClient) failed", hr);
        impl_->emitError(static_cast<int>(hr), "qi-iaudioclient-failed");

        return failStart();
    }

    // The process-loopback virtual device returns a fixed Float32 mix
    // format — but we still query so our format-conversion path stays
    // robust to future changes and so we can log what we actually got.
    hr = impl_->audioClient->GetMixFormat(&impl_->mixFormat);
    if (FAILED(hr)) {
        logHr("GetMixFormat failed", hr);
        impl_->emitError(static_cast<int>(hr), "get-mix-format-failed");

        return failStart();
    }

    log("GetMixFormat: tag=0x%04X channels=%u samplesPerSec=%lu "
        "bitsPerSample=%u blockAlign=%u cbSize=%u",
        impl_->mixFormat->wFormatTag, impl_->mixFormat->nChannels,
        impl_->mixFormat->nSamplesPerSec, impl_->mixFormat->wBitsPerSample,
        impl_->mixFormat->nBlockAlign, impl_->mixFormat->cbSize);

    // Per MSDN, process-loopback always negotiates Float32. Detect it
    // explicitly — anything else is logged and the capture thread emits
    // silence rather than risking a wrong-format conversion.
    impl_->formatIsFloat32 = false;
    if (impl_->mixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT
            && impl_->mixFormat->wBitsPerSample == 32) {
        impl_->formatIsFloat32 = true;
    } else if (impl_->mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE
               && impl_->mixFormat->cbSize >= 22) {
        const WAVEFORMATEXTENSIBLE* ext =
            reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(impl_->mixFormat);

        if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                && impl_->mixFormat->wBitsPerSample == 32) {
            impl_->formatIsFloat32 = true;
        }
    }

    if (!impl_->formatIsFloat32) {
        log("WARNING: mix format is not Float32 (tag=0x%04X bits=%u); "
            "capture thread will emit silence",
            impl_->mixFormat->wFormatTag, impl_->mixFormat->wBitsPerSample);
    }

    // Event handle for audio-ready notifications. Buffer duration of 0
    // tells WASAPI to pick a sensible default for shared-mode — typically
    // ~10ms.
    impl_->audioReadyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    impl_->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

    if (!impl_->audioReadyEvent || !impl_->stopEvent) {
        log("CreateEvent failed: GLE=%lu", GetLastError());
        impl_->emitError(static_cast<int>(GetLastError()),
                         "create-event-failed");
        impl_->cleanup();

        return failStart();
    }

    // LOOPBACK as a stream flag is required for process-loopback even
    // though activation already configured it — leaving it off is a
    // common pitfall.
    const DWORD streamFlags =
        AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;

    hr = impl_->audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                        streamFlags, 0, 0,
                                        impl_->mixFormat, nullptr);

    if (FAILED(hr)) {
        logHr("Initialize failed", hr);
        impl_->emitError(static_cast<int>(hr), "initialize-failed");
        impl_->cleanup();

        return failStart();
    }

    hr = impl_->audioClient->SetEventHandle(impl_->audioReadyEvent);
    if (FAILED(hr)) {
        logHr("SetEventHandle failed", hr);
        impl_->emitError(static_cast<int>(hr), "set-event-handle-failed");
        impl_->cleanup();

        return failStart();
    }

    UINT32 bufferFrames = 0;

    impl_->audioClient->GetBufferSize(&bufferFrames);
    log("Initialize OK: buffer=%u frames (~%.2fms at %u Hz)", bufferFrames,
        bufferFrames * 1000.0 / impl_->mixFormat->nSamplesPerSec,
        impl_->mixFormat->nSamplesPerSec);

    hr = impl_->audioClient->GetService(__uuidof(IAudioCaptureClient),
                                        &impl_->captureClient);
    if (FAILED(hr)) {
        logHr("GetService(IAudioCaptureClient) failed", hr);
        impl_->emitError(static_cast<int>(hr), "get-capture-client-failed");
        impl_->cleanup();

        return failStart();
    }

    hr = impl_->audioClient->Start();
    if (FAILED(hr)) {
        logHr("audioClient->Start failed", hr);
        impl_->emitError(static_cast<int>(hr), "audioclient-start-failed");
        impl_->cleanup();

        return failStart();
    }

    impl_->running.store(true, std::memory_order_release);
    impl_->captureThread =
        std::thread(&Impl::captureLoop, impl_.get());

    log("start succeeded");

    return true;
}

void WinAudioCapture::stop() {
    std::lock_guard<std::mutex> lock(impl_->stateMu);

    if (!impl_->running.load(std::memory_order_acquire)) {
        return;
    }

    log("stop requested");

    impl_->stopRequested.store(true, std::memory_order_release);
    if (impl_->stopEvent) {
        SetEvent(impl_->stopEvent);
    }

    if (impl_->captureThread.joinable()) {
        impl_->captureThread.join();
    }

    impl_->running.store(false, std::memory_order_release);
    impl_->cleanup();

    // Only undo the COM init if start() actually took one — the
    // RPC_E_CHANGED_MODE path leaves comInitOwned=false because another
    // caller already owns the apartment.
    if (impl_->comInitOwned) {
        CoUninitialize();
        impl_->comInitOwned = false;
    }

    log("stop complete");
}

bool WinAudioCapture::isRunning() const {
    return impl_->running.load(std::memory_order_acquire);
}

namespace {

// BFS the process tree up to MAX_DEPTH levels deep. Returns a flat list
// of PIDs (excluding the root). Used to expose Chromium's full process
// graph so the test session can verify the audio service is in there.
std::string formatChildrenBfs(DWORD rootPid, int maxDepth) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);

    if (snap == INVALID_HANDLE_VALUE) {
        return "<snapshot-failed>";
    }

    std::vector<std::pair<DWORD, DWORD>> all; // child, parent
    PROCESSENTRY32W pe = {};

    pe.dwSize = sizeof(pe);

    if (Process32FirstW(snap, &pe)) {
        do {
            all.emplace_back(pe.th32ProcessID, pe.th32ParentProcessID);
        } while (Process32NextW(snap, &pe));
    }

    CloseHandle(snap);

    std::vector<DWORD> frontier{ rootPid };
    std::vector<DWORD> descendants;

    for (int depth = 0; depth < maxDepth && !frontier.empty(); ++depth) {
        std::vector<DWORD> next;

        for (DWORD parent : frontier) {
            for (auto& [ pid, ppid ] : all) {
                if (ppid == parent && pid != parent) {
                    descendants.push_back(pid);
                    next.push_back(pid);
                }
            }
        }
        frontier = std::move(next);
    }

    if (descendants.empty()) {
        return "<none>";
    }

    std::string out;

    for (size_t i = 0; i < descendants.size(); ++i) {
        if (i > 0) {
            out += ",";
        }
        out += std::to_string(descendants[i]);
    }

    return out;
}

std::string formatChildrenDirect(DWORD rootPid) {
    return formatChildrenBfs(rootPid, 1);
}

// RtlGetVersion via undocumented ntdll export. GetVersionEx lies on
// Win10/11 (always returns 6.2 unless the manifest opts in); RtlGetVersion
// returns the real numbers. Used for the test-log to confirm we're
// actually on Win11 21H2+.
std::string formatWindowsVersion() {
    typedef LONG(WINAPI* RtlGetVersionFn)(OSVERSIONINFOEXW*);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");

    if (!ntdll) {
        return "<no-ntdll>";
    }

    auto fn = reinterpret_cast<RtlGetVersionFn>(
        GetProcAddress(ntdll, "RtlGetVersion"));

    if (!fn) {
        return "<no-RtlGetVersion>";
    }

    OSVERSIONINFOEXW info = {};

    info.dwOSVersionInfoSize = sizeof(info);
    fn(&info);

    char buf[64];

    std::snprintf(buf, sizeof(buf), "%lu.%lu.%lu",
                  info.dwMajorVersion, info.dwMinorVersion,
                  info.dwBuildNumber);

    return buf;
}

std::string formatMixFormatBrief(WAVEFORMATEX* fmt) {
    if (!fmt) {
        return "<null>";
    }

    char buf[128];

    std::snprintf(buf, sizeof(buf),
                  "tag=0x%04X ch=%u Hz=%lu bits=%u cb=%u",
                  fmt->wFormatTag, fmt->nChannels, fmt->nSamplesPerSec,
                  fmt->wBitsPerSample, fmt->cbSize);

    return buf;
}

} // anonymous namespace

DiagnosticsSnapshot collectDiagnostics(bool runSmokeTest) {
    DiagnosticsSnapshot snap;

    snap.currentProcessId = GetCurrentProcessId();
    snap.childPids = formatChildrenDirect(snap.currentProcessId);
    snap.descendantPids = formatChildrenBfs(snap.currentProcessId, 6);
    snap.windowsVersion = formatWindowsVersion();

    // CoInitializeEx returns S_FALSE if already initialized in the same
    // mode, RPC_E_CHANGED_MODE if a different mode is set. Either way the
    // caller has working COM; we just note whether THIS call did the
    // fresh init.
    const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    snap.comInitFresh = (coHr == S_OK);

    log("diagnostics: PID=%u children=%s windowsVersion=%s comInitFresh=%d",
        snap.currentProcessId, snap.childPids.c_str(),
        snap.windowsVersion.c_str(), snap.comInitFresh ? 1 : 0);
    log("diagnostics: descendants=%s", snap.descendantPids.c_str());

    if (!runSmokeTest) {
        if (coHr == S_OK || coHr == S_FALSE) {
            CoUninitialize();
        }

        return snap;
    }

    // ------------------------------------------------------------
    // Smoke test — full activation path WITHOUT IAudioClient::Start
    // ------------------------------------------------------------
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};

    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = snap.currentProcessId;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT prop = {};

    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof(params);
    prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ComPtr<ActivateCompleter> completer =
        Microsoft::WRL::Make<ActivateCompleter>();

    if (!completer) {
        snap.smokeTestHresult = static_cast<uint32_t>(E_OUTOFMEMORY);

        if (coHr == S_OK || coHr == S_FALSE) {
            CoUninitialize();
        }

        return snap;
    }

    ComPtr<IActivateAudioInterfaceAsyncOperation> op;
    HRESULT activateHr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
        &prop, completer.Get(), &op);

    if (FAILED(activateHr)) {
        snap.smokeTestHresult = static_cast<uint32_t>(activateHr);
        logHr("smokeTest: ActivateAudioInterfaceAsync failed", activateHr);

        if (coHr == S_OK || coHr == S_FALSE) {
            CoUninitialize();
        }

        return snap;
    }

    if (WaitForSingleObject(completer->doneEvent(), 2000) != WAIT_OBJECT_0) {
        snap.smokeTestHresult = static_cast<uint32_t>(E_PENDING);
        log("smokeTest: activation wait timed out");

        if (coHr == S_OK || coHr == S_FALSE) {
            CoUninitialize();
        }

        return snap;
    }

    const HRESULT actResult = completer->activationResult();

    snap.smokeTestHresult = static_cast<uint32_t>(actResult);

    if (FAILED(actResult)) {
        logHr("smokeTest: activation result", actResult);

        if (coHr == S_OK || coHr == S_FALSE) {
            CoUninitialize();
        }

        return snap;
    }

    ComPtr<IAudioClient> client;

    if (SUCCEEDED(completer->activatedInterface().As(&client))) {
        WAVEFORMATEX* mix = nullptr;

        if (SUCCEEDED(client->GetMixFormat(&mix))) {
            snap.mixFormatDescription = formatMixFormatBrief(mix);
            log("smokeTest: mixFormat = %s",
                snap.mixFormatDescription.c_str());
            CoTaskMemFree(mix);
        }
    }

    // Intentionally DON'T call Start() — smoke test ends here so we
    // never commit to a capture session.

    if (coHr == S_OK || coHr == S_FALSE) {
        CoUninitialize();
    }

    log("smokeTest: PASSED — activation + mix format query OK");

    return snap;
}

} // namespace sonacove
