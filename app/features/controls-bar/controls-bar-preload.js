const { contextBridge, ipcRenderer } = require('electron');

// Channel names mirror IPC in ./constants.js — kept in sync by hand (same as
// the PiP preload; preloads can't cleanly require feature modules).

/**
 * Builds a main → renderer subscription for a channel. The returned function
 * takes a callback (invoked with the payload directly) and returns an
 * unsubscribe function.
 *
 * @param {string} channel - The IPC channel to listen on.
 * @returns {(cb: Function) => () => void}
 */
function onChannel(channel) {
    return callback => {
        const handler = (_event, data) => callback(data);

        ipcRenderer.on(channel, handler);

        return () => ipcRenderer.removeListener(channel, handler);
    };
}

contextBridge.exposeInMainWorld('controlsBarAPI', {
    // Expand (true) / collapse (false) — main resizes the window to fit.
    setHover: expanded => ipcRenderer.send('cb-hover', Boolean(expanded)),
    startDrag: () => ipcRenderer.send('cb-start-window-drag'),
    stopDrag: () => ipcRenderer.send('cb-stop-window-drag'),
    stopShare: () => ipcRenderer.send('cb-stop-share'),

    // Click-through: when the cursor is off the capsule, ignore mouse events so
    // clicks fall through the transparent margins to the window behind (the
    // shared screen / meeting). Reuses the shared overlay handler in ipc.js.
    setIgnoreMouse: ignore => ipcRenderer.send('set-ignore-mouse-events', Boolean(ignore)),

    // Conference start timestamp (epoch ms) for the meeting timer.
    onConferenceTimestamp: onChannel('cb-conference-timestamp'),

    // Mic / camera toggles — forwarded to the meeting renderer.
    toggleAudio: () => ipcRenderer.send('cb-toggle-audio'),
    toggleVideo: () => ipcRenderer.send('cb-toggle-video'),

    // Live mic/cam muted state ({ audioMuted, videoMuted }) → Audio/Video icons.
    onAvState: onChannel('cb-av-state'),

    // Open the participants pane / chat in the meeting.
    openParticipants: () => ipcRenderer.send('cb-open-participants'),
    openChat: () => ipcRenderer.send('cb-open-chat'),

    // Toggle local recording.
    toggleRecord: () => ipcRenderer.send('cb-toggle-record'),

    // Local recording on/off ({ recording }) → Record menu label.
    onRecording: onChannel('cb-recording'),

    // Transient toast ({ message, sub?, actionLabel? }) → shown below the bar.
    onToast: onChannel('cb-toast'),

    // Toast's "Show in folder" button → reveal the saved recording.
    openRecording: () => ipcRenderer.send('cb-open-recording'),

    // Live counts ({ participantCount, unreadCount }) → Participants/Chat badges.
    onCounts: onChannel('cb-counts')
});
