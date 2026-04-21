'use strict';

const { BrowserWindow, Notification, app } = require('electron');

const { getIconPath } = require('../paths');

const MAX_TITLE_LEN = 100;
const MAX_BODY_LEN = 250;
const PAYLOAD_MAX_AGE_MS = 10_000;
const DEDUP_TTL_MS = 3_000;

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

    // uid -> timestamp (ms). Drops duplicate sends within DEDUP_TTL_MS.
    const recentUids = new Map();

    // macOS dock bounce id — stored so focus handler can cancel it.
    let bounceId = null;

    // Unread count for setBadgeCount. Reset on focus.
    let unread = 0;

    /**
     * Clears taskbar flash, dock bounce, and badge count.
     */
    function clearAttentionSignals() {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.flashFrame(false);
            } catch {
                // Platform may not support it — ignore.
            }
        }
        if (process.platform === 'darwin' && app.dock && bounceId !== null) {
            try {
                app.dock.cancelBounce(bounceId);
            } catch {
                // Bounce already finished — ignore.
            }
            bounceId = null;
        }
        if (unread > 0) {
            unread = 0;
            try {
                app.setBadgeCount(0);
            } catch {
                // Unsupported platform — ignore.
            }
        }
    }

    /**
     * Restores, shows and focuses the main window.
     */
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

    /**
     * Validates the IPC payload shape and freshness.
     *
     * @param {object} payload
     * @returns {boolean}
     */
    function isPayloadValid(payload) {
        if (!payload || typeof payload !== 'object') {
            return false;
        }
        if (typeof payload.title !== 'string' || payload.title.trim() === '') {
            return false;
        }
        if (typeof payload.timestamp !== 'number' || Date.now() - payload.timestamp > PAYLOAD_MAX_AGE_MS) {
            return false;
        }

        return true;
    }

    /**
     * Returns true if the given uid was seen within DEDUP_TTL_MS, otherwise records it.
     *
     * @param {string|undefined} uid
     * @returns {boolean}
     */
    function isDuplicate(uid) {
        if (!uid) {
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

        return false;
    }

    /**
     * IPC listener for 'cross-window-notification'. Pops a native OS toast
     * + flash/bounce/badge when no app window is focused.
     *
     * @param {Electron.IpcMainEvent} _event
     * @param {object} payload
     */
    function onNotification(_event, payload) {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        // Any of our windows focused → drop. In-app React toast already shows.
        if (BrowserWindow.getFocusedWindow() !== null) {
            return;
        }

        if (!isPayloadValid(payload)) {
            return;
        }

        if (isDuplicate(payload.uid)) {
            return;
        }

        const title = String(payload.title).slice(0, MAX_TITLE_LEN);
        const body = typeof payload.body === 'string'
            ? payload.body.slice(0, MAX_BODY_LEN)
            : '';

        if (!Notification.isSupported()) {
            return;
        }

        const notification = new Notification({
            title,
            body,
            icon: getIconPath('png'),
            silent: false
        });

        notification.on('click', () => {
            focusMainWindow();
            clearAttentionSignals();
        });

        notification.show();

        // Taskbar flash (Windows; no-op elsewhere).
        if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.flashFrame(true);
            } catch {
                // Ignore.
            }
        }

        // Dock bounce (macOS).
        if (process.platform === 'darwin' && app.dock) {
            try {
                // Cancel any previous bounce so we don't stack.
                if (bounceId !== null) {
                    app.dock.cancelBounce(bounceId);
                }
                bounceId = app.dock.bounce('informational');
            } catch {
                // Ignore.
            }
        }

        // Badge count — works on macOS dock, no-op on Windows (non-Unity Linux too).
        unread += 1;
        try {
            app.setBadgeCount(unread);
        } catch {
            // Ignore.
        }

        if (capture) {
            capture('cross_window_notification_shown', {
                uid: payload.uid || null,
                appearance: payload.appearance || null
            });
        }
    }

    /**
     * Window 'focus' handler — clears flash/bounce/badge when user returns.
     */
    function onFocus() {
        clearAttentionSignals();
    }

    ipcMain.on('cross-window-notification', onNotification);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.on('focus', onFocus);
    }

    // eslint-disable-next-line require-jsdoc
    return function cleanup() {
        ipcMain.removeListener('cross-window-notification', onNotification);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.removeListener('focus', onFocus);
        }
        recentUids.clear();
        clearAttentionSignals();
    };
}

module.exports = { setupCrossWindowNotifications };
