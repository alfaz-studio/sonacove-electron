/** @type {string} Global shortcut key for toggling click-through on the overlay. */
const SHORTCUT_TOGGLE_CLICK_THROUGH = 'Alt+X';

/** @type {string} Preload script filename for the overlay window. */
const OVERLAY_PRELOAD_FILENAME = 'overlay-preload.js';

/** @type {string} IPC channel sent to renderer when the overlay closes. */
const IPC_NOTIFY_OVERLAY_CLOSED = 'notify-overlay-closed';

/** @type {string} IPC channel sent to the overlay to toggle click-through. */
const IPC_TOGGLE_CLICK_THROUGH = 'toggle-click-through-request';

/** @type {string} IPC channel sent to renderer to clean up viewer whiteboards. */
const IPC_CLEANUP_VIEWER_WHITEBOARDS = 'cleanup-whiteboards-for-viewers';

/** @type {string} IPC channel for non-fatal overlay status notices (main → renderer). */
const IPC_ANNOTATION_STATUS = 'annotation-status';

/** @type {string} Dedicated session partition for overlay windows (CORS scoping). */
const OVERLAY_PARTITION = 'persist:overlay';

/** @type {string} Close reason: user manually toggled off. */
const CLOSE_REASON_MANUAL = 'manual';

/** @type {string} Close reason: overlay window closed externally (OS close, crash). */
const CLOSE_REASON_OVERLAY_CLOSED = 'overlay-closed';

/** @type {string} Close reason: screenshare stopped for viewers. */
const CLOSE_REASON_SCREENSHARE_STOPPED = 'screenshare-stopped';

/** @type {string} Close reason: the overlay page failed to load (network/cert/bad URL). */
const CLOSE_REASON_LOAD_FAILED = 'load-failed';

/** @type {string} Close reason: the overlay render process crashed or went away. */
const CLOSE_REASON_CRASHED = 'crashed';

/** @type {string} Close reason: the display the overlay was on was removed. */
const CLOSE_REASON_DISPLAY_GONE = 'display-gone';

/** @type {string} Close reason: the overlay renderer hung past the grace window. */
const CLOSE_REASON_UNRESPONSIVE = 'unresponsive';

/** @type {string} macOS/Windows always-on-top level. */
const ALWAYS_ON_TOP_LEVEL = 'screen-saver';

/** @type {string} Fully transparent background colour. */
const TRANSPARENT_BG = '#00000000';

module.exports = {
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    OVERLAY_PRELOAD_FILENAME,
    IPC_NOTIFY_OVERLAY_CLOSED,
    IPC_TOGGLE_CLICK_THROUGH,
    IPC_CLEANUP_VIEWER_WHITEBOARDS,
    IPC_ANNOTATION_STATUS,
    OVERLAY_PARTITION,
    CLOSE_REASON_MANUAL,
    CLOSE_REASON_OVERLAY_CLOSED,
    CLOSE_REASON_SCREENSHARE_STOPPED,
    CLOSE_REASON_LOAD_FAILED,
    CLOSE_REASON_CRASHED,
    CLOSE_REASON_DISPLAY_GONE,
    CLOSE_REASON_UNRESPONSIVE,
    ALWAYS_ON_TOP_LEVEL,
    TRANSPARENT_BG
};
