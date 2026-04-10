/**
 * Application menu and About dialog.
 *
 * macOS: app-name menu with About, Check for Updates, and standard system
 *        actions (Services, Hide, Quit).
 * Windows: null — the native menu bar is hidden and the custom in-page title
 *          bar handles About / Check for Updates.
 */

const { Menu, app, shell } = require('electron');

const { t } = require('./i18n');
const { showAboutPanel } = require('./in-app-dialogs');

/**
 * Shows an in-app About panel with version and environment info.
 *
 * @param {Electron.BrowserWindow} mainWindow
 */
function showAboutDialog(mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    showAboutPanel(mainWindow.webContents, {
        appName: app.name,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        platform: `${process.platform} ${process.arch}`
    }, {
        version: t('aboutPanel.version', { version: app.getVersion() }),
        electron: t('aboutPanel.electron'),
        chrome: t('aboutPanel.chrome'),
        node: t('aboutPanel.node'),
        platform: t('aboutPanel.platform'),
        copyright: t('aboutPanel.copyright', { year: new Date().getFullYear() }),
        ok: t('aboutPanel.ok')
    });
}

/**
 * Sets the application menu.
 *
 * @param {{ showAboutDialog: Function, checkForUpdatesManually: Function }} handlers
 */
function setApplicationMenu({ showAboutDialog: aboutFn, checkForUpdatesManually }) {
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);

        return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { label: t('menu.about', { appName: app.name }), click: aboutFn },
                { type: 'separator' },
                { label: t('menu.checkForUpdates'), click: checkForUpdatesManually },
                { type: 'separator' },
                { role: 'services', submenu: [] },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideothers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: t('menu.edit'),
            submenu: [ {
                label: t('menu.undo'),
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            },
            {
                label: t('menu.redo'),
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            },
            {
                type: 'separator'
            },
            {
                label: t('menu.cut'),
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            },
            {
                label: t('menu.copy'),
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            },
            {
                label: t('menu.paste'),
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            },
            {
                label: t('menu.selectAll'),
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            } ]
        },
        {
            label: t('menu.window'),
            role: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        },
        {
            label: t('menu.help'),
            role: 'help',
            submenu: [
                {
                    label: t('menu.guides'),
                    click: async () => {
                        await shell.openExternal('https://docs.sonacove.com/');
                    }
                }
            ]
        }
    ]));
}

module.exports = { showAboutDialog, setApplicationMenu };
