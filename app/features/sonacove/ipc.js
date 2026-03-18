const { BrowserWindow, shell } = require('electron');
const isDev = require('electron-is-dev');

const sonacoveConfig = require('./config');
const { toggleOverlay, getOverlayWindow, closeViewersWhiteboards, getMainWindow } = require('./overlay/overlay-window');

/**
 * Previously registered listeners, keyed by channel.
 * Used to remove only our own listeners when re-registering.
 */
let registeredListeners = {};

/**
 * Registers all Sonacove-specific IPC listeners.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @param {BrowserWindow} _mainWindow - The main window (unused, kept for call-site compat).
 * @param {Object} [handlers] - Additional handlers (e.g., for About dialog).
 * @returns {void}
 */
function setupSonacoveIPC(ipcMain, _mainWindow, handlers = {}) {
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

    // PostHog Analytics
    register('posthog-capture', (_, { event, properties } = {}) => {
        if (event && typeof event === 'string' && handlers.capture) {
            handlers.capture(event, properties || {});
        }
    });
}

module.exports = { setupSonacoveIPC };
