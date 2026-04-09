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
const TILE_GAP = 6;
const TILE_PAD = 6;   // padding inside the tiles container (each side)

// ── Panel chrome ─────────────────────────────────────────────────────────────

const HEADER_H = 32;  // control bar height
const BORDER = 1;     // panel border width (each side)
const MARGIN = 20;    // gap between panel and screen edges

// ── Pill ─────────────────────────────────────────────────────────────────────

const PILL_SIZE = 56;

// ── IPC channels ─────────────────────────────────────────────────────────────

const IPC = {
    // Renderer → main (sent from jitsi-meet via sonacove IPC bridge)
    SCREENSHARE_START: 'pip-screenshare-start',
    SCREENSHARE_STOP: 'pip-screenshare-stop',
    SCREENSHARE_FRAME: 'pip-screenshare-frame',
    PARTICIPANTS_UPDATE: 'pp-participants-update',
    RESIZE: 'pip-resize',

    // Panel renderer → main (sent from participant-panel.html via preload)
    PIN_STATE_CHANGED: 'pp-pin-state-changed',
    START_DRAG: 'pp-start-window-drag',
    STOP_DRAG: 'pp-stop-window-drag',
    TOGGLE_ORIENTATION: 'pip-toggle-orientation',
    CLOSE_REQUEST: 'pp-close-request',
    REOPEN_REQUEST: 'pp-reopen-request',
    TOGGLE_AUDIO: 'pp-toggle-audio',
    TOGGLE_VIDEO: 'pp-toggle-video',
    OPEN_CHAT: 'pp-open-chat',
    FOCUS_MAIN: 'pp-focus-main',
    END_MEETING: 'pp-end-meeting',
    START_EDGE_RESIZE: 'pp-start-edge-resize',
    STOP_EDGE_RESIZE: 'pp-stop-edge-resize',

    // Main → panel renderer
    FRAME: 'pp-frame',
    ORIENTATION_CHANGED: 'pp-orientation-changed',
    VISIBLE_COUNT_CHANGED: 'pp-visible-count-changed',
    ENTER_PILL_MODE: 'pp-enter-pill-mode',
    ENTER_PANEL_MODE: 'pp-enter-panel-mode',

    // Main → jitsi-meet renderer
    PIN_STATE_CHANGED_RENDERER: 'pip-pin-state-changed',
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
    PILL_SIZE,
    IPC,
};
