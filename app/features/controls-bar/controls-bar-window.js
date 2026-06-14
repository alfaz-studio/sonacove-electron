/**
 * Screenshare controls bar — window lifecycle.
 *
 * A transparent, frameless, always-on-top window showing the "sharing strip"
 * that expands (resize-on-hover) to reveal the meeting controls. Phase 1 is
 * visuals only; control actions are wired in Phase 2.
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');

const { t } = require('../i18n');

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

// Latest conference start timestamp (epoch ms) pushed from the jitsi renderer.
// Cached at module scope so it survives the bar window opening *after* the
// value was already set — replayed to the renderer on every load (no race).
let conferenceTimestamp = null;

/** Sends a message to the controls-bar renderer if the window is alive. */
function sendToBar(channel, payload) {
    if (controlsBarWindow && !controlsBarWindow.isDestroyed()) {
        controlsBarWindow.webContents.send(channel, payload);
    }
}

/**
 * Builds the bar's localized UI strings. The renderer (a separate window with
 * no i18n runtime of its own) applies these on load — same approach the
 * titlebar uses for its sandboxed renderer.
 *
 * @returns {Object} Map of string keys to translated text.
 */
function barStrings() {
    return {
        windowTitle: t('controlsBar.windowTitle'),
        live: t('controlsBar.live'),
        stop: t('controlsBar.stop'),
        audio: t('controlsBar.audio'),
        video: t('controlsBar.video'),
        participants: t('controlsBar.participants'),
        chat: t('controlsBar.chat'),
        annotate: t('controlsBar.annotate'),
        stopAnnotating: t('controlsBar.stopAnnotating'),
        more: t('controlsBar.more'),
        record: t('controlsBar.record'),
        stopRecording: t('controlsBar.stopRecording'),
        hint: t('controlsBar.hint')
    };
}

/**
 * Caches the conference start timestamp and forwards it to the bar. Called from
 * the main IPC layer (ipc.js) whenever the renderer reports it.
 *
 * @param {number|null} ts - Conference start time in epoch ms.
 * @returns {void}
 */
function setConferenceTimestamp(ts) {
    // Coerce: the renderer reports the conference timestamp as a numeric STRING,
    // so a strict typeof-number check would drop it. Number() handles both.
    const n = Number(ts);

    conferenceTimestamp = Number.isFinite(n) && n > 0 ? n : null;
    sendToBar(IPC.CONFERENCE_TIMESTAMP, conferenceTimestamp);
}

// Latest local mic/cam muted state, so the bar's Audio/Video icons are correct
// on open (cached + replayed on load, like the timestamp).
let avMuted = { audioMuted: false,
    videoMuted: false };

/**
 * Caches the local audio/video muted state and forwards it to the bar.
 *
 * @param {{ audioMuted?: boolean, videoMuted?: boolean }} [data] - Muted flags.
 * @returns {void}
 */
function setAvState(data) {
    avMuted = { audioMuted: Boolean(data?.audioMuted),
        videoMuted: Boolean(data?.videoMuted) };
    sendToBar('cb-av-state', avMuted);
}

// Latest participant / unread counts for the bar's badges (cached + replayed).
let counts = { participantCount: 0,
    unreadCount: 0 };

/**
 * Caches the participant / unread counts and forwards them to the bar.
 *
 * @param {{ participantCount?: number, unreadCount?: number }} [data] - Counts.
 * @returns {void}
 */
function setCounts(data) {
    counts = { participantCount: Number(data?.participantCount) || 0,
        unreadCount: Number(data?.unreadCount) || 0 };
    sendToBar('cb-counts', counts);
}

// Latest local-recording on/off state (cached + replayed on load).
let recording = false;

/**
 * Caches the local recording on/off state and forwards it to the bar.
 *
 * @param {{ recording?: boolean }} [data] - The recording flag.
 * @returns {void}
 */
function setRecording(data) {
    recording = Boolean(data?.recording);
    sendToBar('cb-recording', { recording });
}

// Latest annotation on/off state (cached + replayed on load).
let annotating = false;

/**
 * Caches the annotation on/off state and forwards it to the bar.
 *
 * @param {{ annotating?: boolean }} [data] - The annotation flag.
 * @returns {void}
 */
function setAnnotateState(data) {
    annotating = Boolean(data?.annotating);
    sendToBar('cb-annotate-state', { annotating });
}

/**
 * Forwards a transient toast to the bar (not cached — it's a one-off event).
 *
 * @param {{ message: string, sub?: string, actionLabel?: string }} [data] - Toast.
 * @returns {void}
 */
function showToast(data) {
    if (data?.message) {
        sendToBar('cb-toast', data);
    }
}

// ── Crash safety ────────────────────────────────────────────────────────────
// The bar is a separate always-on-top window. If the meeting's main window or
// its renderer dies without sending cb-hide, the bar would be orphaned over the
// screen — so we watch the main window and tear the bar down with it.

let mainWindowWatch = null;

/** Stops watching the main window for close/crash. */
function detachMainWindowWatch() {
    if (!mainWindowWatch) {
        return;
    }
    const { win, onGone } = mainWindowWatch;

    if (win && !win.isDestroyed()) {
        win.removeListener('closed', closeControlsBarWindow);
        if (win.webContents && !win.webContents.isDestroyed()) {
            win.webContents.removeListener('render-process-gone', onGone);
        }
    }
    mainWindowWatch = null;
}

/** Closes the bar if the meeting's main window closes or its renderer crashes. */
function attachMainWindowWatch() {
    detachMainWindowWatch();
    const win = getMainWindow();

    if (!win || win.isDestroyed()) {
        return;
    }
    const onGone = () => closeControlsBarWindow();

    win.once('closed', closeControlsBarWindow);
    win.webContents.once('render-process-gone', onGone);
    mainWindowWatch = { win,
        onGone };
}

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

    // cb-stop-share (Stop button) is handled in app/features/ipc.js, which has
    // the direct main-window reference needed to forward the stop to the renderer.
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

    // Start click-through: the transparent margins around the capsule must not
    // eat clicks meant for the shared screen behind. `forward: true` still
    // delivers mousemove to the renderer, which re-enables interaction when the
    // cursor is over the capsule (see controls-bar.js).
    controlsBarWindow.setIgnoreMouseEvents(true, { forward: true });

    controlsBarWindow.on('closed', () => {
        controlsBarWindow = null;
        detachMainWindowWatch();
        stopDrag();
    });

    /** Reveals the window + (macOS) the dock icon. Idempotent. */
    const reveal = () => {
        if (controlsBarWindow && !controlsBarWindow.isDestroyed()) {
            controlsBarWindow.show();
            if (process.platform === 'darwin') {
                app.dock.show();
            }
        }
    };

    // Show as soon as the first frame is painted — far snappier than waiting on
    // did-finish-load (which blocks on every subresource, incl. fonts).
    controlsBarWindow.once('ready-to-show', reveal);

    controlsBarWindow.webContents.on('did-finish-load', () => {
        reveal(); // fallback in case ready-to-show didn't fire

        // Localized UI strings first, so the Record / Annotate state replays
        // below land their labels in the right language (IPC preserves order).
        sendToBar('cb-strings', barStrings());

        // Replay cached state so a freshly-loaded bar reflects reality.
        sendToBar(IPC.CONFERENCE_TIMESTAMP, conferenceTimestamp);
        sendToBar('cb-av-state', avMuted);
        sendToBar('cb-counts', counts);
        sendToBar('cb-recording', { recording });
        sendToBar('cb-annotate-state', { annotating });
    });

    attachMainWindowWatch();
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
    closeControlsBarWindow,
    setConferenceTimestamp,
    setAvState,
    setCounts,
    setRecording,
    setAnnotateState,
    showToast
};
