/**
 * Generate an amber/gold color-shifted version of the Sonacove icon
 * for the staging launcher.
 *
 * Usage: node scripts/generate-icon.js
 *
 * Reads:  ../resources/icon.png  (blue Sonacove logo)
 * Writes: resources/icon.png     (amber/gold variant)
 */

const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', '..', 'resources', 'icon.png');
const DEST = path.join(__dirname, '..', 'resources', 'icon.png');

/**
 * Convert an RGB color (0-255 channels) to HSL.
 * @param {number} r  Red channel (0-255)
 * @param {number} g  Green channel (0-255)
 * @param {number} b  Blue channel (0-255)
 * @returns {[number, number, number]} [hue (0-360), saturation (0-1), lightness (0-1)]
 */
function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;

    if (max !== min) {
        const d = max - min;

        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
        case rn:
            h = (((gn - bn) / d) + (gn < bn ? 6 : 0)) / 6;
            break;
        case gn:
            h = (((bn - rn) / d) + 2) / 6;
            break;
        case bn:
            h = (((rn - gn) / d) + 4) / 6;
            break;
        }
    }

    return [ h * 360, s, l ];
}

/**
 * Convert an HSL color to RGB.
 * @param {number} h  Hue (0-360)
 * @param {number} s  Saturation (0-1)
 * @param {number} l  Lightness (0-1)
 * @returns {[number, number, number]} [red, green, blue] each 0-255
 */
function hslToRgb(h, s, l) {
    const hn = h / 360;
    let b, g, r;

    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            let tt = t;

            if (tt < 0) {
                tt += 1;
            }
            if (tt > 1) {
                tt -= 1;
            }
            if (tt < 1 / 6) {
                return p + ((q - p) * 6 * tt);
            }
            if (tt < 1 / 2) {
                return q;
            }
            if (tt < 2 / 3) {
                return p + ((q - p) * ((2 / 3) - tt) * 6);
            }

            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : (l + s) - (l * s);
        const p = (2 * l) - q;

        r = hue2rgb(p, q, hn + (1 / 3));
        g = hue2rgb(p, q, hn);
        b = hue2rgb(p, q, hn - (1 / 3));
    }

    return [ Math.round(r * 255), Math.round(g * 255), Math.round(b * 255) ];
}

/**
 * Read the source icon, hue-shift its colored pixels to amber, upscale, and
 * write the result to DEST.
 * @returns {Promise<void>}
 */
async function main() {
    const image = sharp(SRC);

    // Get raw pixel data (RGBA)
    const { data, info } = await image
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const pixels = Buffer.from(data);

    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];

        // Skip fully transparent pixels
        if (a === 0) {
            continue;
        }

        // Skip near-white and near-black pixels (preserve them)
        const [ h, s, l ] = rgbToHsl(r, g, b);

        if (s < 0.1) {
            continue;
        } // Grayscale — leave as-is

        // Shift hue: blue (~200-240°) → amber (~35-45°)
        // Apply a ~190° rotation
        const newH = (h + 190) % 360;

        // Slightly boost saturation for warmer feel
        const newS = Math.min(s * 1.1, 1.0);

        const [ nr, ng, nb ] = hslToRgb(newH, newS, l);

        pixels[i] = nr;
        pixels[i + 1] = ng;
        pixels[i + 2] = nb;

        // Alpha unchanged
    }

    // electron-builder requires at least 512x512 for macOS; target 1024x1024
    const TARGET_SIZE = 1024;

    await sharp(pixels, {
        raw: { width: info.width,
            height: info.height,
            channels: 4 }
    })
        .resize(TARGET_SIZE, TARGET_SIZE, { kernel: 'lanczos3' })
        .png()
        .toFile(DEST);

    console.log(`✓ Generated amber icon: ${DEST} (${TARGET_SIZE}×${TARGET_SIZE})`);
}

main().catch(err => {
    console.error('Failed to generate icon:', err);
    process.exit(1);
});
