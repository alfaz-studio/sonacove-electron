const { ipcMain, BrowserWindow } = require('electron');
const { getMainWindow } = require('../windows/main-window');
const { toggleOverlay } = require('../windows/overlay-window');
const { currentConfig } = require('../config'); 

function setupIpcHandlers() {
    // Toggle Annotation Overlay
    ipcMain.on('toggle-annotation', (event, data) => {
        const win = getMainWindow();
        if (win) {
            toggleOverlay(win, data);
        }
    });

    // Click-Through Logic
    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.setIgnoreMouseEvents(ignore, { forward: true });
        }
    });

    // Home Navigation
    ipcMain.on('nav-to-home', () => {
        const win = getMainWindow();
        if (win) {
            console.log(`🏠 Navigating to Home: ${currentConfig.landing}`);
            win.loadURL(currentConfig.landing);
        }
    });
}

module.exports = { setupIpcHandlers };
