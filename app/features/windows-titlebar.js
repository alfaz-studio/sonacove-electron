/**
 * Windows custom in-page titlebar.
 *
 * Because we use titleBarStyle:'hidden' on Windows, the native menu bar is
 * gone. This module injects a slim custom title bar into each loaded page so
 * the user still has About / Check for Updates without pressing Alt.
 */

const { app } = require('electron');
const fs = require('fs');

const { t } = require('./i18n');
const { getIconPath } = require('./paths');

const TITLEBAR_CSS = ''
    + '#sonacove-titlebar{position:fixed;top:0;left:0;right:0;height:32px;background:#1a1a2e;'
    + '-webkit-app-region:drag;display:flex;align-items:center;padding:0 12px;z-index:2147483647;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;'
    + 'color:#c0c0c0;user-select:none;box-sizing:border-box;}'
    + '#sonacove-titlebar .stb-icon{width:20px;height:20px;margin-right:8px;background-size:contain;'
    + 'background-repeat:no-repeat;background-position:center;}'
    + '#sonacove-titlebar .stb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '#sonacove-titlebar .stb-version{color:#666680;font-size:11px;margin-left:8px;}'
    + '#sonacove-titlebar .stb-spacer{flex:1;}'
    + '#sonacove-titlebar .stb-menu{display:flex;gap:2px;-webkit-app-region:no-drag;margin-right:140px;}'
    + '#sonacove-titlebar .stb-btn{background:transparent;border:none;color:#a0a0a0;cursor:pointer;'
    + 'padding:4px 10px;border-radius:4px;font-size:12px;font-family:inherit;line-height:1;'
    + 'transition:background 0.15s ease,color 0.15s ease;}'
    + '#sonacove-titlebar .stb-btn:hover{background:rgba(255,255,255,0.1);color:#fff;}'
    + '#sonacove-titlebar .stb-btn:active{background:rgba(255,255,255,0.18);color:#fff;}'
    + 'html{box-sizing:border-box!important;padding-top:32px!important;}';

const getTitlebarJS = (iconBase64 = '', strings = {}, appVersion = '') => `
(function() {
    var strings = ${JSON.stringify(strings)};

    // Inject styles idempotently to prevent flash on re-navigation.
    var sid = 'sonacove-titlebar-styles';
    if (!document.getElementById(sid)) {
        var s = document.createElement('style');
        s.id = sid;
        s.textContent = ${JSON.stringify(TITLEBAR_CSS)};
        document.head.appendChild(s);
    }

    // Guard against duplicate injection.
    if (document.getElementById('sonacove-titlebar')) return;

    var bar = document.createElement('div');
    bar.id = 'sonacove-titlebar';
    var iconHtml = '';
    if ('${iconBase64}') {
        iconHtml = '<div class="stb-icon" style="background-image: url(\\'data:image/png;base64,${iconBase64}\\')"></div>';
    }
    bar.innerHTML =
        iconHtml +
        '<div class="stb-title">' + (document.title || strings.windowTitle) + '</div>' +
        ('${appVersion}' ? '<span class="stb-version">v' + '${appVersion}'.split('.').pop() + '</span>' : '') +
        '<div class="stb-spacer"></div>' +
        '<div class="stb-menu">' +
            '<button class="stb-btn" id="stb-about" title="' + strings.aboutTooltip + '">' + strings.about + '</button>' +
            '<button class="stb-btn" id="stb-updates" title="' + strings.checkForUpdatesTooltip + '">' + strings.checkForUpdates + '</button>' +
            '<button class="stb-btn" id="stb-help" title="' + strings.helpTooltip + '">' + strings.help + '</button>' +
        '</div>';
    document.body.prepend(bar);

    document.getElementById('stb-about').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('show-about-dialog');
    });
    document.getElementById('stb-updates').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('check-for-updates');
    });
    document.getElementById('stb-help').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('open-help-docs');
    });

    // Keep the displayed title in sync with document.title changes.
    var titleTarget = document.querySelector('title');
    if (titleTarget) {
        new MutationObserver(function() {
            var el = document.querySelector('#sonacove-titlebar .stb-title');
            if (el) el.textContent = document.title || 'Sonacove Meets';
        }).observe(titleTarget, { childList: true, characterData: true, subtree: true });
    }
})();
`.trim();

// Cache the icon base64 at startup rather than re-reading from disk on every navigation.
let _cachedIconBase64 = null;

function getIconBase64() {
    if (_cachedIconBase64 !== null) {
        return _cachedIconBase64;
    }
    try {
        const iconPath = getIconPath('png');

        _cachedIconBase64 = fs.existsSync(iconPath) ? fs.readFileSync(iconPath).toString('base64') : '';
    } catch (e) {
        _cachedIconBase64 = '';
    }

    return _cachedIconBase64;
}

/**
 * Injects the custom title bar into the currently loaded page.
 *
 * @param {Electron.BrowserWindow} mainWindow
 */
function injectWindowsTitleBar(mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const titlebarStrings = {
        windowTitle: t('app.windowTitle'),
        about: t('titlebar.about'),
        aboutTooltip: t('titlebar.aboutTooltip'),
        checkForUpdates: t('titlebar.checkForUpdates'),
        checkForUpdatesTooltip: t('titlebar.checkForUpdatesTooltip'),
        help: t('titlebar.help'),
        helpTooltip: t('titlebar.helpTooltip')
    };

    mainWindow.webContents.executeJavaScript(
        getTitlebarJS(getIconBase64(), titlebarStrings, app.getVersion())
    ).catch(() => {});
}

module.exports = { injectWindowsTitleBar };
