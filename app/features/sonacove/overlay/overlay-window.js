const { screen, globalShortcut } = require('electron');

const {
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    IPC_NOTIFY_OVERLAY_CLOSED,
    IPC_CLEANUP_VIEWER_WHITEBOARDS,
    CLOSE_REASON_MANUAL,
    CLOSE_REASON_OVERLAY_CLOSED,
    CLOSE_REASON_SCREENSHARE_STOPPED
} = require('./constants');
const {
    getMainWindow,
    sendToMainWindow,
    restoreMainWindow,
    resolvePreloadPath,
    buildOverlayUrl
} = require('./helpers');
const {
    createOverlayWindow,
    configurePlatform,
    registerShortcut,
    wireEvents
} = require('./window-factory');

// ── Module state ────────────────────────────────────────────────────────────

let annotationWindow = null;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Toggles the annotation overlay window (opens it if closed, closes it if open).
 *
 * @param {BrowserWindow} mainWindow - The parent/main window instance.
 * @param {Object} data - Configuration data for the overlay.
 * @returns {void}
 */
function toggleOverlay(mainWindow, data) {
    const { enabled, collabDetails, annotationsUrl, isWindowSharing } = data;

    // Block annotation when sharing a specific window (not entire screen)
    if (isWindowSharing) {
        return;
    }

    // Explicit close or toggle-off
    if (enabled === false || (annotationWindow && enabled !== true)) {
        if (annotationWindow) {
            closeOverlay(true, CLOSE_REASON_MANUAL);
        }

        return;
    }

    // Validate required data (guard skipped when annotationsUrl is present)
    if (!annotationsUrl && (!collabDetails?.roomId || !collabDetails?.roomKey)) {
        console.error('❌ Cannot open annotation: Missing Collab Details.');

        return;
    }

    // Resolve the target screen
    const activeMainWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : getMainWindow();
    const displayBounds = activeMainWindow
        ? activeMainWindow.getBounds()
        : screen.getPrimaryDisplay().bounds;
    const currentScreen = screen.getDisplayMatching(displayBounds);

    console.log(
        `🖌️ Launching Overlay on Screen: ${currentScreen.label}`
        + ` at ${currentScreen.bounds.x},${currentScreen.bounds.y}`
        + ` (${currentScreen.bounds.width}x${currentScreen.bounds.height})`
    );

    // Resolve preload, create window, configure platform
    const preloadPath = resolvePreloadPath();

    annotationWindow = createOverlayWindow(currentScreen.bounds, preloadPath);
    configurePlatform(annotationWindow, currentScreen.bounds);

    // Load URL, register shortcut, wire events
    annotationWindow.loadURL(buildOverlayUrl(data));
    registerShortcut(annotationWindow);
    wireEvents(annotationWindow, {
        onClosed: () => {
            annotationWindow = null;
            globalShortcut.unregister(SHORTCUT_TOGGLE_CLICK_THROUGH);
            restoreMainWindow();
            sendToMainWindow(IPC_NOTIFY_OVERLAY_CLOSED, {
                reason: CLOSE_REASON_OVERLAY_CLOSED,
                timestamp: Date.now()
            });
        }
    });
}

/**
 * Closes the annotation overlay window.
 *
 * @param {boolean} [notifyOthers=false] - Whether to notify the renderer that the overlay closed.
 * @param {string} [reason='manual'] - The reason for closing.
 * @returns {void}
 */
function closeOverlay(notifyOthers = false, reason = CLOSE_REASON_MANUAL) {
    globalShortcut.unregister(SHORTCUT_TOGGLE_CLICK_THROUGH);

    if (annotationWindow) {
        console.log(`🧹 Closing annotation overlay. Reason: ${reason}`);

        // Remove the 'closed' listener before destroy to prevent double-notify:
        // destroy() fires 'closed' → cleanup → notify, then we'd notify again below.
        annotationWindow.removeAllListeners('closed');
        annotationWindow.destroy();
        annotationWindow = null;

        restoreMainWindow();

        if (notifyOthers) {
            sendToMainWindow(IPC_NOTIFY_OVERLAY_CLOSED, {
                reason,
                timestamp: Date.now()
            });
        }
    }
}

/**
 * Retrieves the current annotation overlay window instance.
 *
 * @returns {BrowserWindow|null} The overlay window or null if not open.
 */
function getOverlayWindow() {
    return annotationWindow;
}

/**
 * Notifies the main window to clean up whiteboards for viewers when a screenshare stops.
 *
 * @param {string} sharerId - The ID of the participant who stopped sharing.
 * @returns {void}
 */
function closeViewersWhiteboards(sharerId) {
    sendToMainWindow(IPC_CLEANUP_VIEWER_WHITEBOARDS, {
        sharerId,
        reason: CLOSE_REASON_SCREENSHARE_STOPPED
    });
}

module.exports = {
    toggleOverlay,
    closeOverlay,
    getOverlayWindow,
    getMainWindow,
    closeViewersWhiteboards
};
