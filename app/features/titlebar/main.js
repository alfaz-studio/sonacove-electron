const { app } = require('electron');

const { t } = require('../i18n');

const { getIconBase64 } = require('./icon');
const { getTitlebarJS, getMacTitlebarJS } = require('./renderer-script');

/**
 * Shared titlebar strings used by both platforms.
 *
 * @returns {Object}
 */
function getTitlebarStrings() {
    return {
        appVersion: app.getVersion(),
        windowTitle: t('app.windowTitle'),
        about: t('titlebar.about'),
        aboutTooltip: t('titlebar.aboutTooltip'),
        checkForUpdates: t('titlebar.checkForUpdates'),
        checkForUpdatesTooltip: t('titlebar.checkForUpdatesTooltip'),
        help: t('titlebar.help'),
        helpTooltip: t('titlebar.helpTooltip')
    };
}

/**
 * Injects the custom title bar into the currently loaded page (Windows).
 *
 * @param {import('electron').BrowserWindow} mainWindow
 */
function injectTitlebar(mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    mainWindow.webContents.executeJavaScript(getTitlebarJS(getIconBase64(), getTitlebarStrings())).catch(() => {});
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

    mainWindow.webContents.executeJavaScript(getMacTitlebarJS(getIconBase64(), strings)).catch(() => {});
}

/**
 * Sets up the custom in-page title bar for the given window.
 * Currently Windows-only (no-ops on macOS). macOS support can be added here later.
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

module.exports = { setupTitlebar, notifyUpdateAvailable };
