/* global setImmediate */

const { getPopupTarget } = require('@jitsi/electron-sdk');

const sonacoveConfig = require('../sonacove/config');
const { openExternalLink } = require('../utils/openExternalLink');

/**
 * Creates a window-open handler that routes popups to the browser or allows
 * them in Electron based on allowed hosts and the SDK's popup target logic.
 *
 * @returns {Function} A handler suitable for `webContents.setWindowOpenHandler`.
 */
function createWindowOpenHandler() {
    return ({ url, frameName }) => {
        const target = getPopupTarget(url, frameName);

        // Allow URLs on allowed hosts to open inside Electron instead of the browser
        const allowedHosts = sonacoveConfig.currentConfig.allowedHosts || [];

        try {
            const parsedUrl = new URL(url);

            if (allowedHosts.some(host => parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`))) {
                return { action: 'allow' };
            }
        } catch (e) {
            // ignore parse errors
        }

        if (!target || target === 'browser') {
            openExternalLink(url);

            return { action: 'deny' };
        }

        if (target === 'electron') {
            return { action: 'allow' };
        }

        return { action: 'deny' };
    };
}

/**
 * Registers the `will-navigate` handler on the given window to route
 * hangup redirects (to `/static/close`) and meeting navigations (to `/meet`)
 * to the correct URLs.
 *
 * @param {BrowserWindow} win - The main application window.
 * @returns {void}
 */
function setupNavigation(win) {
    win.webContents.on('will-navigate', (event, url) => {
        const parsedUrl = new URL(url);

        if (parsedUrl.pathname.includes('/static/close')) {
            if (event) {
                event.preventDefault();
            }
            const landingUrl = new URL(sonacoveConfig.currentConfig.landing);

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

        if (parsedUrl.pathname.startsWith('/meet')) {
            const meetRootUrl = new URL(sonacoveConfig.currentConfig.meetRoot);

            if (parsedUrl.hostname !== meetRootUrl.hostname) {
                event.preventDefault();

                const targetUrl = `${sonacoveConfig.currentConfig.meetRoot}${parsedUrl.pathname}${parsedUrl.search}`;

                setImmediate(() => {
                    win.loadURL(targetUrl);
                });
            }
        }
    });
}

module.exports = {
    createWindowOpenHandler,
    setupNavigation
};
