const { ipcMain } = require('electron');

/**
 * Sets up automatic Picture-in-Picture triggering for Electron.
 *
 * Uses webContents.executeJavaScript with userGesture:true to call
 * window.__pipEnter() / window.__pipExit() which are registered by the
 * jitsi-meet frontend (controller-electron.ts). All PiP DOM logic and
 * media session setup lives in the frontend — this module only orchestrates
 * when to enter/exit.
 *
 * @param {BrowserWindow} mainWindow - The main application window.
 */
function setupPictureInPicture(mainWindow) {
    let pipActive = false;

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('✅ PiP: Window loaded, setting up auto-trigger');
        pipActive = false;

        // Install visibility change and PiP exit listeners in the renderer.
        // These are the only bits of inline JS needed — they just send IPC
        // messages back to the main process so we can respond with userGesture.
        mainWindow.webContents.executeJavaScript(`
            (() => {
                if (window.__pipVisibilityInstalled) return;
                window.__pipVisibilityInstalled = true;

                const getApi = () => window.sonacoveElectronAPI || window.electronAPI;

                document.addEventListener('visibilitychange', () => {
                    const hidden = document.visibilityState === 'hidden';
                    getApi()?.ipc?.send?.('pip-visibility-change', hidden);
                });

                document.addEventListener('leavepictureinpicture', () => {
                    getApi()?.ipc?.send?.('pip-exited');
                });
            })();
        `);
    });

    ipcMain.on('pip-visibility-change', (_event, hidden) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        if (hidden && !pipActive) {
            // userGesture: true (second arg) bypasses Chromium's gesture requirement.
            // window.__pipEnter() is registered by the frontend's ElectronPipController.
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
