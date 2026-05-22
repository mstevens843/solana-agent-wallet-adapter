// Generates apps/desktop-shell/src-tauri/icons/icon.png (1024x1024) by
// compositing the Android adaptive-icon background + foreground behind an
// Apple-style squircle clip. Pure JS; no native compile step.
//
// After this, run `cargo tauri icon` to fan out .icns / .ico / sized PNGs.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const FG_PATH = resolve(
  REPO_ROOT,
  'apps/android-twa/app/src/main/res/drawable/agentic_launcher_foreground.png',
);
const BG_PATH = resolve(
  REPO_ROOT,
  'apps/android-twa/app/src/main/res/drawable/agentic_launcher_background.png',
);
const OUT_PATH = resolve(__dirname, '..', 'src-tauri/icons/icon.png');

const SIZE = 1024;
const CORNER = Math.round(SIZE * 0.2237); // Apple Big Sur+ corner radius (~229)

const [fgB64, bgB64] = await Promise.all([
  readFile(FG_PATH).then((b) => b.toString('base64')),
  readFile(BG_PATH).then((b) => b.toString('base64')),
]);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <clipPath id="squircle">
      <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${CORNER}" ry="${CORNER}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#squircle)">
    <image href="data:image/png;base64,${bgB64}" x="0" y="0" width="${SIZE}" height="${SIZE}"/>
    <image href="data:image/png;base64,${fgB64}" x="0" y="0" width="${SIZE}" height="${SIZE}"/>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: SIZE } })
  .render()
  .asPng();

await writeFile(OUT_PATH, png);
console.log(`[icon] wrote ${OUT_PATH} (${png.length} bytes)`);
