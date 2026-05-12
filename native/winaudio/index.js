'use strict';

// Win11 21H2 base build = 22000.
const MIN_BUILD_FOR_PROCESS_LOOPBACK = 22000;

// Lazy-load the compiled addon. Windows-only: importing on other platforms
// would fail at the require() — we surface a friendlier error and return a
// stub so callers can do `require('@sonacove/winaudio').isSupported()`
// without crashing on macOS/Linux dev machines.
//
// Even on Windows, isSupported() returns false on builds older than
// Win11 21H2 (22000) — the underlying ActivateAudioInterfaceAsync with
// PROCESS_LOOPBACK activation doesn't exist there. The native side
// returns E_NOTIMPL at start time, which the IPC bridge surfaces as a
// load-style error to the renderer.

const os = require('os');

const isWin = process.platform === 'win32';

// Re-export the threshold for callers (test-plan runner uses it).
const MIN_BUILD = MIN_BUILD_FOR_PROCESS_LOOPBACK;

function _winBuild() {
    // os.release() on Windows returns e.g. "10.0.22631". Split off the
    // build number; fall back to 0 if unparseable so the gate fails
    // closed.
    const parts = (os.release() || '').split('.');
    const build = Number(parts[2]);

    return Number.isFinite(build) ? build : 0;
}

let nativeAddon = null;
let loadError = null;

if (isWin) {
    try {
        nativeAddon = require('./build/Release/winaudio.node');
    } catch (err) {
        loadError = err;
    }
}

module.exports = {
    isSupported() {
        return isWin && nativeAddon !== null && _winBuild() >= MIN_BUILD;
    },
    loadError() {
        return loadError;
    },
    /**
     * Begin capturing system audio with the current process's own output
     * excluded.
     *
     * @param {{ sampleRate?: number; channels?: number; verboseProcessTree?: boolean }} opts
     *   verboseProcessTree: if true, logs Electron's full descendant
     *   PID list at start so the Win11 test session can verify
     *   Chromium's audio service is in our tree (a prerequisite for
     *   EXCLUDE_TARGET_PROCESS_TREE to do anything useful).
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
                'winaudio addon not available: '
                + (loadError ? loadError.message : 'unsupported platform')
            );
        }

        if (_winBuild() < MIN_BUILD) {
            throw new Error(
                `winaudio requires Windows 11 21H2 or later (build ${MIN_BUILD}+); `
                + `running on build ${_winBuild()}`
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
    // Re-export the minimum Windows build that supports the
    // PROCESS_LOOPBACK activation. test-plan.js consumes this to gate
    // its build-version check against the same threshold the gate
    // here uses.
    MIN_BUILD,
    /**
     * Non-capture diagnostics — gathers process tree, Windows version,
     * COM state, and (if `runSmokeTest` true) the result of the full
     * activation chain WITHOUT starting capture. Use during the Win11
     * test session to validate the addon's environment before
     * committing to a real capture.
     *
     * @param {boolean} runSmokeTest
     * @returns {object} See DiagnosticsSnapshot in WinAudioCapture.h.
     */
    diagnostics(runSmokeTest) {
        if (!nativeAddon) {
            return {
                currentProcessId: process.pid,
                windowsVersion: os.release(),
                error: 'addon not loaded: '
                    + (loadError ? loadError.message : 'unsupported platform')
            };
        }

        return nativeAddon.diagnostics(Boolean(runSmokeTest));
    }
};
