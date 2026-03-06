'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const isDev = require('electron-is-dev');

/**
 * Returns the project root, stripping the trailing 'build' directory
 * from app.getAppPath() if present (production builds).
 *
 * @returns {string} Absolute path to the project root.
 */
function getProjectRoot() {
    let appPath = app.getAppPath();

    if (appPath.endsWith('build')) {
        appPath = path.resolve(appPath, '..');
    }

    return appPath;
}

/**
 * Resolves the absolute path to the application icon based on the current platform.
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

    // 2. Try Production Path (Packaged app)
    if (process.resourcesPath) {
        const prodPath = path.join(process.resourcesPath, name);

        if (fs.existsSync(prodPath)) {
            return prodPath;
        }
    }

    // 3. Fallback: resolve from app root
    return path.join(getProjectRoot(), 'resources', name);
}

/**
 * Returns the path to a local HTML page bundled with the app.
 *
 * @param {string} filename - The HTML filename (e.g., 'splash.html').
 * @returns {string} Absolute path to the file.
 */
function getPagePath(filename) {
    return isDev
        ? path.join(process.cwd(), 'app', filename)
        : path.join(app.getAppPath(), 'build', filename);
}

/**
 * Returns the path to the local splash screen HTML file.
 *
 * @returns {string} Absolute path to splash.html.
 */
function getSplashPath() {
    return getPagePath('splash.html');
}

/**
 * Returns the path to the local error page HTML file.
 *
 * @returns {string} Absolute path to error.html.
 */
function getErrorPath() {
    return getPagePath('error.html');
}

module.exports = {
    getIconPath,
    getSplashPath,
    getErrorPath
};
