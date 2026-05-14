'use strict';

const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getRecordingsDir } = require('./sonacovePaths');

/**
 * Maximum concurrent recording sessions per webContents.
 * Prevents a misbehaving renderer from exhausting file handles.
 */
const MAX_SESSIONS_PER_WC = 4;

/**
 * Maximum size (bytes) of a single chunk accepted from the renderer.
 * 64 MiB is well above MediaRecorder's typical 5 s timeslice (~10–20 MiB)
 * while still preventing accidental OOM from a runaway sender.
 */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Active write sessions, keyed by sessionId.
 * Each entry: { filePath, stream, webContentsId, firstChunkSize, detachCleanup }.
 * detachCleanup removes the per-session 'destroyed' listener from the renderer's webContents
 * once the session is finalized — without it, listeners would accumulate across many recordings.
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
 * Sanitizes a filename for safe writing to disk.
 * Strips directory components, restricts to a safe charset, enforces .webm extension,
 * and caps total length at 255 bytes (most filesystems' limit).
 *
 * @param {string} filename - User-suggested filename.
 * @returns {string|null} Safe filename, or null if not recoverable.
 */
function sanitizeFilename(filename) {
    if (typeof filename !== 'string' || !filename) {
        return null;
    }

    let safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');

    if (!safe.toLowerCase().endsWith('.webm')) {
        safe = `${safe}.webm`;
    }

    if (safe === '.webm' || safe.length === 0) {
        return null;
    }

    if (safe.length > 255) {
        safe = `${safe.slice(0, 250)}.webm`;
    }

    return safe;
}

/**
 * Closes and removes a session, optionally unlinking the partial file.
 *
 * @param {string} sessionId - The session to clean up.
 * @param {boolean} [unlink=false] - If true, delete the partial file from disk.
 * @returns {Promise<void>}
 */
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
        try {
            await fs.promises.unlink(session.filePath);
        } catch (_) { /* ignore — file may not exist yet */ }
    }
}

/**
 * Registers recording-related IPC handlers.
 *
 * Protocol (chunk-stream):
 *   recording:start-write({ filename })           → { sessionId, filePath }
 *   recording:write-chunk({ sessionId, chunk })   → { ok: true }
 *   recording:finish-write({ sessionId, firstChunkOverride? }) → { filePath }
 *   recording:cancel-write({ sessionId })         → { ok: true }
 *
 * Memory is flat: each chunk hits the disk write-stream directly,
 * so long meetings don't accumulate in renderer or main RAM.
 *
 * @param {Electron.IpcMain} ipcMain - The Electron IPC Main instance.
 * @returns {void}
 */
function setupRecordingIPC(ipcMain) {
    ipcMain.handle('recording:start-write', async (event, params = {}) => {
        try {
            const safeName = sanitizeFilename(params.filename);

            if (!safeName) {
                return { error: 'Invalid filename' };
            }

            const wcId = event.sender.id;
            const activeForWc = Array.from(sessions.values())
                .filter(s => s.webContentsId === wcId).length;

            if (activeForWc >= MAX_SESSIONS_PER_WC) {
                return { error: 'Too many active recording sessions' };
            }

            const dir = getRecordingsDir();
            const filePath = path.join(dir, safeName);
            const stream = fs.createWriteStream(filePath);

            const sessionId = crypto.randomUUID();

            // If the renderer's webContents goes away mid-recording (window closed,
            // app quit, renderer crashed), close the stream but keep the partial file
            // on disk so the user can recover what was captured.
            const cleanup = () => {
                disposeSession(sessionId, false).catch(() => { /* swallow */ });
            };
            const sender = event.sender;

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
        } catch (err) {
            console.error('❌ recording:start-write failed:', err);

            return { error: err.message || 'Failed to start recording' };
        }
    });

    ipcMain.handle('recording:write-chunk', async (event, params = {}) => {
        const { sessionId, chunk } = params;
        const session = sessions.get(sessionId);

        if (!session) {
            return { error: 'Unknown session' };
        }
        if (session.webContentsId !== event.sender.id) {
            return { error: 'Session does not belong to this window' };
        }
        if (!chunk || !(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer)) {
            return { error: 'Invalid chunk' };
        }

        const buf = chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

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

        // Honor backpressure: wait for 'drain' if write() returns false.
        const ok = session.stream.write(buf);

        if (!ok) {
            await new Promise((resolve, reject) => {
                session.stream.once('drain', resolve);
                session.stream.once('error', reject);
            });
        }

        return { ok: true };
    });

    ipcMain.handle('recording:finish-write', async (event, params = {}) => {
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

            // Optional: re-write the first chunk with WebM duration fixed.
            // Must be the same byte length as the original first chunk to avoid corruption.
            if (firstChunkOverride) {
                const override = firstChunkOverride instanceof ArrayBuffer
                    ? Buffer.from(firstChunkOverride)
                    : Buffer.from(firstChunkOverride.buffer, firstChunkOverride.byteOffset, firstChunkOverride.byteLength);

                if (override.length !== session.firstChunkSize) {
                    console.warn(
                        `⚠️ recording:finish-write — firstChunkOverride length ${override.length} ` +
                        `!= original ${session.firstChunkSize}; skipping overwrite to avoid corruption.`
                    );
                } else {
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
            console.error('❌ recording:finish-write failed:', err);
            await disposeSession(sessionId, true);

            return { error: err.message || 'Failed to finalize recording' };
        }
    });

    ipcMain.handle('recording:cancel-write', async (event, params = {}) => {
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
    });
}

module.exports = { setupRecordingIPC };
