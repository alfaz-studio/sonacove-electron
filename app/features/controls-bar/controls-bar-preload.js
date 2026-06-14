const { contextBridge, ipcRenderer } = require('electron');

// Channel names mirror IPC in ./constants.js — kept in sync by hand (same as
// the PiP preload; preloads can't cleanly require feature modules).
contextBridge.exposeInMainWorld('controlsBarAPI', {
    // Expand (true) / collapse (false) — main resizes the window to fit.
    setHover: expanded => ipcRenderer.send('cb-hover', Boolean(expanded)),
    startDrag: () => ipcRenderer.send('cb-start-window-drag'),
    stopDrag: () => ipcRenderer.send('cb-stop-window-drag'),
    stopShare: () => ipcRenderer.send('cb-stop-share'),

    // Click-through: when the cursor is off the capsule, ignore mouse events so
    // clicks fall through the transparent margins to the window behind (the
    // shared screen / meeting). Reuses the shared overlay handler in ipc.js.
    setIgnoreMouse: ignore => ipcRenderer.send('set-ignore-mouse-events', Boolean(ignore)),

    // Conference start timestamp (epoch ms) for the meeting timer. Returns an
    // unsubscribe fn. The listener receives the timestamp (or null) directly.
    onConferenceTimestamp: callback => {
        const handler = (_event, ts) => callback(ts);

        ipcRenderer.on('cb-conference-timestamp', handler);

        return () => ipcRenderer.removeListener('cb-conference-timestamp', handler);
    }
});
