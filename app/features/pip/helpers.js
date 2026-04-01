/**
 * Shared helpers for the participant PiP panel.
 */

const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');

/** @type {BrowserWindow|null} Reference set by participant-window.js */
let _participantWindow = null;

/**
 * Sets the participant window reference so getMainWindow() can exclude it.
 * Called by participant-window.js whenever the window is created or destroyed.
 *
 * @param {BrowserWindow|null} win
 */
function setParticipantWindow(win) {
    _participantWindow = win;
}

/**
 * Returns the actual main application window, excluding the PiP panel.
 *
 * The generic "first visible window" approach fails when the main window is
 * minimized because the always-on-top PiP panel becomes the first visible
 * window instead.
 *
 * @returns {BrowserWindow|null}
 */
function getMainWindow() {
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
    getMainWindow,
    resolveFile,
};
