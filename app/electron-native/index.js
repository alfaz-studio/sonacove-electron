/*
 * Local replacements for the @jitsi/electron-sdk features this app still uses.
 * Each is a thin wrapper over a native Electron API the SDK was merely wrapping.
 * Import from here instead of '@jitsi/electron-sdk'.
 */

const {
    setupPowerMonitorMain,
    POWER_MONITOR_EVENT_CHANNEL,
    QUERY_IDLE_STATE_CHANNEL,
    QUERY_IDLE_TIME_CHANNEL
} = require('./power-monitor');
const { setupWindowOpenHandler } = require('./window-open');

module.exports = {
    setupWindowOpenHandler,
    setupPowerMonitorMain,
    POWER_MONITOR_EVENT_CHANNEL,
    QUERY_IDLE_STATE_CHANNEL,
    QUERY_IDLE_TIME_CHANNEL
};
