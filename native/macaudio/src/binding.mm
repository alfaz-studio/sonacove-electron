// binding.mm — N-API surface for MacAudioCapture.
//
// Why a TSFN: SCStream delivers buffers on a private dispatch queue, which is
// NOT the V8 thread. We need a thread-safe function (TSFN) to bounce each
// buffer back into JS land. The TSFN is created with an unlimited queue —
// realistic backpressure happens via WebAudio later in the pipeline; if we
// dropped here we'd add an extra failure mode that's harder to reason about.

#import "MacAudioCapture.h"

#include <napi.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

namespace {

// Wrapper holding the singleton capture instance + a lock guarding
// start/stop transitions. We expose a stateless module surface (start,
// stop, isRunning) rather than a class, because there's no useful case
// for two simultaneous captures: one stream per process is the supported
// SCStream model and a second consumer would just steal the audio
// callback target.
struct Module {
    std::mutex mu;
    std::unique_ptr<sonacove::MacAudioCapture> capture;
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

        // Copy into a Buffer the JS side owns; freeing the std::vector
        // happens with `owned` going out of scope. We don't try to give JS
        // a zero-copy view because the source memory belongs to a CMSampleBuffer
        // we've already returned from on the capture queue.
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
    const double sampleRate =
        opts.Has("sampleRate") ? opts.Get("sampleRate").ToNumber().DoubleValue()
                               : 48000.0;
    const uint32_t channels = opts.Has("channels")
                                  ? opts.Get("channels").ToNumber().Uint32Value()
                                  : 2;

    auto& m = module();
    std::lock_guard<std::mutex> lock(m.mu);

    if (m.capture && m.capture->isRunning()) {
        return Napi::Boolean::New(env, true);
    }

    m.tsfn = Napi::ThreadSafeFunction::New(
        env, info[1].As<Napi::Function>(), "MacAudioCaptureCallback",
        0, // unlimited queue
        1  // single thread (the SCStream delivery queue)
    );
    m.tsfnAcquired = true;

    m.capture = std::make_unique<sonacove::MacAudioCapture>();

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

        // BlockingCall has back-pressure baked in; if JS is slow we wait
        // here instead of drowning the queue. SCStream tolerates a backlog
        // because it has its own bounded queue (config.queueDepth).
        napi_status st = mm.tsfn.BlockingCall(
            pb,
            // Pass nullptr cast pointer for the unused first slot —
            // Napi requires the prototype but we don't use it.
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

        // Emit a special "error" buffer with frameCount=0 and an error
        // string in the meta object. Keeps the JS surface to a single
        // callback rather than two.
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

    const bool ok = m.capture->start(sampleRate, channels, onAudio, onError);

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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("isRunning", Napi::Function::New(env, IsRunning));

    return exports;
}

} // namespace

NODE_API_MODULE(macaudio, Init)
