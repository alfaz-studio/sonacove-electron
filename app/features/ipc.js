const { BrowserWindow, shell } = require('electron');
const isDev = require('electron-is-dev');

const config = require('./config');
const { toggleOverlay, getOverlayWindow, closeViewersWhiteboards, getMainWindow } = require('./overlay/overlay-window');
const { restoreMainWindow } = require('./overlay/helpers');
const {
    openParticipantWindow,
    sendParticipantFrame,
    sendParticipantsUpdate,
    closeParticipantWindow,
    shrinkToPill,
    suppressUnreadChatCount,
    getCurrentState,
} = require('./pip/participant-window');
const { IPC } = require('./pip/constants');
const { getParticipantWindow } = require('./pip/helpers');
const { openControlsBarWindow, closeControlsBarWindow } = require('./controls-bar/controls-bar-window');
const {
    IPC_REQUEST_CHANNEL: SYSTEM_VOLUME_REQUEST,
    IPC_SET_MUTED_CHANNEL: SYSTEM_VOLUME_SET_MUTED,
    IPC_SET_VOLUME_CHANNEL: SYSTEM_VOLUME_SET_VOLUME,
    sendCurrentSystemVolume,
    setSystemMuted,
    setSystemVolume
} = require('./system-volume');

/**
 * Previously registered listeners as [channel, fn] pairs.
 * Used to remove only our own listeners when re-registering.
 */
let registeredListeners = [];

/**
 * Registers all Sonacove-specific IPC listeners.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @param {BrowserWindow} mainWindow - The main application window.
 * @param {Object} [handlers] - Additional handlers (e.g., for About dialog).
 * @returns {void}
 */
function setupSonacoveIPC(ipcMain, mainWindow, handlers = {}) {
    // Remove only our own previously registered listeners
    for (const [ channel, listener ] of registeredListeners) {
        ipcMain.removeListener(channel, listener);
    }
    registeredListeners = [];

    /**
     * Registers a listener and tracks it for later cleanup.
     *
     * @param {string} channel - The IPC channel name.
     * @param {Function} listener - The listener function.
     */
    function register(channel, listener) {
        registeredListeners.push([ channel, listener ]);
        ipcMain.on(channel, listener);
    }

    // Toggle Annotation Overlay
    // The renderer always sends the object form: { enabled, collabDetails, ... }
    register('toggle-annotation', (event, overlayConfig) => {
        if (isDev) {
            console.log('🖌️ IPC: toggle-annotation received.', {
                enabled: overlayConfig.enabled,
                roomId: overlayConfig.collabDetails?.roomId,
                hasRoomKey: Boolean(overlayConfig.collabDetails?.roomKey),
                hasAnnotationsUrl: Boolean(overlayConfig.annotationsUrl),
                isWindowSharing: overlayConfig.isWindowSharing,
                sourceWidth: overlayConfig.sourceWidth,
                sourceHeight: overlayConfig.sourceHeight
            });
        }

        // Find main window dynamically to handle refreshes
        const mw = getMainWindow();

        try {
            toggleOverlay(mw, overlayConfig);
        } catch (err) {
            console.error('❌ Failed to toggle annotation overlay:', err);
        }
    });

    // Open External Links (only allow http/https to prevent arbitrary scheme execution)
    register('open-external', (event, url) => {
        try {
            const parsed = new URL(url);

            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                shell.openExternal(url);
            } else {
                console.warn(`⚠️ Blocked open-external with disallowed scheme: ${parsed.protocol}`);
            }
        } catch (e) {
            console.warn('⚠️ Blocked open-external with invalid URL:', url);
        }
    });

    // Show Overlay
    register('show-overlay', () => {
        const overlay = getOverlayWindow();

        if (overlay && !overlay.isDestroyed()) {
            overlay.show();
        }
    });

    // Click-through logic
    register('set-ignore-mouse-events', (event, ignore) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);

            if (win && !win.isDestroyed()) {
                win.setIgnoreMouseEvents(ignore, { forward: true });
            }
        } catch (err) {
            console.error('❌ Failed to set ignore mouse events:', err);
        }
    });

    // Screenshare Cleanup
    register('screenshare-stop', (event, data) => {
        closeViewersWhiteboards(data?.sharerId);
    });

    // Navigation
    register('nav-to-home', () => {
        const mw = getMainWindow();

        if (mw) {
            mw.loadURL(config.currentConfig.landing);
        }
    });

    // Custom Windows Title Bar Handlers
    register('show-about-dialog', () => {
        if (handlers.showAboutDialog) {
            handlers.showAboutDialog();
        }
    });

    register('check-for-updates', () => {
        if (handlers.checkForUpdatesManually) {
            handlers.checkForUpdatesManually();
        }
    });

    register('open-help-docs', () => {
        shell.openExternal('https://docs.sonacove.com/');
    });

    // Custom window controls (frame:false on Windows)
    register('titlebar-minimize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);

        if (win && !win.isDestroyed()) {
            win.minimize();
        }
    });

    register('titlebar-maximize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);

        if (win && !win.isDestroyed()) {
            if (win.isMaximized()) {
                win.unmaximize();
            } else {
                win.maximize();
            }
        }
    });

    register('titlebar-close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);

        if (win && !win.isDestroyed()) {
            win.close();
        }
    });

    // ── Participant PiP panel ─────────────────────────────────────────────────

    // Renderer signals that local screenshare started and there are remote
    // participants to show — open the floating participant overlay window.
    // If the window already exists in pill mode, expand it back to full panel.
    register('pip-screenshare-start', () => {
        try {
            // Lazy require — pill.js is only needed for this conditional path.
            const { isPillMode, expandFromPill } = require('./pip/pill');

            if (getParticipantWindow() && isPillMode()) {
                const { count, orientation } = getCurrentState();

                expandFromPill(count, orientation);
            } else {
                openParticipantWindow();
            }
        } catch (err) {
            console.error('❌ ParticipantPiP: Failed to open window:', err);
        }

        // Screenshare controls bar (Phase 1: static visuals).
        // NOTE: this event currently fires only when there are remote
        // participants. Broadening it to any local screenshare (incl. solo) is
        // a Phase 2 trigger task.
        try {
            openControlsBarWindow(getMainWindow);
        } catch (err) {
            console.error('❌ ControlsBar: Failed to open window:', err);
        }
    });

    // Renderer sends a per-participant JPEG frame — forward to the overlay.
    register('pip-screenshare-frame', (_event, frameData) => {
        sendParticipantFrame(frameData);
    });

    // Renderer sends participant metadata (names, avatars, camera state).
    register('pp-participants-update', (_event, participants) => {
        sendParticipantsUpdate(participants);
    });

    // Renderer signals screenshare stopped (main window restored, or panel
    // closed notification echoed back). Only close the PiP if we're not
    // already in pill mode — shrinkToPill() triggers this same event.
    // Guard: if shrinkToPill() just fired, the renderer sends pip-screenshare-stop
    // in response to pip-panel-closed — don't destroy the window in that case.
    register('pip-screenshare-stop', () => {
        const { isPillMode } = require('./pip/pill');

        if (!isPillMode()) {
            closeParticipantWindow();
        }

        closeControlsBarWindow();
    });

    // User toggled pin state in the PiP panel — forward to main renderer
    // so jitsi-meet can protect pinned participants from dominant speaker swapping.
    register(IPC.PIN_STATE_CHANGED, (_event, pinnedIds) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.PIN_STATE_CHANGED_RENDERER, pinnedIds);
        }
    });

    // User toggled mic/cam from the PiP panel — forward to main renderer.
    // Use the direct mainWindow reference (not getMainWindow()) because
    // getMainWindow() picks the first *visible* window, which is the PiP
    // panel itself when the main window is minimized.
    register('pp-toggle-audio', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pip-toggle-audio');
        }
    });

    register('pp-toggle-video', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pip-toggle-video');
        }
    });

    // User clicked chat icon in PiP — restore + focus main window. Only
    // open the chat panel itself when there are unread messages; otherwise
    // just bring the meeting forward.
    register('pp-open-chat', (_event, data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            // restoreMainWindow handles dock.show + app.focus({ steal }) on
            // macOS — required because PiP (alwaysOnTop+skipTaskbar) hides
            // the dock icon and focus() alone won't bring the app forward
            // when another app is in the foreground.
            restoreMainWindow(mainWindow);
            if (data?.openPanel) {
                mainWindow.webContents.send('pip-open-chat');
                suppressUnreadChatCount();
            }
        }
    });

    // User clicked "End meeting" in the PiP panel — leave conference
    // without restoring the main window.
    register('pp-end-meeting', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pip-end-meeting');
        }
        closeParticipantWindow(false);
    });

    // User clicked the close (×) button inside the overlay panel.
    // Shrink to a floating pill instead of destroying the window, so the pill
    // remains visible (always-on-top) over the shared screen — matching the
    // annotation pencil reopen pill behaviour.
    register('pp-close-request', () => {
        shrinkToPill();
    });

    // PostHog Analytics
    register('posthog-capture', (_, { event, properties } = {}) => {
        if (event && typeof event === 'string' && handlers.capture) {
            handlers.capture(event, properties || {});
        }
    });

    // Renderer asks for the current OS-output volume on mount of the
    // prejoin speaker-warning hook. The watcher broadcasts on changes;
    // this handler covers the cold-start case where the first broadcast
    // hasn't happened yet.
    register(SYSTEM_VOLUME_REQUEST, event => {
        if (event.senderFrame !== event.sender.mainFrame) {
            console.warn(`⚠️ ${SYSTEM_VOLUME_REQUEST} rejected: non-main frame`);

            return;
        }
        sendCurrentSystemVolume(event.sender);
    });

    // Renderer toggling the speaker mute button — flips the OS-level
    // mute. system-volume.js force-broadcasts on success so the UI
    // doesn't lag behind the actual state.
    //
    // Origin-validated: only the top frame can mute the OS. Without this
    // any iframe Jitsi loads (etherpad, whiteboard, YouTube embed) could
    // silence the user's machine. Sub-frames are dropped silently after
    // a console.warn — they have no business calling this channel.
    register(SYSTEM_VOLUME_SET_MUTED, (event, muted) => {
        if (event.senderFrame !== event.sender.mainFrame) {
            console.warn(`⚠️ ${SYSTEM_VOLUME_SET_MUTED} rejected: non-main frame`);

            return;
        }
        if (typeof muted !== 'boolean') {
            console.warn(`⚠️ ${SYSTEM_VOLUME_SET_MUTED} rejected: payload not a boolean`);

            return;
        }
        // Fire-and-forget: errors are caught and logged inside setSystemMuted.
        void setSystemMuted(muted);
    });

    // Renderer "fix-it" quick action on the low-volume warning — bumps
    // the OS output volume to a reasonable level.
    //
    // Same origin validation as set-system-volume-muted. Payload must be a
    // finite number; setSystemVolume internally clamps to 0..100, so we
    // don't double-clamp here.
    register(SYSTEM_VOLUME_SET_VOLUME, (event, volume) => {
        if (event.senderFrame !== event.sender.mainFrame) {
            console.warn(`⚠️ ${SYSTEM_VOLUME_SET_VOLUME} rejected: non-main frame`);

            return;
        }
        if (typeof volume !== 'number' || !Number.isFinite(volume)) {
            console.warn(`⚠️ ${SYSTEM_VOLUME_SET_VOLUME} rejected: payload not a finite number`);

            return;
        }
        // Fire-and-forget: errors are caught and logged inside setSystemVolume.
        void setSystemVolume(volume);
    });
}

module.exports = { setupSonacoveIPC };
