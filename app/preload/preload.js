const {
    initPopupsConfigurationRender,
    setupPictureInPictureRender,
    setupRemoteControlRender,
    setupPowerMonitorRender
} = require('@jitsi/electron-sdk');
const { ipcRenderer } = require('electron');

// Polyfill Headers API for Paddle SDK
if (typeof Headers === 'undefined') {
    global.Headers = class Headers {
        constructor(init) {
            this._map = new Map();
            
            if (init) {
                if (init instanceof Headers) {
                    for (const [key, value] of init._map) {
                        this._map.set(key, value);
                    }
                } else if (Array.isArray(init)) {
                    for (const [key, value] of init) {
                        this._map.set(key, value);
                    }
                } else if (typeof init === 'object') {
                    for (const key in init) {
                        this._map.set(key, init[key]);
                    }
                }
            }
        }
        
        append(name, value) {
            const existing = this._map.get(name);
            if (existing) {
                this._map.set(name, `${existing}, ${value}`);
            } else {
                this._map.set(name, value);
            }
        }
        
        delete(name) {
            this._map.delete(name);
        }
        
        get(name) {
            return this._map.get(name) || null;
        }
        
        has(name) {
            return this._map.has(name);
        }
        
        set(name, value) {
            this._map.set(name, value);
        }
        
        entries() {
            return this._map.entries();
        }
        
        keys() {
            return this._map.keys();
        }
        
        values() {
            return this._map.values();
        }
        
        forEach(callback, thisArg) {
            this._map.forEach((value, key) => {
                callback.call(thisArg, value, key, this);
            });
        }
        
        *[Symbol.iterator]() {
            for (const [ key, value ] of this._map) {
                yield [ key, value ];
            }
        }
    };
}

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
