const { app, BrowserWindow } = require('electron');
const path = require('path');

const sonacoveConfig = require('./config');

let macDeepLinkUrl = null;
let pendingStartupDeepLink = null;

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
            pendingStartupDeepLink = url;
        }
    }
    if (macDeepLinkUrl) {
        pendingStartupDeepLink = macDeepLinkUrl;
        macDeepLinkUrl = null;
    }
}

/**
 * Handles the authentication callback from the deep link.
 * Extracts user data and sends it to the renderer process via IPC.
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
                console.log('🔐 deep-link.js: Sending auth-token-received event with user:', user?.email);
                
                // Send the IPC event to the renderer process
                win.webContents.send('auth-token-received', user);
                
                // Wait a moment for the IPC to be processed and localStorage updated, then reload
                setTimeout(() => {
                    console.log('🔄 deep-link.js: Reloading page to apply auth token');
                    if (!win.isDestroyed()) {
                        win.webContents.reload();
                    }
                }, 500);
                
                // Focus the window
                if (win.isMinimized()) {
                    win.restore();
                }
                win.focus();
            } else {
                console.error('❌ deep-link.js: No main window found to send auth token');
            }
        } else {
            console.warn('⚠️ deep-link.js: No payload found in auth callback');
        }
    } catch (e) {
        console.error('❌ Auth Parsing Error:', e);
    }
}

/**
 * Navigates the application based on the provided deep link.
 * Handles auth callbacks, logout, and standard navigation.
 *
 * @param {string} deepLink - The deep link URL to process.
 * @returns {boolean} Success status.
 */
function navigateDeepLink(deepLink) {
    console.log('🔗 navigateDeepLink called with:', deepLink);

    // CRITICAL: Check for auth-callback FIRST with specific pattern
    // Must check for 'auth-callback' but NOT 'logout-callback'
    if (deepLink.includes('auth-callback') && !deepLink.includes('logout')) {
        console.log('🔐 Detected auth-callback');
        handleAuthCallback(deepLink);
        return true;
    }

    // 2. Handle Logout (must be checked AFTER auth-callback)
    if (deepLink.includes('logout-callback')) {
        console.log('🚪 Detected logout-callback');
        const win = getMainWindow();

        if (win) {
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();
            setTimeout(() => {
                console.log('📤 Sending auth-logout-complete event');
                if (!win.isDestroyed()) {
                    win.webContents.send('auth-logout-complete');
                }
            }, 500);
        }

        return true;
    }

    // 3. Handle Standard Navigation
    try {
        let rawPath = deepLink.replace('sonacove://', '');

        try {
            const appHost = new URL(sonacoveConfig.currentConfig.landing).host; // e.g. sonacove.com
            if (rawPath.startsWith(appHost)) {
                rawPath = rawPath.replace(appHost, '');
            }
        } catch (e) { /* ignore URL parsing error */ }

        if (rawPath.startsWith('/')) rawPath = rawPath.substring(1);
        if (rawPath.endsWith('/')) rawPath = rawPath.slice(0, -1);

        const meetRoot = sonacoveConfig.currentConfig.meetRoot;
        let targetUrl = '';

        if (rawPath.startsWith('meet/')) {
            const meetRootOrigin = new URL(meetRoot).origin; // https://sonacove.com
            targetUrl = `${meetRootOrigin}/${rawPath}`;
        }
        else if (rawPath && rawPath !== '') {
            // Ensure meetRoot doesn't have trailing slash for clean concatenation
            const cleanMeetRoot = meetRoot.endsWith('/') ? meetRoot.slice(0, -1) : meetRoot;
            targetUrl = `${cleanMeetRoot}/${rawPath}`;
        }
        // Case C: Empty path
        else {
            targetUrl = sonacoveConfig.currentConfig.landing;
        }

        console.log(`🔗 Navigating Deep Link to: ${targetUrl}`);

        const win = getMainWindow();

        if (win) {
            win.loadURL(targetUrl);
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();

            return true;
        }

        return false;


    } catch (error) {
        console.error('❌ Error parsing deep link:', error);

        return false;
    }
}

module.exports = {
    registerProtocol,
    setupMacDeepLinkListener,
    processDeepLinkOnStartup,
    navigateDeepLink
};
