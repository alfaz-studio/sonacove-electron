const { app } = require('electron');
const fs = require('original-fs');
const path = require('path');

const GITHUB_OWNER = 'alfaz-studio';
const GITHUB_REPO = 'sonacove-electron';
const CACHE_DIR = path.join(app.getPath('userData'), 'staging-builds');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

// TODO: migrate token storage to safeStorage.encryptString/decryptString
// to use the OS keychain instead of plaintext JSON.

/**
 * Load persisted launcher settings from disk.
 * @returns {object} Parsed settings, or an empty object if missing/invalid
 */
function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

/**
 * Persist launcher settings to disk (creates the parent directory if needed).
 * @param {object} settings  Settings object to serialize
 */
function saveSettings(settings) {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

module.exports = { GITHUB_OWNER,
    GITHUB_REPO,
    CACHE_DIR,
    SETTINGS_PATH,
    loadSettings,
    saveSettings };
