/**
 * System-volume polling + IPC broadcast.
 *
 * `loudness` shells out to OS-native CLIs (PowerShell on Windows, osascript
 * on macOS, amixer/pactl on Linux) so we keep the poll interval generous
 * (1s) — fast enough to react when the user nudges the volume slider,
 * slow enough not to spawn a child process every animation frame.
 *
 * The renderer subscribes via `system-volume-changed` and asks for the
 * current value on mount via `request-system-volume` (see
 * `useSystemVolume.ts`).
 */

const loudness = require('loudness');

const POLL_INTERVAL_MS = 1000;
const IPC_BROADCAST_CHANNEL = 'system-volume-changed';
const IPC_REQUEST_CHANNEL = 'request-system-volume';
const IPC_SET_MUTED_CHANNEL = 'set-system-volume-muted';
const IPC_SET_VOLUME_CHANNEL = 'set-system-volume';

let _pollTimer = null;
let _last = {
    volume: null,
    muted: null
};
// Bumped by every optimistic write (setSystemMuted / setSystemVolume). A
// poll tick captures this at the start of its read and discards the result
// if the version changed mid-flight — prevents a stale OS reading from
// clobbering a fresh optimistic update.
let _version = 0;
// Guard against overlapping ticks when a single read takes longer than the
// interval (common on Windows PowerShell cold start). Without this, slow
// reads queue up and the spawn rate grows unbounded.
let _inFlight = false;
// Cleared at startup if `loudness.getVolume()` throws or returns garbage —
// e.g. PulseAudio/PipeWire-only Linux systems where amixer no-ops silently.
// When false, the watcher never starts and set* calls early-return.
let _supported = true;
// Set on watcher start. Broadcasts target only this window so PiP/overlay
// renderers — which don't consume system-volume-changed — aren't paged.
let _targetWindow = null;
// Suppress repeated warnings while reads are failing back-to-back (broken
// amixer, locked-down PowerShell policy). Flips back when a read recovers.
let _readFailing = false;

/**
 * Reads the current system output volume + muted state. Silent — callers
 * are responsible for surfacing the failure mode they care about.
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
    } catch {
        return null;
    }
}

/**
 * Sends the payload to the target window only. `_targetWindow.isDestroyed()`
 * catches the BrowserWindow shell going away; `webContents.isDestroyed()`
 * catches the renderer being torn down independently (mid-navigation, dev
 * reload). Either guard alone is insufficient.
 */
function _broadcast(payload) {
    if (!_targetWindow || _targetWindow.isDestroyed() || _targetWindow.webContents.isDestroyed()) {
        return;
    }
    _targetWindow.webContents.send(IPC_BROADCAST_CHANNEL, payload);
}

/**
 * Polls once and, if volume or muted changed since the last tick, broadcasts.
 * Idempotent — safe to call from a `setInterval` and from the on-mount
 * request handler.
 */
async function _tick() {
    if (!_supported || _inFlight) {
        return null;
    }

    _inFlight = true;
    const versionAtStart = _version;
    let state;

    try {
        state = await _read();
    } finally {
        _inFlight = false;
    }

    if (!state) {
        if (!_readFailing) {
            console.warn('⚠️ system-volume read failed, suppressing further warnings until recovery');
            _readFailing = true;
        }

        return null;
    }
    _readFailing = false;

    // An optimistic update raced this read — discard so we don't roll the
    // user-visible value back to the pre-set OS reading.
    if (_version !== versionAtStart) {
        return null;
    }

    const changed = state.volume !== _last.volume || state.muted !== _last.muted;

    if (changed) {
        _last = state;
        _broadcast(state);
    }

    return state;
}

/**
 * Starts the polling loop. Safe to call multiple times — re-entrant calls
 * are no-ops once a timer is registered.
 *
 * Probes the OS layer once before starting the interval. On systems where
 * `loudness` can't read (PulseAudio/PipeWire-only Linux, headless CI),
 * the watcher stays dormant and `_supported` flips to false so set* calls
 * short-circuit.
 *
 * @param {Electron.BrowserWindow} targetWindow - The window that consumes
 *   `system-volume-changed`. Broadcasts go only here.
 */
async function startSystemVolumeWatcher(targetWindow) {
    if (_pollTimer) {
        return;
    }
    _targetWindow = targetWindow || null;

    // Probe + cold-start broadcast in one call so we don't pay two reads
    // (each a child-process spawn) before the renderer sees its first value.
    const initial = await _read();

    if (!initial || typeof initial.volume !== 'number') {
        console.warn('⚠️ system-volume read unavailable on this system, disabling feature');
        _supported = false;

        return;
    }

    _last = initial;
    _broadcast(initial);

    _pollTimer = setInterval(() => _tick(), POLL_INTERVAL_MS);
}

/**
 * Whether the OS-volume layer is usable on this host. The renderer
 * doesn't currently consume this — `setSystemMuted` / `setSystemVolume`
 * already no-op when unsupported — but it's exported for diagnostics.
 *
 * @returns {boolean}
 */
function isSupported() {
    return _supported;
}

/**
 * Stops the polling loop and resets module state. Called on app quit so
 * we don't leave a child-process spawner running during shutdown.
 * Resetting `_supported` and `_last` also lets dev hot-reload re-probe
 * cleanly instead of inheriting the prior process's verdict.
 */
function stopSystemVolumeWatcher() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
    _last = { volume: null, muted: null };
    _version = 0;
    _inFlight = false;
    _supported = true;
    _targetWindow = null;
    _readFailing = false;
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
    if (!_supported) {
        return;
    }

    try {
        await loudness.setMuted(Boolean(muted));
        _version++;
        _last = { volume: _last.volume, muted: Boolean(muted) };
        _broadcast(_last);
    } catch (err) {
        console.warn('⚠️ system-volume setMuted failed:', err?.message || err);
    }
}

/**
 * Sets the OS-output volume. Same fast-path as `setSystemMuted` — skips
 * the verify-read and broadcasts the optimistic value directly. Also
 * unmutes when bumping to a non-zero volume so the warning UI clears
 * cleanly (a muted-at-50% state is a confusing in-between).
 *
 * @param {number} volume - Target volume, 0–100. Clamped.
 */
async function setSystemVolume(volume) {
    if (!_supported) {
        return;
    }

    const clamped = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));

    try {
        await loudness.setVolume(clamped);
        let muted = _last.muted;

        if (clamped > 0 && _last.muted) {
            await loudness.setMuted(false);
            muted = false;
        }
        _version++;
        _last = { volume: clamped, muted };
        _broadcast(_last);
    } catch (err) {
        console.warn('⚠️ system-volume setVolume failed:', err?.message || err);
    }
}

/**
 * Replies to the sender with the current cached value. Re-reads the OS
 * if the cache is still empty (first call before the first poll has
 * landed).
 *
 * Possible duplicate broadcast: while this is awaiting `_read()`, the
 * watcher's own `_tick` can fire and call `_broadcast` first. The
 * renderer hook treats same-value updates as a no-op so the duplicate
 * is harmless.
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
    setSystemVolume,
    isSupported,
    IPC_BROADCAST_CHANNEL,
    IPC_REQUEST_CHANNEL,
    IPC_SET_MUTED_CHANNEL,
    IPC_SET_VOLUME_CHANNEL
};
