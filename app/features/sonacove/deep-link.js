const { app, BrowserWindow } = require('electron');
const path = require('path');

let macDeepLinkUrl = null;

/**
 * Finds the main visible application window to receive deep link events.
 *
 * @returns {BrowserWindow|undefined} The main visible window.
 */
function getMainWindow() {
    const windows = BrowserWindow.getAllWindows();

    return windows.find(w => !w.isDestroyed() && w.isVisible());
}

/**
 * Registers the custom protocol scheme for the application.
 *
 * @returns {void}
 */
function registerProtocol() {
    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient('sonacove', process.execPath, [ path.resolve(process.argv[1]) ]);
        }
    } else {
        app.setAsDefaultProtocolClient('sonacove');
    }
}

/**
 * Sets up the listener for the macOS open-url event.
 *
 * @returns {void}
 */
function setupMacDeepLinkListener() {
    app.on('open-url', (event, url) => {
        event.preventDefault();
        console.log('🍎 Mac Open URL Event:', url);
        macDeepLinkUrl = url;
        const win = getMainWindow();

        if (win) {
            navigateDeepLink(url);
        }
    });
}

/**
 * Processes any deep link arguments provided during application startup.
 *
 * @returns {void}
 */
function processDeepLinkOnStartup() {
    if (process.platform === 'win32' || process.platform === 'linux') {
        const url = process.argv.find(arg => arg.startsWith('sonacove://'));

        if (url) {
            console.log('🪟 Windows/Linux Startup URL:', url);
            setTimeout(() => navigateDeepLink(url), 1000);
        }
    }
    if (macDeepLinkUrl) {
        setTimeout(() => navigateDeepLink(macDeepLinkUrl), 1000);
        macDeepLinkUrl = null;
    }
}

/**
 * Navigates the application based on the provided deep link.
 * Handles auth callbacks, logout, and standard navigation.
 *
 * @param {string} deepLink - The deep link URL to process.
 * @returns {void}
 */
function navigateDeepLink(deepLink) {
    // 1. Handle Auth Callback
    if (deepLink.includes('auth-callback')) {
        handleAuthCallback(deepLink);

        return;
    }

    // 2. Handle Logout
    if (deepLink.includes('logout-callback')) {
        const win = getMainWindow();

        if (win) {
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();
            setTimeout(() => {
                win.webContents.send('auth-logout-complete');
            }, 500);
        } else {
            console.error('❌ Could not find Main Window to send logout');
        }

        return;
    }

    // 3. Handle Standard Navigation
    try {
        let rawPath = deepLink.replace('sonacove://', '');

        if (rawPath.startsWith('/')) {
            rawPath = rawPath.substring(1);
        }
        if (rawPath.endsWith('/')) {
            rawPath = rawPath.slice(0, -1);
        }

        const targetUrl = `https://${rawPath}`;

        console.log('🔗 Navigating to:', targetUrl);

        const win = getMainWindow();

        if (win) {
            win.loadURL(targetUrl);
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();
        }
    } catch (error) {
        console.error('❌ Error parsing deep link:', error);
    }
}

/**
 * Handles the authentication callback from the deep link.
 * Extracts user data and sends it to the renderer process.
 *
 * @param {string} deepLink - The auth callback URL.
 * @returns {void}
 */
function handleAuthCallback(deepLink) {
    try {
        // Hack to use URL parser with non-standard protocol
        const urlStr = deepLink.replace('sonacove://', 'https://');
        const urlObj = new URL(urlStr);
        const payload = urlObj.searchParams.get('payload');

        if (payload) {
            const user = JSON.parse(decodeURIComponent(payload));
            const win = getMainWindow();

            if (win) {
                console.log('✅ Main Window found. Sending \'auth-token-received\'...');

                // Focus first to ensure execution priority
                if (win.isMinimized()) {
                    win.restore();
                }
                win.focus();
                console.log('auth token rec');

                // Send the data
                win.webContents.send('auth-token-received', user);
                console.log('📤 IPC message sent.');
            } else {
                console.error('❌ FATAL: Auth callback received, but Main Window not found.');
            }
        } else {
            console.error('❌ Auth callback URL missing payload param.');
        }
    } catch (e) {
        console.error('❌ Auth Parsing Error', e);
    }
}

module.exports = {
    registerProtocol,
    setupMacDeepLinkListener,
    processDeepLinkOnStartup,
    navigateDeepLink
};
