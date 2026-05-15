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
    for (let i = 0; i < MAX_FILENAME_COLLISIONS; i++) {
        const name = i === 0 ? `${baseName}${ext}` : `${baseName}_${i}${ext}`;
        const filePath = path.join(dir, name);
        const stream = fs.createWriteStream(filePath, { flags: 'wx' });

        try {
            await new Promise((resolve, reject) => {
                stream.once('open', resolve);
                stream.once('error', reject);
            });

            return { stream, filePath };
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
            // collision — try next suffix
        }
    }

    throw new Error(`Could not find a free filename for ${baseName}${ext} after ${MAX_FILENAME_COLLISIONS} attempts`);
}

module.exports = { openExclusiveWriteStream, MAX_FILENAME_COLLISIONS };
