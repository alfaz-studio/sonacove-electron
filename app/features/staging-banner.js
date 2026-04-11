/**
 * Staging banner — injects a visible "STAGING BUILD" badge so testers
 * know they're on a PR build.
 */

const { app } = require('electron');

const { t } = require('./i18n');

const STAGING_BANNER_CSS = `
    #sonacove-staging-banner {
        position: fixed;
        bottom: 8px; right: 8px;
        padding: 2px 8px;
        background: rgba(217, 119, 6, 0.7);
        color: #000;
        border-radius: 4px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 10px;
        font-weight: 600;
        z-index: 2147483647;
        user-select: none;
        pointer-events: none;
        opacity: 0.8;
    }
`;

/**
 * Injects the staging banner into the given webContents.
 *
 * @param {Electron.WebContents} webContents
 */
function injectStagingBanner(webContents) {
    const bannerText = t('staging.banner', { version: app.getVersion() });

    // Inject both CSS and DOM in a single executeJavaScript call with an
    // idempotency guard, avoiding insertCSS which accumulates on every navigation.
    webContents.executeJavaScript(`
        (function() {
            if (document.getElementById('sonacove-staging-banner')) return;
            var sid = 'sonacove-staging-banner-styles';
            if (!document.getElementById(sid)) {
                var s = document.createElement('style');
                s.id = sid;
                s.textContent = ${JSON.stringify(STAGING_BANNER_CSS)};
                document.head.appendChild(s);
            }
            var banner = document.createElement('div');
            banner.id = 'sonacove-staging-banner';
            banner.textContent = ${JSON.stringify(bannerText)};
            document.body.appendChild(banner);
        })();
    `).catch(() => {});
}

module.exports = { injectStagingBanner };
