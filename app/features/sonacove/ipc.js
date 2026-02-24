const { BrowserWindow, shell } = require('electron');

const sonacoveConfig = require('./config');
const { toggleOverlay, getOverlayWindow, closeViewersWhiteboards } = require('./overlay-window');

/**
 * Registers all Sonacove-specific IPC listeners.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @param {Electron.BrowserWindow} mainWindow - The main application window.
 * @param {Object} [handlers] - Additional handlers (e.g., for About dialog).
 * @returns {void}
 */
function setupSonacoveIPC(ipcMain, mainWindow, handlers = {}) {

    // Toggle Annotation Overlay
    ipcMain.on('toggle-annotation', (event, data) => {
        // Ensure we pass the current main window instance
        toggleOverlay(mainWindow, data);
    });

    // Open External Links (Proxy for renderer)
    ipcMain.on('open-external', (event, url) => {
        shell.openExternal(url);
    });

    // Show Overlay (Triggered by React once loaded)
    ipcMain.on('show-overlay', () => {
        const overlay = getOverlayWindow();

        if (overlay) {
            overlay.show();
        }
    });

    // Click-through logic
    ipcMain.on('set-ignore-mouse-events', (event, ignore) => {
        console.log(`🖱️ Setting Mouse Ignore: ${ignore}`);
        const win = BrowserWindow.fromWebContents(event.sender);

        if (win) {
            win.setIgnoreMouseEvents(ignore, { forward: true });
        }
    });

    // Screenshare Cleanup
    ipcMain.on('screenshare-stop', (event, data) => {
        closeViewersWhiteboards(data.sharerId);
    });

    // Navigation
    ipcMain.on('nav-to-home', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(sonacoveConfig.currentConfig.landing);
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
