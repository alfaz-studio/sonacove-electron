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
    screen,
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
const { initAnalytics, capture, shutdownAnalytics } = require('./app/features/analytics');
const { initI18n, t } = require('./app/features/i18n');
const {
    showUpdateToast, showLeaveModal, showInfoToast, showAboutPanel
} = require('./app/features/in-app-dialogs');
const { getIconPath, getSplashPath, getErrorPath } = require('./app/features/paths');

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

// Remote control is disabled. The feature requires renderer-side integration
// that was removed with the local renderer app.
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

/**
 * Shows an in-app About panel with version and environment info.
 */
function showAboutDialog() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    showAboutPanel(mainWindow.webContents, {
        appName: app.name,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        platform: `${process.platform} ${process.arch}`
    }, {
        version: t('aboutPanel.version', { version: app.getVersion() }),
        electron: t('aboutPanel.electron'),
        chrome: t('aboutPanel.chrome'),
        node: t('aboutPanel.node'),
        platform: t('aboutPanel.platform'),
        copyright: t('aboutPanel.copyright', { year: new Date().getFullYear() }),
        ok: t('aboutPanel.ok')
    });
}

/**
 * Triggers a manual update check and reports the result to the user.
 */
function checkForUpdatesManually() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const wc = mainWindow.webContents;

    const okLabel = t('infoToast.ok');

    if (isStaging) {
        showInfoToast(wc, {
            title: t('update.stagingTitle'),
            message: t('update.stagingMessage'),
            okLabel
        });

        return;
    }

    showInfoToast(wc, {
        title: t('update.checkingTitle'),
        message: t('update.checkingMessage'),
        okLabel
    });

    autoUpdater.checkForUpdates()
        .then(result => {
            if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
                showInfoToast(wc, {
                    title: t('update.noUpdatesTitle'),
                    message: t('update.noUpdatesMessage', { version: app.getVersion() }),
                    okLabel
                });
            }

            // If an update IS available, the existing autoUpdater event
            // handlers (update-available → update-downloaded) take over.
        })
        .catch(err => {
            console.error('Manual update check failed:', err);
            showInfoToast(wc, {
                title: t('update.checkFailedTitle'),
                message: t('update.checkFailedMessage'),
                type: 'error',
                okLabel
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
                { label: t('menu.about', { appName: app.name }), click: showAboutDialog },
                { type: 'separator' },
                { label: t('menu.checkForUpdates'), click: checkForUpdatesManually },
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
            label: t('menu.edit'),
            submenu: [ {
                label: t('menu.undo'),
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            },
            {
                label: t('menu.redo'),
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            },
            {
                type: 'separator'
            },
            {
                label: t('menu.cut'),
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            },
            {
                label: t('menu.copy'),
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            },
            {
                label: t('menu.paste'),
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            },
            {
                label: t('menu.selectAll'),
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            } ]
        },
        {
            label: t('menu.window'),
            role: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        },
        {
            label: t('menu.help'),
            role: 'help',
            submenu: [
                {
                    label: t('menu.guides'),
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

const TITLEBAR_CSS = ''
    + '#sonacove-titlebar{position:fixed;top:0;left:0;right:0;height:32px;background:#1A1A1A;'
    + 'border-bottom:2px solid;border-image:linear-gradient(90deg,#E8613C,#F59E0B) 1;'
    + '-webkit-app-region:drag;display:flex;align-items:center;padding:0 12px;z-index:2147483647;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;'
    + 'color:#c0c0c0;user-select:none;box-sizing:border-box;}'
    + '#sonacove-titlebar .stb-icon{width:20px;height:20px;margin-right:8px;background-size:contain;'
    + 'background-repeat:no-repeat;background-position:center;}'
    + '#sonacove-titlebar .stb-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '#sonacove-titlebar .stb-menu{display:flex;gap:2px;-webkit-app-region:no-drag;}'
    + '#sonacove-titlebar .stb-btn{background:transparent;border:none;color:#a0a0a0;cursor:pointer;'
    + 'padding:4px 10px;border-radius:4px;font-size:12px;font-family:inherit;line-height:1;'
    + 'transition:background 0.15s ease,color 0.15s ease;}'
    + '#sonacove-titlebar .stb-btn:hover{background:rgba(255,255,255,0.1);color:#fff;}'
    + '#sonacove-titlebar .stb-btn:active{background:rgba(255,255,255,0.18);color:#fff;}'
    + '#sonacove-titlebar .stb-wc{display:flex;-webkit-app-region:no-drag;margin-left:8px;}'
    + '#sonacove-titlebar .stb-wc-btn{background:transparent;border:none;color:#9090A0;cursor:pointer;'
    + 'width:46px;height:30px;display:flex;align-items:center;justify-content:center;'
    + '-webkit-app-region:no-drag;transition:background 0.15s ease,color 0.15s ease;}'
    + '#sonacove-titlebar .stb-wc-btn svg{pointer-events:none;}'
    + '#sonacove-titlebar .stb-wc-btn:hover{background:rgba(255,255,255,0.08);color:#D0D0DA;}'
    + '#sonacove-titlebar .stb-wc-btn:active{background:rgba(255,255,255,0.14);color:#E0E0E6;}'
    + '#sonacove-titlebar .stb-wc-btn.stb-close:hover{background:#e81123;color:#fff;}'
    + 'html{box-sizing:border-box!important;padding-top:34px!important;overflow:hidden!important;}'
    + 'body{height:calc(100vh - 34px)!important;overflow-y:auto!important;}'
    + 'body::-webkit-scrollbar{width:8px;}'
    + 'body::-webkit-scrollbar-track{background:transparent;}'
    + 'body::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:4px;}'
    + 'body::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.3);}';

const getTitlebarJS = (iconBase64 = '', strings = {}) => `
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
    var iconHtml = '';
    if ('${iconBase64}') {
        iconHtml = '<div class="stb-icon" style="background-image: url(\\'data:image/png;base64,${iconBase64}\\')"></div>';
    }
    var minSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    var maxSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2.5" y="2.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
    var closeSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    bar.innerHTML =
        iconHtml +
        '<div class="stb-title">' + (document.title || strings.windowTitle) + '</div>' +
        '<div class="stb-menu">' +
            '<button class="stb-btn" id="stb-about" title="' + strings.aboutTooltip + '">' + strings.about + '</button>' +
            '<button class="stb-btn" id="stb-updates" title="' + strings.checkForUpdatesTooltip + '">' + strings.checkForUpdates + '</button>' +
            '<button class="stb-btn" id="stb-help" title="' + strings.helpTooltip + '">' + strings.help + '</button>' +
        '</div>' +
        '<div class="stb-wc">' +
            '<button class="stb-wc-btn" id="stb-minimize" title="Minimize">' + minSvg + '</button>' +
            '<button class="stb-wc-btn" id="stb-maximize" title="Restore">' + maxSvg + '</button>' +
            '<button class="stb-wc-btn stb-close" id="stb-close" title="Close">' + closeSvg + '</button>' +
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
    var restoreSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="4" y="1.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="1.5" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="#1A1A1A"/></svg>';
    if (window.sonacoveElectronAPI && window.sonacoveElectronAPI.ipc && window.sonacoveElectronAPI.ipc.on) {
        window.sonacoveElectronAPI.ipc.on('titlebar-maximized', function() {
            var btn = document.getElementById('stb-maximize');
            btn.innerHTML = restoreSvg;
            btn.title = 'Restore';
        });
        window.sonacoveElectronAPI.ipc.on('titlebar-unmaximized', function() {
            var btn = document.getElementById('stb-maximize');
            btn.innerHTML = maxSvg;
            btn.title = 'Restore';
        });
    }

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
// Cache the icon base64 at startup rather than re-reading from disk on every navigation.
let _cachedIconBase64 = null;
function getIconBase64() {
    if (_cachedIconBase64 !== null) return _cachedIconBase64;
    try {
        const iconPath = getIconPath('png');
        _cachedIconBase64 = fs.existsSync(iconPath) ? fs.readFileSync(iconPath).toString('base64') : '';
    } catch (e) {
        _cachedIconBase64 = '';
    }
    return _cachedIconBase64;
}

function injectWindowsTitleBar() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const titlebarStrings = {
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
        title: t('app.windowTitle'),
        icon: getIconPath(),
        minWidth: 800,
        minHeight: 600,
        show: false,
        backgroundColor: '#1A1A1A',

        // On Windows, remove the native frame entirely. A fully custom in-page
        // title bar (with window controls) is injected via injectWindowsTitleBar().
        // thickFrame keeps the native resize borders and window shadow.
        ...(process.platform !== 'darwin' ? {
            frame: false,
            thickFrame: true
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

    let pendingUpdateVersion = null;

    if (!process.mas && !isStaging) {
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

        autoUpdater.on('update-not-available', () => {
            console.log('❌ Update not available.');
        });

        autoUpdater.on('update-downloaded', info => {
            capture('update_downloaded', { new_version: info.version });
            pendingUpdateVersion = info.version;

            if (mainWindow && !mainWindow.isDestroyed()) {
                showUpdateToast(mainWindow.webContents, info.version, {
                    title: t('updateToast.title'),
                    message: t('updateToast.message', { version: info.version }),
                    later: t('updateToast.later'),
                    installNow: t('updateToast.installNow')
                });
            }
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

    // Handle update toast responses (placed here with other IPC handlers
    // rather than inside the updater block for consistent cleanup).
    const onUpdateToast = (event, data) => {
        if (event.sender !== mainWindow?.webContents) return;
        if (data && data.action === 'install') {
            capture('update_install_clicked', { new_version: pendingUpdateVersion });
            autoUpdater.quitAndInstall(false, true);
        } else {
            capture('update_deferred', { new_version: pendingUpdateVersion });
        }
    };

    ipcMain.on('update-toast-action', onUpdateToast);

    // Picture-in-Picture Auto-Trigger
    const cleanupPip = setupPictureInPicture(mainWindow);

    // Participant PiP — open overlay when the main window is minimized
    mainWindow.on('minimize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pip-window-minimized');
        }
    });

    mainWindow.on('restore', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pip-window-restored');
        }
    });

    mainWindow.on('focus', () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
            mainWindow.webContents.send('pip-window-restored');
        }
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
        showAboutDialog,
        checkForUpdatesManually,
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
    if (ENABLE_REMOTE_CONTROL) {
        setupRemoteControlMain(mainWindow);
    }

    // Inject the custom in-page title bar on Windows on every page load
    // (including splash/error pages so the frameless window always has controls).
    // dom-ready fires before did-finish-load for faster appearance.
    if (process.platform !== 'darwin') {
        mainWindow.webContents.on('dom-ready', () => {
            mainWindow.webContents.insertCSS(TITLEBAR_CSS).catch(() => {});
            injectWindowsTitleBar();
        });
    }

    // Inject a visible staging banner so testers know they're on a PR build.
    if (isStaging) {
        mainWindow.webContents.on('did-finish-load', () => {
            mainWindow.webContents.insertCSS(`
                #sonacove-staging-banner {
                    position: fixed;
                    bottom: 8px; right: 8px;
                    padding: 2px 8px;
                    background: rgba(217, 119, 6, 0.7);
                    color: #000;
                    border-radius: 4px;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 10px;
                    font-weight: 600;
                    z-index: 2147483647;
                    user-select: none;
                    pointer-events: none;
                    opacity: 0.8;
                }
            `).catch(() => {});
            const bannerText = t('staging.banner', { version: app.getVersion() });

            mainWindow.webContents.executeJavaScript(`
                (function() {
                    if (document.getElementById('sonacove-staging-banner')) return;
                    var banner = document.createElement('div');
                    banner.id = 'sonacove-staging-banner';
                    banner.textContent = ${JSON.stringify(bannerText)};
                    document.body.appendChild(banner);
                })();
            `).catch(() => {});
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
        // Remove PiP IPC listeners to prevent accumulation on window recreation (macOS).
        cleanupPip();

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
