'use strict';

const path = require('path');

const MAX_FILENAME_BYTES = 255;

/**
 * Truncates a string so its UTF-8 byte length doesn't exceed `maxBytes`.
 * Iterates by code point, so we never cut in the middle of a multi-byte
 * character.
 *
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateUtf8(s, maxBytes) {
    let bytes = 0;
    let result = '';

    for (const ch of s) {
        const chBytes = Buffer.byteLength(ch, 'utf8');

        if (bytes + chBytes > maxBytes) break;
        result += ch;
        bytes += chBytes;
    }

    return result;
}

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
 * - Caps total UTF-8 byte length at {@link MAX_FILENAME_BYTES} (255).
 *   String.length is UTF-16 code units (1 per char), but most Linux/
 *   macOS filesystems impose a 255-*byte* per-component limit — a
 *   100-character CJK name (~300 bytes UTF-8) would otherwise blow
 *   past it. Truncation is code-point-aware so we don't cut a
 *   character in half.
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

    // All-dots names (`.`, `..`, `...`) would become hidden files (`.${ext}`,
    // `..${ext}`) — refuse them entirely, falling through to the null return.
    if (/^\.+$/.test(safe)) {
        return null;
    }

    // Defence in depth: never let a sanitized name begin with `-`. The
    // current codebase doesn't pass these names to a shell, but a leading
    // dash can be misinterpreted as a flag if it ever does — prepending
    // `_` is the standard fix.
    if (safe.startsWith('-')) {
        safe = `_${safe}`;
    }

    if (!safe.toLowerCase().endsWith(requiredExt.toLowerCase())) {
        safe = `${safe}${requiredExt}`;
    }
    if (safe === requiredExt || safe.length === 0) {
        return null;
    }
    if (Buffer.byteLength(safe, 'utf8') > MAX_FILENAME_BYTES) {
        const extBytes = Buffer.byteLength(requiredExt, 'utf8');

        safe = `${truncateUtf8(safe, MAX_FILENAME_BYTES - extBytes)}${requiredExt}`;
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

/**
 * Soft guardrail that constrains an absolute path candidate to live under one
 * of a small set of allowed root directories. Used by the `set-save-paths`
 * IPC so a renderer (or page-level XSS in the contextIsolation:false setup)
 * cannot point Sonacove's save location at sensitive system locations
 * (`~/.ssh`, `C:\Windows`, etc.) via this single IPC.
 *
 * What this does:
 * - Requires the input to be absolute.
 * - Normalizes via `path.normalize` and resolves to absolute form.
 * - Requires the normalized path to be inside at least one of `allowedRoots`
 *   by prefix (case-insensitive on Windows). The root itself is treated as
 *   "inside" (equal paths are accepted).
 * - Explicitly rejects any `..` segment that survives normalization (defence
 *   in depth — `path.normalize` already collapses `..` against earlier
 *   segments, but a leading `..` on a relative input can survive; the
 *   `path.isAbsolute` gate handles that case, but the explicit check keeps
 *   the helper robust against future input handling changes).
 *
 * Limitations (intentional):
 * - No symlink resolution. Symlink-based escapes are an integration-layer
 *   concern; the data flowing into settings is what this helper guards. The
 *   `show-in-folder` flow already realpath's both sides before comparing.
 * - Determined attackers with arbitrary renderer JS can still call other
 *   Electron APIs that bypass this — the goal is to remove this specific IPC
 *   as a confused-deputy primitive, not to provide blanket sandboxing.
 *
 * @param {string} value - Absolute path candidate (already trimmed, non-null).
 * @param {string[]} allowedRoots - Allowed parent directories.
 * @returns {{ ok: string } | { error: string }}
 */
function validateUserPath(value, allowedRoots) {
    if (typeof value !== 'string' || !value) {
        return { error: 'Path must be a non-empty string' };
    }
    if (!path.isAbsolute(value)) {
        return { error: 'Path must be absolute' };
    }

    // path.resolve normalizes separators and collapses `.`/`..` segments
    // against earlier components. Passing a single absolute argument is
    // effectively a normalize that also tolerates mixed separators.
    const normalized = path.resolve(value);

    // Defence in depth — if any segment is exactly '..' after normalization
    // (which shouldn't happen for a normalized absolute path, but covers
    // platform quirks like UNC roots), refuse.
    if (normalized.split(/[\\/]/).some(seg => seg === '..')) {
        return { error: 'Path must not contain traversal segments' };
    }

    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
        return { error: 'Path is outside allowed roots' };
    }

    const isWindows = process.platform === 'win32';
    const norm = s => (isWindows ? s.toLowerCase() : s);
    const target = norm(normalized);

    for (const root of allowedRoots) {
        if (typeof root !== 'string' || !root) continue;
        const normalizedRoot = path.resolve(root);
        const rootNorm = norm(normalizedRoot);

        if (target === rootNorm || target.startsWith(rootNorm + path.sep)) {
            return { ok: normalized };
        }
    }

    return { error: 'Path is outside allowed roots' };
}

module.exports = {
    sanitizeOutputFilename,
    sanitizeOverride,
    validateUserPath,
    MAX_FILENAME_BYTES
};
