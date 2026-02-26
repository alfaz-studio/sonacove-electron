const { ipcMain } = require('electron');

/**
 * Sets up automatic Picture-in-Picture triggering for Electron.
 *
 * The frontend (controller-electron.ts) handles all PiP logic:
 * - Registers window.__pipEnter / window.__pipExit globals
 * - Sends 'pip-visibility-change' IPC on visibilitychange (only during a conference)
 * - Sends 'pip-exited' IPC when PiP window is closed
 *
 * This module only listens for those IPC messages and responds by calling
 * the globals with executeJavaScript — using userGesture:true for enter
 * to bypass Chromium's gesture requirement.
 *
 * Returns a cleanup function that removes IPC listeners when the window
 * is closed (important on macOS where windows can be recreated).
 *
 * @param {BrowserWindow} mainWindow - The main application window.
 * @returns {Function} Cleanup function to remove listeners.
 */
function setupPictureInPicture(mainWindow) {
    let pipActive = false;

    const onDidFinishLoad = () => {
        pipActive = false;
    };

    const onVisibilityChange = (_event, hidden) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        if (hidden && !pipActive) {
            // Set optimistically to prevent duplicate calls from rapid tab switches.
            pipActive = true;

            // userGesture: true (second arg) bypasses Chromium's gesture requirement.
            mainWindow.webContents.executeJavaScript('window.__pipEnter()', true)
                .then(success => {
                    if (!success) {
                        pipActive = false;
                    }
                })
                .catch(err => {
                    console.error('❌ PiP: enter error:', err);
                    pipActive = false;
                });
        } else if (!hidden && pipActive) {
            pipActive = false;

            mainWindow.webContents.executeJavaScript('window.__pipExit()')
                .catch(err => {
                    console.error('❌ PiP: exit error:', err);
                });
        }
    };

    const onPipExited = () => {
        pipActive = false;
    };

    mainWindow.webContents.on('did-finish-load', onDidFinishLoad);
    ipcMain.on('pip-visibility-change', onVisibilityChange);
    ipcMain.on('pip-exited', onPipExited);

    // Return cleanup function to remove listeners when window is closed.
    return () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.removeListener('did-finish-load', onDidFinishLoad);
        }
        ipcMain.removeListener('pip-visibility-change', onVisibilityChange);
        ipcMain.removeListener('pip-exited', onPipExited);
    };
}

module.exports = { setupPictureInPicture };
