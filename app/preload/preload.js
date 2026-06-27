const { ipcRenderer } = require('electron');

const {
    setupScreenSharingPreload,
    getLastScreenshareSourceId,
    clearLastScreenshareSourceId
} = require('../features/screen-sharing/preload');
const {
    IPC_BROADCAST_CHANNEL,
    IPC_REQUEST_CHANNEL,
    IPC_SET_MUTED_CHANNEL,
    IPC_SET_VOLUME_CHANNEL
} = require('../features/system-volume-channels');

// Load Polyfills
require('./polyfills');

// Channels the renderer is allowed to both send to main AND receive from main.
// Most app channels are roundtrip — request/response or symmetric command flows.
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
    'notify-overlay-opened',
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
    'pip-stage-changed',
    'pp-participants-update',
    'pp-theme-update',
    'pip-toggle-audio',
    'pip-toggle-video',
    'pip-open-chat',
    'pip-end-meeting',
    'cb-show',
    'cb-hide',
    'cb-stop-screenshare',
    'cb-start-share',
    'cb-sharing-state',
    'cb-toggle-audio',
    'cb-toggle-video',
    'cb-av-state',
    'cb-open-participants',
    'cb-open-chat',
    'cb-counts',
    'cb-toggle-record',
    'cb-toggle-annotate',
    'cb-annotate-state',
    'cb-annotate-ready',
    'cb-recording',
    'cb-toast',
    'cb-open-recording',
    'share-border',
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
    'power-monitor-event',
    IPC_REQUEST_CHANNEL,
    IPC_SET_MUTED_CHANNEL,
    IPC_SET_VOLUME_CHANNEL
];

// Receive-only channels: main → renderer broadcasts. The renderer must be
// able to subscribe via ipc.on, but must not be allowed to ipc.send on them
// (main has no listener — the send would silently go nowhere).
const receiveOnlyIpcChannels = [
    IPC_BROADCAST_CHANNEL
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

// Screen sharing: install the desktop-source picker bridge + getUserMedia
// source-id tracking (app/features/screen-sharing).
setupScreenSharingPreload();

window.sonacoveElectronAPI = {
    openExternalLink,
    captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
    saveScreenshot: (base64Data, filename) => ipcRenderer.invoke('save-screenshot', base64Data, filename),
    showInFolder: filePath => ipcRenderer.send('show-in-folder', filePath),

    // Local recording — chunk-stream protocol. Keeps memory flat for long meetings:
    // the renderer streams each MediaRecorder chunk to disk via main, instead of
    // buffering the whole recording in memory or relying on showSaveFilePicker.
    recording: {
        startWrite: filename => ipcRenderer.invoke('recording:start-write', { filename }),
        writeChunk: (sessionId, chunk) => ipcRenderer.invoke('recording:write-chunk', { sessionId,
            chunk }),
        finishWrite: (sessionId, firstChunkOverride) =>
            ipcRenderer.invoke('recording:finish-write', { sessionId,
                firstChunkOverride }),
        cancelWrite: sessionId => ipcRenderer.invoke('recording:cancel-write', { sessionId })
    },

    // Save-path settings — lets the renderer expose a UI for customizing where
    // recordings and screenshots are saved. Defaults live in Documents/Sonacove/.
    savePaths: {
        get: () => ipcRenderer.invoke('sonacove:get-save-paths'),
        set: next => ipcRenderer.invoke('sonacove:set-save-paths', next),
        pickFolder: options => ipcRenderer.invoke('sonacove:pick-folder', options || {})
    },
    ipc: {
        on: (channel, listener) => {
            if (!whitelistedIpcChannels.includes(channel) && !receiveOnlyIpcChannels.includes(channel)) {
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
        addListener: (channel, listener) => {
            if (!whitelistedIpcChannels.includes(channel) && !receiveOnlyIpcChannels.includes(channel)) {
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
            // Receive-only channels are intentionally not sendable from the renderer.
            if (!whitelistedIpcChannels.includes(channel)) {
                return;
            }

            if (channel === 'toggle-annotation' && args[0] && typeof args[0] === 'object') {
                const sourceId = getLastScreenshareSourceId();
                const isWindow = sourceId ? sourceId.startsWith('window:') : false;

                args[0].isWindowSharing = isWindow;
            }

            if (channel === 'screenshare-stop') {
                clearLastScreenshareSourceId();
            }

            ipcRenderer.send(channel, ...args);
        }
    }
};

