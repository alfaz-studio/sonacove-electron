/**
 * Screenshare border — window lifecycle.
 *
 * A transparent, frameless, always-on-top, click-through overlay that draws an
 * orange frame around the DISPLAY the Electron presenter is sharing (full-screen
 * shares only — window shares get no border). The frame is excluded from the
 * capture stream via setContentProtection(true), so only the presenter sees it.
 *
 * Mirrors the annotation overlay's window options + display-change handling
 * (see overlay/window-factory.js + overlay/overlay-window.js), simplified: the
 * page is a tiny static local HTML, so there's no remote-load watchdog.
 */

const { app, BrowserWindow, screen } = require('electron');
const isDev = require('electron-is-dev');
const fs = require('fs');
const path = require('path');

const { ALWAYS_ON_TOP_LEVEL, TRANSPARENT_BG } = require('../overlay/constants');
const { getMainWindow } = require('../overlay/helpers');
const { getIconPath } = require('../paths');
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

// Trailing-debounce timer for display-metrics-changed (coalesces bursts).
let metricsDebounceTimer = null;

// Trailing-debounce delay (ms) for coalescing display-metrics bursts.
const METRICS_DEBOUNCE_MS = 200;

// ── Asset resolution ─────────────────────────────────────────────────────────

/**
 * Resolves a bundled border asset across the candidate dirs (build dir, app
 * dir, __dirname) — same approach as the overlay preload resolver, so it works
 * both in dev (source tree) and packaged builds.
 *
 * @param {string} filename - The file to find.
 * @returns {string|null} The resolved absolute path, or null if not found.
 */
function resolveAsset(filename) {
    const candidates = [
        path.join(app.getAppPath(), 'build', filename),
        path.join(app.getAppPath(), filename),
        path.join(__dirname, filename),
        path.join(__dirname, '../../../build', filename)
    ];

    return candidates.find(p => fs.existsSync(p)) || null;
}

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

/** Handles a display being removed — self-close if it's the one we're on. */
function onDisplayRemoved(_event, display) {
    if (borderWindow && display?.id === borderDisplayId) {
        console.warn('⚠️ Share-border display removed — closing border.');
        closeShareBorderWindow();
    }
}

/**
 * Handles our display's metrics changing (resolution/scale) — refit or
 * self-close. Coalesced with a short trailing debounce so a burst of events
 * (e.g. resolution + scaleFactor landing together) settles to one reposition.
 */
function onDisplayMetricsChanged(_event, display, changedMetrics) {
    if (!borderWindow || display?.id !== borderDisplayId) {
        return;
    }
    if (!changedMetrics?.includes('bounds') && !changedMetrics?.includes('scaleFactor')) {
        return;
    }

    if (metricsDebounceTimer) {
        clearTimeout(metricsDebounceTimer);
    }
    metricsDebounceTimer = setTimeout(() => {
        metricsDebounceTimer = null;

        // The window may have been torn down during the debounce window.
        if (!borderWindow || borderWindow.isDestroyed()) {
            return;
        }

        const target = screen.getAllDisplays().find(d => d.id === borderDisplayId);

        if (!target) {
            closeShareBorderWindow();

            return;
        }
        repositionBorder(target.workArea);
    }, METRICS_DEBOUNCE_MS);
}

let displayListenersAttached = false;

/** Subscribe to display changes while the border is open. */
function attachDisplayListeners() {
    if (displayListenersAttached) {
        return;
    }
    screen.on('display-removed', onDisplayRemoved);
    screen.on('display-metrics-changed', onDisplayMetricsChanged);
    displayListenersAttached = true;
}

/** Remove display-change subscriptions once the border is gone. */
function detachDisplayListeners() {
    if (!displayListenersAttached) {
        return;
    }
    screen.removeListener('display-removed', onDisplayRemoved);
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
    displayListenersAttached = false;
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

    const preloadPath = resolveAsset(SHARE_BORDER_PRELOAD_FILENAME);
    const htmlPath = resolveAsset(SHARE_BORDER_HTML_FILENAME);

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
        detachDisplayListeners();
        if (metricsDebounceTimer) {
            clearTimeout(metricsDebounceTimer);
            metricsDebounceTimer = null;
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

    attachDisplayListeners();
    borderWindow.loadFile(htmlPath);
}

/**
 * Closes the screenshare border window and clears its display listeners.
 *
 * @returns {void}
 */
function closeShareBorderWindow() {
    detachDisplayListeners();
    if (metricsDebounceTimer) {
        clearTimeout(metricsDebounceTimer);
        metricsDebounceTimer = null;
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
