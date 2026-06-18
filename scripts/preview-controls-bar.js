/**
 * Standalone preview of the screenshare controls bar — no meeting or
 * screenshare needed. Opens just the bar window so it can be iterated on fast.
 *
 *   npm run preview:controls-bar              open the bar
 *   npm run preview:controls-bar -- --devtools  + detached DevTools
 *
 * Live-reloads the window whenever the bar's html/css/renderer js changes.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const {
    openControlsBarWindow,
    setConferenceTimestamp
} = require('../app/features/controls-bar/controls-bar-window');

const FEATURE_DIR = path.join(__dirname, '../app/features/controls-bar');
const WATCH_FILES = [ 'controls-bar.html', 'controls-bar.css', 'controls-bar.js' ];
const wantsDevtools = process.argv.includes('--devtools');

app.whenReady().then(() => {
    const win = openControlsBarWindow();

    if (!win) {
        console.error('Could not open the controls bar window.');
        app.quit();

        return;
    }

    if (wantsDevtools) {
        win.webContents.openDevTools({ mode: 'detach' });
    }

    // No meeting in standalone preview — fake a conference start (~17 min ago)
    // so the live timer ticks. Cached + replayed to the bar on (re)load.
    setConferenceTimestamp(Date.now() - (((17 * 60) + 12) * 1000));

    // Live reload on asset edits.
    for (const file of WATCH_FILES) {
        try {
            fs.watch(path.join(FEATURE_DIR, file), () => {
                if (win && !win.isDestroyed()) {
                    win.webContents.reloadIgnoringCache();
                }
            });
        } catch {
            // file missing / platform without fs.watch — skip
        }
    }

    console.log('✅ Controls bar preview open. Edit the html/css/js to live-reload.');
});

app.on('window-all-closed', () => app.quit());
