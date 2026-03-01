const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');

const {
    OVERLAY_PRELOAD_FILENAME,
    FALLBACK_PRELOAD_FILENAME
} = require('./constants');

// ── Window lookup ───────────────────────────────────────────────────────────

/**
 * Finds the main Sonacove application window.
 *
 * @returns {BrowserWindow|undefined} The main window instance.
 */
function getMainWindow() {
    const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());

    // 1. Try by title
    const byTitle = windows.find(w => w.getTitle().includes('Sonacove'));

    if (byTitle) {
        return byTitle;
    }

    // 2. Try by visibility
    const visible = windows.find(w => w.isVisible());

    if (visible) {
        return visible;
    }

    // 3. Fallback
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
 * known candidate locations. Prefers the dedicated overlay-preload; falls
 * back to the main preload for backward compatibility.
 *
 * @returns {string|undefined} The resolved preload path, or undefined if not found.
 */
function resolvePreloadPath() {
    const filenames = [ OVERLAY_PRELOAD_FILENAME, FALLBACK_PRELOAD_FILENAME ];
    const dirs = [
        path.join(app.getAppPath(), 'build'),
        app.getAppPath(),
        path.join(__dirname, '..', '..', '..', 'app', 'preload'),
        path.join(__dirname, '..', '..', '..', 'build'),
        path.join(__dirname, '..', '..', '..', '..', 'build'),
        path.join(__dirname, '..', '..', '..', '..', '..', 'build')
    ];

    for (const filename of filenames) {
        for (const dir of dirs) {
            const candidate = path.join(dir, filename);

            if (fs.existsSync(candidate)) {
                console.log(`✅ Annotation Overlay using preload: ${candidate}`);

                return candidate;
            }
        }
    }

    console.error('❌ CRITICAL: Could not find overlay preload script!');
    console.error('Searched directories:', dirs);
    console.error('Searched filenames:', filenames);

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
    const { annotationsUrl, roomUrl, collabDetails, collabServerUrl } = data;

    if (annotationsUrl) {
        console.log(`🖌️ Opening Annotations Overlay: ${annotationsUrl}`);

        return annotationsUrl;
    }

    const joinUrl = new URL(roomUrl);

    joinUrl.searchParams.set('standalone', 'true');
    joinUrl.searchParams.set('whiteboardId', collabDetails.roomId);
    joinUrl.searchParams.set('whiteboardKey', collabDetails.roomKey);
    joinUrl.searchParams.set('whiteboardServer', collabServerUrl);

    const url = joinUrl.toString();

    console.log(`🖌️ Opening Standalone Whiteboard: ${url}`);

    return url;
}

module.exports = {
    getMainWindow,
    sendToMainWindow,
    restoreMainWindow,
    resolvePreloadPath,
    buildOverlayUrl
};
