/**
 * IPC channel names for the system-volume feature. Kept in a thin module
 * separate from system-volume.js so the preload can import them without
 * pulling in the `loudness` native CLI dependency that lives at the top
 * of system-volume.js.
 */
const IPC_BROADCAST_CHANNEL = 'system-volume-changed';
const IPC_REQUEST_CHANNEL = 'request-system-volume';
const IPC_SET_MUTED_CHANNEL = 'set-system-volume-muted';
const IPC_SET_VOLUME_CHANNEL = 'set-system-volume';

module.exports = {
    IPC_BROADCAST_CHANNEL,
    IPC_REQUEST_CHANNEL,
    IPC_SET_MUTED_CHANNEL,
    IPC_SET_VOLUME_CHANNEL
};
