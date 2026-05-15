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

    assert.equal(result.length, MAX_FILENAME_BYTES);
    assert.ok(result.endsWith('.webm'));
});

test('sanitizeOutputFilename length cap accounts for extension', () => {
    const longName = 'a'.repeat(300);
    const result = sanitizeOutputFilename(longName, '.png');

    assert.equal(result.length, MAX_FILENAME_BYTES);
    assert.ok(result.endsWith('.png'));
    assert.equal(result, `${'a'.repeat(MAX_FILENAME_BYTES - 4)}.png`);
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
