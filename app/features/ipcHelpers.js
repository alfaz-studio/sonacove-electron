'use strict';

const { app } = require('electron');

/**
 * Wraps an IPC handler with uniform error logging and a `{ error }` failure
 * return. Use for any `ipcMain.handle()` registration that wants the standard
 * "data on success, { error: string } on failure" return contract.
 *
 * In unpackaged (dev) builds the renderer-visible error also carries the
 * stack via an extra `stack` field. Production builds keep only the message
 * so we don't leak internal paths.
 *
 * Note on error disclosure: err.message is returned to the renderer
 * verbatim, which on Node fs errors includes the full file path (e.g.
 * "EACCES: permission denied, open '/Users/al/.ssh/authorized_keys'").
 * With contextIsolation: false the renderer is already broadly trusted,
 * so we accept that information disclosure rather than strip paths and
 * lose the actually-useful part of the error. If contextIsolation is
 * ever turned on, revisit this — at that point the renderer becomes
 * a security boundary and we should sanitize err.message before
 * returning it.
 *
 * Fallback: if the thrown error has no `.message` (rare — e.g. a thrown
 * non-Error, or `new Error()`), the channel `label` is used as the error
 * string so the renderer at least gets a non-empty error.
 *
 * @param {string} label - Channel name (or short label) for logging.
 * @param {(event: Electron.IpcMainInvokeEvent, params?: any) => Promise<any>} fn
 * @returns {(event: Electron.IpcMainInvokeEvent, params?: any) => Promise<any>}
 */
function handle(label, fn) {
    return async (event, params = {}) => {
        try {
            return await fn(event, params);
        } catch (err) {
            console.error(`❌ ${label} failed:`, err);

            const result = { error: err.message || label };

            if (!app.isPackaged && err.stack) {
                result.stack = err.stack;
            }

            return result;
        }
    };
}

module.exports = { handle };
