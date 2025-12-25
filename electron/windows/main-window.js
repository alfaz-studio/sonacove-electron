const { BrowserWindow, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const { isProd, currentConfig } = require('../config');

let mainWindow = null;

function createMainWindow(onClose) {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        title: "Sonacove Meet",
        autoHideMenuBar: true,
        icon: path.join(__dirname, '../../build/icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, '../../preload.js')
        },
        partition: 'persist:sonacove'
    });

    mainWindow.webContents.session.setProxy({ mode: 'direct' });

    mainWindow.setMenu(null);
    
    mainWindow.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
        if (!isProd) {
            console.log('Ignoring certificate error for:', url);
            event.preventDefault();
            callback(true);
        } else {
            callback(false);
        }
    });

    mainWindow.loadURL(currentConfig.landing);

    if (!isProd) mainWindow.webContents.openDevTools();

    mainWindow.webContents.on('will-prevent-unload', (event) => {
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Leave', 'Stay'],
            title: 'Leave Meeting?',
            message: 'You are currently in a meeting. Are you sure you want to quit?',
            defaultId: 0,
            cancelId: 1
        });

        const leave = (choice === 0);
        
        if (leave) {
            // User clicked 'Leave'. 
            event.preventDefault();
        }
    });

    // --- Permissions & Screen Share ---
    setupPermissions();
    setupNavigation(mainWindow);

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.setZoomFactor(1.0);
        mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (onClose) onClose();
    });

    return mainWindow;
}

function getMainWindow() {
    return mainWindow;
}

// --- Helper: Permissions ---
function setupPermissions() {
    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = ['media', 'display-capture', 'notifications'];
        callback(allowed.includes(permission));
    });

    mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] })
            .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
            .catch((err) => console.error(err));
    });
}

// --- Helper: Navigation Router ---
function setupNavigation(win) {
    const handleNav = (url, event) => {
        const parsedUrl = new URL(url);


        // Redirect to new Dashboard close page
        if (parsedUrl.pathname.includes('/static/close')) {
            if (event) event.preventDefault();

            const landingUrl = new URL(currentConfig.landing);
            
            // Remove trailing slash if present on landing pathname
            const basePath = landingUrl.pathname.endsWith('/') 
                ? landingUrl.pathname.slice(0, -1) 
                : landingUrl.pathname;
                
            const closePageUrl = `${landingUrl.origin}${basePath}/close`;

            console.log(`🔀 Hangup Detected. Redirecting to: ${closePageUrl}`);

            setImmediate(() => {
                win.loadURL(closePageUrl);
            });
            return 'redirected';
        }

        if (!isProd && parsedUrl.pathname.startsWith('/meet')) {
            if (parsedUrl.hostname !== new URL(currentConfig.meetRoot).hostname) {
                if (event) event.preventDefault();
                const newDest = `${currentConfig.meetRoot}${parsedUrl.pathname}${parsedUrl.search}`;
                setImmediate(() => win.loadURL(newDest));
                return 'redirected';
            }
        }

        if (currentConfig.allowedHosts.includes(parsedUrl.hostname)) {
            return 'allow';
        }

        if (event) event.preventDefault();
        shell.openExternal(url);
        return 'deny';
    };

    win.webContents.on('will-navigate', (event, url) => handleNav(url, event));
    win.webContents.setWindowOpenHandler(({ url }) => {
        const action = handleNav(url, null);
        if (action === 'redirected') return { action: 'deny' };
        if (action === 'allow') return { action: 'allow' };
        return { action: 'deny' };
    });
}

module.exports = { createMainWindow, getMainWindow };
