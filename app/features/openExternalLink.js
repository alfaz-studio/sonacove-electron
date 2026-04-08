'use strict';

const { shell } = require('electron');

/**
 * Opens the given link in an external browser.
 *
 * @param {string} link - The link (URL) that should be opened in the external browser.
 * @returns {void}
 */
function openExternalLink(link) {
    let u;

    try {
        u = new URL(link);
    } catch (e) {
        return;
    }

    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
        shell.openExternal(u.href);
    }
}

module.exports = { openExternalLink };
