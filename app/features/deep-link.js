const { app, ipcMain } = require('electron');
const path = require('path');

const config = require('./config');
const { getMainWindow } = require('./overlay/helpers');
const { closeOverlay } = require('./overlay/overlay-window');
const { showDeeplinkModal } = require('./in-app-dialogs');
const { t } = require('./i18n');

/**
 * Registers the custom protocol scheme for the application.
 *
 * @returns {void}
 */
function registerProtocol() {
    const protocol = config.appProtocolPrefix;

    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient(protocol, process.execPath, [ path.resolve(process.argv[1]) ]);
        }
    } else {
        app.setAsDefaultProtocolClient(protocol);
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
        let rawPath = deepLink.replace(`${config.appProtocolPrefix}://`, '');

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
                    // Remove any stale listener from a previous deep link
                    ipcMain.removeAllListeners('deeplink-modal-action');

                    showDeeplinkModal(win.webContents, {
                        title: t('deeplinkModal.title'),
                        message: t('deeplinkModal.message'),
                        confirm: t('deeplinkModal.confirm'),
                        cancel: t('deeplinkModal.cancel')
                    });

                    const TIMEOUT_MS = 60000;
                    const action = await new Promise(resolve => {
                        const timer = setTimeout(() => {
                            ipcMain.removeAllListeners('deeplink-modal-action');
                            resolve('cancel');
                        }, TIMEOUT_MS);

                        ipcMain.once('deeplink-modal-action', (_event, data) => {
                            clearTimeout(timer);
                            resolve(data?.action);
                        });
                    });

                    if (action !== 'confirm') {
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
