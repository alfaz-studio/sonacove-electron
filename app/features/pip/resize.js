/**
 * User-resize handler for the participant PiP panel.
 *
 * Since frameless transparent windows on Windows don't expose native resize
 * handles, this module implements edge-based resize via cursor polling
 * (same pattern as drag.js).  The renderer detects mousedown on edge zones
 * and sends IPC; this module polls the cursor and snaps to tile boundaries.
 */

const { ipcMain, screen } = require('electron');

const {
    TILE_W, H_TILE_H, V_TILE_H, TILE_GAP, TILE_PAD,
    HEADER_H, BORDER, IPC,
} = require('./constants');
const { computeWindowSize } = require('./sizing');

let _getWindow = null;
let _getState = null;
let _visibleTileCount = 4;

// Edge-resize polling state.
let _isResizing = false;
let _pollInterval = null;
let _startCursorPos = 0;   // cursor position along the resize axis at start
let _startWindowX = 0;     // window x at start
let _startWindowY = 0;     // window y at start
let _startWindowSize = 0;  // window size along the resize axis at start
let _resizeEdge = null;     // 'left' | 'right' | 'top' | 'bottom'

// Lerp animation state — smoothly transitions window bounds between snap points.
const LERP_DURATION = 180; // ms
let _targetBounds = null;  // { x, y, width, height } — where we're animating to
let _lerpFrom = null;      // { x, y, width, height } — where we started
let _lerpStart = 0;        // timestamp when lerp began
let _lerpInterval = null;

/**
 * @returns {number} The current number of visible tiles.
 */
function getVisibleTileCount() {
    return _visibleTileCount;
}

/**
 * @param {number} n
 */
function setVisibleTileCount(n) {
    _visibleTileCount = Math.max(1, n);
}

/**
 * @returns {boolean} Whether an edge resize is in progress.
 */
function isResizing() {
    return _isResizing;
}

/**
 * Given a proposed window size, computes how many tiles fit and returns
 * the snapped dimensions.
 */
function snapToTileBoundary(proposedWidth, proposedHeight, orientation, maxTiles) {
    const pad2 = TILE_PAD * 2;
    const bdr2 = BORDER * 2;
    let n;

    if (orientation === 'horizontal') {
        const availableWidth = proposedWidth - pad2 - bdr2 + TILE_GAP;

        n = Math.round(availableWidth / (TILE_W + TILE_GAP));
    } else {
        const availableHeight = proposedHeight - pad2 - bdr2 - HEADER_H + TILE_GAP;

        n = Math.round(availableHeight / (V_TILE_H + TILE_GAP));
    }

    n = Math.max(1, Math.min(n, maxTiles));

    const { width, height } = computeWindowSize(n, orientation);

    return { n, width, height };
}

/**
 * Starts an edge-resize operation using cursor polling.
 *
 * @param {string} edge - 'left' | 'right' | 'top' | 'bottom'
 */
function startEdgeResize(edge) {
    const win = _getWindow?.();

    if (!win || win.isDestroyed() || !_getState) {
        return;
    }

    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();

    _isResizing = true;
    _resizeEdge = edge;

    _startWindowX = bounds.x;
    _startWindowY = bounds.y;

    if (edge === 'left' || edge === 'right') {
        _startCursorPos = cursor.x;
        _startWindowSize = bounds.width;
    } else {
        _startCursorPos = cursor.y;
        _startWindowSize = bounds.height;
    }

    if (_pollInterval) {
        clearInterval(_pollInterval);
    }

    let lastCursorX = -1;
    let lastCursorY = -1;

    _pollInterval = setInterval(() => {
        if (!win || win.isDestroyed()) {
            stopEdgeResize();

            return;
        }

        const pos = screen.getCursorScreenPoint();

        // Skip redundant computation when the cursor hasn't moved.
        if (pos.x === lastCursorX && pos.y === lastCursorY) {
            return;
        }
        lastCursorX = pos.x;
        lastCursorY = pos.y;

        const { count, orientation } = _getState();

        let proposedWidth = _startWindowSize;
        let proposedHeight = _startWindowSize;

        // Compute proposed size from cursor delta (use start size, not current
        // bounds, since current bounds may be mid-lerp).
        if (_resizeEdge === 'right') {
            proposedWidth = _startWindowSize + (pos.x - _startCursorPos);
            proposedHeight = 0; // irrelevant for horizontal
        } else if (_resizeEdge === 'left') {
            proposedWidth = _startWindowSize - (pos.x - _startCursorPos);
            proposedHeight = 0;
        } else if (_resizeEdge === 'bottom') {
            proposedHeight = _startWindowSize + (pos.y - _startCursorPos);
            proposedWidth = 0;
        } else if (_resizeEdge === 'top') {
            proposedHeight = _startWindowSize - (pos.y - _startCursorPos);
            proposedWidth = 0;
        }

        // Fill in the locked axis so snapToTileBoundary gets valid values.
        if (orientation === 'horizontal' && proposedHeight === 0) {
            proposedHeight = computeWindowSize(1, orientation).height;
        } else if (orientation === 'vertical' && proposedWidth === 0) {
            proposedWidth = computeWindowSize(1, orientation).width;
        }

        const { n, width, height } = snapToTileBoundary(
            proposedWidth, proposedHeight, orientation, count
        );

        // Compute target position — anchor to opposite edge.
        let newX = _startWindowX;
        let newY = _startWindowY;

        if (_resizeEdge === 'left') {
            newX = _startWindowX + _startWindowSize - width;
        } else if (_resizeEdge === 'top') {
            newY = _startWindowY + _startWindowSize - height;
        }

        const target = { x: Math.round(newX), y: Math.round(newY), width, height };

        // If snap point changed, start a lerp animation to the new bounds.
        if (n !== _visibleTileCount) {
            _visibleTileCount = n;
            win.webContents.send(IPC.VISIBLE_COUNT_CHANGED, {
                count: n,
                edge: _resizeEdge,
            });
            _startLerp(win, target);
        } else if (!_targetBounds
                || _targetBounds.x !== target.x
                || _targetBounds.y !== target.y
                || _targetBounds.width !== target.width
                || _targetBounds.height !== target.height) {
            // Same tile count but target moved (shouldn't normally happen for
            // snapped resize, but keep it responsive).
            _startLerp(win, target);
        }
    }, 16); // ~60fps
}

/**
 * Starts a lerp animation from the window's current bounds to the target.
 */
function _startLerp(win, target) {
    if (win.isDestroyed()) {
        return;
    }

    // Relax size constraints so intermediate lerp values aren't clamped.
    win.setMinimumSize(1, 1);
    win.setMaximumSize(0, 0);

    _lerpFrom = win.getBounds();
    _targetBounds = target;
    _lerpStart = Date.now();

    // If already running a lerp interval, keep it — it will pick up the new target.
    if (_lerpInterval) {
        return;
    }

    _lerpInterval = setInterval(() => {
        if (!win || win.isDestroyed()) {
            _stopLerp();

            return;
        }

        const elapsed = Date.now() - _lerpStart;
        const t = Math.min(elapsed / LERP_DURATION, 1);

        // Ease-out quart — smooth deceleration.
        const ease = 1 - Math.pow(1 - t, 4);

        const x = Math.round(_lerpFrom.x + (_targetBounds.x - _lerpFrom.x) * ease);
        const y = Math.round(_lerpFrom.y + (_targetBounds.y - _lerpFrom.y) * ease);
        const w = Math.round(_lerpFrom.width + (_targetBounds.width - _lerpFrom.width) * ease);
        const h = Math.round(_lerpFrom.height + (_targetBounds.height - _lerpFrom.height) * ease);

        win.setBounds({ x, y, width: Math.max(1, w), height: Math.max(1, h) });

        if (t >= 1) {
            _stopLerp();
        }
    }, 16);
}

/**
 * Stops the lerp animation and snaps to the final target.
 */
function _stopLerp() {
    if (_lerpInterval) {
        clearInterval(_lerpInterval);
        _lerpInterval = null;
    }
    _targetBounds = null;
    _lerpFrom = null;
}

/**
 * Stops the edge-resize operation.
 */
function stopEdgeResize() {
    _isResizing = false;
    _resizeEdge = null;

    if (_pollInterval) {
        clearInterval(_pollInterval);
        _pollInterval = null;
    }

    // Let any in-flight lerp finish naturally (it'll complete within LERP_DURATION).
    // But if the window is already at the target, clean up immediately.
    if (_targetBounds && _lerpFrom
        && _lerpFrom.width === _targetBounds.width
        && _lerpFrom.height === _targetBounds.height) {
        _stopLerp();
    }
}

/**
 * Registers edge-resize IPC handlers.
 *
 * @param {() => Electron.BrowserWindow|null} getWindow
 * @param {() => { count: number, orientation: string }} getState
 */
function setupResizeHandlers(getWindow, getState) {
    _getWindow = getWindow;
    _getState = getState;
    _visibleTileCount = getState().count;

    ipcMain.on(IPC.START_EDGE_RESIZE, (_event, { edge }) => {
        startEdgeResize(edge);
    });

    ipcMain.on(IPC.STOP_EDGE_RESIZE, () => {
        stopEdgeResize();
    });
}

/**
 * Removes IPC handlers and resets state.
 */
function cleanup() {
    stopEdgeResize();
    _stopLerp();
    _visibleTileCount = 4;
    ipcMain.removeAllListeners(IPC.START_EDGE_RESIZE);
    ipcMain.removeAllListeners(IPC.STOP_EDGE_RESIZE);
}

module.exports = {
    getVisibleTileCount,
    setVisibleTileCount,
    isResizing,
    setupResizeHandlers,
    cleanup,
};
