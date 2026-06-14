const { contextBridge, ipcRenderer } = require('electron');

// Channel names mirror IPC in ./constants.js — kept in sync by hand (same as
// the PiP preload; preloads can't cleanly require feature modules).
contextBridge.exposeInMainWorld('controlsBarAPI', {
    // Expand (true) / collapse (false) — main resizes the window to fit.
    setHover: expanded => ipcRenderer.send('cb-hover', Boolean(expanded)),
    startDrag: () => ipcRenderer.send('cb-start-window-drag'),
    stopDrag: () => ipcRenderer.send('cb-stop-window-drag'),
    stopShare: () => ipcRenderer.send('cb-stop-share')
});
