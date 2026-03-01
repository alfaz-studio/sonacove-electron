const { BrowserWindow, shell } = require('electron');

const sonacoveConfig = require('./config');
const { toggleOverlay, getOverlayWindow, closeViewersWhiteboards, getMainWindow } = require('./overlay/overlay-window');

/**
 * Registers all Sonacove-specific IPC listeners.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @param {Object} [handlers] - Additional handlers (e.g., for About dialog).
 * @returns {void}
 */
function setupSonacoveIPC(ipcMain, handlers = {}) {
    const channels = [
        'toggle-annotation',
        'open-external',
        'show-overlay',
        'set-ignore-mouse-events',
        'screenshare-stop',
        'nav-to-home',
        'show-about-dialog',
        'check-for-updates',
        'open-help-docs',
        'posthog-capture'
    ];

    channels.forEach(ch => ipcMain.removeAllListeners(ch));

    // Toggle Annotation Overlay
    ipcMain.on('toggle-annotation', (event, data, ...args) => {
        let config = data;

        if (typeof data === 'boolean') {
            config = {
                enabled: data,
                roomUrl: args[0],
                collabDetails: args[1],
                collabServerUrl: args[2]
            };
        } else if (typeof data === 'string') {
            config = {
                enabled: true,
                roomUrl: data,
                collabDetails: args[0],
                collabServerUrl: args[1]
            };
        }

        console.log('🖌️ IPC: toggle-annotation received.', config);

        // Find main window dynamically to handle refreshes
        const mw = getMainWindow();

        toggleOverlay(mw, config);
    });

    // Open External Links (only allow http/https to prevent arbitrary scheme execution)
    ipcMain.on('open-external', (event, url) => {
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
    ipcMain.on('show-overlay', () => {
        const overlay = getOverlayWindow();

        if (overlay) {
            overlay.show();
        }
    });

    // Click-through logic
    ipcMain.on('set-ignore-mouse-events', (event, ignore) => {
        const win = BrowserWindow.fromWebContents(event.sender);

        if (win) {
            win.setIgnoreMouseEvents(ignore, { forward: true });
        }
    });

    // Screenshare Cleanup
    ipcMain.on('screenshare-stop', (event, data) => {
        closeViewersWhiteboards(data?.sharerId);
    });

    // Navigation
    ipcMain.on('nav-to-home', () => {
        const mw = getMainWindow();

        if (mw) {
            mw.loadURL(sonacoveConfig.currentConfig.landing);
        }
    });

    // Custom Windows Title Bar Handlers
    ipcMain.on('show-about-dialog', () => {
        if (handlers.showAboutDialog) {
            handlers.showAboutDialog();
        }
    });

    ipcMain.on('check-for-updates', () => {
        if (handlers.checkForUpdatesManually) {
            handlers.checkForUpdatesManually();
        }
    });

    ipcMain.on('open-help-docs', () => {
        shell.openExternal('https://docs.sonacove.com/');
    });

    // PostHog Analytics
    ipcMain.on('posthog-capture', (_, { event, properties } = {}) => {
        if (event && typeof event === 'string' && handlers.capture) {
            handlers.capture(event, properties || {});
        }
    });
}

module.exports = { setupSonacoveIPC };
