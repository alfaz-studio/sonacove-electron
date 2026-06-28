const { BrowserWindow, app, globalShortcut, session } = require('electron');

const { getIconPath } = require('../paths');

const {
    ALWAYS_ON_TOP_LEVEL,
    TRANSPARENT_BG,
    SHORTCUT_TOGGLE_CLICK_THROUGH,
    IPC_TOGGLE_CLICK_THROUGH,
    OVERLAY_PARTITION,
    CLOSE_REASON_LOAD_FAILED,
    CLOSE_REASON_CRASHED,
    CLOSE_REASON_UNRESPONSIVE
} = require('./constants');

/**
 * Per-attempt ceiling (ms) for the overlay page to make load progress. The page
 * is a REMOTE meeting-app shell, so a cold/slow connection can legitimately take
 * a while to reach `dom-ready` — hence the generous ceiling. Crucially this is
 * not an absolute deadline: the watchdog is reset on every `did-start-loading`
 * (see wireEvents), so an ongoing load that keeps making progress (redirects,
 * sub-resource fetches, retries) is never torn down. Only a genuinely wedged
 * load — no progress at all for this whole window — trips the failure path.
 */
const LOAD_WATCHDOG_MS = 45000;

/**
 * Grace window (ms) after `unresponsive` before tearing the overlay down. A brief
 * hang during Excalidraw init is normal and usually clears (`responsive`); only a
 * sustained freeze — which blocks the whole screen, the overlay being fullscreen
 * always-on-top — warrants a teardown.
 */
const UNRESPONSIVE_GRACE_MS = 10000;

/** Module-level set tracking overlay windows (safer than setting arbitrary props on BrowserWindow). */
const overlayWindows = new Set();

/**
 * Creates the BrowserWindow instance for the annotation overlay.
 *
 * @param {{ x: number, y: number, width: number, height: number }} screenBounds - Target screen bounds.
 * @param {string|undefined} preloadPath - Resolved preload script path.
 * @returns {BrowserWindow} The new overlay window.
 */
function createOverlayWindow(screenBounds, preloadPath) {
    const { x, y, width, height } = screenBounds;
    const isMac = process.platform === 'darwin';

    const windowOptions = {
        x: Math.floor(x),
        y: Math.floor(y),
        width: Math.floor(width),
        height: Math.floor(height),
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        roundedCorners: false,
        fullscreen: !isMac,
        resizable: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: TRANSPARENT_BG,
        icon: getIconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath,

            // Dedicated partition so the CORS relaxation in wireEvents()
            // only affects the overlay, not the main window's session.
            partition: OVERLAY_PARTITION
        }
    };

    if (isMac) {
        windowOptions.type = 'utility';
    }

    const win = new BrowserWindow(windowOptions);

    // Track so getMainWindow() can exclude overlays from its search
    overlayWindows.add(win);
    win.on('closed', () => overlayWindows.delete(win));

    return win;
}

/**
 * Applies platform-specific configuration to the overlay window.
 *
 * @param {BrowserWindow} win - The overlay window.
 * @param {{ x: number, y: number, width: number, height: number }} screenBounds - Target screen bounds.
 * @param {{ collabEnabled?: boolean }} [options] - Additional options.
 * @returns {void}
 */
function configurePlatform(win, screenBounds, options = {}) {
    const { x, y, width, height } = screenBounds;

    // When collab is enabled, exclude the overlay from screen capture so
    // annotations are shared via Excalidraw collab (transparent whiteboard).
    // When collab is disabled (default), include annotations in the capture
    // stream so viewers see them directly in the screenshare video.
    win.setContentProtection(Boolean(options.collabEnabled));

    if (process.platform === 'darwin') {
        app.dock.show();
        win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.setBounds({
            x: Math.floor(x),
            y: Math.floor(y),
            width: Math.floor(width),
            height: Math.floor(height)
        });
    } else {
        win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);

        // fullscreen is already set via the constructor's `fullscreen: !isMac`.
    }
}

/**
 * Registers the global keyboard shortcut for toggling click-through on the overlay.
 *
 * @param {BrowserWindow} win - The overlay window to send the toggle request to.
 * @returns {boolean} Whether the shortcut was registered (false if another app owns it).
 */
function registerShortcut(win) {
    const success = globalShortcut.register(SHORTCUT_TOGGLE_CLICK_THROUGH, () => {
        if (win && !win.isDestroyed()) {
            win.webContents.send(IPC_TOGGLE_CLICK_THROUGH);
        }
    });

    if (!success) {
        console.warn(
            `⚠️ Failed to register shortcut "${SHORTCUT_TOGGLE_CLICK_THROUGH}".`
            + ' Another application may have claimed it. Click-through toggle will not work.'
        );
    }

    return success;
}

/**
 * Clears the CORS-relaxation header filter from the shared overlay session.
 * `onHeadersReceived` is a per-session singleton on the persistent `persist:overlay`
 * session, so wireEvents re-registers it (with a fresh collab origin) on every open;
 * clearing it on close stops a stale closure from lingering between sessions.
 *
 * @returns {void}
 */
function clearOverlaySessionCors() {
    try {
        session.fromPartition(OVERLAY_PARTITION).webRequest.onHeadersReceived(null);
    } catch (e) {
        console.warn('⚠️ Failed to clear overlay CORS filter:', e);
    }
}

/**
 * Wires lifecycle event listeners on the overlay window (load, failure, close, cleanup).
 *
 * @param {BrowserWindow} win - The overlay window.
 * @param {string} [collabServerUrl] - The collab server URL (for scoped CORS injection).
 * @param {Object} callbacks - Lifecycle callbacks.
 * @param {Function} callbacks.onClosed - Called when the window is closed externally.
 * @param {Function} callbacks.onFailure - Called with a close-reason when the overlay
 *   fails to load, crashes, or hangs — the caller tears it down and notifies the renderer.
 * @param {Function} [callbacks.onShown] - Called once the overlay has loaded and is shown.
 * @returns {Function} A cancel function that clears the load/grace timers immediately.
 */
function wireEvents(win, collabServerUrl, { onClosed, onFailure, onShown }) {
    // Allow cross-origin requests to the collab server (fonts, WebSocket handshake)
    // without disabling webSecurity globally. Scoped to the collab server origin
    // so other endpoints (auth, analytics) keep their own CORS policies.
    let collabOrigin = null;

    try {
        if (collabServerUrl) {
            collabOrigin = new URL(collabServerUrl).origin;
        }
    } catch { /* invalid URL — skip CORS injection */ }

    if (collabOrigin) {
        win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
            const headers = { ...details.responseHeaders };

            // Match on origin + '/' so a look-alike host (e.g.
            // https://collab.example.com.evil/) can't prefix-match the real
            // origin. Real request URLs always carry a path, so the trailing
            // slash never excludes a legitimate one.
            //
            // SCOPE: this relaxes ACAO for EVERY collab-origin response that
            // lacks one — not only the font / WebSocket-handshake paths the
            // collab protocol actually needs. Accepted because (a) it is confined
            // to the isolated persist:overlay session (the main window's session
            // is untouched), and (b) the collab origin is our own trusted infra.
            // Path-targeting the exact endpoints is impractical (handshake/font
            // paths aren't stable across versions), so we scope by origin within
            // this session. If the collab protocol ever sends custom request
            // headers, add them to Access-Control-Allow-Headers below.
            if (details.url.startsWith(`${collabOrigin}/`)) {
                const hasACHeader = Object.keys(headers)
                    .some(k => k.toLowerCase() === 'access-control-allow-origin');

                if (!hasACHeader) {
                    // Echo the overlay PAGE's own origin (the cross-origin
                    // requester) rather than a wildcard — least-privilege, and the
                    // value the browser actually requires: ACAO must match the
                    // request's Origin (the overlay page), NOT the collab server's
                    // origin. Falls back to '*' only if the page URL can't be read
                    // (e.g. the window was torn down mid-response).
                    let allowOrigin = '*';

                    try {
                        allowOrigin = new URL(win.webContents.getURL()).origin;
                    } catch { /* keep the wildcard fallback */ }

                    headers['Access-Control-Allow-Origin'] = [ allowOrigin ];

                    // Only the headers the collab requests actually send, rather
                    // than a blanket '*', to keep the relaxation minimal.
                    headers['Access-Control-Allow-Headers'] = [ 'Content-Type', 'Authorization' ];
                }
            }
            callback({ responseHeaders: headers });
        });
    }

    // ── Failure plumbing ──
    // A wedged load leaves the window invisible (show is deferred to
    // did-finish-load) and the renderer stuck "annotating"; a crash/hang leaves
    // an orphaned window that blocks re-open. Each failure path routes through a
    // single guarded `fail()` so the caller can tear down + notify exactly once.
    let loadWatchdog = null;
    let graceTimer = null;
    let tornDown = false;

    // Forward-declared so fail() can strip it on a failed load; assigned below
    // once initialLoadComplete exists.
    let onDidStartLoading = null;

    const clearTimers = () => {
        if (loadWatchdog) {
            clearTimeout(loadWatchdog);
            loadWatchdog = null;
        }
        if (graceTimer) {
            clearTimeout(graceTimer);
            graceTimer = null;
        }
    };

    const fail = reason => {
        // Also bail if the window is already gone — e.g. a watchdog still pending
        // after a manual close (which strips the 'closed' timer-clearing bridge).
        if (tornDown || !win || win.isDestroyed()) {
            clearTimers();

            return;
        }
        tornDown = true;
        clearTimers();

        // dom-ready (which normally removes this) may never fire on a failed
        // load, so strip the did-start-loading listener here too.
        win.webContents.removeListener('did-start-loading', onDidStartLoading);
        onFailure?.(reason);
    };

    // (Re)arm the load watchdog. Called once up front and again on every
    // `did-start-loading` so an actively-progressing remote load keeps getting a
    // fresh window instead of a single absolute deadline. dom-ready stops the
    // re-arming for good. No-op once we've torn down.
    const armWatchdog = () => {
        if (tornDown) {
            return;
        }
        if (loadWatchdog) {
            clearTimeout(loadWatchdog);
        }
        loadWatchdog = setTimeout(() => {
            console.warn(`⚠️ Overlay load made no progress for ${LOAD_WATCHDOG_MS}ms.`);
            fail(CLOSE_REASON_LOAD_FAILED);
        }, LOAD_WATCHDOG_MS);
    };

    armWatchdog();

    // Reveal the overlay once it has loaded. Hoisted so BOTH dom-ready and
    // did-finish-load can call it; the isVisible() guard makes it idempotent so
    // whichever fires first wins and the other no-ops.
    const showOverlay = () => {
        if (win && !win.isDestroyed() && !win.isVisible()) {
            win.show();
            win.focus();
            onShown?.();
        }
    };

    // Reset the watchdog whenever the INITIAL load (re)starts — a redirect,
    // retry, or sub-frame navigation all count as progress, so the slow-network
    // case isn't killed mid-flight. Gated on initialLoadComplete and removed in
    // dom-ready: without that, a post-load did-start-loading (in-app navigation,
    // sub-frame fetch, redirect) would re-arm the watchdog AFTER dom-ready had
    // already cleared it — and since dom-ready is once(), nothing would clear the
    // new timer, tearing a healthy overlay down 45s later.
    let initialLoadComplete = false;

    onDidStartLoading = () => {
        if (!initialLoadComplete) {
            armWatchdog();
        }
    };

    win.webContents.on('did-start-loading', onDidStartLoading);

    // dom-ready is the reliable "the page loaded" signal. We can't rely on
    // did-finish-load (below): it waits for the `load` event, which never fires
    // while the page holds long-lived connections (Vite HMR in dev, the
    // Excalidraw collab socket), so the watchdog would tear down a healthy
    // overlay. dom-ready fires once the DOM is parsed, regardless — so it both
    // clears the watchdog and owns the show() fallback for exactly that
    // did-finish-load-never-fires case (otherwise the overlay loads but stays
    // invisible — the very bug this lifecycle hardening targets).
    win.webContents.once('dom-ready', () => {
        initialLoadComplete = true;
        win.webContents.removeListener('did-start-loading', onDidStartLoading);
        if (loadWatchdog) {
            clearTimeout(loadWatchdog);
            loadWatchdog = null;
        }
        showOverlay();
    });

    win.webContents.on('did-finish-load', () => {
        // Only the load watchdog — an unresponsive renderer can't reach
        // did-finish-load, so the grace timer is never live here; clearing it too
        // would be misleading.
        if (loadWatchdog) {
            clearTimeout(loadWatchdog);
            loadWatchdog = null;
        }
        showOverlay();
    });

    // Main-frame load error. Ignore -3 (ABORTED) — that fires on our own
    // destroy() and on benign in-page navigations, not on a real load failure.
    // Also ignore once the initial load has completed (dom-ready set
    // initialLoadComplete): the overlay hosts a remote SPA shell whose
    // client-side route changes / redirect chains can fail AFTER it's up, and
    // tearing down a healthy, visible overlay for an in-page navigation failure
    // would be wrong — mirrors the onDidStartLoading guard.
    // eslint-disable-next-line max-params -- Electron's did-fail-load passes a fixed positional signature
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (!isMainFrame || errorCode === -3 || initialLoadComplete) {
            return;
        }
        console.warn(`⚠️ Overlay did-fail-load (${errorCode}): ${errorDescription}`);
        fail(CLOSE_REASON_LOAD_FAILED);
    });

    // Render process crashed / was killed / OOM. 'clean-exit' is the normal
    // teardown path (our destroy) — not a crash.
    win.webContents.on('render-process-gone', (_event, details) => {
        if (details?.reason === 'clean-exit') {
            return;
        }
        console.warn(`⚠️ Overlay render process gone: ${details?.reason}`);
        fail(CLOSE_REASON_CRASHED);
    });

    // Hung renderer. Give it a grace window — a transient freeze during init
    // usually clears with 'responsive'; a sustained one blocks the whole screen.
    win.webContents.on('unresponsive', () => {
        if (graceTimer || tornDown) {
            return;
        }
        console.warn('⚠️ Overlay renderer unresponsive — starting grace timer.');
        graceTimer = setTimeout(() => {
            graceTimer = null;
            console.warn('⚠️ Overlay renderer still unresponsive — tearing down.');
            fail(CLOSE_REASON_UNRESPONSIVE);
        }, UNRESPONSIVE_GRACE_MS);
    });

    // Cancel a pending teardown when the renderer recovers within the grace
    // window. NOTE: a vanishingly narrow race remains — if 'responsive' arrives
    // AFTER the grace timer already fired fail() (graceTimer is null by then) but
    // BEFORE the caller's async teardown runs, this handler can't cancel it.
    // Accepted: the full UNRESPONSIVE_GRACE_MS has elapsed by that point, so the
    // renderer was genuinely wedged, and a torn-down overlay is recoverable by
    // re-opening.
    win.webContents.on('responsive', () => {
        if (graceTimer) {
            clearTimeout(graceTimer);
            graceTimer = null;
        }
    });

    // External close (OS close, app quit). Clear our timers so they can't fire
    // against a gone window, then run the caller's cleanup.
    win.on('closed', () => {
        clearTimers();
        onClosed?.();
    });

    // Hand the caller a way to flush the timers immediately. The manual-close
    // path strips this window's 'closed' listener (to avoid a double-notify),
    // which would otherwise leave loadWatchdog/graceTimer pending in this closure
    // until they fire and fail() guards them out.
    return clearTimers;
}

module.exports = {
    createOverlayWindow,
    configurePlatform,
    registerShortcut,
    clearOverlaySessionCors,
    wireEvents,
    overlayWindows
};
