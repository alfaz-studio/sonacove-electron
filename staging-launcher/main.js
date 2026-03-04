const { app, BrowserWindow, ipcMain, shell } = require('electron');
const https = require('https');
// Use original-fs to bypass Electron's asar patching.  The patched fs
// opens .asar files transparently, which holds file handles and causes
// EPERM when we later try to delete the cache directory.
const fs = require('original-fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { createWriteStream } = require('original-fs');

const GITHUB_OWNER = 'alfaz-studio';
const GITHUB_REPO = 'sonacove-electron';
const CACHE_DIR = path.join(app.getPath('userData'), 'staging-builds');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

let mainWindow = null;

// ── Settings ────────────────────────────────────────────────────────────────

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

    await Promise.all([ ...shasToPrs.keys() ].map(async sha => {
        try {
            const { data } = await githubApi(
                `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${sha}`,
                token
            );

            commitMap.set(sha, data.commit.message.split('\n')[0]); // first line only
        } catch {
            // Ignore — commit message is optional
        }
    }));

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

// Download a build
ipcMain.handle('download-build', async (event, { prNumber, assetUrl, sha, token }) => {
    const cacheDir = path.join(CACHE_DIR, `pr-${prNumber}`);
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

// Launch a cached build
ipcMain.handle('launch-build', async (_event, { prNumber }) => {
    const extractDir = path.join(CACHE_DIR, `pr-${prNumber}`, 'app');

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

        spawn('open', [ '-a', appPath ], { detached: true, stdio: 'ignore' }).unref();
    } else {
        // Find the .exe
        const entries = fs.readdirSync(extractDir);
        const exe = entries.find(e => e.endsWith('.exe') && !e.includes('Uninstall'));

        if (!exe) {
            throw new Error('No .exe found in extracted build');
        }

        const exePath = path.join(extractDir, exe);

        spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: extractDir }).unref();
    }

    return { success: true };
});

// Clear cache for a specific PR or all.
// Use "rd /s /q" on Windows — Node's fs.rmSync consistently hits EPERM
// on directories even with maxRetries and original-fs.
ipcMain.handle('clear-cache', async (_event, { prNumber }) => {
    const targets = [];

    if (prNumber) {
        targets.push(path.join(CACHE_DIR, `pr-${prNumber}`));
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
    saveSettings(settings);

    return { success: true };
});

// Open external link
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));

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
            { hostname: url.hostname, path: url.pathname, headers },
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
        const protocol = parsedUrl.protocol === 'https:' ? https : require('http');

        const req = protocol.get(url, res => {
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
                    `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
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

app.whenReady().then(() => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
