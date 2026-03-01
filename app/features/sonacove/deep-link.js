const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');

const sonacoveConfig = require('./config');
const { closeOverlay } = require('./overlay/overlay-window');

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
}

/**
 * Navigates the application based on the provided deep link.
 * Handles standard navigation (e.g. sonacove://meet/roomname).
 *
 * @param {string} deepLink - The deep link URL to process.
 * @returns {boolean} Success status.
 */
function navigateDeepLink(deepLink) {
    try {
        let rawPath = deepLink.replace('sonacove://', '');

        try {
            const appHost = new URL(sonacoveConfig.currentConfig.landing).host; // e.g. sonacove.com

            if (rawPath.startsWith(appHost)) {
                rawPath = rawPath.replace(appHost, '');
            }
        } catch (e) { /* ignore URL parsing error */ }

        if (rawPath.startsWith('/')) {
            rawPath = rawPath.substring(1);
        }
        if (rawPath.endsWith('/')) {
            rawPath = rawPath.slice(0, -1);
        }

        const meetRoot = sonacoveConfig.currentConfig.meetRoot;
        let targetUrl = '';

        if (rawPath.startsWith('meet/')) {
            const meetRootOrigin = new URL(meetRoot).origin; // https://sonacove.com

            targetUrl = `${meetRootOrigin}/${rawPath}`;
        } else if (rawPath && rawPath !== '') {
            // Ensure meetRoot doesn't have trailing slash for clean concatenation
            const cleanMeetRoot = meetRoot.endsWith('/') ? meetRoot.slice(0, -1) : meetRoot;

            targetUrl = `${cleanMeetRoot}/${rawPath}`;
        } else {
            targetUrl = sonacoveConfig.currentConfig.landing;
        }

        console.log(`🔗 Navigating Deep Link to: ${targetUrl}`);

        const win = getMainWindow();

        if (win) {
            // Check if user is currently in a meeting
            try {
                const currentUrl = new URL(win.webContents.getURL());

                if (currentUrl.pathname.startsWith('/meet')) {
                    const choice = dialog.showMessageBoxSync(win, {
                        type: 'question',
                        buttons: [ 'Leave Meeting', 'Stay' ],
                        title: 'Meeting in Progress',
                        message: 'You are already in a meeting. Do you want to leave and join a new one?',
                        defaultId: 1,
                        cancelId: 1
                    });

                    if (choice !== 0) {
                        return false;
                    }

                    closeOverlay(false, 'deep-link-navigation');
                }
            } catch (e) { /* ignore URL parse errors */ }

            win.loadURL(targetUrl);
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();

            return true;
        }

        return false;


    } catch (error) {
        console.error('Error parsing deep link:', error);

        return false;
    }
}

module.exports = {
    registerProtocol,
    processDeepLinkOnStartup,
    navigateDeepLink
};
