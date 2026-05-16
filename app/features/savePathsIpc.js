'use strict';

const { BrowserWindow, dialog } = require('electron');

const { handle } = require('./ipcHelpers');
const { sanitizeOverride, validateUserPath } = require('./sanitizers');
const { getAllowedSavePathRoots, getSavePathsInfo, saveSettings } = require('./sonacovePaths');

/**
 * Registers IPC for inspecting and updating save-path settings.
 *
 *   sonacove:get-save-paths()                              → SavePathsInfo
 *   sonacove:set-save-paths({ recordings?, screenshots? }) → SavePathsInfo
 *   sonacove:pick-folder({ defaultPath?, title? })         → string | null
 *
 * pick-folder returns the picked path on success, `null` on user
 * cancellation, and `{ error }` on internal failure. The null vs `{ error }`
 * distinction lets the renderer skip silently on cancel and log on failure.
 *
 * @param {Electron.IpcMain} ipcMain
 */
function setupSavePathsIPC(ipcMain) {
    ipcMain.handle('sonacove:get-save-paths', handle('sonacove:get-save-paths', async () => getSavePathsInfo()));

    ipcMain.handle('sonacove:set-save-paths', handle('sonacove:set-save-paths', async (_event, params) => {
        const next = {};
        const allowedRoots = getAllowedSavePathRoots();

        for (const key of [ 'recordings', 'screenshots' ]) {
            if (!(key in params)) continue;
            const v = sanitizeOverride(params[key]);

            if (v === undefined) {
                return { error: `Invalid ${key} path` };
            }
            if (v === null) {
                next[key] = null;
                continue;
            }

            // Soft guardrail: a determined attacker with arbitrary renderer
            // JS can call other Electron APIs, but we don't want this IPC
            // itself to be usable as a confused-deputy primitive that
            // redirects saves to ~/.ssh, C:\Windows, etc.
            const check = validateUserPath(v, allowedRoots);

            if ('error' in check) {
                return { error: `Invalid ${key} path: ${check.error}` };
            }
            next[key] = check.ok;
        }

        await saveSettings(next);

        return getSavePathsInfo();
    }));

    // Note: returns whatever path the user navigates to without allowlist
    // validation. With contextIsolation: false, a compromised renderer
    // could call this IPC to inspect parts of the user's folder tree (the
    // path of any directory the user clicks through is exposed). The
    // validation happens at set-save-paths time, so this can't be used to
    // redirect recordings to sensitive locations — but it's a small
    // information-disclosure surface inherent to the current sandboxing
    // posture.
    ipcMain.handle('sonacove:pick-folder', handle('sonacove:pick-folder', async (event, params) => {
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
    }));
}

module.exports = { setupSavePathsIPC };
