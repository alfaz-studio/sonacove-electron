const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

function initUpdater() {
    if (!app.isPackaged) return;

    autoUpdater.logger = log;
    autoUpdater.logger.transports.file.level = 'info';
    
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', () => {
        log.info('Update available.');
    });

    autoUpdater.on('update-downloaded', () => {
        log.info('Update downloaded');
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: 'A new version of Sonacove Meet has been downloaded. Quit and install now?',
            buttons: ['Yes', 'Later']
        }).then((result) => {
            if (result.response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });
}

module.exports = { initUpdater };
