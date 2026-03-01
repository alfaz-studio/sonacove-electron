const { BrowserWindow, app, globalShortcut } = require('electron');
const path = require('path');

const {
    ALWAYS_ON_TOP_LEVEL,
    TRANSPARENT_BG,
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    IPC_TOGGLE_CLICK_THROUGH
} = require('./constants');

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
        enableLargerThanScreen: true,
        roundedCorners: false,
        fullscreen: !isMac,
        resizable: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: TRANSPARENT_BG,
        icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,

            // webSecurity is disabled because the overlay loads content from the
            // app origin (e.g. localhost:5173 in dev) which may fetch assets
            // (fonts, collab WebSocket handshake) from the collab server on a
            // different origin. contextIsolation: true ensures this does NOT
            // give the page access to Node internals despite the relaxed CORS.
            webSecurity: false,
            sandbox: true,
            preload: preloadPath
        }
    };

    if (isMac) {
        windowOptions.type = 'utility';
    }

    return new BrowserWindow(windowOptions);
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
    globalShortcut.register(SHORTCUT_TOGGLE_CLICK_THROUGH, () => {
        if (win && !win.isDestroyed()) {
            win.webContents.send(IPC_TOGGLE_CLICK_THROUGH);
        }
    });
}

/**
 * Wires lifecycle event listeners on the overlay window (load, close, cleanup).
 *
 * @param {BrowserWindow} win - The overlay window.
 * @param {Object} callbacks - Lifecycle callbacks.
 * @param {Function} callbacks.onClosed - Called when the window is closed externally.
 * @returns {void}
 */
function wireEvents(win, { onClosed }) {
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
    wireEvents
};
