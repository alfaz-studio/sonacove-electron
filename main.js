const { app, BrowserWindow, session, shell, desktopCapturer, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
require('dotenv').config();

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App starting...');

const isProd = (process.env.APP_ENV || 'production') === 'production';

const URLS = {
    production: {
        landing: 'https://sonacove.com/meet',
        allowedHosts: ['sonacove.com'] 
    },
    staging: {
        landing: 'https://dfd2a4f8-sonacove.catfurr.workers.dev/dashboard-demo',
        meetRoot: 'https://a6eb6923-sona-app.catfurr.workers.dev',
        allowedHosts: [
            'dfd2a4f8-sonacove.catfurr.workers.dev', 
            'a6eb6923-sona-app.catfurr.workers.dev',
            'staj.sonacove.com'
        ]
    }
};

const currentConfig = isProd ? URLS.production : URLS.staging;

console.log(`🚀 Launching in [${isProd ? 'PRODUCTION' : 'STAGING'}] mode.`);

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    app.whenReady().then(createWindow);
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        title: "Sonacove Meet",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        }
    });

    mainWindow.setMenu(null);

    const userAgent = mainWindow.webContents.getUserAgent();
    mainWindow.webContents.setUserAgent(userAgent.replace(/Electron\/\S*\s/, ''));

    mainWindow.loadURL(currentConfig.landing);

    // --- AUTO UPDATER LOGIC ---
    // Only run this in production builds (not when running 'npm start')
    if (app.isPackaged) {
        
        // 1. check for updates
        autoUpdater.checkForUpdatesAndNotify();

        // 2. Optional: Listen for events to show a popup
        autoUpdater.on('update-available', () => {
            log.info('Update available.');
        });

        autoUpdater.on('update-downloaded', () => {
            log.info('Update downloaded');
            // Optional: Ask user to restart now
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

    // --- NAVIGATION LOGIC ---
    const handleNavigation = (url, event) => {
        const parsedUrl = new URL(url);

        if (!isProd) {
            if (parsedUrl.pathname.startsWith('/meet')) {
                if (parsedUrl.hostname !== new URL(currentConfig.meetRoot).hostname) {
                    if (event) event.preventDefault();
                    const newDestination = `${currentConfig.meetRoot}${parsedUrl.pathname}${parsedUrl.search}`;
                    setImmediate(() => {
                        mainWindow.loadURL(newDestination);
                    });
                    return 'redirected';
                }
            }
        }

        if (currentConfig.allowedHosts.includes(parsedUrl.hostname)) {
            return 'allow';
        }

        if (event) event.preventDefault();
        shell.openExternal(url);
        return 'deny';
    };

    mainWindow.webContents.on('will-navigate', (event, url) => {
        handleNavigation(url, event);
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        const action = handleNavigation(url, null);
        if (action === 'redirected') return { action: 'deny' };
        if (action === 'allow') return { action: 'allow' };
        return { action: 'deny' }; 
    });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowedPermissions = ['media', 'display-capture', 'notifications'];
        if (allowedPermissions.includes(permission)) {
            callback(true);
        } else {
            callback(false);
        }
    });

    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
            callback({ video: sources[0], audio: 'loopback' });
        }).catch((err) => console.error(err));
    });

    if (!isProd) mainWindow.webContents.openDevTools();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
