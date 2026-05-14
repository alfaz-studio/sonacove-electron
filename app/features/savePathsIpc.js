'use strict';

const { BrowserWindow, dialog } = require('electron');

const { getSavePathsInfo, saveSettings } = require('./sonacovePaths');

/**
 * Validates a user-supplied directory override value.
 * Accepts strings (taken verbatim) and null (clears the override).
 * Empty strings are coerced to null.
 *
 * @param {unknown} value - Value from the renderer.
 * @returns {string|null|undefined} Sanitized value, or undefined if the input is invalid.
 */
function sanitizeOverride(value) {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();

    return trimmed === '' ? null : trimmed;
}

/**
 * Registers IPC handlers for inspecting and updating Sonacove save-path settings.
 *
 * Channels:
 *   sonacove:get-save-paths()                        → SavePathsInfo
 *   sonacove:set-save-paths({ recordings?, screenshots? }) → SavePathsInfo
 *   sonacove:pick-folder({ defaultPath?, title? })   → string|null
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @returns {void}
 */
function setupSavePathsIPC(ipcMain) {
    ipcMain.handle('sonacove:get-save-paths', async () => {
        try {
            return getSavePathsInfo();
        } catch (err) {
            console.error('❌ sonacove:get-save-paths failed:', err);

            return { error: err.message || 'Failed to read save paths' };
        }
    });

    ipcMain.handle('sonacove:set-save-paths', async (_event, params = {}) => {
        try {
            const next = {};

            if ('recordings' in params) {
                const r = sanitizeOverride(params.recordings);

                if (r === undefined) {
                    return { error: 'Invalid recordings path' };
                }
                next.recordings = r;
            }
            if ('screenshots' in params) {
                const s = sanitizeOverride(params.screenshots);

                if (s === undefined) {
                    return { error: 'Invalid screenshots path' };
                }
                next.screenshots = s;
            }

            saveSettings(next);

            return getSavePathsInfo();
        } catch (err) {
            console.error('❌ sonacove:set-save-paths failed:', err);

            return { error: err.message || 'Failed to save paths' };
        }
    });

    ipcMain.handle('sonacove:pick-folder', async (event, params = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            const options = {
                properties: [ 'openDirectory', 'createDirectory' ],
                title: typeof params.title === 'string' ? params.title : 'Choose folder'
            };

            if (typeof params.defaultPath === 'string' && params.defaultPath) {
                options.defaultPath = params.defaultPath;
            }

            const result = win && !win.isDestroyed()
                ? await dialog.showOpenDialog(win, options)
                : await dialog.showOpenDialog(options);

            if (result.canceled || result.filePaths.length === 0) {
                return null;
            }

            return result.filePaths[0];
        } catch (err) {
            console.error('❌ sonacove:pick-folder failed:', err);

            return null;
        }
    });
}

module.exports = { setupSavePathsIPC };
