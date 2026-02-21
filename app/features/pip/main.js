const { ipcMain } = require('electron');

/**
 * Sets up automatic Picture-in-Picture triggering for Electron.
 *
 * The frontend (controller-electron.ts) handles all PiP logic:
 * - Registers window.__pipEnter / window.__pipExit globals
 * - Sends 'pip-visibility-change' IPC on visibilitychange
 * - Sends 'pip-exited' IPC when PiP window is closed
 *
 * This module only listens for those IPC messages and responds by calling
 * the globals with executeJavaScript — using userGesture:true for enter
 * to bypass Chromium's gesture requirement.
 *
 * @param {BrowserWindow} mainWindow - The main application window.
 */
function setupPictureInPicture(mainWindow) {
    let pipActive = false;

    mainWindow.webContents.on('did-finish-load', () => {
        pipActive = false;
    });

    ipcMain.on('pip-visibility-change', (_event, hidden) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        if (hidden && !pipActive) {
            // userGesture: true (second arg) bypasses Chromium's gesture requirement.
            mainWindow.webContents.executeJavaScript('window.__pipEnter()', true)
                .then(success => {
                    if (success) {
                        pipActive = true;
                    }
                })
                .catch(err => {
                    console.error('❌ PiP: enter error:', err);
                });
        } else if (!hidden && pipActive) {
            mainWindow.webContents.executeJavaScript('window.__pipExit()')
                .then(() => {
                    pipActive = false;
                })
                .catch(err => {
                    console.error('❌ PiP: exit error:', err);
                    pipActive = false;
                });
        }
    });

    ipcMain.on('pip-exited', () => {
        pipActive = false;
    });
}

module.exports = { setupPictureInPicture };
