'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Hard cap on suffix attempts when resolving a collision-free filename.
 * 100 distinct recordings with the same base name in one second is well
 * beyond any realistic case, and the cap prevents an infinite loop if
 * something on disk consistently rejects every variant.
 */
const MAX_FILENAME_COLLISIONS = 100;

/**
 * Shared collision-resolution loop for atomically opening a file with the
 * 'wx' flag at `dir/baseName${ext}`, falling back to `dir/baseName_1${ext}`,
 * `_2${ext}`, … on collision. The actual opening is delegated to `opener`,
 * which returns a handle-like object plus a promise that resolves once the
 * underlying resource is observably open or rejects with an `EEXIST` (so we
 * can retry) or another error (which we surface).
 *
 * Internal — exported only via the two specialized wrappers below.
 *
 * @template T
 * @param {string} dir
 * @param {string} baseName
 * @param {string} ext
 * @param {(filePath: string) => Promise<T>} opener
 *   Must atomically open the file with O_CREAT|O_EXCL semantics. On collision
 *   the returned promise MUST reject with a Node-style error whose `.code`
 *   is `'EEXIST'`. Any other rejection is propagated unchanged.
 * @returns {Promise<{ handle: T, filePath: string }>}
 */
async function openFileExclusive(dir, baseName, ext, opener) {
    for (let i = 0; i < MAX_FILENAME_COLLISIONS; i++) {
        const name = i === 0 ? `${baseName}${ext}` : `${baseName}_${i}${ext}`;
        const filePath = path.join(dir, name);

        try {
            const handle = await opener(filePath);

            return { handle, filePath };
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
            // collision — try next suffix
        }
    }

    throw new Error(
        `Could not find a free filename for ${baseName}${ext} after ${MAX_FILENAME_COLLISIONS} attempts`
    );
}

/**
 * Opens an exclusive write stream at `dir/baseName${ext}`, falling back to
 * `dir/baseName_1${ext}`, `_2${ext}`, … on collision. Uses the 'wx' open
 * flag so each attempt is atomic — no TOCTOU race with concurrent writers
 * that might be racing to create the same name.
 *
 * @param {string} dir - Absolute directory path (must already exist).
 * @param {string} baseName - Filename without extension.
 * @param {string} ext - Extension including the leading dot, e.g. '.webm'.
 * @returns {Promise<{ stream: fs.WriteStream, filePath: string }>}
 *   The opened write stream and the final path (with any added suffix).
 * @throws If no collision-free name is found within MAX_FILENAME_COLLISIONS
 *   attempts, or if a non-EEXIST fs error occurs.
 */
async function openExclusiveWriteStream(dir, baseName, ext) {
    const { handle, filePath } = await openFileExclusive(dir, baseName, ext, filePath => {
        const stream = fs.createWriteStream(filePath, { flags: 'wx' });

        return new Promise((resolve, reject) => {
            // We must remove both listeners on either outcome — otherwise the
            // unused one stays attached and a later 'error' on a successfully
            // opened stream would reject this promise after we've already
            // returned the stream to the caller (unhandled rejection).
            const onOpen = () => {
                stream.removeListener('error', onError);
                resolve(stream);
            };
            const onError = err => {
                stream.removeListener('open', onOpen);
                // For EEXIST, the WriteStream auto-destroys; for other errors
                // we also want to free the descriptor so it can't leak.
                if (!stream.destroyed) {
                    stream.destroy();
                }
                reject(err);
            };

            stream.once('open', onOpen);
            stream.once('error', onError);
        });
    });

    return { stream: handle, filePath };
}

/**
 * Opens an exclusive `fs.promises.FileHandle` at `dir/baseName${ext}`, with
 * the same suffix-fallback collision behaviour as
 * {@link openExclusiveWriteStream}. Use when you need to write a complete
 * buffer (no streaming) — e.g. PNG screenshots.
 *
 * Caller is responsible for closing the handle.
 *
 * @param {string} dir - Absolute directory path (must already exist).
 * @param {string} baseName - Filename without extension.
 * @param {string} ext - Extension including the leading dot, e.g. '.png'.
 * @returns {Promise<{ handle: import('fs').promises.FileHandle, filePath: string }>}
 */
async function openExclusiveFileHandle(dir, baseName, ext) {
    return openFileExclusive(dir, baseName, ext, filePath => fs.promises.open(filePath, 'wx'));
}

module.exports = {
    openExclusiveWriteStream,
    openExclusiveFileHandle,
    MAX_FILENAME_COLLISIONS
};
