const { app } = require('electron');
const path = require('path');
const { getMainWindow } = require('../windows/main-window');

let macDeepLinkUrl = null;

function registerProtocol() {
    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient('sonacove', process.execPath, [path.resolve(process.argv[1])]);
        }
    } else {
        app.setAsDefaultProtocolClient('sonacove');
    }
}

function setupMacDeepLinkListener() {
    // macOS: Handle URL opening (Cold & Warm starts)
    app.on('open-url', (event, url) => {
        event.preventDefault();
        macDeepLinkUrl = url; // Cache for cold start
        const win = getMainWindow();
        if (win) {
            navigateDeepLink(url);
        }
    });
}

function processDeepLinkOnStartup() {
    // 1. WINDOWS / LINUX COLD START
    if (process.platform === 'win32' || process.platform === 'linux') {
        const url = process.argv.find(arg => arg.startsWith('sonacove://'));
        if (url) {
            setTimeout(() => navigateDeepLink(url), 1000);
        }
    }
    
    // 2. MACOS COLD START
    if (macDeepLinkUrl) {
        setTimeout(() => navigateDeepLink(macDeepLinkUrl), 1000);
        macDeepLinkUrl = null;
    }
}

function navigateDeepLink(deepLink) {
    console.log("🔗 Received Deep Link:", deepLink);

    try {
        let rawPath = deepLink.replace('sonacove://', '');
        
        if (rawPath.startsWith('/')) rawPath = rawPath.substring(1);
        if (rawPath.endsWith('/')) rawPath = rawPath.slice(0, -1);

        const targetUrl = `https://${rawPath}`;
        console.log("🔗 Navigating to:", targetUrl);

        const win = getMainWindow();
        if (win) {
            win.loadURL(targetUrl);
            if (win.isMinimized()) win.restore();
            win.focus();
        } else {
            console.error("❌ Main window not found for deep link");
        }
    } catch (error) {
        console.error("❌ Error parsing deep link:", error);
    }
}

module.exports = {
    registerProtocol,
    setupMacDeepLinkListener,
    processDeepLinkOnStartup,
    navigateDeepLink
};
