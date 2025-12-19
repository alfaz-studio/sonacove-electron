const { BrowserWindow, screen, globalShortcut } = require('electron');
const path = require('path');

let annotationWindow = null;

function toggleOverlay(mainWindow, data) {
    // If open, close it
    if (annotationWindow) {        
        if (!annotationWindow.isDestroyed()) {
            annotationWindow.destroy();
        }
        
        annotationWindow = null;
        return;
    }

    const { roomUrl, collabDetails, collabServerUrl } = data;

    if (!collabDetails?.roomId || !collabDetails?.roomKey) {
        console.error("❌ Cannot open annotation: Missing Collab Details.");
        return;
    }

    // Get Bounds (Including Taskbar)
    const currentScreen = screen.getDisplayMatching(mainWindow.getBounds());
    const { x, y, width, height } = currentScreen.bounds;

    annotationWindow = new BrowserWindow({
        x, y, width, height,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        fullscreen: false, // False to respect taskbar z-index
        resizable: false,
        skipTaskbar: true, // Key for "Single App" feel
        icon: path.join(__dirname, '../../build/icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            // Adjust path relative to this file
            preload: path.join(__dirname, '../../preload.js'),
        }
    });

    // Windows Fix: Ensure it stays on top of taskbar
    annotationWindow.setAlwaysOnTop(true, "screen-saver");

    // Construct URL
    const joinUrl = new URL(roomUrl);
    joinUrl.searchParams.set('standalone', 'true');
    joinUrl.searchParams.set('whiteboardId', collabDetails.roomId);
    joinUrl.searchParams.set('whiteboardKey', collabDetails.roomKey);
    joinUrl.searchParams.set('whiteboardServer', collabServerUrl);

    console.log(`🖌️ Opening Standalone Whiteboard: ${joinUrl.toString()}`);
    annotationWindow.loadURL(joinUrl.toString());

    globalShortcut.register('Alt+X', () => {
        if (annotationWindow && !annotationWindow.isDestroyed()) {
            annotationWindow.webContents.send('toggle-click-through-request');
        }
    });

    // Cleanup
    annotationWindow.on('closed', () => {
        annotationWindow = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.focus();
        }
    });
}

function closeOverlay() {
    if (annotationWindow) {
        annotationWindow.close();
        annotationWindow = null;
    }
}

module.exports = { toggleOverlay, closeOverlay };
