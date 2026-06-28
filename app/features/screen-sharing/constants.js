/*
 * Shared constants for the screen-sharing component. Process-agnostic, so both
 * the main-process handler and the preload bridge import from here.
 */

// IPC channel (renderer invoke -> main handle) for fetching desktop-capture
// sources. The renderer side is reached via window.APP.API.requestDesktopSources.
const SCREEN_SHARING_GET_SOURCES_CHANNEL = 'screen-sharing:get-sources';

module.exports = { SCREEN_SHARING_GET_SOURCES_CHANNEL };
