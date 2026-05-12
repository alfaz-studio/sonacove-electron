// binding.cpp — N-API surface for WinAudioCapture.
//
// Mirrors native/macaudio/src/binding.mm. Why a TSFN: WASAPI delivers
// buffers on a dedicated capture thread, which is NOT the V8 thread. We
// need a thread-safe function (TSFN) to bounce each buffer back into JS
// land. The TSFN is created with an unlimited queue — realistic
// backpressure happens via WebAudio later in the pipeline; if we dropped
// here we'd add an extra failure mode that's harder to reason about.

#include "WinAudioCapture.h"

#include <napi.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

namespace {

struct Module {
    std::mutex mu;
    std::unique_ptr<sonacove::WinAudioCapture> capture;
    Napi::ThreadSafeFunction tsfn;
    bool tsfnAcquired = false;
};

Module& module() {
    static Module m;

    return m;
}

struct PendingBuffer {
    std::vector<float> samples;
    double sampleRate;
    uint32_t channels;
};

void dispatchBufferToJS(Napi::Env env, Napi::Function callback,
                        std::nullptr_t*, PendingBuffer* data) {
    if (data == nullptr) {
        return;
    }

    std::unique_ptr<PendingBuffer> owned(data);

    if (env != nullptr && callback != nullptr) {
        Napi::HandleScope scope(env);
        const size_t bytes = owned->samples.size() * sizeof(float);

        Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(
            env, reinterpret_cast<const uint8_t*>(owned->samples.data()), bytes);

        Napi::Object meta = Napi::Object::New(env);

        meta.Set("sampleRate", owned->sampleRate);
        meta.Set("channels", owned->channels);
        meta.Set("frameCount",
                 static_cast<double>(owned->samples.size() / owned->channels));

        callback.Call({buf, meta});
    }
}

Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "start(opts: object, callback: fn)")
            .ThrowAsJavaScriptException();

        return env.Undefined();
    }

    Napi::Object opts = info[0].As<Napi::Object>();

    sonacove::WinAudioCapture::StartOptions startOpts;

    startOpts.sampleRate =
        opts.Has("sampleRate") ? opts.Get("sampleRate").ToNumber().DoubleValue()
                               : 48000.0;
    startOpts.channelCount = opts.Has("channels")
                                  ? opts.Get("channels").ToNumber().Uint32Value()
                                  : 2;
    startOpts.verboseProcessTree =
        opts.Has("verboseProcessTree")
            && opts.Get("verboseProcessTree").ToBoolean().Value();

    auto& m = module();
    std::lock_guard<std::mutex> lock(m.mu);

    if (m.capture && m.capture->isRunning()) {
        return Napi::Boolean::New(env, true);
    }

    m.tsfn = Napi::ThreadSafeFunction::New(
        env, info[1].As<Napi::Function>(), "WinAudioCaptureCallback",
        0, // unlimited queue
        1  // single thread (the WASAPI capture thread)
    );
    m.tsfnAcquired = true;

    m.capture = std::make_unique<sonacove::WinAudioCapture>();

    auto onAudio = [](const float* samples, size_t frameCount,
                      sonacove::AudioFormat fmt) {
        auto& mm = module();

        if (!mm.tsfnAcquired) {
            return;
        }

        auto* pb = new PendingBuffer();

        pb->samples.assign(samples, samples + (frameCount * fmt.channelCount));
        pb->sampleRate = fmt.sampleRate;
        pb->channels = fmt.channelCount;

        napi_status st = mm.tsfn.BlockingCall(
            pb,
            [](Napi::Env env, Napi::Function cb, PendingBuffer* data) {
                dispatchBufferToJS(env, cb, nullptr, data);
            });

        if (st != napi_ok) {
            delete pb;
        }
    };

    auto onError = [](int code, const char* msg) {
        auto& mm = module();

        if (!mm.tsfnAcquired) {
            return;
        }

        struct ErrPb {
            int code;
            std::string message;
        };

        auto* ep = new ErrPb{code, msg ? msg : ""};

        mm.tsfn.BlockingCall(
            ep, [](Napi::Env env, Napi::Function cb, ErrPb* data) {
              std::unique_ptr<ErrPb> owned(data);

              if (env != nullptr && cb != nullptr) {
                  Napi::HandleScope scope(env);
                  Napi::Object meta = Napi::Object::New(env);

                  meta.Set("error", true);
                  meta.Set("code", owned->code);
                  meta.Set("message", owned->message);
                  cb.Call({env.Null(), meta});
              }
            });
    };

    const bool ok = m.capture->start(startOpts, onAudio, onError);

    if (!ok) {
        // start() failed — release the TSFN we acquired above and drop
        // the (non-running) capture instance. Otherwise a next Start()
        // overwrites m.tsfn without releasing it (a TSFN leak per
        // failed call) and the stale capture sticks around.
        m.capture.reset();
        if (m.tsfnAcquired) {
            m.tsfn.Release();
            m.tsfnAcquired = false;
        }
    }

    return Napi::Boolean::New(env, ok);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
    auto& m = module();
    std::lock_guard<std::mutex> lock(m.mu);

    if (m.capture) {
        m.capture->stop();
        m.capture.reset();
    }

    if (m.tsfnAcquired) {
        m.tsfn.Release();
        m.tsfnAcquired = false;
    }

    return info.Env().Undefined();
}

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
    auto& m = module();
    std::lock_guard<std::mutex> lock(m.mu);

    return Napi::Boolean::New(info.Env(),
                              m.capture && m.capture->isRunning());
}

// Diagnostics — non-capture function that gathers PID tree, Windows
// version, COM state, and (if smokeTest=true) runs the full activation
// chain WITHOUT starting capture. The Win11 test session can call this
// before committing to a real capture session to maximize signal per
// run and isolate activation issues from capture issues.
Napi::Value Diagnostics(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    const bool smoke =
        info.Length() > 0 && info[0].IsBoolean() && info[0].As<Napi::Boolean>().Value();

    sonacove::DiagnosticsSnapshot snap = sonacove::collectDiagnostics(smoke);

    Napi::Object out = Napi::Object::New(env);

    out.Set("currentProcessId",
            Napi::Number::New(env, snap.currentProcessId));
    out.Set("childPids", Napi::String::New(env, snap.childPids));
    out.Set("descendantPids", Napi::String::New(env, snap.descendantPids));
    out.Set("windowsVersion", Napi::String::New(env, snap.windowsVersion));
    out.Set("comInitFresh", Napi::Boolean::New(env, snap.comInitFresh));
    out.Set("smokeTestRan", Napi::Boolean::New(env, smoke));
    out.Set("smokeTestHresult",
            Napi::Number::New(env,
                              static_cast<double>(snap.smokeTestHresult)));
    out.Set("mixFormatDescription",
            Napi::String::New(env, snap.mixFormatDescription));

    return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("isRunning", Napi::Function::New(env, IsRunning));
    exports.Set("diagnostics", Napi::Function::New(env, Diagnostics));

    return exports;
}

} // namespace

NODE_API_MODULE(winaudio, Init)
