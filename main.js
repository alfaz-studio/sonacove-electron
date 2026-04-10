/* global __dirname */

const {
    initPopupsConfigurationMain,
    getPopupTarget,
    setupPictureInPictureMain,
    setupPowerMonitorMain
} = require('@jitsi/electron-sdk');
const {
    BrowserWindow,
    app,
    ipcMain,
    desktopCapturer,
    screen
} = require('electron');
const contextMenu = require('electron-context-menu');
const isDev = require('electron-is-dev');
const windowStateKeeper = require('electron-window-state');
const fs = require('fs');
const path = require('path');
const process = require('process');
const nodeURL = require('url');

const { setupPictureInPicture } = require('./app/features/pip/main');
const { closeParticipantWindow } = require('./app/features/pip/participant-window');
const { initAnalytics, capture, shutdownAnalytics } = require('./app/features/analytics');
const { initI18n, t } = require('./app/features/i18n');
const { showLeaveModal } = require('./app/features/in-app-dialogs');
const { getIconPath, getSplashPath, getErrorPath } = require('./app/features/paths');
const { showAboutDialog, setApplicationMenu } = require('./app/features/app-menu');
const { setupAutoUpdater, checkForUpdatesManually, handleUpdateToastAction } = require('./app/features/updater');
const { injectWindowsTitleBar } = require('./app/features/windows-titlebar');
const { injectStagingBanner } = require('./app/features/staging-banner');

// Track the time the app process started for session duration calculation.
const appLaunchTime = Date.now();

// Set app user model ID at the very top for Windows icon support.
// Staging builds have their package.json name/productName changed to include
// "staging" by CI. app.name may return either depending on Electron version.
const _appNameLower = (app.name || '').toLowerCase();

if (process.platform === 'win32') {
    app.setAppUserModelId(
        _appNameLower.includes('staging') ? 'com.sonacove.staging' : 'com.sonacove.meet'
    );
}

const config = require('./app/features/config');
const {
    registerProtocol,
    navigateDeepLink
} = require('./app/features/deep-link');
const { setupSonacoveIPC } = require('./app/features/ipc');
const { closeOverlay } = require('./app/features/overlay/overlay-window');
const { setupScreenshotIPC } = require('./app/features/screenshot');
const { openExternalLink } = require('./app/features/openExternalLink');

// Staging builds have their package.json name/productName set to include "staging" by CI.
// Check case-insensitively since app.name may return name or productName.
const isStaging = _appNameLower.includes('staging');

if (!isStaging) {
    registerProtocol();
}

// Fix screen-sharing thumbnails being missing sometimes.
// https://github.com/electron/electron/issues/44504
const disabledFeatures = [
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

app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
app.commandLine.appendSwitch('disable-site-isolation-trials');

if (isDev) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
    app.commandLine.appendSwitch('allow-insecure-localhost');
}

// Enable WebRTC field trials:
// - Opus RED: redundant audio encoding for packet loss resilience
// - FlexFEC-03: forward error correction for video in P2P calls
//   (advertise in SDP + enable sending; receive is on by default)
app.commandLine.appendSwitch('force-fieldtrials',
    'WebRTC-Audio-Red-For-Opus/Enabled/'
    + 'WebRTC-FlexFEC-03-Advertised/Enabled/'
    + 'WebRTC-FlexFEC-03/Enabled/');

// Wayland: Enable optional PipeWire support.
if (!app.commandLine.hasSwitch('enable-features')) {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

// Enable context menu so things like copy and paste work in input fields.
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

/**
 * When in development mode:
 * - Enable automatic reloads
 */
if (isDev) {
    require('electron-reload')(path.join(__dirname, 'build'));
}

/**
 * The window object that will load the iframe with Jitsi Meet.
 * IMPORTANT: Must be defined as global in order to not be garbage collected
 * acidentally.
 */
let mainWindow = null;

let webrtcInternalsWindow = null;

/**
 * Add protocol data
 */
const appProtocolSurplus = `${config.appProtocolPrefix}://`;
let pendingStartupDeepLink = null;

// showAboutDialog, checkForUpdatesManually, setApplicationMenu — see app/features/app-menu.js and app/features/updater.js

// Windows titlebar — see app/features/windows-titlebar.js

/**
 * Opens new window with index.html(Jitsi Meet is loaded in iframe there).
 */
function createJitsiMeetWindow() {
    // Application menu — wrapper closures capture mainWindow for the menu callbacks.
    const _showAboutDialog = () => showAboutDialog(mainWindow);
    const _checkForUpdatesManually = () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }
        checkForUpdatesManually(mainWindow.webContents);
    };

    setApplicationMenu({
        showAboutDialog: _showAboutDialog,
        checkForUpdatesManually: _checkForUpdatesManually
    });

    // Load the previous window state with fallback to defaults.
    const windowState = windowStateKeeper({
        defaultWidth: 800,
        defaultHeight: 600,
        fullScreen: false
    });

    // Path to root directory.
    const basePath = isDev ? process.cwd() : app.getAppPath();

    // Options used when creating the main Jitsi Meet window.
    // Use a preload script in order to provide node specific functionality
    // to a isolated BrowserWindow in accordance with electron security
    // guideline.
    const options = {
        x: windowState.x,
        y: windowState.y,
        width: windowState.width,
        height: windowState.height,
        title: t('app.windowTitle'),
        icon: getIconPath(),
        minWidth: 800,
        minHeight: 600,
        show: false,
        backgroundColor: '#1a1a2e',

        // On Windows, hide the native menu bar row and show native window
        // controls as an overlay. A custom in-page title bar is injected via
        // injectWindowsTitleBar() on each page load.
        ...(process.platform !== 'darwin' ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: {
                color: '#1a1a2e',
                symbolColor: '#e0e0e0',
                height: 32
            }
        } : {}),

        webPreferences: {
            enableBlinkFeatures: 'WebAssemblyCSP',
            contextIsolation: false,
            nodeIntegration: false,
            preload: path.resolve(basePath, 'build', 'preload.js'),
            sandbox: false,
            webSecurity: false,
            backgroundThrottling: false
        }
    };

    const windowOpenHandler = ({ url, frameName }) => {
        const target = getPopupTarget(url, frameName);

        // Allow URLs on allowed hosts to open inside Electron instead of the browser
        const allowedHosts = config.currentConfig.allowedHosts || [];

        try {
            const parsedUrl = new URL(url);

            if (allowedHosts.some(host => parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`))) {
                return { action: 'allow' };
            }
        } catch (e) {
            // ignore parse errors
        }

        if (!target || target === 'browser') {
            openExternalLink(url);

            return { action: 'deny' };
        }

        if (target === 'electron') {
            return { action: 'allow' };
        }

        return { action: 'deny' };
    };

    setupAutoUpdater(() => mainWindow, { isStaging });

    mainWindow = new BrowserWindow(options);

    // Set icon immediately after creating window for taskbar/PiP
    if (process.platform !== 'darwin') {
        const iconPath = getIconPath();

        console.log(`🎯 Setting window icon: ${iconPath}`);
        if (fs.existsSync(iconPath)) {
            mainWindow.setIcon(iconPath);
        }
    }

    // Prevent Close during Meeting — show custom in-app modal instead of native dialog.
    // Not calling event.preventDefault() keeps the page open (prevents unload).
    // If the user confirms "Leave", the IPC handler calls mainWindow.destroy().
    mainWindow.webContents.on('will-prevent-unload', () => {
        showLeaveModal(mainWindow.webContents, {
            title: t('leaveModal.title'),
            message: t('leaveModal.message'),
            confirm: t('leaveModal.confirm'),
            cancel: t('leaveModal.cancel')
        });
    });

    const onLeaveModal = (event, data) => {
        if (event.sender !== mainWindow?.webContents) return;
        if (data && data.action === 'confirm' && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
        }
    };

    ipcMain.on('leave-modal-action', onLeaveModal);

    // Handle update toast responses.
    const onUpdateToast = (event, data) => {
        if (event.sender !== mainWindow?.webContents) return;
        if (data) {
            handleUpdateToastAction(data.action);
        }
    };

    ipcMain.on('update-toast-action', onUpdateToast);

    // Picture-in-Picture Auto-Trigger
    const cleanupPip = setupPictureInPicture(mainWindow);

    // Participant PiP — open overlay when the main window loses focus
    // (minimize, alt-tab, click another app, etc.)
    let pipMinimizedSent = false;  // idempotency guard — prevents repeated pip-window-minimized
    let blurTimer = null;          // timer ref so focus/restore can cancel pending blur

    mainWindow.on('minimize', () => {
        if (mainWindow && !mainWindow.isDestroyed() && !pipMinimizedSent) {
            pipMinimizedSent = true;
            mainWindow.webContents.send('pip-window-minimized');
        }
    });

    mainWindow.on('blur', () => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || pipMinimizedSent) {
            return;
        }

        // Short delay to check if focus moved to one of our own windows
        // (e.g. the PIP panel or an overlay) — don't trigger PIP in that case.
        if (blurTimer) {
            clearTimeout(blurTimer);
        }
        blurTimer = setTimeout(() => {
            blurTimer = null;
            if (!mainWindow || mainWindow.isDestroyed() || pipMinimizedSent) {
                return;
            }
            const focused = BrowserWindow.getFocusedWindow();

            if (!focused) {
                // Focus left the app entirely — trigger PIP.
                pipMinimizedSent = true;
                mainWindow.webContents.send('pip-window-minimized');
            }
        }, 100);
    });

    // Guard: restore fires before focus on taskbar click — skip the
    // duplicate send in the focus handler that immediately follows.
    let restoredSent = false;

    mainWindow.on('restore', () => {
        if (blurTimer) {
            clearTimeout(blurTimer);
            blurTimer = null;
        }
        pipMinimizedSent = false;
        restoredSent = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pip-window-restored');
        }
    });

    mainWindow.on('focus', () => {
        if (blurTimer) {
            clearTimeout(blurTimer);
            blurTimer = null;
        }
        pipMinimizedSent = false;

        // If restore already sent the event (taskbar click), skip.
        if (restoredSent) {
            restoredSent = false;

            return;
        }
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
            mainWindow.webContents.send('pip-window-restored');
        }
    });

    // Enable Screen Sharing
    ipcMain.handle('jitsi-screen-sharing-get-sources', async (event, options) => {
        const validOptions = {
            types: options?.types || [ 'screen', 'window' ],
            thumbnailSize: options?.thumbnailSize || { width: 300,
                height: 300 },
            fetchWindowIcons: true
        };

        try {
            const sources = await desktopCapturer.getSources(validOptions);

            console.log(`✅ Main: Found ${sources.length} sources`);

            const mappedSources = sources.map(source => {
                return {
                    id: source.id,
                    name: source.name,
                    thumbnail: {
                        dataUrl: source.thumbnail.toDataURL()
                    }
                };
            });

            return mappedSources;
        } catch (error) {
            console.error('❌ Main: Error getting desktop sources:', error);

            return [];
        }
    });

    // Navigation Router (Dashboard -> Meeting)
    mainWindow.webContents.on('will-navigate', (event, url) => {
        const parsedUrl = new URL(url);

        if (parsedUrl.pathname.includes('/static/close')) {
            if (event) {
                event.preventDefault();
            }
            const landingUrl = new URL(config.currentConfig.landing);

            // Remove trailing slash if present on landing pathname
            const basePath = landingUrl.pathname.endsWith('/')
                ? landingUrl.pathname.slice(0, -1)
                : landingUrl.pathname;

            const closePageUrl = `${landingUrl.origin}${basePath}/close`;

            console.log(`🔀 Hangup Detected. Redirecting to: ${closePageUrl}`);

            setImmediate(() => {
                mainWindow.loadURL(closePageUrl);
            });

            return 'redirected';
        }

        if (parsedUrl.pathname.startsWith('/meet')) {
            const meetRootUrl = new URL(config.currentConfig.meetRoot);

            if (parsedUrl.origin !== meetRootUrl.origin) {
                event.preventDefault();

                // Strip the /meet prefix from pathname — meetRoot already
                // includes it, so we'd otherwise get /meet/meet/room.
                const roomPath = parsedUrl.pathname.replace(/^\/meet/, '');
                const targetUrl = `${config.currentConfig.meetRoot}${roomPath}${parsedUrl.search}`;

                setImmediate(() => {
                    mainWindow.loadURL(targetUrl);
                });
            }
        }
    });

    setupSonacoveIPC(ipcMain, mainWindow, {
        showAboutDialog: _showAboutDialog,
        checkForUpdatesManually: _checkForUpdatesManually,
        capture
    });

    windowState.manage(mainWindow);

    // Show a branded splash screen first, then navigate to the remote URL.
    // The backgroundColor matches the splash so the transition feels seamless.
    mainWindow.loadFile(getSplashPath());

    if (isDev) {
        mainWindow.webContents.session.clearCache();
    }

    mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
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
                    const pageUrl = mainWindow.webContents.getURL();

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

    // Filter out x-frame-options and frame-ancestors CSP to allow loading jitsi via the iframe API
    // Resolves https://github.com/jitsi/jitsi-meet-electron/issues/285
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
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

    // Block redirects.
    const allowedRedirects = [
        'http:',
        'https:',
        'ws:',
        'wss:'
    ];

    mainWindow.webContents.addListener('will-redirect', (ev, url) => {
        const requestedUrl = new URL(url);

        if (!allowedRedirects.includes(requestedUrl.protocol)) {
            console.warn(`Disallowing redirect to ${url}`);
            ev.preventDefault();
        }
    });

    // Block opening any external applications.
    mainWindow.webContents.session.setPermissionRequestHandler((_, permission, callback, details) => {
        if (permission === 'openExternal') {
            console.warn(`Disallowing opening ${details.externalURL}`);
            callback(false);

            return;
        }

        callback(true);
    });

    initPopupsConfigurationMain(mainWindow, windowOpenHandler);
    setupPictureInPictureMain(mainWindow);
    setupPowerMonitorMain(mainWindow);
    // On macOS, append the version patch number to the native title bar.
    if (process.platform === 'darwin') {
        const patchVersion = app.getVersion().split('.').pop();

        mainWindow.on('page-title-updated', (event, title) => {
            event.preventDefault();
            mainWindow.setTitle(title
                ? `${title} — v${patchVersion}`
                : `Sonacove Meets — v${patchVersion}`);
        });
    }

    // Inject the custom in-page title bar on Windows after each page load.
    if (process.platform !== 'darwin') {
        mainWindow.webContents.on('did-finish-load', () => {
            // Skip local pages (splash, error) — title bar is only for the remote dashboard.
            const url = mainWindow.webContents.getURL();

            if (!url.startsWith('file://')) {
                injectWindowsTitleBar(mainWindow);
            }
        });
    }

    // Inject a visible staging banner so testers know they're on a PR build.
    if (isStaging) {
        mainWindow.webContents.on('did-finish-load', () => {
            injectStagingBanner(mainWindow.webContents);
        });
    }

    // Show a branded error page instead of Chromium's default when the
    // remote URL fails to load (offline, DNS failure, server down, etc.).
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // Only handle main-frame failures; ignore sub-frames and aborted loads
        // (ERR_ABORTED fires when navigation is cancelled by a new one).
        if (!isMainFrame || errorCode === -3) {
            return;
        }

        // Don't show the error page if a local file itself failed to load —
        // this prevents an infinite loop if error.html is missing or corrupt.
        if (validatedURL && validatedURL.startsWith('file://')) {
            return;
        }

        console.warn(`Page load failed: ${errorDescription} (${errorCode}) — ${validatedURL}`);

        mainWindow.loadFile(getErrorPath(), {
            query: {
                code: String(errorCode),
                desc: errorDescription,
                strings: JSON.stringify({
                    heading: t('errorPage.heading'),
                    subtitle: t('errorPage.subtitle'),
                    retryButton: t('errorPage.retryButton'),
                    offlineHeading: t('errorPage.offlineHeading'),
                    offlineSubtitle: t('errorPage.offlineSubtitle'),
                    serverHeading: t('errorPage.serverHeading'),
                    serverSubtitle: t('errorPage.serverSubtitle'),
                    securityHeading: t('errorPage.securityHeading'),
                    securitySubtitle: t('errorPage.securitySubtitle'),
                    connecting: t('errorPage.connecting')
                })
            }
        });
    });

    // Allow the error page to trigger a reload of the remote dashboard.
    const onRetryLoad = (event) => {
        if (event.sender !== mainWindow?.webContents) return;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(config.currentConfig.landing);
        }
    };

    ipcMain.on('retry-load', onRetryLoad);

    mainWindow.on('closed', () => {
        // Cancel any pending blur timer.
        if (blurTimer) {
            clearTimeout(blurTimer);
            blurTimer = null;
        }

        // Remove PiP IPC listeners to prevent accumulation on window recreation (macOS).
        cleanupPip();

        // Destroy the participant PiP panel (may still be alive in pill mode).
        closeParticipantWindow(false);

        // Close the annotation overlay if it is open
        closeOverlay();

        ipcMain.removeListener('retry-load', onRetryLoad);
        ipcMain.removeListener('update-toast-action', onUpdateToast);
        ipcMain.removeListener('leave-modal-action', onLeaveModal);
        ipcMain.removeHandler('jitsi-screen-sharing-get-sources');
        mainWindow = null;
    });
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();

        // Splash is now visible — load the remote dashboard.
        mainWindow.loadURL(config.currentConfig.landing);

        // Try pending startup deeplink if we have one
        if (pendingStartupDeepLink) {
            navigateDeepLink(pendingStartupDeepLink);
        }
    });

    /**
     * When someone tries to enter something like jitsi-meet://test
     *  while app is closed
     * it will trigger this event below
     */
    handleProtocolCall(process.argv.pop());
}

// Handle PiP and child window icon configuration
const setupChildWindowIcon = () => {
    const iconPath = getIconPath();

    // Set the app icon on child windows opened via window.open().
    // Skip the main window — it has its own windowOpenHandler with
    // URL-based allow/deny logic that this would override.
    app.on('web-contents-created', (event, contents) => {
        if (mainWindow && contents === mainWindow.webContents) {
            return;
        }
        contents.setWindowOpenHandler(({ url }) => {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    icon: iconPath,
                    show: true
                }
            };
        });
    });
};

/**
 * Opens new window with WebRTC internals.
 */
function createWebRTCInternalsWindow() {
    const options = {
        minWidth: 800,
        minHeight: 600,
        show: true
    };

    webrtcInternalsWindow = new BrowserWindow(options);
    webrtcInternalsWindow.loadURL('chrome://webrtc-internals');
}

/**
 * Handler for application protocol links to initiate a conference.
 */
function handleProtocolCall(fullProtocolCall) {
    // Store deeplink for retry mechanism if no window exists yet
    if (fullProtocolCall && fullProtocolCall.indexOf(appProtocolSurplus) === 0) {
        pendingStartupDeepLink = fullProtocolCall;
    }

    // don't touch when something is bad
    if (
        !fullProtocolCall
        || fullProtocolCall.trim() === ''
        || fullProtocolCall.indexOf(appProtocolSurplus) !== 0
    ) {
        console.log('❌ Invalid protocol call, returning');

        return;
    }

    navigateDeepLink(fullProtocolCall);
    capture('deep_link_opened', { deep_link: fullProtocolCall });

    if (app.isReady() && mainWindow === null) {
        createJitsiMeetWindow();
    }

    // Note: Protocol handling now done directly in main process
    // No longer need to forward to renderer process
}

/**
 * Force Single Instance Application.
 * Handle this on darwin via LSMultipleInstancesProhibited in Info.plist as below does not work on MAS
 */
const gotInstanceLock = process.platform === 'darwin' ? true : app.requestSingleInstanceLock();

if (!gotInstanceLock) {
    app.quit();
    process.exit(0);
}

/**
 * Run the application.
 */

app.on('activate', () => {
    if (mainWindow === null) {
        createJitsiMeetWindow();
    }
});

app.on('certificate-error',
    // eslint-disable-next-line max-params
    (event, webContents, url, error, certificate, callback) => {
        if (isDev) {
            event.preventDefault();
            callback(true);
        } else {
            callback(false);
        }
    }
);

app.on('ready', () => {
    initI18n();
    initAnalytics();
    capture('app_launched');

    // Register screenshot IPC handlers once at app level (not per-window)
    // to avoid "Attempted to register a second handler" crashes on window recreation.
    setupScreenshotIPC(ipcMain);

    setupChildWindowIcon();
    createJitsiMeetWindow();
});

app.on('second-instance', (event, commandLine) => {
    /**
     * If someone creates second instance of the application, set focus on
     * existing window.
     */
    if (mainWindow) {
        mainWindow.isMinimized() && mainWindow.restore();
        mainWindow.focus();

        /**
         * This is for windows [win32]
         * so when someone tries to enter something like jitsi-meet://test
         * while app is opened it will trigger protocol handler.
         */
        handleProtocolCall(commandLine.pop());
    }
});

if (isDev) {
    app.on('ready', createWebRTCInternalsWindow);
}

app.on('window-all-closed', () => {
    app.quit();
});

// Capture app_quit and flush PostHog before the process exits.
// Uses a flag to avoid infinite recursion (before-quit → app.quit() → before-quit...).
let analyticsShutdownDone = false;

app.on('before-quit', event => {
    if (analyticsShutdownDone) {
        return;
    }
    event.preventDefault();
    analyticsShutdownDone = true;

    capture('app_quit', {
        session_duration_s: Math.floor((Date.now() - appLaunchTime) / 1000)
    });

    // Allow up to 3 s for PostHog to flush, then force-quit regardless.
    const forceQuitTimeout = setTimeout(() => app.quit(), 3000);

    shutdownAnalytics()
        .then(() => {
            clearTimeout(forceQuitTimeout);
            app.quit();
        })
        .catch(() => {
            clearTimeout(forceQuitTimeout);
            app.quit();
        });
});

// Staging builds must not register as the default protocol handler —
// that would hijack deeplinks from the production install.
if (!isStaging) {
    // remove so we can register each time as we run the app.
    app.removeAsDefaultProtocolClient(config.appProtocolPrefix);

    // If we are running a non-packaged version of the app && on windows
    if (isDev && process.platform === 'win32') {
        // Set the path of electron.exe and your app.
        // These two additional parameters are only available on windows.
        app.setAsDefaultProtocolClient(
            config.appProtocolPrefix,
            process.execPath,
            [ path.resolve(process.argv[1]) ]
        );
    } else {
        app.setAsDefaultProtocolClient(config.appProtocolPrefix);
    }
}

/**
 * This is for mac [darwin]
 * so when someone tries to enter something like jitsi-meet://test
 * it will trigger this event below
 */
app.on('open-url', (event, data) => {
    event.preventDefault();
    handleProtocolCall(data);
});
