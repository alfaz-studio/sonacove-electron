#!/usr/bin/env node


// Build the macOS ScreenCaptureKit audio addon against Electron's V8 ABI
// and produce a universal (arm64 + x86_64) `.node` binary.
//
// Why not just `node-gyp rebuild`?
//   - It would build against the host Node's V8 ABI, which Electron does
//     not load (different NODE_MODULE_VERSION → "was compiled against a
//     different Node.js version" at require()).
//   - It would build for the host arch only. Released Macs need a
//     universal binary so a single dmg works on both Intel and Apple
//     Silicon machines.
//
// The script:
//   1. Skips on non-macOS (Linux/Windows contributors can still
//      `npm install` without Xcode).
//   2. Reads Electron version from the parent package.json.
//   3. Builds twice with `node-gyp rebuild --target=<v> --dist-url=…
//      --arch=<arch>` for each of arm64 and x86_64.
//   4. Lipos the two outputs into one fat `.node` written to
//      `build/Release/macaudio.node`.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin') {
    process.stderr.write(
        `[macaudio] skipping native build on ${
            process.platform
        } (macOS-only feature)\n`
    );
    process.exit(0);
}

const repoRoot = path.join(__dirname, '..');
const addonRoot = path.join(repoRoot, 'native', 'macaudio');
const electronVersion = require(path.join(repoRoot, 'package.json'))
    .devDependencies.electron;

if (!electronVersion) {
    process.stderr.write('[macaudio] unable to read Electron version from package.json\n');
    process.exit(1);
}

// Install the addon's own deps (node-addon-api) the first time. Subsequent
// runs short-circuit. Keeping it self-contained means top-level package.json
// doesn't need to know about node-addon-api or node-gyp build details.
if (!fs.existsSync(path.join(addonRoot, 'node_modules', 'node-addon-api'))) {
    process.stdout.write('[macaudio] installing addon build deps\n');
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
        process.stderr.write('[macaudio] addon dep install failed\n');
        process.exit(install.status === null ? 1 : install.status);
    }
}

// Universal builds are slow (~2× single-arch) but unavoidable for a single
// dmg that runs on both Intel and Apple Silicon. Devs running locally can
// skip the universal build and produce a host-arch-only binary by setting
// MACAUDIO_HOST_ARCH=1, which makes the inner-loop fast for iteration.
const hostOnly = process.env.MACAUDIO_HOST_ARCH === '1';
const archs = hostOnly ? [ process.arch ] : [ 'arm64', 'x64' ];
const releaseDir = path.join(addonRoot, 'build', 'Release');

// Stage outside `build/` entirely: `node-gyp rebuild` runs `clean` first,
// which wipes the addon's build/ directory wholesale — anything we tucked
// into a subdirectory there gets blown away between archs. The OS temp
// dir survives across runs and is automatically cleaned by the OS.
const stagingDir = hostOnly
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), 'macaudio-build-'));
const stagingByArch = {};

for (const arch of archs) {
    process.stdout.write(`[macaudio] building for ${arch} against electron ${electronVersion}\n`);

    // Use `npx` so we pick up the locally-installed `node-gyp` that npm
    // shipped alongside the project. A bare `node-gyp` invocation works
    // only when the user has it globally on PATH, which we can't assume
    // (CI runners don't, and neither do most fresh dev machines).
    const result = spawnSync(
        'npx',
        [
            '--no-install',
            'node-gyp',
            'rebuild',
            `--target=${electronVersion}`,
            '--dist-url=https://electronjs.org/headers',
            `--arch=${arch}`,
            '--runtime=electron'
        ],
        {
            cwd: addonRoot,
            stdio: 'inherit',
            shell: true,

            // npx looks at the parent project's node_modules first; if
            // node-gyp isn't there it walks up. Setting cwd to the addon
            // dir AND forwarding PATH from the repo root ensures it
            // resolves to the same node-gyp the rest of the project uses.
            env: {
                ...process.env,
                PATH: `${path.join(repoRoot, 'node_modules', '.bin')}:${process.env.PATH}`
            }
        }
    );

    if (result.status !== 0) {
        process.stderr.write(`[macaudio] node-gyp failed for ${arch}\n`);
        process.exit(result.status === null ? 1 : result.status);
    }

    // Stash the per-arch artifact so the lipo step has stable paths to
    // pull from. node-gyp overwrites build/Release/ in place on each run,
    // so we move out before the next arch starts.
    const built = path.join(releaseDir, 'macaudio.node');

    if (!fs.existsSync(built)) {
        process.stderr.write(`[macaudio] expected output not found at ${built}\n`);
        process.exit(1);
    }

    const staged = hostOnly
        ? built
        : path.join(stagingDir, `macaudio-${arch}.node`);

    if (!hostOnly) {
        fs.renameSync(built, staged);
    }
    stagingByArch[arch] = staged;
}

if (hostOnly) {
    // Host-only build: node-gyp already left the binary at the canonical
    // path; nothing to move.
    process.stdout.write('[macaudio] host-only build complete (universal skipped)\n');
    process.exit(0);
}

// lipo creates a fat Mach-O containing both slices. Both architectures'
// dynamic linker entries are preserved; the OS picks the right one at
// load time. The output is what `index.js` requires.
const finalPath = path.join(releaseDir, 'macaudio.node');
const lipoArgs = [ '-create', '-output', finalPath, ...Object.values(stagingByArch) ];
const lipo = spawnSync('lipo', lipoArgs, { stdio: 'inherit' });

if (lipo.status !== 0) {
    process.stderr.write('[macaudio] lipo failed\n');
    process.exit(lipo.status === null ? 1 : lipo.status);
}

// Tidy staging dir; lipo's output is the only thing we ship.
fs.rmSync(stagingDir, { recursive: true,
    force: true });

process.stdout.write(`[macaudio] universal build complete: ${finalPath}\n`);
