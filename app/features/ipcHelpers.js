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
