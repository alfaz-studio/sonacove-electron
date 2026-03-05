const { contextBridge, ipcRenderer } = require('electron');

// Track per-channel listeners so we can swap them without the blunt
// removeAllListeners (which would strip Electron-internal listeners).
let downloadProgressHandler = null;
let updaterStatusHandler = null;

contextBridge.exposeInMainWorld('stagingAPI', {
    getStagingPRs: token => ipcRenderer.invoke('get-staging-prs', token),
    downloadBuild: opts => ipcRenderer.invoke('download-build', opts),
    launchBuild: opts => ipcRenderer.invoke('launch-build', opts),
    clearCache: opts => ipcRenderer.invoke('clear-cache', opts),
    getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: settings => ipcRenderer.invoke('save-settings', settings),
    savePROverride: opts => ipcRenderer.invoke('save-pr-override', opts),
    openExternal: url => ipcRenderer.invoke('open-external', url),
    getRepoInfo: () => ipcRenderer.invoke('get-repo-info'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    onDownloadProgress: callback => {
        if (downloadProgressHandler) {
            ipcRenderer.removeListener('download-progress', downloadProgressHandler);
        }
        downloadProgressHandler = (_event, data) => callback(data);
        ipcRenderer.on('download-progress', downloadProgressHandler);
    },
    onUpdaterStatus: callback => {
        if (updaterStatusHandler) {
            ipcRenderer.removeListener('updater-status', updaterStatusHandler);
        }
        updaterStatusHandler = (_event, data) => callback(data);
        ipcRenderer.on('updater-status', updaterStatusHandler);
    }
});
