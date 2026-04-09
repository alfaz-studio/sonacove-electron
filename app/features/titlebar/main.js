const { app } = require('electron');

const { t } = require('../i18n');

const { getIconBase64 } = require('./icon');
const { getTitlebarJS } = require('./renderer-script');

/**
 * Injects the custom title bar into the currently loaded page.
 *
 * @param {import('electron').BrowserWindow} mainWindow
 */
function injectTitlebar(mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const titlebarStrings = {
        appVersion: app.getVersion(),
        windowTitle: t('app.windowTitle'),
        about: t('titlebar.about'),
        aboutTooltip: t('titlebar.aboutTooltip'),
        checkForUpdates: t('titlebar.checkForUpdates'),
        checkForUpdatesTooltip: t('titlebar.checkForUpdatesTooltip'),
        help: t('titlebar.help'),
        helpTooltip: t('titlebar.helpTooltip')
    };

    mainWindow.webContents.executeJavaScript(getTitlebarJS(getIconBase64(), titlebarStrings)).catch(() => {});
}

/**
 * Sets up the custom in-page title bar for the given window.
 * Currently Windows-only (no-ops on macOS). macOS support can be added here later.
 *
 * @param {import('electron').BrowserWindow} mainWindow
 */
function setupTitlebar(mainWindow) {
    if (process.platform === 'darwin') {
        // macOS: keep native frame, just append version to the window title.
        const patchVersion = app.getVersion().split('.').pop();

        mainWindow.on('page-title-updated', (event, title) => {
            event.preventDefault();
            mainWindow.setTitle(title
                ? `${title} — v${patchVersion}`
                : `Sonacove Meets — v${patchVersion}`);
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
