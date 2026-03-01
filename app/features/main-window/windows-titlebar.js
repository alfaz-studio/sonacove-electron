const fs = require('fs');

// ── Windows: in-page title bar ─────────────────────────────────────────────
// Because we use titleBarStyle:'hidden' on Windows, the native menu bar is
// gone. We inject a slim custom title bar into each loaded page so the user
// still has About / Check for Updates without pressing Alt.

const TITLEBAR_CSS = `
#sonacove-titlebar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 32px;
    background: #1a1a2e;
    -webkit-app-region: drag;
    display: flex;
    align-items: center;
    padding: 0 12px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 12px;
    color: #c0c0c0;
    user-select: none;
    box-sizing: border-box;
}
#sonacove-titlebar .stb-icon {
    width: 20px;
    height: 20px;
    margin-right: 8px;
    background-size: contain;
    background-repeat: no-repeat;
    background-position: center;
}
#sonacove-titlebar .stb-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#sonacove-titlebar .stb-menu {
    display: flex;
    gap: 2px;
    -webkit-app-region: no-drag;
    margin-right: 140px; /* space for native window-controls overlay */
}
#sonacove-titlebar .stb-btn {
    background: transparent;
    border: none;
    color: #a0a0a0;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-family: inherit;
    line-height: 1;
}
#sonacove-titlebar .stb-btn:hover {
    background: rgba(255,255,255,0.1);
    color: #ffffff;
}
body { margin-top: 32px !important; }
`.trim();

/**
 * Builds the JavaScript snippet that creates the in-page title bar DOM.
 *
 * @param {string} [iconBase64=''] - Base64-encoded PNG icon data.
 * @returns {string} The JavaScript code to inject.
 */
function getTitlebarJS(iconBase64 = '') {
    return `
(function() {
    if (document.getElementById('sonacove-titlebar')) return;

    var bar = document.createElement('div');
    bar.id = 'sonacove-titlebar';
    var iconHtml = '';
    if ('${iconBase64}') {
        iconHtml = '<div class="stb-icon" style="background-image: url(\\'data:image/png;base64,${iconBase64}\\')"></div>';
    }
    bar.innerHTML =
        iconHtml +
        '<div class="stb-title">' + (document.title || 'Sonacove Meets') + '</div>' +
        '<div class="stb-menu">' +
            '<button class="stb-btn" id="stb-about">About</button>' +
            '<button class="stb-btn" id="stb-updates">Check for Updates</button>' +
            '<button class="stb-btn" id="stb-help">Help</button>' +
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
            if (el) el.textContent = document.title;
        }).observe(titleTarget, { childList: true, characterData: true, subtree: true });
    }
})();
`.trim();
}

/**
 * Injects the custom title bar into the currently loaded page (Windows only).
 *
 * @param {BrowserWindow} win - The window to inject into.
 * @param {Function} getIconPathFn - Icon path resolver function.
 * @returns {void}
 */
function injectWindowsTitleBar(win, getIconPathFn) {
    if (!win || win.isDestroyed()) {
        return;
    }

    let iconBase64 = '';

    try {
        const iconPath = getIconPathFn('png');

        if (fs.existsSync(iconPath)) {
            iconBase64 = fs.readFileSync(iconPath).toString('base64');
        }
    } catch (e) {
        console.warn('Failed to load title bar icon:', e);
    }

    // eslint-disable-next-line no-empty-function
    win.webContents.insertCSS(TITLEBAR_CSS).catch(() => {});

    // eslint-disable-next-line no-empty-function
    win.webContents.executeJavaScript(getTitlebarJS(iconBase64)).catch(() => {});
}

module.exports = { injectWindowsTitleBar };
