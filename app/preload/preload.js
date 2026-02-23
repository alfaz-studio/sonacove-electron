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
    'jitsi-open-url',
    'open-external',
    'pip-visibility-change',
    'pip-exited',
    'posthog-capture',
    'show-about-dialog',
    'check-for-updates',
    'open-help-docs'
];

ipcRenderer.setMaxListeners(0);

/**
 * Open an external URL.
 *
 * @param {string} url - The URL we with to open.
 * @returns {void}
 */
function openExternalLink(url) {
    ipcRenderer.send('jitsi-open-url', url);
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


/**
 * Send a PostHog event from the renderer process through the main process.
 *
 * @param {string} event - PostHog event name.
 * @param {Object} [properties] - Extra properties to attach.
 * @returns {void}
 */
function captureAnalyticsEvent(event, properties = {}) {
    ipcRenderer.send('posthog-capture', { event,
        properties });
}

window.sonacoveElectronAPI = {
    openExternalLink,
    setupRenderer,
    analytics: { capture: captureAnalyticsEvent },
    ipc: {
        on: (channel, listener) => {
            if (!whitelistedIpcChannels.includes(channel)) {
                return;
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

                console.log(`DEBUG: PRELOAD: Augmenting toggle-annotation. SourceId: ${sourceId}, isWindowSharing: ${isWindow}`);
                args[0].isWindowSharing = isWindow;
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
        console.log('🖥️ Renderer: Requesting desktop sources...', options);

        ipcRenderer.invoke('jitsi-screen-sharing-get-sources', options)
            .then(sources => {
                console.log(`✅ Renderer: Received ${sources.length} sources`);
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
                    console.log('✅ APP.API: Desktop sources obtained:', sources.length);
                    resolve({ sources });
                },
                error => {
                    console.error('❌ APP.API: Error obtaining sources:', error);
                    reject({ error });
                },
                options
        );
    });

    console.log('✅ APP.API.requestDesktopSources registered');
});
