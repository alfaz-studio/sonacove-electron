const { ipcMain } = require('electron');

/**
 * Sets up automatic Picture-in-Picture triggering for Electron.
 *
 * Uses webContents.executeJavaScript with userGesture:true to bypass
 * Chromium's user gesture requirement for requestPictureInPicture().
 *
 * @param {BrowserWindow} mainWindow - The main application window.
 */
function setupPictureInPicture(mainWindow) {
    let pipActive = false;

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('✅ PiP: Window loaded, setting up auto-trigger');
        pipActive = false;

        // Install visibility change and PiP exit listeners in the renderer
        mainWindow.webContents.executeJavaScript(`
            (() => {
                if (window.__pipVisibilityInstalled) return;
                window.__pipVisibilityInstalled = true;

                const getApi = () => window.sonacoveElectronAPI || window.electronAPI;

                document.addEventListener('visibilitychange', () => {
                    const hidden = document.visibilityState === 'hidden';
                    console.log('🔔 Visibility change detected: tab ' + (hidden ? 'hidden' : 'visible'));
                    getApi()?.ipc?.send?.('pip-visibility-change', hidden);
                });

                document.addEventListener('leavepictureinpicture', () => {
                    console.log('📱 PiP: User exited PiP window');
                    getApi()?.ipc?.send?.('pip-exited');
                });

                console.log('✅ PiP visibility change detector installed');
            })();
        `);
    });

    ipcMain.on('pip-visibility-change', (_event, hidden) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        if (hidden && !pipActive) {
            _enterPip(mainWindow)
                .then(success => {
                    if (success) {
                        pipActive = true;
                    }
                })
                .catch(err => {
                    console.error('❌ PiP: executeJavaScript error:', err);
                });
        } else if (!hidden && pipActive) {
            _exitPip(mainWindow)
                .then(() => {
                    pipActive = false;
                })
                .catch(err => {
                    console.error('❌ PiP: executeJavaScript exit error:', err);
                    pipActive = false;
                });
        }
    });

    ipcMain.on('pip-exited', () => {
        pipActive = false;
    });
}

/**
 * Enters PiP by executing requestPictureInPicture in the renderer
 * with userGesture:true to bypass the browser gesture requirement.
 *
 * @param {BrowserWindow} mainWindow - The main application window.
 * @returns {Promise<boolean>} Whether PiP was entered successfully.
 */
function _enterPip(mainWindow) {
    return mainWindow.webContents.executeJavaScript(`
        (async () => {
            try {
                const video = document.getElementById('largeVideo');
                if (!video) {
                    console.warn('⚠️ PiP: largeVideo element not found');
                    return false;
                }
                if (document.pictureInPictureElement) {
                    console.log('📱 PiP: Already in PiP mode');
                    return true;
                }
                await video.requestPictureInPicture();
                console.log('✅ PiP: Entered PiP via Electron userGesture');

                if (window.__onElectronPipEntered) {
                    window.__onElectronPipEntered();
                }
                return true;
            } catch (err) {
                console.error('❌ PiP: Failed to enter:', err);
                return false;
            }
        })();
    `, true); // userGesture: true — bypasses Chromium's gesture requirement
}

/**
 * Exits PiP by calling document.exitPictureInPicture in the renderer.
 *
 * @param {BrowserWindow} mainWindow - The main application window.
 * @returns {Promise<boolean>} Whether PiP was exited successfully.
 */
function _exitPip(mainWindow) {
    return mainWindow.webContents.executeJavaScript(`
        (async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                    console.log('✅ PiP: Exited PiP');
                }
                return true;
            } catch (err) {
                console.error('❌ PiP: Failed to exit:', err);
                return false;
            }
        })();
    `);
}

module.exports = { setupPictureInPicture };
