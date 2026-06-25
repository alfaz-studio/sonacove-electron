'use strict';

// CI-only Electron main script used by .github/workflows/native-addon-smoketest.yml.
// Loads the platform-specific native audio addon, runs the diagnostic
// path (no real capture — no display/audio device needed), and exits.
//
// Why this exists vs `electron -- -e "..."`: Electron's CLI doesn't have
// a `-e` eval flag; it expects a path to an app's main script. Without
// app.quit() the runner waits forever for a window that never opens,
// hitting the workflow timeout.

const { app } = require('electron');

const target = process.argv.find(a => a === '--mac' || a === '--win');

if (!target) {
    process.stderr.write('usage: electron smoketest-native.js --mac|--win\n');
    process.exit(2);
}

function fail(msg) {
    process.stderr.write(`SMOKETEST FAIL: ${msg}\n`);
    process.exit(1);
}

function pass(msg) {
    process.stdout.write(`SMOKETEST PASS: ${msg}\n`);
}

app.whenReady().then(() => {
    try {
        if (target === '--mac') {
            const ma = require('../native/macaudio');

            console.log('macaudio isSupported:', ma.isSupported());
            console.log('macaudio loadError:', ma.loadError() && ma.loadError().message);

            if (!ma.isSupported()) {
                fail('macaudio.isSupported() === false');

                return;
            }
            pass('macaudio loaded and isSupported() === true');
        } else {
            const wa = require('../native/winaudio');

            console.log('winaudio isSupported:', wa.isSupported());
            console.log('winaudio loadError:', wa.loadError() && wa.loadError().message);

            // Non-capture diagnostic — runs the full activation chain
            // without IAudioClient::Start. On the Win11 runner this
            // should return smokeTestHresult=0 and a Float32 mix
            // format.
            const diag = wa.diagnostics(true);

            console.log('winaudio diagnostics:\n', JSON.stringify(diag, null, 2));

            if (!wa.isSupported()) {
                fail('winaudio.isSupported() === false');

                return;
            }
            pass('winaudio loaded and isSupported() === true');
        }

        app.quit();
    } catch (err) {
        fail(err && err.stack ? err.stack : String(err));
    }
});

// Hard ceiling — if anything hangs, fail rather than burning the runner
// quota.
setTimeout(() => fail('timeout: smoketest exceeded 60s'), 60000);
