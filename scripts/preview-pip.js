/**
 * Standalone preview of the Spotlight participant PiP — no meeting needed.
 * Opens just the PiP window with a mock multi-user roster so the layouts
 * (single / split / grid), the Auto/Pinned follow toggle, and the filmstrip
 * can be iterated on fast.
 *
 *   npm run preview:pip                 open the PiP with mock users
 *   npm run preview:pip -- --devtools     + detached DevTools
 *   npm run preview:pip -- --n=8          mock 8 participants (default 6)
 *
 * Live-reloads the window whenever the panel html/css/js changes. A rotating
 * "dominant speaker" drives the Auto-follow so you can see it track.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const {
    openParticipantWindow,
    sendParticipantsUpdate
} = require('../app/features/pip/participant-window');

const FEATURE_DIR = path.join(__dirname, '../app/features/pip');
const WATCH_FILES = [ 'participant-panel.html', 'participant-panel.css', 'participant-panel.js' ];
const wantsDevtools = process.argv.includes('--devtools');

const nArg = process.argv.find(a => a.startsWith('--n='));
const COUNT = Math.max(1, Math.min(20, nArg ? parseInt(nArg.slice(4), 10) : 6));

// A mock roster (mirrors the design's PEOPLE, extended). 'local' renders as the
// brand mark; the rest get gradient initials. No real video — tiles show avatars.
const PEOPLE = [
    { id: 'local',
        name: 'You',
        initials: 'YO',
        hasAudio: true,
        hasVideo: false },
    { id: 'p2',
        name: 'Daniel R.',
        initials: 'DR',
        avatarColor: '#059669',
        hasAudio: true,
        hasVideo: false },
    { id: 'p3',
        name: 'Abdul',
        initials: 'AB',
        avatarColor: '#2563eb',
        hasAudio: true,
        hasVideo: false },
    { id: 'p4',
        name: 'ibrahim3 c',
        initials: 'IC',
        avatarColor: '#7c3aed',
        hasAudio: false,
        hasVideo: false },
    { id: 'p5',
        name: 'Sara M.',
        initials: 'SM',
        avatarColor: '#d97706',
        hasAudio: true,
        hasVideo: false },
    { id: 'p6',
        name: 'Noah K.',
        initials: 'NK',
        avatarColor: '#e11d48',
        hasAudio: false,
        hasVideo: false },
    { id: 'p7',
        name: 'Mia T.',
        initials: 'MT',
        avatarColor: '#0891b2',
        hasAudio: true,
        hasVideo: false },
    { id: 'p8',
        name: 'Omar F.',
        initials: 'OF',
        avatarColor: '#ca8a04',
        hasAudio: true,
        hasVideo: false },
    { id: 'p9',
        name: 'Lena P.',
        initials: 'LP',
        avatarColor: '#be185d',
        hasAudio: false,
        hasVideo: false },
    { id: 'p10',
        name: 'Yusuf A.',
        initials: 'YA',
        avatarColor: '#4f46e5',
        hasAudio: true,
        hasVideo: false }
];

const roster = PEOPLE.slice(0, COUNT);

// Rotate the dominant speaker among the remotes so Auto-follow visibly tracks.
let speaker = 1;

/** Push the current mock roster (with the rotating dominant speaker) to the panel. */
function pushUpdate() {
    const withSpeaking = roster.map((p, i) => {
        return { ...p,
            dominantSpeaker: i === speaker };
    });

    sendParticipantsUpdate({
        participants: withSpeaking.slice(0, 4),
        roster: withSpeaking,
        totalParticipantCount: roster.length,
        unreadChatCount: 0
    });
}

app.whenReady().then(() => {
    openParticipantWindow();

    if (wantsDevtools) {
        const { getParticipantWindow } = require('../app/features/pip/helpers');
        const win = getParticipantWindow();

        if (win) {
            win.webContents.openDevTools({ mode: 'detach' });
        }
    }

    pushUpdate();
    setInterval(() => {
        speaker = 1 + (speaker % Math.max(1, roster.length - 1));
        pushUpdate();
    }, 2500);

    for (const file of WATCH_FILES) {
        try {
            fs.watch(path.join(FEATURE_DIR, file), () => {
                const { getParticipantWindow } = require('../app/features/pip/helpers');
                const win = getParticipantWindow();

                if (win && !win.isDestroyed()) {
                    win.webContents.reloadIgnoringCache();
                }
            });
        } catch {
            // file missing / platform without fs.watch — skip
        }
    }

    console.log(`✅ PiP preview open with ${roster.length} mock users. Edit the panel html/css/js to live-reload.`);
});

app.on('window-all-closed', () => app.quit());
