const { BrowserWindow, shell } = require('electron');

const sonacoveConfig = require('./config');
const { toggleOverlay, getOverlayWindow, closeViewersWhiteboards } = require('./overlay-window');

/**
 * Registers all Sonacove-specific IPC listeners.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @param {Electron.BrowserWindow} mainWindow - The main application window.
 * @returns {void}
 */
function setupSonacoveIPC(ipcMain, mainWindow) {

    // Toggle Annotation Overlay
    ipcMain.on('toggle-annotation', (event, data) => {
        // Ensure we pass the current main window instance
        toggleOverlay(mainWindow, data);
    });

    // Open External Links (Proxy for renderer)
    // URLs on allowed hosts are navigated in-app instead of opening the system browser.
    ipcMain.on('open-external', (event, url) => {
        const allowedHosts = sonacoveConfig.currentConfig.allowedHosts || [];

        try {
            const parsedUrl = new URL(url);

            if (allowedHosts.some(host => parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`))) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadURL(url);
                }

                return;
            }
        } catch (e) {
            // ignore parse errors
        }

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
}

module.exports = { setupSonacoveIPC };
