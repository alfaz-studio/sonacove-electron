/* global __dirname */

const { app } = require('electron');
const contextMenu = require('electron-context-menu');
const isDev = require('electron-is-dev');
const path = require('path');

// ── Chromium feature flags ──────────────────────────────────────────────────

const DISABLED_FEATURES = [

    // Fix screen-sharing thumbnails being missing sometimes.
    // https://github.com/electron/electron/issues/44504
    'ThumbnailCapturerMac:capture_mode/sc_screenshot_manager',
    'ScreenCaptureKitPickerScreen',
    'ScreenCaptureKitStreamPickerSonoma',

    // Disable cookie restrictions — Electron loads the web app from a different
    // origin than the API, so session cookies are cross-site by nature.
    'ThirdPartyCookieDeprecationTrial',
    'ThirdPartyStoragePartitioning',
    'PartitionedCookies',
    'SameSiteByDefaultCookies',
    'CookiesWithoutSameSiteMustBeSecure',

    // Disable other restrictive browser policies that don't apply to a desktop app
    'BlockInsecurePrivateNetworkRequests',
    'PrivateNetworkAccessRespectPreflightResults'
];

/**
 * Appends all required Chromium command-line switches.
 *
 * @returns {void}
 */
function setupCommandLineSwitches() {
    app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES.join(','));
    app.commandLine.appendSwitch('disable-site-isolation-trials');

    if (isDev) {
        app.commandLine.appendSwitch('ignore-certificate-errors');
        app.commandLine.appendSwitch('allow-insecure-localhost');
    }

    // Enable Opus RED field trial.
    app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Audio-Red-For-Opus/Enabled/');

    // Wayland: Enable optional PipeWire support.
    if (!app.commandLine.hasSwitch('enable-features')) {
        app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
    }
}

/**
 * Enables the right-click context menu (copy, paste, etc.) in input fields.
 *
 * @returns {void}
 */
function setupContextMenu() {
    contextMenu({
        showLookUpSelection: false,
        showSearchWithGoogle: false,
        showCopyImage: false,
        showCopyImageAddress: false,
        showSaveImage: false,
        showSaveImageAs: false,
        showInspectElement: true,
        showServices: false
    });
}

/**
 * When in development mode, enable automatic reloads on file changes.
 *
 * @returns {void}
 */
function setupDevReload() {
    if (isDev) {
        require('electron-reload')(path.join(__dirname, '..', '..', '..', 'build'));
    }
}

module.exports = {
    setupCommandLineSwitches,
    setupContextMenu,
    setupDevReload
};
