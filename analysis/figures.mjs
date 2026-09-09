#!/usr/bin/env node
/**
 * Renders the study's eight figures as standalone SVG.
 *
 * Hand-authored SVG with no charting dependency, for the same reason the rest of the
 * analysis is plain Node: a figure that cannot be regenerated from the committed samples
 * is an assertion, not a result. Every number drawn here is read out of results/raw/ at
 * render time and reduced by the same helpers analyze.mjs uses, so a figure and the table
 * beside it cannot drift apart, and a reader who distrusts a bar can re-run this file over
 * the same JSON and get the same pixels. A charting library would put a second,
 * unversioned opinion about scales, rounding and colour between the samples and the claim,
 * and would still not stop a long clip id from running under its own bar — which is why
 * the label budgets below are asserted rather than eyeballed.
 *
 * Canvas heights are derived from the data, not fixed: an arm that completes or a clip that
 * is added grows the plot and the note with it instead of overprinting them.
 *
 * Two inputs are NOT in results/raw/, and are named as constants below: container boot time
 * and the platform's own predict_time. They come from the deployment's metering lines
 * rather than from print_timing_info(), and the cost figure says so on its face.
 *
 * Usage: node analysis/figures.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mean, percentile, cv, pairedDelta, linfit, fmt, signed } from './stats.mjs';
import { DEFAULT_RATE, per1000, throughputPerGpuHour, usd } from './cost.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'results/figures');
mkdirSync(outDir, { recursive: true });

const raw = (n) => JSON.parse(readFileSync(join(root, 'results/raw', `${n}.json`), 'utf8'));

const lipsync = raw('lipsync-prod');
const wr = raw('wordreplacement-prod');
const hdtfSelf = raw('hdtf-self');
const arms = raw('arms');
const lse = raw('lse');
const clips = raw('clips');

// --- domain ------------------------------------------------------------------

/** Pipeline execution order, which is also the argument the figures make. */
const STAGE_ORDER = ['crop_face', 'detect_landmarks', 'parse_face', 'track_face', 'run_animator',
  'create_driving_geo_and_mask', 'predict_liveportait', 'reshape_liveportrait', 'render_rgb', 'paste_back_video'];
const STAGE_LABEL = {
  crop_face: 'Face crop', detect_landmarks: 'Landmark detection', parse_face: 'Face parsing',
  track_face: '3D face tracking', run_animator: 'Audio to expression',
  create_driving_geo_and_mask: 'Driving geometry + mask', predict_liveportait: 'LivePortrait warp',
  reshape_liveportrait: 'Warp reshaping', render_rgb: 'Neural render + super-res',
  paste_back_video: 'Paste-back compositing',
};
/** The four stages before the animator take no audio input: the cacheable prefix. */
const SOURCE_ONLY = new Set(['crop_face', 'detect_landmarks', 'parse_face', 'track_face']);
/** Job-level stages that touch no GPU. */
const CPU_ONLY = new Set(['download_and_preprocess', 'adjust_video_length_to_audio', 'modify_video_length',
  'split_segments', 'stitch_segments', 'attach_audio', 'upload_to_s3', 'upload_input_files_to_s3',
  'setup_job_dir']);

/**
 * Metered, not instrumented. Container boot and the platform's billed in-container time are
 * read off the deployment's own metering lines; print_timing_info() sees neither, so neither
 * is in results/raw/. Named here so the cost figure can be audited against them.
 */
const COLD_START_S = 285.41;
const PREDICT_TIME_S = 645.90;
/** The gate an optimization arm has to clear before it is kept, in percent, faster. */
const GATE_PCT = 3;
/**
 * Same-build regeneration noise on LSE-D. One pair of regenerations of one production clip,
 * n=1, carried onto this dataset — a bound on re-encode noise, not an interval.
 */
const FLOOR_D = 0.256;

const sum = (v) => v.reduce((a, b) => a + b, 0);
const stageMeans = (runs) => Object.fromEntries(STAGE_ORDER
  .filter((s) => runs.some((r) => s in r.stages))
  .map((s) => [s, mean(runs.filter((r) => s in r.stages).map((r) => r.stages[s]))]));
const prefixOf = (m) => sum(Object.entries(m).filter(([k]) => SOURCE_ONLY.has(k)).map(([, v]) => v));

/** Clip ids carry a corpus prefix that no reader needs and no gutter can hold. */
const shortClip = (id) => String(id).replace(/\.mp4$/, '').replace(/^hdtf\d+_/, '');

// --- svg primitives ----------------------------------------------------------

const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const INK = '#141920';
const MUTED = '#5f6b79';
const GRID = '#dde2e9';
const BEFORE = '#a92218';
const AFTER = '#0a6146';
const NEUTRAL = '#1f4fd8';
const AMBER = '#96450a';
const KNOCKOUT = '#ffffff';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x, y, s, o = {}) {
  const { size = 12, fill = INK, anchor = 'start', weight = 400, family = FONT, opacity = 1 } = o;
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" fill="${fill}" ` +
    `text-anchor="${anchor}" font-weight="${weight}" opacity="${opacity}">${esc(s)}</text>`;
}

/** Greedy wrap. Subtitles and notes are prose and were overflowing the canvas. */
function wrap(s, maxChars) {
  const out = [];
  let line = '';
  for (const word of String(s).split(' ')) {
    if (line && `${line} ${word}`.length > maxChars) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

const noteWrap = (width, note) => (note ? wrap(note, Math.floor((width - 64) / 5.9)) : []);

/**
 * Canvas height that fits the plot, its tick labels and however many lines the note wraps
 * to. Called before frame() so the note can never land on the axis.
 */
const canvasHeight = (width, yBot, note, pad = 40) =>
  Math.round(yBot + pad + noteWrap(width, note).length * 15 + 12);

function frame(width, height, title, subtitle, body, note) {
  const subLines = subtitle ? wrap(subtitle, Math.floor((width - 64) / 6.55)) : [];
  // AXIS_CAPTION_Y assumes the subtitle stops at two lines. Enforced, because the failure
  // mode is a caption printed underneath a subtitle rather than an obvious crash.
  if (subLines.length > 2) {
    throw new Error(`${title}: subtitle wraps to ${subLines.length} lines and would crowd the axis caption at y=${AXIS_CAPTION_Y}`);
  }
  const noteLines = noteWrap(width, note);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}">`,
    // A white backing rect so the file stands alone; the page build strips it and lets the
    // sheet's own surface show through.
    `<rect width="${width}" height="${height}" fill="${KNOCKOUT}"/>`,
    text(32, 38, title, { size: 17, weight: 650 }),
    ...subLines.map((l, i) => text(32, 60 + i * 17, l, { size: 12.5, fill: MUTED })),
    body,
    ...noteLines.map((l, i) => text(32, height - 18 - (noteLines.length - 1 - i) * 15, l, { size: 11, fill: MUTED })),
    '</svg>',
  ].join('\n');
}

/** Consistent home for the value-axis caption, clear of the wrapped subtitle. */
const AXIS_CAPTION_Y = 108;

/** Horizontal gridlines plus a left value axis. */
function yAxis(x0, x1, yOf, ticks, fmtT) {
  return ticks.map((t) => {
    const y = yOf(t);
    return `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${GRID}" stroke-width="1"/>` +
      text(x0 - 10, y + 4, fmtT(t), { size: 11, fill: MUTED, anchor: 'end' });
  }).join('\n');
}

/** Vertical gridlines plus a bottom value axis: the horizontal-bar counterpart of yAxis. */
function xAxis(yTop, yBot, xOf, ticks, fmtT) {
  return ticks.map((t) => `<line x1="${xOf(t)}" y1="${yTop}" x2="${xOf(t)}" y2="${yBot}" stroke="${GRID}" stroke-width="1"/>` +
    text(xOf(t), yBot + 20, fmtT(t), { size: 11, fill: MUTED, anchor: 'middle' })).join('\n');
}

/** Round axis maximum and its ticks, so no figure hardcodes a scale the data outgrew. */
function scaleTo(maxVal, target = 6) {
  const rawStep = maxVal / target;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 4, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? 10 * magnitude;
  const max = Math.ceil(maxVal / step - 1e-9) * step;
  const ticks = [];
  for (let t = 0; t <= max + step / 1e6; t += step) ticks.push(Number(t.toPrecision(12)));
  return { max, ticks };
}

// --- label budgets -----------------------------------------------------------

/**
 * Advance-width estimate, in px, for the label fonts above.
 *
 * Hand-authored SVG has no layout engine, so this is the cheap substitute for measuring:
 * per-character em widths in the Helvetica family's proportions, times a safety factor,
 * checked against the space each figure allocated. assertFits throws rather than shipping a
 * collision, and the run prints the widest label in every gutter.
 */
const NARROW = new Set([...'ijlItfr\'"!.,:;|()[]/\\`', '·']);
const WIDE = new Set([...'mwMW—→×']);
export function measure(s, size, mono = false) {
  // The mono stack is fixed-pitch, so its labels are counted at pitch rather than by shape.
  if (mono) return String(s).length * 0.6 * size * 1.02;
  let em = 0;
  for (const ch of String(s)) {
    if (ch === ' ') em += 0.28;
    else if (NARROW.has(ch)) em += 0.30;
    else if (WIDE.has(ch)) em += 0.92;
    else if (ch >= '0' && ch <= '9') em += 0.56;
    else if (ch >= 'A' && ch <= 'Z') em += 0.70;
    else em += 0.55;
  }
  return em * size * 1.02;
}

const BUDGETS = [];
/** An already-measured span against its allocation, recorded and enforced the same way. */
function assertSpan(figure, what, label, width, budget) {
  if (width > budget) {
    throw new Error(`${figure}: ${what} "${label}" needs ${width.toFixed(1)}px but only ${budget.toFixed(1)}px was allocated`);
  }
  BUDGETS.push({ figure, what, label, width, budget });
  return width;
}

/** Widest label in a set against the space allocated for it. Throws on overflow. */
function assertFits(figure, what, labels, size, budget, mono = false) {
  let worst = { width: 0, label: '' };
  for (const l of labels) {
    const width = measure(l, size, mono);
    if (width > worst.width) worst = { width, label: String(l) };
  }
  if (worst.width > budget) {
    throw new Error(`${figure}: ${what} label "${worst.label}" needs ${worst.width.toFixed(1)}px ` +
      `at size ${size} but only ${budget.toFixed(1)}px was allocated`);
  }
  BUDGETS.push({ figure, what, ...worst, size, budget });
  return worst;
}

/**
 * Legend laid out right-to-left from xEnd using the same width estimate as the assertions,
 * so entries cannot overlap each other or the axis caption whatever their text says.
 * Returns the svg and the x it starts at, which the caller asserts against.
 */
function legend(xEnd, y, items, size = 11) {
  const widths = items.map((it) => 11 + 6 + measure(it.label, size));
  const total = sum(widths) + 18 * (items.length - 1);
  let x = xEnd - total;
  const start = x;
  const parts = [];
  items.forEach((it, i) => {
    parts.push(`<rect x="${x.toFixed(1)}" y="${y - 9}" width="11" height="11" fill="${it.colour}" rx="2"/>`);
    parts.push(text((x + 17).toFixed(1), y, it.label, { size, fill: it.fill ?? MUTED }));
    x += widths[i] + 18;
  });
  return { svg: parts.join('\n'), start };
}

/** The value-axis caption plus a legend on the same line, with the gap between asserted. */
function captionRow(figure, width, caption, xEnd, items) {
  const lg = items.length ? legend(xEnd, AXIS_CAPTION_Y, items) : { svg: '', start: width - 32 };
  assertFits(figure, 'axis caption', [caption], 11.5, lg.start - 32 - 16);
  return `${text(32, AXIS_CAPTION_Y, caption, { size: 11.5, fill: MUTED })}\n${lg.svg}`;
}

function write(name, svg) {
  writeFileSync(join(outDir, name), `${svg}\n`);
  console.log(`  ${name}`);
}

// --- 1. where the pipeline's time goes --------------------------------------

function figureStageProfile() {
  const m = stageMeans(lipsync);
  const tot = sum(Object.values(m));
  const rows = STAGE_ORDER.filter((s) => s in m).map((s) => ({
    key: s, label: STAGE_LABEL[s], v: m[s], share: (100 * m[s]) / tot, prefix: SOURCE_ONLY.has(s),
  }));

  const W = 880;
  const x0 = 232, x1 = W - 170, yTop = 150, rowH = 30;
  const yBot = yTop + rows.length * rowH;
  const { max, ticks } = scaleTo(Math.max(...rows.map((r) => r.v)));
  const xOf = (v) => x0 + (v / max) * (x1 - x0);
  const label = (r) => `${fmt(r.v)} s · ${fmt(r.share, 1)}%`;

  assertFits('01-stage-profile', 'stage name', rows.map((r) => r.label), 12.5, x0 - 14 - 32);
  assertFits('01-stage-profile', 'bar value', rows.map(label), 12, W - 32 - (x1 + 10));

  const body = [];
  body.push(xAxis(yTop - 10, yBot, xOf, ticks, (t) => `${t}`));
  body.push(captionRow('01-stage-profile', W, `mean seconds per stage, measured over n=${lipsync.length} production runs`, W - 32, [
    { colour: NEUTRAL, label: 'source-only prefix (no audio input)' },
    { colour: INK, label: 'audio-dependent' },
  ]));

  rows.forEach((r, i) => {
    const yc = yTop + i * rowH + rowH / 2;
    const h = 19;
    const colour = r.prefix ? NEUTRAL : INK;
    body.push(text(x0 - 14, yc + 4, r.label, { size: 12.5, anchor: 'end', weight: r.prefix ? 550 : 500 }));
    body.push(`<rect x="${x0}" y="${yc - h / 2}" width="${Math.max(xOf(r.v) - x0, 1.5).toFixed(1)}" height="${h}" fill="${colour}" rx="2"/>`);
    body.push(text((Math.max(xOf(r.v), x0 + 2) + 10).toFixed(1), yc + 4, label(r), { size: 12, weight: 600, fill: colour }));
  });

  const top2 = [...rows].sort((a, b) => b.v - a.v).slice(0, 2);
  const animator = rows.find((r) => r.key === 'run_animator');
  const prefix = prefixOf(m);
  const note = `${top2[0].label} and ${top2[1].label} are ${fmt(top2[0].share + top2[1].share, 1)}% of the pipeline between them. ` +
    `${animator.label} — the audio-to-motion model itself, the part a reader assumes this pipeline is — is ${fmt(animator.share, 1)}%. ` +
    `The four stages in the prefix colour run before the animator and take no audio input at all: ${fmt(prefix)} s, ` +
    `${fmt((100 * prefix) / tot, 1)}% of the pipeline, recomputed identically for every job that reuses a source video.`;

  write('01-stage-profile.svg', frame(W, canvasHeight(W, yBot, note),
    'Two stages are half the pipeline, and neither is the lipsync model',
    `Measured mean per-stage seconds, n=${lipsync.length} harvested production lipsync predictions at 1920×1080, ` +
    `${Math.min(...lipsync.map((r) => r.frames))}–${Math.max(...lipsync.map((r) => r.frames))} frames at 25 fps. ` +
    `Stages in pipeline execution order; shares are of the ${fmt(tot)} s stage total.`,
    body.join('\n'), note));
}

// --- 2. the A/B result -------------------------------------------------------

const ARM_LABEL = {
  arm0: 'Baseline', arm1: 'Renderer batch 4 → 16', arm2: 'Batch 16 + fp16 autocast',
  arm3: 'cuDNN autotuning in the render loop', arm0b: 'Baseline, repeated (seeded)',
  control_main: 'Control: main-branch runtime',
};

/** Human summary of the knobs an arm actually set, read from the arm's own record. */
function knobText(knobs = {}) {
  const bits = [];
  if (knobs.RENDER_BATCH_SIZE) bits.push(`batch ${knobs.RENDER_BATCH_SIZE}`);
  bits.push(knobs.RENDER_AMP === '1' ? 'fp16' : 'fp32');
  if (knobs.RENDER_CUDNN_BENCHMARK === '1') bits.push('cuDNN autotune');
  return bits.join(', ');
}

function figureArmsPaired() {
  const byArm = {};
  for (const a of arms) (byArm[a.arm] ??= []).push(a);
  const wallOf = (rows) => Object.fromEntries(rows.filter((r) => r.wall_s).map((r) => [r.clip, r.wall_s]));
  const base = wallOf(byArm.arm0 ?? []);
  if (!Object.keys(base).length) { console.log('  02 skipped: no baseline arm with wall time'); return; }

  const groups = [];
  const incomplete = [];
  for (const id of ['arm1', 'arm2', 'arm3', 'arm0b', 'control_main']) {
    const rows = byArm[id];
    if (!rows) continue;
    // An arm can have logs but no summarised wall time. Omit it rather than draw a NaN.
    const d = pairedDelta(wallOf(rows), base);
    if (!d) { incomplete.push(id); continue; }
    groups.push({ id, label: ARM_LABEL[id] ?? id, knobs: knobText(rows[0].knobs), d, pass: d.meanPct <= -GATE_PCT });
  }
  if (!groups.length) { console.log('  02 skipped: no completed arm to compare'); return; }

  const W = 900;
  const x0 = 380, x1 = W - 92, yTop = 172, rowH = 34, gap = 26;
  // Two gutters, not one: clip names sit against the plot, the arm block outside them.
  const clipW = Math.max(...groups.flatMap((g) => g.d.perClip.map((c) => measure(shortClip(c.clip), 12))));
  const armRight = x0 - 16 - clipW - 16;
  const span = Math.max(4, Math.ceil(Math.max(GATE_PCT + 1,
    ...groups.flatMap((g) => g.d.perClip.map((c) => Math.abs(c.deltaPct) + 0.8)))));
  const xOf = (d) => x0 + ((d + span) / (2 * span)) * (x1 - x0);
  const nRows = groups.reduce((s, g) => s + g.d.perClip.length, 0);
  const yBot = yTop + nRows * rowH + (groups.length - 1) * gap;

  assertFits('02-arms-paired', 'clip id', groups.flatMap((g) => g.d.perClip.map((c) => shortClip(c.clip))), 12, clipW);
  assertFits('02-arms-paired', 'arm name', [
    ...groups.map((g) => g.label), ...groups.map((g) => `mean ${signed(g.d.meanPct)}%`),
  ], 12.5, armRight - 32);
  assertFits('02-arms-paired', 'knob detail (mono)', groups.map((g) => g.knobs), 10.5, armRight - 32, true);
  assertFits('02-arms-paired', 'delta value', groups.flatMap((g) => g.d.perClip.map((c) => `${signed(c.deltaPct)}%`)), 12, 70);
  assertFits('02-arms-paired', 'verdict', groups.map((g) => (g.pass ? 'KEEP' : 'rejected')), 11.5, W - 32 - (x1 + 12));

  const ticks = [];
  for (let t = -span; t <= span + 1e-9; t += 1) ticks.push(t);

  const body = [];
  body.push(xAxis(yTop - 24, yBot, xOf, ticks, (t) => (t === 0 ? '0%' : `${signed(t, 0)}%`)));
  // The gate band is a flat neutral fill, not a translucent tint: this palette has one grey,
  // and layering opacity to make a lighter one would invent a ninth colour.
  body.push(`<rect x="${xOf(-GATE_PCT).toFixed(1)}" y="${yTop - 24}" width="${(xOf(GATE_PCT) - xOf(-GATE_PCT)).toFixed(1)}" height="${yBot - yTop + 24}" fill="${GRID}"/>`);
  body.push(`<line x1="${xOf(0)}" y1="${yTop - 24}" x2="${xOf(0)}" y2="${yBot}" stroke="${MUTED}" stroke-width="1.5"/>`);
  body.push(`<line x1="${xOf(-GATE_PCT)}" y1="${yTop - 24}" x2="${xOf(-GATE_PCT)}" y2="${yBot}" stroke="${AFTER}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  body.push(text(xOf(-GATE_PCT) + 7, yTop - 10, `keep threshold −${GATE_PCT}%`, { size: 11, fill: AFTER, weight: 650 }));
  body.push(text(xOf(GATE_PCT) - 7, yTop - 10, `±${GATE_PCT}% acceptance gate`, { size: 11, fill: MUTED, anchor: 'end' }));
  body.push(captionRow('02-arms-paired', W,
    'per-clip paired wall-time delta against the baseline arm — negative is faster', W - 32, []));
  body.push(text(W - 32, AXIS_CAPTION_Y, `measured, n=${groups[0].d.n} clips per arm`, { size: 11.5, fill: MUTED, anchor: 'end' }));

  let y = yTop;
  for (const g of groups) {
    const colour = g.pass ? AFTER : BEFORE;
    const first = y;
    for (const c of g.d.perClip) {
      const yc = y + rowH / 2;
      body.push(text(x0 - 16, yc + 4, shortClip(c.clip), { size: 12, anchor: 'end', fill: MUTED }));
      // A connector from zero, because at this magnitude a lone dot reads as noise on the axis.
      body.push(`<line x1="${xOf(0)}" y1="${yc}" x2="${xOf(c.deltaPct).toFixed(1)}" y2="${yc}" stroke="${colour}" stroke-width="2"/>`);
      body.push(`<circle cx="${xOf(c.deltaPct).toFixed(1)}" cy="${yc}" r="5" fill="${colour}"/>`);
      const right = c.deltaPct >= 0;
      body.push(text((xOf(c.deltaPct) + (right ? 11 : -11)).toFixed(1), yc + 4, `${signed(c.deltaPct)}%`,
        { size: 12, weight: 600, fill: colour, anchor: right ? 'start' : 'end' }));
      y += rowH;
    }
    body.push(text(armRight, first + 17, g.label, { size: 12.5, anchor: 'end', weight: 650 }));
    body.push(text(armRight, first + 33, g.knobs, { size: 10.5, anchor: 'end', fill: MUTED, family: MONO }));
    body.push(text(armRight, first + 49, `mean ${signed(g.d.meanPct)}%`, { size: 11, anchor: 'end', fill: colour, weight: 650 }));
    body.push(text(x1 + 12, (first + y) / 2 + 4, g.pass ? 'KEEP' : 'rejected', { size: 11.5, fill: colour, weight: 650 }));
    y += gap;
  }

  const worst = groups.reduce((a, g) => Math.max(a, Math.abs(g.d.meanPct)), 0);
  const armCv = cv((byArm.arm0 ?? []).filter((a) => a.wall_s).map((a) => a.wall_s));
  const kept = groups.filter((g) => g.pass);
  const note = `Sign convention: the delta is candidate minus baseline, so negative is faster and positive is slower. ` +
    `The gate keeps a change only at ${GATE_PCT}% faster or better — the dashed green line — and ` +
    `${kept.length ? `${kept.length} of ${groups.length} arms reached it` : `no arm reached it, so nothing here is drawn in the keep colour`}. ` +
    `The largest mean effect of any arm is ${fmt(worst, 2)}%, against a baseline run-to-run CV of ${fmt(armCv, 3)}. ` +
    `Measured on one dedicated A100 40GB, so the null is a real null and not an artefact of a noisy host: the renderer is decode-bound, and neither batch size nor autocast reaches the bottleneck.` +
    (incomplete.length ? ` ${incomplete.join(' and ')} has a record but no completed wall time, and is omitted rather than drawn.` : '');

  write('02-arms-paired.svg', frame(W, canvasHeight(W, yBot, note),
    kept.length
      ? `${kept.length} of ${groups.length} renderer tuning arms cleared the gate`
      : `All ${groups.length} renderer tuning arms landed inside the noise`,
    `Measured on one dedicated A100 40GB: the same ${groups[0].d.n} clips in the same order, one warm process per arm, ` +
    `sampler seeded, arms run sequentially. Paired per clip because clip-to-clip spread in this pipeline is larger than the effects being tested.`,
    body.join('\n'), note));
}

// --- 3. what input resolution actually costs --------------------------------

function figureResolution() {
  const byClip = Object.fromEntries(clips.map((c) => [c.id, c]));
  const pts = hdtfSelf.filter((r) => byClip[r.clip]).map((r) => ({
    clip: r.clip,
    mp: (byClip[r.clip].width * byClip[r.clip].height) / 1e6,
    frames: r.frames ?? byClip[r.clip].frames,
    stages: r.stages,
  })).sort((a, b) => a.mp - b.mp);
  if (pts.length < 3) { console.log('  03 skipped: too few clips'); return; }

  const series = STAGE_ORDER.filter((s) => pts.every((p) => s in p.stages)).map((s) => {
    const xs = pts.map((p) => p.mp);
    const ys = pts.map((p) => p.stages[s] / p.frames);
    return { key: s, label: STAGE_LABEL[s], xs, ys, fit: linfit(xs, ys), prefix: SOURCE_ONLY.has(s) };
  });
  // Detected, not assumed: one HDTF run shared the GPU with a concurrent batch, which shows
  // up as a single per-frame value far off its own stage's median. Flagged in place.
  const contended = new Set();
  for (const s of series) {
    const med = percentile(s.ys, 0.5);
    s.ys.forEach((v, i) => { if (v > 2 * med) contended.add(`${s.key}|${i}`); });
  }
  const steepest = [...series].sort((a, b) => b.fit.r2 * Math.abs(b.fit.b) - a.fit.r2 * Math.abs(a.fit.b))[0];

  const W = 920;
  const x0 = 92, x1 = W - 224, yTop = 138, yBot = 478;
  const { max: yMax, ticks: yTicks } = scaleTo(Math.max(...series.flatMap((s) => s.ys)), 4);
  const mpLo = 0.15, mpHi = Math.ceil(Math.max(...pts.map((p) => p.mp)) * 10) / 10 + 0.1;
  const xOf = (mp) => x0 + ((mp - mpLo) / (mpHi - mpLo)) * (x1 - x0);
  const yOf = (v) => yBot - (v / yMax) * (yBot - yTop);

  assertFits('03-resolution-decomposition', 'series', series.map((s) => s.label), 11.5, W - 32 - (x1 + 26));

  const body = [];
  body.push(yAxis(x0, x1, yOf, yTicks, (t) => fmt(t, 2)));
  body.push(captionRow('03-resolution-decomposition', W, 'seconds per frame', x1, [
    { colour: NEUTRAL, label: 'source-only prefix' },
    { colour: MUTED, label: 'flat: fixed internal resolution' },
    { colour: BEFORE, label: 'scales with input' },
  ]));
  for (const t of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    body.push(text(xOf(t).toFixed(1), yBot + 20, fmt(t, 1), { size: 11, fill: MUTED, anchor: 'middle' }));
  }
  body.push(text((x0 + x1) / 2, yBot + 42, 'source frame size (megapixels) — frame count held at 751', { size: 11.5, fill: MUTED, anchor: 'middle' }));

  const colourOf = (s) => (s === steepest ? BEFORE : s.prefix ? NEUTRAL : MUTED);
  for (const s of series) {
    const colour = colourOf(s);
    body.push(`<path d="${s.xs.map((x, i) => `${i ? 'L' : 'M'}${xOf(x).toFixed(1)},${yOf(s.ys[i]).toFixed(1)}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="${s === steepest ? 2.5 : 1.4}"/>`);
    s.xs.forEach((x, i) => {
      const flagged = contended.has(`${s.key}|${i}`);
      body.push(`<circle cx="${xOf(x).toFixed(1)}" cy="${yOf(s.ys[i]).toFixed(1)}" r="${flagged ? 5 : 3}" fill="${flagged ? AMBER : colour}"/>`);
    });
  }

  // Right-hand label column, pushed apart so the flat stages stop stacking on one another.
  const minGap = 16;
  const labels = series.map((s) => ({ s, at: yOf(s.ys.at(-1)), y: yOf(s.ys.at(-1)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i += 1) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + minGap);
  const overflow = labels.at(-1).y - yBot;
  if (overflow > 0) {
    labels.at(-1).y = yBot;
    for (let i = labels.length - 2; i >= 0; i -= 1) labels[i].y = Math.min(labels[i].y, labels[i + 1].y - minGap);
  }
  for (const l of labels) {
    const colour = colourOf(l.s);
    body.push(`<polyline points="${x1},${l.at.toFixed(1)} ${x1 + 12},${(l.y - 4).toFixed(1)} ${x1 + 20},${(l.y - 4).toFixed(1)}" fill="none" stroke="${colour}" stroke-width="1"/>`);
    body.push(text(x1 + 26, l.y.toFixed(1), l.s.label, { size: 11.5, fill: colour, weight: l.s === steepest ? 650 : 400 }));
  }

  // Both annotations sit in measured gaps in the data, not on top of it: the amber key just
  // under the top gridline, the fit above the warp line and below the render line.
  const amberY = yOf(yMax * 0.95);
  body.push(`<circle cx="${xOf(0.30).toFixed(1)}" cy="${amberY.toFixed(1)}" r="5" fill="${AMBER}"/>`);
  body.push(text((xOf(0.30) + 13).toFixed(1), (amberY + 4).toFixed(1),
    'GPU-contended sample — flagged where a stage exceeds 2× its own median', { size: 11, fill: AMBER }));
  const fitX = xOf(0.60);
  const fitY = yOf(yMax * 0.45);
  assertSpan('03-resolution-decomposition', 'in-plot fit annotation',
    `${steepest.label}: R² = …`,
    Math.max(measure(`${steepest.label}: R² = ${fmt(steepest.fit.r2, 3)} against megapixels`, 12.5),
      measure(`slope ${fmt(steepest.fit.b, 5)} s/frame/MPix over a fixed ${fmt(steepest.fit.a, 5)} s/frame`, 11.5)),
    x1 - fitX);
  body.push(text(fitX.toFixed(1), fitY.toFixed(1),
    `${steepest.label}: R² = ${fmt(steepest.fit.r2, 3)} against megapixels`, { size: 12.5, fill: BEFORE, weight: 650 }));
  body.push(text(fitX.toFixed(1), (fitY + 17).toFixed(1),
    `slope ${fmt(steepest.fit.b, 5)} s/frame/MPix over a fixed ${fmt(steepest.fit.a, 5)} s/frame`, { size: 11.5, fill: BEFORE }));

  const flat = series.filter((s) => s !== steepest);
  const worstFlat = flat.reduce((a, s) => (s.fit.r2 > a.fit.r2 ? s : a), flat[0]);
  const note = `Every intermediate in this pipeline — the crop, the tracked geometry, the render itself — is written at 512² regardless of input size, ` +
    `so the flat lines are structural: those stages never see the source resolution. Paste-back is the only stage that composites back onto the original frame, and it is the only one that slopes. ` +
    `The next-best fit among the flat stages is ${worstFlat.label} at R² ${fmt(worstFlat.fit.r2, 3)}. ` +
    `That the flat stages come out flat is therefore a property of the design, and not evidence that the instrument is trustworthy. ` +
    `Measured, one run per clip; the fits are ordinary least squares through those points and the amber sample is inside them.`;

  write('03-resolution-decomposition.svg', frame(W, canvasHeight(W, yBot, note, 66),
    'Only compositing pays for input resolution',
    `Measured per-frame stage cost against source frame size, n=${pts.length} HDTF clips spanning ` +
    `${fmt(Math.max(...pts.map((p) => p.mp)) / Math.min(...pts.map((p) => p.mp)), 1)}× in pixel count with frame count fixed at 751. ` +
    `One line per stage, ${series.length} stages.`,
    body.join('\n'), note));
}

// --- 4. quality against the clip's own real footage -------------------------

function figureQuality() {
  const gen = { ...(lse.hdtf_prod?.scores ?? {}), ...(lse.hdtf_prod_rest?.scores ?? {}) };
  const gt = { ...(lse.hdtf_gt?.scores ?? {}), ...(lse.hdtf_gt_rest?.scores ?? {}) };
  const paired = Object.keys(gen)
    .filter((k) => k in gt && !gen[k].error && !gt[k].error)
    .map((k) => ({ clip: shortClip(k), gd: gen[k].lse_d, td: gt[k].lse_d }))
    .sort((a, b) => (a.gd - a.td) - (b.gd - b.td));
  if (!paired.length) { console.log('  04 skipped: no paired LSE scores'); return; }

  const W = 900;
  const x0 = 228, x1 = W - 116, yTop = 158, rowH = 26;
  const yBot = yTop + paired.length * rowH;
  const lo = Math.floor(Math.min(...paired.flatMap((p) => [p.gd, p.td - FLOOR_D])) * 2) / 2;
  const hi = Math.ceil(Math.max(...paired.flatMap((p) => [p.gd, p.td + FLOOR_D])) * 2) / 2;
  const xOf = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);

  assertFits('04-quality-paired', 'clip id', paired.map((p) => p.clip), 11, x0 - 14 - 32);
  assertFits('04-quality-paired', 'gap value (mono)', paired.map((p) => signed(p.gd - p.td, 3)), 11.5, W - 32 - (x1 + 16), true);

  const ticks = [];
  for (let t = lo; t <= hi + 1e-9; t += 0.5) ticks.push(Number(t.toFixed(2)));

  const body = [];
  body.push(xAxis(yTop - 12, yBot, xOf, ticks, (t) => fmt(t, 1)));
  body.push(captionRow('04-quality-paired', W,
    `LSE-D, lower is better — measured with SyncNet on ${lse.hdtf_prod?.device ?? 'cpu'}, n=${paired.length} clips`, W - 32, []));
  body.push(text(W - 32, AXIS_CAPTION_Y, 'each clip against its own real footage', { size: 11.5, fill: MUTED, anchor: 'end' }));

  // Marker legend, spelled out because the two ends of a dumbbell mean different things.
  const legendY = 128;
  const lg = [
    { kind: 'band', label: `±${FLOOR_D} noise floor around the real clip`, colour: GRID, fill: MUTED },
    { kind: 'hollow', label: 'real footage', colour: INK, fill: MUTED },
    { kind: 'dot', label: 'generated, inside the floor', colour: MUTED, fill: MUTED },
    { kind: 'dot', label: 'generated, clears the floor', colour: BEFORE, fill: BEFORE },
  ];
  const lgWidths = lg.map((it) => (it.kind === 'band' ? 26 : 11) + 6 + measure(it.label, 11));
  const lgTotal = sum(lgWidths) + 16 * (lg.length - 1);
  assertSpan('04-quality-paired', 'marker legend row', lg.map((it) => it.label).join(' / '), lgTotal, W - 64);
  let lx = W - 32 - lgTotal;
  for (const [i, it] of lg.entries()) {
    if (it.kind === 'band') body.push(`<rect x="${lx}" y="${legendY - 9}" width="26" height="11" fill="${GRID}"/>`);
    else if (it.kind === 'hollow') body.push(`<circle cx="${lx + 5}" cy="${legendY - 4}" r="5" fill="${KNOCKOUT}" stroke="${INK}" stroke-width="1.6"/>`);
    else body.push(`<circle cx="${lx + 5}" cy="${legendY - 4}" r="5" fill="${it.colour}"/>`);
    body.push(text(lx + (it.kind === 'band' ? 32 : 17), legendY, it.label, { size: 11, fill: it.fill }));
    lx += lgWidths[i] + 16;
  }

  let within = 0;
  paired.forEach((p, i) => {
    const yc = yTop + i * rowH + rowH / 2;
    const inside = Math.abs(p.gd - p.td) <= FLOOR_D;
    if (inside) within += 1;
    const colour = inside ? MUTED : BEFORE;
    body.push(`<rect x="${xOf(p.td - FLOOR_D).toFixed(1)}" y="${yc - 7}" width="${(xOf(p.td + FLOOR_D) - xOf(p.td - FLOOR_D)).toFixed(1)}" height="14" fill="${GRID}" rx="2"/>`);
    body.push(text(x0 - 14, yc + 4, p.clip, { size: 11, anchor: 'end' }));
    body.push(`<line x1="${xOf(p.td).toFixed(1)}" y1="${yc}" x2="${xOf(p.gd).toFixed(1)}" y2="${yc}" stroke="${colour}" stroke-width="2"/>`);
    body.push(`<circle cx="${xOf(p.td).toFixed(1)}" cy="${yc}" r="5" fill="${KNOCKOUT}" stroke="${INK}" stroke-width="1.6"/>`);
    body.push(`<circle cx="${xOf(p.gd).toFixed(1)}" cy="${yc}" r="5" fill="${colour}"/>`);
    body.push(text(x1 + 16, yc + 4, signed(p.gd - p.td, 3), { size: 11.5, fill: colour, weight: 600, family: MONO }));
  });
  body.push(text(x1 + 16, yTop - 10, 'gap', { size: 11, fill: MUTED }));

  const gaps = paired.map((p) => p.gd - p.td);
  const note = `The ±${FLOOR_D} LSE-D floor is not measured on this dataset: it is a single pair of regenerations of one production clip, n=1, carried here. ` +
    `It bounds what a same-build re-run of the same input moves the metric by, so a gap inside it cannot be told apart from re-encode noise — but it is one observation, not an interval, and it came from a different corpus. ` +
    `${paired.length - within} clips clear it; the largest gap is ${signed(Math.max(...gaps), 3)} and the mean is ${signed(mean(gaps), 3)}. ` +
    `Ground truth is not a ceiling here: on ${gaps.filter((g) => g < 0).length} clip${gaps.filter((g) => g < 0).length === 1 ? '' : 's'} the generated video scores better than the real footage it came from, which is a fact about the metric.`;

  write('04-quality-paired.svg', frame(W, canvasHeight(W, yBot, note),
    `${within} of ${paired.length} clips are indistinguishable from their own real footage`,
    `Measured LSE-D under the published SyncNet protocol. Each generated clip is joined to the real footage it was made from, so the comparison is within-clip. ` +
    `Rows sorted by gap; colour is whether the gap clears the noise floor.`,
    body.join('\n'), note));
}

// --- 5. what a job actually bills -------------------------------------------

function figureCostComposition() {
  const m = stageMeans(lipsync);
  const stageTotal = sum(Object.values(m));
  const unattributed = PREDICT_TIME_S - stageTotal;
  const billed = COLD_START_S + PREDICT_TIME_S;

  const rows = [
    ...STAGE_ORDER.filter((s) => s in m).map((s) => ({
      label: STAGE_LABEL[s], v: m[s], kind: SOURCE_ONLY.has(s) ? 'prefix' : 'stage',
    })),
    { label: 'Container cold start', v: COLD_START_S, kind: 'nonstage' },
    { label: 'Unattributed in-container', v: unattributed, kind: 'nonstage' },
  ].sort((a, b) => b.v - a.v);

  const W = 900;
  const x0 = 244, x1 = W - 176, yTop = 152, rowH = 27;
  const yBot = yTop + rows.length * rowH;
  const { max, ticks } = scaleTo(per1000(Math.max(...rows.map((r) => r.v))));
  const xOf = (usdV) => x0 + (usdV / max) * (x1 - x0);
  const label = (r) => `${usd(per1000(r.v))} · ${fmt((100 * r.v) / billed, 1)}%`;

  assertFits('05-cost-composition', 'line item', rows.map((r) => r.label), 12, x0 - 14 - 32);
  assertFits('05-cost-composition', 'bar value', rows.map(label), 12, W - 32 - (x1 + 10));

  const body = [];
  body.push(xAxis(yTop - 10, yBot, xOf, ticks, (t) => `$${t}`));
  body.push(captionRow('05-cost-composition', W, `cost per 1000 videos at ${usd(DEFAULT_RATE.usdPerHour)}/GPU-hour`, W - 32, [
    { colour: NEUTRAL, label: 'source-only prefix' },
    { colour: INK, label: 'audio-dependent stage' },
    { colour: AMBER, label: 'billed, but not a stage' },
  ]));

  rows.forEach((r, i) => {
    const yc = yTop + i * rowH + rowH / 2;
    const h = 17;
    const colour = r.kind === 'nonstage' ? AMBER : r.kind === 'prefix' ? NEUTRAL : INK;
    body.push(text(x0 - 14, yc + 4, r.label, { size: 12, anchor: 'end', weight: r.kind === 'nonstage' ? 650 : 500 }));
    body.push(`<rect x="${x0}" y="${yc - h / 2}" width="${Math.max(xOf(per1000(r.v)) - x0, 1.5).toFixed(1)}" height="${h}" fill="${colour}" rx="2"/>`);
    body.push(text((Math.max(xOf(per1000(r.v)), x0 + 2) + 10).toFixed(1), yc + 4, label(r), { size: 12, weight: 600, fill: colour }));
  });

  const biggestStage = rows.find((r) => r.kind !== 'nonstage');
  const note = `Cold start is ${fmt(COLD_START_S)} s, ${fmt((100 * COLD_START_S) / billed, 1)}% of the billed total and ` +
    `${fmt(COLD_START_S / biggestStage.v, 2)}× the largest stage — and the deployment's cooldown is set to 30 s against it, ` +
    `so the machine is torn down long before the next job can reuse it. ` +
    `The unattributed ${fmt(unattributed)} s is metered predict time the stage timers never account for: downloads, length adjustment, uploads. ` +
    `A cost model built on the stage sum alone understates the GPU seconds actually bought by ${fmt((100 * unattributed) / stageTotal, 0)}%. ` +
    `Seconds are measured; the money is modelled from one input, printed here: ${DEFAULT_RATE.label} at ${usd(DEFAULT_RATE.usdPerHour)}/GPU-hour. ` +
    `The GPU model behind the production runs is recorded nowhere in the logs or the deployment config, so that rate cannot be reconciled against the hardware that produced these timings.`;

  write('05-cost-composition.svg', frame(W, canvasHeight(W, yBot, note),
    'The largest single line on the bill is not a stage at all',
    `Cost per 1000 videos, sorted. Stage seconds are measured means over n=${lipsync.length} production runs; cold start and the remainder come from the ` +
    `platform's own metering. Shares are of the ${fmt(billed)} s billed total, not the ${fmt(stageTotal)} s of stages.`,
    body.join('\n'), note));
}

// --- 6. the cacheable prefix ------------------------------------------------

function figureCacheablePrefix() {
  const workloads = [
    { label: 'Production lipsync', runs: lipsync },
    { label: 'Production word replacement', runs: wr },
  ].map((w) => {
    const m = stageMeans(w.runs);
    const tot = sum(Object.values(m));
    const pre = prefixOf(m);
    return { ...w, m, tot, pre, rest: tot - pre, share: (100 * pre) / tot };
  });

  const W = 900;
  const x0 = 262, x1 = W - 132, yTop = 168, rowH = 104;
  const yBot = yTop + workloads.length * rowH;
  const { max, ticks } = scaleTo(Math.max(...workloads.map((w) => w.tot)));
  const xOf = (v) => x0 + (v / max) * (x1 - x0);

  const captions = workloads.map((w) =>
    `source-only prefix ${fmt(w.pre)} s (${fmt(w.share, 1)}%) · audio-dependent remainder ${fmt(w.rest)} s (${fmt(100 - w.share, 1)}%)`);
  assertFits('06-cacheable-prefix', 'workload name', workloads.map((w) => w.label), 12.5, x0 - 16 - 32);
  assertFits('06-cacheable-prefix', 'split caption', captions, 11, x1 - x0);
  assertFits('06-cacheable-prefix', 'bar total', workloads.map((w) => `${fmt(w.tot)} s`), 12, W - 32 - (x1 + 10));
  assertFits('06-cacheable-prefix', 'run count (mono)', workloads.map((w) => `n=${w.runs.length} measured runs`), 10.5, x0 - 16 - 32, true);

  const body = [];
  body.push(xAxis(yTop - 14, yBot, xOf, ticks, (t) => `${t}`));
  body.push(captionRow('06-cacheable-prefix', W, 'mean pipeline seconds per video', W - 32, [
    { colour: NEUTRAL, label: 'source-only prefix — cacheable' },
    { colour: INK, label: 'audio-dependent' },
  ]));

  workloads.forEach((w, i) => {
    const yc = yTop + i * rowH + 38;
    const h = 36;
    body.push(text(x0 - 16, yc - 2, w.label, { size: 12.5, anchor: 'end', weight: 650 }));
    body.push(text(x0 - 16, yc + 14, `n=${w.runs.length} measured runs`, { size: 10.5, anchor: 'end', fill: MUTED, family: MONO }));
    const preW = xOf(w.pre) - x0;
    body.push(`<rect x="${x0}" y="${yc - h / 2}" width="${Math.max(preW, 1.5).toFixed(1)}" height="${h}" fill="${NEUTRAL}" rx="2"/>`);
    body.push(`<rect x="${xOf(w.pre).toFixed(1)}" y="${yc - h / 2}" width="${Math.max(xOf(w.tot) - xOf(w.pre), 1.5).toFixed(1)}" height="${h}" fill="${INK}" rx="2"/>`);
    // The share goes inside the prefix segment when it fits, and above it on a leader when
    // it does not — which is exactly the case for the smaller workload.
    const shareLabel = `${fmt(w.share, 1)}% cacheable`;
    if (measure(shareLabel, 13) + 24 < preW) {
      body.push(text(x0 + 12, yc + 5, shareLabel, { size: 13, fill: KNOCKOUT, weight: 650 }));
    } else {
      const cx = x0 + preW / 2;
      body.push(`<line x1="${cx.toFixed(1)}" y1="${yc - h / 2}" x2="${cx.toFixed(1)}" y2="${yc - h / 2 - 12}" stroke="${NEUTRAL}" stroke-width="1"/>`);
      body.push(text(cx.toFixed(1), yc - h / 2 - 17, shareLabel, { size: 13, fill: NEUTRAL, weight: 650, anchor: 'middle' }));
    }
    body.push(text((xOf(w.tot) + 10).toFixed(1), yc + 5, `${fmt(w.tot)} s`, { size: 12, weight: 600 }));
    body.push(text(x0, yc + h / 2 + 22, captions[i], { size: 11, fill: MUTED }));
  });

  const [ls, wrw] = workloads;
  const note = `The prefix share is ${fmt(wrw.share, 1)}% for word replacement against ${fmt(ls.share, 1)}% for lipsync, because word replacement re-runs the entire source analysis to change a few seconds of speech. ` +
    `Measured seconds, but the saving is modelled and is an upper bound, not a result: a cache cannot hit until the frame time-warp RNG is seeded, and today nothing seeds it, so two runs on the same source do not produce reusable intermediates. ` +
    `The word-replacement cohort is also six replicas of one fixture — same source, same transcript, one changed segment — so it measures one workload six times rather than six workloads.`;

  write('06-cacheable-prefix.svg', frame(W, canvasHeight(W, yBot, note),
    'Word replacement spends most of its pipeline re-analysing a video it has already seen',
    `Measured mean pipeline seconds, split at the animator: the four stages before it take no audio input, so for any job reusing a source video they recompute identical results. ` +
    `n=${ls.runs.length} lipsync and n=${wrw.runs.length} word-replacement production runs.`,
    body.join('\n'), note));
}

// --- 7. GPU work against CPU-only work --------------------------------------

function figureGpuVsCpu() {
  const workloads = [
    { label: 'Production lipsync', runs: lipsync },
    { label: 'Production word replacement', runs: wr },
    { label: 'HDTF self-driven', runs: hdtfSelf },
  ].map((w) => {
    let cpu = 0, gpu = 0;
    for (const r of w.runs) {
      for (const [k, v] of Object.entries(r.job)) {
        if (CPU_ONLY.has(k)) cpu += v / w.runs.length; else gpu += v / w.runs.length;
      }
    }
    return { ...w, cpu, gpu, tot: cpu + gpu, share: (100 * cpu) / (cpu + gpu) };
  });

  const W = 900;
  const x0 = 272, x1 = W - 168, yTop = 158, rowH = 88;
  const yBot = yTop + workloads.length * rowH;
  const { max, ticks } = scaleTo(Math.max(...workloads.map((w) => w.tot)), 7);
  const xOf = (v) => x0 + (v / max) * (x1 - x0);

  assertFits('07-gpu-vs-cpu', 'workload name', workloads.map((w) => w.label), 12.5, x0 - 16 - 32);
  assertFits('07-gpu-vs-cpu', 'workload detail (mono)', workloads.map((w) => `n=${w.runs.length} · ${fmt(w.tot)} s job`), 10.5, x0 - 16 - 32, true);
  assertFits('07-gpu-vs-cpu', 'share value', workloads.map((w) => `${fmt(w.share, 1)}% CPU-only`), 12, W - 32 - (x1 + 10));

  const body = [];
  body.push(xAxis(yTop - 14, yBot, xOf, ticks, (t) => `${t}`));
  body.push(captionRow('07-gpu-vs-cpu', W, 'mean job seconds per video, all billed at the GPU machine rate', W - 32, [
    { colour: INK, label: 'needs the GPU' },
    { colour: AMBER, label: 'CPU-only: ffmpeg, transfers' },
  ]));

  workloads.forEach((w, i) => {
    const yc = yTop + i * rowH + 34;
    const h = 34;
    body.push(text(x0 - 16, yc - 2, w.label, { size: 12.5, anchor: 'end', weight: 650 }));
    body.push(text(x0 - 16, yc + 14, `n=${w.runs.length} · ${fmt(w.tot)} s job`, { size: 10.5, anchor: 'end', fill: MUTED, family: MONO }));
    const gpuW = xOf(w.gpu) - x0;
    const cpuW = xOf(w.tot) - xOf(w.gpu);
    body.push(`<rect x="${x0}" y="${yc - h / 2}" width="${Math.max(gpuW, 1.5).toFixed(1)}" height="${h}" fill="${INK}" rx="2"/>`);
    body.push(`<rect x="${xOf(w.gpu).toFixed(1)}" y="${yc - h / 2}" width="${Math.max(cpuW, 1.5).toFixed(1)}" height="${h}" fill="${AMBER}" rx="2"/>`);
    const gpuLabel = `GPU ${fmt(w.gpu)} s`;
    if (measure(gpuLabel, 12) + 24 < gpuW) body.push(text(x0 + 12, yc + 4, gpuLabel, { size: 12, fill: KNOCKOUT, weight: 600 }));
    const cpuLabel = `${fmt(w.cpu)} s`;
    if (measure(cpuLabel, 11) + 16 < cpuW) {
      body.push(text((xOf(w.gpu) + 8).toFixed(1), yc + 4, cpuLabel, { size: 11, fill: KNOCKOUT, weight: 600 }));
    } else {
      // Too narrow to label in place: drop a leader below the bar rather than overprint it.
      const cx = xOf(w.gpu) + cpuW / 2;
      body.push(`<line x1="${cx.toFixed(1)}" y1="${yc + h / 2}" x2="${cx.toFixed(1)}" y2="${yc + h / 2 + 12}" stroke="${AMBER}" stroke-width="1"/>`);
      body.push(text(cx.toFixed(1), yc + h / 2 + 26, `${fmt(w.cpu)} s CPU-only`, { size: 11, fill: AMBER, anchor: 'middle', weight: 600 }));
    }
    body.push(text((xOf(w.tot) + 10).toFixed(1), yc + 4, `${fmt(w.share, 1)}% CPU-only`, { size: 12, weight: 650, fill: AMBER }));
  });

  const prod = workloads.filter((w) => w.label.startsWith('Production'));
  const note = `The two production workloads spend ${fmt(Math.min(...prod.map((w) => w.share)), 1)}–${fmt(Math.max(...prod.map((w) => w.share)), 1)}% of their job on the CPU alone, ` +
    `dominated by downloading and re-encoding the source. The HDTF cohort falls to ${fmt(workloads.at(-1).share, 1)}% only because its inputs are local 30 s clips rather than full-length customer uploads — ` +
    `an open-dataset benchmark understates this cost by construction. Measured job stages, classified by whether the stage needs a GPU at all; ` +
    `moving that work off the accelerator is a rate difference rather than a time saving, and it adds a network hop for the largest artefact in the job, which has not been measured.`;

  write('07-gpu-vs-cpu.svg', frame(W, canvasHeight(W, yBot, note),
    'A sixth of a production job holds a GPU without using one',
    `Measured job-level timings, n=${lipsync.length}, ${wr.length} and ${hdtfSelf.length} runs. CPU-only means ffmpeg length adjustment, segment splitting and stitching, ` +
    `audio attachment, job setup and S3 transfers — every second of which is billed at the GPU machine rate.`,
    body.join('\n'), note));
}

// --- 8. throughput per GPU-hour ---------------------------------------------

function figureThroughput() {
  const lsM = stageMeans(lipsync);
  const wrM = stageMeans(wr);
  const lsTot = sum(Object.values(lsM));
  const wrTot = sum(Object.values(wrM));
  const wrCached = wrTot - prefixOf(wrM);

  const rows = [
    { label: 'Lipsync', sub: `as deployed · ${fmt(lsTot)} s/video`, v: lsTot, colour: INK, modelled: false },
    { label: 'Word replacement', sub: `as deployed · ${fmt(wrTot)} s/video`, v: wrTot, colour: INK, modelled: false },
    { label: 'Word replacement', sub: `source prefix cached · ${fmt(wrCached)} s/video`, v: wrCached, colour: AFTER, modelled: true },
  ].map((r) => ({ ...r, thru: throughputPerGpuHour(r.v) }));

  const W = 860;
  const x0 = 292, x1 = W - 118, yTop = 170, rowH = 60;
  const yBot = yTop + rows.length * rowH;
  const { max, ticks } = scaleTo(Math.max(...rows.map((r) => r.thru)), 7);
  const xOf = (v) => x0 + (v / max) * (x1 - x0);

  assertFits('08-throughput', 'scenario name', rows.map((r) => r.label), 13, x0 - 16 - 32);
  assertFits('08-throughput', 'scenario detail (mono)', rows.map((r) => r.sub), 10.5, x0 - 16 - 32, true);
  assertFits('08-throughput', 'bar value', rows.map((r) => fmt(r.thru, 1)), 13, W - 32 - (x1 + 10));

  const body = [];
  body.push(xAxis(yTop - 14, yBot, xOf, ticks, (t) => `${t}`));
  body.push(captionRow('08-throughput', W, 'videos per GPU-hour — rate-independent', W - 32, [
    { colour: INK, label: 'measured, as deployed' },
    { colour: AFTER, label: 'modelled ceiling' },
  ]));

  rows.forEach((r, i) => {
    const yc = yTop + i * rowH + rowH / 2;
    const h = 26;
    body.push(text(x0 - 16, yc - 2, r.label, { size: 13, anchor: 'end', weight: 650, fill: r.colour }));
    body.push(text(x0 - 16, yc + 14, r.sub, { size: 10.5, anchor: 'end', fill: MUTED, family: MONO }));
    body.push(`<rect x="${x0}" y="${yc - h / 2}" width="${Math.max(xOf(r.thru) - x0, 1.5).toFixed(1)}" height="${h}" fill="${r.colour}" rx="2"/>`);
    body.push(text((xOf(r.thru) + 10).toFixed(1), yc + 5, fmt(r.thru, 1), { size: 13, weight: 650, fill: r.colour }));
    if (r.modelled) body.push(text(x0 + 12, yc + 5, 'upper bound', { size: 11, fill: KNOCKOUT, weight: 600 }));
  });

  const note = `This is the planning unit for hardware kept warm, and cold start is excluded by construction — amortised across a queue rather than billed per job. ` +
    `A job that pays the ${fmt(COLD_START_S)} s boot achieves none of these figures, and at the deployed 30 s cooldown most jobs pay it. ` +
    `The cached row is modelled rather than measured: it removes the source-only prefix outright, so it is the ceiling on a perfect cache — ` +
    `${fmt(rows[2].thru / rows[1].thru, 2)}× the deployed word-replacement rate. Nothing seeds the frame time-warp RNG today, so that ceiling is not currently reachable.`;

  write('08-throughput.svg', frame(W, canvasHeight(W, yBot, note),
    'Videos per GPU-hour, which is the unit a capacity plan is written in',
    `Derived from measured pipeline seconds: n=${lipsync.length} lipsync and n=${wr.length} word-replacement production runs. ` +
    `Rate-independent, so it survives the fact that the GPU model behind the production runs is recorded nowhere.`,
    body.join('\n'), note));
}

// --- run ---------------------------------------------------------------------

console.log('figures →', outDir);
figureStageProfile();
figureArmsPaired();
figureResolution();
figureQuality();
figureCostComposition();
figureCacheablePrefix();
figureGpuVsCpu();
figureThroughput();

// Hand-authored SVG has no layout engine, so the widest label in every allocated space is
// reported rather than assumed. assertFits above throws if any of these overflowed.
console.log('\nwidest label per allocated space (estimated advance width, px):');
for (const b of BUDGETS) {
  console.log(`  ${b.figure.padEnd(30)} ${b.what.padEnd(22)} ${b.width.toFixed(0).padStart(4)} / ${b.budget.toFixed(0).padStart(4)}  "${b.label}"`);
}
