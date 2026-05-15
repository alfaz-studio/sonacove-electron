'use strict';

const { BrowserWindow, desktopCapturer, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { openExclusiveFileHandle } = require('./fileWriters');
const { sanitizeOutputFilename } = require('./sanitizers');
const { getAllowedRevealDirs, getScreenshotsDir } = require('./sonacovePaths');

const PNG_EXT = '.png';

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

            const safeName = sanitizeOutputFilename(filename, PNG_EXT);

            if (!safeName) {
                throw new Error('Invalid filename');
            }

            const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');

            // Validate full 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A)
            if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50
                || buffer[2] !== 0x4E || buffer[3] !== 0x47 || buffer[4] !== 0x0D
                || buffer[5] !== 0x0A || buffer[6] !== 0x1A || buffer[7] !== 0x0A) {
                throw new Error('Invalid image data: not a valid PNG');
            }

            // Exclusive open with suffix-on-collision keeps parity with
            // recording.js — two screenshots with the same timestamp can't
            // silently clobber each other.
            const dir = await getScreenshotsDir();
            const baseName = safeName.slice(0, -PNG_EXT.length);
            const { handle, filePath } = await openExclusiveFileHandle(dir, baseName, PNG_EXT);

            try {
                await handle.writeFile(buffer);
            } finally {
                await handle.close();
            }

            return filePath;
        } catch (error) {
            console.error('❌ Main: Error saving screenshot:', error);

            return null;
        }
    });

    // Path allowlist prevents arbitrary path disclosure via this IPC.
    // We resolve realpath on both the target and the allowed dirs before
    // prefix-comparing so a symlink inside an allowed dir can't escape it.
    //
    // ipcMain.on doesn't await the callback, so we delegate to a named async
    // function and attach a top-level .catch so an unexpected rejection (e.g.
    // from the Promise.all of realpaths) can't become a process-level
    // unhandledRejection. The renderer uses .send() here and doesn't expect
    // a response, so swallowing the error after logging is fine.
    ipcMain.on('show-in-folder', (_event, filePath) => {
        handleShowInFolder(filePath).catch(err => {
            console.error('❌ Main: show-in-folder failed:', err);
        });
    });
}

async function handleShowInFolder(filePath) {
    if (typeof filePath !== 'string' || !filePath) return;

    // Resolve the real path of the target. If it doesn't exist yet
    // (showInFolder is sometimes called for an in-flight file), fall back
    // to the normalized input — shell.showItemInFolder will handle the
    // "missing file" case with its own warning.
    let realTarget;

    try {
        realTarget = await fs.promises.realpath(filePath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            realTarget = path.normalize(filePath);
        } else {
            console.warn('⚠️ Main: show-in-folder realpath failed:', err.message);

            return;
        }
    }

    // Realpath the allowed dirs too — on macOS, /var is a symlink to
    // /private/var, and the user's custom override could legitimately
    // sit under such a path.
    const realAllowedDirs = await Promise.all(
        getAllowedRevealDirs().map(async dir => {
            try {
                return await fs.promises.realpath(dir);
            } catch {
                // Dir may not exist yet — fall back to the literal path.
                return dir;
            }
        })
    );

    // Windows paths are case-insensitive — compare lowercased to avoid
    // false negatives if a renderer sends a differently-cased path.
    const isWindows = process.platform === 'win32';
    const norm = s => (isWindows ? s.toLowerCase() : s);
    const target = norm(realTarget);

    // Allow either the dir itself or any descendant of it. The `+ path.sep`
    // boundary prevents a sibling-with-prefix-match attack
    // (e.g. `/foo/bar` against an allowed root of `/foo/ba`); the `===` arm
    // lets a caller reveal an allowed dir itself (not just files inside it).
    const isAllowed = realAllowedDirs.some(dir => {
        const rootNorm = norm(dir);

        return target === rootNorm || target.startsWith(rootNorm + path.sep);
    });

    if (!isAllowed) {
        console.warn('⚠️ Main: show-in-folder blocked — path outside allowed dirs:', filePath);

        return;
    }

    // shell.showItemInFolder handles missing files gracefully (logs a
    // warning, returns false) — no need to pre-check existence. Use
    // `realTarget` (not the raw input) so a symlink-targeted reveal opens
    // the same path the allowlist actually authorised. Side-effect: if a
    // user's recordings dir is itself a symlink (e.g. ~/Documents/Sonacove
    // -> /Volumes/NAS/Sonacove on macOS), Finder/Explorer opens the
    // resolved target rather than the symlink path. Intentional — we'd
    // rather be consistent with the allowlist than preserve the
    // friendlier-looking path.
    try {
        shell.showItemInFolder(realTarget);
    } catch (error) {
        console.error('❌ Main: Error revealing file in folder:', error);
    }
}

module.exports = { setupScreenshotIPC };
