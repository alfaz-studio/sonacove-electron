const fs = require('original-fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Validate PR number to prevent path traversal.
 * @param {string|number} prNumber
 * @returns {number} Parsed, positive integer
 */
function validPR(prNumber) {
    const n = parseInt(prNumber, 10);

    if (!Number.isFinite(n) || n <= 0) {
        throw new Error('Invalid PR number');
    }

    return n;
}

/**
 * Validate a build identifier and return the cache subdirectory name.
 * Accepts a positive integer (PR number → "pr-N") or the literal "main".
 * @param {string|number} buildId
 * @returns {string} Cache subdirectory name
 */
function validBuildId(buildId) {
    if (buildId === 'main') {
        return 'main';
    }

    return `pr-${validPR(buildId)}`;
}

/**
 * Cross-platform recursive directory removal.
 * Uses `rd /s /q` on Windows — Node's fs.rmSync consistently hits EPERM
 * on cache directories even with maxRetries and original-fs.
 */
async function rmDir(dirPath) {
    if (process.platform === 'win32') {
        await execFileAsync('cmd', [ '/c', 'rd', '/s', '/q', dirPath ]);
    } else {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
}

/**
 * Promise wrapper around child_process.execFile.
 */
function execFileAsync(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout) => {
            err ? reject(err) : resolve(stdout);
        });
    });
}

/**
 * Platform-specific ZIP extraction.
 * macOS: ditto (preserves extended attributes and symlinks).
 * Windows: PowerShell Expand-Archive.
 */
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

/**
 * Recursively calculate directory size in bytes.
 * Silently ignores errors (permission denied, etc.).
 */
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

module.exports = { validPR, validBuildId, rmDir, execFileAsync, extractZip, getDirSize };
