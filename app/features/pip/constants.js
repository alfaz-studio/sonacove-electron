/**
 * Constants for the participant PiP panel — sizing, layout, and IPC channels.
 *
 * Tile dimensions mirror ParticipantPiPCanvas.tsx in jitsi-meet so the
 * Electron window exactly fits the tiles rendered in the panel HTML.
 */

// ── Tile sizing ──────────────────────────────────────────────────────────────

const TILE_W = 250;   // tile width — same for both orientations
const H_TILE_H = 130; // tile height in horizontal mode (landscape)
const V_TILE_H = 160; // tile height in vertical mode (squarish)
const TILE_GAP = 8;
const TILE_PAD = 8;   // padding inside the tiles container (each side)

// ── Panel chrome ─────────────────────────────────────────────────────────────

const HEADER_H = 32;  // control bar height
const BORDER = 1;     // panel border width (each side)
const MARGIN = 20;    // gap between panel and screen edges

// Transparent padding the window carries around the visible panel so the panel's
// rounded CSS drop-shadow has room to render instead of being clipped to the
// window rectangle (which, with the native window shadow, looked sharp-cornered).
// The panel is inset by this much via `body { padding }`.
// ⚠ Mirrored as the `body { padding }` literal in participant-panel.css (the
//   sandboxed panel can't import this module) — update both together.
const WINDOW_PAD = 18;

// ── Pill ─────────────────────────────────────────────────────────────────────

// Larger than the visible 60px pill (which is centred in it via .pill-overlay)
// so the pill's drop shadow and unread badge have transparent room and don't
// clip against the window edge. The extra padding also acts as the screen-edge
// inset (see pill.js — no MARGIN is subtracted for the pill).
const PILL_SIZE = 110;

// Extra transparent headroom ADDED ABOVE the pill window so the "Drag to move"
// hover hint (which floats ~40px above the pill) isn't clipped by the window
// bounds. The window grows upward by this much (height += it, y -= it) while the
// visible pill stays pinned to the same on-screen position (see pill.js + the
// .pill-overlay flex-end anchoring in participant-panel.css).
// ⚠ Mirrored as the `.pill-overlay { padding-bottom }` reasoning in the CSS.
const PILL_HINT_HEADROOM = 46;

// ── Spotlight card (renderer-driven sizing) ─────────────────────────────────
// The Spotlight panel is a fixed-width card; the renderer measures its content
// per layout and requests the exact window size via SET_SIZE. CARD_H_DEFAULT is
// just the initial guess before the renderer's first measure lands.
const CARD_W = 320;
const CARD_H_DEFAULT = 331;

// ── Spotlight ──────────────────────────────────────────────────────────────
// Feature flag: show live video in the filmstrip thumbnails. Off for now —
// the filmstrip shows avatars only; live video is reserved for the stage
// tile(s). Flipping this on later also widens the on-stage set reported to
// jitsi to include filmstrip-visible participants (cap to viewport then).
const FILMSTRIP_VIDEO = false;

// ── IPC channels ─────────────────────────────────────────────────────────────

const IPC = {
    // Renderer → main (sent from jitsi-meet via sonacove IPC bridge)
    SCREENSHARE_START: 'pip-screenshare-start',
    SCREENSHARE_STOP: 'pip-screenshare-stop',
    SCREENSHARE_FRAME: 'pip-screenshare-frame',
    PARTICIPANTS_UPDATE: 'pp-participants-update',
    RESIZE: 'pip-resize',

    // Panel renderer → main (sent from participant-panel.html via preload)
    CONTENT_SIZE: 'pp-content-size',
    PIN_STATE_CHANGED: 'pp-pin-state-changed',
    STAGE_CHANGED: 'pp-stage-changed',
    START_DRAG: 'pp-start-window-drag',
    STOP_DRAG: 'pp-stop-window-drag',
    TOGGLE_ORIENTATION: 'pip-toggle-orientation',
    CLOSE_REQUEST: 'pp-close-request',
    REOPEN_REQUEST: 'pp-reopen-request',
    TOGGLE_AUDIO: 'pp-toggle-audio',
    TOGGLE_VIDEO: 'pp-toggle-video',
    OPEN_CHAT: 'pp-open-chat',
    END_MEETING: 'pp-end-meeting',
    START_EDGE_RESIZE: 'pp-start-edge-resize',
    STOP_EDGE_RESIZE: 'pp-stop-edge-resize',

    // Spotlight: renderer-driven window size + persisted layout/auto prefs.
    SET_SIZE: 'pp-set-size',
    SAVE_SETTINGS: 'pp-save-settings',

    // Renderer → main → panel renderer (host theme tokens for live recolour)
    THEME_UPDATE: 'pp-theme-update',

    // Main → panel renderer
    FRAME: 'pp-frame',
    SETTINGS: 'pp-settings',
    ORIENTATION_CHANGED: 'pp-orientation-changed',
    VISIBLE_COUNT_CHANGED: 'pp-visible-count-changed',
    ENTER_PILL_MODE: 'pp-enter-pill-mode',
    ENTER_PANEL_MODE: 'pp-enter-panel-mode',

    // Main → jitsi-meet renderer
    PIN_STATE_CHANGED_RENDERER: 'pip-pin-state-changed',
    STAGE_CHANGED_RENDERER: 'pip-stage-changed',
    PANEL_CLOSED: 'pip-panel-closed',
    PANEL_REOPENED: 'pip-panel-reopened',
    ORIENTATION_CHANGED_RENDERER: 'pip-orientation-changed',
};

module.exports = {
    TILE_W,
    H_TILE_H,
    V_TILE_H,
    TILE_GAP,
    TILE_PAD,
    HEADER_H,
    BORDER,
    MARGIN,
    WINDOW_PAD,
    PILL_SIZE,
    PILL_HINT_HEADROOM,
    CARD_W,
    CARD_H_DEFAULT,
    FILMSTRIP_VIDEO,
    IPC,
};
