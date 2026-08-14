// Generates the app icons in public/icons/ from the game's own palette.
//
// Why a script and not committed binaries: the icon is the one asset that
// has to exist at several exact sizes (Play wants 512, the manifest wants
// 192 and 512, Bubblewrap re-slices both), and hand-exported PNGs drift out
// of sync with the theme the moment a colour changes. Regenerate with:
//
//   node scripts/make-icons.mjs
//
// It writes PNGs with no image library — Node's zlib is the only thing a
// PNG actually needs beyond a CRC — so there's no dependency to install on
// a machine that just wants to rebuild the store assets.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// Same values as THEME/COLORS in game.tsx. Kept as literals rather than
// imported because that file is TSX and this script runs bare on Node.
const BOARD = [0xbb, 0xad, 0xa0];
const RED = [0xf2, 0x60, 0x3c];
const GREEN = [0x9d, 0xbf, 0x56];
const BLUE = [0x6b, 0xa3, 0xc9];

// --- tiny PNG writer ----------------------------------------------------

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const encodePng = (width, height, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Rows are stored with filter type 0 (none). Filtering would compress
  // better; at these sizes the file is already a few KB.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// --- drawing ------------------------------------------------------------
// Everything is drawn at SS× scale and box-filtered down at the end, which
// is the cheapest way to get antialiased corners without a rasteriser.

const SS = 4;

const makeCanvas = (size) => ({
  size,
  px: new Float64Array(size * size * 4), // straight RGBA, 0..255
});

const blend = (canvas, x, y, [r, g, b], alpha) => {
  if (alpha <= 0 || x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  const px = canvas.px;
  const outA = alpha + (px[i + 3] / 255) * (1 - alpha);
  if (outA <= 0) return;
  px[i] = (r * alpha + px[i] * (px[i + 3] / 255) * (1 - alpha)) / outA;
  px[i + 1] = (g * alpha + px[i + 1] * (px[i + 3] / 255) * (1 - alpha)) / outA;
  px[i + 2] = (b * alpha + px[i + 2] * (px[i + 3] / 255) * (1 - alpha)) / outA;
  px[i + 3] = outA * 255;
};

// Rounded rectangle, coordinates in canvas pixels.
const roundRect = (canvas, x, y, w, h, radius, color) => {
  const x1 = x + w;
  const y1 = y + h;
  for (let py = Math.floor(y); py < Math.ceil(y1); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x1); px++) {
      // Distance from the rounded-rect's inner box, per the standard
      // signed-distance formulation.
      const cx = Math.max(x + radius - px - 0.5, 0, px + 0.5 - (x1 - radius));
      const cy = Math.max(y + radius - py - 0.5, 0, py + 0.5 - (y1 - radius));
      const d = Math.hypot(cx, cy);
      if (d <= radius) blend(canvas, px, py, color, 1);
    }
  }
};

const downsample = (canvas, target) => {
  const out = Buffer.alloc(target * target * 4);
  const factor = canvas.size / target;
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * canvas.size + (x * factor + sx)) * 4;
          const sa = canvas.px[i + 3] / 255;
          r += canvas.px[i] * sa;
          g += canvas.px[i + 1] * sa;
          b += canvas.px[i + 2] * sa;
          a += sa;
        }
      }
      const n = factor * factor;
      const o = (y * target + x) * 4;
      // Un-premultiply so partially covered edge pixels keep their hue.
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
};

// The mark: three tiles in the colour cycle, arranged as a triangle leaning
// inward — red above, green and blue below — so the icon says "these three
// pull on each other" at 48px as well as at 512.
const drawIcon = (size, { maskable }) => {
  const canvas = makeCanvas(size * SS);
  const S = size * SS;

  if (maskable) {
    // Maskable icons are cropped to whatever shape the launcher wants, so
    // the background has to bleed to every edge and the mark has to stay
    // inside the 80% safe zone.
    roundRect(canvas, 0, 0, S, S, 0, BOARD);
  } else {
    roundRect(canvas, 0, 0, S, S, S * 0.22, BOARD);
  }

  const tile = S * (maskable ? 0.2 : 0.26);
  const radius = tile * 0.22;
  const cx = S / 2;
  const cy = S / 2;
  const spread = S * (maskable ? 0.16 : 0.21);

  const place = (dx, dy, color) => {
    const x = cx + dx * spread - tile / 2;
    const y = cy + dy * spread - tile / 2;
    // The darker lower edge the tiles have in game, so the icon reads as
    // the same object. Painted as a full tile underneath and then covered
    // by the lighter face, rather than as a band on top: a band drawn over
    // the tile has its own corners, which poke out past the tile's rounded
    // ones and read as a separate bar sitting under the tile.
    roundRect(canvas, x, y, tile, tile, radius, color.map((v) => Math.round(v * 0.84)));
    roundRect(canvas, x, y, tile, tile * 0.87, radius, color);
  };

  place(0, -0.95, RED);
  place(-0.85, 0.62, GREEN);
  place(0.85, 0.62, BLUE);

  return encodePng(size, size, downsample(canvas, size));
};

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT_DIR, name), drawIcon(size, opts));
  console.log(`wrote ${name} (${size}x${size})`);
}

// Vector copy for the browser tab, where an SVG stays crisp at any size.
const svgTile = (x, y, fill) =>
  `<rect x="${x - 11}" y="${y - 11}" width="22" height="22" rx="5" fill="${fill}"/>`;
writeFileSync(
  join(OUT_DIR, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <rect width="96" height="96" rx="21" fill="#BBADA0"/>
  ${svgTile(48, 29, '#F2603C')}
  ${svgTile(31, 62, '#9DBF56')}
  ${svgTile(65, 62, '#6BA3C9')}
</svg>
`
);
console.log('wrote icon.svg');
