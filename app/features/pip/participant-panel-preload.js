const { contextBridge, ipcRenderer } = require('electron');

const { FILMSTRIP_VIDEO } = require('./constants');

/**
 * Minimal preload for the participant PiP panel overlay window.
 *
 * Exposes a safe, narrow API via contextBridge so the panel HTML can:
 *   - Receive JPEG frame data from the main process.
 *   - Notify the main process that the user closed the panel.
 *   - Toggle between horizontal and vertical strip layouts.
 *   - Receive the current orientation from the main process.
 */
contextBridge.exposeInMainWorld('panelPlatform', process.platform);

// Static panel config (feature flags) read once by the renderer at startup.
contextBridge.exposeInMainWorld('panelConfig', { filmstripVideo: FILMSTRIP_VIDEO });

contextBridge.exposeInMainWorld('panelAPI', {
    /**
     * Register a callback that fires whenever a new video frame arrives.
     * Data is an object: { id: string, data: string } where data is a base64 JPEG.
     *
     * @param {function(Object): void} cb - Called with { id, data }.
     * @returns {void}
     */
    onFrame(cb) {
        ipcRenderer.on('pp-frame', (_event, data) => cb(data));
    },

    /**
     * Register a callback that fires when participant metadata updates.
     *
     * @param {function(Array): void} cb - Called with array of participant objects.
     * @returns {void}
     */
    onParticipantsUpdate(cb) {
        ipcRenderer.on('pp-participants-update', (_event, data) => cb(data));
    },

    /**
     * Tell the main process to toggle the local user's microphone.
     */
    toggleAudio() {
        ipcRenderer.send('pp-toggle-audio');
    },

    /**
     * Tell the main process to toggle the local user's camera.
     */
    toggleVideo() {
        ipcRenderer.send('pp-toggle-video');
    },

    /**
     * Restore and focus the main window. If `openPanel` is true, also open
     * the chat panel; otherwise just bring the meeting window forward.
     *
     * @param {boolean} openPanel - Whether to also open the chat panel.
     */
    openChat(openPanel) {
        ipcRenderer.send('pp-open-chat', { openPanel: !!openPanel });
    },

    /**
     * Tell the main process the user clicked the close button.
     *
     * @returns {void}
     */
    close() {
        ipcRenderer.send('pp-close-request');
    },

    /**
     * Register a callback that fires when the main process wants the panel
     * to switch to pill (minimised) mode.
     *
     * @param {function(): void} cb
     * @returns {void}
     */
    onEnterPillMode(cb) {
        ipcRenderer.on('pp-enter-pill-mode', () => cb());
    },

    /**
     * Register a callback that fires when the main process wants the panel
     * to switch back to full panel mode.
     *
     * @param {function(): void} cb
     * @returns {void}
     */
    onEnterPanelMode(cb) {
        ipcRenderer.on('pp-enter-panel-mode', () => cb());
    },

    /**
     * Tell the main process the user clicked the pill to reopen the panel.
     *
     * @returns {void}
     */
    reopen() {
        ipcRenderer.send('pp-reopen-request');
    },

    /**
     * Tell the main process to start moving the window with the cursor.
     * Call on mousedown when in pill mode.
     *
     * @returns {void}
     */
    startWindowDrag() {
        ipcRenderer.send('pp-start-window-drag');
    },

    /**
     * Tell the main process to stop moving the window.
     * Call on mouseup.
     *
     * @returns {void}
     */
    stopWindowDrag() {
        ipcRenderer.send('pp-stop-window-drag');
    },

    /**
     * Tell the main process to end the meeting (leave conference)
     * without restoring the main window.
     *
     * @returns {void}
     */
    endMeeting() {
        ipcRenderer.send('pp-end-meeting');
    },

    /**
     * Notify the main process that pin state changed.
     * Forwarded to jitsi-meet renderer so it can protect pinned
     * participants from dominant speaker swapping.
     *
     * @param {Object} pinned - { participantId: true } map.
     */
    updatePinState(pinned) {
        if (pinned && typeof pinned === 'object' && !Array.isArray(pinned)) {
            // Keep in sync with IPC.PIN_STATE_CHANGED in constants.js
            ipcRenderer.send('pp-pin-state-changed', pinned);
        }
    },

    /**
     * Spotlight: report which participants are currently on-stage (spotlight /
     * split / grid tiles) so the main renderer captures frames + attaches video
     * for exactly those, instead of a fixed top-N.
     *
     * @param {string[]} stageIds - Participant ids currently shown as tiles.
     * @returns {void}
     */
    reportStage(stageIds) {
        if (Array.isArray(stageIds)) {
            ipcRenderer.send('pp-stage-changed', stageIds);
        }
    },

    /**
     * Spotlight: request the window be resized to the panel's measured card
     * size. The renderer owns its layout, so it owns its dimensions.
     *
     * @param {number} width - Desired window width in px.
     * @param {number} height - Desired window height in px.
     * @returns {void}
     */
    setSize(width, height) {
        ipcRenderer.send('pp-set-size', { width,
            height });
    },

    /**
     * Spotlight: persist the panel's layout + auto-follow prefs across sessions.
     *
     * @param {{ layout: string, auto: boolean }} settings - Prefs to persist.
     * @returns {void}
     */
    saveSettings(settings) {
        ipcRenderer.send('pp-save-settings', settings);
    },

    /**
     * Register a callback for the persisted settings, sent once on load.
     *
     * @param {function({ layout: string, auto: boolean }): void} cb - Called with prefs.
     * @returns {void}
     */
    onSettings(cb) {
        ipcRenderer.on('pp-settings', (_event, settings) => cb(settings));
    },
});
