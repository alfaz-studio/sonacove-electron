const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('original-fs');
const path = require('path');

const { CACHE_DIR } = require('./lib/config');
const { registerIpcHandlers } = require('./lib/ipc');
const { setupAutoUpdater } = require('./lib/updater');

let mainWindow = null;
const getMainWindow = () => mainWindow;

// ── Window ──────────────────────────────────────────────────────────────────

function getIconPath() {
    const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';

    // Staging-launcher's own color-shifted icon
    const launcherIcon = path.join(__dirname, 'resources', iconFile);

    if (fs.existsSync(launcherIcon)) {
        return launcherIcon;
    }

    // Fallback to the main app's icon
    const repoIcon = path.join(__dirname, '..', 'resources', iconFile);

    if (fs.existsSync(repoIcon)) {
        return repoIcon;
    }

    // Packaged launcher: icon is bundled by electron-builder
    return undefined;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 960,
        height: 700,
        minWidth: 700,
        minHeight: 500,
        title: 'Sonacove Staging Launcher',
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

registerIpcHandlers({ getMainWindow });

// Enforce single instance — focus existing window instead of opening a second
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        createWindow();
        setupAutoUpdater({ autoUpdater, ipcMain, app, getMainWindow, dialog });
    });
}

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
