'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeOutputFilename, sanitizeOverride, MAX_FILENAME_BYTES }
    = require('../app/features/sanitizers');

test('sanitizeOutputFilename rejects non-string and empty input', () => {
    assert.equal(sanitizeOutputFilename(undefined, '.webm'), null);
    assert.equal(sanitizeOutputFilename(null, '.webm'), null);
    assert.equal(sanitizeOutputFilename('', '.webm'), null);
    assert.equal(sanitizeOutputFilename(42, '.webm'), null);
});

test('sanitizeOutputFilename strips directory components', () => {
    assert.equal(
        sanitizeOutputFilename('/etc/passwd.webm', '.webm'),
        'passwd.webm'
    );
    assert.equal(
        sanitizeOutputFilename('C:\\Users\\someone\\meeting.webm', '.webm'),
        'meeting.webm'
    );
    // `..` is treated as a path component by basename, so traversal attempts
    // are flattened to just the filename.
    assert.equal(
        sanitizeOutputFilename('../escape.webm', '.webm'),
        'escape.webm'
    );
});

test('sanitizeOutputFilename appends extension when missing', () => {
    assert.equal(sanitizeOutputFilename('meeting', '.webm'), 'meeting.webm');
    assert.equal(sanitizeOutputFilename('shot', '.png'), 'shot.png');
});

test('sanitizeOutputFilename accepts case-insensitive extension match', () => {
    assert.equal(sanitizeOutputFilename('Meeting.WebM', '.webm'), 'Meeting.WebM');
    assert.equal(sanitizeOutputFilename('shot.PNG', '.png'), 'shot.PNG');
});

test('sanitizeOutputFilename rejects extension-only input', () => {
    assert.equal(sanitizeOutputFilename('.webm', '.webm'), null);
});

test('sanitizeOutputFilename replaces shell-special chars with underscore', () => {
    assert.equal(sanitizeOutputFilename('a b c.webm', '.webm'), 'a_b_c.webm');
    assert.equal(sanitizeOutputFilename('a;rm -rf.webm', '.webm'), 'a_rm_-rf.webm');
    assert.equal(sanitizeOutputFilename('a*?<>|.webm', '.webm'), 'a_____.webm');
});

test('sanitizeOutputFilename preserves Unicode letters and digits', () => {
    assert.equal(sanitizeOutputFilename('会議.webm', '.webm'), '会議.webm');
    assert.equal(sanitizeOutputFilename('café_2026.webm', '.webm'), 'café_2026.webm');
    assert.equal(sanitizeOutputFilename('한국어.webm', '.webm'), '한국어.webm');
    assert.equal(sanitizeOutputFilename('тест.webm', '.webm'), 'тест.webm');
});

test('sanitizeOutputFilename caps length at 255 bytes', () => {
    const longName = 'a'.repeat(300);
    const result = sanitizeOutputFilename(longName, '.webm');

    assert.equal(Buffer.byteLength(result, 'utf8'), MAX_FILENAME_BYTES);
    assert.ok(result.endsWith('.webm'));
});

test('sanitizeOutputFilename length cap accounts for extension', () => {
    const longName = 'a'.repeat(300);
    const result = sanitizeOutputFilename(longName, '.png');

    assert.equal(Buffer.byteLength(result, 'utf8'), MAX_FILENAME_BYTES);
    assert.ok(result.endsWith('.png'));
    assert.equal(result, `${'a'.repeat(MAX_FILENAME_BYTES - 4)}.png`);
});

test('sanitizeOutputFilename caps by UTF-8 bytes, not characters, for Unicode names', () => {
    // CJK ideographs are 3 bytes each in UTF-8. 100 of them = 300 bytes
    // (only 100 UTF-16 code units), well over the 255-byte filesystem limit.
    const cjkName = '会議'.repeat(100); // 200 chars, 600 bytes
    const result = sanitizeOutputFilename(cjkName, '.webm');

    assert.ok(Buffer.byteLength(result, 'utf8') <= MAX_FILENAME_BYTES);
    assert.ok(result.endsWith('.webm'));
});

test('sanitizeOutputFilename truncation never cuts in the middle of a code point', () => {
    // Worst case: byte budget that wouldn't evenly accommodate the last
    // multi-byte char. Cap is 255 bytes. 84 CJK chars = 252 bytes; with a
    // 5-byte ext we'd have 250 bytes for the body — 83 chars = 249 bytes
    // fits, 84 = 252 doesn't, so we expect 83 chars before the extension.
    const cjkName = '日'.repeat(100); // 300 bytes
    const result = sanitizeOutputFilename(cjkName, '.webm');

    // No replacement characters (U+FFFD) or stray surrogate pairs.
    assert.ok(!result.includes('\uFFFD'));
    // Round-trip through UTF-8 must give the same string back.
    assert.equal(Buffer.from(result, 'utf8').toString('utf8'), result);
});

test('sanitizeOutputFilename prepends underscore when result starts with -', () => {
    // Plain leading-dash filename — could be mistaken for a CLI flag.
    assert.equal(
        sanitizeOutputFilename('-rf something.webm', '.webm'),
        '_-rf_something.webm'
    );
    // Double-dash long-flag form, no extension supplied.
    assert.equal(
        sanitizeOutputFilename('--foo', '.webm'),
        '_--foo.webm'
    );
});

test('sanitizeOutputFilename leaves non-dash-prefixed names alone (regression)', () => {
    // The leading-dash guard must not affect ordinary ASCII filenames.
    assert.equal(sanitizeOutputFilename('meeting.webm', '.webm'), 'meeting.webm');
    assert.equal(sanitizeOutputFilename('abc-def.webm', '.webm'), 'abc-def.webm');
});

test('sanitizeOverride passes through valid strings', () => {
    assert.equal(sanitizeOverride('C:\\Users\\me\\Videos'), 'C:\\Users\\me\\Videos');
    assert.equal(sanitizeOverride('/home/user/videos'), '/home/user/videos');
});

test('sanitizeOverride trims whitespace', () => {
    assert.equal(sanitizeOverride('  /path/  '), '/path/');
});

test('sanitizeOverride treats null and empty as clear (null)', () => {
    assert.equal(sanitizeOverride(null), null);
    assert.equal(sanitizeOverride(''), null);
    assert.equal(sanitizeOverride('   '), null);
});

test('sanitizeOverride rejects non-string non-null (undefined)', () => {
    assert.equal(sanitizeOverride(undefined), undefined);
    assert.equal(sanitizeOverride(42), undefined);
    assert.equal(sanitizeOverride({}), undefined);
    assert.equal(sanitizeOverride([]), undefined);
});
