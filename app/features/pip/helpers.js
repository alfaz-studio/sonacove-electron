/**
 * Shared helpers for the participant PiP panel.
 */

const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');

/** @type {BrowserWindow|null} Reference set by participant-window.js */
let _participantWindow = null;

/**
 * Sets the participant window reference so getMainWindowExcludingPip() and
 * overlay/helpers:getMainWindow can exclude it. Called by
 * participant-window.js whenever the window is created or destroyed.
 *
 * @param {BrowserWindow|null} win
 */
function setParticipantWindow(win) {
    _participantWindow = win;
}

/**
 * Returns the participant PiP window reference (or null). Exported so that
 * other features' main-window lookups (e.g. overlay/helpers, deep-link) can
 * exclude it — the always-on-top PiP panel would otherwise be picked as the
 * "first visible" window when the main window is minimized/hidden.
 *
 * @returns {BrowserWindow|null}
 */
function getParticipantWindow() {
    return _participantWindow;
}

/**
 * Returns the first non-destroyed window that isn't the participant PiP
 * panel. Pip-internal helper only.
 *
 * ⚠ DO NOT use outside the `pip/` feature. This helper exists solely to
 * avoid a circular require back into `overlay/helpers`, and it has two
 * limitations compared to `overlay/helpers:getMainWindow`:
 *
 *   1. It does NOT exclude annotation overlay windows — an overlay could
 *      be returned if present.
 *   2. It does NOT prefer visible windows — it returns the first
 *      non-destroyed match.
 *
 * These are acceptable for pip-internal use (display geometry / bounds
 * lookups) but wrong for routing user intent. External callers should use
 * `overlay/helpers:getMainWindow` instead.
 *
 * @returns {BrowserWindow|null}
 */
function getMainWindowExcludingPip() {
    const windows = BrowserWindow.getAllWindows().filter(
        w => !w.isDestroyed() && w !== _participantWindow
    );

    return windows[0] || null;
}

/**
 * Resolves a file by searching a list of candidate paths.
 *
 * @param {string} filename - The file to find.
 * @param {string} featureDir - The __dirname of the pip feature folder.
 * @returns {string|null} The resolved path, or null if not found.
 */
function resolveFile(filename, featureDir) {
    const candidates = [
        path.join(app.getAppPath(), 'build', filename),
        path.join(app.getAppPath(), filename),
        path.join(featureDir, filename),
        path.join(featureDir, '../../../build', filename),
    ];

    return candidates.find(p => fs.existsSync(p)) || null;
}

module.exports = {
    setParticipantWindow,
    getParticipantWindow,
    getMainWindowExcludingPip,
    resolveFile,
};
