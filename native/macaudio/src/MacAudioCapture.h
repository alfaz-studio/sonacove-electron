// MacAudioCapture.h — ScreenCaptureKit-based system audio loopback that
// EXCLUDES our own process audio, breaking the meeting-feedback loop that has
// blocked the "share system audio" feature on every other path the team tried
// (see jitsi-meet PR #423 for the dead-end audit).
//
// Owns one SCStream per start() call; one stream per process is the supported
// model. Audio buffers are delivered on a private dispatch queue and forwarded
// via a C-style callback to keep the N-API layer unaware of Cocoa runtime
// concerns. The callback receives interleaved Float32 PCM (the format
// SCStream delivers natively for kAudioFormatLinearPCM streams).

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>

namespace sonacove {

struct AudioFormat {
    double sampleRate;     // Hz, typically 48000.
    uint32_t channelCount; // 1 or 2.
};

// Called on an arbitrary worker thread. The buffer is interleaved Float32 PCM
// and lives only for the duration of the call — copy if you need to retain it.
using AudioBufferCallback =
    std::function<void(const float* samples, size_t frameCount, AudioFormat fmt)>;

// Called when the stream produces an unrecoverable error (permission revoked,
// display disconnected, etc.). After this fires, the stream is terminal —
// callers must release and recreate to retry.
using ErrorCallback = std::function<void(int code, const char* message)>;

class MacAudioCapture {
  public:
    MacAudioCapture();
    ~MacAudioCapture();

    MacAudioCapture(const MacAudioCapture&) = delete;
    MacAudioCapture& operator=(const MacAudioCapture&) = delete;

    // Begins capture. Returns true on synchronous success (stream object
    // created and start dispatched); the stream itself starts asynchronously,
    // and audio buffers begin flowing once the OS grants permission.
    //
    // sampleRate / channelCount are HINTS — SCStream may negotiate to a
    // different format. The actual format is reported via the audio callback
    // on every buffer; downstream code should resample if needed.
    bool start(double sampleRate, uint32_t channelCount,
               AudioBufferCallback onAudio, ErrorCallback onError);

    // Stops capture. Safe to call on a never-started instance and idempotent.
    void stop();

    bool isRunning() const;

  private:
    struct Impl;
    Impl* impl_;
};

} // namespace sonacove
