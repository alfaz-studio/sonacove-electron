const { app, dialog } = require('electron');
const path = require('path');

const config = require('./config');
const { getMainWindow } = require('./overlay/helpers');
const { closeOverlay } = require('./overlay/overlay-window');

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
 * Navigates the application based on the provided deep link.
 * Handles standard navigation (e.g. sonacove://meet/roomname).
 *
 * @param {string} deepLink - The deep link URL to process.
 * @returns {boolean} Success status.
 */
async function navigateDeepLink(deepLink) {
    try {
        let rawPath = deepLink.replace('sonacove://', '');

        try {
            const appHost = new URL(config.currentConfig.landing).host; // e.g. sonacove.com
            const meetHost = new URL(config.currentConfig.meetRoot).host;

            if (rawPath.startsWith(appHost)) {
                rawPath = rawPath.replace(appHost, '');
            } else if (meetHost !== appHost && rawPath.startsWith(meetHost)) {
                rawPath = rawPath.replace(meetHost, '');
            }
        } catch (e) { /* ignore URL parsing error */ }

        if (rawPath.startsWith('/')) {
            rawPath = rawPath.substring(1);
        }
        if (rawPath.endsWith('/')) {
            rawPath = rawPath.slice(0, -1);
        }

        const meetRoot = config.currentConfig.meetRoot;
        let targetUrl = '';

        if (rawPath.startsWith('meet/')) {
            const meetRootOrigin = new URL(meetRoot).origin; // https://sonacove.com

            targetUrl = `${meetRootOrigin}/${rawPath}`;
        } else if (rawPath && rawPath !== '') {
            // Ensure meetRoot doesn't have trailing slash for clean concatenation
            const cleanMeetRoot = meetRoot.endsWith('/') ? meetRoot.slice(0, -1) : meetRoot;

            targetUrl = `${cleanMeetRoot}/${rawPath}`;
        } else {
            targetUrl = config.currentConfig.landing;
        }

        console.log(`🔗 Navigating Deep Link to: ${targetUrl}`);

        const win = getMainWindow();

        if (win) {
            // Check if user is currently in a meeting
            try {
                const currentUrl = new URL(win.webContents.getURL());

                if (currentUrl.pathname.startsWith('/meet')) {
                    const { response } = await dialog.showMessageBox(win, {
                        type: 'question',
                        buttons: [ 'Leave Meeting', 'Stay' ],
                        title: 'Meeting in Progress',
                        message: 'You are already in a meeting. Do you want to leave and join a new one?',
                        defaultId: 1,
                        cancelId: 1
                    });

                    if (response !== 0) {
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
    navigateDeepLink
};
