'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILENAME = '.sonacove-save-paths.json';
const DEFAULT_ROOT_NAME = 'Sonacove';
const RECORDINGS_SUBDIR = 'Recordings';
const SCREENSHOTS_SUBDIR = 'Screenshots';

/**
 * In-memory cache of the on-disk settings.
 * Lazily loaded on first read; written through on every set.
 *
 * @type {{ recordings: string|null, screenshots: string|null } | null}
 */
let cachedSettings = null;

/**
 * Returns the absolute path to the settings file in userData.
 *
 * @returns {string}
 */
function getSettingsFilePath() {
    return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

/**
 * Loads the save-path settings from disk. Returns an empty object on any failure
 * (missing file, parse error). Cached after first read.
 *
 * @returns {{ recordings: string|null, screenshots: string|null }}
 */
function loadSettings() {
    if (cachedSettings) {
        return cachedSettings;
    }

    const filePath = getSettingsFilePath();

    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);

            cachedSettings = {
                recordings: typeof parsed.recordings === 'string' ? parsed.recordings : null,
                screenshots: typeof parsed.screenshots === 'string' ? parsed.screenshots : null
            };

            return cachedSettings;
        }
    } catch (err) {
        console.warn('⚠️ sonacovePaths: failed to load settings, falling back to defaults:', err.message);
    }

    cachedSettings = { recordings: null, screenshots: null };

    return cachedSettings;
}

/**
 * Persists the save-path settings to disk and updates the in-memory cache.
 *
 * @param {{ recordings?: string|null, screenshots?: string|null }} next - Partial update.
 * @returns {{ recordings: string|null, screenshots: string|null }} The merged settings.
 */
function saveSettings(next) {
    const current = loadSettings();
    const merged = {
        recordings: 'recordings' in next ? (next.recordings || null) : current.recordings,
        screenshots: 'screenshots' in next ? (next.screenshots || null) : current.screenshots
    };

    const filePath = getSettingsFilePath();

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');

    cachedSettings = merged;

    return merged;
}

/**
 * Returns the default Sonacove root directory under the user's Documents folder.
 *
 * @returns {string}
 */
function getDefaultSonacoveDir() {
    return path.join(app.getPath('documents'), DEFAULT_ROOT_NAME);
}

/**
 * Returns the default recordings directory.
 *
 * @returns {string}
 */
function getDefaultRecordingsDir() {
    return path.join(getDefaultSonacoveDir(), RECORDINGS_SUBDIR);
}

/**
 * Returns the default screenshots directory.
 *
 * @returns {string}
 */
function getDefaultScreenshotsDir() {
    return path.join(getDefaultSonacoveDir(), SCREENSHOTS_SUBDIR);
}

/**
 * Returns the resolved recordings directory (override if set, else default).
 * Ensures the directory exists.
 *
 * @returns {string}
 */
function getRecordingsDir() {
    const settings = loadSettings();
    const dir = settings.recordings || getDefaultRecordingsDir();

    fs.mkdirSync(dir, { recursive: true });

    return dir;
}

/**
 * Returns the resolved screenshots directory (override if set, else default).
 * Ensures the directory exists.
 *
 * @returns {string}
 */
function getScreenshotsDir() {
    const settings = loadSettings();
    const dir = settings.screenshots || getDefaultScreenshotsDir();

    fs.mkdirSync(dir, { recursive: true });

    return dir;
}

/**
 * Legacy screenshots directory used by older builds (~/Pictures/Sonacove Screenshots).
 * Kept allowlisted for show-in-folder so users can still reveal old saves.
 *
 * @returns {string}
 */
function getLegacyScreenshotsDir() {
    return path.join(app.getPath('pictures'), 'Sonacove Screenshots');
}

/**
 * Returns the full set of directories that show-in-folder should accept.
 * Includes defaults, current overrides, and the legacy screenshots dir.
 *
 * @returns {string[]}
 */
function getAllowedRevealDirs() {
    const settings = loadSettings();
    const dirs = new Set([
        getDefaultRecordingsDir(),
        getDefaultScreenshotsDir(),
        getLegacyScreenshotsDir()
    ]);

    if (settings.recordings) {
        dirs.add(settings.recordings);
    }
    if (settings.screenshots) {
        dirs.add(settings.screenshots);
    }

    return Array.from(dirs);
}

/**
 * Returns the current settings (with defaults filled in as resolved paths).
 * Useful for the renderer settings UI.
 *
 * @returns {{
 *   recordings: { current: string, override: string|null, default: string },
 *   screenshots: { current: string, override: string|null, default: string }
 * }}
 */
function getSavePathsInfo() {
    const settings = loadSettings();

    return {
        recordings: {
            current: settings.recordings || getDefaultRecordingsDir(),
            override: settings.recordings,
            default: getDefaultRecordingsDir()
        },
        screenshots: {
            current: settings.screenshots || getDefaultScreenshotsDir(),
            override: settings.screenshots,
            default: getDefaultScreenshotsDir()
        }
    };
}

module.exports = {
    getRecordingsDir,
    getScreenshotsDir,
    getLegacyScreenshotsDir,
    getAllowedRevealDirs,
    getSavePathsInfo,
    saveSettings
};
