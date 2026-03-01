const {
    initPopupsConfigurationMain,
    setupPictureInPictureMain,
    setupRemoteControlMain,
    setupPowerMonitorMain
} = require('@jitsi/electron-sdk');
const {
    BrowserWindow,
    app,
    ipcMain,
    dialog
} = require('electron');
const isDev = require('electron-is-dev');
const windowStateKeeper = require('electron-window-state');
const fs = require('fs');
const path = require('path');
const process = require('process');

const config = require('./app/features/config');
const {
    setupCommandLineSwitches,
    setupContextMenu,
    setupDevReload
} = require('./app/features/main-window/app-setup');
const {
    showAboutDialog,
    checkForUpdatesManually,
    setupAutoUpdater
} = require('./app/features/main-window/auto-updater');
const { getIconPath } = require('./app/features/main-window/icon');
const { setApplicationMenu } = require('./app/features/main-window/menu');
const {
    createWindowOpenHandler,
    setupNavigation
} = require('./app/features/main-window/navigation');
const { setupScreenSharing } = require('./app/features/main-window/screen-sharing');
const { setupSecurity } = require('./app/features/main-window/security');
const { injectWindowsTitleBar } = require('./app/features/main-window/windows-titlebar');
const { setupPictureInPicture } = require('./app/features/pip/main');
const { initAnalytics, capture, shutdownAnalytics } = require('./app/features/sonacove/analytics');
const sonacoveConfig = require('./app/features/sonacove/config');
const {
    registerProtocol,
    navigateDeepLink,
    processDeepLinkOnStartup
} = require('./app/features/sonacove/deep-link');
const { setupSonacoveIPC } = require('./app/features/sonacove/ipc');
const { closeOverlay } = require('./app/features/sonacove/overlay/overlay-window');

// ── Early setup ─────────────────────────────────────────────────────────────

// Track the time the app process started for session duration calculation.
const appLaunchTime = Date.now();

// Set app user model ID at the very top for Windows icon support
if (process.platform === 'win32') {
    app.setAppUserModelId('com.sonacove.meet');
}

registerProtocol();
setupCommandLineSwitches();
setupContextMenu();
setupDevReload();

// For enabling remote control, please change the ENABLE_REMOTE_CONTROL flag in
// app/features/conference/components/Conference.js to true as well
const ENABLE_REMOTE_CONTROL = false;

// ── Module state ────────────────────────────────────────────────────────────

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

// ── Main window creation ────────────────────────────────────────────────────

/**
 * Opens new window with index.html(Jitsi Meet is loaded in iframe there).
 */
function createJitsiMeetWindow() {
    // Application menu.
    setApplicationMenu({
        onAbout: () => showAboutDialog(mainWindow),
        onCheckUpdates: () => checkForUpdatesManually(mainWindow, capture)
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
            preload: path.resolve(basePath, 'build', 'preload.js'),
            sandbox: false,
            webSecurity: false
        }
    };

    const windowOpenHandler = createWindowOpenHandler();

    mainWindow = new BrowserWindow(options);

    // Auto-Updater
    setupAutoUpdater(mainWindow, capture);

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
    setupScreenSharing();

    // Navigation Router (Dashboard -> Meeting)
    setupNavigation(mainWindow);

    setupSonacoveIPC(ipcMain, {
        showAboutDialog: () => showAboutDialog(mainWindow),
        checkForUpdatesManually: () => checkForUpdatesManually(mainWindow, capture),
        capture
    });

    windowState.manage(mainWindow);
    mainWindow.loadURL(sonacoveConfig.currentConfig.landing);

    if (isDev) {
        mainWindow.webContents.session.clearCache();
    }

    // Security handlers (CORS, CSP, file URL blocking, permissions)
    setupSecurity(mainWindow, basePath);

    // SDK plugin registrations
    initPopupsConfigurationMain(mainWindow, windowOpenHandler);
    setupPictureInPictureMain(mainWindow);
    setupPowerMonitorMain(mainWindow);
    if (ENABLE_REMOTE_CONTROL) {
        setupRemoteControlMain(mainWindow);
    }

    // Inject the custom in-page title bar on Windows after each page load.
    if (process.platform !== 'darwin') {
        mainWindow.webContents.on('did-finish-load', () => {
            injectWindowsTitleBar(mainWindow, getIconPath);
        });
    }

    mainWindow.on('closed', () => {
        // Remove PiP IPC listeners to prevent accumulation on window recreation (macOS).
        cleanupPip();

        // Close the annotation overlay if it is open
        closeOverlay(false, 'app-shutdown');

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

// ── Child window icon ───────────────────────────────────────────────────────

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
    });
};

// ── WebRTC internals (debug) ────────────────────────────────────────────────

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

// ── Protocol handling ───────────────────────────────────────────────────────

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

// ── Single instance lock ────────────────────────────────────────────────────

/**
 * Force Single Instance Application.
 * Handle this on darwin via LSMultipleInstancesProhibited in Info.plist as below does not work on MAS
 */
const gotInstanceLock = process.platform === 'darwin' ? true : app.requestSingleInstanceLock();

if (!gotInstanceLock) {
    app.quit();
    process.exit(0);
}

// ── App lifecycle events ────────────────────────────────────────────────────

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

// ── Protocol client registration ────────────────────────────────────────────

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
