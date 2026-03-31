const { BrowserWindow, ipcMain, screen, app } = require('electron');
const fs = require('fs');
const path = require('path');

const { getMainWindow } = require('../sonacove/overlay/overlay-window');

let participantWindow = null;
let currentOrientation = 'horizontal'; // 'horizontal' | 'vertical'
let isPillMode = false;
let lastParticipantsData = null; // Buffered for re-send on did-finish-load

const PILL_SIZE = 56;

// ── Pill window drag state ────────────────────────────────────────────────────
let dragPollInterval = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

ipcMain.on('pp-start-window-drag', () => {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    const mousePos = screen.getCursorScreenPoint();
    const bounds = participantWindow.getBounds();

    dragOffsetX = mousePos.x - bounds.x;
    dragOffsetY = mousePos.y - bounds.y;

    if (dragPollInterval) {
        clearInterval(dragPollInterval);
    }
    dragPollInterval = setInterval(() => {
        if (!participantWindow || participantWindow.isDestroyed()) {
            clearInterval(dragPollInterval);
            dragPollInterval = null;

            return;
        }
        const pos = screen.getCursorScreenPoint();

        participantWindow.setPosition(
            Math.round(pos.x - dragOffsetX),
            Math.round(pos.y - dragOffsetY)
        );
    }, 16); // ~60 fps
});

ipcMain.on('pp-stop-window-drag', () => {
    if (dragPollInterval) {
        clearInterval(dragPollInterval);
        dragPollInterval = null;
    }
});

// Dynamic tile-based sizing — mirrors ParticipantPiPCanvas.tsx constants.
// TILE_W is the same for both orientations; tile height differs so horizontal
// tiles are landscape and vertical tiles are squarish.
const TILE_W = 200;
const H_TILE_H = 130; // tile height in horizontal mode
const V_TILE_H = 160; // tile height in vertical mode (taller / squarish)
const TILE_GAP = 6;
const TILE_PAD = 6;   // padding inside the tiles container (each side)
const HEADER_H = 32;
const BORDER = 1;     // panel border width (each side)

const MARGIN = 20;

let currentParticipantCount = 1;

/**
 * Computes the BrowserWindow dimensions for a given participant count and
 * orientation.  Accounts for tile container padding, gaps, and panel border.
 *
 * @param {number} count
 * @param {string} orientation
 * @returns {{ width: number, height: number }}
 */
function computeWindowSize(count, orientation) {
    const n = Math.max(1, count);
    const tileH = orientation === 'horizontal' ? H_TILE_H : V_TILE_H;
    const pad2 = TILE_PAD * 2;  // top+bottom or left+right padding
    const bdr2 = BORDER * 2;    // border on both sides

    if (orientation === 'horizontal') {
        return {
            width:  n * TILE_W + (n - 1) * TILE_GAP + pad2 + bdr2,
            height: tileH + pad2 + HEADER_H + bdr2,
        };
    }

    return {
        width:  TILE_W + pad2 + bdr2,
        height: n * tileH + (n - 1) * TILE_GAP + pad2 + HEADER_H + bdr2,
    };
}

/**
 * Computes the (x, y) position for the panel given an orientation and the
 * work area of the display that contains the main window.
 */
function getWindowPosition(orientation, workArea) {
    const { width: W, height: H } = computeWindowSize(currentParticipantCount, orientation);

    if (orientation === 'horizontal') {
        // Bottom-right corner, above the dock / taskbar.
        return {
            x: workArea.x + workArea.width - W - MARGIN,
            y: workArea.y + workArea.height - H - MARGIN,
        };
    }

    // Vertical: right side, vertically centred.
    return {
        x: workArea.x + workArea.width - W - MARGIN,
        y: workArea.y + Math.round((workArea.height - H) / 2),
    };
}

/**
 * Resizes and repositions the panel window to match `currentOrientation`.
 * Also notifies both the panel and the main renderer of the new orientation.
 */
function applyOrientation() {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();

    const { width: W, height: H } = computeWindowSize(currentParticipantCount, currentOrientation);
    const { x, y } = getWindowPosition(currentOrientation, display.workArea);

    participantWindow.setResizable(true);
    participantWindow.setMinimumSize(1, 1);
    participantWindow.setSize(W, H);
    participantWindow.setPosition(x, y);
    participantWindow.setResizable(false);

    // Tell the panel UI (toggle button label).
    participantWindow.webContents.send('pp-orientation-changed', currentOrientation);

    // Tell the main renderer (canvas dimensions / drawing algorithm).
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pip-orientation-changed', currentOrientation);
    }
}

// ── IPC: orientation toggle (sent from participant panel) ────────────────────

ipcMain.on('pip-toggle-orientation', () => {
    currentOrientation = currentOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    applyOrientation();
});

// ── IPC: participant count changed — resize window in place ──────────────────

ipcMain.on('pip-resize', (_event, { count }) => {
    if (!participantWindow || participantWindow.isDestroyed() || isPillMode) {
        return;
    }
    currentParticipantCount = Math.max(1, count);
    const { width: W, height: H } = computeWindowSize(currentParticipantCount, currentOrientation);

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x, y } = getWindowPosition(currentOrientation, display.workArea);

    participantWindow.setResizable(true);
    participantWindow.setSize(W, H);
    participantWindow.setPosition(x, y);
    participantWindow.setResizable(false);
});

/**
 * Opens the floating participant PiP panel.
 *
 * The panel is a small, always-on-top, frameless window.  It starts in
 * horizontal strip mode (bottom-centre of the display containing the main
 * window) and can be toggled to vertical (right side) by the user.
 *
 * @returns {void}
 */
function openParticipantWindow() {
    if (participantWindow && !participantWindow.isDestroyed()) {
        return; // Already open.
    }

    // Keep the user's last chosen orientation; only reset participant count.
    currentParticipantCount = 1;

    // ── Resolve preload path ──────────────────────────────────────────────
    const preloadCandidates = [
        path.join(app.getAppPath(), 'build', 'participant-panel-preload.js'),
        path.join(app.getAppPath(), 'participant-panel-preload.js'),
        path.join(__dirname, 'participant-panel-preload.js'),
        path.join(__dirname, '../../../build/participant-panel-preload.js'),
    ];
    const preloadPath = preloadCandidates.find(p => fs.existsSync(p));

    if (!preloadPath) {
        console.error('❌ ParticipantPiP: Could not find participant-panel-preload.js');
        console.error('Searched:', preloadCandidates);

        return;
    }

    // ── Resolve HTML path ─────────────────────────────────────────────────
    const htmlCandidates = [
        path.join(app.getAppPath(), 'build', 'participant-panel.html'),
        path.join(app.getAppPath(), 'participant-panel.html'),
        path.join(__dirname, 'participant-panel.html'),
        path.join(__dirname, '../../../build/participant-panel.html'),
    ];
    const htmlPath = htmlCandidates.find(p => fs.existsSync(p));

    if (!htmlPath) {
        console.error('❌ ParticipantPiP: Could not find participant-panel.html');
        console.error('Searched:', htmlCandidates);

        return;
    }

    // ── Determine initial position ────────────────────────────────────────
    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();

    const { width: W, height: H } = computeWindowSize(currentParticipantCount, currentOrientation);
    const { x: posX, y: posY } = getWindowPosition(currentOrientation, display.workArea);

    // ── Create window ─────────────────────────────────────────────────────
    try {
        participantWindow = new BrowserWindow({
            x: posX,
            y: posY,
            width: W,
            height: H,
            minWidth: TILE_W + TILE_PAD * 2 + BORDER * 2,
            minHeight: H_TILE_H + TILE_PAD * 2 + HEADER_H + BORDER * 2,
            transparent: true,
            frame: false,
            alwaysOnTop: true,
            hasShadow: true,
            resizable: false,
            skipTaskbar: true,
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
                preload: preloadPath,
            },
        });
    } catch (err) {
        console.error('❌ ParticipantPiP: Failed to create window:', err);
        participantWindow = null;

        return;
    }

    // macOS: float above full-screen apps.
    if (process.platform === 'darwin') {
        participantWindow.setAlwaysOnTop(true, 'floating');
        participantWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
        participantWindow.setAlwaysOnTop(true, 'normal');
    }

    participantWindow.on('closed', () => {
        participantWindow = null;
    });

    participantWindow.webContents.on('did-finish-load', () => {
        if (participantWindow && !participantWindow.isDestroyed()) {
            // Send initial orientation so the toggle button shows the right icon.
            participantWindow.webContents.send('pp-orientation-changed', currentOrientation);

            // Re-send buffered participant data that may have arrived before load.
            if (lastParticipantsData) {
                participantWindow.webContents.send('pp-participants-update', lastParticipantsData);
            }

            participantWindow.show();
        }
    });

    // Ignore non-critical load abort (-3 = ERR_ABORTED from navigation cancel).
    participantWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        if (errorCode === -3) {
            return;
        }
        console.error(`❌ ParticipantPiP: Failed to load: ${errorDescription} (${errorCode})`);
        if (participantWindow && !participantWindow.isDestroyed()) {
            participantWindow.destroy();
        }
    });

    participantWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error('❌ ParticipantPiP: Renderer crashed:', details.reason);
        participantWindow = null;
    });

    console.log(`✅ ParticipantPiP: Loading ${htmlPath}`);
    try {
        participantWindow.loadFile(htmlPath);
    } catch (err) {
        console.error('❌ ParticipantPiP: loadFile failed:', err);
        if (participantWindow && !participantWindow.isDestroyed()) {
            participantWindow.destroy();
        }
    }
}

/**
 * Sends a per-participant JPEG frame to the participant panel.
 * Data is { id: string, data: string }.
 *
 * @param {{ id: string, data: string }} frameData
 * @returns {void}
 */
function sendParticipantFrame(frameData) {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    participantWindow.webContents.send('pp-frame', frameData);
}

/**
 * Sends participant metadata to the panel so it can render tiles with
 * avatars, names, and camera state.
 *
 * @param {Array} participants - Array of participant metadata objects.
 * @returns {void}
 */
function sendParticipantsUpdate(participants) {
    lastParticipantsData = participants;
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    participantWindow.webContents.send('pp-participants-update', participants);
}

/**
 * Closes the participant panel window and optionally notifies the main
 * renderer that the panel was dismissed by the user (not by screenshare end).
 *
 * @param {boolean} [notifyUserClosed=false] - Whether to send 'pip-panel-closed'
 *   to the main renderer so it stops sending frames and resets its state.
 * @returns {void}
 */
function closeParticipantWindow(notifyUserClosed = false) {
    lastParticipantsData = null;
    if (participantWindow && !participantWindow.isDestroyed()) {
        participantWindow.destroy();
        participantWindow = null;
    }

    if (notifyUserClosed) {
        const mw = getMainWindow();

        if (mw && !mw.isDestroyed()) {
            mw.webContents.send('pip-panel-closed');
        }
    }
}

/**
 * Shrinks the participant panel to a floating pill button.
 * The BrowserWindow stays alive (always-on-top) so the pill floats above the
 * shared screen — identical behaviour to the annotations pencil reopen pill.
 * Sends 'pip-panel-closed' to the main renderer so frame-sending stops.
 *
 * @returns {void}
 */
function shrinkToPill() {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }

    isPillMode = true;

    // Default pill position: bottom-right corner of the work area.
    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x: waX, y: waY, width: waW, height: waH } = display.workArea;
    const pillX = waX + waW - PILL_SIZE - MARGIN;
    const pillY = waY + waH - PILL_SIZE - MARGIN;

    participantWindow.setResizable(true);
    participantWindow.setMinimumSize(PILL_SIZE, PILL_SIZE);
    participantWindow.setSize(PILL_SIZE, PILL_SIZE);
    participantWindow.setPosition(
        Math.max(0, pillX),
        Math.max(0, pillY)
    );
    participantWindow.setResizable(false);

    // Tell panel HTML to switch to pill mode.
    participantWindow.webContents.send('pp-enter-pill-mode');

    // Tell main renderer to stop sending frames.
    const mw = getMainWindow();

    if (mw && !mw.isDestroyed()) {
        mw.webContents.send('pip-panel-closed');
    }
}

/**
 * Expands the floating pill back to a full participant panel.
 * Sends 'pip-panel-reopened' to the main renderer so frame-sending resumes.
 *
 * @returns {void}
 */
function expandFromPill() {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }

    isPillMode = false;

    const { width: W, height: H } = computeWindowSize(currentParticipantCount, currentOrientation);
    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x: posX, y: posY } = getWindowPosition(currentOrientation, display.workArea);

    participantWindow.setResizable(true);
    participantWindow.setMinimumSize(TILE_W + TILE_PAD * 2 + BORDER * 2, H_TILE_H + TILE_PAD * 2 + HEADER_H + BORDER * 2);
    participantWindow.setSize(W, H);
    participantWindow.setPosition(posX, posY);
    participantWindow.setResizable(false);

    // Tell panel HTML to switch back to panel mode.
    participantWindow.webContents.send('pp-enter-panel-mode');

    // Tell main renderer to resume sending frames.
    const mw = getMainWindow();

    if (mw && !mw.isDestroyed()) {
        mw.webContents.send('pip-panel-reopened');
    }
}

// ── IPC: user clicks pill to reopen panel ────────────────────────────────────
ipcMain.on('pp-reopen-request', () => {
    expandFromPill();
});

/**
 * Returns the participant window instance or null.
 *
 * @returns {BrowserWindow|null}
 */
function getParticipantWindow() {
    return participantWindow;
}

module.exports = {
    openParticipantWindow,
    sendParticipantFrame,
    sendParticipantsUpdate,
    closeParticipantWindow,
    shrinkToPill,
    getParticipantWindow,
};
