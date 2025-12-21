const { app } = require('electron');
const log = require('electron-log');

const { isProd } = require('./electron/config');
const { initUpdater } = require('./electron/utils/updater');
const { setupIpcHandlers } = require('./electron/utils/ipc');
const { 
    registerProtocol, 
    setupMacDeepLinkListener, 
    processDeepLinkOnStartup, 
    navigateDeepLink 
} = require('./electron/utils/deep-link');

const { createMainWindow, getMainWindow } = require('./electron/windows/main-window');
const { closeOverlay } = require('./electron/windows/overlay-window');

log.info('App starting...');

// --- GLOBAL SETTINGS ---
if (!isProd) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
    app.commandLine.appendSwitch('allow-insecure-localhost');
    app.commandLine.appendSwitch('no-proxy-server'); 
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// --- SETUP DEEP LINKING ---
registerProtocol();
setupMacDeepLinkListener();

// --- SINGLE INSTANCE LOCK ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    // Handle Second Instance (Deep Link while app is running)
    app.on('second-instance', (event, commandLine) => {
        const win = getMainWindow();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
            
            // Extract URL from args (Windows/Linux)
            const url = commandLine.find(arg => arg.startsWith('sonacove://'));
            if (url) {
                navigateDeepLink(url);
            }
        }
    });

    app.whenReady().then(startApp);
}

// --- APP STARTUP ---
function startApp() {
    createMainWindow(() => {
        // When main window closes, ensure overlay closes too
        closeOverlay();
    });
    
    setupIpcHandlers();
    initUpdater();
    processDeepLinkOnStartup();
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
