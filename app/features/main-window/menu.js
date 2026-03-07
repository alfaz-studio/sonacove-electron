/* global process */

const { Menu, app, shell } = require('electron');

/**
 * Sets the application menu.
 *
 * MacOS: app-name menu with About, Check for Updates, Edit, Window, Help.
 * Windows: null — the native menu bar is hidden (titleBarStyle:'hidden') and
 *          the custom in-page title bar handles About / Check for Updates.
 *
 * @param {Object} callbacks - Menu action callbacks.
 * @param {Function} callbacks.onAbout - Handler for the About menu item.
 * @param {Function} callbacks.onCheckUpdates - Handler for Check for Updates.
 * @returns {void}
 */
function setApplicationMenu({ onAbout, onCheckUpdates }) {
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);

        return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                {
                    label: `About ${app.name}`,
                    click: onAbout
                },
                { type: 'separator' },
                {
                    label: 'Check for Updates…',
                    click: onCheckUpdates
                },
                { type: 'separator' },
                {
                    role: 'services',
                    submenu: []
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideothers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [ {
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            },
            {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            },
            {
                type: 'separator'
            },
            {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            },
            {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            },
            {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            },
            {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            } ]
        },
        {
            label: '&Window',
            role: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        },
        {
            label: '&Help',
            role: 'help',
            submenu: [
                {
                    label: 'Guides',
                    click: async () => {
                        await shell.openExternal('https://docs.sonacove.com/');
                    }
                }
            ]
        }
    ]));
}

module.exports = { setApplicationMenu };
