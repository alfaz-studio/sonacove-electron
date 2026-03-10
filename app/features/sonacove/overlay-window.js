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
    return BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.getTitle() === 'Sonacove Meets');
}

/**
 * Toggles the annotation overlay window (opens it if closed, closes it if open).
 *
 * @param {BrowserWindow} mainWindow - The parent/main window instance.
 * @param {Object} data - Configuration data for the overlay.
 * @param {string} data.roomUrl - The base URL for the room.
 * @param {Object} data.collabDetails - The room ID and key for the whiteboard.
 * @param {string} data.collabServerUrl - The server URL for the whiteboard.
 * @returns {void}
 */
function toggleOverlay(mainWindow, data) {
    if (annotationWindow) {
        if (!annotationWindow.isDestroyed()) {
            annotationWindow.destroy();
        }
        annotationWindow = null;

        return;
    }

    const { roomUrl, collabDetails, collabServerUrl, isWindowSharing } = data;

    // Only allow annotation if the user is sharing their entire screen
    if (isWindowSharing) {
        return;
    }

    if (!collabDetails?.roomId || !collabDetails?.roomKey) {
        console.error('❌ Cannot open annotation: Missing Collab Details.');

        return;
    }

    const currentScreen = screen.getDisplayMatching(mainWindow.getBounds());
    const { x, y, width, height } = currentScreen.bounds;
    const isMac = process.platform === 'darwin';

    const possiblePaths = [
        path.join(app.getAppPath(), 'build', 'preload.js'),
        path.join(app.getAppPath(), 'preload.js'),
        path.join(__dirname, 'preload.js'),
        path.join(__dirname, '../../../../build/preload.js')
    ];

    const preloadPath = possiblePaths.find(p => fs.existsSync(p));

    if (preloadPath) {
        console.log(`✅ Annotation Overlay using preload: ${preloadPath}`);
    } else {
        console.error('❌ CRITICAL: Could not find preload.js! Overlay will be broken.');
        console.error('Searched in:', possiblePaths);

        return;
    }

    const windowOptions = {
        x,
        y,
        width,
        height,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        roundedCorners: false,
        fullscreen: false,
        resizable: false,
        skipTaskbar: true,
        show: false,
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

    try {
        annotationWindow = new BrowserWindow(windowOptions);
    } catch (err) {
        console.error('❌ Failed to create annotation overlay window:', err);
        annotationWindow = null;

        return;
    }

    if (isMac) {
        app.dock.show();
        annotationWindow.setAlwaysOnTop(true, 'screen-saver');
        annotationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        annotationWindow.setBounds({ x,
            y,
            width,
            height });

    } else {

        annotationWindow.setAlwaysOnTop(true, 'screen-saver');
        annotationWindow.setBounds({ x,
            y,
            width,
            height });
    }

    const joinUrl = new URL(roomUrl);

    joinUrl.searchParams.set('standalone', 'true');
    joinUrl.searchParams.set('whiteboardId', collabDetails.roomId);
    joinUrl.searchParams.set('whiteboardKey', collabDetails.roomKey);
    joinUrl.searchParams.set('whiteboardServer', collabServerUrl);

    console.log(`🖌️ Opening Standalone Whiteboard: ${joinUrl.toString()}`);
    try {
        annotationWindow.loadURL(joinUrl.toString());
    } catch (err) {
        console.error('❌ Failed to load annotation overlay URL:', err);
        if (annotationWindow && !annotationWindow.isDestroyed()) {
            annotationWindow.destroy();
        }
        annotationWindow = null;

        return;
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

    annotationWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        console.error(`❌ Annotation overlay failed to load: ${errorDescription} (${errorCode})`);
        if (annotationWindow && !annotationWindow.isDestroyed()) {
            annotationWindow.destroy();
        }
        annotationWindow = null;
        cleanup('load-failed');
    });

    annotationWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error('❌ Annotation overlay renderer crashed:', details.reason);
        if (annotationWindow && !annotationWindow.isDestroyed()) {
            annotationWindow.destroy();
        }
        annotationWindow = null;
        cleanup('crashed');
    });

    annotationWindow.on('unresponsive', () => {
        console.error('❌ Annotation overlay became unresponsive');
        if (annotationWindow && !annotationWindow.isDestroyed()) {
            annotationWindow.destroy();
        }
        annotationWindow = null;
        cleanup('unresponsive');
    });

    // Cleanup
    const cleanup = (reason = 'overlay-closed') => {
        try {
            globalShortcut.unregister('Alt+X');
        } catch {
            // Alt+X shortcut already unregistered
        }

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
    closeViewersWhiteboards };
