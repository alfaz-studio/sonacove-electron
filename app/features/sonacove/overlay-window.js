const { BrowserWindow, screen, globalShortcut, app } = require('electron');
const fs = require('fs');
const path = require('path');

let annotationWindow = null;

/**
 * Finds the main Sonacove application window.
 *
 * @returns {BrowserWindow|undefined} The main window instance.
 */
function getMainWindow() {
    const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());

    // 1. Try by title
    const byTitle = windows.find(w => w.getTitle().includes('Sonacove'));

    if (byTitle) {
        return byTitle;
    }

    // 4. Try by visibility
    const visible = windows.find(w => w.isVisible());

    if (visible) {
        return visible;
    }

    // 5. Fallback
    return windows[0];
}

/**
 * Toggles the annotation overlay window (opens it if closed, closes it if open).
 *
 * @param {BrowserWindow} mainWindow - The parent/main window instance.
 * @param {Object} data - Configuration data for the overlay.
 * @returns {void}
 */
function toggleOverlay(mainWindow, data) {
    const { enabled, roomUrl, collabDetails, collabServerUrl, annotationsUrl, isWindowSharing } = data;

    // Only allow annotation if the user is sharing their entire screen
    if (isWindowSharing) {
        return;
    }

    // Explicit Close OR Toggle if open and no explicit 'enabled'.
    // IMPORTANT: If we are toggling off (enabled !== true), we must return immediately,
    // otherwise we'll fall through and try to reopen with missing details (e.g. empty payload {}).
    if (enabled === false) {
        if (annotationWindow) {
            closeOverlay(true, 'manual');
        }

        return;
    }

    if (annotationWindow && enabled !== true) {
        closeOverlay(true, 'manual');

        return;
    }

    if (!collabDetails?.roomId || !collabDetails?.roomKey) {
        console.error('❌ Cannot open annotation: Missing Collab Details.');

        return;
    }

    // Resolve active window for screen matching
    const activeMainWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : getMainWindow();
    const currentScreen = screen.getDisplayMatching(activeMainWindow ? activeMainWindow.getBounds() : screen.getPrimaryDisplay().bounds);
    const { x, y, width, height } = currentScreen.bounds;
    const isMac = process.platform === 'darwin';

    console.log(`🖌️ Launching Overlay on Screen: ${currentScreen.label} at ${x},${y} (${width}x${height})`);

    const possiblePaths = [
        path.join(app.getAppPath(), 'build', 'preload.js'),
        path.join(app.getAppPath(), 'preload.js'),
        path.join(__dirname, 'preload.js'),
        path.join(__dirname, '..', '..', 'build', 'preload.js'),
        path.join(__dirname, '..', '..', '..', 'build', 'preload.js'),
        path.join(__dirname, '..', '..', '..', '..', 'build', 'preload.js')
    ];

    const preloadPath = possiblePaths.find(p => fs.existsSync(p));

    if (preloadPath) {
        console.log(`✅ Annotation Overlay using preload: ${preloadPath}`);
    } else {
        console.error('❌ CRITICAL: Could not find preload.js! Overlay will be broken.');
        console.error('Searched in:', possiblePaths);
    }

    const windowOptions = {
        x: Math.floor(x),
        y: Math.floor(y),
        width: Math.floor(width),
        height: Math.floor(height),
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        roundedCorners: false,
        fullscreen: !isMac, // Fullscreen helps alignment on Windows/Linux
        resizable: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: '#00000000',
        icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            webSecurity: false,
            sandbox: false,
            preload: preloadPath
        }
    };

    // On macOS, use utility type to hide from Alt+Tab
    if (process.platform === 'darwin') {
        windowOptions.type = 'utility';
    }

    annotationWindow = new BrowserWindow(windowOptions);

    if (isMac) {
        app.dock.show();
        annotationWindow.setAlwaysOnTop(true, 'screen-saver');
        annotationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        annotationWindow.setBounds({
            x: Math.floor(x),
            y: Math.floor(y),
            width: Math.floor(width),
            height: Math.floor(height)
        });
    } else {
        annotationWindow.setAlwaysOnTop(true, 'screen-saver');
        annotationWindow.setFullScreen(true);
    }

    if (annotationsUrl) {
        console.log(`🖌️ Opening Annotations Overlay (annotationsUrl): ${annotationsUrl}`);
        annotationWindow.loadURL(annotationsUrl);
    } else {
        const joinUrl = new URL(roomUrl);

        joinUrl.searchParams.set('standalone', 'true');
        joinUrl.searchParams.set('whiteboardId', collabDetails.roomId);
        joinUrl.searchParams.set('whiteboardKey', collabDetails.roomKey);
        joinUrl.searchParams.set('whiteboardServer', collabServerUrl);

        console.log(`🖌️ Opening Standalone Whiteboard: ${joinUrl.toString()}`);
        annotationWindow.loadURL(joinUrl.toString());
    }

    globalShortcut.register('Alt+X', () => {
        if (annotationWindow && !annotationWindow.isDestroyed()) {
            annotationWindow.webContents.send('toggle-click-through-request');
        }
    });

    annotationWindow.webContents.on('did-finish-load', () => {
        if (annotationWindow && !annotationWindow.isDestroyed()) {
            annotationWindow.show();
            annotationWindow.focus();
        }
    });

    // Cleanup
    const cleanup = (reason = 'overlay-closed') => {
        const mw = getMainWindow();

        restoreMainWindow();

        if (mw && !mw.isDestroyed()) {
            mw.webContents.send('notify-overlay-closed', {
                reason,
                timestamp: Date.now()
            });
            mw.focus();
        }
    };

    annotationWindow.on('closed', () => {
        annotationWindow = null;
        cleanup();
    });
}

/**
 * Closes the annotation overlay window.
 *
 * @param {boolean} notifyOthers - Whether to send a notification to the renderer that the overlay closed.
 * @param {string} reason - The reason for closing (e.g., 'manual', 'screenshare-stopped').
 * @returns {void}
 */
function closeOverlay(notifyOthers = false, reason = 'manual') {
    if (annotationWindow) {
        console.log(`🧹 Closing annotation overlay. Reason: ${reason}`);

        annotationWindow.destroy();
        annotationWindow = null;

        restoreMainWindow();

        if (notifyOthers) {
            const mw = getMainWindow();

            if (mw && !mw.isDestroyed()) {
                mw.webContents.send('notify-overlay-closed', {
                    reason,
                    timestamp: Date.now()
                });
            }
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
    const mw = getMainWindow();

    if (mw && !mw.isDestroyed()) {
        mw.webContents.send('cleanup-whiteboards-for-viewers', {
            sharerId,
            reason: 'screenshare-stopped'
        });
    }
}

/**
 * Forcefully brings the main window back to the front and ensures the Dock icon is visible.
 *
 * @returns {void}
 */
function restoreMainWindow() {
    const mw = getMainWindow();

    // 1. Force the Dock icon to reappear (Mac specific)
    if (process.platform === 'darwin') {
        app.dock.show();
    }

    if (mw && !mw.isDestroyed()) {
        // 2. If it was minimized, restore it
        if (mw.isMinimized()) {
            mw.restore();
        }

        // 3. Force it to be visible (in case it was hidden)
        mw.show();

        // 4. Give it focus
        mw.focus();
    }
}

module.exports = { toggleOverlay,
    closeOverlay,
    getOverlayWindow,
    getMainWindow,
    closeViewersWhiteboards };
