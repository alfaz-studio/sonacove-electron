'use strict';

const path = require('path');

const MAX_FILENAME_BYTES = 255;

/**
 * Sanitizes a user-supplied filename for safe writing to disk.
 *
 * - Strips directory components via `path.basename`.
 * - Restricts to Unicode letters/digits plus `._-`. Non-Latin scripts
 *   (CJK, Cyrillic, Arabic, accented Latin) are preserved; spaces,
 *   slashes, shell-special and FS-reserved characters are replaced
 *   with `_`.
 * - Enforces the given extension (case-insensitive match, appends if
 *   missing).
 * - Caps total length at {@link MAX_FILENAME_BYTES} (255).
 *
 * @param {string} filename - User-suggested filename.
 * @param {string} requiredExt - Required extension including the dot, e.g. '.webm'.
 * @returns {string|null} Safe filename, or null if not recoverable.
 */
function sanitizeOutputFilename(filename, requiredExt) {
    if (typeof filename !== 'string' || !filename) {
        return null;
    }

    let safe = path.basename(filename).replace(/[^\p{L}\p{N}._-]/gu, '_');

    if (!safe.toLowerCase().endsWith(requiredExt.toLowerCase())) {
        safe = `${safe}${requiredExt}`;
    }
    if (safe === requiredExt || safe.length === 0) {
        return null;
    }
    if (safe.length > MAX_FILENAME_BYTES) {
        safe = `${safe.slice(0, MAX_FILENAME_BYTES - requiredExt.length)}${requiredExt}`;
    }

    return safe;
}

/**
 * Sanitizes a user-supplied folder override.
 *
 * - `null` or an empty/whitespace string → `null` (clears the override).
 * - Any other string → trimmed.
 * - Anything else (non-string) → `undefined`, signaling invalid input.
 *
 * @param {unknown} value
 * @returns {string|null|undefined}
 */
function sanitizeOverride(value) {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;

    const trimmed = value.trim();

    return trimmed === '' ? null : trimmed;
}

module.exports = { sanitizeOutputFilename, sanitizeOverride, MAX_FILENAME_BYTES };
