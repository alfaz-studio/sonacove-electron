/**
 * Screenshare border — IPC channel constants.
 *
 * Phase 1: a passive, click-through, content-protected orange frame drawn around
 * the shared DISPLAY while the Electron presenter shares a full screen (not a
 * window). Excluded from the capture stream so viewers never see it.
 */

/** @type {string} IPC channel pushing host theme tokens to the border (main → border). */
const IPC_SHARE_BORDER_THEME = 'sb-theme';

/** @type {string} Preload script filename for the border window. */
const SHARE_BORDER_PRELOAD_FILENAME = 'share-border-preload.js';

/** @type {string} Static HTML filename for the border window. */
const SHARE_BORDER_HTML_FILENAME = 'share-border.html';

module.exports = {
    IPC_SHARE_BORDER_THEME,
    SHARE_BORDER_PRELOAD_FILENAME,
    SHARE_BORDER_HTML_FILENAME
};
