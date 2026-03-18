const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const isDev = require('electron-is-dev');

const { OVERLAY_PRELOAD_FILENAME } = require('./constants');
const { overlayWindows } = require('./window-factory');

// ── Window lookup ───────────────────────────────────────────────────────────

/**
 * Finds the main Sonacove application window.
 *
 * @returns {BrowserWindow|undefined} The main window instance.
 */
function getMainWindow() {
    const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && !overlayWindows.has(w));

    // 1. Try by visibility (more reliable than title which may not be set during startup)
    const visible = windows.find(w => w.isVisible());

    if (visible) {
        return visible;
    }

    // 2. Fallback
    return windows[0];
}

/**
 * Sends an IPC message to the main window if it exists and is not destroyed.
 *
 * @param {string} channel - The IPC channel name.
 * @param {Object} [data] - Optional data payload.
 * @returns {void}
 */
function sendToMainWindow(channel, data) {
    const mw = getMainWindow();

    if (mw && !mw.isDestroyed()) {
        mw.webContents.send(channel, data);
    }
}

/**
 * Forcefully brings the main window back to the front and ensures the Dock icon is visible.
 *
 * @param {BrowserWindow} [mainWindow] - Optional window to restore. Falls back to getMainWindow().
 * @returns {void}
 */
function restoreMainWindow(mainWindow) {
    const mw = mainWindow || getMainWindow();

    if (process.platform === 'darwin') {
        app.dock.show();
    }

    if (mw && !mw.isDestroyed()) {
        if (mw.isMinimized()) {
            mw.restore();
        }
        mw.show();
        mw.focus();
    }
}

// ── Overlay creation helpers ────────────────────────────────────────────────

/**
 * Resolves the absolute path to the overlay preload script by searching
 * known candidate locations.
 *
 * Only the dedicated overlay-preload script is accepted. The main preload.js
 * is NOT a valid fallback because it relies on `window.sonacoveElectronAPI`
 * (no contextBridge), which silently fails in the sandboxed overlay window
 * (contextIsolation: true, sandbox: true).
 *
 * @returns {string|undefined} The resolved preload path, or undefined if not found.
 */
function resolvePreloadPath() {
    const dirs = [
        path.join(app.getAppPath(), 'build'),
        app.getAppPath(),
        path.join(__dirname, '..', '..', '..', 'app', 'preload')
    ];

    for (const dir of dirs) {
        const candidate = path.join(dir, OVERLAY_PRELOAD_FILENAME);

        if (fs.existsSync(candidate)) {
            if (isDev) {
                console.log(`✅ Annotation Overlay using preload: ${candidate}`);
            }

            return candidate;
        }
    }

    console.error(`❌ CRITICAL: Could not find ${OVERLAY_PRELOAD_FILENAME}!`);
    console.error('   The main preload.js is NOT a valid substitute — it lacks');
    console.error('   contextBridge bindings required by the sandboxed overlay.');
    console.error('Searched directories:', dirs);

    return undefined;
}

/**
 * Builds the URL to load in the overlay window.
 *
 * If an annotationsUrl is provided it is used directly; otherwise a
 * standalone whiteboard URL is constructed from the collab details.
 *
 * @param {Object} data - Configuration data containing URL info.
 * @param {string} [data.annotationsUrl] - Direct URL for annotation overlay.
 * @param {string} [data.roomUrl] - Room URL for standalone whiteboard mode.
 * @param {Object} [data.collabDetails] - Collaboration room details.
 * @param {string} [data.collabServerUrl] - Collaboration server URL.
 * @returns {string} The fully-formed overlay URL.
 */
function buildOverlayUrl(data) {
    const { annotationsUrl, roomUrl, collabDetails, collabServerUrl, localParticipantName } = data;

    if (annotationsUrl) {
        if (isDev) {
            console.log(`🖌️ Opening Annotations Overlay: ${annotationsUrl}`);
        }

        return annotationsUrl;
    }

    let joinUrl;

    try {
        joinUrl = new URL(roomUrl);
    } catch {
        console.error(`❌ buildOverlayUrl: invalid roomUrl "${roomUrl}"`);

        return null;
    }

    joinUrl.searchParams.set('standalone', 'true');
    joinUrl.searchParams.set('whiteboardId', collabDetails.roomId);
    joinUrl.searchParams.set('whiteboardKey', collabDetails.roomKey);
    joinUrl.searchParams.set('whiteboardServer', collabServerUrl);

    if (localParticipantName) {
        joinUrl.searchParams.set('userName', localParticipantName);
    }

    const url = joinUrl.toString();

    if (isDev) {
        console.log(`🖌️ Opening Standalone Whiteboard: ${url}`);
    }

    return url;
}

module.exports = {
    getMainWindow,
    sendToMainWindow,
    restoreMainWindow,
    resolvePreloadPath,
    buildOverlayUrl
};
