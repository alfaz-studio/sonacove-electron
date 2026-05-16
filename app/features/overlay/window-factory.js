const { BrowserWindow, app, globalShortcut } = require('electron');

const {
    ALWAYS_ON_TOP_LEVEL,
    TRANSPARENT_BG,
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    IPC_TOGGLE_CLICK_THROUGH,
    IPC_SHOW_OVERLAY
} = require('./constants');
const { getIconPath } = require('../paths');

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
 * @param {{ collabEnabled?: boolean }} [options] - Additional options.
 * @returns {void}
 */
function configurePlatform(win, screenBounds, options = {}) {
    const { x, y, width, height } = screenBounds;

    // When collab is enabled, exclude the overlay from screen capture so
    // annotations are shared via Excalidraw collab (transparent whiteboard).
    // When collab is disabled (default), include annotations in the capture
    // stream so viewers see them directly in the screenshare video.
    win.setContentProtection(Boolean(options.collabEnabled));

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

    // White-flash fix (#530): showing the window on 'did-finish-load' surfaces
    // it before React mounts and applies the transparent background, so
    // Chromium's default white document paints through the transparent window.
    // The overlay renderer instead signals readiness via the 'show-overlay'
    // IPC once it has forced transparent backgrounds (see AnnotationOverlay /
    // useTransparentBackground). We wait for that signal and only fall back to
    // a timer if it never arrives (e.g. the renderer crashed before mount).
    let shown = false;
    let showFallbackTimer = null;
    const showOnce = () => {
        if (shown || !win || win.isDestroyed()) {
            return;
        }
        shown = true;
        win.show();
        win.focus();
    };

    win.webContents.ipc.on(IPC_SHOW_OVERLAY, showOnce);

    win.webContents.on('did-finish-load', () => {
        // Safety net only — never show this early on the happy path.
        clearTimeout(showFallbackTimer);
        showFallbackTimer = setTimeout(showOnce, 4000);
    });

    win.on('closed', () => {
        clearTimeout(showFallbackTimer);
        onClosed();
    });
}

module.exports = {
    createOverlayWindow,
    configurePlatform,
    registerShortcut,
    wireEvents,
    overlayWindows
};
