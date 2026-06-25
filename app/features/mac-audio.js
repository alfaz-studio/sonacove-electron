

// Bridge between the macaudio native addon and the renderer.
//
// On `start`, the renderer subscribes to `mac-audio-buffer` messages. Each
// message carries a Float32 PCM Buffer plus a small metadata header
// (sampleRate, channels, frameCount). On `stop`, capture is torn down and
// any in-flight buffers are dropped.
//
// One capture session per app process. SCStream is process-singleton; if a
// second `start` arrives before `stop`, we treat it as idempotent and
// return the running session unchanged rather than racing teardown.

const { ipcMain } = require('electron');

let macaudio = null;
let loadError = null;

if (process.platform === 'darwin') {
    try {
        macaudio = require('../../native/macaudio');
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
function setupMacAudioIpc(getRendererWebContents) {
    if (process.platform !== 'darwin') {
        return;
    }

    ipcMain.handle('mac-audio-supported', () => Boolean(macaudio && macaudio.isSupported()));

    ipcMain.handle('mac-audio-start', (_event, opts) => {
        if (!macaudio || !macaudio.isSupported()) {
            return {
                ok: false,
                reason: 'unsupported',
                message: loadError ? loadError.message : 'macaudio addon unavailable'
            };
        }

        if (macaudio.isRunning()) {
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
            macaudio.start(
                {
                    sampleRate: opts && typeof opts.sampleRate === 'number'
                        ? opts.sampleRate : 48000,
                    channels: opts && typeof opts.channels === 'number'
                        ? opts.channels : 2
                },
                (buffer, meta) => {
                    // Filter dropped messages: SCStream may emit one or two
                    // buffers between our stop() call and the actual stream
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
                        target.send('mac-audio-error', meta);

                        return;
                    }

                    target.send('mac-audio-buffer', { buffer,
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

    ipcMain.handle('mac-audio-stop', () => {
        activeSenderId = null;

        if (macaudio) {
            macaudio.stop();
        }

        return { ok: true };
    });
}

/**
 * Tear down the bridge. Called on app quit so the addon's worker queue
 * gets a chance to drain instead of being killed mid-buffer.
 */
function shutdownMacAudio() {
    activeSenderId = null;

    if (macaudio) {
        macaudio.stop();
    }
}

module.exports = {
    setupMacAudioIpc,
    shutdownMacAudio
};
