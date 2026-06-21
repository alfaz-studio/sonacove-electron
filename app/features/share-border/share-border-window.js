/**
 * Screenshare border — window lifecycle.
 *
 * A transparent, frameless, always-on-top, click-through overlay that draws an
 * accent frame around the DISPLAY the Electron presenter is sharing (full-screen
 * shares only — window shares get no border). The frame is excluded from the
 * capture stream via setContentProtection(true), so only the presenter sees it.
 *
 * Mirrors the annotation overlay's window options, and shares its display-follow
 * watcher (../overlay/display-follow) for refit-on-metrics-change / close-on-
 * display-removed. The page is a tiny static local HTML, so there's no
 * remote-load watchdog.
 */

const { app, BrowserWindow, screen } = require('electron');
const isDev = require('electron-is-dev');

const { ALWAYS_ON_TOP_LEVEL, TRANSPARENT_BG } = require('../overlay/constants');
const { attachDisplayFollow } = require('../overlay/display-follow');
const { getMainWindow } = require('../overlay/helpers');
const { getIconPath } = require('../paths');
const { resolveFile } = require('../pip/helpers');
const { getLastTheme } = require('../pip/participant-window');

const {
    IPC_SHARE_BORDER_THEME,
    SHARE_BORDER_PRELOAD_FILENAME,
    SHARE_BORDER_HTML_FILENAME
} = require('./constants');

// ── Module state ────────────────────────────────────────────────────────────

let borderWindow = null;

// id of the display the border was opened on — tracked so it can follow that
// display's geometry changes and self-close if the display is unplugged.
let borderDisplayId = null;

// Detach handle for the shared display-follow watcher (see ../overlay/display-follow).
let detachDisplayFollow = null;

// ── Display-change handling ─────────────────────────────────────────────────

/**
 * Re-applies the border's geometry to the given work-area bounds. We size to the
 * display's work area (not full bounds) so the bottom edge clears the Windows
 * taskbar — a full-bounds window sits behind the system-topmost taskbar, hiding
 * the bottom line.
 *
 * @param {{ x: number, y: number, width: number, height: number }} bounds - Target work-area bounds.
 * @returns {void}
 */
function repositionBorder(bounds) {
    if (!borderWindow || borderWindow.isDestroyed()) {
        return;
    }

    const target = {
        x: Math.floor(bounds.x),
        y: Math.floor(bounds.y),
        width: Math.floor(bounds.width),
        height: Math.floor(bounds.height)
    };

    try {
        borderWindow.setBounds(target);
        borderWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
    } catch (e) {
        console.error('❌ Failed to reposition share border after display change:', e);
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Opens the screenshare border on the display the presenter is sharing. No-op if
 * already open (the border is a singleton). Resolves the shared display from the
 * main meeting window (excluding the PiP/overlay aux windows via getMainWindow).
 *
 * @returns {void}
 */
function openShareBorderWindow() {
    // Already open — don't create a second frame.
    if (borderWindow && !borderWindow.isDestroyed()) {
        return;
    }

    const mainWindow = getMainWindow();
    const displayBounds = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : screen.getPrimaryDisplay().bounds;
    const display = screen.getDisplayMatching(displayBounds);

    const preloadPath = resolveFile(SHARE_BORDER_PRELOAD_FILENAME, __dirname);
    const htmlPath = resolveFile(SHARE_BORDER_HTML_FILENAME, __dirname);

    if (!preloadPath || !htmlPath) {
        console.error('❌ ShareBorder: could not resolve preload/html assets.');

        return;
    }

    borderDisplayId = display.id;

    if (isDev) {
        console.log(
            `🟧 Launching Share Border on Screen: ${display.label}`
            + ` at ${display.workArea.x},${display.workArea.y}`
            + ` (${display.workArea.width}x${display.workArea.height})`
        );
    }

    // Size to the work area (not full bounds) so the bottom edge clears the
    // taskbar; a fullscreen/full-bounds window hides its bottom line behind the
    // system-topmost taskbar. No `fullscreen` for the same reason — fullscreen
    // forces full monitor bounds and ignores the work-area inset.
    const { x, y, width, height } = display.workArea;
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
        resizable: false,
        skipTaskbar: true,
        show: false,

        // NOTE: deliberately NOT `focusable: false`. We mirror the annotation
        // overlay (which is excluded from capture reliably on the same Windows
        // builds): a non-focusable window did NOT get excluded here. Focus theft
        // is instead avoided by revealing with showInactive() below.
        backgroundColor: TRANSPARENT_BG,
        icon: getIconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath
        }
    };

    if (isMac) {
        windowOptions.type = 'utility';
    }

    borderWindow = new BrowserWindow(windowOptions);

    // Passive, click-through, sharer-only visual (mirrors the annotation
    // overlay, which is reliably excluded from capture on the same machines):
    //  - screen-saver always-on-top so it floats above fullscreen apps
    //  - setContentProtection(true) excludes it from the capture stream so
    //    viewers don't see it. Re-asserted after show() below — Electron drops
    //    the capture-exclusion flag across a hide→show cycle (electron#29085),
    //    and this window is created hidden then revealed with showInactive().
    //  - setIgnoreMouseEvents click-through so it never eats input
    borderWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
    borderWindow.setContentProtection(true);
    borderWindow.setIgnoreMouseEvents(true, { forward: true });

    if (isMac) {
        app.dock.show();
        borderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        borderWindow.setBounds({
            x: Math.floor(x),
            y: Math.floor(y),
            width: Math.floor(width),
            height: Math.floor(height)
        });
    }

    borderWindow.on('closed', () => {
        borderWindow = null;
        if (detachDisplayFollow) {
            detachDisplayFollow();
            detachDisplayFollow = null;
        }
        borderDisplayId = null;
    });

    borderWindow.webContents.on('did-finish-load', () => {
        if (!borderWindow || borderWindow.isDestroyed()) {
            return;
        }

        // showInactive (not show) so the border never steals focus from the
        // shared app / meeting window.
        borderWindow.showInactive();

        // Re-assert capture-exclusion AFTER show — Electron loses the flag
        // across the hidden→shown transition (electron#29085), so setting it
        // only at create time (above) leaves the border visible to viewers.
        borderWindow.setContentProtection(true);

        // Replay the cached host theme so the frame recolours to the app accent
        // the moment it loads (live changes arrive via sendShareBorderTheme).
        borderWindow.webContents.send(IPC_SHARE_BORDER_THEME, getLastTheme());
    });

    // Follow the shared display: refit on metrics change, self-close if unplugged.
    detachDisplayFollow = attachDisplayFollow({
        getWindow: () => borderWindow,
        getDisplayId: () => borderDisplayId,
        reposition: target => repositionBorder(target.workArea),
        onGone: closeShareBorderWindow
    });

    borderWindow.loadFile(htmlPath);
}

/**
 * Closes the screenshare border window and clears its display listeners.
 *
 * @returns {void}
 */
function closeShareBorderWindow() {
    if (detachDisplayFollow) {
        detachDisplayFollow();
        detachDisplayFollow = null;
    }
    borderDisplayId = null;

    if (borderWindow && !borderWindow.isDestroyed()) {
        borderWindow.destroy();
    }
    borderWindow = null;
}

/**
 * Forwards host theme tokens to the border so its frame recolours live with the
 * app theme. No-op if the border is closed or no theme is available.
 *
 * @param {Object|null} theme - The theme token map ({ accent, accentHover, … }).
 * @returns {void}
 */
function sendShareBorderTheme(theme) {
    if (theme && borderWindow && !borderWindow.isDestroyed()) {
        borderWindow.webContents.send(IPC_SHARE_BORDER_THEME, theme);
    }
}

module.exports = {
    openShareBorderWindow,
    closeShareBorderWindow,
    sendShareBorderTheme
};
