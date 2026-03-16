const { app, desktopCapturer, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Registers screenshot-related IPC handlers.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @returns {void}
 */
function setupScreenshotIPC(ipcMain) {
    // Full-screen screenshot (for annotation overlay).
    ipcMain.handle('capture-screenshot', async () => {
        try {
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width, height } = primaryDisplay.size;
            const scaleFactor = primaryDisplay.scaleFactor;

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

            // Match the primary display by display_id (sources[0] isn't guaranteed to be primary on multi-monitor).
            const primaryId = String(primaryDisplay.id);
            const source = sources.find(s => s.display_id === primaryId) || sources[0];

            return source.thumbnail.toDataURL('image/png');
        } catch (error) {
            console.error('❌ Main: Error capturing screenshot:', error);

            return null;
        }
    });

    // Save a screenshot directly to the user's Pictures/Sonacove Screenshots folder.
    ipcMain.handle('save-screenshot', async (_event, base64Data, filename) => {
        try {
            if (typeof base64Data !== 'string' || !base64Data) {
                throw new Error('Invalid base64Data');
            }
            if (typeof filename !== 'string' || !filename) {
                throw new Error('Invalid filename');
            }

            // Sanitize filename: strip directory components and enforce .png extension
            let safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');

            if (!safeName || safeName === '.png' || !safeName.endsWith('.png')) {
                throw new Error('Invalid filename: must be a non-empty name ending with .png');
            }

            // Enforce filesystem filename length limit (255 bytes on most OSes)
            if (safeName.length > 255) {
                safeName = safeName.slice(0, -4); // strip .png
                safeName = safeName.slice(0, 251) + '.png';
            }

            const dir = path.join(app.getPath('pictures'), 'Sonacove Screenshots');

            await fs.promises.mkdir(dir, { recursive: true });

            const filePath = path.join(dir, safeName);
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

    // Reveal a file in the OS file explorer.
    // Only allow paths inside the screenshots directory to prevent arbitrary path disclosure.
    ipcMain.on('show-in-folder', (_event, filePath) => {
        if (typeof filePath !== 'string' || !filePath) return;

        const screenshotsDir = path.join(app.getPath('pictures'), 'Sonacove Screenshots');

        // Normalize separators for consistent comparison on Windows.
        const normalizedPath = path.normalize(filePath);

        if (!normalizedPath.startsWith(screenshotsDir + path.sep)) return;
        if (!fs.existsSync(normalizedPath)) return;

        shell.showItemInFolder(normalizedPath);
    });
}

module.exports = { setupScreenshotIPC };
