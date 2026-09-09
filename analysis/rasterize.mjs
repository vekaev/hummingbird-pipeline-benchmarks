#!/usr/bin/env node
/**
 * Rasterises each figure to a 2x PNG on a white ground, for dropping into documents.
 *
 * Run locally, not in the deploy: it drives headless Chrome, and the Vercel build is
 * restricted to Node builtins so that the served pages cannot depend on anything outside
 * this repository. The PNGs are committed artefacts of this script.
 *
 * Usage: node analysis/rasterize.mjs
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const figDir = join(root, 'results/figures');
const pngDir = join(figDir, 'png');
mkdirSync(pngDir, { recursive: true });

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCALE = 2;

const files = readdirSync(figDir).filter((f) => f.endsWith('.svg')).sort();
if (!files.length) throw new Error('no SVGs in results/figures — run analysis/figures.mjs first');

for (const f of files) {
  const svg = readFileSync(join(figDir, f), 'utf8');
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vb) throw new Error(`${f}: no viewBox, cannot size the raster`);
  const w = Number(vb[1]);
  const h = Number(vb[2]);

  // A wrapper page rather than rendering the SVG directly: it pins the white ground and
  // removes the default body margin, so the PNG edge is the figure edge.
  const work = join(tmpdir(), `fig-${process.pid}-${f}.html`);
  writeFileSync(work, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#ffffff}svg{display:block}</style>${svg}`);

  const out = join(pngDir, f.replace(/\.svg$/, '.png'));
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
    `--screenshot=${out}`, `--window-size=${w},${h}`,
    `--force-device-scale-factor=${SCALE}`, `file://${work}`,
  ], { stdio: 'pipe' });
  rmSync(work, { force: true });
  console.log(`  ${f.replace(/\.svg$/, '.png')}  ${w * SCALE}x${h * SCALE}`);
}
console.log(`${files.length} PNGs at ${SCALE}x in results/figures/png/`);
