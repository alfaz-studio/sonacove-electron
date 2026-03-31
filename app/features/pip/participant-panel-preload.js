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
});
