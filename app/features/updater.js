/**
 * Auto-updater setup and manual update check logic.
 *
 * Wraps electron-updater configuration, event handlers, and the manual
 * "Check for Updates" flow triggered from the menu / title bar.
 */

const { app } = require('electron');
const isDev = require('electron-is-dev');
const { autoUpdater } = require('electron-updater');

const { t } = require('./i18n');
const { capture } = require('./analytics');
const { showUpdateToast, showInfoToast } = require('./in-app-dialogs');

let _pendingUpdateVersion = null;
let _isStaging = false;
let _setupDone = false;

/**
 * Configures and starts the auto-updater.
 * No-op on MAS and staging builds.
 *
 * @param {() => Electron.BrowserWindow|null} getMainWindow
 * @param {{ isStaging: boolean }} opts
 */
function setupAutoUpdater(getMainWindow, { isStaging }) {
    _isStaging = isStaging;

    if (process.mas || isStaging) {
        return;
    }
    if (_setupDone) {
        return;
    }
    _setupDone = true;

    autoUpdater.logger = require('electron-log');
    autoUpdater.logger.transports.file.level = 'info';

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
        _pendingUpdateVersion = info.version;

        const mw = getMainWindow();

        if (mw && !mw.isDestroyed()) {
            showUpdateToast(mw.webContents, info.version, {
                title: t('updateToast.title'),
                message: t('updateToast.message', { version: info.version }),
                later: t('updateToast.later'),
                installNow: t('updateToast.installNow')
            });
        }
    });

    autoUpdater.on('error', err => {
        console.error('Updater Error:', err);
        capture('update_error', { error_message: err.message });
    });

    if (!isDev) {
        autoUpdater.checkForUpdates();
    }
}

/**
 * Triggers a manual update check and reports the result via in-app toast.
 *
 * @param {Electron.WebContents} webContents
 */
function checkForUpdatesManually(webContents) {
    const okLabel = t('infoToast.ok');

    if (process.mas || _isStaging) {
        showInfoToast(webContents, {
            title: t('update.stagingTitle'),
            message: t('update.stagingMessage'),
            okLabel
        });

        return;
    }

    showInfoToast(webContents, {
        title: t('update.checkingTitle'),
        message: t('update.checkingMessage'),
        okLabel
    });

    autoUpdater.checkForUpdates()
        .then(result => {
            if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
                showInfoToast(webContents, {
                    title: t('update.noUpdatesTitle'),
                    message: t('update.noUpdatesMessage', { version: app.getVersion() }),
                    okLabel
                });
            }
        })
        .catch(err => {
            console.error('Manual update check failed:', err);
            showInfoToast(webContents, {
                title: t('update.checkFailedTitle'),
                message: t('update.checkFailedMessage'),
                type: 'error',
                okLabel
            });
        });

    // Track the user action (click), not the outcome — result is tracked in .then()/.catch().
    capture('update_check_manual');
}

/**
 * Handles the user's response to the update toast.
 *
 * @param {string} action - 'install' or 'dismiss'
 */
function handleUpdateToastAction(action) {
    if (action === 'install') {
        capture('update_install_clicked', { new_version: _pendingUpdateVersion });
        autoUpdater.quitAndInstall(false, true);
    } else {
        capture('update_deferred', { new_version: _pendingUpdateVersion });
    }
}

module.exports = {
    setupAutoUpdater,
    checkForUpdatesManually,
    handleUpdateToastAction
};
