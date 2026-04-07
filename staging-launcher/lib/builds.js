const https = require('https');
const fs = require('original-fs');
const { createWriteStream } = require('original-fs');
const path = require('path');
const { spawn } = require('child_process');
const { validPR, validBuildId, rmDir, extractZip, execFileAsync, getDirSize } = require('./fs-utils');
const { patchBuildUrls, buildLaunchEnv } = require('./patching');

// ── Download helpers ────────────────────────────────────────────────────────

/**
 * Download a GitHub release asset (follows the redirect to S3).
 * @param {string} assetUrl  GitHub API asset URL
 * @param {string} destPath  Local file path
 * @param {string} [token]   PAT for auth
 * @param {Function} onProgress  Called with percentage (0-100)
 */
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

/**
 * Direct HTTPS download (for S3 redirect targets).
 * Rejects non-HTTPS redirects for security.
 */
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

// ── Build operations ────────────────────────────────────────────────────────

/**
 * Download and extract a staging build.
 * @param {{ prNumber?, buildId?, assetUrl, sha, token, cacheDir, getMainWindow }} opts
 */
async function downloadBuild({ prNumber, buildId, assetUrl, sha, token, cacheDir, getMainWindow }) {
    if (!assetUrl.startsWith('https://api.github.com/')) {
        throw new Error('Asset URL must be from api.github.com');
    }

    const cacheSubdir = buildId ? validBuildId(buildId) : `pr-${validPR(prNumber)}`;
    const progressKey = buildId || prNumber;
    const prCacheDir = path.join(cacheDir, cacheSubdir);
    const zipPath = path.join(prCacheDir, 'build.zip');
    const extractDir = path.join(prCacheDir, 'app');

    // Clean previous download
    if (fs.existsSync(prCacheDir)) {
        if (process.platform === 'win32') {
            await execFileAsync('cmd', [ '/c', 'rd', '/s', '/q', prCacheDir ]);
        } else {
            fs.rmSync(prCacheDir, { recursive: true, force: true });
        }
    }

    fs.mkdirSync(extractDir, { recursive: true });

    // Download the asset (GitHub API redirects to S3)
    const mainWindow = getMainWindow();

    await downloadAsset(assetUrl, zipPath, token, progress => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', { prNumber: progressKey, progress });
        }
    });

    // Extract
    await extractZip(zipPath, extractDir);

    // Clean up the zip to save space
    fs.rmSync(zipPath, { force: true });

    // Write meta
    fs.writeFileSync(
        path.join(prCacheDir, 'meta.json'),
        JSON.stringify({ sha, downloadedAt: new Date().toISOString() })
    );

    return { success: true };
}

/**
 * Launch a cached staging build.
 * @param {{ prNumber?, buildId?, cacheDir, loadSettings }} opts
 */
async function launchBuild({ prNumber, buildId, cacheDir, loadSettings }) {
    const cacheSubdir = buildId ? validBuildId(buildId) : `pr-${validPR(prNumber)}`;
    const overrideKey = buildId || prNumber;
    const extractDir = path.join(cacheDir, cacheSubdir, 'app');

    // On macOS, find the .app bundle once — used for quarantine stripping,
    // patching, and launching.
    let macAppBundle = null;

    if (process.platform === 'darwin') {
        const entries = fs.readdirSync(extractDir);

        macAppBundle = entries.find(e => e.endsWith('.app'));

        if (!macAppBundle) {
            throw new Error('No .app bundle found in extracted build');
        }

        // Strip the quarantine attribute BEFORE patching.  ditto/unzip sets
        // com.apple.quarantine on extracted files, and macOS can prevent
        // reading inside a quarantined .app bundle — causing patchBuildUrls()
        // to fail with "No app.asar backup found" because fs.existsSync()
        // returns false for files inside the quarantined bundle.
        await execFileAsync('xattr', [ '-cr', path.join(extractDir, macAppBundle) ]);
    }

    // Apply URL overrides by patching the build's main.js inside the asar.
    // If no overrides are set, this restores the original asar.
    const settings = loadSettings();
    const overrides = (settings.prOverrides || {})[overrideKey] || {};

    await patchBuildUrls(extractDir, overrides);

    const env = buildLaunchEnv(overrideKey, loadSettings);

    // When URL overrides are active the target may be a local dev server
    // with a self-signed certificate (e.g. Vite --https).  Electron rejects
    // self-signed certs by default, resulting in chrome-error:// pages.
    // Pass the Chromium flag to allow them for this launched instance only.
    // Security note: --ignore-certificate-errors is intentional here. The staging
    // launcher's UI shows a visible ".has-override" indicator when custom URLs are
    // active, making it clear to the user that cert validation is relaxed.
    const hasOverrides = !!(overrides.landingUrl || overrides.meetUrl);
    const launchArgs = hasOverrides ? [ '--ignore-certificate-errors' ] : [];

    if (process.platform === 'darwin') {
        const appPath = path.join(extractDir, macAppBundle);

        // Launch the inner binary directly so env vars are forwarded.
        // `open -a` doesn't pass environment variables to the child process.
        const macOSDir = path.join(appPath, 'Contents', 'MacOS');
        // Electron's main binary has no extension; helper executables and
        // libraries (crash reporter, etc.) do.  Prefer the extensionless entry
        // so we don't accidentally launch a helper if one is ever added.
        const binaries = fs.readdirSync(macOSDir);
        const binary = binaries.find(b => !b.includes('.')) ?? binaries[0];

        if (!binary) {
            throw new Error('No executable found in .app/Contents/MacOS/');
        }

        spawn(path.join(macOSDir, binary), launchArgs, {
            detached: true,
            stdio: 'ignore',
            env
        }).unref();
    } else if (process.platform === 'win32') {
        // Find the .exe
        const entries = fs.readdirSync(extractDir);
        const exe = entries.find(e => e.endsWith('.exe') && !e.includes('Uninstall'));

        if (!exe) {
            throw new Error('No .exe found in extracted build');
        }

        const exePath = path.join(extractDir, exe);

        spawn(exePath, launchArgs, { detached: true, stdio: 'ignore', cwd: extractDir, env }).unref();
    } else {
        // Linux — look for the main executable (no extension, executable bit set)
        const entries = fs.readdirSync(extractDir);
        const binary = entries.find(e => !e.includes('.') && !e.includes('Uninstall'));

        if (!binary) {
            throw new Error('No executable found in extracted build');
        }

        const binPath = path.join(extractDir, binary);

        // Ensure the binary is executable (ZIP extraction may not preserve mode bits)
        await execFileAsync('chmod', [ '+x', binPath ]);

        spawn(binPath, launchArgs, { detached: true, stdio: 'ignore', cwd: extractDir, env }).unref();
    }

    return { success: true };
}

/**
 * Clear cache for a specific PR, multiple PRs, or all cached builds.
 * Uses "rd /s /q" on Windows — Node's fs.rmSync consistently hits EPERM
 * on directories even with maxRetries and original-fs.
 * @param {{ prNumber?, prNumbers?, buildId?, cacheDir }} opts
 */
async function clearCache({ prNumber, prNumbers, buildId, cacheDir }) {
    const targets = [];

    if (buildId) {
        targets.push(path.join(cacheDir, validBuildId(buildId)));
    } else if (prNumbers && prNumbers.length > 0) {
        // Clear cache for a list of PRs (used by "clear unused" for closed/merged PRs)
        for (const num of prNumbers) {
            targets.push(path.join(cacheDir, `pr-${validPR(num)}`));
        }
    } else if (prNumber) {
        const prNum = validPR(prNumber);

        targets.push(path.join(cacheDir, `pr-${prNum}`));
    } else if (fs.existsSync(cacheDir)) {
        for (const entry of fs.readdirSync(cacheDir)) {
            targets.push(path.join(cacheDir, entry));
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
}

/**
 * Get cache info (total size + per-entry breakdown).
 * @param {string} cacheDir
 */
function getCacheInfo(cacheDir) {
    if (!fs.existsSync(cacheDir)) {
        return { totalSize: 0, entries: [] };
    }

    const entries = [];
    let totalSize = 0;

    for (const dir of fs.readdirSync(cacheDir)) {
        const dirPath = path.join(cacheDir, dir);
        const stat = fs.statSync(dirPath);

        if (!stat.isDirectory()) {
            continue;
        }

        const size = getDirSize(dirPath);

        totalSize += size;
        entries.push({ tag: dir, size });
    }

    return { totalSize, entries };
}

module.exports = { downloadBuild, launchBuild, clearCache, getCacheInfo };
