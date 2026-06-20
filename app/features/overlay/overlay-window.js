const { screen, globalShortcut } = require('electron');
const isDev = require('electron-is-dev');

const {
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    IPC_NOTIFY_OVERLAY_CLOSED,
    IPC_NOTIFY_OVERLAY_OPENED,
    IPC_CLEANUP_VIEWER_WHITEBOARDS,
    IPC_ANNOTATION_STATUS,
    ALWAYS_ON_TOP_LEVEL,
    CLOSE_REASON_MANUAL,
    CLOSE_REASON_OVERLAY_CLOSED,
    CLOSE_REASON_SCREENSHARE_STOPPED,
    CLOSE_REASON_DISPLAY_GONE
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
    clearOverlaySessionCors,
    wireEvents,
    overlayWindows
} = require('./window-factory');

// ── Module state ────────────────────────────────────────────────────────────

let annotationWindow = null;

// Cancel handle returned by wireEvents — flushes its load/grace timers. Held so
// the manual-close path (which strips the window's 'closed' listener) can clear
// them immediately instead of leaving them pending in the wireEvents closure.
let overlayCancel = null;

// id of the display the overlay was opened on — tracked so the overlay can
// follow that display's geometry changes and self-close if it's unplugged.
let overlayDisplayId = null;

// Trailing-debounce timer for display-metrics-changed (see onDisplayMetricsChanged).
let metricsDebounceTimer = null;

// Trailing-debounce delay (ms) for coalescing display-metrics bursts.
const METRICS_DEBOUNCE_MS = 200;

// ── Display-change handling ─────────────────────────────────────────────────

/**
 * Re-applies the overlay's geometry to the given display bounds. On Windows the
 * window is pinned fullscreen, so we drop out of fullscreen to move/resize, then
 * re-assert it; macOS positions via setBounds directly.
 *
 * @param {{ x: number, y: number, width: number, height: number }} bounds - Target bounds.
 * @returns {void}
 */
function repositionOverlay(bounds) {
    if (!annotationWindow || annotationWindow.isDestroyed()) {
        return;
    }

    const target = {
        x: Math.floor(bounds.x),
        y: Math.floor(bounds.y),
        width: Math.floor(bounds.width),
        height: Math.floor(bounds.height)
    };

    try {
        if (process.platform === 'darwin') {
            annotationWindow.setBounds(target);
            annotationWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
        } else {
            annotationWindow.setFullScreen(false);
            annotationWindow.setBounds(target);
            annotationWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
            annotationWindow.setFullScreen(true);
        }
    } catch (e) {
        console.error('❌ Failed to reposition overlay after display change:', e);
    }
}

/** Handles a display being removed — self-close if it's the one we're on. */
function onDisplayRemoved(_event, display) {
    if (annotationWindow && display?.id === overlayDisplayId) {
        console.warn('⚠️ Overlay display removed — closing overlay.');
        closeOverlay(true, CLOSE_REASON_DISPLAY_GONE);
    }
}

/**
 * Handles our display's metrics changing (resolution/scale) — refit or self-close.
 *
 * `display-metrics-changed` fires in rapid bursts for a single change, and the
 * Windows reposition path toggles fullscreen off/on (visible flicker, and races
 * if a new event lands mid-toggle). We coalesce the burst with a short trailing
 * debounce and re-validate the window/display when it finally fires.
 */
function onDisplayMetricsChanged(_event, display, changedMetrics) {
    if (!annotationWindow || display?.id !== overlayDisplayId) {
        return;
    }
    if (!changedMetrics?.includes('bounds') && !changedMetrics?.includes('scaleFactor')) {
        return;
    }

    if (metricsDebounceTimer) {
        clearTimeout(metricsDebounceTimer);
    }
    metricsDebounceTimer = setTimeout(() => {
        metricsDebounceTimer = null;

        // The window may have been torn down during the debounce window.
        if (!annotationWindow || annotationWindow.isDestroyed()) {
            return;
        }

        const target = screen.getAllDisplays().find(d => d.id === overlayDisplayId);

        if (!target) {
            closeOverlay(true, CLOSE_REASON_DISPLAY_GONE);

            return;
        }
        repositionOverlay(target.bounds);
    }, METRICS_DEBOUNCE_MS);
}

let displayListenersAttached = false;

/** Subscribe to display changes while the overlay is open. */
function attachDisplayListeners() {
    if (displayListenersAttached) {
        return;
    }
    screen.on('display-removed', onDisplayRemoved);
    screen.on('display-metrics-changed', onDisplayMetricsChanged);
    displayListenersAttached = true;
}

/** Remove display-change subscriptions once the overlay is gone. */
function detachDisplayListeners() {
    if (!displayListenersAttached) {
        return;
    }
    screen.removeListener('display-removed', onDisplayRemoved);
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
    displayListenersAttached = false;
}

/**
 * Shared global-state teardown run by both close paths — the manual
 * {@link closeOverlay} and the window's own 'closed' handler. Idempotent.
 *
 * @returns {void}
 */
function teardownOverlayState() {
    globalShortcut.unregister(SHORTCUT_TOGGLE_CLICK_THROUGH);
    detachDisplayListeners();
    clearOverlaySessionCors();
    if (metricsDebounceTimer) {
        clearTimeout(metricsDebounceTimer);
        metricsDebounceTimer = null;
    }
    overlayDisplayId = null;
}

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

    // Already open — don't create a second window
    if (annotationWindow) {
        return;
    }

    // Validate required data (guard skipped when annotationsUrl is present)
    if (!annotationsUrl && (!collabDetails?.roomId || !collabDetails?.roomKey || !data.roomUrl)) {
        console.error('❌ Cannot open annotation: Missing Collab Details or roomUrl.');

        return;
    }

    // Resolve the target screen
    const activeMainWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : getMainWindow();
    const displayBounds = activeMainWindow
        ? activeMainWindow.getBounds()
        : screen.getPrimaryDisplay().bounds;
    const currentScreen = screen.getDisplayMatching(displayBounds);

    overlayDisplayId = currentScreen.id;

    if (isDev) {
        console.log(
            `🖌️ Launching Overlay on Screen: ${currentScreen.label}`
            + ` at ${currentScreen.bounds.x},${currentScreen.bounds.y}`
            + ` (${currentScreen.bounds.width}x${currentScreen.bounds.height})`
        );
    }

    // Resolve preload, create window, configure platform
    const preloadPath = resolvePreloadPath();

    if (!preloadPath) {
        console.error('❌ Cannot open annotation: overlay preload script not found.');

        return;
    }

    annotationWindow = createOverlayWindow(currentScreen.bounds, preloadPath);
    configurePlatform(annotationWindow, currentScreen.bounds, { collabEnabled: data.collabEnabled });

    // Load URL, register shortcut, wire events
    const overlayUrl = buildOverlayUrl(data);

    if (!overlayUrl) {
        annotationWindow.destroy();
        annotationWindow = null;

        return;
    }

    annotationWindow.loadURL(overlayUrl);

    // Surface a dead toggle shortcut (another app already owns Alt+X) so the
    // user isn't left wondering why Draw-mode toggling does nothing.
    if (!registerShortcut(annotationWindow)) {
        sendToMainWindow(IPC_ANNOTATION_STATUS, { type: 'shortcut-unavailable' });
    }

    overlayCancel = wireEvents(annotationWindow, data.collabServerUrl, {
        onClosed: () => {
            annotationWindow = null;
            overlayCancel = null;
            teardownOverlayState();
            restoreMainWindow();
            sendToMainWindow(IPC_NOTIFY_OVERLAY_CLOSED, {
                reason: CLOSE_REASON_OVERLAY_CLOSED,
                timestamp: Date.now()
            });
        },

        // Load failure / crash / hang — tear down with the specific reason so the
        // renderer can drop its "annotating" state and warn the presenter. Deferred
        // to the next tick: these fire from inside the overlay's own webContents
        // handlers, where a synchronous destroy() can be fragile.
        onFailure: reason => setImmediate(() => closeOverlay(true, reason)),

        // Fires once the overlay has loaded and is shown — the real "annotation
        // is up" moment (a few seconds after the toggle), used to settle the
        // controls bar's Annotate button and clear its loading spinner.
        onShown: () => {
            sendToMainWindow(IPC_NOTIFY_OVERLAY_OPENED, {
                timestamp: Date.now()
            });
        }
    });

    attachDisplayListeners();
}

/**
 * Closes the annotation overlay window.
 *
 * @param {boolean} [notifyOthers=false] - Whether to notify the renderer that the overlay closed.
 * @param {string} [reason='manual'] - The reason for closing.
 * @returns {void}
 */
function closeOverlay(notifyOthers = false, reason = CLOSE_REASON_MANUAL) {
    teardownOverlayState();

    if (annotationWindow) {
        if (isDev) {
            console.log(`🧹 Closing annotation overlay. Reason: ${reason}`);
        }

        // Remove the 'closed' listener before destroy to prevent double-notify:
        // destroy() fires 'closed' → cleanup → notify, then we'd notify again below.
        // Explicitly remove from overlayWindows since the 'closed' listener that
        // would do this is being stripped by removeAllListeners.
        // Flush the wireEvents timers now — removeAllListeners('closed') below
        // strips the 'closed' handler that would otherwise clear them.
        overlayCancel?.();
        overlayCancel = null;

        overlayWindows.delete(annotationWindow);
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
    closeViewersWhiteboards
};
