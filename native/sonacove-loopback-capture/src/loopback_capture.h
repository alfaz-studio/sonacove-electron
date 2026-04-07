#pragma once

#include <napi.h>
#include <atomic>
#include <thread>
#include <cstdint>

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <audioclientactivationparams.h>

/**
 * LoopbackCapture: Captures system audio via WASAPI loopback,
 * excluding a target process tree (Electron's own audio output).
 *
 * Audio data is written as interleaved float32 PCM into a
 * SharedArrayBuffer ring buffer that the renderer's AudioWorklet
 * reads from (lock-free, zero-copy).
 *
 * Ring buffer layout (all uint32 unless noted):
 *   [0]  writePosition  (in frames, atomically updated by capture thread)
 *   [1]  readPosition   (in frames, atomically updated by AudioWorklet)
 *   [2]  sampleRate
 *   [3]  channels
 *   [16..] float32 interleaved PCM data
 */

// Header size in bytes (4 uint32 values + padding to 16 bytes)
constexpr size_t RING_BUFFER_HEADER_BYTES = 16;

class LoopbackCapture {
public:
    LoopbackCapture();
    ~LoopbackCapture();

    // Start capturing, excluding the given PID's process tree.
    // sharedBuffer points to the raw SharedArrayBuffer backing store.
    // bufferByteLength is the total size of the SharedArrayBuffer.
    bool Start(DWORD excludePid, void* sharedBuffer, size_t bufferByteLength);

    // Stop capturing and release WASAPI resources.
    void Stop();

    // Check if the WASAPI process loopback exclusion API is available.
    static bool IsSupported();

    // Check if INCLUDE mode (capture FROM a specific process) is available.
    static bool IsIncludeSupported();

    // Diagnostic: probe both INCLUDE and EXCLUDE modes, returning HRESULT values.
    // Results written to the provided arrays (index 0=INCLUDE, 1=EXCLUDE).
    static void ProbeApi(long asyncHr[2], long activateHr[2], bool hasClient[2]);

    // Get the system's default mix format sample rate and channel count.
    static bool GetDefaultFormat(uint32_t& sampleRate, uint32_t& channels);

private:
    void CaptureLoop();

    IAudioClient* audioClient_ = nullptr;
    IAudioCaptureClient* captureClient_ = nullptr;
    HANDLE captureEvent_ = nullptr;

    std::atomic<bool> running_{false};
    std::thread captureThread_;

    // Ring buffer pointers (into SharedArrayBuffer)
    std::atomic<uint32_t>* writePos_ = nullptr;
    std::atomic<uint32_t>* readPos_ = nullptr;
    float* pcmData_ = nullptr;
    uint32_t bufferFrames_ = 0; // total frames in the ring buffer
    uint32_t channels_ = 0;
};
