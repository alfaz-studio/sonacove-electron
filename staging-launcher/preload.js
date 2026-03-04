const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stagingAPI', {
    getStagingPRs: token => ipcRenderer.invoke('get-staging-prs', token),
    downloadBuild: opts => ipcRenderer.invoke('download-build', opts),
    launchBuild: opts => ipcRenderer.invoke('launch-build', opts),
    clearCache: opts => ipcRenderer.invoke('clear-cache', opts),
    getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: settings => ipcRenderer.invoke('save-settings', settings),
    openExternal: url => ipcRenderer.invoke('open-external', url),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    onDownloadProgress: callback => {
        ipcRenderer.on('download-progress', (_event, data) => callback(data));
    },
    onUpdaterStatus: callback => {
        ipcRenderer.on('updater-status', (_event, data) => callback(data));
    }
});
