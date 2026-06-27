const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const { validateUserPath } = require('./sanitizers');

const SETTINGS_FILENAME = '.sonacove-save-paths.json';
const SETTINGS_VERSION = 1;
const DEFAULT_ROOT_NAME = 'Sonacove';
const RECORDINGS_SUBDIR = 'Recordings';
const SCREENSHOTS_SUBDIR = 'Screenshots';

/**
 * Standard Electron `app.getPath()` keys we allow as save-path roots.
 * Defined here (not in savePathsIpc.js) because `loadSettings` also needs
 * to consult them when validating a previously-persisted path on disk —
 * keeping a single source-of-truth list avoids drift between the IPC's
 * accept-set and the cold-load accept-set.
 */
const ALLOWED_ROOT_KEYS = [
    'documents',
    'downloads',
    'videos',
    'pictures',
    'music',
    'desktop',
    'home'
];

/**
 * Resolves the allowed root directories at call time (not module init)
 * because `app.getPath` can throw before the `ready` event in some
 * environments, and because the value of e.g. `home` depends on the
 * runtime user.
 */
function getAllowedSavePathRoots() {
    const roots = [];

    for (const key of ALLOWED_ROOT_KEYS) {
        try {
            roots.push(app.getPath(key));
        } catch {
            // Some platforms don't expose every well-known dir — skip silently.
        }
    }

    return roots;
}

/** @type {{ recordings: string|null, screenshots: string|null } | null} */
let cachedSettings = null;

/**
 * Absolute path of the JSON file backing the persisted save-path settings.
 *
 * @returns {string} Path inside the Electron `userData` directory.
 */
function getSettingsFilePath() {
    return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

/**
 * Loads the persisted save-path settings, validating stored paths against the
 * allowed-roots allowlist. Reads from disk once per process and caches the
 * result; falls back to `{ recordings: null, screenshots: null }` on a missing,
 * unparseable, version-mismatched, or rejected file.
 *
 * @returns {{ recordings: string|null, screenshots: string|null }}
 */
function loadSettings() {
    // Cache-first: the sync readFileSync below only runs on the first call
    // per process lifetime — subsequent calls return the in-memory object.
    // Async wouldn't buy us much for a ~100-byte file read once at startup.
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
            cachedSettings = { recordings: null,
                screenshots: null };

            return cachedSettings;
        }

        // Re-validate stored paths against the allowed-roots allowlist. A
        // hand-edited settings file could otherwise feed an arbitrary
        // relative or out-of-allowlist absolute path straight into
        // fs.promises.mkdir() via getRecordingsDir()/getScreenshotsDir().
        const allowedRoots = getAllowedSavePathRoots();
        const validateStored = v => {
            if (typeof v !== 'string') {
                return null;
            }
            const check = validateUserPath(v, allowedRoots);

            if ('error' in check) {
                console.warn(
                    `⚠️ sonacovePaths: stored path rejected by validateUserPath (${check.error}); `
                    + 'falling back to default'
                );

                return null;
            }

            return check.ok;
        };

        cachedSettings = {
            recordings: validateStored(parsed.recordings),
            screenshots: validateStored(parsed.screenshots)
        };
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('⚠️ sonacovePaths: failed to load settings, falling back to defaults:', err.message);
        }
        cachedSettings = { recordings: null,
            screenshots: null };
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
            recordings: 'recordings' in next ? next.recordings ?? null : current.recordings,
            screenshots: 'screenshots' in next ? next.screenshots ?? null : current.screenshots
        };
        const onDisk = { version: SETTINGS_VERSION,
            ...merged };
        const target = getSettingsFilePath();
        const tmp = `${target}.tmp`;

        try {
            await fs.promises.writeFile(tmp, JSON.stringify(onDisk, null, 2), 'utf8');
            await fs.promises.rename(tmp, target);
        } catch (err) {
            // Best-effort cleanup; we don't actually need the .tmp gone for
            // correctness (the next successful save will overwrite it), but
            // leaving stray files in userData is a minor hygiene win.
            await fs.promises.unlink(tmp).catch(() => { /* best-effort cleanup */ });
            throw err;
        }
        cachedSettings = merged;

        return merged;
    });

    // Don't let one rejection poison the queue for later callers. The
    // returned promise still surfaces the error to the original caller.
    saveQueue = run.catch(() => { /* keep queue alive; error surfaced via run */ });

    return run;
}

/**
 * Default Sonacove root directory under the user's Documents folder.
 *
 * @returns {string} Absolute directory path.
 */
function getDefaultSonacoveDir() {
    return path.join(app.getPath('documents'), DEFAULT_ROOT_NAME);
}

/**
 * Default recordings directory (Documents/Sonacove/Recordings).
 *
 * @returns {string} Absolute directory path.
 */
function getDefaultRecordingsDir() {
    return path.join(getDefaultSonacoveDir(), RECORDINGS_SUBDIR);
}

/**
 * Default screenshots directory (Documents/Sonacove/Screenshots).
 *
 * @returns {string} Absolute directory path.
 */
function getDefaultScreenshotsDir() {
    return path.join(getDefaultSonacoveDir(), SCREENSHOTS_SUBDIR);
}

/**
 * Resolves the effective recordings directory (user override or default) and
 * ensures it exists on disk.
 *
 * @returns {Promise<string>} Absolute path of the created/ensured directory.
 */
async function getRecordingsDir() {
    const settings = loadSettings();
    const dir = settings.recordings ?? getDefaultRecordingsDir();

    await fs.promises.mkdir(dir, { recursive: true });

    return dir;
}

/**
 * Resolves the effective screenshots directory (user override or default) and
 * ensures it exists on disk.
 *
 * @returns {Promise<string>} Absolute path of the created/ensured directory.
 */
async function getScreenshotsDir() {
    const settings = loadSettings();
    const dir = settings.screenshots ?? getDefaultScreenshotsDir();

    await fs.promises.mkdir(dir, { recursive: true });

    return dir;
}

// Legacy ~/Pictures/Sonacove Screenshots dir from older builds — kept allowlisted
// for show-in-folder so users can still reveal screenshots saved before the
// move to Documents/Sonacove/Screenshots.
/**
 * Legacy ~/Pictures/Sonacove Screenshots directory from older builds, kept so
 * show-in-folder can still reveal screenshots saved before the move to
 * Documents/Sonacove/Screenshots.
 *
 * @returns {string} Absolute directory path.
 */
function getLegacyScreenshotsDir() {
    return path.join(app.getPath('pictures'), 'Sonacove Screenshots');
}

/**
 * Directories the renderer is permitted to reveal in the OS file manager:
 * the default recordings/screenshots dirs, the legacy screenshots dir, and any
 * active user overrides.
 *
 * @returns {string[]} Deduplicated list of absolute directory paths.
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
 * Builds the save-paths summary returned to the renderer: for both recordings
 * and screenshots, the currently effective path, the user override (or null),
 * and the built-in default.
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
            current: settings.recordings ?? getDefaultRecordingsDir(),
            override: settings.recordings,
            default: getDefaultRecordingsDir()
        },
        screenshots: {
            current: settings.screenshots ?? getDefaultScreenshotsDir(),
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
    getAllowedSavePathRoots,
    getSavePathsInfo,
    saveSettings
};
