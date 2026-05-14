const { BrowserWindow, desktopCapturer, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { getAllowedRevealDirs, getScreenshotsDir, sanitizeOutputFilename } = require('./sonacovePaths');

/**
 * Registers screenshot-related IPC handlers.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @returns {void}
 */
function setupScreenshotIPC(ipcMain) {
    // Full-screen screenshot (for annotation overlay).
    // Captures the screen the calling window is on (multi-monitor aware).
    // Falls back to primary display if the sender window can't be determined.
    ipcMain.handle('capture-screenshot', async (event) => {
        try {
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            const targetDisplay = senderWindow && !senderWindow.isDestroyed()
                ? screen.getDisplayMatching(senderWindow.getBounds())
                : screen.getPrimaryDisplay();
            const { width, height } = targetDisplay.size;
            const scaleFactor = targetDisplay.scaleFactor;

            const sources = await desktopCapturer.getSources({
                types: [ 'screen' ],
                thumbnailSize: {
                    width: Math.round(width * scaleFactor),
                    height: Math.round(height * scaleFactor)
                }
            });

            if (sources.length === 0) {
                return null;
            }

            // Match the target display by display_id (sources[0] isn't guaranteed to be correct on multi-monitor).
            const targetId = String(targetDisplay.id);
            const source = sources.find(s => s.display_id === targetId) || sources[0];

            return source.thumbnail.toDataURL('image/png');
        } catch (error) {
            console.error('❌ Main: Error capturing screenshot:', error);

            return null;
        }
    });

    // Save a screenshot directly to the user's Sonacove screenshots folder
    // (Documents/Sonacove/Screenshots by default, or a custom path from settings).
    ipcMain.handle('save-screenshot', async (_event, base64Data, filename) => {
        try {
            if (typeof base64Data !== 'string' || !base64Data) {
                throw new Error('Invalid base64Data');
            }

            const safeName = sanitizeOutputFilename(filename, '.png');

            if (!safeName) {
                throw new Error('Invalid filename');
            }

            const filePath = path.join(getScreenshotsDir(), safeName);
            const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');

            // Validate full 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A)
            if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50
                || buffer[2] !== 0x4E || buffer[3] !== 0x47 || buffer[4] !== 0x0D
                || buffer[5] !== 0x0A || buffer[6] !== 0x1A || buffer[7] !== 0x0A) {
                throw new Error('Invalid image data: not a valid PNG');
            }

            await fs.promises.writeFile(filePath, buffer);

            return filePath;
        } catch (error) {
            console.error('❌ Main: Error saving screenshot:', error);

            return null;
        }
    });

    // Path allowlist prevents arbitrary path disclosure via this IPC.
    ipcMain.on('show-in-folder', (_event, filePath) => {
        if (typeof filePath !== 'string' || !filePath) return;

        // Normalize separators for consistent comparison on Windows.
        const normalizedPath = path.normalize(filePath);
        const allowedDirs = getAllowedRevealDirs().map(d => path.normalize(d));
        const isAllowed = allowedDirs.some(dir => normalizedPath.startsWith(dir + path.sep));

        if (!isAllowed) {
            console.warn('⚠️ Main: show-in-folder blocked — path outside allowed dirs:', normalizedPath);

            return;
        }
        if (!fs.existsSync(normalizedPath)) {
            console.warn('⚠️ Main: show-in-folder blocked — file does not exist:', normalizedPath);

            return;
        }

        try {
            shell.showItemInFolder(normalizedPath);
        } catch (error) {
            console.error('❌ Main: Error revealing file in folder:', error);
        }
    });
}

module.exports = { setupScreenshotIPC };
