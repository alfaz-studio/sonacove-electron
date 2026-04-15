const { TITLEBAR_CSS, MAC_TITLEBAR_CSS } = require('./styles');

/**
 * Returns inline JS that sets up the update-available IPC listener for
 * a given version element ID. Shared between Windows and macOS titlebars.
 *
 * @param {string} verId - DOM id of the version element.
 * @returns {string}
 */
function updateAvailableListenerJS(verId) {
    return `
            window.sonacoveElectronAPI.ipc.on('titlebar-update-available', function(version) {
                var ver = document.getElementById('${verId}');
                if (ver && !ver._updateBound) {
                    ver._updateBound = true;
                    ver.textContent = '';
                    var dot = document.createElement('span');
                    dot.className = 'stb-update-dot';
                    ver.appendChild(dot);
                    ver.appendChild(document.createTextNode('v' + version + ' available'));
                    ver.className = 'stb-ver stb-update';
                    ver.title = 'Click to install update';
                    ver.addEventListener('click', function() {
                        window.sonacoveElectronAPI.ipc.send('update-toast-action', { action: 'install' });
                    });
                }
            })`;
}

/**
 * Returns inline JS that observes <title> changes and syncs them to a
 * titlebar element. Adds the observer's disconnect to the cleanup array.
 *
 * @param {string} selector - CSS selector for the title element to update.
 * @param {string} cleanupVar - Name of the window cleanup array variable.
 * @returns {string}
 */
function titleObserverJS(selector, cleanupVar) {
    return `
    var titleTarget = document.querySelector('title');
    if (titleTarget) {
        var _obs = new MutationObserver(function() {
            var el = document.querySelector('${selector}');
            if (el) el.textContent = document.title;
        });
        _obs.observe(titleTarget, { childList: true, characterData: true, subtree: true });
        ${cleanupVar}.push(function() { _obs.disconnect(); });
    }`;
}

/**
 * Returns a JS string to be injected into the renderer via executeJavaScript.
 * Builds the custom in-page title bar DOM, event listeners, and IPC wiring.
 *
 * @param {string} iconHtml - Pre-built HTML for the app icon (empty string if no icon).
 * @param {Object} strings - i18n strings for button labels and tooltips.
 * @returns {string} JavaScript source to execute in the renderer.
 */
const getTitlebarJS = (iconHtml = '', strings = {}) => `
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
    var iconHtml = ${JSON.stringify(iconHtml)};
    var minSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    var maxSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2.5" y="2.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
    var closeSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    // Build innerHTML with safe static content only — dynamic text is set
    // via textContent below to prevent XSS from document.title or version strings.
    bar.innerHTML =
        iconHtml +
        '<div class="stb-title"></div>' +
        '<span class="stb-ver" id="stb-ver"></span>' +
        '<div class="stb-menu">' +
            '<button class="stb-btn" id="stb-about"></button>' +
            '<button class="stb-btn" id="stb-updates"></button>' +
            '<button class="stb-btn" id="stb-help"></button>' +
        '</div>' +
        '<div class="stb-wc">' +
            '<button class="stb-wc-btn" id="stb-minimize" title="Minimize">' + minSvg + '</button>' +
            '<button class="stb-wc-btn" id="stb-maximize" title="Maximize">' + maxSvg + '</button>' +
            '<button class="stb-wc-btn stb-close" id="stb-close" title="Close">' + closeSvg + '</button>' +
        '</div>';
    bar.querySelector('.stb-title').textContent = document.title || strings.windowTitle;
    bar.querySelector('#stb-ver').textContent = 'v' + strings.appVersion;
    var aboutBtn = bar.querySelector('#stb-about');
    aboutBtn.textContent = strings.about;
    aboutBtn.title = strings.aboutTooltip;
    var updatesBtn = bar.querySelector('#stb-updates');
    updatesBtn.textContent = strings.checkForUpdates;
    updatesBtn.title = strings.checkForUpdatesTooltip;
    var helpBtn = bar.querySelector('#stb-help');
    helpBtn.textContent = strings.help;
    helpBtn.title = strings.helpTooltip;

    // Prepend titlebar to <html> (outside <body>) — position:fixed anchors
    // it to the viewport regardless of body scroll or overflow.
    document.documentElement.prepend(bar);

    // Reserve space for the titlebar via padding-top on <html>. The body
    // inherits the reduced content area (100vh minus padding) so page
    // content flows below the titlebar without transform hacks.
    // 34px = 32px titlebar height + 2px gradient border (see styles.js TITLEBAR_CSS).
    document.documentElement.style.setProperty('padding-top', '34px', 'important');
    document.documentElement.style.setProperty('box-sizing', 'border-box', 'important');
    document.documentElement.style.setProperty('height', '100vh', 'important');
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    document.body.style.setProperty('height', '100%', 'important');
    document.body.style.setProperty('overflow', 'hidden', 'important');

    document.getElementById('stb-about').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('show-about-dialog');
    });
    document.getElementById('stb-updates').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('check-for-updates');
    });
    document.getElementById('stb-help').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('open-help-docs');
    });
    document.getElementById('stb-minimize').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('titlebar-minimize');
    });
    document.getElementById('stb-maximize').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('titlebar-maximize');
    });
    document.getElementById('stb-close').addEventListener('click', function() {
        window.sonacoveElectronAPI.ipc.send('titlebar-close');
    });

    // Swap maximize/restore icon when window state changes.
    var restoreSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="4" y="1.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="1.5" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="transparent"/></svg>';

    // Clean up any IPC listeners and observers from a previous injection
    // (e.g. navigation) to prevent accumulation.
    if (window._stbCleanup) {
        window._stbCleanup.forEach(function(fn) { fn(); });
    }
    window._stbCleanup = [];

    if (window.sonacoveElectronAPI && window.sonacoveElectronAPI.ipc && window.sonacoveElectronAPI.ipc.on) {
        window._stbCleanup.push(
            window.sonacoveElectronAPI.ipc.on('titlebar-maximized', function() {
                var btn = document.getElementById('stb-maximize');
                if (btn) {
                    btn.innerHTML = restoreSvg;
                    btn.title = 'Restore';
                }
            }),
            window.sonacoveElectronAPI.ipc.on('titlebar-unmaximized', function() {
                var btn = document.getElementById('stb-maximize');
                if (btn) {
                    btn.innerHTML = maxSvg;
                    btn.title = 'Maximize';
                }
            }),${updateAvailableListenerJS('stb-ver')}
        );
    }
${titleObserverJS('#sonacove-titlebar .stb-title', 'window._stbCleanup')}
})();
`.trim();

/**
 * Returns a JS string for the macOS titlebar content (hiddenInset mode).
 * Injects branding (icon, title, version) and the update-available pill
 * into the space left by the hidden native title text.
 *
 * @param {string} iconHtml - Pre-built HTML for the app icon (empty string if no icon).
 * @param {Object} strings - i18n strings (appVersion, windowTitle).
 * @returns {string} JavaScript source to execute in the renderer.
 */
const getMacTitlebarJS = (iconHtml = '', strings = {}) => `
(function() {
    var strings = ${JSON.stringify(strings)};

    // Inject styles idempotently.
    var sid = 'sonacove-mac-titlebar-styles';
    if (!document.getElementById(sid)) {
        var s = document.createElement('style');
        s.id = sid;
        s.textContent = ${JSON.stringify(MAC_TITLEBAR_CSS)};
        document.head.appendChild(s);
    }

    // Guard against duplicate injection.
    if (document.getElementById('sonacove-mac-titlebar')) return;

    var bar = document.createElement('div');
    bar.id = 'sonacove-mac-titlebar';
    var iconHtml = ${JSON.stringify(iconHtml)};
    bar.innerHTML = '<div class="stb-content">'
        + iconHtml
        + '<span class="stb-title"></span>'
        + '<span class="stb-ver" id="stb-mac-ver"></span>'
        + '</div>';
    bar.querySelector('.stb-title').textContent = document.title || strings.windowTitle;
    bar.querySelector('#stb-mac-ver').textContent = 'v' + strings.appVersion;

    // Prepend titlebar to <html> (outside <body>) — position:fixed anchors
    // it to the viewport regardless of body scroll or overflow.
    document.documentElement.prepend(bar);

    // Reserve space for the titlebar via padding-top on <html>. The body
    // inherits the reduced content area (100vh minus padding) so page
    // content flows below the titlebar without transform hacks.
    // 28px = macOS titlebar height (see styles.js MAC_TITLEBAR_CSS).
    document.documentElement.style.setProperty('padding-top', '28px', 'important');
    document.documentElement.style.setProperty('box-sizing', 'border-box', 'important');
    document.documentElement.style.setProperty('height', '100vh', 'important');
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    document.body.style.setProperty('height', '100%', 'important');
    document.body.style.setProperty('overflow', 'hidden', 'important');

    // Clean up previous IPC listeners and observers (re-navigation).
    if (window._stbMacCleanup) {
        window._stbMacCleanup.forEach(function(fn) { fn(); });
    }
    window._stbMacCleanup = [];

    if (window.sonacoveElectronAPI && window.sonacoveElectronAPI.ipc && window.sonacoveElectronAPI.ipc.on) {
        window._stbMacCleanup.push(${updateAvailableListenerJS('stb-mac-ver')}
        );
    }
${titleObserverJS('#sonacove-mac-titlebar .stb-title', 'window._stbMacCleanup')}
})();
`.trim();

module.exports = { getTitlebarJS, getMacTitlebarJS };
