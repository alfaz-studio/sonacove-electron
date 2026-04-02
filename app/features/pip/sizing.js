/**
 * Pure sizing/positioning functions for the participant PiP panel.
 * No side effects, no module state — all inputs are parameters.
 */

const {
    TILE_W, H_TILE_H, V_TILE_H, TILE_GAP, TILE_PAD,
    HEADER_H, BORDER, MARGIN,
} = require('./constants');

/**
 * Computes the BrowserWindow dimensions for a given participant count and
 * orientation.  Accounts for tile container padding, gaps, and panel border.
 *
 * @param {number} count - Number of participant tiles.
 * @param {string} orientation - 'horizontal' or 'vertical'.
 * @returns {{ width: number, height: number }}
 */
function computeWindowSize(count, orientation) {
    const n = Math.max(1, count);
    const tileH = orientation === 'horizontal' ? H_TILE_H : V_TILE_H;
    const pad2 = TILE_PAD * 2;
    const bdr2 = BORDER * 2;

    if (orientation === 'horizontal') {
        return {
            width: n * TILE_W + (n - 1) * TILE_GAP + pad2 + bdr2,
            height: tileH + pad2 + HEADER_H + bdr2,
        };
    }

    return {
        width: TILE_W + pad2 + bdr2,
        height: n * tileH + (n - 1) * TILE_GAP + pad2 + HEADER_H + bdr2,
    };
}

/**
 * Computes the (x, y) position for the panel relative to a display work area.
 *
 * @param {number} count - Number of participant tiles.
 * @param {string} orientation - 'horizontal' or 'vertical'.
 * @param {Electron.Rectangle} workArea - The display work area.
 * @returns {{ x: number, y: number }}
 */
function getWindowPosition(count, orientation, workArea) {
    const { width: W, height: H } = computeWindowSize(count, orientation);

    if (orientation === 'horizontal') {
        return {
            x: workArea.x + workArea.width - W - MARGIN,
            y: workArea.y + workArea.height - H - MARGIN,
        };
    }

    return {
        x: workArea.x + workArea.width - W - MARGIN,
        y: workArea.y + Math.round((workArea.height - H) / 2),
    };
}

module.exports = {
    computeWindowSize,
    getWindowPosition,
};
