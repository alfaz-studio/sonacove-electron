/** @type {string} Global shortcut key for toggling click-through on the overlay. */
const SHORTCUT_TOGGLE_CLICK_THROUGH = 'Alt+X';

/** @type {string} Preload script filename for the overlay window. */
const OVERLAY_PRELOAD_FILENAME = 'overlay-preload.js';

/** @type {string} Fallback preload filename (legacy, before security hardening). */
const FALLBACK_PRELOAD_FILENAME = 'preload.js';

/** @type {string} IPC channel sent to renderer when the overlay closes. */
const IPC_NOTIFY_OVERLAY_CLOSED = 'notify-overlay-closed';

/** @type {string} IPC channel sent to the overlay to toggle click-through. */
const IPC_TOGGLE_CLICK_THROUGH = 'toggle-click-through-request';

/** @type {string} IPC channel sent to renderer to clean up viewer whiteboards. */
const IPC_CLEANUP_VIEWER_WHITEBOARDS = 'cleanup-whiteboards-for-viewers';

/** @type {string} Close reason: user manually toggled off. */
const CLOSE_REASON_MANUAL = 'manual';

/** @type {string} Close reason: overlay window closed externally (OS close, crash). */
const CLOSE_REASON_OVERLAY_CLOSED = 'overlay-closed';

/** @type {string} Close reason: screenshare stopped for viewers. */
const CLOSE_REASON_SCREENSHARE_STOPPED = 'screenshare-stopped';

/** @type {string} macOS/Windows always-on-top level. */
const ALWAYS_ON_TOP_LEVEL = 'screen-saver';

/** @type {string} Fully transparent background colour. */
const TRANSPARENT_BG = '#00000000';

module.exports = {
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    OVERLAY_PRELOAD_FILENAME,
    FALLBACK_PRELOAD_FILENAME,
    IPC_NOTIFY_OVERLAY_CLOSED,
    IPC_TOGGLE_CLICK_THROUGH,
    IPC_CLEANUP_VIEWER_WHITEBOARDS,
    CLOSE_REASON_MANUAL,
    CLOSE_REASON_OVERLAY_CLOSED,
    CLOSE_REASON_SCREENSHARE_STOPPED,
    ALWAYS_ON_TOP_LEVEL,
    TRANSPARENT_BG
};
