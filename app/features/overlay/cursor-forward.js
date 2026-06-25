/**
 * Synthetic mouse-move forwarder for the annotation overlay.
 *
 * The overlay is a transparent, always-on-top, click-through window. Its meet
 * renderer (`useClickThrough`) decides per-frame whether the cursor is over the
 * toolbar — and the window should "solidify" (`setIgnoreMouseEvents(false)`) to
 * catch the click — by listening for `mousemove`. But on Windows an UNFOCUSED,
 * click-through (`setIgnoreMouseEvents(true)`) window receives ~no `mousemove`
 * in its renderer: Electron's `{ forward: true }` only reliably delivers moves
 * to the focused window, and the overlay is never the focused window during a
 * screenshare (the meeting / shared app holds focus). So the hover is never
 * detected and every click — toolbar included — falls through. (Draw mode is
 * affected the same way: it solidifies the whole window on `mousemove`, so with
 * no moves arriving, drawing breaks too.)
 *
 * This watcher polls the OS cursor and injects a synthetic `mouseMove` straight
 * into the overlay's webContents, so the renderer's hover detection runs
 * regardless of focus, occlusion, or content-protection (collab on/off) state.
 * Injection is gated on the overlay's click-through state: once the renderer
 * solidifies the window the OS delivers real moves to it (a window under the
 * cursor gets `mousemove` whether or not it's focused), so we stop injecting to
 * avoid doubling input on the drawing path. Inject-only — real clicks
 * (mousedown/up) always flow normally.
 */

const { screen } = require('electron');

/** Cursor poll interval (ms). ~60fps — matches the renderer's throttled handler. */
const CURSOR_POLL_MS = 16;

/**
 * Start forwarding the OS cursor into the overlay as synthetic mouse-moves.
 * Returns a detach function that stops the loop — call it on window close.
 *
 * @param {Object} opts - Options.
 * @param {() => (Electron.BrowserWindow|null)} opts.getWindow - Current overlay window (null once gone).
 * @param {() => boolean} opts.isClickThrough - Whether the overlay currently ignores
 *   mouse events (click-through). Moves are injected only while this returns true.
 * @returns {() => void} detach - Stops the poll loop.
 */
function attachCursorForward({ getWindow, isClickThrough }) {
    // The unfocused-renderer forwarding gap is Windows-specific: only there does
    // setIgnoreMouseEvents(true, { forward: true }) fail to deliver mousemove to an
    // unfocused window. On macOS the overlay still receives real OS moves while
    // click-through, so synthetic injection is redundant — skip the poll entirely.
    if (process.platform !== 'win32') {
        return () => {};
    }

    const timer = setInterval(() => {
        const win = getWindow();

        if (!win || win.isDestroyed()) {
            return;
        }

        // Inject only while click-through. Once solidified the window gets real OS
        // moves (a window under the cursor receives them focused or not), so
        // injecting would double the input on the drawing path. No position-dedup:
        // re-evaluating every tick lets the renderer react to UI that changes under
        // a still cursor (e.g. the toolbar collapsing to its pill), which a dedup
        // would freeze until the next real move.
        if (!isClickThrough()) {
            return;
        }

        // getContentBounds() and sendInputEvent() both touch the window, which can
        // be torn down mid-tick — wrap both so a stray tick can't throw.
        try {
            const { x: cx, y: cy } = screen.getCursorScreenPoint();
            const { x: bx, y: by, width, height } = win.getContentBounds();

            // Both points are in Electron's global DIP space, so the subtraction gives
            // window-content DIPs regardless of display scale; reading getContentBounds
            // each tick keeps it correct across a mid-session display/fullscreen change.
            // Rounded — sendInputEvent expects integer coordinates.
            const x = Math.round(cx - bx);
            const y = Math.round(cy - by);

            // Cursor is on another display (outside the overlay) — nothing to detect.
            if (x < 0 || y < 0 || x >= width || y >= height) {
                return;
            }

            win.webContents.sendInputEvent({
                type: 'mouseMove',
                x,
                y
            });
        } catch {
            // Window/webContents torn down mid-tick — the next tick's getWindow() guard recovers.
        }
    }, CURSOR_POLL_MS);

    return function detach() {
        clearInterval(timer);
    };
}

module.exports = {
    attachCursorForward
};
