const { ipcMain, shell } = require('electron');
const { GITHUB_OWNER, GITHUB_REPO, CACHE_DIR, loadSettings, saveSettings } = require('./config');
const { fetchStagingPRs, fetchMainBuild } = require('./github');
const { downloadBuild, launchBuild, clearCache, getCacheInfo } = require('./builds');
const { validPR, validBuildId } = require('./fs-utils');

/**
 * Register all IPC handlers.
 * @param {{ getMainWindow: Function }} deps
 */
function registerIpcHandlers({ getMainWindow }) {
    // Fetch list of staging PR builds
    ipcMain.handle('get-staging-prs', (_event, token) =>
        fetchStagingPRs(token, { owner: GITHUB_OWNER, repo: GITHUB_REPO, cacheDir: CACHE_DIR })
    );

    // Fetch the latest main-branch staging build
    ipcMain.handle('get-main-build', (_event, token) =>
        fetchMainBuild(token, { owner: GITHUB_OWNER, repo: GITHUB_REPO, cacheDir: CACHE_DIR })
    );

    // Download a build
    ipcMain.handle('download-build', (_event, opts) =>
        downloadBuild({ ...opts, cacheDir: CACHE_DIR, getMainWindow })
    );

    // Launch a cached build
    ipcMain.handle('launch-build', (_event, opts) =>
        launchBuild({ ...opts, cacheDir: CACHE_DIR, loadSettings })
    );

    // Clear cache for a specific PR or all
    ipcMain.handle('clear-cache', (_event, opts) =>
        clearCache({ ...opts, cacheDir: CACHE_DIR })
    );

    // Get cache info
    ipcMain.handle('get-cache-info', () => getCacheInfo(CACHE_DIR));

    // Settings
    ipcMain.handle('get-settings', () => loadSettings());
    ipcMain.handle('save-settings', (_event, settings) => {
        const current = loadSettings();

        saveSettings({ ...current, ...settings });

        return { success: true };
    });

    // Per-build URL overrides
    ipcMain.handle('save-pr-override', (_event, { prNumber, buildId, landingUrl, meetUrl }) => {
        const key = buildId || validPR(prNumber);

        // Validate URLs server-side (the renderer's <input type="url"> catches most
        // issues, but this prevents invalid strings from reaching config.js where
        // new URL() would throw and crash the launched app).
        if (landingUrl) {
            new URL(landingUrl);
        }
        if (meetUrl) {
            new URL(meetUrl);
        }

        const settings = loadSettings();

        if (!settings.prOverrides) {
            settings.prOverrides = {};
        }

        if (landingUrl || meetUrl) {
            settings.prOverrides[key] = { landingUrl, meetUrl };
        } else {
            delete settings.prOverrides[key];
        }

        saveSettings(settings);

        return { success: true };
    });

    // Expose repo constants so the renderer has a single source of truth
    ipcMain.handle('get-repo-info', () => ({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        baseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`
    }));

    // Open external link — restrict to http/https to prevent arbitrary scheme execution
    ipcMain.handle('open-external', (_event, url) => {
        const parsed = new URL(url);

        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error('Only http/https URLs are allowed');
        }

        return shell.openExternal(url);
    });
}

module.exports = { registerIpcHandlers };
