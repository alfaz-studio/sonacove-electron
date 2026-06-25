/*
 * Screen-sharing: main-process side.
 *
 * Owns the desktopCapturer source picker. The renderer requests sources via
 * window.APP.API.requestDesktopSources (see ./preload.js), which invokes the
 * SCREEN_SHARING_GET_SOURCES_CHANNEL handled here.
 */

const { desktopCapturer, ipcMain } = require('electron');

const { SCREEN_SHARING_GET_SOURCES_CHANNEL } = require('./constants');

/**
 * Registers the IPC handler that returns available desktop-capture sources
 * (screens and windows) for screen sharing.
 *
 * @returns {Function} Cleanup function that removes the handler.
 */
function setupScreenSharingMain() {
    // removeHandler first so setup is idempotent — ipcMain.handle throws if a
    // handler for the channel already exists (e.g. setup called twice).
    ipcMain.removeHandler(SCREEN_SHARING_GET_SOURCES_CHANNEL);
    ipcMain.handle(SCREEN_SHARING_GET_SOURCES_CHANNEL, async (_event, options) => {
        const validOptions = {
            types: options?.types || [ 'screen', 'window' ],
            thumbnailSize: options?.thumbnailSize || {
                width: 300,
                height: 300
            },
            fetchWindowIcons: true
        };

        try {
            const sources = await desktopCapturer.getSources(validOptions);

            return sources.map(source => {
                return {
                    id: source.id,
                    name: source.name,
                    thumbnail: {
                        dataUrl: source.thumbnail.toDataURL()
                    }
                };
            });
        } catch (error) {
            console.error('❌ Screen sharing: error getting desktop sources:', error);

            return [];
        }
    });

    return () => ipcMain.removeHandler(SCREEN_SHARING_GET_SOURCES_CHANNEL);
}

module.exports = { setupScreenSharingMain };
