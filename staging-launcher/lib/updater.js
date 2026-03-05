/**
 * Set up electron-updater auto-update lifecycle and related IPC handlers.
 *
 * All Electron modules are injected as parameters so this module has zero
 * direct Electron imports, making the dependency flow explicit.
 *
 * @param {{ autoUpdater, ipcMain, app, getMainWindow: Function, dialog }} deps
 */
function setupAutoUpdater({ autoUpdater, ipcMain, app, getMainWindow, dialog }) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] Checking for launcher update...');
        const win = getMainWindow();

        if (win && !win.isDestroyed()) {
            win.webContents.send('updater-status', {
                status: 'checking'
            });
        }
    });

    autoUpdater.on('update-available', info => {
        console.log(`[updater] Update available: ${info.version}`);
        const win = getMainWindow();

        if (win && !win.isDestroyed()) {
            win.webContents.send('updater-status', {
                status: 'downloading',
                version: info.version
            });
        }
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[updater] No update available.');
        const win = getMainWindow();

        if (win && !win.isDestroyed()) {
            win.webContents.send('updater-status', {
                status: 'up-to-date'
            });
        }
    });

    autoUpdater.on('download-progress', progress => {
        const win = getMainWindow();

        if (win && !win.isDestroyed()) {
            win.webContents.send('updater-status', {
                status: 'downloading',
                percent: Math.round(progress.percent)
            });
        }
    });

    autoUpdater.on('update-downloaded', info => {
        console.log(`[updater] Update downloaded: ${info.version}`);
        const win = getMainWindow();

        if (win && !win.isDestroyed()) {
            win.webContents.send('updater-status', {
                status: 'ready',
                version: info.version
            });

            dialog.showMessageBox(win, {
                type: 'info',
                title: 'Launcher Update Ready',
                message: `Staging Launcher v${info.version} has been downloaded. Restart to update?`,
                buttons: [ 'Restart Now', 'Later' ]
            }).then(result => {
                if (result.response === 0) {
                    autoUpdater.quitAndInstall(false, true);
                }
            });
        }
    });

    autoUpdater.on('error', err => {
        console.error('[updater] Error:', err.message);
        const win = getMainWindow();

        if (win && !win.isDestroyed()) {
            win.webContents.send('updater-status', {
                status: 'error',
                error: err.message
            });
        }
    });

    // IPC: allow renderer to request a manual update check
    ipcMain.handle('check-for-updates', async () => {
        try {
            const result = await autoUpdater.checkForUpdates();

            return {
                updateAvailable: result && result.updateInfo
                    && result.updateInfo.version !== app.getVersion()
            };
        } catch (err) {
            return { updateAvailable: false, error: err.message };
        }
    });

    // IPC: return current app version
    ipcMain.handle('get-app-version', () => app.getVersion());

    // Check for updates after a short delay to let the UI load first
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.error('[updater] Check failed:', err.message);
        });
    }, 3000);
}

module.exports = { setupAutoUpdater };
