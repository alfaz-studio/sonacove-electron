const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jitsiNodeAPI', {
    ipc: {
        send: (channel, data, options) => {
            const validChannels = ['toggle-annotation', 'set-ignore-mouse-events', 'nav-to-home', 'open-external'];
            if (validChannels.includes(channel)) {
                ipcRenderer.send(channel, data, options);
            }
        },
        on: (channel, func) => {
            const validChannels = ['annotation-status', 'toggle-click-through-request', 'auth-token-received', 'auth-logout-complete'];
            if (validChannels.includes(channel)) {
                ipcRenderer.on(channel, (event, ...args) => func(...args));
            }
        }
    }
});
