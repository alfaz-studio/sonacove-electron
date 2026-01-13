const {
    initPopupsConfigurationRender,
    setupPictureInPictureRender,
    setupRemoteControlRender,
    setupPowerMonitorRender
} = require('@jitsi/electron-sdk');
const { ipcRenderer } = require('electron');

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
    'auth-token-received',
    'auth-logout-complete',
    'cleanup-whiteboards-for-viewers',
    'jitsi-open-url',
    'open-external'
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

window.jitsiNodeAPI = {
    openExternalLink,
    setupRenderer,
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
            ipcRenderer.send(channel, ...args);
        }
    }
};
