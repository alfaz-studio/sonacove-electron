'use strict';

// Lazy-load the compiled addon. macOS-only: importing on other platforms
// would fail at the require() — we surface a friendlier error and return a
// stub so callers can do `require('@sonacove/macaudio').isSupported()`
// without crashing on Windows/Linux dev machines.

const isMac = process.platform === 'darwin';

let nativeAddon = null;
let loadError = null;

if (isMac) {
    try {
        nativeAddon = require('./build/Release/macaudio.node');
    } catch (err) {
        loadError = err;
    }
}

module.exports = {
    isSupported() {
        return isMac && nativeAddon !== null;
    },
    loadError() {
        return loadError;
    },
    /**
     * Begin capturing system audio with the current process's own output
     * excluded.
     *
     * @param {{ sampleRate?: number; channels?: number }} opts
     * @param {(buffer: Buffer | null, meta: object) => void} onBuffer
     *   Called per audio chunk on the main JS thread. `buffer` is interleaved
     *   Float32 PCM (size = frameCount * channels * 4 bytes). When the OS
     *   reports a stream error, `buffer` is null and `meta.error === true`
     *   with `meta.code` and `meta.message`.
     * @returns {boolean} true if start was dispatched.
     */
    start(opts, onBuffer) {
        if (!nativeAddon) {
            throw new Error(
                'macaudio addon not available: '
                + (loadError ? loadError.message : 'unsupported platform')
            );
        }

        return nativeAddon.start(opts || {}, onBuffer);
    },
    stop() {
        if (nativeAddon) {
            nativeAddon.stop();
        }
    },
    isRunning() {
        return nativeAddon ? nativeAddon.isRunning() : false;
    },
};
