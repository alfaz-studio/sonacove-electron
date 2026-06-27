/**
 * Minimal preload for the annotation overlay window.
 *
 * Uses contextBridge (contextIsolation: true) so the overlay page
 * never gets direct access to Node / Electron internals.
 * Only the two IPC channels the overlay actually needs are exposed.
 *
 * The API shape matches window.sonacoveElectronAPI.ipc so the
 * jitsi-meet renderer code (electronApi.ts → getElectronAPI())
 * works without changes.
 */
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_CHANNELS = [
    'toggle-click-through-request', // Main → overlay: Alt+X toggle
    'set-ignore-mouse-events', // Overlay → main: click-through state
    'overlay-theme-update', // Main → overlay: host theme tokens for live recolour
    'overlay-theme-request' // Overlay → main: pull the cached theme on load
];

contextBridge.exposeInMainWorld('sonacoveElectronAPI', {
    captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
    saveScreenshot: (base64Data, filename) => ipcRenderer.invoke('save-screenshot', base64Data, filename),
    showInFolder: filePath => ipcRenderer.send('show-in-folder', filePath),
    ipc: {

        /**
         * Registers a listener for an allowed IPC channel.
         *
         * @param {string} channel - The IPC channel to listen on.
         * @param {Function} listener - Callback invoked with message args.
         * @returns {Function} Unsubscribe function.
         */
        on: (channel, listener) => {
            if (!ALLOWED_CHANNELS.includes(channel)) {
                // Channel not allowed: return a no-op unsubscribe so callers
                // can always invoke the returned function safely.
                return () => {
                    // Nothing was registered, so there is nothing to remove.
                };
            }
            const cb = (_event, ...args) => listener(...args);

            ipcRenderer.on(channel, cb);

            return () => ipcRenderer.removeListener(channel, cb);
        },

        /**
         * Sends a message to the main process on an allowed IPC channel.
         *
         * @param {string} channel - The IPC channel to send on.
         * @param {...*} args - Arguments to pass with the message.
         * @returns {void}
         */
        send: (channel, ...args) => {
            if (!ALLOWED_CHANNELS.includes(channel)) {
                return;
            }
            ipcRenderer.send(channel, ...args);
        }
    }
});
