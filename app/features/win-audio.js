

// Bridge between the winaudio native addon and the renderer.
//
// On `start`, the renderer subscribes to `win-audio-buffer` messages. Each
// message carries a Float32 PCM Buffer plus a small metadata header
// (sampleRate, channels, frameCount). On `stop`, capture is torn down and
// any in-flight buffers are dropped.
//
// One capture session per app process. The WASAPI process-loopback model
// is process-singleton; if a second `start` arrives before `stop`, we
// treat it as idempotent and return the running session unchanged rather
// than racing teardown.

const { ipcMain } = require('electron');

let winaudio = null;
let loadError = null;

if (process.platform === 'win32') {
    try {
        winaudio = require('../../native/winaudio');
    } catch (err) {
        loadError = err;
    }
}

let activeSenderId = null;

/**
 * Wire IPC handlers. Idempotent across hot-reload — we only register once.
 *
 * @param {() => Electron.WebContents | null} getRendererWebContents - lazy
 *   accessor for the main renderer; the bridge sends buffers there. We don't
 *   capture the reference at setup because the BrowserWindow may not exist
 *   yet when this is called from app startup.
 */
function setupWinAudioIpc(getRendererWebContents) {
    if (process.platform !== 'win32') {
        return;
    }

    ipcMain.handle('win-audio-supported', () => Boolean(winaudio && winaudio.isSupported()));

    ipcMain.handle('win-audio-start', (_event, opts) => {
        if (!winaudio || !winaudio.isSupported()) {
            return {
                ok: false,
                reason: 'unsupported',
                message: loadError ? loadError.message : 'winaudio addon unavailable'
            };
        }

        if (winaudio.isRunning()) {
            return { ok: true,
                alreadyRunning: true };
        }

        const wc = getRendererWebContents();

        if (!wc) {
            return { ok: false,
                reason: 'no-renderer' };
        }

        activeSenderId = wc.id;

        try {
            winaudio.start(
                {
                    sampleRate: opts && typeof opts.sampleRate === 'number'
                        ? opts.sampleRate : 48000,
                    channels: opts && typeof opts.channels === 'number'
                        ? opts.channels : 2,
                    verboseProcessTree: Boolean(opts && opts.verboseProcessTree)
                },
                (buffer, meta) => {
                    // Filter dropped messages: WASAPI may emit one or two
                    // buffers between our stop() call and the actual
                    // teardown. We ignore them rather than waking a dead
                    // renderer.
                    if (activeSenderId === null) {
                        return;
                    }

                    const target = getRendererWebContents();

                    if (!target || target.id !== activeSenderId
                            || target.isDestroyed()) {
                        return;
                    }

                    if (meta && meta.error) {
                        target.send('win-audio-error', meta);

                        return;
                    }

                    target.send('win-audio-buffer', { buffer,
                        meta });
                }
            );

            return { ok: true };
        } catch (err) {
            activeSenderId = null;

            return { ok: false,
                reason: 'start-threw',
                message: err.message };
        }
    });

    ipcMain.handle('win-audio-stop', () => {
        activeSenderId = null;

        if (winaudio) {
            winaudio.stop();
        }

        return { ok: true };
    });

    // Non-capture diagnostics — invoked by the renderer's test-plan
    // runner. Returns a fixed-shape JSON snapshot the renderer logs to
    // the console. Safe to call any number of times; doesn't affect
    // capture state.
    ipcMain.handle('win-audio-diagnostics', (_event, opts) => {
        if (!winaudio) {
            return {
                error: loadError
                    ? loadError.message
                    : 'winaudio addon unavailable'
            };
        }

        return winaudio.diagnostics(Boolean(opts && opts.runSmokeTest));
    });
}

/**
 * Tear down the bridge. Called on app quit so the addon's capture thread
 * gets a chance to drain instead of being killed mid-buffer.
 */
function shutdownWinAudio() {
    activeSenderId = null;

    if (winaudio) {
        winaudio.stop();
    }
}

module.exports = {
    setupWinAudioIpc,
    shutdownWinAudio
};
