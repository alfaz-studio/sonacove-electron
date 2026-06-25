/*
 * Power / presence monitor for the main process.
 *
 * Replaces @jitsi/electron-sdk's `powermonitor` module. The SDK bridged OS power
 * events into a cross-origin Jitsi iframe via `postis`; this app loads the meet
 * frontend directly (no iframe), so that transport is obsolete here. Instead we
 * forward the same `electron.powerMonitor` events to the renderer over plain IPC
 * and expose idle-state queries via `ipcMain.handle`.
 *
 * SCAFFOLD: the main side is complete, but no renderer code subscribes yet, so
 * this is currently inert. To make it functional, the frontend must listen on
 * POWER_MONITOR_EVENT_CHANNEL (already whitelisted in the preload) and/or invoke
 * the idle-query channels.
 *
 * Must be called after the Electron app is ready (powerMonitor requires it).
 */

const { ipcMain, powerMonitor } = require('electron');

// Main -> renderer: pushed when an OS power/presence event fires.
const POWER_MONITOR_EVENT_CHANNEL = 'power-monitor-event';

// Renderer -> main (invoke): on-demand idle status queries.
const QUERY_IDLE_STATE_CHANNEL = 'power-monitor:query-idle-state';
const QUERY_IDLE_TIME_CHANNEL = 'power-monitor:query-idle-time';

// OS power/presence events relayed to the renderer. Mirrors the set the SDK
// forwarded; events that a given platform never emits are simply never fired.
const POWER_MONITOR_EVENTS = [
    'suspend',
    'resume',
    'lock-screen',
    'unlock-screen',
    'on-ac',
    'on-battery',
    'shutdown'
];

/**
 * Wires Electron's powerMonitor to the renderer over IPC.
 *
 * @param {BrowserWindow} mainWindow - The window hosting the meet app.
 * @returns {Function} Cleanup function that removes all listeners and handlers
 * (call on window close; important on macOS where windows are recreated).
 */
function setupPowerMonitorMain(mainWindow) {
    const forwarders = POWER_MONITOR_EVENTS.map(event => {
        const listener = () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(POWER_MONITOR_EVENT_CHANNEL, { event });
            }
        };

        powerMonitor.on(event, listener);

        return {
            event,
            listener
        };
    });

    ipcMain.handle(QUERY_IDLE_STATE_CHANNEL, (_event, idleThreshold) =>
        powerMonitor.getSystemIdleState(idleThreshold));
    ipcMain.handle(QUERY_IDLE_TIME_CHANNEL, () => powerMonitor.getSystemIdleTime());

    return () => {
        forwarders.forEach(({ event, listener }) => powerMonitor.removeListener(event, listener));
        ipcMain.removeHandler(QUERY_IDLE_STATE_CHANNEL);
        ipcMain.removeHandler(QUERY_IDLE_TIME_CHANNEL);
    };
}

module.exports = {
    setupPowerMonitorMain,
    POWER_MONITOR_EVENT_CHANNEL,
    QUERY_IDLE_STATE_CHANNEL,
    QUERY_IDLE_TIME_CHANNEL
};
