/**
 * Participant PiP panel — window lifecycle orchestrator.
 *
 * Creates and manages the always-on-top floating panel that shows participant
 * tiles when the main window is minimized.  Delegates sizing, drag, and pill
 * mode to dedicated modules.
 */

const { BrowserWindow, ipcMain, screen } = require('electron');

const { TILE_W, TILE_PAD, H_TILE_H, HEADER_H, BORDER, IPC } = require('./constants');
const { setParticipantWindow, getMainWindow, resolveFile } = require('./helpers');
const { computeWindowSize, getWindowPosition } = require('./sizing');
const { setupDragHandlers, isDragging } = require('./drag');
const { setupPillHandlers, isPillMode, shrinkToPill, reset: resetPill } = require('./pill');

let participantWindow = null;
let currentOrientation = 'horizontal';
let currentParticipantCount = 1;
let lastParticipantsData = null;

// ── Wire up drag and pill subsystems ─────────────────────────────────────────

const getWindow = () => participantWindow;
const getState = () => ({ count: currentParticipantCount, orientation: currentOrientation });

setupDragHandlers(getWindow);
setupPillHandlers(getWindow, getState);

// ── Orientation ──────────────────────────────────────────────────────────────

/**
 * Resizes and repositions the panel to match the current orientation.
 * Notifies both the panel renderer and the main renderer.
 */
function applyOrientation() {
    if (!participantWindow || participantWindow.isDestroyed() || isDragging()) {
        return;
    }

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();

    const { width: W, height: H } = computeWindowSize(currentParticipantCount, currentOrientation);
    const { x, y } = getWindowPosition(currentParticipantCount, currentOrientation, display.workArea);

    participantWindow.setResizable(true);
    participantWindow.setMinimumSize(1, 1);
    participantWindow.setBounds({ x, y, width: W, height: H });
    participantWindow.setResizable(false);

    participantWindow.webContents.send(IPC.ORIENTATION_CHANGED, currentOrientation);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.ORIENTATION_CHANGED_RENDERER, currentOrientation);
    }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on(IPC.TOGGLE_ORIENTATION, () => {
    currentOrientation = currentOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    applyOrientation();
});

ipcMain.on(IPC.RESIZE, (_event, { count }) => {
    if (!participantWindow || participantWindow.isDestroyed() || isPillMode() || isDragging()) {
        return;
    }

    currentParticipantCount = Math.max(1, count);
    const { width: W, height: H } = computeWindowSize(currentParticipantCount, currentOrientation);

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x, y } = getWindowPosition(currentParticipantCount, currentOrientation, display.workArea);

    participantWindow.setResizable(true);
    participantWindow.setMinimumSize(1, 1);
    participantWindow.setBounds({ x, y, width: W, height: H });
    participantWindow.setResizable(false);
});

ipcMain.on(IPC.FOCUS_MAIN, () => {
    const mw = getMainWindow();

    if (mw) {
        if (mw.isMinimized()) {
            mw.restore();
        }
        mw.focus();
    }
});

// ── Window lifecycle ─────────────────────────────────────────────────────────

/**
 * Opens the floating participant PiP panel.
 */
function openParticipantWindow() {
    if (participantWindow && !participantWindow.isDestroyed()) {
        return;
    }

    currentParticipantCount = 1;

    const preloadPath = resolveFile('participant-panel-preload.js', __dirname);

    if (!preloadPath) {
        console.error('❌ ParticipantPiP: Could not find participant-panel-preload.js');

        return;
    }

    const htmlPath = resolveFile('participant-panel.html', __dirname);

    if (!htmlPath) {
        console.error('❌ ParticipantPiP: Could not find participant-panel.html');

        return;
    }

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();

    const { width: W, height: H } = computeWindowSize(currentParticipantCount, currentOrientation);
    const { x: posX, y: posY } = getWindowPosition(currentParticipantCount, currentOrientation, display.workArea);

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

    setParticipantWindow(participantWindow);

    // macOS: float above full-screen apps.
    if (process.platform === 'darwin') {
        participantWindow.setAlwaysOnTop(true, 'floating');
        participantWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
        participantWindow.setAlwaysOnTop(true, 'normal');
    }

    participantWindow.on('closed', () => {
        participantWindow = null;
        setParticipantWindow(null);
        resetPill();
    });

    participantWindow.webContents.on('did-finish-load', () => {
        if (participantWindow && !participantWindow.isDestroyed()) {
            participantWindow.webContents.send(IPC.ORIENTATION_CHANGED, currentOrientation);

            if (lastParticipantsData) {
                participantWindow.webContents.send(IPC.PARTICIPANTS_UPDATE, lastParticipantsData);
            }

            participantWindow.show();
        }
    });

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
        setParticipantWindow(null);
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

// ── Data forwarding ──────────────────────────────────────────────────────────

function sendParticipantFrame(frameData) {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    participantWindow.webContents.send(IPC.FRAME, frameData);
}

function sendParticipantsUpdate(participants) {
    lastParticipantsData = participants;
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    participantWindow.webContents.send(IPC.PARTICIPANTS_UPDATE, participants);
}

function closeParticipantWindow(notifyUserClosed = false) {
    lastParticipantsData = null;
    if (participantWindow && !participantWindow.isDestroyed()) {
        participantWindow.destroy();
        participantWindow = null;
        setParticipantWindow(null);
    }

    if (notifyUserClosed) {
        const mw = getMainWindow();

        if (mw && !mw.isDestroyed()) {
            mw.webContents.send(IPC.PANEL_CLOSED);
        }
    }
}

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
