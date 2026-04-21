'use strict';

const { BrowserWindow, Notification, app } = require('electron');

const { getIconPath } = require('../paths');

const IPC_CHANNEL = 'cross-window-notification';
const MAX_TITLE_LEN = 100;
const MAX_BODY_LEN = 250;
const PAYLOAD_MAX_AGE_MS = 10_000;
const DEDUP_TTL_MS = 3_000;
const MAX_RECENT_KEYS = 50;

/**
 * Sets up native OS notifications for jitsi in-meeting events when the app window is unfocused.
 *
 * The renderer (jitsi-meet) forwards allowlisted notifications over the
 * 'cross-window-notification' IPC channel. This module checks focus state and,
 * when no app window has focus, pops a native Notification + flashes the taskbar
 * (Windows) / bounces the dock (macOS) / sets an unread badge. Clicking the toast
 * restores and focuses the main window. Focus clears all three attention signals.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {Electron.BrowserWindow} mainWindow
 * @param {{ capture?: (event: string, props?: object) => void }} [options]
 * @returns {() => void} Cleanup function — call from mainWindow 'closed'.
 */
function setupCrossWindowNotifications(ipcMain, mainWindow, options = {}) {
    const capture = typeof options.capture === 'function' ? options.capture : null;
    const notificationIcon = getIconPath('png');

    // uid -> timestamp (ms). Drops duplicate sends within DEDUP_TTL_MS.
    const recentUids = new Map();

    // macOS dock bounce id — stored so focus handler can cancel it.
    let bounceId = null;

    let unread = 0;

    // eslint-disable-next-line require-jsdoc
    function clearAttentionSignals() {
        if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.flashFrame(false);
            } catch {
                // Platform doesn't support it.
            }
        }
        if (process.platform === 'darwin' && app.dock && bounceId !== null) {
            try {
                app.dock.cancelBounce(bounceId);
            } catch {
                // Bounce already finished.
            }
            bounceId = null;
        }
        if (unread > 0) {
            unread = 0;
            try {
                app.setBadgeCount(0);
            } catch {
                // Unsupported platform.
            }
        }
    }

    // eslint-disable-next-line require-jsdoc
    function focusMainWindow() {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
    }

    // eslint-disable-next-line require-jsdoc
    function isPayloadValid(payload) {
        if (!payload || typeof payload !== 'object') {
            return false;
        }
        if (typeof payload.title !== 'string' || payload.title.trim() === '') {
            return false;
        }
        if (typeof payload.timestamp !== 'number') {
            return false;
        }
        const age = Date.now() - payload.timestamp;

        if (age < 0 || age > PAYLOAD_MAX_AGE_MS) {
            return false;
        }

        return true;
    }

    // eslint-disable-next-line require-jsdoc
    function isDuplicate(uid) {
        if (uid === undefined || uid === null) {
            return false;
        }
        const now = Date.now();
        const last = recentUids.get(uid);

        if (last && now - last < DEDUP_TTL_MS) {
            return true;
        }
        recentUids.set(uid, now);

        // Opportunistic cleanup — drop entries older than TTL.
        for (const [ k, t ] of recentUids) {
            if (now - t >= DEDUP_TTL_MS) {
                recentUids.delete(k);
            }
        }

        // Hard cap — trim oldest entries if the Map has somehow grown large
        // (e.g. a burst of distinct UIDs arrived and hasn't been cleaned yet).
        while (recentUids.size > MAX_RECENT_KEYS) {
            const oldest = recentUids.keys().next().value;

            if (oldest === undefined) {
                break;
            }
            recentUids.delete(oldest);
        }

        return false;
    }

    // eslint-disable-next-line require-jsdoc
    function onNotification(_event, payload) {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        // Any of our windows focused → drop. In-app React toast already shows.
        if (BrowserWindow.getFocusedWindow() !== null) {
            return;
        }

        if (!isPayloadValid(payload) || isDuplicate(payload.uid)) {
            return;
        }

        if (!Notification.isSupported()) {
            return;
        }

        const title = String(payload.title).slice(0, MAX_TITLE_LEN);
        const body = typeof payload.body === 'string'
            ? payload.body.slice(0, MAX_BODY_LEN)
            : '';

        const notification = new Notification({
            title,
            body,
            icon: notificationIcon
        });

        notification.on('click', () => {
            focusMainWindow();
            clearAttentionSignals();
        });

        notification.show();

        if (process.platform === 'win32') {
            try {
                mainWindow.flashFrame(true);
            } catch { /* empty */ }
        }

        if (process.platform === 'darwin' && app.dock) {
            try {
                // Cancel any previous bounce so we don't stack.
                if (bounceId !== null) {
                    app.dock.cancelBounce(bounceId);
                }
                bounceId = app.dock.bounce('informational');
            } catch { /* empty */ }
        }

        // Badge count — works on macOS dock, no-op on Windows (non-Unity Linux too).
        unread += 1;
        try {
            app.setBadgeCount(unread);
        } catch { /* empty */ }

        if (capture) {
            capture('cross_window_notification_shown', {
                uid: payload.uid || null,
                appearance: payload.appearance || null
            });
        }
    }

    // eslint-disable-next-line require-jsdoc
    function onFocus() {
        clearAttentionSignals();
    }

    ipcMain.on(IPC_CHANNEL, onNotification);
    mainWindow.on('focus', onFocus);

    // eslint-disable-next-line require-jsdoc
    return function cleanup() {
        ipcMain.removeListener(IPC_CHANNEL, onNotification);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.removeListener('focus', onFocus);
        }
        recentUids.clear();
        clearAttentionSignals();
    };
}

module.exports = { setupCrossWindowNotifications };
