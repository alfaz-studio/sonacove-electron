#!/usr/bin/env node


// Build the Windows WASAPI process-loopback audio addon against
// Electron's V8 ABI.
//
// Why not just `node-gyp rebuild`?
//   - It would build against the host Node's V8 ABI, which Electron does
//     not load (different NODE_MODULE_VERSION → "was compiled against a
//     different Node.js version" at require()).
//
// Windows-side simpler than macOS: no universal binary (Windows is
// single-arch per build, x64 covers virtually all clients), so no `lipo`
// equivalent.
//
// Mirrors scripts/build-macaudio.js. Skips on non-Windows so Mac/Linux
// contributors can still `npm install` without VS Build Tools.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') {
    process.stderr.write(
        `[winaudio] skipping native build on ${
            process.platform
        } (Windows-only feature)\n`
    );
    process.exit(0);
}

const repoRoot = path.join(__dirname, '..');
const addonRoot = path.join(repoRoot, 'native', 'winaudio');
const electronVersion = require(path.join(repoRoot, 'package.json'))
    .devDependencies.electron;

if (!electronVersion) {
    process.stderr.write('[winaudio] unable to read Electron version from package.json\n');
    process.exit(1);
}

// Install the addon's own deps (node-addon-api) the first time. Subsequent
// runs short-circuit. Keeping it self-contained means top-level package.json
// doesn't need to know about node-addon-api or node-gyp build details.
if (!fs.existsSync(path.join(addonRoot, 'node_modules', 'node-addon-api'))) {
    process.stdout.write('[winaudio] installing addon build deps\n');
    const install = spawnSync(
        'npm',
        [ 'install', '--no-save', '--no-audit', '--no-fund' ],
        {
            cwd: addonRoot,
            stdio: 'inherit',
            shell: true
        }
    );

    if (install.status !== 0) {
        process.stderr.write('[winaudio] addon dep install failed\n');
        process.exit(install.status === null ? 1 : install.status);
    }
}

const releaseDir = path.join(addonRoot, 'build', 'Release');

// Skip the universal-build dance the Mac side needs — Windows is
// single-arch per build. node-gyp picks up the host arch and leaves the
// .node at the canonical path that index.js loads.
process.stdout.write(
    `[winaudio] building against electron ${electronVersion}\n`
);

const result = spawnSync(
    'npx',
    [
        '--no-install',
        'node-gyp',
        'rebuild',
        `--target=${electronVersion}`,
        '--dist-url=https://electronjs.org/headers',
        '--runtime=electron'
    ],
    {
        cwd: addonRoot,
        stdio: 'inherit',
        shell: true,

        // Same PATH-forwarding trick as the Mac script — npx walks the
        // tree to find node-gyp, and we want the project's local copy.
        env: {
            ...process.env,
            PATH: `${path.join(repoRoot, 'node_modules', '.bin')};${process.env.PATH}`
        }
    }
);

if (result.status !== 0) {
    process.stderr.write('[winaudio] node-gyp failed\n');
    process.exit(result.status === null ? 1 : result.status);
}

const built = path.join(releaseDir, 'winaudio.node');

if (!fs.existsSync(built)) {
    process.stderr.write(`[winaudio] expected output not found at ${built}\n`);
    process.exit(1);
}

process.stdout.write(`[winaudio] build complete: ${built}\n`);
