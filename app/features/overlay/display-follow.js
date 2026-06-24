/**
 * Shared display-follow watcher for aux overlay windows (annotation overlay,
 * screenshare border, …). Subscribes to screen geometry changes for ONE display
 * and, for the window tracking it:
 *  - re-fits the window when that display's metrics change — coalesced with a
 *    trailing debounce so a burst of bounds+scaleFactor events settles to a
 *    single reposition (and, on Windows, a single fullscreen-toggle flicker);
 *  - tears the window down when that display is removed/unplugged.
 *
 * Each window keeps its OWN reposition + close behaviour (full bounds vs work
 * area, fullscreen-toggle vs plain setBounds) via callbacks — only the
 * subscribe / debounce / teardown plumbing is shared here.
 */

const { screen } = require('electron');

/** Trailing-debounce delay (ms) for coalescing display-metrics bursts. */
const METRICS_DEBOUNCE_MS = 200;

/**
 * Start following a display. Returns a detach function that removes the screen
 * listeners and clears any pending debounce — call it on window close.
 *
 * @param {Object} opts - Options.
 * @param {() => (Electron.BrowserWindow|null)} opts.getWindow - Current window (null once gone).
 * @param {() => (number|null|undefined)} opts.getDisplayId - id of the display to track.
 * @param {(display: Electron.Display) => void} opts.reposition - Re-fit to the (still-present) display.
 * @param {() => void} opts.onGone - Called when the tracked display is removed/unplugged.
 * @param {number} [opts.debounceMs] - Override the metrics debounce.
 * @returns {() => void} detach - Removes listeners + clears the pending debounce.
 */
function attachDisplayFollow({ getWindow, getDisplayId, reposition, onGone, debounceMs = METRICS_DEBOUNCE_MS }) {
    let metricsDebounceTimer = null;

    const clearTimer = () => {
        if (metricsDebounceTimer) {
            clearTimeout(metricsDebounceTimer);
            metricsDebounceTimer = null;
        }
    };

    const onDisplayRemoved = (_event, display) => {
        if (getWindow() && display?.id === getDisplayId()) {
            onGone();
        }
    };

    const onDisplayMetricsChanged = (_event, display, changedMetrics) => {
        if (!getWindow() || display?.id !== getDisplayId()) {
            return;
        }
        if (!changedMetrics?.includes('bounds') && !changedMetrics?.includes('scaleFactor')) {
            return;
        }

        clearTimer();
        metricsDebounceTimer = setTimeout(() => {
            metricsDebounceTimer = null;

            // The window may have been torn down during the debounce window.
            const win = getWindow();

            if (!win || win.isDestroyed()) {
                return;
            }

            const target = screen.getAllDisplays().find(d => d.id === getDisplayId());

            if (!target) {
                onGone();

                return;
            }
            reposition(target);
        }, debounceMs);
    };

    screen.on('display-removed', onDisplayRemoved);
    screen.on('display-metrics-changed', onDisplayMetricsChanged);

    return function detach() {
        screen.removeListener('display-removed', onDisplayRemoved);
        screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
        clearTimer();
    };
}

module.exports = {
    attachDisplayFollow,
    METRICS_DEBOUNCE_MS
};
