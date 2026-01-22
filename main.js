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
    dialog
} = require('electron');
const contextMenu = require('electron-context-menu');
const isDev = require('electron-is-dev');
const { autoUpdater } = require('electron-updater');
const windowStateKeeper = require('electron-window-state');
const path = require('path');
const process = require('process');
const nodeURL = require('url');

const config = require('./app/features/config');
const sonacoveConfig = require('./app/features/sonacove/config');
const {
    registerProtocol,
    navigateDeepLink,
    setupMacDeepLinkListener,
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
    'ScreenCaptureKitStreamPickerSonoma'
];

app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));

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
 * Sets the application menu. It is hidden on all platforms except macOS because
 * otherwise copy and paste functionality is not available.
 */
function setApplicationMenu() {
    if (process.platform === 'darwin') {
        const template = [ {
            label: app.name,
            submenu: [
                {
                    role: 'services',
                    submenu: []
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideothers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }, {
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
        }, {
            label: '&Window',
            role: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        } ];

        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } else {
        Menu.setApplicationMenu(null);
    }
}

/**
 * Opens new window with index.html(Jitsi Meet is loaded in iframe there).
 */
function createJitsiMeetWindow() {
    // Application menu.
    setApplicationMenu();

    // Check for Updates.
    if (!process.mas) {
        autoUpdater.checkForUpdatesAndNotify();
    }

    // Load the previous window state with fallback to defaults.
    const windowState = windowStateKeeper({
        defaultWidth: 800,
        defaultHeight: 600,
        fullScreen: false
    });

    // Path to root directory.
    const basePath = isDev ? __dirname : app.getAppPath();

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
        icon: path.resolve(basePath, './resources/icon.png'),
        minWidth: 800,
        minHeight: 600,
        show: false,
        webPreferences: {
            enableBlinkFeatures: 'WebAssemblyCSP',
            contextIsolation: false,
            nodeIntegration: false,
            preload: path.resolve(basePath, './build/preload.js'),
            sandbox: false,
            webSecurity: false
        }
    };

    const windowOpenHandler = ({ url, frameName }) => {
        const target = getPopupTarget(url, frameName);

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
        autoUpdater.logger = require('electron-log');
        autoUpdater.logger.transports.file.level = 'info';

        autoUpdater.on('update-downloaded', info => {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Update Ready',
                message: `Version ${info.version} has been downloaded. Quit and install now?`,
                buttons: [ 'Yes', 'Later' ]
            }).then(result => {
                if (result.response === 0) {
                    autoUpdater.quitAndInstall(false, true);
                }
            });
        });

        autoUpdater.on('error', err => {
            console.error('Updater Error:', err);
        });

        autoUpdater.checkForUpdates();
    }

    mainWindow = new BrowserWindow(options);

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

    // Enable Screen Sharing
    mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: [ 'screen', 'window' ] })
        .then(sources => {
            callback({ video: sources[0],
                audio: 'loopback' });
        })
        .catch(err => {
            console.error('Error getting sources:', err);
            callback(null);
        });
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

    setupSonacoveIPC(ipcMain, mainWindow);

    windowState.manage(mainWindow);
    mainWindow.loadURL(sonacoveConfig.currentConfig.landing);

    mainWindow.webContents.setWindowOpenHandler(windowOpenHandler);

    if (isDev) {
        mainWindow.webContents.session.clearCache();
    }

    // Block access to file:// URLs.
    const fileFilter = {
        urls: [ 'file://*' ]
    };

    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(fileFilter, (details, callback) => {
        const requestedPath = path.resolve(nodeURL.fileURLToPath(details.url));
        const appBasePath = path.resolve(basePath);

        if (!requestedPath.startsWith(appBasePath)) {
            callback({ cancel: true });
            console.warn(`Rejected file URL: ${details.url}`);

            return;
        }

        callback({ cancel: false });
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

    initPopupsConfigurationMain(mainWindow);
    setupPictureInPictureMain(mainWindow);
    setupPowerMonitorMain(mainWindow);
    if (ENABLE_REMOTE_CONTROL) {
        setupRemoteControlMain(mainWindow);
    }

    mainWindow.on('closed', () => {
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

    if (
        fullProtocolCall.includes('auth-callback')
        || fullProtocolCall.includes('payload')
        || fullProtocolCall.includes('logout-callback')
    ) {
        console.log('🔐 Auth/logout callback, using navigateDeepLink');
        navigateDeepLink(fullProtocolCall);

        return;
    }

    // Handle standard navigation (like meeting links) directly
    console.log('🚀 Standard navigation, using navigateDeepLink');
    navigateDeepLink(fullProtocolCall);

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
    setupMacDeepLinkListener();
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

/**
 * This is to notify main.js [this] that front app is ready to receive messages.
 */
// Note: Protocol handling now done directly in main process
// No longer need renderer-ready handler for protocol data

/**
 * Handle opening external links in the main process.
 */
ipcMain.on('jitsi-open-url', (event, someUrl) => {
    openExternalLink(someUrl);
});
