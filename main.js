/* global __dirname */

const {
    initPopupsConfigurationMain,
    getPopupTarget,
    setupPictureInPictureMain,
    setupRemoteControlMain,
    setupPowerMonitorMain
} = require('@jitsi/electron-sdk');
const {
    BrowserWindow,
    Menu,
    app,
    ipcMain,
    desktopCapturer,
    dialog,
    shell
} = require('electron');
const contextMenu = require('electron-context-menu');
const isDev = require('electron-is-dev');
const { autoUpdater } = require('electron-updater');
const windowStateKeeper = require('electron-window-state');
const fs = require('fs');
const path = require('path');
const process = require('process');
const nodeURL = require('url');

const { setupPictureInPicture } = require('./app/features/pip/main');
const { initAnalytics, capture, shutdownAnalytics } = require('./app/features/sonacove/analytics');

// Track the time the app process started for session duration calculation.
const appLaunchTime = Date.now();

// Set app user model ID at the very top for Windows icon support
if (process.platform === 'win32') {
    app.setAppUserModelId('com.sonacove.meet');
}

const config = require('./app/features/config');
const sonacoveConfig = require('./app/features/sonacove/config');
const {
    registerProtocol,
    navigateDeepLink,
    processDeepLinkOnStartup
} = require('./app/features/sonacove/deep-link');
const { setupSonacoveIPC } = require('./app/features/sonacove/ipc');
const { closeOverlay } = require('./app/features/sonacove/overlay-window');
const { openExternalLink } = require('./app/features/utils/openExternalLink');


registerProtocol();

// For enabling remote control, please change the ENABLE_REMOTE_CONTROL flag in
// app/features/conference/components/Conference.js to true as well
const ENABLE_REMOTE_CONTROL = false;

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

// Enable Opus RED field trial.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Audio-Red-For-Opus/Enabled/');

// Wayland: Enable optional PipeWire support.
if (!app.commandLine.hasSwitch('enable-features')) {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

autoUpdater.logger = require('electron-log');
autoUpdater.logger.transports.file.level = 'info';

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
const appProtocolSurplus = `${config.default.appProtocolPrefix}://`;
let pendingStartupDeepLink = null;

/**
 * Resolves the absolute path to the application icon based on the current platform
 *
 * @param {string} [format] - Optional format override (e.g., 'png').
 * @returns {string} The absolute path to the icon file (.ico for Windows, .png for others).
 */
const getIconPath = format => {
    const ext = format || (process.platform === 'win32' ? 'ico' : 'png');
    const name = `icon.${ext}`;

    // 1. Try Development Root (Where you run npm start)
    const devPath = path.join(process.cwd(), 'resources', name);

    if (fs.existsSync(devPath)) {
        return devPath;
    }

    // 2. Try Relative to main.js (Moving up from build folder)
    const relativePath = path.resolve(__dirname, '..', 'resources', name);

    if (fs.existsSync(relativePath)) {
        return relativePath;
    }

    // 3. Try Production Path (Packaged app)
    if (process.resourcesPath) {
        const prodPath = path.join(process.resourcesPath, name);

        if (fs.existsSync(prodPath)) {
            return prodPath;
        }
    }

    // 4. Ultimate Fallback: try app.getAppPath() but strip 'build' if present
    let appPath = app.getAppPath();

    if (appPath.endsWith('build')) {
        appPath = path.resolve(appPath, '..');
    }

    return path.join(appPath, 'resources', name);
};

/**
 * Shows a native About dialog with version and environment info.
 */
function showAboutDialog() {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: `About ${app.name}`,
        message: app.name,
        detail: [
            `Version: ${app.getVersion()}`,
            `Electron: ${process.versions.electron}`,
            `Chrome: ${process.versions.chrome}`,
            `Node: ${process.versions.node}`,
            `Platform: ${process.platform} ${process.arch}`
        ].join('\n'),
        buttons: [ 'OK' ]
    });
}

/**
 * Triggers a manual update check and reports the result to the user.
 */
function checkForUpdatesManually() {
    autoUpdater.checkForUpdates()
        .then(result => {
            if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'No Updates Available',
                    message: `You're on the latest version (${app.getVersion()}).`,
                    buttons: [ 'OK' ]
                });
            }

            // If an update IS available, the existing autoUpdater event
            // handlers (update-available → update-downloaded) take over.
        })
        .catch(err => {
            console.error('Manual update check failed:', err);
            dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Update Check Failed',
                message: 'Could not check for updates. Please try again later.',
                detail: err.message,
                buttons: [ 'OK' ]
            });
        });

    capture('update_check_manual');
}

/**
 * Sets the application menu.
 *
 * macOS: app-name menu with About, Check for Updates, and the standard
 *        system actions (Services, Hide, Quit). Nothing else.
 * Windows: null — the native menu bar is hidden (titleBarStyle:'hidden') and
 *          the custom in-page title bar handles About / Check for Updates.
 */
function setApplicationMenu() {
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);

        return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { label: `About ${app.name}`, click: showAboutDialog },
                { type: 'separator' },
                { label: 'Check for Updates…', click: checkForUpdatesManually },
                { type: 'separator' },
                { role: 'services', submenu: [] },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideothers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [ {
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            },
            {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            },
            {
                type: 'separator'
            },
            {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            },
            {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            },
            {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            },
            {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            } ]
        },
        {
            label: '&Window',
            role: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        },
        {
            label: '&Help',
            role: 'help',
            submenu: [
                {
                    label: 'Guides',
                    click: async () => {
                        await shell.openExternal('https://docs.sonacove.com/');
                    }
                }
            ]
        }
    ]));
}

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

const getTitlebarJS = (iconBase64 = '') => `
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

/**
 * Injects the custom title bar into the currently loaded page (Windows only).
 */
function injectWindowsTitleBar() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    let iconBase64 = '';
    try {
        const iconPath = getIconPath('png');
        if (fs.existsSync(iconPath)) {
            iconBase64 = fs.readFileSync(iconPath).toString('base64');
        }
    } catch (e) {
        console.warn('Failed to load title bar icon:', e);
    }

    mainWindow.webContents.insertCSS(TITLEBAR_CSS).catch(() => {});
    mainWindow.webContents.executeJavaScript(getTitlebarJS(iconBase64)).catch(() => {});
}

/**
 * Opens new window with index.html(Jitsi Meet is loaded in iframe there).
 */
function createJitsiMeetWindow() {
    // Application menu.
    setApplicationMenu();

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
        title: 'Sonacove Meets',
        icon: getIconPath(),
        minWidth: 800,
        minHeight: 600,
        show: false,

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
            preload: isDev
                ? path.resolve(basePath, 'build', 'preload.js')
                : path.resolve(basePath, 'build', 'preload.js'),
            sandbox: false,
            webSecurity: false
        }
    };

    const windowOpenHandler = ({ url, frameName }) => {
        const target = getPopupTarget(url, frameName);

        // Allow URLs on allowed hosts to open inside Electron instead of the browser
        const allowedHosts = sonacoveConfig.currentConfig.allowedHosts || [];

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


    if (!process.mas) {
        // Setup Logger
        autoUpdater.logger = require('electron-log');
        autoUpdater.logger.transports.file.level = 'info';

        // Configure Updater
        autoUpdater.disableWebInstaller = true;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('checking-for-update', () => {
            console.log('🔎 Checking for update...');
        });

        autoUpdater.on('update-available', info => {
            console.log(`✅ Update available: ${info.version}`);
            capture('update_available', {
                new_version: info.version,
                current_version: app.getVersion()
            });
        });

        autoUpdater.on('update-not-available', info => {
            console.log('❌ Update not available.');
        });

        autoUpdater.on('update-downloaded', info => {
            capture('update_downloaded', { new_version: info.version });

            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Update Ready',
                message: `Version ${info.version} has been downloaded. Quit and install now?`,
                buttons: [ 'Yes', 'Later' ]
            }).then(result => {
                if (result.response === 0) {
                    capture('update_install_clicked', { new_version: info.version });
                    autoUpdater.quitAndInstall(false, true);
                } else {
                    capture('update_deferred', { new_version: info.version });
                }
            });
        });

        autoUpdater.on('error', err => {
            console.error('Updater Error:', err);
            capture('update_error', { error_message: err.message });
        });

        // Only check for updates in production
        if (!isDev) {
            autoUpdater.checkForUpdates();
        }
    }

    mainWindow = new BrowserWindow(options);

    // Set icon immediately after creating window for taskbar/PiP
    if (process.platform !== 'darwin') {
        const iconPath = getIconPath();

        console.log(`🎯 Setting window icon: ${iconPath}`);
        if (fs.existsSync(iconPath)) {
            mainWindow.setIcon(iconPath);
        }
    }

    // Prevent Close during Meeting
    mainWindow.webContents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: [ 'Leave', 'Stay' ],
            title: 'Leave Meeting?',
            message: 'You are currently in a meeting. Are you sure you want to quit?',
            defaultId: 0,
            cancelId: 1
        });

        const leave = choice === 0;

        if (leave) {
            event.preventDefault();
        }
    });

    // Picture-in-Picture Auto-Trigger
    const cleanupPip = setupPictureInPicture(mainWindow);

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
            const landingUrl = new URL(sonacoveConfig.currentConfig.landing);

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
            const meetRootUrl = new URL(sonacoveConfig.currentConfig.meetRoot);

            if (parsedUrl.hostname !== meetRootUrl.hostname) {
                event.preventDefault();

                const targetUrl = `${sonacoveConfig.currentConfig.meetRoot}${parsedUrl.pathname}${parsedUrl.search}`;

                setImmediate(() => {
                    mainWindow.loadURL(targetUrl);
                });
            }
        }
    });

    setupSonacoveIPC(ipcMain, mainWindow, {
        showAboutDialog,
        checkForUpdatesManually,
        capture
    });

    windowState.manage(mainWindow);
    mainWindow.loadURL(sonacoveConfig.currentConfig.landing);

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
    if (ENABLE_REMOTE_CONTROL) {
        setupRemoteControlMain(mainWindow);
    }

    // Inject the custom in-page title bar on Windows after each page load.
    if (process.platform !== 'darwin') {
        mainWindow.webContents.on('did-finish-load', injectWindowsTitleBar);
    }

    mainWindow.on('closed', () => {
        // Remove PiP IPC listeners to prevent accumulation on window recreation (macOS).
        cleanupPip();

        // Close the annotation overlay if it is open
        closeOverlay();

        mainWindow = null;
    });
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();

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

    // Listen for all new BrowserWindow creations
    app.on('web-contents-created', (event, contents) => {
        // This handles windows opened via window.open()
        contents.setWindowOpenHandler(({ url }) => {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    icon: iconPath,
                    show: true
                }
            };
        });

        // Listen for window creation on this webContents
        contents.on('new-window', (event, url, frameName, disposition, options) => {
            options.icon = iconPath;
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
    initAnalytics();
    capture('app_launched');

    setupChildWindowIcon();
    createJitsiMeetWindow();

    // Process deeplinks AFTER window creation
    setTimeout(() => {
        processDeepLinkOnStartup();
    }, 500);
});

if (isDev) {
    app.on('ready', createWebRTCInternalsWindow);
}

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

// remove so we can register each time as we run the app.
app.removeAsDefaultProtocolClient(config.default.appProtocolPrefix);

// If we are running a non-packaged version of the app && on windows
if (isDev && process.platform === 'win32') {
    // Set the path of electron.exe and your app.
    // These two additional parameters are only available on windows.
    app.setAsDefaultProtocolClient(
        config.default.appProtocolPrefix,
        process.execPath,
        [ path.resolve(process.argv[1]) ]
    );
} else {
    app.setAsDefaultProtocolClient(config.default.appProtocolPrefix);
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
