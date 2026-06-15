/**
 * Participant PiP panel — window lifecycle orchestrator.
 *
 * Creates and manages the always-on-top floating panel that shows participant
 * tiles when the main window is minimized.  Delegates sizing, drag, and pill
 * mode to dedicated modules.
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const { TILE_W, TILE_GAP, TILE_PAD, H_TILE_H, V_TILE_H, HEADER_H, BORDER, WINDOW_PAD, IPC } = require('./constants');
const { setParticipantWindow, getMainWindowExcludingPip: getMainWindow, resolveFile } = require('./helpers');
const { chromeMain, computeWindowSize, windowFromMainExtent, uniformMainExtent, getWindowPosition } = require('./sizing');
const { setupDragHandlers, isDragging } = require('./drag');
const { setupPillHandlers, isPillMode, shrinkToPill, reset: resetPill } = require('./pill');
const {
    setupResizeHandlers,
    isResizing,
    attachNativeResizeListener,
    getVisibleTileCount,
    setVisibleTileCount,
} = require('./resize');

// ── Settings persistence ─────────────────────────────────────────────────────

const SETTINGS_FILE = path.join(app.getPath('userData'), 'pip-settings.json');

function loadOrientation() {
    try {
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

        if (data.orientation === 'horizontal' || data.orientation === 'vertical') {
            return data.orientation;
        }
    } catch (_) { /* missing, corrupt, or unreadable — fall through */ }

    return 'vertical';
}

function saveOrientation(orientation) {
    // Async — IPC handler shouldn't block on disk I/O. Best-effort; a
    // failure just means next launch falls back to vertical.
    fs.writeFile(SETTINGS_FILE, JSON.stringify({ orientation }), 'utf8', () => {});
}

let participantWindow = null;
let currentOrientation = loadOrientation();
let currentParticipantCount = 1;
let currentPinnedCount = 0;
let lastParticipantsData = null;

// Length-budget cap: the panel auto-opens to at most this fraction of the
// display's main axis (height in vertical, width in horizontal). Tall tiles
// (a portrait video can grow to 360px vs a normal 141px) eat more of the budget
// so fewer auto-show. 0.95 keeps the panel under ~95% of the screen while still
// fitting a portrait + a couple of normals; adaptive across displays. Single knob.
const BUDGET_PCT = 0.95;
// Whether the panel still follows the budget cap. Once the user edge-resizes we
// respect their size — and that choice PERSISTS across the panel closing and
// reopening (savedUserCount carries the count, captured on close, restored on
// open). It never auto-reverts to the budget.
let autoSized = true;
let savedUserCount = null;
let lastThemeData = null;

// Per-video tile sizing. Tiles vary in size with each video's aspect ratio
// (portrait videos get tall/narrow tiles, landscape wide ones), so the panel
// reports the main-axis extent of its visible tiles and the window fits them
// exactly (contentMainExtent). effTileMain is the reported average per-tile
// main-axis size, used for the uniform estimates the resize engine still needs
// (snapping, and the pre-size shown before the panel's first report).
let contentMainExtent = null;
let effTileMain = null;
// Per-participant main-axis tile sizes (display order), reported by the panel.
// Lets the resize engine snap by whole tiles at their real size (a 2x portrait
// video is one step) instead of dividing by the average tile size.
let tileMainSizes = [];

// Timestamp (ms) until which a programmatic content-fit owns the bounds. The
// native-resize listener skips while this is in the future so it doesn't
// re-snap (with uniform-tile math) the exact per-video size we just applied.
let fittingUntil = 0;

/**
 * Effective per-tile main-axis size: the panel-reported average, or the legacy
 * fixed tile size before the panel has reported.
 *
 * @returns {number}
 */
function effectiveTileMain() {
    return effTileMain || (currentOrientation === 'horizontal' ? TILE_W : V_TILE_H);
}

/**
 * Floor for the visible-tile count. Pinning N participants means the user
 * explicitly wants those N visible — resize must not shrink past that.
 * Capped at the participant count so leaving participants can't strand the
 * minimum above the available tiles.
 */
function getMinTiles() {
    return Math.max(1, Math.min(currentPinnedCount, currentParticipantCount));
}

/**
 * Auto visible-tile count under the length budget: the most tiles (in growth
 * order — pinned first, same as the panel renders) whose combined main-axis
 * extent fits BUDGET_PCT of the display's main axis. Tall tiles eat more budget
 * so fewer fit; pinned users always show (override the cap); never returns 0.
 *
 * @returns {number}
 */
function budgetVisibleCount() {
    const sizes = tileMainSizes;
    const pinned = getMinTiles();

    if (!sizes.length) {
        return Math.max(pinned, 1); // before the panel's first per-tile report
    }

    const mainWindow = getMainWindow();
    const workArea = (mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay()).workArea;
    const screenMain = currentOrientation === 'vertical' ? workArea.height : workArea.width;
    const tileBudget = (screenMain * BUDGET_PCT) - chromeMain(currentOrientation);

    // First tile always shows; later tiles only while they still fit the budget.
    let fit = 0;
    let cum = 0;

    for (let i = 0; i < sizes.length; i++) {
        const withTile = cum + (i > 0 ? TILE_GAP : 0) + sizes[i];

        if (i > 0 && withTile > tileBudget) {
            break;
        }
        cum = withTile;
        fit = i + 1;
    }

    return Math.min(Math.max(pinned, fit), currentParticipantCount);
}

// See suppressUnreadChatCount() for the rationale. 15s is the safety floor;
// suppression normally drops earlier via the signals in sendParticipantsUpdate.
const UNREAD_SUPPRESS_MS = 15000;
let suppressUnreadUntil = 0;
let suppressBaseline = 0;

// ── Wire up drag and pill subsystems ─────────────────────────────────────────

const getWindow = () => participantWindow;
const getState = () => ({
    count: currentParticipantCount,
    minTiles: getMinTiles(),
    orientation: currentOrientation,
    tileMain: effectiveTileMain(),
    tileMains: tileMainSizes,
});

// Pill expand and the resize lerp both relax min/max to (1,1)/(0,0); without
// this restore the next OS-native resize can shrink past the single-tile
// minimum. Arrow wrapper sidesteps the hoisting question.
const restoreSizeConstraints = () => updateSizeConstraints();

setupDragHandlers(getWindow);
setupPillHandlers(getWindow, getState, restoreSizeConstraints);
setupResizeHandlers(getWindow, getState, restoreSizeConstraints, () => {
    // User took manual control of the size — stop auto-capping to the budget.
    autoSized = false;
});

// ── Orientation ──────────────────────────────────────────────────────────────

/**
 * Resizes and repositions the panel to match the current orientation.
 * Notifies both the panel renderer and the main renderer.
 */
function applyOrientation() {
    if (!participantWindow || participantWindow.isDestroyed()
            || isDragging() || isResizing() || isPillMode()) {
        // isPillMode: the pill is locked to PILL_SIZE; resizing/repositioning
        // here would yank it out of its fixed shape. expandFromPill reapplies
        // orientation and size when the user reopens.
        return;
    }

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();

    // Clamp visible count to the pin floor as a lower bound and the
    // participant count as an upper bound, so the data layer can't drift
    // below the floor even when called from paths that bypass the
    // PIN_STATE_CHANGED handler.
    const visibleCount = Math.max(
        getMinTiles(),
        Math.min(getVisibleTileCount(), currentParticipantCount)
    );

    setVisibleTileCount(visibleCount);

    // An orientation toggle reshapes every tile (the cross and main axes swap),
    // so the panel-reported per-video extent no longer applies — clear it and
    // pre-size with the uniform estimate. The panel reports the exact extent
    // once it re-renders, and the CONTENT_SIZE handler refits.
    contentMainExtent = null;
    effTileMain = null;
    tileMainSizes = [];

    const { width: W, height: H } = computeWindowSize(visibleCount, currentOrientation);
    const { x, y } = getWindowPosition(W, H, currentOrientation, display.workArea);

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

    // Min = floor enforced by pin count (else 1 tile). The cross axis is locked
    // (min == max) so resize stays on one axis: height in horizontal, width in
    // vertical. The main axis is left generous (up to the work area) rather than
    // clamped to a uniform all-participants estimate — with per-video tiles the
    // exact content extent can exceed that estimate, and clamping it here would
    // crop the panel. The pin floor (min) and tile-count ceiling are enforced by
    // the resize engine's snapping instead.
    const eff = effectiveTileMain();
    const minSize = computeWindowSize(getMinTiles(), currentOrientation, eff);
    const mainWindow = getMainWindow();
    const workArea = (mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay()).workArea;

    if (currentOrientation === 'horizontal') {
        // Height locked, width free up to the work area.
        participantWindow.setMinimumSize(minSize.width, minSize.height);
        participantWindow.setMaximumSize(Math.max(minSize.width, workArea.width), minSize.height);
    } else {
        // Width locked, height free up to the work area.
        participantWindow.setMinimumSize(minSize.width, minSize.height);
        participantWindow.setMaximumSize(minSize.width, Math.max(minSize.height, workArea.height));
    }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on(IPC.TOGGLE_ORIENTATION, () => {
    currentOrientation = currentOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    saveOrientation(currentOrientation);
    applyOrientation();
});

// Track pin count so resize handlers can honor it as a floor. ipc.js
// already forwards pin state to the main renderer for dominant-speaker
// protection — this is an additional listener, not a replacement.
ipcMain.on(IPC.PIN_STATE_CHANGED, (_event, pinnedIds) => {
    if (pinnedIds && typeof pinnedIds === 'object' && !Array.isArray(pinnedIds)) {
        currentPinnedCount = Object.keys(pinnedIds).length;
    } else {
        currentPinnedCount = 0;
    }

    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }

    // Skip all window mutations while in pill mode: both branches below
    // (applyOrientation / updateSizeConstraints) would override the pill's
    // fixed PILL_SIZE lock. currentPinnedCount is already updated above, and
    // expandFromPill → restoreSizeConstraints reapplies the correct floor when
    // the user reopens the panel.
    if (isPillMode()) {
        return;
    }

    // Grow visible count up to the new floor if pinning just expanded it.
    // Shrinking past the floor is handled by setMinimumSize via
    // updateSizeConstraints — the OS won't allow it.
    //
    // Skip the auto-expand while a drag/resize is in flight: applyOrientation
    // silently no-ops in that state, so mutating _visibleTileCount here
    // would leave the data layer out of sync with the window bounds.
    // updateSizeConstraints picks up the new floor on the next tick when
    // the resize completes and restoreSizeConstraints fires.
    const min = getMinTiles();

    if (!isDragging() && !isResizing() && getVisibleTileCount() < min) {
        setVisibleTileCount(min);
        applyOrientation();
    } else {
        updateSizeConstraints();
    }
});

ipcMain.on(IPC.RESIZE, (_event, { count }) => {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }

    currentParticipantCount = Math.max(1, count);

    // While auto-sizing, the visible count tracks the length-budget cap; once the
    // user has manually resized we keep their count, just clamped to bounds.
    const visibleCount = autoSized
        ? budgetVisibleCount()
        : Math.max(getMinTiles(), Math.min(getVisibleTileCount(), currentParticipantCount));

    setVisibleTileCount(visibleCount);

    // While in pill mode or mid drag/resize we still keep the count/visible
    // data in sync above (so expandFromPill and gesture-end restore size to
    // the fresh count) — but we must not move the window or touch size
    // constraints: that would fight the pill size lock and the resize lerp.
    if (isPillMode() || isDragging() || isResizing()) {
        return;
    }

    const { width: W, height: H } = computeWindowSize(visibleCount, currentOrientation, effectiveTileMain());

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x, y } = getWindowPosition(W, H, currentOrientation, display.workArea);

    updateSizeConstraints();
    participantWindow.setMinimumSize(1, 1);
    participantWindow.setBounds({ x, y, width: W, height: H });
    updateSizeConstraints();

    participantWindow.webContents.send(IPC.VISIBLE_COUNT_CHANGED, { count: visibleCount, edge: null });
});

/**
 * Fits the window to the panel's reported per-video content extent (the exact
 * main-axis size of the visible tiles) and re-anchors it. Falls back to the
 * uniform estimate before the panel has reported. No-ops while a gesture or
 * pill transition owns the bounds — those paths refit when they finish.
 */
function fitWindowToContent() {
    if (!participantWindow || participantWindow.isDestroyed()
            || isDragging() || isResizing() || isPillMode()) {
        return;
    }

    const visibleCount = Math.max(
        getMinTiles(),
        Math.min(getVisibleTileCount(), currentParticipantCount)
    );
    const mainExtent = contentMainExtent !== null
        ? contentMainExtent
        : uniformMainExtent(visibleCount, effectiveTileMain());
    const { width: W, height: H } = windowFromMainExtent(mainExtent, currentOrientation);

    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { x, y } = getWindowPosition(W, H, currentOrientation, display.workArea);

    // Relax constraints so the exact extent isn't clamped by a stale max, set
    // bounds, then reapply the locked-cross-axis constraints. Mark the window as
    // self-fitting so the native-resize listener doesn't re-snap these bounds.
    fittingUntil = Date.now() + 150;
    participantWindow.setMinimumSize(1, 1);
    participantWindow.setMaximumSize(0, 0);
    participantWindow.setBounds({ x, y, width: W, height: H });
    updateSizeConstraints();
}

// The panel reports the main-axis extent of its visible tiles whenever they
// change (new frame aspect ratio, participant add/remove, layout switch). Fit
// the window to it so per-video tiles are never cropped or left with dead space.
ipcMain.on(IPC.CONTENT_SIZE, (_event, data) => {
    if (!data || typeof data.mainExtent !== 'number' || !isFinite(data.mainExtent)) {
        return;
    }

    // Ignore reports for a stale orientation (arriving mid-toggle).
    if (data.orientation && data.orientation !== currentOrientation) {
        return;
    }

    if (typeof data.avgTileMain === 'number' && data.avgTileMain > 0) {
        effTileMain = data.avgTileMain;
    }

    // Stored before the extent dedup below so a report that only changes the
    // tile set (same overall extent) still refreshes the per-tile snap sizes.
    if (Array.isArray(data.tileMains)) {
        tileMainSizes = data.tileMains;
    }

    // Re-apply the length-budget cap with the fresh per-tile sizes (e.g. a tile
    // just became a tall portrait). If the cap changes the count, re-render and
    // let the resulting report size the window — this extent is now stale.
    if (autoSized && !isPillMode() && !isDragging() && !isResizing()
            && participantWindow && !participantWindow.isDestroyed()) {
        const want = budgetVisibleCount();

        if (want !== getVisibleTileCount()) {
            setVisibleTileCount(want);
            participantWindow.webContents.send(IPC.VISIBLE_COUNT_CHANGED, { count: want, edge: null });

            return;
        }
    }

    const next = Math.round(data.mainExtent);

    // Skip negligible deltas to avoid setBounds churn from sub-pixel jitter.
    if (contentMainExtent !== null && Math.abs(next - contentMainExtent) < 2) {
        return;
    }

    contentMainExtent = next;
    fitWindowToContent();
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
    currentPinnedCount = 0;
    contentMainExtent = null;
    effTileMain = null;
    tileMainSizes = [];
    // Restore the user's chosen size across reopen; otherwise start at 1 and let
    // the budget cap auto-fit once participants + per-tile sizes arrive.
    setVisibleTileCount(!autoSized && savedUserCount ? savedUserCount : 1);

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
    const { x: posX, y: posY } = getWindowPosition(W, H, currentOrientation, display.workArea);

    try {
        participantWindow = new BrowserWindow({
            x: posX,
            y: posY,
            width: W,
            height: H,
            minWidth: TILE_W + TILE_PAD * 2 + BORDER * 2 + WINDOW_PAD * 2,
            minHeight: H_TILE_H + TILE_PAD * 2 + HEADER_H + BORDER * 2 + WINDOW_PAD * 2,
            transparent: true,
            frame: false,
            alwaysOnTop: true,
            // No native window shadow: it's rectangular (sharp corners) on the
            // rounded panel. The window carries WINDOW_PAD of transparent padding
            // so the panel's own rounded CSS box-shadow renders instead.
            hasShadow: false,
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

    attachNativeResizeListener(
        participantWindow, getState, () => isPillMode() || isDragging() || Date.now() < fittingUntil
    );

    participantWindow.webContents.on('did-finish-load', () => {
        if (participantWindow && !participantWindow.isDestroyed()) {
            participantWindow.webContents.send(IPC.ORIENTATION_CHANGED, currentOrientation);

            // Also tell the jitsi renderer the active orientation now, not just
            // on toggle. Its orientationRef defaults to 'horizontal'; without
            // this the frame capture uses the wrong tile aspect until the user
            // first toggles when the persisted orientation is 'vertical'.
            const mw = getMainWindow();

            if (mw && !mw.isDestroyed()) {
                mw.webContents.send(IPC.ORIENTATION_CHANGED_RENDERER, currentOrientation);
            }

            // Direct send: the cache is already suppression-applied (via
            // sendParticipantsUpdate, the only writer); re-routing would
            // re-evaluate suppression against our own zeroed value and
            // drop the window early.
            if (lastParticipantsData) {
                participantWindow.webContents.send(IPC.PARTICIPANTS_UPDATE, lastParticipantsData);
            }

            // Replay the last host theme so a panel opened after the theme was
            // set still recolours (instead of falling back to the dark defaults).
            if (lastThemeData) {
                participantWindow.webContents.send(IPC.THEME_UPDATE, lastThemeData);
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
    if (suppressUnreadUntil > 0) {
        const incoming = participants?.unreadChatCount ?? 0;
        const expired = Date.now() >= suppressUnreadUntil;
        const caughtUp = incoming === 0;
        const newMessages = incoming > suppressBaseline;

        if (expired || caughtUp || newMessages) {
            suppressUnreadUntil = 0;
            suppressBaseline = 0;
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

/**
 * Caches and forwards the host theme tokens to the panel so it recolours live.
 * Cached because the jitsi renderer may push the theme before the panel window
 * exists; the did-finish-load handler replays the cache on open.
 *
 * @param {Object} theme - { accent, accentHover, danger, dangerIcon, warn }.
 * @returns {void}
 */
function setParticipantTheme(theme) {
    if (!theme || typeof theme !== 'object') {
        return;
    }

    lastThemeData = theme;

    if (participantWindow && !participantWindow.isDestroyed()) {
        participantWindow.webContents.send(IPC.THEME_UPDATE, theme);
    }
}

function closeParticipantWindow(notifyUserClosed = false) {
    lastParticipantsData = null;

    // Remember a user-chosen size so reopening the panel restores it instead of
    // snapping back to the budget default.
    if (!autoSized) {
        savedUserCount = getVisibleTileCount();
    }
    // suppressUnreadUntil intentionally survives close: the chat-click
    // closes the PiP ms later and reopens it when the user minimises.
    // Edge case: if a new meeting starts within the 15s window with
    // unread <= suppressBaseline (carried from the old meeting), those
    // messages are suppressed briefly. The caughtUp signal
    // (incoming === 0) drops suppression on a clean-slate meeting, and
    // the timer caps the worst case at 15s.
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
 * Suppress the unread-chat badge after the user opened chat from the PiP.
 * jitsi-meet's chat-read state takes a few seconds to propagate, so the
 * next pp-participants-update still carries the old unreadChatCount and
 * a re-opened PiP would briefly show a stale badge.
 *
 * Baseline = count at suppression-start: incoming > baseline drops
 * suppression so a real new message during the window shows immediately.
 */
function suppressUnreadChatCount() {
    suppressBaseline = lastParticipantsData?.unreadChatCount ?? 0;
    if (lastParticipantsData) {
        lastParticipantsData = { ...lastParticipantsData, unreadChatCount: 0 };
    }
    suppressUnreadUntil = Date.now() + UNREAD_SUPPRESS_MS;
}

module.exports = {
    openParticipantWindow,
    sendParticipantFrame,
    sendParticipantsUpdate,
    setParticipantTheme,
    closeParticipantWindow,
    shrinkToPill,
    suppressUnreadChatCount,
    getCurrentState: getState,
};
