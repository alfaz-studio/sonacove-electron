/**
 * Pure sizing/positioning functions for the participant PiP panel.
 * No side effects, no module state — all inputs are parameters.
 *
 * Tiles are sized per-video in the panel (a portrait video gets a tall/narrow
 * tile, a landscape video a wide one — see participant-panel.html). The cross
 * axis is fixed per orientation (tile height in horizontal, tile width in
 * vertical); only the main axis varies. So the window's main-axis size is the
 * panel-reported sum of the visible tiles' main-axis extents, and the cross
 * axis stays constant. windowFromMainExtent() is the source of truth for the
 * chrome around that extent; computeWindowSize() is the uniform-tile estimate
 * used before the panel has reported (and for resize snapping).
 */

const {
    TILE_W, H_TILE_H, V_TILE_H, TILE_GAP, TILE_PAD,
    HEADER_H, BORDER, MARGIN, WINDOW_PAD,
} = require('./constants');

/**
 * Panel chrome along the main axis (paddings, borders, the transparent shadow
 * pad, plus the header which always sits on the height). Single source so the
 * window sizing here and the length-budget cap in participant-window can't drift.
 *
 * @param {string} orientation - 'horizontal' or 'vertical'.
 * @returns {number}
 */
function chromeMain(orientation) {
    return (TILE_PAD * 2) + (BORDER * 2) + (WINDOW_PAD * 2)
        + (orientation === 'vertical' ? HEADER_H : 0);
}

/**
 * Wraps the tiles' main-axis extent (sum of visible tile main sizes + the gaps
 * between them) in the panel chrome to produce the BrowserWindow dimensions.
 * The cross axis is fixed by the orientation.
 *
 * @param {number} mainExtent - Tiles' main-axis extent in px (tiles + gaps).
 * @param {string} orientation - 'horizontal' or 'vertical'.
 * @returns {{ width: number, height: number }}
 */
function windowFromMainExtent(mainExtent, orientation) {
    const pad2 = TILE_PAD * 2;
    const bdr2 = BORDER * 2;
    const win2 = WINDOW_PAD * 2;
    const main = Math.max(0, Math.round(mainExtent)) + chromeMain(orientation);

    if (orientation === 'horizontal') {
        return { width: main, height: H_TILE_H + pad2 + HEADER_H + bdr2 + win2 };
    }

    return { width: TILE_W + pad2 + bdr2 + win2, height: main };
}

/**
 * Uniform main-axis extent for `count` tiles that are each `tileMain` px along
 * the main axis, plus the inter-tile gaps.
 *
 * @param {number} count - Number of tiles.
 * @param {number} tileMain - Per-tile main-axis size in px.
 * @returns {number}
 */
function uniformMainExtent(count, tileMain) {
    const n = Math.max(1, count);

    return (n * tileMain) + ((n - 1) * TILE_GAP);
}

/**
 * Uniform-tile window estimate. Used before the panel has reported its real
 * content extent (initial open, orientation toggle) and by the resize engine
 * for snapping. `tileMain` defaults to the legacy fixed tile size so callers
 * that don't track a per-video average keep the old behaviour.
 *
 * @param {number} count - Number of participant tiles.
 * @param {string} orientation - 'horizontal' or 'vertical'.
 * @param {number} [tileMain] - Effective per-tile main-axis size in px.
 * @returns {{ width: number, height: number }}
 */
function computeWindowSize(count, orientation, tileMain) {
    const tm = tileMain || (orientation === 'horizontal' ? TILE_W : V_TILE_H);

    return windowFromMainExtent(uniformMainExtent(count, tm), orientation);
}

/**
 * Computes the (x, y) position for a window of the given size relative to a
 * display work area. Horizontal anchors bottom-right; vertical anchors
 * right-centre. W/H include WINDOW_PAD on each side; offsetting the window out
 * by that much keeps the *visible* panel anchored MARGIN from the screen edge.
 *
 * @param {number} W - Window width.
 * @param {number} H - Window height.
 * @param {string} orientation - 'horizontal' or 'vertical'.
 * @param {Electron.Rectangle} workArea - The display work area.
 * @returns {{ x: number, y: number }}
 */
function getWindowPosition(W, H, orientation, workArea) {
    if (orientation === 'horizontal') {
        return {
            x: workArea.x + workArea.width - W - MARGIN + WINDOW_PAD,
            y: workArea.y + workArea.height - H - MARGIN + WINDOW_PAD,
        };
    }

    return {
        x: workArea.x + workArea.width - W - MARGIN + WINDOW_PAD,
        y: workArea.y + Math.round((workArea.height - H) / 2),
    };
}

module.exports = {
    chromeMain,
    windowFromMainExtent,
    uniformMainExtent,
    computeWindowSize,
    getWindowPosition,
};
