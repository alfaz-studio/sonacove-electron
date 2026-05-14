'use strict';

const { BrowserWindow, dialog } = require('electron');

const { getSavePathsInfo, saveSettings } = require('./sonacovePaths');

/**
 * Validates a user-supplied directory override.
 * Returns `null` for null or empty-string (clears the override),
 * a trimmed string for valid input, or `undefined` for invalid input.
 */
function sanitizeOverride(value) {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();

    return trimmed === '' ? null : trimmed;
}

function handle(label, fn) {
    return async (event, params = {}) => {
        try {
            return await fn(event, params);
        } catch (err) {
            console.error(`❌ ${label} failed:`, err);

            return { error: err.message || label };
        }
    };
}

/**
 * Registers IPC for inspecting and updating save-path settings.
 *
 *   sonacove:get-save-paths()                              → SavePathsInfo
 *   sonacove:set-save-paths({ recordings?, screenshots? }) → SavePathsInfo
 *   sonacove:pick-folder({ defaultPath?, title? })         → string|null
 *
 * @param {Electron.IpcMain} ipcMain
 */
function setupSavePathsIPC(ipcMain) {
    ipcMain.handle('sonacove:get-save-paths', handle('sonacove:get-save-paths', async () => getSavePathsInfo()));

    ipcMain.handle('sonacove:set-save-paths', handle('sonacove:set-save-paths', async (_event, params) => {
        const next = {};

        for (const key of [ 'recordings', 'screenshots' ]) {
            if (!(key in params)) continue;
            const v = sanitizeOverride(params[key]);

            if (v === undefined) {
                return { error: `Invalid ${key} path` };
            }
            next[key] = v;
        }

        saveSettings(next);

        return getSavePathsInfo();
    }));

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
