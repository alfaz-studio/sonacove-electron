// WASAPI process-loopback capture that excludes our own PID tree, so
// system audio can be shared without feedback when our app is playing
// the meeting's audio back. Requires Win11 21H2+ (build 22000+).
//
// One capture thread per start(); the callback receives interleaved
// Float32 PCM on that thread.

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace sonacove {

struct AudioFormat {
    double sampleRate;     // Hz, whatever the system mixer is using.
    uint32_t channelCount; // typically 2.
};

// Called on the WASAPI capture thread. The buffer is interleaved Float32
// PCM and lives only for the duration of the call — copy if you need to
// retain it.
using AudioBufferCallback =
    std::function<void(const float* samples, size_t frameCount, AudioFormat fmt)>;

// Called when the stream produces an unrecoverable error (activation
// failure, format negotiation, capture client release, etc.). After this
// fires, the stream is terminal — callers must release and recreate to
// retry.
using ErrorCallback = std::function<void(int code, const char* message)>;

class WinAudioCapture {
  public:
    WinAudioCapture();
    ~WinAudioCapture();

    WinAudioCapture(const WinAudioCapture&) = delete;
    WinAudioCapture& operator=(const WinAudioCapture&) = delete;

    struct StartOptions {
        double sampleRate = 48000.0;
        uint32_t channelCount = 2;

        // Diagnostic / fallback: instead of trusting
        // EXCLUDE_TARGET_PROCESS_TREE to walk the tree itself, enumerate
        // every descendant PID of our process and log them. Useful when
        // the first test run produces capture-but-still-echoes — the
        // log tells us whether the audio service PID is even
        // discoverable from our tree. The actual exclusion still uses
        // tree mode; this flag just adds visibility into what's in it.
        bool verboseProcessTree = false;
    };

    // Begins capture. Returns true on synchronous success (activation
    // dispatched, capture thread started); the IAudioClient activation
    // itself is async, so the first audio buffer may arrive ~tens of ms
    // after start() returns.
    //
    // sampleRate / channelCount are HINTS — the mixer's current format
    // wins (WASAPI loopback is locked to the render endpoint's format).
    // The actual format is reported via the audio callback on every
    // buffer; downstream code should resample if needed.
    bool start(StartOptions opts,
               AudioBufferCallback onAudio, ErrorCallback onError);

    // Stops capture. Safe to call on a never-started instance and idempotent.
    // Blocks until the capture thread joins, so in-flight callbacks settle
    // before this returns.
    void stop();

    bool isRunning() const;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Non-capture diagnostic info — gathered by `collectDiagnostics()`
// before committing to a real capture session, so failures isolate
// activation issues from capture issues.
struct DiagnosticsSnapshot {
    uint32_t currentProcessId = 0;

    // Direct children PIDs (csv). Used to verify Chromium's audio
    // service is in our process tree — EXCLUDE_TARGET_PROCESS_TREE
    // can't filter it out if it isn't.
    std::string childPids;

    // Same, BFS to N levels — catches the audio service if it's a
    // grandchild via a launcher process.
    std::string descendantPids;

    std::string windowsVersion;
    bool comInitFresh = false;

    // Smoke-test result: runs the full ActivateAudioInterfaceAsync +
    // GetMixFormat chain WITHOUT IAudioClient::Start, so activation
    // failures isolate from capture failures.
    uint32_t smokeTestHresult = 0xFFFFFFFFu; // sentinel: not run
    std::string mixFormatDescription;
};

DiagnosticsSnapshot collectDiagnostics(bool runSmokeTest);

} // namespace sonacove
