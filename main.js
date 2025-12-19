const { app, ipcMain, BrowserWindow } = require('electron');
const log = require('electron-log');
const path = require('path')

const { isProd } = require('./electron/config');
const { initUpdater } = require('./electron/utils/updater');
const { createMainWindow, getMainWindow } = require('./electron/windows/main-window');
const { toggleOverlay, closeOverlay } = require('./electron/windows/overlay-window');

log.info('App starting...');

if (!isProd) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
    app.commandLine.appendSwitch('allow-insecure-localhost');
    app.commandLine.appendSwitch('no-proxy-server'); 
}

if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('sonacove', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('sonacove');
}

// --- SINGLE INSTANCE LOCK ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        const win = getMainWindow();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
            
            const url = commandLine.find(arg => arg.startsWith('sonacove://'));
            if (url) {
                handleDeepLink(url);
            }
        }
    });

    // MACOS: Handle URL opening
    app.on('open-url', (event, url) => {
        event.preventDefault();
        const win = getMainWindow();
        if (win) {
            handleDeepLink(url);
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
    
    initUpdater();
}

// --- IPC LISTENERS ---

// Toggle Annotation Overlay
ipcMain.on('toggle-annotation', (event, data) => {
    const win = getMainWindow();
    if (win) {
        toggleOverlay(win, data);
    }
});

// Click-Through Logic (Desktop Control)
ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        win.setIgnoreMouseEvents(ignore, { forward: true });
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

function handleDeepLink(deepLink) {
    console.log("🔗 Received Deep Link:", deepLink);

    // 1. Remove the custom scheme (sonacove://)
    let rawPath = deepLink.replace('sonacove://', '');
    
    // 2. Remove trailing slashes from protocol if any (e.g. sonacove:///)
    if (rawPath.startsWith('/')) rawPath = rawPath.substring(1);

    // 3. Construct the clean HTTPS URL
    // NOTE: Ensure this logic matches your domain structure. 
    // If deepLink is "sonacove://sonacove.com/meet/Room1", rawPath is "sonacove.com/meet/Room1"
    const targetUrl = `https://${rawPath}`;

    const win = getMainWindow();
    if (win) {
        win.loadURL(targetUrl);
    }
}