const { app, BrowserWindow, session, shell } = require('electron');
require('dotenv').config();

const isProd = process.env.APP_ENV === 'production';

const appUrl = isProd 
    ? 'https://sonacove.com/meet' 
    : 'https://sonacove.catfurr.workers.dev/meet';

console.log(`🚀 Launching in [${isProd ? 'PRODUCTION' : 'STAGING'}] mode.`);
console.log(`🔗 Loading: ${appUrl}`);

// if (!isProduction) {
//     app.commandLine.appendSwitch('ignore-certificate-errors');
// }

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 720,
        title: "Sonacove Meet",
        autoHideMenuBar: true, 
        webPreferences: {
            nodeIntegration: false, 
            contextIsolation: true,
        }
    });

    win.setMenu(null); 

    win.loadURL(appUrl);

    win.webContents.setWindowOpenHandler(({ url }) => {
        // Allow navigation only if it's within Sonacove
        if (url.startsWith(appUrl)) {
            return { action: 'allow' };
        }
        // Open everything else in the default browser
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // 4. HANDLE PERMISSIONS (Camera / Mic)
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowedPermissions = [
            'media',             // Camera/Mic
            'display-capture',   // Screen Sharing
            'notifications'
        ];

        if (allowedPermissions.includes(permission)) {
            callback(true);
        } else {
            console.log(`Denied permission request: ${permission}`);
            callback(false);
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
