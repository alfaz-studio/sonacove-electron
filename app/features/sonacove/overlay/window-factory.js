const { BrowserWindow, app, globalShortcut } = require('electron');

const {
    ALWAYS_ON_TOP_LEVEL,
    TRANSPARENT_BG,
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    IPC_TOGGLE_CLICK_THROUGH
} = require('./constants');
const { getIconPath } = require('../../main-window/icon');

/** Module-level set tracking overlay windows (safer than setting arbitrary props on BrowserWindow). */
const overlayWindows = new Set();

/**
 * Creates the BrowserWindow instance for the annotation overlay.
 *
 * @param {{ x: number, y: number, width: number, height: number }} screenBounds - Target screen bounds.
 * @param {string|undefined} preloadPath - Resolved preload script path.
 * @returns {BrowserWindow} The new overlay window.
 */
function createOverlayWindow(screenBounds, preloadPath) {
    const { x, y, width, height } = screenBounds;
    const isMac = process.platform === 'darwin';

    const windowOptions = {
        x: Math.floor(x),
        y: Math.floor(y),
        width: Math.floor(width),
        height: Math.floor(height),
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        roundedCorners: false,
        fullscreen: !isMac,
        resizable: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: TRANSPARENT_BG,
        icon: getIconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath,

            // Dedicated partition so the CORS relaxation in wireEvents()
            // only affects the overlay, not the main window's session.
            partition: 'persist:overlay'
        }
    };

    if (isMac) {
        windowOptions.type = 'utility';
    }

    const win = new BrowserWindow(windowOptions);

    // Track so getMainWindow() can exclude overlays from its search
    overlayWindows.add(win);
    win.on('closed', () => overlayWindows.delete(win));

    return win;
}

/**
 * Applies platform-specific configuration to the overlay window.
 *
 * @param {BrowserWindow} win - The overlay window.
 * @param {{ x: number, y: number, width: number, height: number }} screenBounds - Target screen bounds.
 * @returns {void}
 */
function configurePlatform(win, screenBounds) {
    const { x, y, width, height } = screenBounds;

    // Exclude the overlay from screen capture so annotations don't appear
    // in the shared screen stream. On Windows 10 2004+ this uses
    // WDA_EXCLUDEFROMCAPTURE; on macOS it sets NSWindowSharingNone.
    // Note: silently a no-op on Linux — Electron does not implement it there.
    win.setContentProtection(true);

    if (process.platform === 'darwin') {
        app.dock.show();
        win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.setBounds({
            x: Math.floor(x),
            y: Math.floor(y),
            width: Math.floor(width),
            height: Math.floor(height)
        });
    } else {
        win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
        win.setFullScreen(true);
    }
}

/**
 * Registers the global keyboard shortcut for toggling click-through on the overlay.
 *
 * @param {BrowserWindow} win - The overlay window to send the toggle request to.
 * @returns {void}
 */
function registerShortcut(win) {
    const success = globalShortcut.register(SHORTCUT_TOGGLE_CLICK_THROUGH, () => {
        if (win && !win.isDestroyed()) {
            win.webContents.send(IPC_TOGGLE_CLICK_THROUGH);
        }
    });

    if (!success) {
        console.warn(
            `⚠️ Failed to register shortcut "${SHORTCUT_TOGGLE_CLICK_THROUGH}".`
            + ' Another application may have claimed it. Click-through toggle will not work.'
        );
    }
}

/**
 * Wires lifecycle event listeners on the overlay window (load, close, cleanup).
 *
 * @param {BrowserWindow} win - The overlay window.
 * @param {string} [collabServerUrl] - The collab server URL (for scoped CORS injection).
 * @param {Object} callbacks - Lifecycle callbacks.
 * @param {Function} callbacks.onClosed - Called when the window is closed externally.
 * @returns {void}
 */
function wireEvents(win, collabServerUrl, { onClosed }) {
    // Allow cross-origin requests to the collab server (fonts, WebSocket handshake)
    // without disabling webSecurity globally. Scoped to the collab server origin
    // so other endpoints (auth, analytics) keep their own CORS policies.
    let collabOrigin = null;

    try {
        if (collabServerUrl) {
            collabOrigin = new URL(collabServerUrl).origin;
        }
    } catch { /* invalid URL — skip CORS injection */ }

    if (collabOrigin) {
        win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
            const headers = { ...details.responseHeaders };

            if (details.url.startsWith(collabOrigin)) {
                const hasACHeader = Object.keys(headers)
                    .some(k => k.toLowerCase() === 'access-control-allow-origin');

                if (!hasACHeader) {
                    headers['Access-Control-Allow-Origin'] = [ '*' ];
                    headers['Access-Control-Allow-Headers'] = [ '*' ];
                }
            }
            callback({ responseHeaders: headers });
        });
    }

    win.webContents.on('did-finish-load', () => {
        if (win && !win.isDestroyed()) {
            win.show();
            win.focus();
        }
    });

    win.on('closed', onClosed);
}

module.exports = {
    createOverlayWindow,
    configurePlatform,
    registerShortcut,
    wireEvents,
    overlayWindows
};
