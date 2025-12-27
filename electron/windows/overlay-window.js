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

    // Detect Mac
    const isMac = process.platform === 'darwin';

    annotationWindow = new BrowserWindow({
        x, y, width, height,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        simpleFullscreen: false, 
        enableLargerThanScreen: true,
        roundedCorners: false,
        type: isMac ? 'panel' : 'toolbar', 
        fullscreen: false,
        resizable: false,
        skipTaskbar: true,
        icon: path.join(__dirname, '../../build/icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../../preload.js'),
        }
    });

    if (!isMac) {
        annotationWindow.setAlwaysOnTop(true, "screen-saver");
        annotationWindow.setBounds({ x, y, width, height });
    } else {
        annotationWindow.setAlwaysOnTop(true, "screen-saver"); 
        annotationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        
        annotationWindow.setBounds({ x, y, width, height });
    }

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
