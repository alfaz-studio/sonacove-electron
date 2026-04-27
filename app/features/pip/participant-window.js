/**
 * Participant PiP panel — window lifecycle orchestrator.
 *
 * Creates and manages the always-on-top floating panel that shows participant
 * tiles when the main window is minimized.  Delegates sizing, drag, and pill
 * mode to dedicated modules.
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');

const { TILE_W, TILE_PAD, H_TILE_H, HEADER_H, BORDER, IPC } = require('./constants');
const { setParticipantWindow, getMainWindowExcludingPip: getMainWindow, resolveFile } = require('./helpers');
const { computeWindowSize, getWindowPosition } = require('./sizing');
const { setupDragHandlers, isDragging } = require('./drag');
const { setupPillHandlers, isPillMode, shrinkToPill, reset: resetPill } = require('./pill');
const { setupResizeHandlers, isResizing, getVisibleTileCount, setVisibleTileCount } = require('./resize');

let participantWindow = null;
let currentOrientation = 'horizontal';
let currentParticipantCount = 1;
let lastParticipantsData = null;

// When the user opens chat from the PiP, jitsi-meet's chat-read state takes
// time to propagate back into pp-participants-update. During this window we
// override unreadChatCount to 0 so the PiP doesn't flash a stale badge.
//
// 15s is the upper bound of "click chat → read for a bit → minimise → PiP
// reopens before jitsi catches up". Suppression usually drops earlier via
// one of the signals below — the timer is just a safety floor.
//
// Baseline tracks the count at suppression-start so a real new message
// arriving DURING the window (incoming > baseline) drops suppression and
// shows the new badge.
const UNREAD_SUPPRESS_MS = 15000;
let suppressUnreadUntil = 0;
let suppressBaseline = 0;

// ── Wire up drag and pill subsystems ─────────────────────────────────────────

const getWindow = () => participantWindow;
const getState = () => ({ count: currentParticipantCount, orientation: currentOrientation });

setupDragHandlers(getWindow);
setupPillHandlers(getWindow, getState);
setupResizeHandlers(getWindow, getState);

// ── Orientation ──────────────────────────────────────────────────────────────

/**
 * Resizes and repositions the panel to match the current orientation.
 * Notifies both the panel renderer and the main renderer.
 */
function applyOrientation() {
    if (!participantWindow || participantWindow.isDestroyed() || isDragging() || isResizing()) {
        return;
    }

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();

    // Clamp visible count to current participant count after orientation change.
    const visibleCount = Math.min(getVisibleTileCount(), currentParticipantCount);

    setVisibleTileCount(visibleCount);

    const { width: W, height: H } = computeWindowSize(visibleCount, currentOrientation);
    const { x, y } = getWindowPosition(visibleCount, currentOrientation, display.workArea);

    updateSizeConstraints();
    participantWindow.setMinimumSize(1, 1);
    participantWindow.setBounds({ x, y, width: W, height: H });
    updateSizeConstraints();

    participantWindow.webContents.send(IPC.ORIENTATION_CHANGED, currentOrientation);
    participantWindow.webContents.send(IPC.VISIBLE_COUNT_CHANGED, { count: visibleCount, edge: null });

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.ORIENTATION_CHANGED_RENDERER, currentOrientation);
    }
}

/**
 * Updates min/max size constraints based on current orientation and
 * participant count, constraining resize to the correct axis.
 */
function updateSizeConstraints() {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }

    // Min = 1 tile, max = all participants.
    // Horizontal: height locked (min == max), width varies.
    // Vertical: width locked (min == max), height varies.
    const minSize = computeWindowSize(1, currentOrientation);
    const maxSize = computeWindowSize(currentParticipantCount, currentOrientation);

    participantWindow.setMinimumSize(minSize.width, minSize.height);
    participantWindow.setMaximumSize(maxSize.width, maxSize.height);
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on(IPC.TOGGLE_ORIENTATION, () => {
    currentOrientation = currentOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    applyOrientation();
});

ipcMain.on(IPC.RESIZE, (_event, { count }) => {
    if (!participantWindow || participantWindow.isDestroyed() || isPillMode() || isDragging() || isResizing()) {
        return;
    }

    const prevCount = currentParticipantCount;

    currentParticipantCount = Math.max(1, count);

    // Clamp visible count if participants left.
    let visibleCount = getVisibleTileCount();

    if (visibleCount > currentParticipantCount) {
        visibleCount = currentParticipantCount;
        setVisibleTileCount(visibleCount);
    }

    // If the user hasn't manually resized (visible == prev total), auto-expand
    // to show new participants.
    if (visibleCount === prevCount && currentParticipantCount > prevCount) {
        visibleCount = currentParticipantCount;
        setVisibleTileCount(visibleCount);
    }

    const { width: W, height: H } = computeWindowSize(visibleCount, currentOrientation);

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x, y } = getWindowPosition(visibleCount, currentOrientation, display.workArea);

    updateSizeConstraints();
    participantWindow.setMinimumSize(1, 1);
    participantWindow.setBounds({ x, y, width: W, height: H });
    updateSizeConstraints();

    participantWindow.webContents.send(IPC.VISIBLE_COUNT_CHANGED, { count: visibleCount, edge: null });
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
    setVisibleTileCount(1);

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
            resizable: true,
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

            // Direct send — the cache is always suppression-applied at write
            // time (sendParticipantsUpdate is the only writer of
            // lastParticipantsData), so re-routing through that function
            // here would just re-evaluate suppression against our own
            // already-zeroed value and drop suppression early.
            if (lastParticipantsData) {
                participantWindow.webContents.send(IPC.PARTICIPANTS_UPDATE, lastParticipantsData);
            }

            participantWindow.show();

            // macOS: PiP has skipTaskbar+alwaysOnTop, so macOS hides
            // the dock icon when it's the only visible window.
            if (process.platform === 'darwin') {
                app.dock.show();
            }
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
    // Apply the unread-chat suppression window (see suppressUnreadChatCount).
    // Four exit conditions, in order:
    //   1. timer expired              → pass through, drop suppression
    //   2. incoming count === 0       → jitsi caught up, drop suppression
    //   3. incoming count > baseline  → real new messages arrived, drop
    //                                   suppression and pass the new count
    //                                   through so the user sees them
    //   otherwise (count > 0 and <= baseline) → stale propagation, override
    //                                   to 0. Timer is NOT re-armed — the
    //                                   fixed window is the safety floor.
    if (suppressUnreadUntil > 0) {
        const incoming = participants?.unreadChatCount || 0;

        if (Date.now() >= suppressUnreadUntil) {
            suppressUnreadUntil = 0;
        } else if (incoming === 0) {
            suppressUnreadUntil = 0;
        } else if (incoming > suppressBaseline) {
            suppressUnreadUntil = 0;
        } else {
            participants = { ...participants, unreadChatCount: 0 };
        }
    }

    lastParticipantsData = participants;
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    participantWindow.webContents.send(IPC.PARTICIPANTS_UPDATE, participants);
}

function closeParticipantWindow(notifyUserClosed = false) {
    lastParticipantsData = null;
    // Do NOT reset suppressUnreadUntil here. The whole point of the
    // suppression is to survive the close-and-reopen cycle that follows
    // a chat-button click (PiP closes ms after the click, reopens when
    // the user minimises again). Resetting would defeat the feature.
    // The timer self-expires if it hasn't been re-armed by an incoming
    // stale update, so stale state can't accumulate.
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

/**
 * Suppress the unread-chat badge for a short window after the user opened
 * chat from the PiP. Without this, jitsi-meet's chat-read state takes a few
 * seconds to propagate, so the next pp-participants-update still carries
 * the old unreadChatCount and a re-opened PiP briefly shows a stale badge.
 *
 * Tracks a baseline (the count at suppression-start) so a real new message
 * arriving during the window — incoming > baseline — drops suppression
 * and lets the new badge through. Drops early on incoming count === 0
 * (jitsi caught up) or via the safety timer.
 */
function suppressUnreadChatCount() {
    suppressBaseline = lastParticipantsData?.unreadChatCount || 0;
    if (lastParticipantsData) {
        lastParticipantsData.unreadChatCount = 0;
    }
    suppressUnreadUntil = Date.now() + UNREAD_SUPPRESS_MS;
}

module.exports = {
    openParticipantWindow,
    sendParticipantFrame,
    sendParticipantsUpdate,
    closeParticipantWindow,
    shrinkToPill,
    suppressUnreadChatCount,
    getCurrentState: getState,
};
