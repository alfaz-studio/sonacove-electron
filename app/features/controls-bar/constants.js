/**
 * Constants for the screenshare controls bar — sizing and IPC channels.
 *
 * The bar has two states: a collapsed "sharing strip" (always visible) and an
 * expanded state that reveals the meeting controls above the strip on hover.
 * The window resizes between the two, anchored at its bottom-centre so the strip
 * stays put while the controls grow upward.
 */

// ── Sizing ───────────────────────────────────────────────────────────────────

// The "Thread" capsule is centred horizontally in a CONSTANT-width window and
// reveals its controls inline (CSS only) — the window never resizes its width,
// so it can't shift its x and flash. Wide enough for the fully-expanded capsule
// (mark + timer + 6 controls + Stop) with margin for its drop shadow.
const WINDOW_W = 560;

// Collapsed height: the capsule row + room below for the tooltip and the
// recording toast (which can be two lines + an action button). The capsule is
// top-anchored; the empty area is click-through (see controls-bar.js).
const COLLAPSED_H = 132;

// Expanded height: only used when the More menu opens — the window grows
// downward (top fixed) so the dropdown isn't clipped.
const EXPANDED_H = 240;

// Gap from the top edge of the work area when first opened.
const TOP_MARGIN = 18;

// ── IPC channels ─────────────────────────────────────────────────────────────

const IPC = {
    // main → controls-bar renderer
    // Conference start timestamp (epoch ms). The bar ticks its meeting timer
    // locally from this. Arrives on the cb-show payload (jitsi renderer) and is
    // cached + replayed to the bar by the main process (controls-bar-window.js).
    CONFERENCE_TIMESTAMP: 'cb-conference-timestamp',

    // renderer → main (sent from controls-bar.html via the preload bridge).
    // Note: cb-stop-share (Stop button) is handled in app/features/ipc.js.
    HOVER: 'cb-hover', // payload: boolean — expand (true) / collapse (false)
    START_DRAG: 'cb-start-window-drag',
    STOP_DRAG: 'cb-stop-window-drag'
};

module.exports = {
    WINDOW_W,
    COLLAPSED_H,
    EXPANDED_H,
    TOP_MARGIN,
    IPC
};
