/**
 * Window drag system for the participant PiP panel.
 *
 * Uses cursor polling at ~60fps with atomic setBounds() to prevent the
 * Windows transparent-frameless-window size drift that setPosition() causes.
 */

const { ipcMain, screen } = require('electron');
const { IPC } = require('./constants');

let _getWindow = null;
let _isDragging = false;
let _pollInterval = null;
let _offsetX = 0;
let _offsetY = 0;

/**
 * @returns {boolean} Whether a drag is currently in progress.
 */
function isDragging() {
    return _isDragging;
}

/**
 * Registers drag IPC handlers.
 *
 * @param {() => Electron.BrowserWindow|null} getWindow - Getter for the
 *   participant window (avoids circular dependency with participant-window.js).
 */
function setupDragHandlers(getWindow) {
    _getWindow = getWindow;

    ipcMain.on(IPC.START_DRAG, () => {
        const win = _getWindow?.();

        if (!win || win.isDestroyed()) {
            return;
        }

        const mousePos = screen.getCursorScreenPoint();
        const bounds = win.getBounds();

        _isDragging = true;
        _offsetX = mousePos.x - bounds.x;
        _offsetY = mousePos.y - bounds.y;

        const dragWidth = bounds.width;
        const dragHeight = bounds.height;

        if (_pollInterval) {
            clearInterval(_pollInterval);
        }

        let lastCursorX = -1;
        let lastCursorY = -1;

        _pollInterval = setInterval(() => {
            if (!win || win.isDestroyed()) {
                clearInterval(_pollInterval);
                _pollInterval = null;

                return;
            }

            const pos = screen.getCursorScreenPoint();

            // Skip redundant setBounds when the cursor hasn't moved.
            if (pos.x === lastCursorX && pos.y === lastCursorY) {
                return;
            }
            lastCursorX = pos.x;
            lastCursorY = pos.y;

            win.setBounds({
                x: Math.round(pos.x - _offsetX),
                y: Math.round(pos.y - _offsetY),
                width: dragWidth,
                height: dragHeight,
            });
        }, 16);
    });

    ipcMain.on(IPC.STOP_DRAG, () => {
        _isDragging = false;

        if (_pollInterval) {
            clearInterval(_pollInterval);
            _pollInterval = null;
        }
    });
}

/**
 * Removes drag IPC handlers and clears any active drag state.
 */
function cleanup() {
    _isDragging = false;

    if (_pollInterval) {
        clearInterval(_pollInterval);
        _pollInterval = null;
    }

    ipcMain.removeAllListeners(IPC.START_DRAG);
    ipcMain.removeAllListeners(IPC.STOP_DRAG);
}

module.exports = {
    isDragging,
    setupDragHandlers,
    cleanup,
};
