'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { validateUserPath } = require('../app/features/sanitizers');

const isWindows = process.platform === 'win32';

/**
 * Cross-platform allowed root for tests. On Windows we use C:\\Users\\Test;
 * on POSIX, /tmp/sonacove-test.
 */
const ALLOWED_ROOT = isWindows
    ? path.join('C:', path.sep, 'Users', 'Test')
    : '/tmp/sonacove-test';

const OUTSIDE_PATH = isWindows
    ? path.join('C:', path.sep, 'Windows', 'System32')
    : '/etc/passwd';

test('validateUserPath rejects non-absolute paths', () => {
    const out = validateUserPath('relative/path', [ ALLOWED_ROOT ]);

    assert.ok('error' in out, 'expected an error result');
    assert.match(out.error, /absolute/i);
});

test('validateUserPath rejects non-string and empty inputs', () => {
    assert.ok('error' in validateUserPath('', [ ALLOWED_ROOT ]));
    assert.ok('error' in validateUserPath(undefined, [ ALLOWED_ROOT ]));
    assert.ok('error' in validateUserPath(null, [ ALLOWED_ROOT ]));
    assert.ok('error' in validateUserPath(42, [ ALLOWED_ROOT ]));
});

test('validateUserPath accepts a path under an allowed root', () => {
    const candidate = path.join(ALLOWED_ROOT, 'Documents', 'recordings');
    const out = validateUserPath(candidate, [ ALLOWED_ROOT ]);

    assert.ok('ok' in out, `expected ok, got ${JSON.stringify(out)}`);
    assert.equal(out.ok, path.resolve(candidate));
});

test('validateUserPath accepts the allowed root itself', () => {
    const out = validateUserPath(ALLOWED_ROOT, [ ALLOWED_ROOT ]);

    assert.ok('ok' in out);
});

test('validateUserPath rejects a path entirely outside the allowed roots', () => {
    const out = validateUserPath(OUTSIDE_PATH, [ ALLOWED_ROOT ]);

    assert.ok('error' in out);
    assert.match(out.error, /outside/i);
});

test('validateUserPath accepts a `..` traversal that normalizes back into an allowed root', () => {
    // E.g. /tmp/sonacove-test/foo/../recordings → /tmp/sonacove-test/recordings
    const candidate = path.join(ALLOWED_ROOT, 'foo', '..', 'recordings');
    const out = validateUserPath(candidate, [ ALLOWED_ROOT ]);

    assert.ok('ok' in out, `expected ok, got ${JSON.stringify(out)}`);
    // After normalization the `..` is gone.
    assert.ok(!out.ok.includes(`${path.sep}..${path.sep}`));
});

test('validateUserPath rejects a `..` traversal that escapes the allowed root', () => {
    // /tmp/sonacove-test/../../etc/passwd → outside root.
    const candidate = path.join(ALLOWED_ROOT, '..', '..', isWindows ? 'Windows' : 'etc', 'secret');
    const out = validateUserPath(candidate, [ ALLOWED_ROOT ]);

    assert.ok('error' in out);
});

test('validateUserPath rejects a sibling-of-root that shares a name prefix', () => {
    // Guard against the naive `startsWith(root)` bug. /tmp/sonacove-testFOO
    // is NOT under /tmp/sonacove-test.
    const siblingPrefix = `${ALLOWED_ROOT}FOO`;
    const out = validateUserPath(siblingPrefix, [ ALLOWED_ROOT ]);

    assert.ok('error' in out, `expected error, got ${JSON.stringify(out)}`);
});

test('validateUserPath supports multiple allowed roots', () => {
    const other = isWindows
        ? path.join('D:', path.sep, 'Media')
        : '/var/media';
    const candidate = path.join(other, 'recordings');
    const out = validateUserPath(candidate, [ ALLOWED_ROOT, other ]);

    assert.ok('ok' in out);
});

test('validateUserPath rejects everything with empty allowedRoots', () => {
    assert.ok('error' in validateUserPath(ALLOWED_ROOT, []));
    assert.ok('error' in validateUserPath(path.join(ALLOWED_ROOT, 'x'), []));
});

test('validateUserPath ignores non-string entries in allowedRoots', () => {
    const candidate = path.join(ALLOWED_ROOT, 'x');
    const out = validateUserPath(candidate, [ null, undefined, '', ALLOWED_ROOT ]);

    assert.ok('ok' in out);
});

test('validateUserPath is case-insensitive on Windows', { skip: !isWindows }, () => {
    // Lowercase drive letter against an uppercase allowed root should still
    // match because Windows paths are case-insensitive.
    const lowerDrive = ALLOWED_ROOT.charAt(0).toLowerCase() + ALLOWED_ROOT.slice(1);
    const candidate = path.join(lowerDrive, 'Subdir');
    const out = validateUserPath(candidate, [ ALLOWED_ROOT ]);

    assert.ok('ok' in out, `expected ok on win32, got ${JSON.stringify(out)}`);
});

test('validateUserPath is case-sensitive on POSIX', { skip: isWindows }, () => {
    const candidate = '/TMP/SONACOVE-TEST/x';
    const out = validateUserPath(candidate, [ '/tmp/sonacove-test' ]);

    assert.ok('error' in out, 'POSIX paths are case-sensitive — should not match');
});

test('validateUserPath works with real OS tempdir roots', () => {
    const tmp = os.tmpdir();
    const candidate = path.join(tmp, 'sonacove-recordings');
    const out = validateUserPath(candidate, [ tmp ]);

    assert.ok('ok' in out);
});
