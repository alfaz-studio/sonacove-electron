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

// Use original-fs to bypass Electron's asar patching.  The patched fs
// opens .asar files transparently, which holds file handles and causes
// EPERM when we later try to delete the cache directory.
const fs = require('original-fs');
// Electron-patched fs — reads asar archives transparently.  We use this
// to extract files from app.asar when patching builds with custom URLs.
const nodeFs = require('fs');
const path = require('path');
const { rmDir } = require('./fs-utils');

// ── Asar extraction helpers ─────────────────────────────────────────────────

/**
 * Recursively copy files out of an asar archive.  `nodeFs` (Electron's
 * patched fs) reads asar contents transparently, including files that the
 * asar marks as "unpacked" (native .node binaries in app.asar.unpacked/).
 * We write with `fs` (original-fs) so we create real files on disk.
 */
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

/**
 * Recursively copy a real directory (using original-fs, no asar patching).
 * Used to overlay the .asar.unpacked contents onto the extracted app dir.
 */
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

// ── main.js patching ────────────────────────────────────────────────────────

/**
 * Apply a regex replacement and warn if it didn't match.
 * Fragile patterns that depend on webpack/terser output should be
 * surfaced when they silently no-op so failures are caught in testing.
 */
function tryReplace(src, pattern, replacement, label) {
    const result = src.replace(pattern, replacement);

    if (result === src) {
        console.warn(`[patcher] ${label} — pattern did not match:`, pattern.toString());
    }

    return result;
}

/**
 * Patch the compiled build/main.js with URL overrides and layout fixes.
 *
 * ⚠ The URL strings and hostnames below must stay in sync with
 * app/features/sonacove/config.js (staging block).
 */
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

// ── Path resolution helpers ─────────────────────────────────────────────────

/**
 * Search recursively for app.asar to derive the correct resources directory.
 * Handles unexpected extraction structures (extra nesting, renamed dirs, etc.)
 * by returning the *directory* containing app.asar.
 * @param {string} dir  Starting directory
 * @param {number} [maxDepth=5]  Maximum recursion depth
 * @returns {string|null}  Path to the directory containing app.asar, or null
 */
function findResourcesDir(dir, maxDepth = 5) {
    if (maxDepth <= 0) {
        return null;
    }

    let entries;

    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }

    // Check if app.asar is directly in this directory
    if (entries.some(e => e.name === 'app.asar')) {
        return dir;
    }

    // Recurse into subdirectories
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const found = findResourcesDir(path.join(dir, entry.name), maxDepth - 1);

            if (found) {
                return found;
            }
        }
    }

    return null;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Apply or restore URL overrides for a cached staging build.
 * @param {string} extractDir  Path to the extracted build (e.g. .../pr-123/app)
 * @param {{ landingUrl?: string, meetUrl?: string }} overrides
 */
async function patchBuildUrls(extractDir, overrides) {
    // On macOS, builds are .app bundles — resources live inside
    // Contents/Resources/ rather than a top-level resources/ folder.
    let resourcesDir = path.join(extractDir, 'resources');

    if (process.platform === 'darwin') {
        const entries = fs.readdirSync(extractDir);
        const appBundle = entries.find(e => e.endsWith('.app'));

        console.log('[patcher] extractDir entries:', entries);
        console.log('[patcher] detected .app bundle:', appBundle || '(none)');

        if (appBundle) {
            resourcesDir = path.join(extractDir, appBundle, 'Contents', 'Resources');
        }

        // Fallback: if the expected resourcesDir doesn't contain app.asar,
        // search recursively.  ditto/unzip may produce unexpected nesting
        // depending on how the zip was created and which macOS version extracts it.
        if (!fs.existsSync(path.join(resourcesDir, 'app.asar'))
            && !fs.existsSync(path.join(resourcesDir, 'app-backup.asar'))) {
            const fallback = findResourcesDir(extractDir);

            if (fallback) {
                console.log('[patcher] fallback resourcesDir:', fallback);
                resourcesDir = fallback;
            }
        }
    }
    const asarPath = path.join(resourcesDir, 'app.asar');
    const asarBackup = path.join(resourcesDir, 'app-backup.asar');
    const asarUnpacked = path.join(resourcesDir, 'app.asar.unpacked');
    const asarUnpackedBackup = path.join(resourcesDir, 'app-backup.asar.unpacked');
    const appDir = path.join(resourcesDir, 'app');

    const hasOverrides = !!(overrides.landingUrl || overrides.meetUrl);

    if (process.platform === 'darwin') {
        console.log('[patcher] resourcesDir:', resourcesDir);
        console.log('[patcher] resourcesDir exists:', fs.existsSync(resourcesDir));
        if (fs.existsSync(resourcesDir)) {
            console.log('[patcher] resourcesDir entries:', fs.readdirSync(resourcesDir));
        }
        console.log('[patcher] app.asar exists:', fs.existsSync(asarPath));
        console.log('[patcher] app/ dir exists:', fs.existsSync(appDir));
    }

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
        const diag = {
            resourcesDir,
            asarPath,
            appDir,
            resourcesDirExists: fs.existsSync(resourcesDir),
            resourcesDirEntries: fs.existsSync(resourcesDir) ? fs.readdirSync(resourcesDir) : [],
            extractDirEntries: fs.readdirSync(extractDir)
        };

        throw new Error(
            'No app.asar backup found — cannot apply URL overrides\n'
            + JSON.stringify(diag, null, 2)
        );
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

/**
 * Build a spawn environment that forwards custom preview URLs to the staging
 * app via env vars.  Builds with config.js env-var support will pick these up
 * directly; for older builds patchBuildUrls() handles it via main.js patching.
 *
 * @param {number} prNumber
 * @param {Function} loadSettings  Settings loader (injected to avoid coupling)
 * @returns {{ [key: string]: string }}
 */
function buildLaunchEnv(prNumber, loadSettings) {
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

module.exports = { copyFromAsar, copyDirReal, findResourcesDir, patchMainJs, patchBuildUrls, buildLaunchEnv };
