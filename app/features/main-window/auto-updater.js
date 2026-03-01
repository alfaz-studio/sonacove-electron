/* global process */

const { app, dialog } = require('electron');
const isDev = require('electron-is-dev');
const { autoUpdater } = require('electron-updater');

/**
 * Shows a native About dialog with version and environment info.
 *
 * @param {BrowserWindow} parentWindow - The parent window for the dialog.
 * @returns {void}
 */
function showAboutDialog(parentWindow) {
    dialog.showMessageBox(parentWindow, {
        type: 'info',
        title: `About ${app.name}`,
        message: app.name,
        detail: [
            `Version: ${app.getVersion()}`,
            `Electron: ${process.versions.electron}`,
            `Chrome: ${process.versions.chrome}`,
            `Node: ${process.versions.node}`,
            `Platform: ${process.platform} ${process.arch}`
        ].join('\n'),
        buttons: [ 'OK' ]
    });
}

/**
 * Triggers a manual update check and reports the result to the user.
 *
 * @param {BrowserWindow} parentWindow - The parent window for dialogs.
 * @param {Function} capture - Analytics capture function.
 * @returns {void}
 */
function checkForUpdatesManually(parentWindow, capture) {
    autoUpdater.checkForUpdates()
        .then(result => {
            if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
                dialog.showMessageBox(parentWindow, {
                    type: 'info',
                    title: 'No Updates Available',
                    message: `You're on the latest version (${app.getVersion()}).`,
                    buttons: [ 'OK' ]
                });
            }

            // If an update IS available, the existing autoUpdater event
            // handlers (update-available → update-downloaded) take over.
        })
        .catch(err => {
            console.error('Manual update check failed:', err);
            dialog.showMessageBox(parentWindow, {
                type: 'error',
                title: 'Update Check Failed',
                message: 'Could not check for updates. Please try again later.',
                detail: err.message,
                buttons: [ 'OK' ]
            });
        });

    capture('update_check_manual');
}

/**
 * Configures the auto-updater: logger, download settings, event handlers,
 * and triggers an initial check in production.
 *
 * @param {BrowserWindow} parentWindow - The parent window for update dialogs.
 * @param {Function} capture - Analytics capture function.
 * @returns {void}
 */
function setupAutoUpdater(parentWindow, capture) {
    if (process.mas) {
        return;
    }

    // Setup Logger
    autoUpdater.logger = require('electron-log');
    autoUpdater.logger.transports.file.level = 'info';

    // Configure Updater
    autoUpdater.disableWebInstaller = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('🔎 Checking for update...');
    });

    autoUpdater.on('update-available', info => {
        console.log(`✅ Update available: ${info.version}`);
        capture('update_available', {
            new_version: info.version,
            current_version: app.getVersion()
        });
    });

    autoUpdater.on('update-not-available', () => {
        console.log('❌ Update not available.');
    });

    autoUpdater.on('update-downloaded', info => {
        capture('update_downloaded', { new_version: info.version });

        dialog.showMessageBox(parentWindow, {
            type: 'info',
            title: 'Update Ready',
            message: `Version ${info.version} has been downloaded. Quit and install now?`,
            buttons: [ 'Yes', 'Later' ]
        }).then(result => {
            if (result.response === 0) {
                capture('update_install_clicked', { new_version: info.version });
                autoUpdater.quitAndInstall(false, true);
            } else {
                capture('update_deferred', { new_version: info.version });
            }
        });
    });

    autoUpdater.on('error', err => {
        console.error('Updater Error:', err);
        capture('update_error', { error_message: err.message });
    });

    // Only check for updates in production
    if (!isDev) {
        autoUpdater.checkForUpdates();
    }
}

module.exports = {
    showAboutDialog,
    checkForUpdatesManually,
    setupAutoUpdater
};
