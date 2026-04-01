/**
 * Pill mode for the participant PiP panel.
 *
 * When the user clicks the close (×) button, the panel shrinks to a small
 * floating pill.  Clicking the pill expands it back to the full panel.
 */

const { ipcMain, screen } = require('electron');
const { PILL_SIZE, MARGIN, IPC } = require('./constants');
const { getMainWindow } = require('./helpers');
const { computeWindowSize, getWindowPosition } = require('./sizing');

let _getWindow = null;
let _isPillMode = false;

/**
 * @returns {boolean} Whether the panel is currently in pill mode.
 */
function isPillMode() {
    return _isPillMode;
}

/**
 * Resets pill mode state (called when the window is destroyed).
 */
function reset() {
    _isPillMode = false;
}

/**
 * Shrinks the participant panel to a floating pill button.
 * The BrowserWindow stays alive (always-on-top) so the pill floats above the
 * shared screen.  Sends 'pip-panel-closed' to the main renderer so
 * frame-sending stops.
 *
 * @param {number} _count - Unused (kept for API symmetry with expand).
 * @param {string} _orientation - Unused.
 */
function shrinkToPill() {
    const win = _getWindow?.();

    if (!win || win.isDestroyed()) {
        return;
    }

    _isPillMode = true;

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x: waX, y: waY, width: waW, height: waH } = display.workArea;
    const pillX = waX + waW - PILL_SIZE - MARGIN;
    const pillY = waY + waH - PILL_SIZE - MARGIN;

    win.setResizable(true);
    win.setMinimumSize(PILL_SIZE, PILL_SIZE);
    win.setBounds({
        x: Math.max(0, pillX),
        y: Math.max(0, pillY),
        width: PILL_SIZE,
        height: PILL_SIZE,
    });
    win.setResizable(false);

    win.webContents.send(IPC.ENTER_PILL_MODE);

    const mw = getMainWindow();

    if (mw && !mw.isDestroyed()) {
        mw.webContents.send(IPC.PANEL_CLOSED);
    }
}

/**
 * Expands the floating pill back to a full participant panel.
 * Sends 'pip-panel-reopened' to the main renderer so frame-sending resumes.
 *
 * @param {number} count - Current participant count.
 * @param {string} orientation - Current orientation.
 */
function expandFromPill(count, orientation) {
    const win = _getWindow?.();

    if (!win || win.isDestroyed()) {
        return;
    }

    _isPillMode = false;

    const { width: W, height: H } = computeWindowSize(count, orientation);
    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x: posX, y: posY } = getWindowPosition(count, orientation, display.workArea);

    win.setResizable(true);
    win.setMinimumSize(1, 1);
    win.setBounds({ x: posX, y: posY, width: W, height: H });
    win.setResizable(false);

    win.webContents.send(IPC.ENTER_PANEL_MODE);

    const mw = getMainWindow();

    if (mw && !mw.isDestroyed()) {
        mw.webContents.send(IPC.PANEL_REOPENED);
    }
}

/**
 * Registers pill-related IPC handlers.
 *
 * @param {() => Electron.BrowserWindow|null} getWindow
 * @param {() => { count: number, orientation: string }} getState - Returns
 *   current participant count and orientation for expand sizing.
 */
function setupPillHandlers(getWindow, getState) {
    _getWindow = getWindow;

    ipcMain.on(IPC.REOPEN_REQUEST, () => {
        const { count, orientation } = getState();

        expandFromPill(count, orientation);
    });
}

/**
 * Removes pill IPC handlers and resets state.
 */
function cleanup() {
    _isPillMode = false;
    ipcMain.removeAllListeners(IPC.REOPEN_REQUEST);
}

module.exports = {
    isPillMode,
    reset,
    shrinkToPill,
    expandFromPill,
    setupPillHandlers,
    cleanup,
};
