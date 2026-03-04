/**
 * Generate a .ico file from the staging icon PNG.
 * Creates a multi-size ICO with 16, 32, 48, 64, 128, 256 px sizes.
 *
 * Usage: node scripts/generate-ico.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '..', 'resources', 'icon.png');
const DEST = path.join(__dirname, '..', 'resources', 'icon.ico');

const SIZES = [16, 32, 48, 64, 128, 256];

async function createIco() {
    const pngBuffers = [];

    for (const size of SIZES) {
        const buf = await sharp(SRC)
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        pngBuffers.push({ size, data: buf });
    }

    // ICO file format
    const numImages = pngBuffers.length;

    // Header: 6 bytes
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);       // Reserved
    header.writeUInt16LE(1, 2);       // Type: 1 = ICO
    header.writeUInt16LE(numImages, 4); // Number of images

    // Directory entries: 16 bytes each
    const dirSize = numImages * 16;
    const directory = Buffer.alloc(dirSize);

    let dataOffset = 6 + dirSize; // After header + directory

    for (let i = 0; i < numImages; i++) {
        const { size, data } = pngBuffers[i];
        const offset = i * 16;

        directory.writeUInt8(size >= 256 ? 0 : size, offset);     // Width (0 = 256)
        directory.writeUInt8(size >= 256 ? 0 : size, offset + 1); // Height (0 = 256)
        directory.writeUInt8(0, offset + 2);     // Color palette
        directory.writeUInt8(0, offset + 3);     // Reserved
        directory.writeUInt16LE(1, offset + 4);  // Color planes
        directory.writeUInt16LE(32, offset + 6); // Bits per pixel
        directory.writeUInt32LE(data.length, offset + 8);  // Data size
        directory.writeUInt32LE(dataOffset, offset + 12);  // Data offset

        dataOffset += data.length;
    }

    // Combine all parts
    const parts = [header, directory, ...pngBuffers.map(p => p.data)];
    const ico = Buffer.concat(parts);

    fs.writeFileSync(DEST, ico);
    console.log(`✓ Generated ICO: ${DEST} (${numImages} sizes: ${SIZES.join(', ')}px)`);
}

createIco().catch(err => {
    console.error('Failed to generate ICO:', err);
    process.exit(1);
});
