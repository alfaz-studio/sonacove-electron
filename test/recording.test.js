'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Installs a fake `electron` module into the require cache so SUTs that
 * `require('electron')` resolve to our stub. Must run BEFORE the SUT is
 * required (Node only consults require.cache on first load).
 *
 * @param {string} userDataDir - real writable dir returned for app.getPath('userData')
 * @param {string} documentsDir - real writable dir returned for app.getPath('documents')
 * @param {string} picturesDir - real writable dir returned for app.getPath('pictures')
 */
function installFakeElectron(userDataDir, documentsDir, picturesDir) {
    const handlers = new Map();
    const fakeElectron = {
        app: {
            getPath: k => {
                if (k === 'userData') return userDataDir;
                if (k === 'documents') return documentsDir;
                if (k === 'pictures') return picturesDir;

                return path.join(os.tmpdir(), `fake-${k}`);
            }
        },
        ipcMain: {
            handle: (channel, fn) => {
                handlers.set(channel, fn);
            }
        },
        BrowserWindow: {
            fromWebContents: () => null,
            getAllWindows: () => []
        },
        dialog: {
            showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
            showMessageBox: async () => ({ response: 0 })
        },
        shell: {
            openPath: async () => '',
            showItemInFolder: () => {}
        }
    };

    require.cache[require.resolve('electron')] = {
        id: 'electron',
        filename: 'electron',
        loaded: true,
        exports: fakeElectron
    };

    return { fakeElectron, handlers };
}

/**
 * Drops the SUT and its electron-touching transitive deps from the require
 * cache so the next require() re-evaluates them against a fresh fake-electron.
 */
function resetSutCache() {
    const toDrop = [
        '../app/features/recording.js',
        '../app/features/sonacovePaths.js',
        '../app/features/fileWriters.js',
        '../app/features/ipcHelpers.js',
        '../app/features/sanitizers.js'
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

/**
 * Builds a minimal IpcMainInvokeEvent.sender stub. The destroyed-listener
 * wiring in recording.js needs once() / removeListener() / isDestroyed();
 * 'destroyed' never fires in these tests so no-ops are fine.
 */
function makeSender(id) {
    return {
        id,
        once() {},
        removeListener() {},
        isDestroyed() { return false; }
    };
}

async function mkTempDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('recording.js — MAX_SESSIONS_PER_WC caps concurrent start-write calls at 4', async () => {
    const userDataDir = await mkTempDir('sonacove-rec-ud-');
    const documentsDir = await mkTempDir('sonacove-rec-docs-');
    const picturesDir = await mkTempDir('sonacove-rec-pics-');

    resetSutCache();
    const { handlers } = installFakeElectron(userDataDir, documentsDir, picturesDir);

    try {
        const { setupRecordingIPC } = require('../app/features/recording.js');

        setupRecordingIPC({ handle: (ch, fn) => handlers.set(ch, fn) });

        const startWrite = handlers.get('recording:start-write');
        const cancelWrite = handlers.get('recording:cancel-write');

        assert.ok(startWrite, 'start-write handler registered');
        assert.ok(cancelWrite, 'cancel-write handler registered');

        const sender = makeSender(1);
        const event = { sender };

        // Drive five start-write invocations from the same webContents in
        // parallel. The handler reserves a slot in `pendingCountByWc`
        // synchronously before any await, so the cap holds even when every
        // caller starts before any of them have populated the `sessions`
        // map. This is the realistic case: a renderer firing concurrent
        // start-write IPCs sees its requests interleaved by the event loop.
        const results = await Promise.all(
            Array.from({ length: 5 }, (_, i) =>
                startWrite(event, { filename: `meeting-${i}.webm` })
            )
        );

        const successes = results.filter(r => r.sessionId);
        const errors = results.filter(r => r.error);

        assert.equal(successes.length, 4, 'exactly 4 sessions succeed');
        assert.equal(errors.length, 1, 'exactly 1 invocation is rejected');
        assert.equal(
            errors[0].error,
            'Too many active recording sessions',
            'rejection carries the cap-exceeded error message'
        );

        // Tidy up: cancel each of the 4 successful sessions so they don't
        // leak open file handles into the next test.
        for (const s of successes) {
            await cancelWrite(event, { sessionId: s.sessionId });
        }
    } finally {
        await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.rm(documentsDir, { recursive: true, force: true });
        await fs.rm(picturesDir, { recursive: true, force: true });
    }
});

test('recording.js — write-chunk after cancel-write returns Unknown session and leaves no file behind', async () => {
    const userDataDir = await mkTempDir('sonacove-rec-ud-');
    const documentsDir = await mkTempDir('sonacove-rec-docs-');
    const picturesDir = await mkTempDir('sonacove-rec-pics-');

    resetSutCache();
    const { handlers } = installFakeElectron(userDataDir, documentsDir, picturesDir);

    try {
        const { setupRecordingIPC } = require('../app/features/recording.js');

        setupRecordingIPC({ handle: (ch, fn) => handlers.set(ch, fn) });

        const startWrite = handlers.get('recording:start-write');
        const cancelWrite = handlers.get('recording:cancel-write');
        const writeChunk = handlers.get('recording:write-chunk');

        const sender = makeSender(2);
        const event = { sender };

        const startRes = await startWrite(event, { filename: 'meeting.webm' });

        assert.ok(startRes.sessionId, 'start-write returns a sessionId');
        const sessionId = startRes.sessionId;

        // Cancel BEFORE writing any chunk. cancel unlinks the (zero-byte) file.
        const cancelRes = await cancelWrite(event, { sessionId });

        assert.deepEqual(cancelRes, { ok: true });

        // write-chunk against the now-removed session must report unknown.
        const chunkRes = await writeChunk(event, {
            sessionId,
            chunk: new Uint8Array([1, 2, 3, 4])
        });

        assert.deepEqual(chunkRes, { error: 'Unknown session' });

        // Crucially: no file left in the recordings dir. The recordings dir
        // lives under documentsDir/Sonacove/Recordings; if no file was created
        // either the dir is empty or doesn't exist (both acceptable).
        const recordingsDir = path.join(documentsDir, 'Sonacove', 'Recordings');
        let entries;

        try {
            entries = await fs.readdir(recordingsDir);
        } catch (err) {
            if (err.code === 'ENOENT') {
                entries = [];
            } else {
                throw err;
            }
        }
        assert.deepEqual(entries, [], 'no file is left behind after cancel');
    } finally {
        await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.rm(documentsDir, { recursive: true, force: true });
        await fs.rm(picturesDir, { recursive: true, force: true });
    }
});

test('recording.js — finish-write for an unknown sessionId returns Unknown session with no disk side effects', async () => {
    const userDataDir = await mkTempDir('sonacove-rec-ud-');
    const documentsDir = await mkTempDir('sonacove-rec-docs-');
    const picturesDir = await mkTempDir('sonacove-rec-pics-');

    resetSutCache();
    const { handlers } = installFakeElectron(userDataDir, documentsDir, picturesDir);

    try {
        const { setupRecordingIPC } = require('../app/features/recording.js');

        setupRecordingIPC({ handle: (ch, fn) => handlers.set(ch, fn) });

        const finishWrite = handlers.get('recording:finish-write');

        const sender = makeSender(3);
        const event = { sender };

        // A random UUID that was never returned by start-write.
        const bogus = require('node:crypto').randomUUID();

        const res = await finishWrite(event, { sessionId: bogus });

        assert.deepEqual(res, { error: 'Unknown session' });

        // No recordings dir should have been created — finish-write must not
        // touch disk when the session doesn't exist.
        const recordingsDir = path.join(documentsDir, 'Sonacove', 'Recordings');
        let exists = true;

        try {
            await fs.stat(recordingsDir);
        } catch (err) {
            if (err.code === 'ENOENT') exists = false;
            else throw err;
        }
        // It's fine if the dir doesn't exist; if it does, it must be empty.
        if (exists) {
            const entries = await fs.readdir(recordingsDir);

            assert.deepEqual(entries, [], 'recordings dir has no files');
        }
    } finally {
        await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.rm(documentsDir, { recursive: true, force: true });
        await fs.rm(picturesDir, { recursive: true, force: true });
    }
});
