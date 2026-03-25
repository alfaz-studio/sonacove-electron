/* global __dirname, process */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Resolves the absolute path to the application icon based on the current platform.
 *
 * Searches four candidate locations (dev root → relative to main.js → production
 * resourcesPath → app path fallback) and returns the first match.
 *
 * @param {string} [format] - Optional format override (e.g., 'png').
 * @returns {string} The absolute path to the icon file (.ico for Windows, .png for others).
 */
function getIconPath(format) {
    const ext = format || (process.platform === 'win32' ? 'ico' : 'png');
    const name = `icon.${ext}`;

    // 1. Try Development Root (Where you run npm start)
    const devPath = path.join(process.cwd(), 'resources', name);

    if (fs.existsSync(devPath)) {
        return devPath;
    }

    // 2. Try Relative to main.js (Moving up from build folder)
    const relativePath = path.resolve(__dirname, '..', '..', '..', 'resources', name);

    if (fs.existsSync(relativePath)) {
        return relativePath;
    }

    // 3. Try Production Path (Packaged app)
    if (process.resourcesPath) {
        const prodPath = path.join(process.resourcesPath, name);

        if (fs.existsSync(prodPath)) {
            return prodPath;
        }
    }

    // 4. Ultimate Fallback: try app.getAppPath() but strip 'build' if present
    let appPath = app.getAppPath();

    if (appPath.endsWith('build')) {
        appPath = path.resolve(appPath, '..');
    }

    return path.join(appPath, 'resources', name);
}

module.exports = { getIconPath };
