const { contextBridge, ipcRenderer } = require('electron');

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
     * Tell the main process to open the chat panel in the main window.
     */
    openChat() {
        ipcRenderer.send('pp-open-chat');
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
     * Request the main process to toggle between horizontal and vertical layout.
     *
     * @returns {void}
     */
    toggleOrientation() {
        ipcRenderer.send('pip-toggle-orientation');
    },

    /**
     * Register a callback that fires when the main process confirms an
     * orientation change.
     *
     * @param {function(string): void} cb - Called with 'horizontal' or 'vertical'.
     * @returns {void}
     */
    onOrientationChanged(cb) {
        ipcRenderer.on('pp-orientation-changed', (_event, orientation) => cb(orientation));
    },

    /**
     * Register a callback that fires when the visible tile count changes
     * (user resized the window, or participants changed).
     *
     * @param {function(number): void} cb - Called with the new visible count.
     * @returns {void}
     */
    onVisibleCountChanged(cb) {
        ipcRenderer.on('pp-visible-count-changed', (_event, data) => cb(data));
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
     * Tell the main process to restore and focus the main window,
     * closing the PiP panel.
     *
     * @returns {void}
     */
    focusMainWindow() {
        ipcRenderer.send('pp-focus-main');
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
     * Tell the main process to start an edge resize.
     *
     * @param {string} edge - 'left' | 'right' | 'top' | 'bottom'
     */
    startEdgeResize(edge) {
        ipcRenderer.send('pp-start-edge-resize', { edge });
    },

    /**
     * Tell the main process to stop edge resizing.
     */
    stopEdgeResize() {
        ipcRenderer.send('pp-stop-edge-resize');
    },
});
