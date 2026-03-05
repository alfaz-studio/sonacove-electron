/**
 * Generate an amber/gold color-shifted version of the Sonacove icon
 * for the staging launcher.
 *
 * Usage: node scripts/generate-icon.js
 *
 * Reads:  ../resources/icon.png  (blue Sonacove logo)
 * Writes: resources/icon.png     (amber/gold variant)
 */

const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'resources', 'icon.png');
const DEST = path.join(__dirname, '..', 'resources', 'icon.png');

/**
 * Convert RGB to HSL.
 */
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return [h * 360, s, l];
}

/**
 * Convert HSL to RGB.
 */
function hslToRgb(h, s, l) {
    h /= 360;
    let r, g, b;

    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

async function main() {
    const image = sharp(SRC);
    const { width, height, channels } = await image.metadata();

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
        if (a === 0) continue;

        // Skip near-white and near-black pixels (preserve them)
        const [h, s, l] = rgbToHsl(r, g, b);
        if (s < 0.1) continue; // Grayscale — leave as-is

        // Shift hue: blue (~200-240°) → amber (~35-45°)
        // Apply a ~190° rotation
        let newH = (h + 190) % 360;

        // Slightly boost saturation for warmer feel
        const newS = Math.min(s * 1.1, 1.0);

        const [nr, ng, nb] = hslToRgb(newH, newS, l);
        pixels[i] = nr;
        pixels[i + 1] = ng;
        pixels[i + 2] = nb;
        // Alpha unchanged
    }

    // electron-builder requires at least 512x512 for macOS; target 1024x1024
    const TARGET_SIZE = 1024;

    await sharp(pixels, {
        raw: { width: info.width, height: info.height, channels: 4 }
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
