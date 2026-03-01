/**
 * Generates simple PNG icons for the CoWatch extension.
 * Run: node icons/generate.js
 *
 * Creates minimal valid PNG files with a purple "CW" badge.
 * No external dependencies required.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function createPNG(size) {
  const pixels = Buffer.alloc(size * size * 4); // RGBA

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= r) {
        // Gradient: #7c3aed -> #a78bfa
        const t = (dy + r) / (2 * r);
        pixels[idx] = Math.round(124 + (167 - 124) * t);     // R
        pixels[idx + 1] = Math.round(58 + (139 - 58) * t);   // G
        pixels[idx + 2] = Math.round(237 + (250 - 237) * t); // B
        pixels[idx + 3] = 255;                                 // A

        // Draw "CW" text for larger icons
        if (size >= 48) {
          const textSize = size >= 128 ? 3 : size >= 48 ? 2 : 1;
          if (drawChar(x, y, size, textSize)) {
            pixels[idx] = 255;
            pixels[idx + 1] = 255;
            pixels[idx + 2] = 255;
            pixels[idx + 3] = 255;
          }
        } else {
          // For 16px just draw a simple play triangle
          const tx = x - size * 0.35;
          const ty = y - size * 0.25;
          const th = size * 0.5;
          const tw = size * 0.4;
          if (tx >= 0 && tx <= tw && ty >= 0 && ty <= th) {
            const edge = (ty / th) * tw;
            const edge2 = ((th - ty) / th) * tw;
            const limit = Math.min(edge, edge2);
            if (tx <= limit) {
              pixels[idx] = 255;
              pixels[idx + 1] = 255;
              pixels[idx + 2] = 255;
            }
          }
        }
      } else {
        pixels[idx + 3] = 0; // transparent
      }
    }
  }

  return encodePNG(size, size, pixels);
}

// Simple bitmap font for "CW"
const FONT = {
  C: [
    "01110",
    "10001",
    "10000",
    "10000",
    "10001",
    "01110",
  ],
  W: [
    "10001",
    "10001",
    "10101",
    "10101",
    "11011",
    "10001",
  ],
};

function drawChar(px, py, size, scale) {
  const letterW = 5 * scale;
  const letterH = 6 * scale;
  const gap = 1 * scale;
  const totalW = letterW * 2 + gap;
  const startX = Math.round((size - totalW) / 2);
  const startY = Math.round((size - letterH) / 2);

  // Check 'C'
  const cx = px - startX;
  const cy = py - startY;
  if (cx >= 0 && cx < letterW && cy >= 0 && cy < letterH) {
    const row = Math.floor(cy / scale);
    const col = Math.floor(cx / scale);
    if (FONT.C[row] && FONT.C[row][col] === "1") return true;
  }

  // Check 'W'
  const wx = px - startX - letterW - gap;
  const wy = py - startY;
  if (wx >= 0 && wx < letterW && wy >= 0 && wy < letterH) {
    const row = Math.floor(wy / scale);
    const col = Math.floor(wx / scale);
    if (FONT.W[row] && FONT.W[row][col] === "1") return true;
  }

  return false;
}

// Minimal PNG encoder
function encodePNG(w, h, rgba) {
  // Build raw scanlines (filter type 0 = None for each row)
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }

  const deflated = zlib.deflateSync(raw, { level: 9 });

  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(pngChunk("IHDR", ihdr));

  // IDAT
  chunks.push(pngChunk("IDAT", deflated));

  // IEND
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeB, data, crc]);
}

// CRC32
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// Generate icons
const sizes = [16, 48, 128];
for (const size of sizes) {
  const png = createPNG(size);
  const outPath = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${png.length} bytes)`);
}
