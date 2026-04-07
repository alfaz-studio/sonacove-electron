#include <napi.h>
#include "loopback_capture.h"

static LoopbackCapture* g_capture = nullptr;

/**
 * isSupported() -> boolean
 * Returns true if the WASAPI process loopback exclusion API is available.
 */
Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), LoopbackCapture::IsSupported());
}

/**
 * probeLoopbackApi() -> { includeAsyncHr, includeActivateHr, includeHasClient,
 *                          excludeAsyncHr, excludeActivateHr, excludeHasClient }
 * Diagnostic: returns the HRESULT values from probing both modes.
 */
Napi::Value ProbeLoopbackApi(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto result = Napi::Object::New(env);

    long asyncHr[2], activateHr[2];
    bool hasClient[2];
    LoopbackCapture::ProbeApi(asyncHr, activateHr, hasClient);

    char buf[32];
    // Index 0 = INCLUDE, 1 = EXCLUDE
    const char* names[2] = { "include", "exclude" };
    for (int i = 0; i < 2; i++) {
        char key[64];
        snprintf(buf, sizeof(buf), "0x%08lX", asyncHr[i]);
        snprintf(key, sizeof(key), "%sAsyncHr", names[i]);
        result.Set(key, Napi::String::New(env, buf));

        snprintf(buf, sizeof(buf), "0x%08lX", activateHr[i]);
        snprintf(key, sizeof(key), "%sActivateHr", names[i]);
        result.Set(key, Napi::String::New(env, buf));

        snprintf(key, sizeof(key), "%sHasClient", names[i]);
        result.Set(key, Napi::Boolean::New(env, hasClient[i]));
    }

    return result;
}

/**
 * getDefaultFormat() -> { sampleRate: number, channels: number } | null
 * Returns the system's default audio render format.
 */
Napi::Value GetDefaultFormat(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint32_t sampleRate = 0, channels = 0;

    if (!LoopbackCapture::GetDefaultFormat(sampleRate, channels)) {
        return env.Null();
    }

    auto result = Napi::Object::New(env);
    result.Set("sampleRate", Napi::Number::New(env, sampleRate));
    result.Set("channels", Napi::Number::New(env, channels));
    return result;
}

/**
 * startCapture(pid: number, sharedBuffer: SharedArrayBuffer) -> boolean
 * Starts WASAPI loopback capture, excluding the given process tree.
 * Audio data is written into the SharedArrayBuffer as a ring buffer.
 */
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (pid, sharedBuffer)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!info[0].IsNumber()) {
        Napi::TypeError::New(env, "pid must be a number").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!info[1].IsArrayBuffer()) {
        Napi::TypeError::New(env, "sharedBuffer must be a SharedArrayBuffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    DWORD pid = info[0].As<Napi::Number>().Uint32Value();
    Napi::ArrayBuffer ab = info[1].As<Napi::ArrayBuffer>();

    // Stop any existing capture
    if (g_capture) {
        g_capture->Stop();
        delete g_capture;
    }

    g_capture = new LoopbackCapture();
    bool ok = g_capture->Start(pid, ab.Data(), ab.ByteLength());

    if (!ok) {
        delete g_capture;
        g_capture = nullptr;
    }

    return Napi::Boolean::New(env, ok);
}

/**
 * stopCapture() -> void
 * Stops the current capture and releases WASAPI resources.
 */
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    if (g_capture) {
        g_capture->Stop();
        delete g_capture;
        g_capture = nullptr;
    }
    return info.Env().Undefined();
}

/**
 * isIncludeSupported() -> boolean
 * Returns true if WASAPI INCLUDE mode (capture FROM a process) is available.
 * This may work on Win10 22H2 even though EXCLUDE mode doesn't.
 */
Napi::Value IsIncludeSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), LoopbackCapture::IsIncludeSupported());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isSupported", Napi::Function::New(env, IsSupported));
    exports.Set("isIncludeSupported", Napi::Function::New(env, IsIncludeSupported));
    exports.Set("probeLoopbackApi", Napi::Function::New(env, ProbeLoopbackApi));
    exports.Set("getDefaultFormat", Napi::Function::New(env, GetDefaultFormat));
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    return exports;
}

NODE_API_MODULE(sonacove_loopback_capture, Init)
