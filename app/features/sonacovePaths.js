'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILENAME = '.sonacove-save-paths.json';
const DEFAULT_ROOT_NAME = 'Sonacove';
const RECORDINGS_SUBDIR = 'Recordings';
const SCREENSHOTS_SUBDIR = 'Screenshots';
const MAX_FILENAME_BYTES = 255;

/** @type {{ recordings: string|null, screenshots: string|null } | null} */
let cachedSettings = null;

function getSettingsFilePath() {
    return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

function loadSettings() {
    if (cachedSettings) {
        return cachedSettings;
    }

    try {
        const raw = fs.readFileSync(getSettingsFilePath(), 'utf8');
        const parsed = JSON.parse(raw);

        cachedSettings = {
            recordings: typeof parsed.recordings === 'string' ? parsed.recordings : null,
            screenshots: typeof parsed.screenshots === 'string' ? parsed.screenshots : null
        };
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('⚠️ sonacovePaths: failed to load settings, falling back to defaults:', err.message);
        }
        cachedSettings = { recordings: null, screenshots: null };
    }

    return cachedSettings;
}

function saveSettings(next) {
    const current = loadSettings();
    const merged = {
        recordings: 'recordings' in next ? (next.recordings || null) : current.recordings,
        screenshots: 'screenshots' in next ? (next.screenshots || null) : current.screenshots
    };

    fs.writeFileSync(getSettingsFilePath(), JSON.stringify(merged, null, 2), 'utf8');
    cachedSettings = merged;

    return merged;
}

function getDefaultSonacoveDir() {
    return path.join(app.getPath('documents'), DEFAULT_ROOT_NAME);
}

function getDefaultRecordingsDir() {
    return path.join(getDefaultSonacoveDir(), RECORDINGS_SUBDIR);
}

function getDefaultScreenshotsDir() {
    return path.join(getDefaultSonacoveDir(), SCREENSHOTS_SUBDIR);
}

function getRecordingsDir() {
    const settings = loadSettings();
    const dir = settings.recordings || getDefaultRecordingsDir();

    fs.mkdirSync(dir, { recursive: true });

    return dir;
}

function getScreenshotsDir() {
    const settings = loadSettings();
    const dir = settings.screenshots || getDefaultScreenshotsDir();

    fs.mkdirSync(dir, { recursive: true });

    return dir;
}

// Legacy ~/Pictures/Sonacove Screenshots dir from older builds — kept allowlisted
// for show-in-folder so users can still reveal screenshots saved before the
// move to Documents/Sonacove/Screenshots.
function getLegacyScreenshotsDir() {
    return path.join(app.getPath('pictures'), 'Sonacove Screenshots');
}

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

/**
 * Sanitizes a user-supplied filename for safe writing to disk.
 * Strips directory components, restricts to a safe charset, enforces the given
 * extension (case-insensitive), and caps total length at 255 bytes.
 *
 * @param {string} filename - User-suggested filename.
 * @param {string} requiredExt - Required extension including the dot, e.g. '.webm'.
 * @returns {string|null} Safe filename, or null if not recoverable.
 */
function sanitizeOutputFilename(filename, requiredExt) {
    if (typeof filename !== 'string' || !filename) {
        return null;
    }

    let safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');

    if (!safe.toLowerCase().endsWith(requiredExt.toLowerCase())) {
        safe = `${safe}${requiredExt}`;
    }
    if (safe === requiredExt || safe.length === 0) {
        return null;
    }
    if (safe.length > MAX_FILENAME_BYTES) {
        safe = `${safe.slice(0, MAX_FILENAME_BYTES - requiredExt.length)}${requiredExt}`;
    }

    return safe;
}

module.exports = {
    getRecordingsDir,
    getScreenshotsDir,
    getLegacyScreenshotsDir,
    getAllowedRevealDirs,
    getSavePathsInfo,
    saveSettings,
    sanitizeOutputFilename
};
