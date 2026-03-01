const { ipcMain, desktopCapturer } = require('electron');

/**
 * Registers the IPC handler for screen-sharing source enumeration.
 *
 * The renderer requests available screens/windows via
 * `ipcRenderer.invoke('jitsi-screen-sharing-get-sources')` and receives
 * an array of `{ id, name, thumbnail: { dataUrl } }` objects.
 *
 * @returns {void}
 */
function setupScreenSharing() {
    ipcMain.handle('jitsi-screen-sharing-get-sources', async (event, options) => {
        const validOptions = {
            types: options?.types || [ 'screen', 'window' ],
            thumbnailSize: options?.thumbnailSize || { width: 300,
                height: 300 },
            fetchWindowIcons: true
        };

        try {
            const sources = await desktopCapturer.getSources(validOptions);

            console.log(`✅ Main: Found ${sources.length} sources`);

            const mappedSources = sources.map(source => {
                return {
                    id: source.id,
                    name: source.name,
                    thumbnail: {
                        dataUrl: source.thumbnail.toDataURL()
                    }
                };
            });

            return mappedSources;
        } catch (error) {
            console.error('❌ Main: Error getting desktop sources:', error);

            return [];
        }
    });
}

module.exports = { setupScreenSharing };
