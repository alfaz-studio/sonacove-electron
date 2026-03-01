const path = require('path');
const nodeURL = require('url');

/**
 * Configures all session-level security handlers on the given window:
 *
 * - `onBeforeSendHeaders`: blocks file:// requests outside the app base path
 *   and injects a CORS `Origin` header when Electron omits it.
 * - `onHeadersReceived`: strips `x-frame-options` and `frame-ancestors` CSP
 *   directives so that the app can load inside an iframe.
 * - `will-redirect`: only allows http(s)/ws(s) redirect protocols.
 * - `setPermissionRequestHandler`: blocks `openExternal` permission requests.
 *
 * @param {BrowserWindow} win - The main application window.
 * @param {string} basePath - The root directory of the application.
 * @returns {void}
 */
function setupSecurity(win, basePath) {
    // ── Block file:// URLs outside app + inject CORS Origin ─────────────────
    win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        // Block file:// URLs outside the app base path
        if (details.url.startsWith('file://')) {
            const requestedPath = path.resolve(nodeURL.fileURLToPath(details.url));
            const appBasePath = path.resolve(basePath);

            if (!requestedPath.startsWith(appBasePath)) {
                callback({ cancel: true });
                console.warn(`Rejected file URL: ${details.url}`);

                return;
            }
        }

        // Electron with webSecurity:false suppresses the Origin header on cross-origin
        // requests. Without Origin, the server's CORS middleware returns '*' and
        // better-auth's trustedOrigins/CSRF check fails, returning null sessions.
        // Inject the correct Origin header so the server treats us like a normal browser.
        //
        // IMPORTANT: We must use the *initiating frame's* origin, not the main page's
        // origin. Third-party iframes (e.g. YouTube embeds) make same-origin requests
        // to their own backend. Injecting the main page's origin on those requests
        // causes 403 Forbidden errors.
        if (!details.requestHeaders.Origin && !details.url.startsWith('file://')) {
            try {
                const reqUrl = new URL(details.url);

                // Determine the origin of the frame that initiated this request.
                // details.frame (WebFrameMain) is available in Electron 40+.
                let frameOrigin = null;

                if (details.frame && details.frame.url) {
                    frameOrigin = new URL(details.frame.url).origin;
                } else {
                    // Fallback: use the main page origin
                    const pageUrl = win.webContents.getURL();

                    frameOrigin = pageUrl ? new URL(pageUrl).origin : null;
                }

                // Only inject Origin when the request is cross-origin relative to the
                // initiating frame. Same-origin requests (e.g. YouTube iframe → youtube.com)
                // don't need an Origin header.
                if (frameOrigin && reqUrl.origin !== frameOrigin) {
                    details.requestHeaders.Origin = frameOrigin;
                }
            } catch (e) {
                // ignore
            }
        }

        callback({ cancel: false,
            requestHeaders: details.requestHeaders });
    });

    // ── Strip x-frame-options / frame-ancestors CSP ─────────────────────────
    // Resolves https://github.com/jitsi/jitsi-meet-electron/issues/285
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        delete details.responseHeaders['x-frame-options'];

        if (details.responseHeaders['content-security-policy']) {
            const cspFiltered = details.responseHeaders['content-security-policy'][0]
                .split(';')
                .filter(x => x.indexOf('frame-ancestors') === -1)
                .join(';');

            details.responseHeaders['content-security-policy'] = [ cspFiltered ];
        }

        if (details.responseHeaders['Content-Security-Policy']) {
            const cspFiltered = details.responseHeaders['Content-Security-Policy'][0]
                .split(';')
                .filter(x => x.indexOf('frame-ancestors') === -1)
                .join(';');

            details.responseHeaders['Content-Security-Policy'] = [ cspFiltered ];
        }

        callback({
            responseHeaders: details.responseHeaders
        });
    });

    // ── Block redirects to non-standard protocols ───────────────────────────
    const allowedRedirects = [
        'http:',
        'https:',
        'ws:',
        'wss:'
    ];

    win.webContents.addListener('will-redirect', (ev, url) => {
        const requestedUrl = new URL(url);

        if (!allowedRedirects.includes(requestedUrl.protocol)) {
            console.warn(`Disallowing redirect to ${url}`);
            ev.preventDefault();
        }
    });

    // ── Block opening external applications ─────────────────────────────────
    win.webContents.session.setPermissionRequestHandler((_, permission, callback, details) => {
        if (permission === 'openExternal') {
            console.warn(`Disallowing opening ${details.externalURL}`);
            callback(false);

            return;
        }

        callback(true);
    });
}

module.exports = { setupSecurity };
