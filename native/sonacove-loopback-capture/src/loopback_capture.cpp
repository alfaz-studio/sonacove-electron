#include "loopback_capture.h"
#include <functiondiscoverykeys_devpkey.h>
#include <combaseapi.h>
#include <cstring>

// ────────────────────────────────────────────────────────────────────
// IActivateAudioInterfaceCompletionHandler implementation
// Used by ActivateAudioInterfaceAsync to signal completion.
// ────────────────────────────────────────────────────────────────────
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ActivationHandler() : refCount_(1) {
        completionEvent_ = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    }

    ~ActivationHandler() {
        if (completionEvent_) {
            CloseHandle(completionEvent_);
        }
    }

    // IUnknown
    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&refCount_);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        ULONG ref = InterlockedDecrement(&refCount_);
        if (ref == 0) {
            delete this;
        }
        return ref;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    // IActivateAudioInterfaceCompletionHandler
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hrActivate = S_OK;
        IUnknown* punkAudioInterface = nullptr;
        HRESULT hr = op->GetActivateResult(&hrActivate, &punkAudioInterface);

        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && punkAudioInterface) {
            punkAudioInterface->QueryInterface(__uuidof(IAudioClient), (void**)&audioClient_);
            punkAudioInterface->Release();
        }
        activateResult_ = SUCCEEDED(hr) ? hrActivate : hr;
        SetEvent(completionEvent_);
        return S_OK;
    }

    bool Wait(DWORD timeoutMs = 5000) {
        return WaitForSingleObject(completionEvent_, timeoutMs) == WAIT_OBJECT_0;
    }

    IAudioClient* GetAudioClient() { return audioClient_; }
    HRESULT GetResult() { return activateResult_; }

private:
    LONG refCount_;
    HANDLE completionEvent_;
    IAudioClient* audioClient_ = nullptr;
    HRESULT activateResult_ = E_FAIL;
};

// ────────────────────────────────────────────────────────────────────
// LoopbackCapture
// ────────────────────────────────────────────────────────────────────

LoopbackCapture::LoopbackCapture() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
}

LoopbackCapture::~LoopbackCapture() {
    Stop();
    CoUninitialize();
}

bool LoopbackCapture::IsSupported() {
    // Probe by actually attempting ActivateAudioInterfaceAsync with
    // PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE. Docs say Build 20348+
    // but OBS confirms related APIs work on Win10 22H2 (19045). Testing is the
    // only reliable way to know.
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = GetCurrentProcessId();
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activateParam = {};
    activateParam.vt = VT_BLOB;
    activateParam.blob.cbSize = sizeof(params);
    activateParam.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    auto handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateParam,
        handler,
        &asyncOp);

    bool supported = false;

    if (SUCCEEDED(hr) && handler->Wait(3000)) {
        supported = SUCCEEDED(handler->GetResult()) && handler->GetAudioClient() != nullptr;
        // Release the probed audio client — we don't need it
        IAudioClient* client = handler->GetAudioClient();
        if (client) {
            client->Release();
        }
    }

    if (asyncOp) asyncOp->Release();
    handler->Release();

    CoUninitialize();

    return supported;
}

void LoopbackCapture::ProbeApi(long asyncHr[2], long activateHr[2], bool hasClient[2]) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    PROCESS_LOOPBACK_MODE modes[2] = {
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
    };

    for (int i = 0; i < 2; i++) {
        AUDIOCLIENT_ACTIVATION_PARAMS params = {};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId = GetCurrentProcessId();
        params.ProcessLoopbackParams.ProcessLoopbackMode = modes[i];

        PROPVARIANT activateParam = {};
        activateParam.vt = VT_BLOB;
        activateParam.blob.cbSize = sizeof(params);
        activateParam.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

        auto handler = new ActivationHandler();
        IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

        HRESULT hr = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            __uuidof(IAudioClient),
            &activateParam,
            handler,
            &asyncOp);

        asyncHr[i] = hr;
        activateHr[i] = -1;
        hasClient[i] = false;

        if (SUCCEEDED(hr) && handler->Wait(3000)) {
            activateHr[i] = handler->GetResult();
            IAudioClient* client = handler->GetAudioClient();
            hasClient[i] = client != nullptr;
            if (client) client->Release();
        }

        if (asyncOp) asyncOp->Release();
        handler->Release();
    }

    CoUninitialize();
}

bool LoopbackCapture::IsIncludeSupported() {
    // Test INCLUDE mode — capture audio FROM a specific process.
    // OBS confirms this works on Win10 22H2 despite docs saying Build 20348+.
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = GetCurrentProcessId();
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activateParam = {};
    activateParam.vt = VT_BLOB;
    activateParam.blob.cbSize = sizeof(params);
    activateParam.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    auto handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateParam,
        handler,
        &asyncOp);

    bool supported = false;

    if (SUCCEEDED(hr) && handler->Wait(3000)) {
        supported = SUCCEEDED(handler->GetResult()) && handler->GetAudioClient() != nullptr;
        IAudioClient* client = handler->GetAudioClient();
        if (client) {
            client->Release();
        }
    }

    if (asyncOp) asyncOp->Release();
    handler->Release();

    CoUninitialize();

    return supported;
}

bool LoopbackCapture::GetDefaultFormat(uint32_t& sampleRate, uint32_t& channels) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* client = nullptr;
    WAVEFORMATEX* format = nullptr;
    bool result = false;

    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), (void**)&enumerator);

    if (SUCCEEDED(hr)) {
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    }
    if (SUCCEEDED(hr)) {
        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
    }
    if (SUCCEEDED(hr)) {
        hr = client->GetMixFormat(&format);
    }
    if (SUCCEEDED(hr) && format) {
        sampleRate = format->nSamplesPerSec;
        channels = format->nChannels;
        result = true;
        CoTaskMemFree(format);
    }

    if (client) client->Release();
    if (device) device->Release();
    if (enumerator) enumerator->Release();

    CoUninitialize();

    return result;
}

bool LoopbackCapture::Start(DWORD excludePid, void* sharedBuffer, size_t bufferByteLength) {
    if (running_.load()) return false;
    if (!sharedBuffer || bufferByteLength <= RING_BUFFER_HEADER_BYTES) return false;

    // Set up activation params for process loopback with exclusion
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = excludePid;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activateParam = {};
    activateParam.vt = VT_BLOB;
    activateParam.blob.cbSize = sizeof(activationParams);
    activateParam.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    // Activate the audio interface asynchronously
    auto handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateParam,
        handler,
        &asyncOp);

    if (FAILED(hr)) {
        handler->Release();
        return false;
    }

    if (!handler->Wait(5000) || FAILED(handler->GetResult())) {
        if (asyncOp) asyncOp->Release();
        handler->Release();
        return false;
    }

    audioClient_ = handler->GetAudioClient();
    if (asyncOp) asyncOp->Release();
    handler->Release();

    if (!audioClient_) return false;

    // Get the mix format
    WAVEFORMATEX* mixFormat = nullptr;
    hr = audioClient_->GetMixFormat(&mixFormat);
    if (FAILED(hr) || !mixFormat) {
        audioClient_->Release();
        audioClient_ = nullptr;
        return false;
    }

    channels_ = mixFormat->nChannels;
    uint32_t sampleRate = mixFormat->nSamplesPerSec;

    // Initialize the audio client in shared loopback mode
    // 50ms buffer duration (in 100ns units)
    REFERENCE_TIME bufferDuration = 500000;
    hr = audioClient_->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        bufferDuration, 0, mixFormat, nullptr);

    CoTaskMemFree(mixFormat);

    if (FAILED(hr)) {
        audioClient_->Release();
        audioClient_ = nullptr;
        return false;
    }

    // Create event for capture notifications
    captureEvent_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!captureEvent_) {
        audioClient_->Release();
        audioClient_ = nullptr;
        return false;
    }

    hr = audioClient_->SetEventHandle(captureEvent_);
    if (FAILED(hr)) {
        CloseHandle(captureEvent_);
        captureEvent_ = nullptr;
        audioClient_->Release();
        audioClient_ = nullptr;
        return false;
    }

    // Get the capture client
    hr = audioClient_->GetService(__uuidof(IAudioCaptureClient), (void**)&captureClient_);
    if (FAILED(hr)) {
        CloseHandle(captureEvent_);
        captureEvent_ = nullptr;
        audioClient_->Release();
        audioClient_ = nullptr;
        return false;
    }

    // Set up ring buffer pointers into the SharedArrayBuffer
    auto* headerBytes = static_cast<uint8_t*>(sharedBuffer);
    auto* header = reinterpret_cast<uint32_t*>(headerBytes);

    writePos_ = reinterpret_cast<std::atomic<uint32_t>*>(&header[0]);
    readPos_ = reinterpret_cast<std::atomic<uint32_t>*>(&header[1]);
    header[2] = sampleRate;
    header[3] = channels_;

    writePos_->store(0, std::memory_order_release);
    // Don't reset readPos — the AudioWorklet manages it

    pcmData_ = reinterpret_cast<float*>(headerBytes + RING_BUFFER_HEADER_BYTES);
    size_t dataBytes = bufferByteLength - RING_BUFFER_HEADER_BYTES;
    bufferFrames_ = static_cast<uint32_t>(dataBytes / (sizeof(float) * channels_));

    // Start capture
    hr = audioClient_->Start();
    if (FAILED(hr)) {
        captureClient_->Release();
        captureClient_ = nullptr;
        CloseHandle(captureEvent_);
        captureEvent_ = nullptr;
        audioClient_->Release();
        audioClient_ = nullptr;
        return false;
    }

    running_.store(true);
    captureThread_ = std::thread(&LoopbackCapture::CaptureLoop, this);

    return true;
}

void LoopbackCapture::Stop() {
    if (!running_.load()) return;

    running_.store(false);
    if (captureThread_.joinable()) {
        // Signal the event so the thread wakes up and checks running_
        if (captureEvent_) {
            SetEvent(captureEvent_);
        }
        captureThread_.join();
    }

    if (audioClient_) {
        audioClient_->Stop();
    }
    if (captureClient_) {
        captureClient_->Release();
        captureClient_ = nullptr;
    }
    if (captureEvent_) {
        CloseHandle(captureEvent_);
        captureEvent_ = nullptr;
    }
    if (audioClient_) {
        audioClient_->Release();
        audioClient_ = nullptr;
    }

    writePos_ = nullptr;
    readPos_ = nullptr;
    pcmData_ = nullptr;
    bufferFrames_ = 0;
}

void LoopbackCapture::CaptureLoop() {
    // Boost thread priority for low-latency audio
    HANDLE taskHandle = nullptr;
    DWORD taskIndex = 0;
    auto avrtDll = LoadLibraryW(L"avrt.dll");
    if (avrtDll) {
        typedef HANDLE(WINAPI* AvSetMmThreadCharacteristicsWPtr)(LPCWSTR, LPDWORD);
        auto avSetMmThread = reinterpret_cast<AvSetMmThreadCharacteristicsWPtr>(
            GetProcAddress(avrtDll, "AvSetMmThreadCharacteristicsW"));
        if (avSetMmThread) {
            taskHandle = avSetMmThread(L"Audio", &taskIndex);
        }
    }

    while (running_.load()) {
        DWORD waitResult = WaitForSingleObject(captureEvent_, 100);
        if (!running_.load()) break;
        if (waitResult != WAIT_OBJECT_0) continue;

        UINT32 packetLength = 0;
        HRESULT hr = captureClient_->GetNextPacketSize(&packetLength);

        while (SUCCEEDED(hr) && packetLength > 0 && running_.load()) {
            BYTE* data = nullptr;
            UINT32 numFrames = 0;
            DWORD flags = 0;

            hr = captureClient_->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            uint32_t wp = writePos_->load(std::memory_order_acquire);

            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // Write silence
                for (uint32_t i = 0; i < numFrames; i++) {
                    uint32_t pos = ((wp + i) % bufferFrames_) * channels_;
                    for (uint32_t ch = 0; ch < channels_; ch++) {
                        pcmData_[pos + ch] = 0.0f;
                    }
                }
            } else {
                // The WASAPI shared mode mix format is typically float32.
                // Copy interleaved float32 data into the ring buffer.
                const float* srcFloat = reinterpret_cast<const float*>(data);
                for (uint32_t i = 0; i < numFrames; i++) {
                    uint32_t pos = ((wp + i) % bufferFrames_) * channels_;
                    for (uint32_t ch = 0; ch < channels_; ch++) {
                        pcmData_[pos + ch] = srcFloat[i * channels_ + ch];
                    }
                }
            }

            writePos_->store((wp + numFrames) % bufferFrames_, std::memory_order_release);

            captureClient_->ReleaseBuffer(numFrames);
            hr = captureClient_->GetNextPacketSize(&packetLength);
        }
    }

    // Revert thread priority
    if (taskHandle && avrtDll) {
        typedef BOOL(WINAPI* AvRevertMmThreadCharacteristicsPtr)(HANDLE);
        auto avRevert = reinterpret_cast<AvRevertMmThreadCharacteristicsPtr>(
            GetProcAddress(avrtDll, "AvRevertMmThreadCharacteristics"));
        if (avRevert) {
            avRevert(taskHandle);
        }
    }
    if (avrtDll) {
        FreeLibrary(avrtDll);
    }
}
