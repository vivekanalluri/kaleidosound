// gen-assets.mjs — produce placeholder Kaleidosound source art for the
// @capacitor/assets generator. It renders a simple kaleidoscope mandala (SVG)
// and writes the source images the tool expects into ./assets:
//   icon-background.png  solid dark base for the adaptive icon
//   icon-foreground.png  centred mark with safe-zone padding (transparent)
//   icon-only.png        mark on the dark base (iOS / legacy icon)
//   splash.png / splash-dark.png  mark centred on a dark canvas
//
// Replace these later by dropping a designed logo into ./assets and re-running
// `npx capacitor-assets generate`.

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'assets');
mkdirSync(outDir, { recursive: true });

const BG = { r: 11, g: 14, b: 20, alpha: 1 }; // #0b0e14, matches the app theme
const PALETTE = ['#21e6c1', '#7b5cff', '#ff4d9d', '#ffb020', '#3ad6ff', '#a24bff'];

/** Build a kaleidoscope mandala SVG of the given size on a transparent bg. */
function markSVG(size) {
  const c = size / 2;
  const petals = 12;
  const layers = [];

  // Two rings of rotated "petals" (ellipses) for a symmetric, glassy look.
  for (const ring of [{ ry: size * 0.30, rx: size * 0.085, dist: size * 0.20, op: 0.85 },
                      { ry: size * 0.20, rx: size * 0.055, dist: size * 0.12, op: 0.95 }]) {
    for (let i = 0; i < petals; i++) {
      const angle = (360 / petals) * i;
      const color = PALETTE[i % PALETTE.length];
      layers.push(
        `<ellipse cx="${c}" cy="${c - ring.dist}" rx="${ring.rx}" ry="${ring.ry}" ` +
          `fill="${color}" opacity="${ring.op}" ` +
          `transform="rotate(${angle} ${c} ${c})" />`
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="45%" stop-color="#21e6c1" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#7b5cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g style="mix-blend-mode:screen">
    ${layers.join('\n    ')}
  </g>
  <circle cx="${c}" cy="${c}" r="${size * 0.14}" fill="url(#glow)"/>
</svg>`;
}

async function markBuffer(px) {
  return sharp(Buffer.from(markSVG(1024))).resize(px, px).png().toBuffer();
}

function solid(size) {
  return sharp({ create: { width: size, height: size, channels: 4, background: BG } });
}

async function centeredOnDark(canvas, markPx) {
  const mark = await markBuffer(markPx);
  return solid(canvas).composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
}

async function main() {
  // Adaptive-icon background: solid dark.
  await solid(1024).png().toFile(resolve(outDir, 'icon-background.png'));

  // Adaptive-icon foreground: mark with generous safe-zone padding, transparent.
  const fg = await sharp(Buffer.from(markSVG(1024))).resize(660, 660).png().toBuffer();
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fg, gravity: 'center' }])
    .png()
    .toFile(resolve(outDir, 'icon-foreground.png'));

  // Legacy / iOS icon: mark on the dark base.
  await sharp(await centeredOnDark(1024, 880)).toFile(resolve(outDir, 'icon-only.png'));

  // Splash (light + dark are identical on our dark theme).
  await sharp(await centeredOnDark(2732, 900)).toFile(resolve(outDir, 'splash.png'));
  await sharp(await centeredOnDark(2732, 900)).toFile(resolve(outDir, 'splash-dark.png'));

  console.log('Wrote placeholder assets to ./assets');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
