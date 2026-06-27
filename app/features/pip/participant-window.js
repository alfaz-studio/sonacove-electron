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

const { CARD_W, CARD_H_DEFAULT, MARGIN, IPC } = require('./constants');
const { setupDragHandlers, isDragging } = require('./drag');
const { setParticipantWindow, getMainWindowExcludingPip: getMainWindow, resolveFile } = require('./helpers');
const { setupPillHandlers, isPillMode, shrinkToPill, reset: resetPill } = require('./pill');
const { getCardPosition } = require('./sizing');

// ── Settings persistence ─────────────────────────────────────────────────────

const SETTINGS_FILE = path.join(app.getPath('userData'), 'pip-settings.json');
const VALID_LAYOUTS = [ 'single', 'split', 'grid' ];
const DEFAULT_SETTINGS = { layout: 'single',
    auto: true };

/**
 * Reads persisted panel settings from disk, validating each field and
 * falling back to defaults for anything missing or malformed.
 *
 * @returns {{ layout: string, auto: boolean }}
 */
function loadSettings() {
    try {
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const layout = VALID_LAYOUTS.includes(data.layout) ? data.layout : DEFAULT_SETTINGS.layout;
        const auto = typeof data.auto === 'boolean' ? data.auto : DEFAULT_SETTINGS.auto;

        return { layout,
            auto };
    } catch (_) { /* missing, corrupt, or unreadable — fall through */ }

    return { ...DEFAULT_SETTINGS };
}

let currentSettings = loadSettings();

/**
 * Merges the given prefs into the current settings and writes them to disk.
 * Async + best-effort: a failure just means the next launch falls back to
 * the last persisted (or default) settings.
 *
 * @param {{ layout?: string, auto?: boolean }} next - Partial prefs to merge.
 */
function saveSettings(next) {
    if (!next || typeof next !== 'object') {
        return;
    }

    const merged = { ...currentSettings };

    if (VALID_LAYOUTS.includes(next.layout)) {
        merged.layout = next.layout;
    }
    if (typeof next.auto === 'boolean') {
        merged.auto = next.auto;
    }

    currentSettings = merged;
    fs.writeFile(SETTINGS_FILE, JSON.stringify(merged), 'utf8', () => {
        /* best-effort write — ignore errors (next launch falls back to defaults) */
    });
}

let participantWindow = null;
let currentSize = { width: CARD_W,
    height: CARD_H_DEFAULT };
let lastParticipantsData = null;
let lastThemeData = null;

// See suppressUnreadChatCount() for the rationale. 15s is the safety floor;
// suppression normally drops earlier via the signals in sendParticipantsUpdate.
const UNREAD_SUPPRESS_MS = 15000;
let suppressUnreadUntil = 0;
let suppressBaseline = 0;

// ── Wire up drag and pill subsystems ─────────────────────────────────────────

const getWindow = () => participantWindow;
const getState = () => {
    return { size: currentSize };
};

setupDragHandlers(getWindow);
setupPillHandlers(getWindow, getState);

// ── IPC handlers ─────────────────────────────────────────────────────────────

// Renderer-driven sizing: the Spotlight card measures its own content per
// layout and reports the exact window size it needs. Main honors the request,
// keeping the bottom-right corner anchored so the card grows upward/leftward.
ipcMain.on(IPC.SET_SIZE, (_event, { width, height } = {}) => {
    const mainWindow = getMainWindow();
    const display = mainWindow
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const { workArea } = display;

    // Clamp to sane bounds: a hard floor plus the display work area (minus
    // edge margins) as the ceiling, so a runaway measure can't exceed screen.
    const maxW = Math.max(200, workArea.width - (MARGIN * 2));
    const maxH = Math.max(200, workArea.height - (MARGIN * 2));
    const w = Math.round(Math.min(maxW, Math.max(200, Number(width) || CARD_W)));
    const h = Math.round(Math.min(maxH, Math.max(200, Number(height) || CARD_H_DEFAULT)));

    currentSize = { width: w,
        height: h };

    if (!participantWindow || participantWindow.isDestroyed()
            || isPillMode() || isDragging()) {
        // Pill lock / active drag own the bounds; currentSize is still updated
        // so expandFromPill / drag-end restore to the fresh size.
        return;
    }

    // Anchor the window's CURRENT bottom-right corner so the card grows
    // upward/leftward in place (instead of snapping to the screen corner after
    // the user has dragged it somewhere), then clamp fully on-screen.
    const b = participantWindow.getBounds();
    const x = Math.max(workArea.x, Math.min(b.x + b.width - w, workArea.x + workArea.width - w));
    const y = Math.max(workArea.y, Math.min(b.y + b.height - h, workArea.y + workArea.height - h));

    participantWindow.setBounds({ x,
        y,
        width: w,
        height: h });
});

ipcMain.on(IPC.SAVE_SETTINGS, (_event, next) => saveSettings(next));

// ── Window lifecycle ─────────────────────────────────────────────────────────

/**
 * Opens the floating participant PiP panel.
 */
function openParticipantWindow() {
    if (participantWindow && !participantWindow.isDestroyed()) {
        return;
    }

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

    const { width: W, height: H } = currentSize;
    const { x: posX, y: posY } = getCardPosition(W, H, display.workArea);

    try {
        participantWindow = new BrowserWindow({
            x: posX,
            y: posY,
            width: W,
            height: H,
            transparent: true,
            frame: false,
            alwaysOnTop: true,

            // No OS window shadow. The window is transparent with rounded content
            // (the card, and the round pill in pill mode), so the native shadow
            // renders as a sharp-cornered square halo around the window rect — and
            // a runtime setHasShadow(false) toggle doesn't reliably repaint it away
            // on Windows. Both the card and the pill carry their own rounded CSS
            // box-shadow (WINDOW_PAD / the pill's window margin give it room), so
            // depth is preserved without the halo.
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
            // Hand the panel its persisted layout/auto prefs so it can render
            // the right layout immediately and then report its measured size.
            participantWindow.webContents.send(IPC.SETTINGS, currentSettings);

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

/**
 * Forwards a rendered participant video frame to the PiP panel, if it's open.
 *
 * @param {*} frameData - The frame payload to relay to the panel renderer.
 * @returns {void}
 */
function sendParticipantFrame(frameData) {
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    participantWindow.webContents.send(IPC.FRAME, frameData);
}

/**
 * Caches and forwards a participants update to the PiP panel, applying the
 * unread-chat suppression window (see suppressUnreadChatCount()).
 *
 * @param {Object} participants - The participants payload from the renderer.
 * @returns {void}
 */
function sendParticipantsUpdate(participants) {
    let outgoing = participants;

    if (suppressUnreadUntil > 0) {
        const incoming = participants?.unreadChatCount ?? 0;
        const expired = Date.now() >= suppressUnreadUntil;
        const caughtUp = incoming === 0;
        const newMessages = incoming > suppressBaseline;

        if (expired || caughtUp || newMessages) {
            suppressUnreadUntil = 0;
            suppressBaseline = 0;
        } else {
            outgoing = { ...participants,
                unreadChatCount: 0 };
        }
    }

    lastParticipantsData = outgoing;
    if (!participantWindow || participantWindow.isDestroyed()) {
        return;
    }
    participantWindow.webContents.send(IPC.PARTICIPANTS_UPDATE, outgoing);
}

/**
 * Closes the PiP panel, clearing cached participant data and optionally
 * notifying the main window that the user dismissed the panel.
 *
 * @param {boolean} [notifyUserClosed] - When true, tells the main window the
 *   panel was closed so it can update its own state.
 * @returns {void}
 */
function closeParticipantWindow(notifyUserClosed = false) {
    lastParticipantsData = null;

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
        lastParticipantsData = { ...lastParticipantsData,
            unreadChatCount: 0 };
    }
    suppressUnreadUntil = Date.now() + UNREAD_SUPPRESS_MS;
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

/**
 * Returns the last host theme tokens received from the renderer, or null if none
 * have been sent yet. Shared with the annotation overlay so it can recolour to
 * the live app theme too (it has no theme of its own — separate window/storage).
 *
 * @returns {Object|null} The cached theme token map, or null.
 */
function getLastTheme() {
    return lastThemeData;
}

module.exports = {
    openParticipantWindow,
    sendParticipantFrame,
    sendParticipantsUpdate,
    setParticipantTheme,
    getLastTheme,
    closeParticipantWindow,
    shrinkToPill,
    suppressUnreadChatCount,
    getCurrentState: getState
};
