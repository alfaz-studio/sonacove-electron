/**
 * Helpers for the screenshare controls bar — file resolution.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Resolves a renderer asset by searching the same candidate paths the PiP
 * feature uses, so it works both in dev (source tree) and packaged builds.
 *
 * @param {string} filename - The file to find (e.g. 'controls-bar.html').
 * @param {string} featureDir - The __dirname of this feature folder.
 * @returns {string|null} The resolved absolute path, or null if not found.
 */
function resolveFile(filename, featureDir) {
    const candidates = [
        path.join(app.getAppPath(), 'build', filename),
        path.join(app.getAppPath(), filename),
        path.join(featureDir, filename),
        path.join(featureDir, '../../../build', filename)
    ];

    return candidates.find(p => fs.existsSync(p)) || null;
}

module.exports = {
    resolveFile
};
