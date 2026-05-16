'use strict';

const fs = require('fs');
const crypto = require('crypto');

const { openExclusiveWriteStream } = require('./fileWriters');
const { handle } = require('./ipcHelpers');
const { sanitizeOutputFilename } = require('./sanitizers');
const { getRecordingsDir } = require('./sonacovePaths');

const WEBM_EXT = '.webm';

// 4 is a generous safety margin — a single meeting has 1 active recording
// session in normal use. Higher caps risk file-descriptor exhaustion if a
// misbehaving renderer hammers start-write; lower caps would surprise
// users who happened to start a second simultaneous recording (e.g. via
// the audio-only path).
const MAX_SESSIONS_PER_WC = 4;

// 64 MiB is well above MediaRecorder's typical 5 s timeslice (~10–20 MiB) while
// still capping accidental OOM from a runaway sender.
// Contract: oversized chunks are rejected, session preserved — the caller may
// invoke `recording:cancel-write` to discard if it wants to abandon. We
// deliberately do not unlink here because doing so would destroy all prior
// recorded content for a single anomalous chunk.
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Active write sessions keyed by sessionId. detachCleanup removes the per-session
 * 'destroyed' listener once the session terminates — without it, listeners would
 * accumulate across many recordings within one webContents.
 *
 * Best-effort save guarantee: on a normal renderer-window close, the 'destroyed'
 * handler runs and the stream is ended cleanly. On a hard kill (SIGKILL, power
 * loss, OS crash), the process exits before any handler runs — the OS will close
 * file descriptors so all written bytes hit disk, but stream.end() is never
 * called, so the resulting WebM may lack a final EOF/cluster marker. The file
 * stays on disk and is usually still playable, just not seekable past the last
 * fully-flushed cluster. Considered acceptable; documented here so future
 * maintainers don't get surprised.
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
 * In-flight `start-write` calls keyed by webContentsId. The cap check has to
 * count pending starts in addition to live sessions — otherwise N truly-parallel
 * `start-write` invocations all observe `sessions` as empty during their
 * synchronous prelude and every one of them slips past `MAX_SESSIONS_PER_WC`
 * before the first one finishes its awaits and writes to `sessions`.
 *
 * Key assumption: webContents IDs are unique per webContents lifetime. We
 * don't try to handle ID reuse — Electron monotonically increments and
 * doesn't reissue.
 *
 * @type {Map<number, number>}
 */
const pendingCountByWc = new Map();

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

/**
 * Awaits a writable stream's 'finish' event after calling .end(), racing
 * against 'error'. `stream.end(cb)` attaches `cb` to 'finish' only — if the
 * stream emits 'error' instead (e.g. disk full at flush), the cb never runs
 * and the promise would hang. We also have to listen for 'error' explicitly
 * because an unhandled 'error' on a Writable crashes the process.
 *
 * Safe to call on an already-finished stream — `writableFinished` short-circuits
 * to resolve immediately. We deliberately check `writableFinished` (set after
 * the 'finish' event fires, i.e. after the OS has flushed) rather than
 * `writableEnded` (flips the instant .end() is called, before bytes hit disk).
 * A concurrent caller racing this function would otherwise see "done" while
 * the flush is still in flight.
 */
function endStream(stream) {
    return new Promise((resolve, reject) => {
        if (stream.destroyed || stream.writableFinished) {
            resolve();

            return;
        }
        const onFinish = () => {
            stream.removeListener('error', onError);
            resolve();
        };
        const onError = err => {
            stream.removeListener('finish', onFinish);
            // Force the stream into a terminal state so a second endStream call
            // (e.g. from disposeSession after we reject) hits the short-circuit
            // at the top of endStream instead of registering new listeners on a
            // half-dead stream.
            if (!stream.destroyed) {
                stream.destroy();
            }
            reject(err);
        };

        stream.once('finish', onFinish);
        stream.once('error', onError);
        stream.end();
    });
}

async function disposeSession(sessionId, unlink = false) {
    const session = sessions.get(sessionId);

    if (!session) {
        return;
    }

    sessions.delete(sessionId);
    session.detachCleanup();

    // If endStream rejects (e.g. flush I/O fault on a stream the caller
    // explicitly asked us to discard), we still need to honour `unlink`
    // — otherwise the partial file lingers despite the caller asking
    // for it to go away (cancel path / oversized chunk on drain). The
    // endStream error is rethrown so the outer caller (e.g.
    // finish-write) can surface it.
    try {
        await endStream(session.stream);
    } finally {
        if (unlink) {
            await fs.promises.unlink(session.filePath).catch(() => { /* may not exist */ });
        }
    }
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
        const safeName = sanitizeOutputFilename(params.filename, WEBM_EXT);

        if (!safeName) {
            return { error: 'Invalid filename' };
        }

        const wcId = event.sender.id;
        const pending = pendingCountByWc.get(wcId) ?? 0;
        const activeForWc = Array.from(sessions.values()).filter(s => s.webContentsId === wcId).length;

        if (pending + activeForWc >= MAX_SESSIONS_PER_WC) {
            return { error: 'Too many active recording sessions' };
        }

        // Reserve a slot synchronously, BEFORE awaiting. Parallel callers that
        // arrive between this point and `sessions.set` below will see the
        // increment in `pending` and bounce off the cap correctly.
        pendingCountByWc.set(wcId, pending + 1);

        try {
            // If a file with this name already exists, openExclusiveWriteStream
            // adds an `_1`, `_2`, … suffix until it finds a free slot — avoids
            // silently clobbering a previous recording with the same timestamp.
            const baseName = safeName.slice(0, -WEBM_EXT.length);
            const dir = await getRecordingsDir();
            const { stream, filePath } = await openExclusiveWriteStream(dir, baseName, WEBM_EXT);
            const sessionId = crypto.randomUUID();

            // If the renderer's webContents goes away mid-recording (window closed,
            // app quit, renderer crashed), close the stream but keep the partial file
            // on disk so the user can recover what was captured.
            const sender = event.sender;
            const cleanup = () => {
                disposeSession(sessionId, false).catch(() => { /* swallow */ });
            };

            // If the sender was destroyed during the awaits above, 'destroyed'
            // has already fired — registering now would never run. Close the
            // stream and unlink the 0-byte placeholder file; no bytes were
            // ever written so the "keep partial file" policy doesn't apply.
            // The renderer's invoke promise has already been rejected by
            // Electron at this point, so the error return is mostly for
            // completeness.
            if (sender.isDestroyed()) {
                await endStream(stream).catch(() => {});
                await fs.promises.unlink(filePath).catch(() => {});

                return { error: 'Renderer destroyed before session was established' };
            }

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
        } finally {
            // Release the reservation regardless of success/failure. On success
            // the live session is now in `sessions` and will be counted by
            // `activeForWc` on subsequent calls; on failure the slot frees up
            // for the next attempt.
            const p = pendingCountByWc.get(wcId) ?? 1;

            if (p <= 1) {
                pendingCountByWc.delete(wcId);
            } else {
                pendingCountByWc.set(wcId, p - 1);
            }
        }
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
            return { error: 'Chunk exceeds maximum size' };
        }

        if (session.stream.destroyed) {
            // Another async path (drain-wait onError/onClose, or a 'destroyed'
            // listener) already disposed this session. Make sure the session is
            // removed from the map so subsequent writes get a clean "Unknown
            // session" error instead of repeated ERR_STREAM_DESTROYED throws.
            disposeSession(sessionId, false).catch(() => { /* swallow */ });

            return { error: 'Recording stream was closed unexpectedly' };
        }

        const writeOk = session.stream.write(buf);

        // Record the first-chunk size synchronously, BEFORE any await. Once
        // stream.write() returns, the bytes are committed in the stream's
        // internal buffer in the order they arrived on the main process.
        // Recording after the drain-wait would let two concurrent
        // write-chunks both see `firstChunkSize === 0` going into their own
        // write/drain cycles — the chunk whose drain resolves second would
        // win, and that isn't necessarily the chunk written first.
        // (Renderer-side electronWriteChain already serializes these IPCs,
        // but recording before the drain-wait keeps us safe against future
        // callers that don't serialize.)
        //
        // A drain failure caught below fires onError → fire-and-forget
        // disposeSession, which removes the session entirely — so a "stale"
        // firstChunkSize for bytes that didn't durably land is unobservable.
        if (session.firstChunkSize === 0) {
            session.firstChunkSize = buf.length;
        }

        if (!writeOk) {
            // Race drain (normal) against error (I/O fault) and close (stream
            // destroyed by the OS before either fired). Without the close
            // listener, an unexpected destroy would hang the IPC forever.
            await new Promise((resolve, reject) => {
                const stream = session.stream;
                const removeListeners = () => {
                    stream.removeListener('drain', onDrain);
                    stream.removeListener('error', onError);
                    stream.removeListener('close', onClose);
                };
                const onDrain = () => { removeListeners(); resolve(); };
                const onError = err => {
                    removeListeners();
                    // Fire-and-forget: dispose frees resources so subsequent
                    // writes from a renderer that ignored the error get a
                    // clean "Unknown session" instead of repeated failures.
                    disposeSession(sessionId, true).catch(() => { /* swallow */ });
                    reject(err);
                };
                const onClose = () => {
                    removeListeners();
                    disposeSession(sessionId, true).catch(() => { /* swallow */ });
                    reject(new Error('Recording stream closed unexpectedly'));
                };

                stream.once('drain', onDrain);
                stream.once('error', onError);
                stream.once('close', onClose);
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

        // Step 1 — close the stream. If THIS fails, the file is corrupt
        // (incomplete flush), so unlink and surface the error.
        try {
            await endStream(session.stream);
        } catch (err) {
            await disposeSession(sessionId, true);
            throw err;
        }

        // Step 2 — drop the session from the map. The file is fully written;
        // we keep it no matter what happens in the best-effort step below.
        const filePath = session.filePath;

        sessions.delete(sessionId);
        session.detachCleanup();

        // Step 3 — best-effort duration-header re-write. A transient I/O error
        // here would otherwise destroy an already-good recording; log and
        // return success instead.
        if (firstChunkOverride) {
            try {
                // Re-write the first chunk with WebM duration fixed. Must be the same
                // byte length as the original first chunk to avoid corrupting the file.
                const override = toBuffer(firstChunkOverride);

                if (override && override.length !== session.firstChunkSize) {
                    console.warn(
                        `⚠️ recording:finish-write — firstChunkOverride length ${override.length} `
                        + `!= original ${session.firstChunkSize}; skipping overwrite to avoid corruption.`
                    );
                } else if (override) {
                    const fh = await fs.promises.open(filePath, 'r+');

                    try {
                        await fh.write(override, 0, override.length, 0);
                    } finally {
                        await fh.close();
                    }
                } else {
                    // toBuffer returned null — caller sent a truthy value that
                    // isn't ArrayBuffer/Uint8Array/Buffer. Without this branch
                    // we'd silently skip the duration fixup.
                    console.warn(
                        '⚠️ recording:finish-write — firstChunkOverride present but not a '
                        + 'recognized binary type; duration header not fixed.'
                    );
                }
            } catch (err) {
                console.warn(
                    '⚠️ recording:finish-write — duration overwrite failed, keeping file as-is:',
                    err.message
                );
            }
        }

        return { filePath };
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
