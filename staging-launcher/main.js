const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const https = require('https');
// Use original-fs to bypass Electron's asar patching.  The patched fs
// opens .asar files transparently, which holds file handles and causes
// EPERM when we later try to delete the cache directory.
const fs = require('original-fs');
const path = require('path');
// Electron-patched fs — reads asar archives transparently.  We use this
// to extract files from app.asar when patching builds with custom URLs.
const nodeFs = require('fs');
const { spawn, execFile } = require('child_process');
const { createWriteStream } = require('original-fs');

const GITHUB_OWNER = 'alfaz-studio';
const GITHUB_REPO = 'sonacove-electron';
const CACHE_DIR = path.join(app.getPath('userData'), 'staging-builds');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

let mainWindow = null;

// ── Settings ────────────────────────────────────────────────────────────────

// TODO: migrate token storage to safeStorage.encryptString/decryptString
// to use the OS keychain instead of plaintext JSON.
function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function saveSettings(settings) {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ── GitHub API ──────────────────────────────────────────────────────────────

function githubApi(apiPath, token) {
    return new Promise((resolve, reject) => {
        const headers = {
            'User-Agent': 'Sonacove-Staging-Launcher',
            Accept: 'application/vnd.github.v3+json'
        };

        if (token) {
            headers.Authorization = `token ${token}`;
        }

        const req = https.get(
            { hostname: 'api.github.com', path: apiPath, headers },
            res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({
                            data: JSON.parse(data),
                            rateLimit: {
                                remaining: res.headers['x-ratelimit-remaining'],
                                limit: res.headers['x-ratelimit-limit']
                            }
                        });
                    } else {
                        reject(new Error(`GitHub API ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                });
            }
        );

        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('GitHub API request timed out'));
        });
    });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

// Fetch list of staging PR builds
ipcMain.handle('get-staging-prs', async (_event, token) => {
    // 1. Get all pre-releases matching staging-pr-*
    const { data: releases, rateLimit } = await githubApi(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=50`,
        token
    );

    const stagingReleases = releases.filter(
        r => r.prerelease && r.tag_name.startsWith('staging-pr-')
    );

    // 2. Get all PRs for metadata (open + closed/merged)
    let prs = [];

    try {
        // Fetch open and closed PRs in parallel
        const [ openRes, closedRes ] = await Promise.all([
            githubApi(
                `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=open&per_page=50`,
                token
            ),
            githubApi(
                `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=closed&per_page=50`,
                token
            )
        ]);

        prs = [ ...openRes.data, ...closedRes.data ];
    } catch {
        // If PR fetch fails, we still have release data
    }

    const prMap = new Map(prs.map(pr => [ pr.number, pr ]));

    // 3. Fetch latest commit message for each PR's head SHA
    const shasToPrs = new Map();

    for (const release of stagingReleases) {
        const prNum = parseInt(release.tag_name.replace('staging-pr-', ''), 10);
        const pr = prMap.get(prNum);

        if (pr && pr.head && pr.head.sha) {
            shasToPrs.set(pr.head.sha, prNum);
        }
    }

    const commitMap = new Map();
    const shas = [ ...shasToPrs.keys() ];

    // Fetch commit messages — parallel when authenticated, sequential without
    // a token to avoid exhausting the 60 req/hr unauthenticated rate limit.
    if (token) {
        await Promise.all(shas.map(async sha => {
            try {
                const { data } = await githubApi(
                    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${sha}`,
                    token
                );

                commitMap.set(sha, data.commit.message.split('\n')[0]);
            } catch {
                // Ignore — commit message is optional
            }
        }));
    } else {
        for (const sha of shas) {
            try {
                const { data } = await githubApi(
                    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${sha}`,
                    token
                );

                commitMap.set(sha, data.commit.message.split('\n')[0]);
            } catch (err) {
                // Stop fetching on rate limit; skip individual failures
                if (err.message.includes('403') || err.message.includes('429')) {
                    break;
                }
            }
        }
    }

    // 4. Merge release + PR + commit data
    const results = stagingReleases.map(release => {
        const prNum = parseInt(release.tag_name.replace('staging-pr-', ''), 10);
        const pr = prMap.get(prNum);
        const headSha = pr && pr.head ? pr.head.sha : null;

        // Determine which assets are available for this platform
        const platform = process.platform === 'darwin' ? 'mac' : 'win';
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        let assetName;

        if (platform === 'mac') {
            assetName = `sonacove-staging-mac-${arch}.zip`;
        } else {
            assetName = 'sonacove-staging-win-x64.zip';
        }

        const asset = release.assets.find(a => a.name === assetName);

        // Check cache status
        const cacheDir = path.join(CACHE_DIR, `pr-${prNum}`);
        const metaPath = path.join(cacheDir, 'meta.json');
        let cached = false;
        let cachedSha = null;

        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

                cached = true;
                cachedSha = meta.sha;
            } catch {
                // Corrupt meta, treat as not cached
            }
        }

        const prState = pr ? pr.state : 'open'; // assume open if no PR metadata
        const merged = pr ? !!pr.merged_at : false;

        return {
            prNumber: prNum,
            title: pr ? pr.title : `PR #${prNum}`,
            author: pr ? pr.user.login : 'unknown',
            authorAvatar: pr ? pr.user.avatar_url : null,
            draft: pr ? !!pr.draft : false,
            state: prState,
            merged,
            sha: headSha || release.target_commitish,
            commitMessage: headSha ? (commitMap.get(headSha) || null) : null,
            updatedAt: release.published_at || release.created_at,
            assetName,
            assetUrl: asset ? asset.url : null,
            assetSize: asset ? asset.size : 0,
            hasAsset: !!asset,
            cached,
            updateAvailable: cached && cachedSha !== (headSha || release.target_commitish)
        };
    });

    return { prs: results, rateLimit };
});

// Validate PR number to prevent path traversal
function validPR(prNumber) {
    const n = parseInt(prNumber, 10);

    if (!Number.isFinite(n) || n <= 0) {
        throw new Error('Invalid PR number');
    }

    return n;
}

// Download a build
ipcMain.handle('download-build', async (event, { prNumber, assetUrl, sha, token }) => {
    if (!assetUrl.startsWith('https://api.github.com/')) {
        throw new Error('Asset URL must be from api.github.com');
    }

    const prNum = validPR(prNumber);
    const cacheDir = path.join(CACHE_DIR, `pr-${prNum}`);
    const zipPath = path.join(cacheDir, 'build.zip');
    const extractDir = path.join(cacheDir, 'app');

    // Clean previous download
    if (fs.existsSync(cacheDir)) {
        if (process.platform === 'win32') {
            await execFileAsync('cmd', [ '/c', 'rd', '/s', '/q', cacheDir ]);
        } else {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    }

    fs.mkdirSync(extractDir, { recursive: true });

    // Download the asset (GitHub API redirects to S3)
    await downloadAsset(assetUrl, zipPath, token, progress => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', { prNumber, progress });
        }
    });

    // Extract
    await extractZip(zipPath, extractDir);

    // Clean up the zip to save space
    fs.rmSync(zipPath, { force: true });

    // Write meta
    fs.writeFileSync(
        path.join(cacheDir, 'meta.json'),
        JSON.stringify({ sha, downloadedAt: new Date().toISOString() })
    );

    return { success: true };
});

// ── URL Override: asar extraction + main.js patching ────────────────────────
//
// Staging builds package the app code inside resources/app.asar.  To override
// hardcoded URLs we:
//   1. Back up app.asar → app-backup.asar  (preserves original for restore)
//   2. Extract all files from the asar into resources/app/  (Electron uses
//      the directory over the asar when both exist)
//   3. String-replace the hardcoded URLs in build/main.js
//
// When no overrides are set, we restore the original asar.

// Recursively copy files out of an asar archive.  `nodeFs` (Electron's
// patched fs) reads asar contents transparently, including files that the
// asar marks as "unpacked" (native .node binaries in app.asar.unpacked/).
// We write with `fs` (original-fs) so we create real files on disk.
function copyFromAsar(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });

    const entries = nodeFs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            copyFromAsar(srcPath, destPath);
        } else if (entry.isSymbolicLink()) {
            try {
                const target = nodeFs.readlinkSync(srcPath);

                fs.symlinkSync(target, destPath);
            } catch {
                // Skip unreadable symlinks
            }
        } else {
            try {
                fs.writeFileSync(destPath, nodeFs.readFileSync(srcPath));
            } catch {
                // Skip files that can't be read — the asar header can list
                // files as "unpacked" that don't actually exist in the
                // .asar.unpacked directory (e.g. .eslintignore, dev configs).
            }
        }
    }
}

// Recursively copy a real directory (using original-fs, no asar patching).
// Used to overlay the .asar.unpacked contents onto the extracted app dir.
function copyDirReal(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            copyDirReal(srcPath, destPath);
        } else {
            try {
                fs.copyFileSync(srcPath, destPath);
            } catch {
                // Skip files that can't be copied (e.g. locked)
            }
        }
    }
}

// ⚠ The URL strings and hostnames below must stay in sync with
// app/features/sonacove/config.js (staging block).
function patchMainJs(mainJsPath, overrides) {
    let mainJs = fs.readFileSync(mainJsPath, 'utf-8');

    if (overrides.landingUrl) {
        // Replace the full landing URL first
        mainJs = mainJs.replaceAll(
            'https://sonacove.catfurr.workers.dev/dashboard',
            overrides.landingUrl
        );

        // Replace the standalone hostname so allowedHosts, windowOpenHandler,
        // Origin injection, and any other host-based checks use the new host.
        // Use a word-boundary-aware regex to avoid double-replacing when the
        // new hostname contains the old one as a substring (e.g. the custom
        // host '404b3320-sona-app.catfurr.workers.dev' contains the default
        // meet host 'sona-app.catfurr.workers.dev').
        try {
            const newHost = new URL(overrides.landingUrl).hostname;

            mainJs = mainJs.replace(
                /(?<![a-zA-Z0-9-])sonacove\.catfurr\.workers\.dev(?![a-zA-Z0-9-])/g,
                newHost
            );
        } catch {
            // ignore invalid URL
        }
    }
    if (overrides.meetUrl) {
        // Only replace the hostname, NOT the full URL.  The meet config value
        // is `https://sona-app.catfurr.workers.dev/meet` — if we replaced the
        // full URL we'd clobber the `/meet` path, and the will-navigate handler
        // in the app's main.js would reconstruct it as `/meet/meet/roomname`
        // (it concatenates meetRoot + pathname, both starting with /meet).
        // By swapping just the hostname, meetRoot stays as
        // `https://<new-host>/meet` and the hostname check passes, so the
        // handler never fires and the path stays correct.
        try {
            const newHost = new URL(overrides.meetUrl).hostname;

            mainJs = mainJs.replace(
                /(?<![a-zA-Z0-9-])sona-app\.catfurr\.workers\.dev(?![a-zA-Z0-9-])/g,
                newHost
            );
        } catch {
            // ignore invalid URL
        }
    }

    // Helper — apply a regex replacement and warn if it didn't match.
    // Fragile patterns that depend on webpack/terser output should be
    // surfaced when they silently no-op so failures are caught in testing.
    function tryReplace(src, pattern, replacement, label) {
        const result = src.replace(pattern, replacement);

        if (result === src) {
            console.warn(`[patcher] ${label} — pattern did not match:`, pattern.toString());
        }

        return result;
    }

    // Shrink the staging banner from a full-width bottom bar to a small
    // bottom-right pill.  The compiled CSS contains literal \n (backslash-n)
    // for newlines, so we use \\n to match those, then \s* for indentation.
    mainJs = tryReplace(mainJs,
        /bottom: 0; left: 0; right: 0;\\n\s*height: 28px;\\n\s*background: #d97706;/,
        'bottom:8px;right:8px;padding:2px 8px;border-radius:4px;pointer-events:none;opacity:.8;background:rgba(217,119,6,0.7);',
        'banner layout'
    );
    mainJs = tryReplace(mainJs,
        /font-size: 12px;\\n\s*font-weight: 600;\\n\s*z-index: 2147483647;/,
        'font-size:10px;font-weight:600;z-index:2147483647;',
        'banner font'
    );

    // Fix the will-navigate handler's URL construction bug present in builds
    // compiled before the source fix.  The handler concatenates meetRoot
    // (ending in /meet) with the full pathname (starting with /meet),
    // producing /meet/meet/room.  We inject a .replace() to strip the
    // leading /meet from pathname.
    //
    // Compiled template-literal form:
    //   `${X.currentConfig.meetRoot}${Y.pathname}${Y.search}`
    mainJs = tryReplace(mainJs,
        /\.currentConfig\.meetRoot\}\$\{(\w+)\.pathname\}\$\{(\w+)\.search\}/g,
        '.currentConfig.meetRoot}${$1.pathname.replace(/^\\/meet/,"")}${$2.search}',
        'will-navigate template literal'
    );
    // Compiled string-concatenation form (terser may convert template literals):
    //   X.currentConfig.meetRoot+Y.pathname+Y.search
    mainJs = tryReplace(mainJs,
        /\.currentConfig\.meetRoot\+(\w+)\.pathname\+(\w+)\.search/g,
        '.currentConfig.meetRoot+$1.pathname.replace(/^\\/meet/,"")+$2.search',
        'will-navigate concatenation'
    );

    fs.writeFileSync(mainJsPath, mainJs);
}

async function rmDir(dirPath) {
    if (process.platform === 'win32') {
        await execFileAsync('cmd', [ '/c', 'rd', '/s', '/q', dirPath ]);
    } else {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
}

async function patchBuildUrls(extractDir, overrides) {
    const resourcesDir = path.join(extractDir, 'resources');
    const asarPath = path.join(resourcesDir, 'app.asar');
    const asarBackup = path.join(resourcesDir, 'app-backup.asar');
    const asarUnpacked = path.join(resourcesDir, 'app.asar.unpacked');
    const asarUnpackedBackup = path.join(resourcesDir, 'app-backup.asar.unpacked');
    const appDir = path.join(resourcesDir, 'app');

    const hasOverrides = !!(overrides.landingUrl || overrides.meetUrl);

    if (!hasOverrides) {
        // Restore original asar if it was backed up
        if (fs.existsSync(asarBackup)) {
            if (fs.existsSync(appDir)) {
                await rmDir(appDir);
            }
            fs.renameSync(asarBackup, asarPath);
            if (fs.existsSync(asarUnpackedBackup)) {
                fs.renameSync(asarUnpackedBackup, asarUnpacked);
            }
        }

        return;
    }

    // If resources/app/ already exists and there's no asar at all, the build
    // uses an unpacked app directory — patch main.js in place.
    if (fs.existsSync(appDir) && !fs.existsSync(asarPath) && !fs.existsSync(asarBackup)) {
        patchMainJs(path.join(appDir, 'build', 'main.js'), overrides);

        return;
    }

    // ── Asar-based build ────────────────────────────────────────────────────

    // 1. Create backup on first override (preserves pristine copy)
    if (fs.existsSync(asarPath) && !fs.existsSync(asarBackup)) {
        fs.renameSync(asarPath, asarBackup);
        if (fs.existsSync(asarUnpacked)) {
            fs.renameSync(asarUnpacked, asarUnpackedBackup);
        }
    }

    if (!fs.existsSync(asarBackup)) {
        throw new Error('No app.asar backup found — cannot apply URL overrides');
    }

    // 2. Clean up any previous extraction
    if (fs.existsSync(appDir)) {
        await rmDir(appDir);
    }
    if (fs.existsSync(asarPath)) {
        fs.unlinkSync(asarPath);
    }

    // 3. Extract all files from the backup asar into resources/app/
    copyFromAsar(asarBackup, appDir);

    // 4. Overlay the real unpacked directory on top.  Native modules and
    //    some JS files live in app.asar.unpacked/ — the asar header lists
    //    them but nodeFs can fail to read files that are missing from disk.
    //    Copying the unpacked directory directly fills in anything that the
    //    asar-based extraction missed.
    if (fs.existsSync(asarUnpackedBackup)) {
        copyDirReal(asarUnpackedBackup, appDir);
    }

    // 5. Patch build/main.js with URL replacements
    patchMainJs(path.join(appDir, 'build', 'main.js'), overrides);
}

// Build a spawn environment that forwards custom preview URLs to the staging
// app via env vars.  Builds with config.js env-var support will pick these up
// directly; for older builds patchBuildUrls() handles it via main.js patching.
function buildLaunchEnv(prNumber) {
    const settings = loadSettings();
    const overrides = (settings.prOverrides || {})[prNumber] || {};
    const env = { ...process.env };

    if (overrides.landingUrl) {
        env.STAGING_LANDING_URL = overrides.landingUrl;
    }
    if (overrides.meetUrl) {
        env.STAGING_MEET_URL = overrides.meetUrl;
    }

    return env;
}

// Launch a cached build
ipcMain.handle('launch-build', async (_event, { prNumber }) => {
    const prNum = validPR(prNumber);
    const extractDir = path.join(CACHE_DIR, `pr-${prNum}`, 'app');

    // Apply URL overrides by patching the build's main.js inside the asar.
    // If no overrides are set, this restores the original asar.
    const settings = loadSettings();
    const overrides = (settings.prOverrides || {})[prNum] || {};

    await patchBuildUrls(extractDir, overrides);

    const env = buildLaunchEnv(prNum);

    // When URL overrides are active the target may be a local dev server
    // with a self-signed certificate (e.g. Vite --https).  Electron rejects
    // self-signed certs by default, resulting in chrome-error:// pages.
    // Pass the Chromium flag to allow them for this launched instance only.
    const hasOverrides = !!(overrides.landingUrl || overrides.meetUrl);
    const launchArgs = hasOverrides ? [ '--ignore-certificate-errors' ] : [];

    if (process.platform === 'darwin') {
        // Find the .app bundle
        const entries = fs.readdirSync(extractDir);
        const appBundle = entries.find(e => e.endsWith('.app'));

        if (!appBundle) {
            throw new Error('No .app bundle found in extracted build');
        }

        const appPath = path.join(extractDir, appBundle);

        // Strip quarantine attribute so macOS doesn't block unsigned app
        await execFileAsync('xattr', [ '-cr', appPath ]);

        // Launch the inner binary directly so env vars are forwarded.
        // `open -a` doesn't pass environment variables to the child process.
        const macOSDir = path.join(appPath, 'Contents', 'MacOS');
        const binaries = fs.readdirSync(macOSDir);
        const binary = binaries[0]; // There's typically one executable

        if (!binary) {
            throw new Error('No executable found in .app/Contents/MacOS/');
        }

        spawn(path.join(macOSDir, binary), launchArgs, {
            detached: true,
            stdio: 'ignore',
            env
        }).unref();
    } else {
        // Find the .exe
        const entries = fs.readdirSync(extractDir);
        const exe = entries.find(e => e.endsWith('.exe') && !e.includes('Uninstall'));

        if (!exe) {
            throw new Error('No .exe found in extracted build');
        }

        const exePath = path.join(extractDir, exe);

        spawn(exePath, launchArgs, { detached: true, stdio: 'ignore', cwd: extractDir, env }).unref();
    }

    return { success: true };
});

// Clear cache for a specific PR or all.
// Use "rd /s /q" on Windows — Node's fs.rmSync consistently hits EPERM
// on directories even with maxRetries and original-fs.
ipcMain.handle('clear-cache', async (_event, { prNumber }) => {
    const targets = [];

    if (prNumber) {
        const prNum = validPR(prNumber);

        targets.push(path.join(CACHE_DIR, `pr-${prNum}`));
    } else if (fs.existsSync(CACHE_DIR)) {
        for (const entry of fs.readdirSync(CACHE_DIR)) {
            targets.push(path.join(CACHE_DIR, entry));
        }
    }

    const errors = [];

    for (const target of targets) {
        if (!fs.existsSync(target)) {
            continue;
        }

        try {
            if (process.platform === 'win32') {
                await execFileAsync('cmd', [ '/c', 'rd', '/s', '/q', target ]);
            } else {
                fs.rmSync(target, { recursive: true, force: true });
            }
        } catch (err) {
            errors.push(err.message);
        }
    }

    if (errors.length > 0) {
        return { success: false, error: errors.join('\n') };
    }

    return { success: true };
});

// Get cache info
ipcMain.handle('get-cache-info', () => {
    if (!fs.existsSync(CACHE_DIR)) {
        return { totalSize: 0, entries: [] };
    }

    const entries = [];
    let totalSize = 0;

    for (const dir of fs.readdirSync(CACHE_DIR)) {
        const dirPath = path.join(CACHE_DIR, dir);
        const stat = fs.statSync(dirPath);

        if (!stat.isDirectory()) {
            continue;
        }

        const size = getDirSize(dirPath);

        totalSize += size;
        entries.push({ tag: dir, size });
    }

    return { totalSize, entries };
});

// Settings
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_event, settings) => {
    const current = loadSettings();

    saveSettings({ ...current, ...settings });

    return { success: true };
});

// Per-PR URL overrides
ipcMain.handle('save-pr-override', (_event, { prNumber, landingUrl, meetUrl }) => {
    const settings = loadSettings();

    if (!settings.prOverrides) {
        settings.prOverrides = {};
    }

    if (landingUrl || meetUrl) {
        settings.prOverrides[prNumber] = { landingUrl, meetUrl };
    } else {
        delete settings.prOverrides[prNumber];
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function downloadAsset(assetUrl, destPath, token, onProgress) {
    return new Promise((resolve, reject) => {
        const headers = {
            'User-Agent': 'Sonacove-Staging-Launcher',
            Accept: 'application/octet-stream'
        };

        if (token) {
            headers.Authorization = `token ${token}`;
        }

        // Parse the GitHub API asset URL
        const url = new URL(assetUrl);

        const req = https.get(
            { hostname: url.hostname, path: url.pathname + url.search, headers },
            res => {
                // GitHub redirects to S3 — follow the redirect
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    downloadUrl(res.headers.location, destPath, onProgress)
                        .then(resolve)
                        .catch(reject);

                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed: HTTP ${res.statusCode}`));

                    return;
                }

                const totalSize = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                const file = createWriteStream(destPath);

                res.on('data', chunk => {
                    downloaded += chunk.length;
                    if (totalSize > 0) {
                        onProgress(Math.round(downloaded / totalSize * 100));
                    }
                });

                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                file.on('error', err => {
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            }
        );

        req.on('error', reject);
        req.setTimeout(300000, () => {
            req.destroy(new Error('Download timed out'));
        });
    });
}

function downloadUrl(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);

        if (parsedUrl.protocol !== 'https:') {
            reject(new Error('Redirect to non-HTTPS URL rejected'));

            return;
        }

        const req = https.get(url, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: HTTP ${res.statusCode}`));

                return;
            }

            const totalSize = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;
            const file = createWriteStream(destPath);

            res.on('data', chunk => {
                downloaded += chunk.length;
                if (totalSize > 0) {
                    onProgress(Math.round(downloaded / totalSize * 100));
                }
            });

            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', err => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        });

        req.on('error', reject);
        req.setTimeout(300000, () => {
            req.destroy(new Error('Download timed out'));
        });
    });
}

function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        if (process.platform === 'darwin') {
            // Use ditto on macOS to preserve extended attributes and symlinks
            execFile('ditto', [ '-xk', zipPath, destDir ], err => {
                err ? reject(err) : resolve();
            });
        } else {
            // Use PowerShell on Windows
            execFile(
                'powershell',
                [
                    '-NoProfile',
                    '-Command',
                    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
                ],
                err => {
                    err ? reject(err) : resolve();
                }
            );
        }
    });
}

function execFileAsync(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout) => {
            err ? reject(err) : resolve(stdout);
        });
    });
}

function getDirSize(dirPath) {
    let size = 0;

    try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isFile()) {
                size += fs.statSync(fullPath).size;
            } else if (entry.isDirectory()) {
                size += getDirSize(fullPath);
            }
        }
    } catch {
        // Ignore errors
    }

    return size;
}

// ── Window ──────────────────────────────────────────────────────────────────

function getIconPath() {
    const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';

    // Staging-launcher's own color-shifted icon
    const launcherIcon = path.join(__dirname, 'resources', iconFile);

    if (fs.existsSync(launcherIcon)) {
        return launcherIcon;
    }

    // Fallback to the main app's icon
    const repoIcon = path.join(__dirname, '..', 'resources', iconFile);

    if (fs.existsSync(repoIcon)) {
        return repoIcon;
    }

    // Packaged launcher: icon is bundled by electron-builder
    return undefined;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 960,
        height: 700,
        minWidth: 700,
        minHeight: 500,
        title: 'Sonacove Staging Launcher',
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ── Auto-Update ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] Checking for launcher update...');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater-status', {
                status: 'checking'
            });
        }
    });

    autoUpdater.on('update-available', info => {
        console.log(`[updater] Update available: ${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater-status', {
                status: 'downloading',
                version: info.version
            });
        }
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[updater] No update available.');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater-status', {
                status: 'up-to-date'
            });
        }
    });

    autoUpdater.on('download-progress', progress => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater-status', {
                status: 'downloading',
                percent: Math.round(progress.percent)
            });
        }
    });

    autoUpdater.on('update-downloaded', info => {
        console.log(`[updater] Update downloaded: ${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater-status', {
                status: 'ready',
                version: info.version
            });

            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Launcher Update Ready',
                message: `Staging Launcher v${info.version} has been downloaded. Restart to update?`,
                buttons: [ 'Restart Now', 'Later' ]
            }).then(result => {
                if (result.response === 0) {
                    autoUpdater.quitAndInstall(false, true);
                }
            });
        }
    });

    autoUpdater.on('error', err => {
        console.error('[updater] Error:', err.message);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater-status', {
                status: 'error',
                error: err.message
            });
        }
    });

    // Check for updates after a short delay to let the UI load first
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.error('[updater] Check failed:', err.message);
        });
    }, 3000);
}

// IPC: allow renderer to request a manual update check
ipcMain.handle('check-for-updates', async () => {
    try {
        const result = await autoUpdater.checkForUpdates();

        return {
            updateAvailable: result && result.updateInfo
                && result.updateInfo.version !== app.getVersion()
        };
    } catch (err) {
        return { updateAvailable: false, error: err.message };
    }
});

// IPC: return current app version
ipcMain.handle('get-app-version', () => app.getVersion());

// Enforce single instance — focus existing window instead of opening a second
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        createWindow();
        setupAutoUpdater();
    });
}

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
