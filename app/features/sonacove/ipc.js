const { BrowserWindow, shell, ipcMain: ipc } = require('electron');

const sonacoveConfig = require('./config');
const { toggleOverlay, getOverlayWindow, closeViewersWhiteboards, getMainWindow } = require('./overlay-window');

/**
 * Registers all Sonacove-specific IPC listeners.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @returns {void}
 */
function setupSonacoveIPC(ipcMain) {
    const channels = [
        'toggle-annotation',
        'open-external',
        'show-overlay',
        'set-ignore-mouse-events',
        'screenshare-stop',
        'nav-to-home'
    ];

    channels.forEach(ch => ipcMain.removeAllListeners(ch));

    // Toggle Annotation Overlay
    ipcMain.on('toggle-annotation', (event, data, ...args) => {
        let config = data;

        // Support for Jitsi's standard signatures:
        // 1. send('toggle-annotation', enabled, roomUrl, collabDetails, serverUrl)
        // 2. send('toggle-annotation', { enabled, roomUrl, ... })
        if (typeof data === 'boolean') {
            config = {
                enabled: data,
                roomUrl: args[0],
                collabDetails: args[1],
                collabServerUrl: args[2]
            };
        } else if (typeof data === 'string') {
            config = {
                enabled: true,
                roomUrl: data,
                collabDetails: args[0],
                collabServerUrl: args[1]
            };
        }

        console.log('🖌️ IPC: toggle-annotation received.', config);
        
        // Find main window dynamically to handle refreshes
        const mw = getMainWindow();
        toggleOverlay(mw, config);
    });

    // Open External Links
    ipcMain.on('open-external', (event, url) => shell.openExternal(url));

    // Show Overlay
    ipcMain.on('show-overlay', () => {
        const overlay = getOverlayWindow();
        if (overlay) overlay.show();
    });

    // Click-through logic
    ipcMain.on('set-ignore-mouse-events', (event, ignore) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
    });

    // Screenshare Cleanup
    ipcMain.on('screenshare-stop', (event, data) => {
        closeViewersWhiteboards(data.sharerId);
    });

    // Navigation
    ipcMain.on('nav-to-home', () => {
        const mw = getMainWindow();
        if (mw) mw.loadURL(sonacoveConfig.currentConfig.landing);
    });
}

module.exports = { setupSonacoveIPC };
