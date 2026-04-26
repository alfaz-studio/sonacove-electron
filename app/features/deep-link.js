const { app, ipcMain } = require('electron');
const path = require('path');

const config = require('./config');
const { t } = require('./i18n');
const { showDeeplinkModal } = require('./in-app-dialogs');
const { getMainWindow } = require('./overlay/helpers');
const { closeOverlay } = require('./overlay/overlay-window');
const { closeParticipantWindow } = require('./pip/participant-window');

/**
 * Max wait for jitsi's leaveConference() flow to reach /static/close before
 * we force the deep-link navigation anyway. If the renderer is unresponsive
 * or somehow skips the hangup redirect, this guarantees the user still gets
 * into the new meeting.
 */
const DEEPLINK_LEAVE_TIMEOUT_MS = 5000;

/**
 * True while a deep-link triggered loadURL is in flight. The main window's
 * will-prevent-unload handler checks this to skip the "Leave Meeting?" quit
 * modal — the user already confirmed the deep-link modal, and falling into
 * the quit flow would destroy the window instead of navigating.
 */
let deeplinkNavigating = false;

/**
 * When non-null, a deep-link navigation is waiting for the in-progress
 * leaveConference() flow to reach /static/close. Shape:
 * `{ targetUrl: string, timer: Timeout }`.
 *
 * Consumed by completeDeeplinkNavigation(), which main.js invokes from its
 * will-navigate handler when /static/close is reached (or by the fallback
 * timer if that redirect never happens).
 */
let pendingDeeplink = null;

/**
 * Tracks the currently-displayed deep-link modal so that a newer deep-link
 * can tear down the older one completely: remove the IPC listener by
 * reference, cancel the 60s timeout, and resolve the stalled promise with
 * 'cancel' (avoids leaking a live async frame for up to a minute).
 *
 * Shape: `{ handler: Function, cancelTimer: Timeout, resolve: Function }`.
 */
let pendingDeeplinkModal = null;

/**
 * Reads the deep-link-navigating flag and clears it atomically.
 *
 * The main window's will-prevent-unload handler calls this to decide
 * whether to bypass the "Leave Meeting?" quit modal. Clearing on read
 * makes the lifetime event-driven — the flag is cleared exactly when it
 * served its purpose, regardless of timing.
 *
 * Named `take*` (not `is*`) to signal that it mutates state on call —
 * it's not a predicate.
 *
 * @returns {boolean} True if a deep-link load was in flight (and the flag
 *  has now been cleared).
 */
function takeDeeplinkNavigating() {
    const was = deeplinkNavigating;

    deeplinkNavigating = false;

    return was;
}

/**
 * @returns {boolean} True while we're waiting for leaveConference() to
 *  reach /static/close before the deep-link navigation can complete.
 */
function isDeeplinkPending() {
    return pendingDeeplink !== null;
}

/**
 * Loads the target URL in the given window, setting the beforeunload-bypass
 * flag briefly in case a residual beforeunload handler is still attached.
 *
 * @param {BrowserWindow} win - The window to navigate.
 * @param {string} targetUrl - The destination URL.
 */
function performDeeplinkLoad(win, targetUrl) {
    deeplinkNavigating = true;

    // Clear the flag as soon as navigation actually starts.
    // `did-start-navigation` fires AFTER beforeunload is resolved — so if
    // will-prevent-unload was going to consume the flag, it already has.
    // Clearing here (instead of after a fixed timeout) prevents the flag
    // from lingering into an unrelated close attempt the user might make
    // a second or two later, which would silently bypass the leave-modal.
    let safetyTimer;
    const clearFlag = () => {
        deeplinkNavigating = false;
        clearTimeout(safetyTimer);
    };

    win.webContents.once('did-start-navigation', clearFlag);

    // Safety: if did-start-navigation never fires (window destroyed during
    // load, loadURL rejected, etc.) still clear the flag so it doesn't
    // stick indefinitely. Guard webContents access — it throws when the
    // window was destroyed during the 2s window.
    safetyTimer = setTimeout(() => {
        deeplinkNavigating = false;
        if (!win.isDestroyed()) {
            win.webContents.removeListener('did-start-navigation', clearFlag);
        }
    }, 2000);

    // Restore + show + focus before loadURL so the navigation happens
    // against a visible window. isMinimized() is false when the window is
    // hidden (win.hide() / macOS cmd+H), so show() is required — focus()
    // alone won't un-hide a hidden window.
    if (win.isMinimized()) {
        win.restore();
    }
    win.show();
    win.focus();
    win.loadURL(targetUrl);
}

/**
 * Tears down any in-flight deep-link state. Call from main.js on window
 * close so the 60s modal-cancel timer and 5s leave-fallback timer don't
 * keep ticking after the window is gone (low-impact — handlers no-op on
 * a destroyed window — but tidier).
 */
function cleanupDeeplinkState() {
    if (pendingDeeplinkModal) {
        ipcMain.removeListener('deeplink-modal-action', pendingDeeplinkModal.handler);
        clearTimeout(pendingDeeplinkModal.cancelTimer);
        pendingDeeplinkModal.resolve('cancel');
        pendingDeeplinkModal = null;
    }
    if (pendingDeeplink) {
        clearTimeout(pendingDeeplink.timer);
        pendingDeeplink = null;
    }
    deeplinkNavigating = false;
}

/**
 * Completes a pending deep-link navigation: clears the fallback timer,
 * closes the participant PiP panel, and loads the stored target URL.
 *
 * Called from main.js's will-navigate handler when /static/close fires
 * after leaveConference(), and also by the fallback timer if that
 * redirect never arrives.
 *
 * @returns {boolean} True if a pending navigation was consumed.
 */
function completeDeeplinkNavigation() {
    if (!pendingDeeplink) {
        return false;
    }

    const { targetUrl, timer } = pendingDeeplink;

    clearTimeout(timer);
    pendingDeeplink = null;

    const win = getMainWindow();

    if (!win || win.isDestroyed()) {
        return false;
    }

    // Ensure the PiP panel is gone. The renderer's cleanup IPC usually
    // handles this via SCREENSHARE_STOP, but pill mode is skipped there,
    // and the IPC can race with the page unload. Idempotent.
    closeParticipantWindow(false);

    performDeeplinkLoad(win, targetUrl);

    return true;
}

/**
 * Registers the custom protocol scheme for the application.
 *
 * @returns {void}
 */
function registerProtocol() {
    const protocol = config.appProtocolPrefix;

    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient(protocol, process.execPath, [ path.resolve(process.argv[1]) ]);
        }
    } else {
        app.setAsDefaultProtocolClient(protocol);
    }
}

/**
 * Navigates the application based on the provided deep link.
 * Handles standard navigation (e.g. sonacove://meet/roomname).
 *
 * @param {string} deepLink - The deep link URL to process.
 * @returns {boolean} Success status.
 */
async function navigateDeepLink(deepLink) {
    try {
        let rawPath = deepLink.replace(`${config.appProtocolPrefix}://`, '');

        try {
            const appHost = new URL(config.currentConfig.landing).host; // e.g. sonacove.com
            const meetHost = new URL(config.currentConfig.meetRoot).host;

            if (rawPath.startsWith(appHost)) {
                rawPath = rawPath.replace(appHost, '');
            } else if (meetHost !== appHost && rawPath.startsWith(meetHost)) {
                rawPath = rawPath.replace(meetHost, '');
            }
        } catch (e) { /* ignore URL parsing error */ }

        if (rawPath.startsWith('/')) {
            rawPath = rawPath.substring(1);
        }
        if (rawPath.endsWith('/')) {
            rawPath = rawPath.slice(0, -1);
        }

        const meetRoot = config.currentConfig.meetRoot;
        let targetUrl = '';

        if (rawPath.startsWith('meet/')) {
            const meetRootOrigin = new URL(meetRoot).origin; // https://sonacove.com

            targetUrl = `${meetRootOrigin}/${rawPath}`;
        } else if (rawPath && rawPath !== '') {
            // Ensure meetRoot doesn't have trailing slash for clean concatenation
            const cleanMeetRoot = meetRoot.endsWith('/') ? meetRoot.slice(0, -1) : meetRoot;

            targetUrl = `${cleanMeetRoot}/${rawPath}`;
        } else {
            targetUrl = config.currentConfig.landing;
        }

        console.log(`🔗 Navigating Deep Link to: ${targetUrl}`);

        const win = getMainWindow();

        if (!win) {
            return false;
        }

        // Check if user is currently in a meeting
        let inMeeting = false;

        try {
            const currentUrl = new URL(win.webContents.getURL());

            inMeeting = currentUrl.pathname.startsWith('/meet');
        } catch (e) { /* ignore URL parse errors */ }

        if (inMeeting) {
            // Tear down any modal left over from a superseded deep-link:
            // remove the IPC listener by reference (not removeAllListeners
            // — a third party could legitimately listen on this channel in
            // the future), cancel the 60s timeout, and resolve the old
            // promise so it doesn't leak a live async frame.
            if (pendingDeeplinkModal) {
                ipcMain.removeListener('deeplink-modal-action', pendingDeeplinkModal.handler);
                clearTimeout(pendingDeeplinkModal.cancelTimer);
                pendingDeeplinkModal.resolve('cancel');
                pendingDeeplinkModal = null;
            }

            showDeeplinkModal(win.webContents, {
                title: t('deeplinkModal.title'),
                message: t('deeplinkModal.message'),
                confirm: t('deeplinkModal.confirm'),
                cancel: t('deeplinkModal.cancel')
            });

            const TIMEOUT_MS = 60000;
            const action = await new Promise(resolve => {
                const cancelTimer = setTimeout(() => {
                    if (pendingDeeplinkModal) {
                        ipcMain.removeListener('deeplink-modal-action', pendingDeeplinkModal.handler);
                        pendingDeeplinkModal = null;
                    }
                    resolve('cancel');
                }, TIMEOUT_MS);

                const handler = (_event, data) => {
                    pendingDeeplinkModal = null;
                    clearTimeout(cancelTimer);
                    resolve(data?.action);
                };

                pendingDeeplinkModal = { handler, cancelTimer, resolve };
                ipcMain.once('deeplink-modal-action', handler);
            });

            if (action !== 'confirm') {
                return false;
            }

            closeOverlay(false, 'deep-link-navigation');

            // If a previous deep-link leave is still in flight, replace its
            // target — the user's most recent confirmation wins — but don't
            // re-send pip-end-meeting below; the renderer is already tearing
            // the conference down and a second trigger could interfere.
            const leaveAlreadyInFlight = pendingDeeplink !== null;

            if (pendingDeeplink) {
                clearTimeout(pendingDeeplink.timer);
            }

            pendingDeeplink = {
                targetUrl,
                // Known edge case: if the renderer sends /static/close at
                // nearly the same millisecond this timer fires, the timer
                // clears pendingDeeplink first and main.js's will-navigate
                // handler falls through to the normal dashboard redirect
                // path (`setImmediate(loadURL(closePageUrl))`). The timer's
                // loadURL has already been issued by then, so the target
                // meeting wins in practice — worst case is a brief flash
                // of the dashboard-close URL before the new meeting loads.
                timer: setTimeout(() => {
                    console.warn('⚠️ Deep-link leave timeout — forcing navigation.');
                    completeDeeplinkNavigation();
                }, DEEPLINK_LEAVE_TIMEOUT_MS)
            };

            // Trigger the same leaveConference() flow the leave-modal uses.
            // Renderer handles the clean XMPP leave, then navigates to
            // /static/close — main.js's will-navigate handler sees the
            // pending deeplink and finishes the navigation.
            if (!leaveAlreadyInFlight) {
                win.webContents.send('pip-end-meeting');
            }

            return true;
        }

        // Not in a meeting — navigate directly.
        performDeeplinkLoad(win, targetUrl);

        return true;
    } catch (error) {
        console.error('Error parsing deep link:', error);

        return false;
    }
}

module.exports = {
    registerProtocol,
    navigateDeepLink,
    takeDeeplinkNavigating,
    isDeeplinkPending,
    completeDeeplinkNavigation,
    cleanupDeeplinkState
};
