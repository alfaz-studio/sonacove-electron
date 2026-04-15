const { app } = require('electron');

const { t } = require('../i18n');

const { getIconBase64 } = require('./icon');
const { getTitlebarJS, getMacTitlebarJS } = require('./renderer-script');

/**
 * Injects the Windows custom title bar into the currently loaded page.
 *
 * @param {import('electron').BrowserWindow} mainWindow
 */
function buildIconHtml() {
    const base64 = getIconBase64();

    return base64
        ? `<div class="stb-icon" style="background-image: url('data:image/png;base64,${base64}')"></div>`
        : '';
}

function injectTitlebar(mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const strings = {
        appVersion: app.getVersion(),
        windowTitle: t('app.windowTitle'),
        about: t('titlebar.about'),
        aboutTooltip: t('titlebar.aboutTooltip'),
        checkForUpdates: t('titlebar.checkForUpdates'),
        checkForUpdatesTooltip: t('titlebar.checkForUpdatesTooltip'),
        help: t('titlebar.help'),
        helpTooltip: t('titlebar.helpTooltip')
    };

    mainWindow.webContents.executeJavaScript(getTitlebarJS(buildIconHtml(), strings))
        .catch(e => console.warn('Titlebar injection failed:', e.message));
}

/**
 * Injects the macOS titlebar content (branding + update pill) into the
 * hiddenInset title bar area.
 *
 * @param {import('electron').BrowserWindow} mainWindow
 */
function injectMacTitlebar(mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const strings = {
        appVersion: app.getVersion(),
        windowTitle: t('app.windowTitle')
    };

    mainWindow.webContents.executeJavaScript(getMacTitlebarJS(buildIconHtml(), strings))
        .catch(e => console.warn('Mac titlebar injection failed:', e.message));
}

/**
 * Sets up the custom in-page title bar for the given window.
 * Windows: full custom titlebar with window controls, menu, and branding.
 * macOS: hiddenInset with branding (icon, title, version) and update pill.
 * Linux: no-op (uses native window frame).
 *
 * @param {import('electron').BrowserWindow} mainWindow
 */
function setupTitlebar(mainWindow) {
    if (process.platform === 'darwin') {
        // macOS: hiddenInset keeps native traffic lights. We inject branding
        // (icon, title, version) and the update pill into the empty title area.
        mainWindow.webContents.on('dom-ready', () => {
            injectMacTitlebar(mainWindow);
        });

        return;
    }

    // Linux uses native window frame — no custom titlebar needed.
    if (process.platform !== 'win32') {
        return;
    }

    // Inject the titlebar on every page load (including splash/error pages)
    // so the frameless window always has controls.
    // dom-ready fires before did-finish-load for faster appearance.
    mainWindow.webContents.on('dom-ready', () => {
        injectTitlebar(mainWindow);
    });

    // Notify renderer of maximize/unmaximize for window control icon swap.
    mainWindow.on('maximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('titlebar-maximized');
        }
    });
    mainWindow.on('unmaximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('titlebar-unmaximized');
        }
    });
}

/**
 * Sends the update-available notification to the titlebar in the renderer.
 *
 * @param {import('electron').BrowserWindow} mainWindow
 * @param {string} version - The new version string.
 */
function notifyUpdateAvailable(mainWindow, version) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('titlebar-update-available', version);
    }
}

// TODO: REMOVE — temporary fake update notification for visual testing
function fakeUpdateNotification(mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
        setTimeout(() => {
            notifyUpdateAvailable(mainWindow, '2025.16.0');
        }, 2000);
    });
}

module.exports = { setupTitlebar, notifyUpdateAvailable, fakeUpdateNotification };
