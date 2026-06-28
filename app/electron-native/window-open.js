/*
 * Window-open routing for the main app window.
 *
 * Replaces @jitsi/electron-sdk's `popupsconfig` module. The SDK wrapped this in
 * a popup-config registry + match-pattern engine, but only ever registered two
 * static OAuth URL patterns — so this collapses the same behavior into a single
 * `setWindowOpenHandler`:
 *   - OAuth provider popups (Google, Dropbox) open in a secure Electron child
 *     window (no node integration), so sign-in flows work in-app.
 *   - URLs on allowed hosts open inside the app.
 *   - Everything else opens in the system browser.
 */

// OAuth authorize endpoints that must open in an Electron window rather than the
// system browser. Ported verbatim from the SDK's popupConfigs match patterns.
const OAUTH_POPUP_PATTERNS = [
    /^https:\/\/(www\.)?accounts\.google\.com\//,
    /^https:\/\/(www\.)?dropbox\.com\/oauth2\/authorize/
];

/**
 * Installs the window-open handler on the given window's webContents.
 *
 * @param {BrowserWindow} mainWindow - The window hosting the meet app.
 * @param {Object} options - Handler dependencies.
 * @param {Function} options.getAllowedHosts - Returns the current array of
 * hostnames allowed to open inside the app. Read on every call so config
 * changes (e.g. staging switch) take effect without re-installing the handler.
 * @param {Function} options.openExternalLink - Opens a URL in the system browser.
 * @returns {void}
 */
function setupWindowOpenHandler(mainWindow, { getAllowedHosts, openExternalLink }) {
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        // OAuth popups open in a secure Electron child window.
        if (OAUTH_POPUP_PATTERNS.some(pattern => pattern.test(url))) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    webPreferences: { nodeIntegration: false }
                }
            };
        }

        // Allowed hosts open inside the app instead of the browser.
        const allowedHosts = getAllowedHosts() || [];

        try {
            const { hostname } = new URL(url);

            if (allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`))) {
                // Open in-app, but as an isolated child window: drop the parent's
                // preload (no window.sonacoveElectronAPI / IPC bridge) and node
                // integration, so an allowed-host page can't reach privileged APIs.
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: {
                        webPreferences: {
                            preload: '',
                            nodeIntegration: false
                        }
                    }
                };
            }
        } catch (e) {
            // Ignore URL parse errors and fall through to the browser.
        }

        // Everything else opens in the system browser.
        openExternalLink(url);

        return { action: 'deny' };
    });
}

module.exports = { setupWindowOpenHandler };
