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

const {
    IPC_BROADCAST_CHANNEL,
    IPC_REQUEST_CHANNEL,
    IPC_SET_MUTED_CHANNEL,
    IPC_SET_VOLUME_CHANNEL
} = require('./system-volume-channels');

const POLL_INTERVAL_MS = 1000;

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
// Set during stopSystemVolumeWatcher() so any IPC request arriving in the
// narrow window between stop and full IPC-listener teardown can't trigger
// a `_read()` spawn — `stop` resets `_supported = true` (for dev hot-reload
// re-probe), which would otherwise let `sendCurrentSystemVolume` past its
// gate. Cleared by `startSystemVolumeWatcher`.
let _stopped = false;

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
 * Sends the payload to a renderer. `supported` is the single source of
 * truth for whether the OS-volume layer is usable on this host — the
 * renderer flips its capability state from this field on every payload
 * (no static preload flag). One helper for both the broadcast path
 * (`_broadcast`) and the on-mount request path (`sendCurrentSystemVolume`)
 * so the payload shape can only ever drift in one place.
 */
function _send(webContents, payload) {
    webContents.send(IPC_BROADCAST_CHANNEL, {
        volume: payload.volume,
        muted: payload.muted,
        supported: _supported
    });
}

/**
 * Broadcasts to the target window. `_targetWindow.isDestroyed()` catches
 * the BrowserWindow shell going away; `webContents.isDestroyed()` catches
 * the renderer being torn down independently (mid-navigation, dev
 * reload). Either guard alone is insufficient.
 */
function _broadcast(payload) {
    if (!_targetWindow || _targetWindow.isDestroyed() || _targetWindow.webContents.isDestroyed()) {
        return;
    }
    _send(_targetWindow.webContents, payload);
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
    _stopped = false;
    // Sentinel: claim the slot before awaiting the probe so a re-entrant call
    // that arrives during `_read()` bails out at the guard above instead of
    // racing a second OS probe + duplicate setInterval.
    _pollTimer = true;
    // `_targetWindow` is fixed for the lifetime of the watcher. If the main
    // BrowserWindow is ever destroyed and recreated (dev reload, error
    // recovery), broadcasts will silently no-op against the destroyed-window
    // guard in `_broadcast`. Call `stopSystemVolumeWatcher()` + `startSystemVolumeWatcher(newWindow)`
    // if the window is replaced.
    _targetWindow = targetWindow || null;

    // Probe + cold-start broadcast in one call so we don't pay two reads
    // (each a child-process spawn) before the renderer sees its first value.
    const initial = await _read();

    // stopSystemVolumeWatcher() raced the probe — bail out cleanly. The stop
    // call already cleared _targetWindow / set _pollTimer = null and reset
    // module state; we just need to not install the interval (and not stomp
    // on _supported, which stop intentionally reset to true).
    if (_pollTimer !== true) {
        return;
    }

    if (!initial || typeof initial.volume !== 'number') {
        // Reset the sentinel so a future call (e.g. dev hot-reload) can retry.
        _pollTimer = null;
        _supported = false;
        console.warn('⚠️ system-volume read unavailable on this system, disabling feature');

        return;
    }

    _last = initial;
    _broadcast(initial);

    _pollTimer = setInterval(() => _tick(), POLL_INTERVAL_MS);
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
    _stopped = true;
}

/**
 * Sets the OS-output mute state. Broadcasts the new state directly
 * without re-reading from the OS — the round-trip would otherwise
 * include two extra native CLI spawns (getVolume + getMuted) on top of
 * setMuted, each ~50-150ms on Windows. The 1s polling watcher
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
    } catch (err) {
        // Primary action failed — OS state is unchanged, surface and bail.
        console.warn('⚠️ system-volume setVolume failed:', err?.message || err);

        return;
    }

    // setVolume succeeded — `clamped` is now the authoritative OS volume.
    let muted = _last.muted;

    // Intentional side effect: bumping a muted system to a non-zero volume
    // also unmutes it. A "muted-at-50%" state is a confusing in-between
    // the UI can land in (icon shows muted, slider shows 50%), so the
    // renderer-side fix-volume action's contract is "lift the system to
    // a working state". Callers (e.g. the renderer "fix-it" pill) MUST
    // make this visible in the UI so the user doesn't see their explicit
    // OS mute disappear silently.
    if (clamped > 0 && _last.muted) {
        try {
            await loudness.setMuted(false);
            muted = false;
        } catch (innerErr) {
            // Unmute is a courtesy follow-up; the volume change is still
            // valid and the renderer needs to see it. The next poll tick
            // will reconcile the actual muted state.
            console.warn('⚠️ system-volume setMuted(false) failed after setVolume succeeded:', innerErr?.message || innerErr);
        }
    }
    _version++;
    _last = { volume: clamped, muted };
    _broadcast(_last);
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

    // App is shutting down — `stopSystemVolumeWatcher` resets `_supported = true`
    // (for dev hot-reload re-probe) but the IPC listeners aren't torn down
    // until the window closes. Without this guard a request arriving in the
    // narrow window would spawn a `_read()` we just stopped to prevent.
    if (_stopped) {
        return;
    }

    // OS-volume layer is unavailable (probe failed at startup). Still send
    // a reply so the renderer's request-system-volume call doesn't hang
    // waiting — `_send` bakes in `supported: _supported` (false here), so
    // the hook learns the capability state and hides the feature UI.
    if (!_supported) {
        _send(webContents, { volume: null, muted: null });

        return;
    }

    // A poll tick is already reading — send the cached value (the tick
    // may not broadcast if nothing changed). `_inFlight` only ever flips
    // true inside `_tick()`, which only runs after `startSystemVolumeWatcher`
    // has completed its initial probe and populated `_last` — so
    // `_last.volume === null` is unreachable here. Just send `_last`.
    if (_inFlight) {
        _send(webContents, _last);

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
        _send(webContents, payload);
    }
}

module.exports = {
    startSystemVolumeWatcher,
    stopSystemVolumeWatcher,
    sendCurrentSystemVolume,
    setSystemMuted,
    setSystemVolume,
    IPC_BROADCAST_CHANNEL,
    IPC_REQUEST_CHANNEL,
    IPC_SET_MUTED_CHANNEL,
    IPC_SET_VOLUME_CHANNEL
};
