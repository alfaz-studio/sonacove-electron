'use strict';

/**
 * AudioCaptureManager — manages WASAPI loopback capture with process exclusion.
 *
 * Wraps the native sonacove-loopback-capture addon and handles lifecycle:
 * start/stop capture, SharedArrayBuffer creation, IPC to renderer.
 *
 * NOTE: This module is not currently used. It is prepared for future
 * integration of echo-free system audio sharing.
 */

let loopbackCapture;

try {
    loopbackCapture = require('sonacove-loopback-capture');
} catch {
    loopbackCapture = null;
}

class AudioCaptureManager {
    constructor() {
        this._sharedBuffer = null;
        this._capturing = false;
        this._format = null;
    }

    /**
     * Whether the native WASAPI process-exclusion capture is available.
     * @returns {boolean}
     */
    isSupported() {
        return !!(loopbackCapture && loopbackCapture.isSupported());
    }

    /**
     * Start capturing system audio, excluding this process tree's output.
     *
     * @param {Electron.WebContents} webContents — the renderer to send the SharedArrayBuffer to.
     * @returns {boolean} true if capture started successfully.
     */
    start(webContents) {
        if (this._capturing) {
            this.stop();
        }

        if (!this.isSupported()) {
            return false;
        }

        // Get default audio format to size the buffer correctly
        const format = loopbackCapture.getDefaultFormat();

        if (!format) {
            console.warn('[AudioCapture] Could not get default audio format');

            return false;
        }

        this._format = format;

        // Allocate SharedArrayBuffer: 1 second of audio + 16-byte header
        // bufferSize = sampleRate * channels * 4 bytes (float32) * 1 second + header
        const dataBytes = format.sampleRate * format.channels * 4;
        const totalBytes = 16 + dataBytes;

        this._sharedBuffer = new SharedArrayBuffer(totalBytes);

        // Start native capture with this process's PID
        const ok = loopbackCapture.startCapture(process.pid, this._sharedBuffer);

        if (!ok) {
            console.warn('[AudioCapture] Native capture failed to start');
            this._sharedBuffer = null;

            return false;
        }

        this._capturing = true;

        // Send the SharedArrayBuffer to the renderer
        webContents.send('wasapi-audio-started', this._sharedBuffer);

        console.log(`[AudioCapture] Started: ${format.sampleRate}Hz, ${format.channels}ch, pid=${process.pid}`);

        return true;
    }

    /**
     * Stop capturing.
     */
    stop() {
        if (!this._capturing) {
            return;
        }

        if (loopbackCapture) {
            loopbackCapture.stopCapture();
        }

        this._capturing = false;
        this._sharedBuffer = null;

        console.log('[AudioCapture] Stopped');
    }

    /**
     * Whether capture is currently active.
     * @returns {boolean}
     */
    get isCapturing() {
        return this._capturing;
    }
}

module.exports = { AudioCaptureManager };
