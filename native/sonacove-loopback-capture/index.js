'use strict';

// NOTE: This native module is not currently used. It is prepared for future
// integration of echo-free system audio sharing via WASAPI loopback capture.

// Only load the native addon on Windows — other platforms get a stub.
if (process.platform !== 'win32') {
    module.exports = {
        isSupported: () => false,
        getDefaultFormat: () => null,
        startCapture: () => false,
        stopCapture: () => {}
    };
} else {
    try {
        const path = require('path');
        const bindings = require('node-gyp-build')(path.resolve(__dirname));

        module.exports = bindings;
    } catch (err) {
        console.warn('[sonacove-loopback-capture] Failed to load native module:', err.message);
        module.exports = {
            isSupported: () => false,
            getDefaultFormat: () => null,
            startCapture: () => false,
            stopCapture: () => {}
        };
    }
}
