'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { openExclusiveWriteStream, MAX_FILENAME_COLLISIONS }
    = require('../app/features/fileWriters');

/**
 * Creates a fresh tmp dir, runs the body, then removes the dir.
 */
async function withTempDir(body) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonacove-test-'));

    try {
        await body(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function closeStream(stream) {
    return new Promise(resolve => stream.end(resolve));
}

test('openExclusiveWriteStream uses the base filename when there is no collision', async () => {
    await withTempDir(async dir => {
        const { stream, filePath } = await openExclusiveWriteStream(dir, 'recording', '.webm');

        try {
            assert.equal(path.basename(filePath), 'recording.webm');
            assert.equal(stream.path, filePath);
        } finally {
            await closeStream(stream);
        }
    });
});

test('openExclusiveWriteStream appends _1 when the base filename is taken', async () => {
    await withTempDir(async dir => {
        await fs.writeFile(path.join(dir, 'recording.webm'), 'existing');

        const { stream, filePath } = await openExclusiveWriteStream(dir, 'recording', '.webm');

        try {
            assert.equal(path.basename(filePath), 'recording_1.webm');
        } finally {
            await closeStream(stream);
        }
    });
});

test('openExclusiveWriteStream finds the next free suffix in sequence', async () => {
    await withTempDir(async dir => {
        await fs.writeFile(path.join(dir, 'recording.webm'), 'a');
        await fs.writeFile(path.join(dir, 'recording_1.webm'), 'b');
        await fs.writeFile(path.join(dir, 'recording_2.webm'), 'c');

        const { stream, filePath } = await openExclusiveWriteStream(dir, 'recording', '.webm');

        try {
            assert.equal(path.basename(filePath), 'recording_3.webm');
        } finally {
            await closeStream(stream);
        }
    });
});

test('openExclusiveWriteStream creates the file atomically (writable)', async () => {
    await withTempDir(async dir => {
        const { stream, filePath } = await openExclusiveWriteStream(dir, 'recording', '.webm');

        await new Promise((resolve, reject) => {
            stream.write('hello', err => err ? reject(err) : resolve());
        });
        await closeStream(stream);

        const contents = await fs.readFile(filePath, 'utf8');

        assert.equal(contents, 'hello');
    });
});

test('openExclusiveWriteStream throws after MAX_FILENAME_COLLISIONS exhausted', async () => {
    await withTempDir(async dir => {
        for (let i = 0; i < MAX_FILENAME_COLLISIONS; i++) {
            const name = i === 0 ? 'recording.webm' : `recording_${i}.webm`;

            await fs.writeFile(path.join(dir, name), '');
        }

        await assert.rejects(
            () => openExclusiveWriteStream(dir, 'recording', '.webm'),
            /Could not find a free filename/
        );
    });
});

test('openExclusiveWriteStream propagates non-EEXIST errors', async () => {
    await assert.rejects(
        () => openExclusiveWriteStream(path.join(os.tmpdir(), 'this-dir-definitely-does-not-exist-xyz'), 'recording', '.webm'),
        err => err.code === 'ENOENT'
    );
});
