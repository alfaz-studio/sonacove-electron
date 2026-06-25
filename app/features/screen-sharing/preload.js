/*
 * Screen-sharing: preload / renderer side.
 *
 * Exposes the desktop-source picker to the meet frontend via the globals it
 * expects (window.JitsiMeetElectron.obtainDesktopStreams and
 * window.APP.API.requestDesktopSources), and tracks the selected screenshare
 * source id by patching getUserMedia.
 *
 * The tracked source id is owned here (not a free-floating window global) and
 * read by the preload's annotation logic via getLastScreenshareSourceId().
 */

const { ipcRenderer } = require('electron');

const { SCREEN_SHARING_GET_SOURCES_CHANNEL } = require('./constants');

// Id of the most recently selected screenshare source. getUserMedia is the only
// place the chosen id is observable in the renderer, so we capture it there.
let lastScreenshareSourceId = null;

/**
 * @returns {?string} The id of the last selected screenshare source, or null.
 */
function getLastScreenshareSourceId() {
    return lastScreenshareSourceId;
}

/**
 * Clears the tracked screenshare source id. Call when sharing stops.
 *
 * @returns {void}
 */
function clearLastScreenshareSourceId() {
    lastScreenshareSourceId = null;
}

/**
 * Intercepts getUserMedia to capture the selected screenshare source id.
 *
 * @returns {void}
 */
function patchGetUserMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return;
    }
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = constraints => {
        if (constraints && constraints.video && typeof constraints.video === 'object') {
            let sourceId = null;

            if (constraints.video.mandatory && constraints.video.mandatory.chromeMediaSourceId) {
                sourceId = constraints.video.mandatory.chromeMediaSourceId;
            } else if (constraints.video.chromeMediaSourceId) {
                sourceId = constraints.video.chromeMediaSourceId;
            }

            if (sourceId) {
                lastScreenshareSourceId = sourceId;
            }
        }

        return originalGetUserMedia(constraints);
    };
}

/**
 * Installs the renderer-side screen-sharing bridge: the getUserMedia patch plus
 * the window.JitsiMeetElectron / window.APP.API.requestDesktopSources globals
 * the meet frontend uses to fetch desktop-capture sources.
 *
 * Must be called at preload module-eval time to preserve the timing the
 * frontend relies on (window.APP.API.requestDesktopSources is set on
 * DOMContentLoaded, before the frontend reads it).
 *
 * @returns {void}
 */
function setupScreenSharingPreload() {
    // navigator.mediaDevices may be unavailable at preload time, so defer if needed.
    if (navigator.mediaDevices) {
        patchGetUserMedia();
    } else {
        window.addEventListener('DOMContentLoaded', patchGetUserMedia);
    }

    window.JitsiMeetElectron = {
        /**
         * Get sources available for desktop sharing.
         *
         * @param {Function} callback - Callback with sources.
         * @param {Function} errorCallback - Callback for errors.
         * @param {Object} options - Options for getting sources.
         * @returns {void}
         */
        obtainDesktopStreams: (callback, errorCallback, options = {}) => {
            ipcRenderer.invoke(SCREEN_SHARING_GET_SOURCES_CHANNEL, options)
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
}

module.exports = {
    setupScreenSharingPreload,
    getLastScreenshareSourceId,
    clearLastScreenshareSourceId
};
