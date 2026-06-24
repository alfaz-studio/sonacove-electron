const { contextBridge, ipcRenderer } = require('electron');

// Channel name mirrors IPC_SHARE_BORDER_THEME in ./constants.js — kept in sync
// by hand (same as the controls-bar / PiP preloads; preloads can't cleanly
// require feature modules from a sandboxed context).
const IPC_SHARE_BORDER_THEME = 'sb-theme';

contextBridge.exposeInMainWorld('shareBorderAPI', {
    // Host theme tokens ({ accent, accentHover, … }) → live recolour of the
    // border frame (mirrors the controls-bar onTheme bridge).
    onTheme: callback => {
        const handler = (_event, theme) => callback(theme);

        ipcRenderer.on(IPC_SHARE_BORDER_THEME, handler);

        return () => ipcRenderer.removeListener(IPC_SHARE_BORDER_THEME, handler);
    }
});
