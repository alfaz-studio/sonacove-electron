/**
 * System-volume polling + IPC broadcast.
 *
 * `loudness` shells out to OS-native CLIs (PowerShell on Windows, osascript
 * on macOS, amixer/pactl on Linux) so we keep the poll interval generous
 * (1.5s) — fast enough to react when the user nudges the volume slider,
 * slow enough not to spawn a child process every animation frame.
 *
 * The renderer subscribes via `system-volume-changed` and asks for the
 * current value on mount via `request-system-volume` (see
 * `useSystemVolume.ts`).
 */

const { BrowserWindow } = require('electron');
const loudness = require('loudness');

const POLL_INTERVAL_MS = 200;
const IPC_BROADCAST_CHANNEL = 'system-volume-changed';
const IPC_REQUEST_CHANNEL = 'request-system-volume';
const IPC_SET_MUTED_CHANNEL = 'set-system-volume-muted';

let _pollTimer = null;
let _last = {
    volume: null,
    muted: null
};

/**
 * Reads the current system output volume + muted state.
 *
 * @returns {Promise<{volume: number, muted: boolean}|null>} `null` when the
 *   underlying OS call fails (e.g. headless CI, transient amixer error).
 */
async function _read() {
    try {
        const [ volume, muted ] = await Promise.all([
            loudness.getVolume(),
            loudness.getMuted()
        ]);

        return {
            volume: typeof volume === 'number' ? volume : null,
            muted: Boolean(muted)
        };
    } catch (err) {
        console.warn('⚠️ system-volume read failed:', err?.message || err);

        return null;
    }
}

/**
 * Broadcasts the given payload to every still-alive renderer window.
 */
function _broadcast(payload) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send(IPC_BROADCAST_CHANNEL, payload);
        }
    }
}

/**
 * Polls once and, if volume or muted changed since the last tick, broadcasts.
 * Idempotent — safe to call from a `setInterval` and from the on-mount
 * request handler.
 */
async function _tick({ force = false } = {}) {
    const state = await _read();

    if (!state) {
        return null;
    }

    const changed = state.volume !== _last.volume || state.muted !== _last.muted;

    if (changed || force) {
        _last = state;
        _broadcast(state);
    }

    return state;
}

/**
 * Starts the polling loop. Safe to call multiple times — re-entrant calls
 * are no-ops once a timer is registered.
 */
function startSystemVolumeWatcher() {
    if (_pollTimer) {
        return;
    }

    // Kick off an immediate read so renderers don't have to wait a full
    // interval for the first value. `force: true` ensures the broadcast
    // fires even if the cached `_last` happens to match.
    _tick({ force: true });

    _pollTimer = setInterval(() => _tick(), POLL_INTERVAL_MS);
}

/**
 * Stops the polling loop. Called on app quit so we don't leave a child-
 * process spawner running during shutdown.
 */
function stopSystemVolumeWatcher() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

/**
 * Sets the OS-output mute state. Broadcasts the new state directly
 * without re-reading from the OS — the round-trip would otherwise
 * include two extra native CLI spawns (getVolume + getMuted) on top of
 * setMuted, each ~50-150ms on Windows. The 200ms polling watcher
 * catches any drift between our optimistic value and the real OS state.
 *
 * @param {boolean} muted - Target mute state.
 */
async function setSystemMuted(muted) {
    try {
        await loudness.setMuted(Boolean(muted));
        _last = { volume: _last.volume, muted: Boolean(muted) };
        _broadcast(_last);
    } catch (err) {
        console.warn('⚠️ system-volume setMuted failed:', err?.message || err);
    }
}

/**
 * Replies to the sender with the current cached value. Re-reads the OS
 * if the cache is still empty (first call before the first poll has
 * landed).
 *
 * @param {Electron.WebContents} webContents - The renderer that asked.
 */
async function sendCurrentSystemVolume(webContents) {
    if (!webContents || webContents.isDestroyed()) {
        return;
    }

    let payload = _last;

    if (payload.volume === null && payload.muted === null) {
        payload = await _read();
        if (payload) {
            _last = payload;
        }
    }

    if (payload && !webContents.isDestroyed()) {
        webContents.send(IPC_BROADCAST_CHANNEL, payload);
    }
}

module.exports = {
    startSystemVolumeWatcher,
    stopSystemVolumeWatcher,
    sendCurrentSystemVolume,
    setSystemMuted,
    IPC_BROADCAST_CHANNEL,
    IPC_REQUEST_CHANNEL,
    IPC_SET_MUTED_CHANNEL
};
