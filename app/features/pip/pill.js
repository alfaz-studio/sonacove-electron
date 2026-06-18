/**
 * Pill mode for the participant PiP panel.
 *
 * When the user clicks the close (×) button, the panel shrinks to a small
 * floating pill.  Clicking the pill expands it back to the full panel.
 */

const { ipcMain, screen } = require('electron');
const { PILL_SIZE, PILL_HINT_HEADROOM, MARGIN, IPC } = require('./constants');
const { getMainWindowExcludingPip: getMainWindow } = require('./helpers');
const { getCardPosition } = require('./sizing');

let _getWindow = null;
let _restoreConstraints = null;
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

    // Tell the renderer to transition to pill mode first, then resize the
    // window after the panel hide animation completes.  Resizing a transparent
    // BrowserWindow on Windows before the renderer is ready causes blank frames.
    win.webContents.send(IPC.ENTER_PILL_MODE);

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x: waX, y: waY, width: waW, height: waH } = display.workArea;
    const pillX = waX + waW - PILL_SIZE - MARGIN;

    // The window is taller than PILL_SIZE by PILL_HINT_HEADROOM (transparent room
    // above the pill for the "Drag to move" hint). Shift its top up by the same
    // amount so the window's BOTTOM — and thus the bottom-anchored visible pill —
    // lands exactly where the plain PILL_SIZE window would have.
    const pillH = PILL_SIZE + PILL_HINT_HEADROOM;
    const pillY = waY + waH - pillH - MARGIN;

    const mw = getMainWindow();

    if (mw && !mw.isDestroyed()) {
        mw.webContents.send(IPC.PANEL_CLOSED);
    }

    // Wait for the renderer's 200ms hide animation before shrinking.
    setTimeout(() => {
        if (!win || win.isDestroyed()) {
            return;
        }

        // Drop the OS window shadow: the window is transparent and only the
        // small round pill is painted, so the shadow would otherwise be drawn
        // around the full (square) window bounds — a rounded-square halo on
        // macOS, a square box on Windows. The pill keeps its own CSS shadow,
        // which fits within the PILL_SIZE window's margin.
        win.setHasShadow(false);

        // Lock to pill size — prevent resize while in pill mode. The window is
        // PILL_SIZE wide but PILL_SIZE + PILL_HINT_HEADROOM tall (headroom above
        // the pill for the hover hint); the pill itself is bottom-anchored in the
        // overlay so it stays PILL_SIZE-square at the window's bottom.
        win.setMinimumSize(PILL_SIZE, pillH);
        win.setMaximumSize(PILL_SIZE, pillH);
        win.setBounds({
            x: Math.max(0, pillX),
            y: Math.max(0, pillY),
            width: PILL_SIZE,
            height: pillH,
        });
    }, 220);
}

/**
 * Expands the floating pill back to a full participant card.
 * Sends 'pip-panel-reopened' to the main renderer so frame-sending resumes.
 *
 * @param {{ width: number, height: number }} size - Current card size to restore.
 */
function expandFromPill(size) {
    const win = _getWindow?.();

    if (!win || win.isDestroyed()) {
        return;
    }

    _isPillMode = false;

    // Restore the OS window shadow for the full panel (its rounded card fills
    // the window, so the window shadow is what gives the panel its depth).
    win.setHasShadow(true);

    const { width: W, height: H } = size;
    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x: posX, y: posY } = getCardPosition(W, H, display.workArea);

    // Release the pill size lock (min back to 1×1, max back to "no limit"),
    // then set the card bounds. The card is non-resizable, but the pill lock
    // pinned min/max to PILL_SIZE — clear it before resizing.
    win.setMaximumSize(0, 0); // 0 = no limit
    win.setMinimumSize(1, 1);
    win.setBounds({ x: posX, y: posY, width: W, height: H });

    if (_restoreConstraints) {
        _restoreConstraints();
    }

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
 * @param {() => { size: { width: number, height: number } }} getState - Returns
 *   the current card size for expand sizing.
 * @param {(() => void)=} restoreConstraints - Optional callback invoked after
 *   expanding back to panel mode so participant-window can reapply min/max.
 */
function setupPillHandlers(getWindow, getState, restoreConstraints) {
    _getWindow = getWindow;
    _restoreConstraints = restoreConstraints || null;

    ipcMain.on(IPC.REOPEN_REQUEST, () => {
        expandFromPill(getState().size);
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
