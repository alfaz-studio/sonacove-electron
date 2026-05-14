const {
    initPopupsConfigurationRender,
    setupPictureInPictureRender,
    setupRemoteControlRender,
    setupPowerMonitorRender
} = require('@jitsi/electron-sdk');
const { ipcRenderer } = require('electron');

// Load Polyfills
require('./polyfills');

const whitelistedIpcChannels = [
    'protocol-data-msg',
    'renderer-ready',
    'toggle-annotation',
    'set-ignore-mouse-events',
    'nav-to-home',
    'show-overlay',
    'screenshare-stop',
    'annotation-status',
    'toggle-click-through-request',
    'cleanup-whiteboards-for-viewers',
    'notify-overlay-closed',
    'open-external',
    'pip-visibility-change',
    'pip-exited',
    'pip-screenshare-start',
    'pip-screenshare-stop',
    'pip-screenshare-frame',
    'pip-panel-closed',
    'pip-panel-reopened',
    'pip-orientation-changed',
    'pip-resize',
    'pip-window-minimized',
    'pip-window-restored',
    'pp-participants-update',
    'pip-toggle-audio',
    'pip-toggle-video',
    'pip-open-chat',
    'pip-end-meeting',
    'show-about-dialog',
    'check-for-updates',
    'open-help-docs',
    'titlebar-minimize',
    'titlebar-maximize',
    'titlebar-close',
    'titlebar-maximized',
    'titlebar-unmaximized',
    'titlebar-update-available',
    'posthog-capture',
    'retry-load',
    'update-toast-action',
    'leave-modal-action',
    'deeplink-modal-action',
    'cross-window-notification',
    'mac-audio-buffer',
    'mac-audio-error',
    'win-audio-buffer',
    'win-audio-error'
];

// Raise the listener cap — the preload subscribes to many channels across the app
// lifecycle. 50 is generous enough to avoid false positives while still catching leaks.
ipcRenderer.setMaxListeners(50);

/**
 * Open an external URL.
 *
 * @param {string} url - The URL we with to open.
 * @returns {void}
 */
function openExternalLink(url) {
    ipcRenderer.send('open-external', url);
}

/**
 * Setup the renderer process.
 *
 * @param {*} api - API object.
 * @param {*} options - Options for what to enable.
 * @returns {void}
 */
function setupRenderer(api, options = {}) {
    initPopupsConfigurationRender(api);
    if (options.enableRemoteControl) {
        setupRemoteControlRender(api);
    }
    if (options.enableAlwaysOnTopWindow) {
        setupPictureInPictureRender(api);
    }
    setupPowerMonitorRender(api);
}

// Intercept getUserMedia to track the last selected screenshare source
// navigator.mediaDevices may not be available at preload time, so defer the patch
function patchGetUserMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return;
    }
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async constraints => {
        if (constraints && constraints.video && typeof constraints.video === 'object') {
            let sourceId = null;

            if (constraints.video.mandatory && constraints.video.mandatory.chromeMediaSourceId) {
                sourceId = constraints.video.mandatory.chromeMediaSourceId;
            } else if (constraints.video.chromeMediaSourceId) {
                sourceId = constraints.video.chromeMediaSourceId;
            }

            if (sourceId) {
                window._lastScreenshareSourceId = sourceId;
            }
        }

        return originalGetUserMedia(constraints);
    };
}

if (navigator.mediaDevices) {
    patchGetUserMedia();
} else {
    window.addEventListener('DOMContentLoaded', patchGetUserMedia);
}


// Expose synchronously-readable platform info. The renderer can't trust the
// User-Agent for macOS version detection (Apple caps the UA at "Mac OS X
// 10_15_7" forever on macOS 11+) so we shuttle the real `os.release()` over
// here. Read once at preload time — kernel version doesn't change at runtime.
const _osModule = require('os');
const _platformInfo = (() => {
    const release = _osModule.release(); // e.g. "23.4.0" on macOS 14.4
    const releaseParts = release.split('.').map(s => parseInt(s, 10));

    return {
        platform: process.platform, // 'darwin' | 'win32' | 'linux' | …
        // Darwin major: macOS 13 = Darwin 22, macOS 14 = Darwin 23, …
        darwinMajor: process.platform === 'darwin' ? releaseParts[0] : null,
        // Windows build number lives in os.release()'s third dotted segment
        // ("10.0.22621" → 22621). Pre-Windows 10 returns lower numbers.
        winBuild: process.platform === 'win32' ? releaseParts[2] : null,
        release
    };
})();

window.sonacoveElectronAPI = {
    openExternalLink,
    setupRenderer,
    platformInfo: _platformInfo,
    captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
    saveScreenshot: (base64Data, filename) => ipcRenderer.invoke('save-screenshot', base64Data, filename),
    showInFolder: filePath => ipcRenderer.send('show-in-folder', filePath),
    macAudio: {
        // True when the platform reached macOS 13+ AND the addon loaded.
        // The renderer uses this to gate the "Share system audio" UI to the
        // echo-free path; on false, it falls back to the legacy capture
        // path with a "may echo" disclaimer.
        isSupported: () => ipcRenderer.invoke('mac-audio-supported'),

        // Begin capture. Resolves with `{ ok, reason?, message? }`.
        // On `ok: true`, listen for `mac-audio-buffer` (Float32 PCM) and
        // `mac-audio-error` (terminal stream error).
        start: opts => ipcRenderer.invoke('mac-audio-start', opts || {}),
        stop: () => ipcRenderer.invoke('mac-audio-stop')
    },
    winAudio: {
        // True when the platform is Win11 21H2+ (build 22000+) AND the
        // addon loaded. Renderer mirrors macAudio: on true, route through
        // the echo-free WASAPI process-loopback path; on false, fall back
        // to the legacy capture path with a "may echo" disclaimer.
        isSupported: () => ipcRenderer.invoke('win-audio-supported'),

        // Begin capture. Resolves with `{ ok, reason?, message? }`.
        // On `ok: true`, listen for `win-audio-buffer` (Float32 PCM) and
        // `win-audio-error` (terminal stream error).
        start: opts => ipcRenderer.invoke('win-audio-start', opts || {}),
        stop: () => ipcRenderer.invoke('win-audio-stop'),

        // Pre-test diagnostics — gathers Electron's PID tree, Windows
        // version, COM state, and optionally runs the full activation
        // chain WITHOUT starting capture (smoke test). Returns a JSON
        // snapshot the renderer's test-plan runner logs to console.
        diagnostics: opts => ipcRenderer.invoke('win-audio-diagnostics', opts || {})
    },
    ipc: {
        on: (channel, listener) => {
            if (!whitelistedIpcChannels.includes(channel)) {
                return () => {};
            }
            const cb = (_event, ...args) => listener(...args);

            ipcRenderer.on(channel, cb);

            return () => ipcRenderer.removeListener(channel, cb);
        },
        addListener: (channel, listener) => {
            if (!whitelistedIpcChannels.includes(channel)) {
                return;
            }
            const cb = (_event, ...args) => {
                listener(...args);
            };
            const remove = () => {
                ipcRenderer.removeListener(channel, cb);
            };

            ipcRenderer.addListener(channel, cb);

            return remove;
        },

        send: (channel, ...args) => {
            if (!whitelistedIpcChannels.includes(channel)) {
                return;
            }

            if (channel === 'toggle-annotation' && args[0] && typeof args[0] === 'object') {
                const sourceId = window._lastScreenshareSourceId;
                const isWindow = sourceId ? sourceId.startsWith('window:') : false;

                args[0].isWindowSharing = isWindow;
            }

            if (channel === 'screenshare-stop') {
                window._lastScreenshareSourceId = null;
            }

            ipcRenderer.send(channel, ...args);
        }
    }
};

window.JitsiMeetElectron = {
    /**
     * Get sources available for desktop sharing.
     *
     * @param {Function} callback - Callback with sources.
     * @param {Function} errorCallback - Callback for errors.
     * @param {Object} options - Options for getting sources.
     * @param {Array<string>} options.types - Types of sources ('screen', 'window').
     * @param {Object} options.thumbnailSize - Thumbnail dimensions.
     */
    obtainDesktopStreams: (callback, errorCallback, options = {}) => {
        ipcRenderer.invoke('jitsi-screen-sharing-get-sources', options)
            .then(sources => {
                callback(sources);
            })
            .catch(error => {
                console.error('❌ Renderer: Error getting sources:', error);
                if (errorCallback) {
                    errorCallback(error);
                }
            });
    }
};

window.addEventListener('DOMContentLoaded', () => {
    // Ensure APP object exists
    if (!window.APP) {
        window.APP = {};
    }

    if (!window.APP.API) {
        window.APP.API = {};
    }

    window.APP.API.requestDesktopSources = options => new Promise((resolve, reject) => {
        window.JitsiMeetElectron.obtainDesktopStreams(
                sources => {
                    resolve({ sources });
                },
                error => {
                    console.error('❌ APP.API: Error obtaining sources:', error);
                    reject({ error });
                },
                options
        );
    });

});
