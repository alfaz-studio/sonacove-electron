const fs = require('fs');

const { getIconPath } = require('../paths');

let _cachedIconBase64 = null;

/**
 * Returns the app icon as a base64-encoded PNG string.
 * Caches the result so the file is only read once.
 */
function getIconBase64() {
    if (_cachedIconBase64 !== null) return _cachedIconBase64;
    try {
        const iconPath = getIconPath('png');
        _cachedIconBase64 = fs.existsSync(iconPath) ? fs.readFileSync(iconPath).toString('base64') : '';
    } catch (e) {
        _cachedIconBase64 = '';
    }
    return _cachedIconBase64;
}

module.exports = { getIconBase64 };
