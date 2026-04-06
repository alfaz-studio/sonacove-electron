const { BrowserWindow, shell } = require('electron');
const isDev = require('electron-is-dev');

const sonacoveConfig = require('./config');
const { toggleOverlay, getOverlayWindow, closeViewersWhiteboards, getMainWindow } = require('./overlay/overlay-window');
const {
    openParticipantWindow,
    sendParticipantFrame,
    sendParticipantsUpdate,
    closeParticipantWindow,
    shrinkToPill,
} = require('../pip/participant-window');

/**
 * Previously registered listeners, keyed by channel.
 * Used to remove only our own listeners when re-registering.
 */
let registeredListeners = {};

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
    for (const [ channel, listener ] of Object.entries(registeredListeners)) {
        ipcMain.removeListener(channel, listener);
    }
    registeredListeners = {};

    /**
     * Registers a listener and tracks it for later cleanup.
     *
     * @param {string} channel - The IPC channel name.
     * @param {Function} listener - The listener function.
     */
    function register(channel, listener) {
        registeredListeners[channel] = listener;
        ipcMain.on(channel, listener);
    }

    // Toggle Annotation Overlay
    // The renderer always sends the object form: { enabled, collabDetails, ... }
    register('toggle-annotation', (event, config) => {
        if (isDev) {
            console.log('🖌️ IPC: toggle-annotation received.', {
                enabled: config.enabled,
                roomId: config.collabDetails?.roomId,
                hasRoomKey: Boolean(config.collabDetails?.roomKey),
                hasAnnotationsUrl: Boolean(config.annotationsUrl),
                isWindowSharing: config.isWindowSharing,
                sourceWidth: config.sourceWidth,
                sourceHeight: config.sourceHeight
            });
        }

        // Find main window dynamically to handle refreshes
        const mw = getMainWindow();

        try {
            toggleOverlay(mw, config);
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
            mw.loadURL(sonacoveConfig.currentConfig.landing);
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

    // ── Participant PiP panel ─────────────────────────────────────────────────

    // Renderer signals that local screenshare started and there are remote
    // participants to show — open the floating participant overlay window.
    // If the window already exists in pill mode, expand it back to full panel.
    register('pip-screenshare-start', () => {
        try {
            const { isPillMode, expandFromPill } = require('../pip/pill');
            const { getParticipantWindow, getCurrentState } = require('../pip/participant-window');

            if (getParticipantWindow() && isPillMode()) {
                const { count, orientation } = getCurrentState();

                expandFromPill(count, orientation);
            } else {
                openParticipantWindow();
            }
        } catch (err) {
            console.error('❌ ParticipantPiP: Failed to open window:', err);
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

    // Renderer signals screenshare ended — shrink to pill instead of
    // destroying the window, so the user can reopen it without re-minimizing.
    register('pip-screenshare-stop', () => {
        const { isPillMode } = require('../pip/pill');

        if (!isPillMode()) {
            shrinkToPill();
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

    // User clicked chat badge in PiP — restore main window and open chat.
    register('pp-open-chat', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
            mainWindow.webContents.send('pip-open-chat');
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
}

module.exports = { setupSonacoveIPC };
