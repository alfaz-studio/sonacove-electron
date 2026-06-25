'use strict';

// Win11-test-session helper. Walks through the pre-flight checklist
// from the implementation plan and prints a structured summary at the
// end. Run from the renderer's DevTools console as:
//
//   await window.sonacoveElectronAPI.winAudio.diagnostics({ runSmokeTest: true });
//
// or from a node REPL after `require('./native/winaudio/test-plan')(opts)`.
//
// What this checks (no actual audio capture — strictly diagnostic):
//   1. Platform is Windows (sanity).
//   2. Windows build >= MIN_BUILD (22000 = Win11 21H2 base build).
//   3. Addon loaded (no DLL miss, no missing exports).
//   4. PID tree visible — Chromium's audio service should be in here
//      somewhere; if it isn't, EXCLUDE_TARGET_PROCESS_TREE won't catch
//      it and the echo will persist even with a working capture.
//   5. Smoke test — full ActivateAudioInterfaceAsync path WITHOUT
//      starting capture. Returns the HRESULT so activation failures
//      are isolated from capture failures.

const winaudio = require('./index');

const MIN_BUILD_FOR_PROCESS_LOOPBACK = winaudio.MIN_BUILD;

function fmtHr(hr) {
    if (hr === 0) {
        return 'S_OK';
    }
    if (hr === 0xFFFFFFFF) {
        return '<not run>';
    }

    // Common ones, named. Unknown ones print as hex.
    const named = {
        0x80004001: 'E_NOTIMPL',
        0x80004002: 'E_NOINTERFACE',
        0x80004005: 'E_FAIL',
        0x80070057: 'E_INVALIDARG',
        0x8007000E: 'E_OUTOFMEMORY',
        0x80070005: 'E_ACCESSDENIED',
        0x88890002: 'AUDCLNT_E_ALREADY_INITIALIZED',
        0x88890003: 'AUDCLNT_E_WRONG_ENDPOINT_TYPE',
        0x88890004: 'AUDCLNT_E_DEVICE_INVALIDATED',
        0x88890008: 'AUDCLNT_E_UNSUPPORTED_FORMAT',
        0x80000004: 'E_PENDING'
    };
    const u32 = hr >>> 0;

    return named[u32] || `0x${u32.toString(16).padStart(8, '0').toUpperCase()}`;
}

function runTestPlan(options) {
    const log = (options && options.log) || console.log;
    const result = {
        platformOk: process.platform === 'win32',
        windowsBuild: null,
        windowsBuildOk: false,
        addonLoaded: false,
        pidTreeOk: false,
        smokeTestOk: false,
        details: null
    };

    log('--- Win audio test plan ---');
    log(`platform: ${process.platform} ${result.platformOk ? 'OK' : 'FAIL (expected win32)'}`);

    if (!result.platformOk) {
        log('--- end (non-Win) ---');

        return result;
    }

    // Build check uses os.release() so we don't need the addon to load
    // first — handy if the addon itself fails on a too-old build.
    const os = require('os');
    const buildStr = (os.release() || '').split('.')[2];
    const build = Number(buildStr) || 0;

    result.windowsBuild = build;
    result.windowsBuildOk = build >= MIN_BUILD_FOR_PROCESS_LOOPBACK;
    log(`windowsBuild: ${build} ${
        result.windowsBuildOk ? 'OK' : `FAIL (need ${MIN_BUILD_FOR_PROCESS_LOOPBACK}+)`}`);

    result.addonLoaded = winaudio.isSupported();
    log(`addonLoaded: ${result.addonLoaded ? 'OK' : `FAIL — ${winaudio.loadError()?.message || 'reason unknown'}`}`);

    if (!result.addonLoaded) {
        log('--- end (addon not loaded) ---');

        return result;
    }

    const snapshot = winaudio.diagnostics(true);

    result.details = snapshot;
    log(`PID: ${snapshot.currentProcessId}`);
    log(`direct children: ${snapshot.childPids}`);
    log(`descendants (BFS d=6): ${snapshot.descendantPids}`);
    log(`os version: ${snapshot.windowsVersion}`);
    log(`com init fresh: ${snapshot.comInitFresh}`);

    result.pidTreeOk = (snapshot.descendantPids
        && snapshot.descendantPids !== '<none>'
        && snapshot.descendantPids !== '<snapshot-failed>');
    log(`pid tree: ${result.pidTreeOk ? 'OK (children visible)' : 'WARN (no children seen — exclusion may not work)'}`);

    const hr = snapshot.smokeTestHresult;

    result.smokeTestOk = hr === 0;
    log(`smoke test HRESULT: ${fmtHr(hr)} ${result.smokeTestOk ? 'OK' : 'FAIL'}`);

    if (snapshot.mixFormatDescription) {
        log(`mix format: ${snapshot.mixFormatDescription}`);
    }

    log('--- end ---');

    return result;
}

module.exports = runTestPlan;
