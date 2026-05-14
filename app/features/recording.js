'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getRecordingsDir, sanitizeOutputFilename } = require('./sonacovePaths');

const MAX_SESSIONS_PER_WC = 4;

// 64 MiB is well above MediaRecorder's typical 5 s timeslice (~10–20 MiB) while
// still capping accidental OOM from a runaway sender.
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Active write sessions keyed by sessionId. detachCleanup removes the per-session
 * 'destroyed' listener once the session terminates — without it, listeners would
 * accumulate across many recordings within one webContents.
 *
 * @type {Map<string, {
 *   filePath: string,
 *   stream: fs.WriteStream,
 *   webContentsId: number,
 *   firstChunkSize: number,
 *   detachCleanup: () => void
 * }>}
 */
const sessions = new Map();

/**
 * Wraps an ArrayBuffer/Uint8Array/Buffer (post-structured-clone) into a Buffer
 * without copying. Returns null if the input isn't one of those types.
 */
function toBuffer(chunk) {
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (chunk instanceof ArrayBuffer) {
        return Buffer.from(chunk);
    }

    return null;
}

async function disposeSession(sessionId, unlink = false) {
    const session = sessions.get(sessionId);

    if (!session) {
        return;
    }

    sessions.delete(sessionId);
    session.detachCleanup();

    await new Promise(resolve => {
        if (session.stream.destroyed) {
            resolve();

            return;
        }
        session.stream.end(() => resolve());
    });

    if (unlink) {
        await fs.promises.unlink(session.filePath).catch(() => { /* may not exist */ });
    }
}

/**
 * Wraps an IPC handler with uniform error logging and a `{ error }` failure return.
 */
function handle(label, fn) {
    return async (event, params = {}) => {
        try {
            return await fn(event, params);
        } catch (err) {
            console.error(`❌ ${label} failed:`, err);

            return { error: err.message || label };
        }
    };
}

/**
 * Registers recording IPC handlers.
 *
 * Protocol (chunk-stream — memory-flat, each chunk hits disk immediately):
 *   recording:start-write({ filename })                          → { sessionId, filePath }
 *   recording:write-chunk({ sessionId, chunk })                  → { ok: true }
 *   recording:finish-write({ sessionId, firstChunkOverride? })   → { filePath }
 *   recording:cancel-write({ sessionId })                        → { ok: true }
 *
 * @param {Electron.IpcMain} ipcMain
 */
function setupRecordingIPC(ipcMain) {
    ipcMain.handle('recording:start-write', handle('recording:start-write', async (event, params) => {
        const safeName = sanitizeOutputFilename(params.filename, '.webm');

        if (!safeName) {
            return { error: 'Invalid filename' };
        }

        const wcId = event.sender.id;
        const activeForWc = Array.from(sessions.values()).filter(s => s.webContentsId === wcId).length;

        if (activeForWc >= MAX_SESSIONS_PER_WC) {
            return { error: 'Too many active recording sessions' };
        }

        const filePath = path.join(getRecordingsDir(), safeName);
        const stream = fs.createWriteStream(filePath);
        const sessionId = crypto.randomUUID();

        // If the renderer's webContents goes away mid-recording (window closed,
        // app quit, renderer crashed), close the stream but keep the partial file
        // on disk so the user can recover what was captured.
        const sender = event.sender;
        const cleanup = () => {
            disposeSession(sessionId, false).catch(() => { /* swallow */ });
        };

        sender.once('destroyed', cleanup);

        sessions.set(sessionId, {
            filePath,
            stream,
            webContentsId: wcId,
            firstChunkSize: 0,
            detachCleanup: () => {
                if (!sender.isDestroyed()) {
                    sender.removeListener('destroyed', cleanup);
                }
            }
        });

        return { sessionId, filePath };
    }));

    ipcMain.handle('recording:write-chunk', handle('recording:write-chunk', async (event, params) => {
        const { sessionId, chunk } = params;
        const session = sessions.get(sessionId);

        if (!session) {
            return { error: 'Unknown session' };
        }
        if (session.webContentsId !== event.sender.id) {
            return { error: 'Session does not belong to this window' };
        }

        const buf = toBuffer(chunk);

        if (!buf) {
            return { error: 'Invalid chunk' };
        }
        if (buf.length === 0) {
            return { ok: true };
        }
        if (buf.length > MAX_CHUNK_BYTES) {
            await disposeSession(sessionId, true);

            return { error: 'Chunk exceeds maximum size' };
        }

        if (session.firstChunkSize === 0) {
            session.firstChunkSize = buf.length;
        }

        if (!session.stream.write(buf)) {
            await new Promise((resolve, reject) => {
                session.stream.once('drain', resolve);
                session.stream.once('error', reject);
            });
        }

        return { ok: true };
    }));

    ipcMain.handle('recording:finish-write', handle('recording:finish-write', async (event, params) => {
        const { sessionId, firstChunkOverride } = params;
        const session = sessions.get(sessionId);

        if (!session) {
            return { error: 'Unknown session' };
        }
        if (session.webContentsId !== event.sender.id) {
            return { error: 'Session does not belong to this window' };
        }

        try {
            await new Promise((resolve, reject) => {
                session.stream.end(err => err ? reject(err) : resolve());
            });

            // Re-write the first chunk with WebM duration fixed. Must be the same
            // byte length as the original first chunk to avoid corrupting the file.
            if (firstChunkOverride) {
                const override = toBuffer(firstChunkOverride);

                if (override && override.length !== session.firstChunkSize) {
                    console.warn(
                        `⚠️ recording:finish-write — firstChunkOverride length ${override.length} `
                        + `!= original ${session.firstChunkSize}; skipping overwrite to avoid corruption.`
                    );
                } else if (override) {
                    const fh = await fs.promises.open(session.filePath, 'r+');

                    try {
                        await fh.write(override, 0, override.length, 0);
                    } finally {
                        await fh.close();
                    }
                }
            }

            const filePath = session.filePath;

            sessions.delete(sessionId);
            session.detachCleanup();

            return { filePath };
        } catch (err) {
            await disposeSession(sessionId, true);
            throw err;
        }
    }));

    ipcMain.handle('recording:cancel-write', handle('recording:cancel-write', async (event, params) => {
        const { sessionId } = params;
        const session = sessions.get(sessionId);

        if (!session) {
            return { ok: true };
        }
        if (session.webContentsId !== event.sender.id) {
            return { error: 'Session does not belong to this window' };
        }

        await disposeSession(sessionId, true);

        return { ok: true };
    }));
}

module.exports = { setupRecordingIPC };
