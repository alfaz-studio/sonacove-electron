/**
 * Constants for the screenshare controls bar — sizing and IPC channels.
 *
 * The bar has two states: a collapsed "sharing strip" (always visible) and an
 * expanded state that reveals the meeting controls above the strip on hover.
 * The window resizes between the two, anchored at its bottom-centre so the strip
 * stays put while the controls grow upward.
 */

// ── Sizing ───────────────────────────────────────────────────────────────────

// The window width is CONSTANT (only the height changes on hover) so resizing
// never shifts the window's x — that shift caused a horizontal "glitch" — and so
// the strip's drop shadow isn't clipped. Wide enough to also fit the More menu
// opening to the right of the controls.
const WINDOW_W = 980;

// Collapsed height: the sharing strip + the hover caret beneath it. (The controls
// are translated above the window top, clipped.)
const COLLAPSED_H = 84;

// Expanded height: room for the controls bar that slides in above the strip,
// plus the controls' drop shadow below.
const EXPANDED_H = 184;

// Gap from the top edge of the work area when first opened.
const TOP_MARGIN = 18;

// ── IPC channels ─────────────────────────────────────────────────────────────

const IPC = {
    // main → renderer
    // (none needed in Phase 1 — static bar)

    // renderer → main (sent from controls-bar.html via the preload bridge)
    HOVER: 'cb-hover', // payload: boolean — expand (true) / collapse (false)
    START_DRAG: 'cb-start-window-drag',
    STOP_DRAG: 'cb-stop-window-drag',
    STOP_SHARE: 'cb-stop-share' // Phase 2 — currently a no-op listener
};

module.exports = {
    WINDOW_W,
    COLLAPSED_H,
    EXPANDED_H,
    TOP_MARGIN,
    IPC
};
