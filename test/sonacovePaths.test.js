'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Same module-cache trick as recording.test.js: inject a fake `electron`
 * before requiring sonacovePaths.js. Each test installs a fresh fake with
 * its own userDataDir / picturesDir / documentsDir so state cannot leak.
 */
function installFakeElectron(userDataDir, documentsDir, picturesDir) {
    const fakeElectron = {
        app: {
            getPath: k => {
                if (k === 'userData') return userDataDir;
                if (k === 'documents') return documentsDir;
                if (k === 'pictures') return picturesDir;

                return path.join(os.tmpdir(), `fake-${k}`);
            }
        },
        ipcMain: { handle: () => {} },
        BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        shell: { openPath: async () => '', showItemInFolder: () => {} }
    };

    require.cache[require.resolve('electron')] = {
        id: 'electron',
        filename: 'electron',
        loaded: true,
        exports: fakeElectron
    };
}

function resetSutCache() {
    const toDrop = [
        '../app/features/sonacovePaths.js'
    ];

    for (const rel of toDrop) {
        try {
            delete require.cache[require.resolve(rel)];
        } catch { /* not cached yet */ }
    }
    try {
        delete require.cache[require.resolve('electron')];
    } catch { /* not cached yet */ }
}

async function mkTempDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('sonacovePaths.loadSettings — mismatched version falls back to defaults and warns', async () => {
    const userDataDir = await mkTempDir('sonacove-paths-ud-');
    const documentsDir = await mkTempDir('sonacove-paths-docs-');
    const picturesDir = await mkTempDir('sonacove-paths-pics-');

    // Seed a v999 (future-version) file. The current build expects v1, so
    // loadSettings() must reject the overrides and warn.
    const settingsPath = path.join(userDataDir, '.sonacove-save-paths.json');

    fsSync.writeFileSync(settingsPath, JSON.stringify({
        version: 999,
        recordings: '/custom/path',
        screenshots: '/other'
    }));

    resetSutCache();
    installFakeElectron(userDataDir, documentsDir, picturesDir);

    // Spy on console.warn for the duration of the test.
    const originalWarn = console.warn;
    const warnCalls = [];

    console.warn = (...args) => { warnCalls.push(args); };

    try {
        const { getSavePathsInfo } = require('../app/features/sonacovePaths.js');

        const info = getSavePathsInfo();

        // Override must be null — the v999 values were rejected.
        assert.equal(info.recordings.override, null, 'recordings override is null');
        assert.equal(info.screenshots.override, null, 'screenshots override is null');

        // `current` should fall back to the platform defaults
        // (documentsDir/Sonacove/{Recordings,Screenshots}).
        const expectedRecordings = path.join(documentsDir, 'Sonacove', 'Recordings');
        const expectedScreenshots = path.join(documentsDir, 'Sonacove', 'Screenshots');

        assert.equal(info.recordings.current, expectedRecordings);
        assert.equal(info.screenshots.current, expectedScreenshots);
        assert.equal(info.recordings.default, expectedRecordings);
        assert.equal(info.screenshots.default, expectedScreenshots);

        // A warn must have been emitted about the version mismatch.
        const matched = warnCalls.some(call =>
            call.some(arg => typeof arg === 'string' && arg.includes('settings version 999')));

        assert.ok(matched, 'console.warn carried the version-mismatch message');
    } finally {
        console.warn = originalWarn;
        await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.rm(documentsDir, { recursive: true, force: true });
        await fs.rm(picturesDir, { recursive: true, force: true });
    }
});

test('sonacovePaths.saveSettings — concurrent saves of different keys both land on disk', async () => {
    // Lost-update guard: two parallel saveSettings calls each touching a
    // different key. Without serialization, both read the same baseline
    // cachedSettings (recordings:null, screenshots:null), merge their own
    // key, and the second write clobbers the first. With serialization,
    // the second call sees the first call's update via cachedSettings and
    // both keys persist.
    const userDataDir = await mkTempDir('sonacove-paths-ud-');
    const documentsDir = await mkTempDir('sonacove-paths-docs-');
    const picturesDir = await mkTempDir('sonacove-paths-pics-');

    resetSutCache();
    installFakeElectron(userDataDir, documentsDir, picturesDir);

    try {
        const { saveSettings: save } = require('../app/features/sonacovePaths.js');

        const pathA = path.join(os.tmpdir(), 'sonacove-test-recordings-A');
        const pathB = path.join(os.tmpdir(), 'sonacove-test-screenshots-B');

        // Kick off both saves "simultaneously" — Promise.all returns once
        // both resolve. The serialization queue inside saveSettings forces
        // them through in order without dropping either key.
        await Promise.all([
            save({ recordings: pathA }),
            save({ screenshots: pathB })
        ]);

        // Read the file directly from disk (not via cache) and assert both
        // keys made it through.
        const raw = fsSync.readFileSync(path.join(userDataDir, '.sonacove-save-paths.json'), 'utf8');
        const parsed = JSON.parse(raw);

        assert.equal(parsed.version, 1);
        assert.equal(parsed.recordings, pathA, 'recordings override survived concurrent save');
        assert.equal(parsed.screenshots, pathB, 'screenshots override survived concurrent save');
    } finally {
        await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.rm(documentsDir, { recursive: true, force: true });
        await fs.rm(picturesDir, { recursive: true, force: true });
    }
});

test('sonacovePaths.saveSettings — rename failure leaves existing file untouched', async () => {
    // Atomic-write guard: stub fs.promises.rename to throw on the second
    // save and assert the prior valid file content is preserved (the
    // partially-written .tmp must not have replaced the real file).
    const userDataDir = await mkTempDir('sonacove-paths-ud-');
    const documentsDir = await mkTempDir('sonacove-paths-docs-');
    const picturesDir = await mkTempDir('sonacove-paths-pics-');

    resetSutCache();
    installFakeElectron(userDataDir, documentsDir, picturesDir);

    const settingsPath = path.join(userDataDir, '.sonacove-save-paths.json');
    const realRename = fsSync.promises.rename;

    try {
        const { saveSettings: save } = require('../app/features/sonacovePaths.js');

        // First save lays down a known-good file.
        const goodPath = path.join(os.tmpdir(), 'sonacove-test-good');

        await save({ recordings: goodPath });

        const beforeRaw = fsSync.readFileSync(settingsPath, 'utf8');
        const beforeParsed = JSON.parse(beforeRaw);

        assert.equal(beforeParsed.recordings, goodPath, 'baseline file holds first save');

        // Now stub rename so the next save fails after writing the .tmp.
        fsSync.promises.rename = () => Promise.reject(new Error('simulated rename crash'));

        const badPath = path.join(os.tmpdir(), 'sonacove-test-bad');

        await assert.rejects(
            save({ recordings: badPath }),
            /simulated rename crash/,
            'saveSettings surfaces rename failure to caller'
        );

        // Real file unchanged — still points at the first save's value.
        const afterRaw = fsSync.readFileSync(settingsPath, 'utf8');
        const afterParsed = JSON.parse(afterRaw);

        assert.equal(afterParsed.recordings, goodPath, 'target file preserved after rename failure');
        assert.equal(afterRaw, beforeRaw, 'target file is byte-identical to pre-crash state');
    } finally {
        fsSync.promises.rename = realRename;
        await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.rm(documentsDir, { recursive: true, force: true });
        await fs.rm(picturesDir, { recursive: true, force: true });
    }
});

test('sonacovePaths.getAllowedRevealDirs — v1 file with custom overrides includes defaults, overrides, and legacy', async () => {
    const userDataDir = await mkTempDir('sonacove-paths-ud-');
    const documentsDir = await mkTempDir('sonacove-paths-docs-');
    const picturesDir = await mkTempDir('sonacove-paths-pics-');

    const customRecordings = path.join(os.tmpdir(), 'sonacove-test-custom-recordings');
    const customScreenshots = path.join(os.tmpdir(), 'sonacove-test-custom-screenshots');

    const settingsPath = path.join(userDataDir, '.sonacove-save-paths.json');

    fsSync.writeFileSync(settingsPath, JSON.stringify({
        version: 1,
        recordings: customRecordings,
        screenshots: customScreenshots
    }));

    resetSutCache();
    installFakeElectron(userDataDir, documentsDir, picturesDir);

    try {
        const { getAllowedRevealDirs } = require('../app/features/sonacovePaths.js');

        const dirs = getAllowedRevealDirs();

        const expectedDefaultRecordings = path.join(documentsDir, 'Sonacove', 'Recordings');
        const expectedDefaultScreenshots = path.join(documentsDir, 'Sonacove', 'Screenshots');
        const expectedLegacy = path.join(picturesDir, 'Sonacove Screenshots');

        // Defaults present.
        assert.ok(dirs.includes(expectedDefaultRecordings), 'includes default recordings dir');
        assert.ok(dirs.includes(expectedDefaultScreenshots), 'includes default screenshots dir');
        // Legacy ~/Pictures/Sonacove Screenshots present.
        assert.ok(dirs.includes(expectedLegacy), 'includes legacy pictures screenshots dir');
        // Custom overrides present.
        assert.ok(dirs.includes(customRecordings), 'includes custom recordings override');
        assert.ok(dirs.includes(customScreenshots), 'includes custom screenshots override');
    } finally {
        await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.rm(documentsDir, { recursive: true, force: true });
        await fs.rm(picturesDir, { recursive: true, force: true });
    }
});
