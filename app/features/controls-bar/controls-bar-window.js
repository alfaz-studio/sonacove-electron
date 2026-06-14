/**
 * Screenshare controls bar — window lifecycle.
 *
 * A transparent, frameless, always-on-top window showing the "sharing strip"
 * that expands (resize-on-hover) to reveal the meeting controls. Phase 1 is
 * visuals only; control actions are wired in Phase 2.
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');

const {
    WINDOW_W,
    COLLAPSED_H,
    EXPANDED_H,
    TOP_MARGIN,
    IPC
} = require('./constants');
const { resolveFile } = require('./helpers');

let controlsBarWindow = null;

// Optional getter for the meeting's main window, so the bar opens on the same
// display. Falls back to the primary display (e.g. the standalone preview).
let getMainWindow = () => null;

/** Pick the display the bar should live on. */
function targetWorkArea() {
    const main = getMainWindow();
    const display = main && !main.isDestroyed()
        ? screen.getDisplayMatching(main.getBounds())
        : screen.getPrimaryDisplay();

    return display.workArea;
}

/** Top-centred collapsed bounds on the target display. */
function initialBounds() {
    const wa = targetWorkArea();

    return {
        x: Math.round(wa.x + ((wa.width - WINDOW_W) / 2)),
        y: Math.round(wa.y + TOP_MARGIN),
        width: WINDOW_W,
        height: COLLAPSED_H
    };
}

// ── Drag (cursor poll + atomic setBounds, like the PiP panel) ───────────────

let dragInterval = null;
let dragOffset = { x: 0,
    y: 0 };

/** Begins dragging the window by polling the cursor (atomic setBounds). */
function startDrag() {
    if (!controlsBarWindow || controlsBarWindow.isDestroyed()) {
        return;
    }
    const cursor = screen.getCursorScreenPoint();
    const b = controlsBarWindow.getBounds();

    dragOffset = { x: cursor.x - b.x,
        y: cursor.y - b.y };

    if (dragInterval) {
        clearInterval(dragInterval);
    }
    dragInterval = setInterval(() => {
        if (!controlsBarWindow || controlsBarWindow.isDestroyed()) {
            stopDrag();

            return;
        }
        const pos = screen.getCursorScreenPoint();
        const cur = controlsBarWindow.getBounds();

        controlsBarWindow.setBounds({
            x: Math.round(pos.x - dragOffset.x),
            y: Math.round(pos.y - dragOffset.y),
            width: cur.width,
            height: cur.height
        });
    }, 16);
}

/** Stops an in-progress window drag. */
function stopDrag() {
    if (dragInterval) {
        clearInterval(dragInterval);
        dragInterval = null;
    }
}

// ── Resize on hover (top + horizontal centre stay fixed) ────────────────────

/**
 * Resizes the window between collapsed and expanded, keeping the top edge and
 * horizontal centre fixed so the strip stays put while the controls grow down.
 *
 * @param {boolean} expanded - Whether to show the controls.
 * @returns {void}
 */
function setExpanded(expanded) {
    if (!controlsBarWindow || controlsBarWindow.isDestroyed() || dragInterval) {
        return;
    }
    const b = controlsBarWindow.getBounds();

    // Only the height changes — x/width stay fixed so the window never shifts
    // horizontally (which flashed the content) and the strip's shadow has room.
    controlsBarWindow.setBounds({
        x: b.x,
        y: b.y, // top fixed — controls grow downward, pushing the strip down
        width: b.width,
        height: expanded ? EXPANDED_H : COLLAPSED_H
    });
}

// ── IPC ──────────────────────────────────────────────────────────────────────

let ipcWired = false;

/** Registers the bar's IPC listeners once (idempotent). */
function wireIpcOnce() {
    if (ipcWired) {
        return;
    }
    ipcWired = true;

    ipcMain.on(IPC.HOVER, (_e, expanded) => setExpanded(Boolean(expanded)));
    ipcMain.on(IPC.START_DRAG, startDrag);
    ipcMain.on(IPC.STOP_DRAG, stopDrag);
    ipcMain.on(IPC.STOP_SHARE, () => {
        // Phase 2: forward to the renderer to actually stop the screenshare.
    });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Opens the controls bar window.
 *
 * @param {() => BrowserWindow|null} [mainWindowGetter] - Getter for the meeting
 *   main window (display targeting). Omit for the standalone preview.
 * @returns {BrowserWindow|null}
 */
function openControlsBarWindow(mainWindowGetter) {
    if (typeof mainWindowGetter === 'function') {
        getMainWindow = mainWindowGetter;
    }

    if (controlsBarWindow && !controlsBarWindow.isDestroyed()) {
        controlsBarWindow.focus();

        return controlsBarWindow;
    }

    const preloadPath = resolveFile('controls-bar-preload.js', __dirname);
    const htmlPath = resolveFile('controls-bar.html', __dirname);

    if (!preloadPath || !htmlPath) {
        console.error('❌ ControlsBar: could not resolve preload/html assets');

        return null;
    }

    wireIpcOnce();

    controlsBarWindow = new BrowserWindow({
        ...initialBounds(),
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        resizable: false,
        skipTaskbar: true,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: preloadPath
        }
    });

    if (process.platform === 'darwin') {
        controlsBarWindow.setAlwaysOnTop(true, 'floating');
        controlsBarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
        controlsBarWindow.setAlwaysOnTop(true, 'normal');
    }

    controlsBarWindow.on('closed', () => {
        controlsBarWindow = null;
        stopDrag();
    });

    controlsBarWindow.webContents.on('did-finish-load', () => {
        if (controlsBarWindow && !controlsBarWindow.isDestroyed()) {
            controlsBarWindow.show();
            if (process.platform === 'darwin') {
                app.dock.show();
            }
        }
    });

    controlsBarWindow.loadFile(htmlPath);

    return controlsBarWindow;
}

/** Closes the controls bar window and clears any drag state. */
function closeControlsBarWindow() {
    if (controlsBarWindow && !controlsBarWindow.isDestroyed()) {
        controlsBarWindow.destroy();
    }
    controlsBarWindow = null;
    stopDrag();
}

module.exports = {
    openControlsBarWindow,
    closeControlsBarWindow
};
