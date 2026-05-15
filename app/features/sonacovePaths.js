'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILENAME = '.sonacove-save-paths.json';
const SETTINGS_VERSION = 1;
const DEFAULT_ROOT_NAME = 'Sonacove';
const RECORDINGS_SUBDIR = 'Recordings';
const SCREENSHOTS_SUBDIR = 'Screenshots';

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

        // If the on-disk schema doesn't match what this build expects, fall back
        // to defaults rather than silently misinterpreting fields. The first
        // saveSettings() call will rewrite the file with the current version.
        if (typeof parsed.version !== 'number' || parsed.version !== SETTINGS_VERSION) {
            console.warn(
                `⚠️ sonacovePaths: settings version ${parsed.version} != expected ${SETTINGS_VERSION}, using defaults`
            );
            cachedSettings = { recordings: null, screenshots: null };

            return cachedSettings;
        }

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

// Serializes concurrent saveSettings calls. Without it, two parallel callers
// would each read the same `cachedSettings`, merge only their own key, and
// race on the final write — the second write would silently clobber the
// first caller's change (lost-update). Chaining through this queue forces
// strict ordering: each save sees the cache update from the previous one.
let saveQueue = Promise.resolve();

/**
 * Persists the merged settings to disk and updates the in-memory cache.
 *
 * Writes are atomic (write-to-temp + rename) so a process kill mid-write
 * cannot leave behind a partially-written JSON file that the next launch
 * would fail to parse and silently fall back to defaults on.
 *
 * Concurrent calls are serialized through a module-level promise chain so
 * two in-flight saves can't lost-update each other's keys.
 *
 * @param {{ recordings?: string|null, screenshots?: string|null }} next
 * @returns {Promise<{ recordings: string|null, screenshots: string|null }>}
 */
function saveSettings(next) {
    const run = saveQueue.then(async () => {
        const current = loadSettings();
        // `?? null` (not `|| null`): we only want to coerce nullish values to
        // null, not falsy ones. `sanitizeOverride` already maps empty/whitespace
        // strings to null, so anything truthy that survives here is a real path
        // (and even if it weren't, `|| null` would have wrongly clobbered
        // legitimate values that happened to be falsy in some future schema).
        const merged = {
            recordings: 'recordings' in next ? (next.recordings ?? null) : current.recordings,
            screenshots: 'screenshots' in next ? (next.screenshots ?? null) : current.screenshots
        };
        const onDisk = { version: SETTINGS_VERSION, ...merged };
        const target = getSettingsFilePath();
        const tmp = `${target}.tmp`;

        try {
            await fs.promises.writeFile(tmp, JSON.stringify(onDisk, null, 2), 'utf8');
            await fs.promises.rename(tmp, target);
        } catch (err) {
            // Best-effort cleanup; we don't actually need the .tmp gone for
            // correctness (the next successful save will overwrite it), but
            // leaving stray files in userData is a minor hygiene win.
            await fs.promises.unlink(tmp).catch(() => {});
            throw err;
        }
        cachedSettings = merged;

        return merged;
    });

    // Don't let one rejection poison the queue for later callers. The
    // returned promise still surfaces the error to the original caller.
    saveQueue = run.catch(() => {});

    return run;
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

async function getRecordingsDir() {
    const settings = loadSettings();
    const dir = settings.recordings || getDefaultRecordingsDir();

    await fs.promises.mkdir(dir, { recursive: true });

    return dir;
}

async function getScreenshotsDir() {
    const settings = loadSettings();
    const dir = settings.screenshots || getDefaultScreenshotsDir();

    await fs.promises.mkdir(dir, { recursive: true });

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

module.exports = {
    getRecordingsDir,
    getScreenshotsDir,
    getLegacyScreenshotsDir,
    getAllowedRevealDirs,
    getSavePathsInfo,
    saveSettings
};
