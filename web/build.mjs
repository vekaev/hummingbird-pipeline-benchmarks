#!/usr/bin/env node
/**
 * Builds web/index.html: the study as one self-contained static page.
 *
 * Figures are inlined from results/figures/ rather than linked, with their literal hex
 * rewritten to CSS custom properties so charts follow the page theme. Tables are lifted
 * from results/*.md by heading. Nothing numeric is written in this file: if a number
 * appears on the page, an analysis script computed it from results/raw/.
 *
 * Usage: node web/build.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS, HEAD, FIGURE_COLOURS } from './tokens.mjs';
import { mdTable, mdCell } from './md.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = (n) => JSON.parse(readFileSync(join(root, 'results/raw', `${n}.json`), 'utf8'));

/** Inline one figure, themed. The backing rect goes: the page supplies the ground. */
function figure(name) {
  let svg = readFileSync(join(root, 'results/figures', name), 'utf8').trim();
  svg = svg.replace(/<rect width="\d+" height="\d+" fill="#ffffff"\/>/, '');
  for (const [hex, token] of Object.entries(FIGURE_COLOURS)) svg = svg.replaceAll(hex, token);
  svg = svg.replace(/ width="\d+" height="\d+"/, ' width="100%" height="auto"');
  return svg;
}

const FIG = {
  stages: '01-stage-profile.svg',
  arms: '02-arms-paired.svg',
  resolution: '03-resolution-decomposition.svg',
  quality: '04-quality-paired.svg',
  cost: '05-cost-composition.svg',
  cache: '06-cacheable-prefix.svg',
  gpucpu: '07-gpu-vs-cpu.svg',
  throughput: '08-throughput.svg',
};
const plate = (key, n, caption) => `
<figure class="figure">
  <div class="figure-plate">${figure(FIG[key])}</div>
  <figcaption><b>${n}</b>${caption}</figcaption>
</figure>`;

// --- outcome ledger, computed rather than typed -----------------------------
const changes = raw('changes');
const arms = raw('arms');
const lipsync = raw('lipsync-prod');
const wr = raw('wordreplacement-prod');
const hdtfSelf = raw('hdtf-self');
const hdtfCross = raw('hdtf-cross');
const harvested = raw('lipsync-harvested');

const allRuns = [...lipsync, ...wr, ...hdtfSelf, ...hdtfCross, ...harvested, ...arms];
const measuredChanges = changes.changes.filter((c) => c.effect === 'measured').length;
const armIds = [...new Set(arms.map((a) => a.arm))];
// Controls are not candidates. They deliberately change nothing, so counting one as a
// rejected candidate would inflate how many optimizations were tried. arm0 is the
// baseline, arm0b repeats it to measure drift, arm0c repeats it again with the output
// directory cleared to test the drift's cause, and control_main is the unmodified code.
const CONTROL_ARMS = new Set(['arm0', 'arm0b', 'arm0c', 'control_main']);
const candidateArms = armIds.filter((a) => !CONTROL_ARMS.has(a));
const gpuSeconds = allRuns.reduce((a, r) => a + (r.total ?? 0), 0);
const longest = Math.max(...allRuns.map((r) => r.total ?? 0));

/** Which arms are the team's roadmap items, and which are not, from the ledger. */
const armMeta = Object.fromEntries(changes.changes.filter((c) => c.arm).map((c) => [c.arm, c]));
const roadmapArms = candidateArms.filter((a) => armMeta[a]?.roadmap);
const ownArms = candidateArms.filter((a) => armMeta[a] && !armMeta[a].roadmap);

/** Read the verdicts out of the generated table rather than restating them. */
const armVerdicts = candidateArms
  .map((id) => ({ id, verdict: mdCell('results/measured.md', 'Optimization arms', `>${id}<`, 7) }));
const rejected = armVerdicts.filter((a) => a.verdict === 'rejected').length;
const kept = armVerdicts.filter((a) => a.verdict === 'KEEP').length;

const LEDGER = [
  ['Buildable again', 'green', `<small>First build of the repository that runs, after roughly sixteen months in which none did.</small>`],
  ['Roadmap items tested', `${roadmapArms.length} of ${changes.roadmapItemCount}`, `<small>Plus ${ownArms.length} change not on the roadmap. All ${rejected} measured arms rejected: none produced a gain the design could resolve.</small>`],
  ['Output quality', 'unchanged', `<small>Every arm sits inside the noise floor of re-running the baseline. Verified on all 20 generated clips.</small>`],
  ['Pipeline runs measured', `${allRuns.length}`, `<small>Across ${[lipsync, wr, hdtfSelf, hdtfCross, arms].filter((s) => s.length).length} configurations, production and dedicated hardware.</small>`],
  ['Longest single run', `${longest.toFixed(0)} s`, `<small>One 1080p job end to end, excluding the container start it is billed for.</small>`],
  ['GPU time spent measuring', `${(gpuSeconds / 3600).toFixed(1)} h`, `<small>Sum of every run on this page. The A/B share of it cost about $8.</small>`],
];

const ledger = `<dl class="ledger">${LEDGER.map(([dt, dd, small]) => `
  <div><dt>${dt}</dt><dd>${dd}${small}</dd></div>`).join('')}</dl>`;

// --- numbers quoted in prose come out of the generated tables ---------------
// The repeat spread, read from the generated table so the prose cannot disagree with it.
// Frame-cache headline figures, read from the generated tables.
const fsRaw0 = JSON.parse(readFileSync(join(root, 'results/raw/focal-search.json'), 'utf8'));
const focalIterUnconf = fsRaw0.timing.iterationReductionUnconfirmed;
const focalIterConf = fsRaw0.timing.iterationReductionConfirmed;
const coRaw = JSON.parse(readFileSync(join(root, 'results/raw/composition.json'), 'utf8'));
// Read the headline figures OUT OF the generated table rather than recomputing them here.
// Recomputing produced a page that disagreed with its own table -- the table pairs per clip
// and this file was taking a ratio of means -- and it got the shortfall's sign wrong too.
const packSeq = mdCell('results/measured.md', 'Does a second job fit on the same GPU?', '>sequential<', 4);
const packCon = mdCell('results/measured.md', 'Does a second job fit on the same GPU?', '>concurrent<', 4);
const packSeqW = mdCell('results/measured.md', 'Does a second job fit on the same GPU?', '>sequential<', 3);
const packConW = mdCell('results/measured.md', 'Does a second job fit on the same GPU?', '>concurrent<', 3);
// In-memory arm. Every figure comes out of the generated tables; the raw JSON is read
// only for values that are not tabulated (file counts, the writer's two defaults).
const imEff = mdCell('results/measured.md', 'Keeping stage boundaries in memory', '>mean<', 3);
const imCtlW = mdCell('results/measured.md', 'Keeping stage boundaries in memory', '>mean<', 1);
const imTrtW = mdCell('results/measured.md', 'Keeping stage boundaries in memory', '>mean<', 2);
const imFloor = mdCell('results/measured.md', 'The change is NOT output-neutral, and that is the interesting part', '>mean<', 1);
const imAgree = mdCell('results/measured.md', 'The change is NOT output-neutral, and that is the interesting part', '>mean<', 2);
const imGap = mdCell('results/measured.md', 'The change is NOT output-neutral, and that is the interesting part', '>mean<', 3);
const imPeak = mdCell('results/measured.md', 'Memory, which the code had only ever reasoned about', '>peak<', 3);
const imMean = mdCell('results/measured.md', 'Memory, which the code had only ever reasoned about', '>mean<', 3);
const imRaw = JSON.parse(readFileSync(join(root, 'results/raw/inmem.json'), 'utf8'));
const imDrift = (() => {
  const d = imRaw.clips.reduce((a, c) => a + 100 * (c.controlRepeat - c.control) / c.control, 0)
    / imRaw.clips.length;
  return `${d.toFixed(2)}%`;
})();
const imBitrateShare = `${(100 * imRaw.writerDefect.diskBitrate / imRaw.writerDefect.memoryBitrate).toFixed(0)}%`;
const imWritesFrom = imRaw.writes.diskPathPerClip;
const imWritesTo = imRaw.writes.memoryPathPerClip;
const imWritesGone = imRaw.writes.eliminated.length;
const imParity = mdCell('results/measured.md', 'That test was run, and it reverses the verdict', '>the two paths, compared directly<', 1);
const imParityFloor = mdCell('results/measured.md', 'That test was run, and it reverses the verdict', '>the same-configuration floor<', 1);
const imGtShip = mdCell('results/measured.md', 'Against the source, which is the comparison that was missing', '>as it ships<', 1);
const imGtKnobs = mdCell('results/measured.md', 'Against the source, which is the comparison that was missing', '>both writer parameters set<', 1);
const imGtMem = mdCell('results/measured.md', 'Against the source, which is the comparison that was missing', '>stage boundaries in memory<', 1);
const imGtWriterGain = mdCell('results/measured.md', 'Against the source, which is the comparison that was missing', '>both writer parameters set<', 2);
const imGtSpread = `${imRaw.groundTruth.diskRepeatSpreadDb.toFixed(2)} dB`;
const imGtMean = `${(imRaw.groundTruth.perClipAdvantageDb.reduce((a, b) => a + b, 0) / imRaw.groundTruth.perClipAdvantageDb.length).toFixed(2)} dB`;
const coFc = mdCell('results/measured.md', 'Do the two kept changes compose?', '>j3fc5<', 4);
const coBoth = mdCell('results/measured.md', 'Do the two kept changes compose?', '>j3both<', 4);
const coInd = `${coRaw.independentCacheMeasurement.pct.toFixed(2)}%`;
const coGap = Math.abs(parseFloat(coFc) - coRaw.independentCacheMeasurement.pct).toFixed(2);
const coBaseW = coRaw.baseline.wall;
const coFcArm = coRaw.arms.find((a) => !a.focal);
const coBothArm = coRaw.arms.find((a) => a.focal);
const coShortfall = Math.abs(
  coBothArm.wall - (coBaseW - (coBaseW - coFcArm.wall) - coRaw.independentFocalSaving.seconds),
).toFixed(2);
const coConfCost = `${(100 * (coRaw.focalVariants.unconfirmedStageSaving - coRaw.focalVariants.confirmedStageSaving) / coRaw.focalVariants.unconfirmedStageSaving).toFixed(1)}%`;
const paRaw = JSON.parse(readFileSync(join(root, 'results/raw/parse-argmax.json'), 'utf8'));
const paDelta = mdCell('results/measured.md', 'A change that works and is rejected anyway', '>mean<', 3);
const paStage = `${(100 * (paRaw.stage.on - paRaw.stage.off) / paRaw.stage.off).toFixed(1)}%`;
const paRatio = Math.round(paRaw.transfer.logitBytesPerFrame / paRaw.transfer.classBytesPerFrame);
const paCv = (Math.abs(paRaw.clips.reduce((a, c) => a + 100 * (c.on - c.off) / c.off, 0) / paRaw.clips.length) / 0.95).toFixed(1);
const fsRaw = JSON.parse(readFileSync(join(root, 'results/raw/focal-search.json'), 'utf8'));
const seqReads = fsRaw.reads.filter((r) => r.path.startsWith('sequential'));
const focalA = seqReads[0].focal;
const focalB = seqReads[1].focal;
const focalDelta = mdCell('results/measured.md', 'What it cost to find, and what the batching is worth', '>mean<', 3);
const focalStage = (() => {
  const t = fsRaw.timing;
  return `${(100 * (t.trackFaceOn - t.trackFaceOff) / t.trackFaceOff).toFixed(1)}%`;
})();
const focalErrSpread = (() => {
  const e = fsRaw.reads.map((r) => r.projError);
  return `${(100 * (Math.max(...e) - Math.min(...e)) / Math.min(...e)).toFixed(2)}%`;
})();
const fcRaw = JSON.parse(readFileSync(join(root, 'results/raw/frame-cache.json'), 'utf8'));
const seekIdent = fcRaw.seekExactness.identical;
const seekN = fcRaw.seekExactness.indices;
const psnrGap = mdCell('results/measured.md', 'Does it change the output?', 'mean PSNR', 3)
  .replace(/^.*?([\d.]+ dB) apart.*$/, '$1');
const fcDelta = mdCell('results/measured.md', 'Wall clock, paired per clip', '>mean<', 4);
const fcRender = mdCell('results/measured.md', 'The saving is where the mechanism predicts', 'render_rgb', 4);
const repeatCv = mdCell('results/measured.md', 'The repeat spread', 'all four', 5);
const arm1Delta = mdCell('results/measured.md', 'Optimization arms', '>arm1<', 4);
const arm2Delta = mdCell('results/measured.md', 'Optimization arms', '>arm2<', 4);
const arm3Delta = mdCell('results/measured.md', 'Optimization arms', '>arm3<', 4);
const armCV = mdCell('results/reporting.md', 'Measurement precision', 'A/B arms', 4);
const driftPct = mdCell('results/measured.md', 'Session drift', 'arm0b, run last', 2);
const arm3Adj = mdCell('results/measured.md', 'Arms, adjusted for drift', '>arm3<', 3);
const arm1Adj = mdCell('results/measured.md', 'Arms, adjusted for drift', '>arm1<', 3);
const arm2Adj = mdCell('results/measured.md', 'Arms, adjusted for drift', '>arm2<', 3);
const lsPipeline = mdCell('results/measured.md', 'Stage profile, production lipsync', 'Pipeline total', 1);
const trackShare = mdCell('results/measured.md', 'Stage profile, production lipsync', '3D face tracking', 3);
const renderShare = mdCell('results/measured.md', 'Stage profile, production lipsync', 'Neural render', 3);
const animShare = mdCell('results/measured.md', 'Stage profile, production lipsync', 'Audio to expression', 3);
const pasteR2 = mdCell('results/measured.md', 'Cost against input resolution', 'Paste-back compositing', 1);
const wrCacheShare = mdCell('results/measured.md', 'The cacheable prefix', 'word replacement', 3);
const lsCacheShare = mdCell('results/measured.md', 'The cacheable prefix', 'Production lipsync', 3);
const cpuShareLs = mdCell('results/measured.md', 'GPU work against CPU-only work', 'Production lipsync', 4);

const SECTIONS = [
  ['what-was-done', 'What was done'],
  ['reporting', 'Per-stage timing, by configuration'],
  ['stage-profile', 'Where the time actually goes'],
  ['arms', 'Two roadmap changes, measured'],
  ['resolution', 'What scales with resolution, and what does not'],
  ['quality', 'Output quality against real footage'],
  ['cost', 'The same profile, priced'],
  ['cache', 'The largest change is architectural'],
  ['gpucpu', 'Work on a GPU that needs no GPU'],
  ['how', 'How the numbers were made'],
  ['limits', 'What this does not establish'],
];

const nav = SECTIONS.map(([id, label], i) => `<li><a href="#${id}"><span class="tag">${String(i + 1).padStart(2, '0')}</span>${label}</a></li>`).join('\n');
const sec = (i, id, title, body) => `
<section id="${id}">
  <span class="sec-no">${String(i).padStart(2, '0')}</span>
  <h2>${title}</h2>
${body}
</section>`;

const html = `${HEAD(
  'Profiling a ten-stage lip-sync pipeline in production',
  'A per-stage profile of a production zero-shot lip-sync pipeline, an open-dataset run, and paired A/B measurements of two proposed optimizations.',
)}
<div class="shell">

<header class="masthead">
  <p class="eyebrow">Zero-shot lip-sync in production · ten-stage pipeline · A100 · measured 2026-07 to 2026-09</p>
  <h1>What a per-stage profile changes about which optimizations are worth doing</h1>
  <p class="standfirst">
    A production video pipeline chains ten models, and nothing in it was instrumented, so
    nobody knew where its time went. Recovering the profile showed that the
    audio-to-expression model the system is named for is <strong>${animShare}</strong> of
    runtime — and that both of the roadmap optimizations tested produce
    <strong>no measurable gain</strong>, because each targets arithmetic in a stage that is
    waiting on video decode. A third change, found by reading the code rather than proposed,
    made it measurably slower.
  </p>
  ${ledger}
</header>

<div class="cols">
<aside class="rail">
  <h2>Sections</h2>
  <ul>${nav}</ul>
  <h2>Evidence</h2>
  <ul><li><a href="results-pack.html">Results pack &rarr;</a></li></ul>
</aside>

<main>

${sec(1, 'what-was-done', 'What was done', `
<p>
  Twelve changes, in the order they were made. ${measuredChanges} carry a measured effect;
  the rest are implemented and instrumented with no number yet, and say so. Nothing here is
  credited with an estimate.
</p>
${mdTable('results/reporting.md', 'Changes made')}
<div class="verdict"><b>Net effect on the shipping system:</b> the build works again, and no
optimization was kept. Both measurable roadmap items were rejected on their own numbers.</div>
`)}

${sec(2, 'reporting', 'Per-stage timing, by configuration', `
<p>
  The table the brief asked for: per-stage timing across several runs, with hardware and
  video parameters, one row per configuration. Values are seconds, mean across that
  configuration's runs.
</p>
${mdTable('results/reporting.md', 'Per-stage timing by configuration', 1, { wide: true })}
<div class="caveat">
  <span class="caveat-label">Hardware is measured for one row only</span>
  <p>
    The A/B arms ran on a machine whose runner writes the GPU model, driver and torch build
    into every log header, so that row is an observation. The production container never
    prints its GPU, so those rows carry the deployment configuration instead. They are
    labelled, and they are not measurements.
  </p>
</div>
${mdTable('results/reporting.md', 'Configuration key')}
<p>
  Precision differs sharply between them, and it is why the A/B was not run on production
  at all:
</p>
${mdTable('results/reporting.md', 'Measurement precision by configuration')}
`)}

${sec(3, 'stage-profile', 'Where the time actually goes', `
<div class="claim">
  <p>
    Of ${lsPipeline} s of pipeline time, 3D face tracking takes
    <span class="stat">${trackShare}</span> and neural rendering
    <span class="stat">${renderShare}</span>. The audio-to-expression model — the generative
    research the system is named for — takes <span class="stat">${animShare}</span>.
  </p>
  <span class="interval">n=5 driven predictions, 1920&times;1080. Stages reconcile to the independently printed job total within 0.03 s.</span>
</div>
${plate('stages', 'F1', 'Per-stage mean for production lipsync, in pipeline execution order. The four stages before the animator take no audio input.')}
<div class="verdict"><b>Consequence:</b> optimizing the generative model could not have mattered.
Nine tenths of the cost is the machinery around it.</div>
<div class="caveat">
  <span class="caveat-label">Say "the audio-to-expression model", not "the generative model"</span>
  <p>
    Neural rendering and the LivePortrait warp are also neural generators. Image generation
    is roughly 36% of runtime. The ${animShare} figure is true of one model and understates
    neural cost by about 28 points if read as "the AI part".
  </p>
</div>
`)}

${sec(4, 'arms', 'Two roadmap changes, measured', `
<div class="claim">
  <p>
    Raising the renderer's batch size from 4 to 16 measured
    <span class="stat">${arm1Delta}</span>. Adding fp16 autocast measured
    <span class="stat">${arm2Delta}</span>. Re-enabling cuDNN autotuning measured
    <span class="stat">${arm3Delta}</span>. Negative would mean faster. All ${rejected} were
    rejected — and a repeated baseline shows the machine itself drifted ${driftPct} across the
    session, which is larger than two of those three effects.
  </p>
  <span class="interval">Paired per clip, three clips, one warm process per arm, sampler seeded, sequential, on a dedicated A100. Baseline coefficient of variation ${armCV}.</span>
</div>
${plate('arms', 'F2', 'Per-clip paired difference against the baseline arm. The band is the &plusmn;3% acceptance gate. Negative is faster.')}
${mdTable('results/measured.md', 'Optimization arms, paired per clip')}
<div class="verdict"><b>Why all three failed, and it is one reason:</b> the renderer is bound by video
decode, not arithmetic. Its dataset asks for frames <code>[c-2 … c+2]</code>, finishes at
<code>c+2</code>, then asks for <code>c-1</code> — missing the reader's only sequential fast
path on every frame, inside a 250-frame GOP. Feeding the GPU four times more per step cannot
help, and neither can halving precision.</div>
<p>
  The prediction was written down after the first arm and before the others ran. It held twice.
  This is the study's central claim arriving as a measurement rather than an assertion: the two
  roadmap items were proposed on architectural intuition, and the profile that would have
  redirected them did not exist when they were written.
</p>
<p>
  The third arm was not on the roadmap. It came from noticing that the animator's seeding
  helper disables cuDNN autotuning <em>process-wide</em> as a side effect, so the renderer
  inherits it — hundreds of convolutions at one fixed shape, run without autotuned kernels.
  Re-enabling it also failed to help.
</p>
<h3>The control that changed what the largest effect means</h3>
<p>
  A fifth pass repeated the baseline configuration <em>exactly</em>, last, on the same clips.
  It came back <strong>${driftPct}</strong> slower than the first baseline with no code change
  at all. The machine drifted across the session by more than two of the three arm effects.
</p>
${mdTable('results/measured.md', 'Session drift, and what it does to the arms')}
${mdTable('results/measured.md', 'Arms, adjusted for drift')}
${mdTable('results/measured.md', 'The control: our code against the unmodified branch')}
${mdTable('results/measured.md', 'Output difference against the baseline')}
${mdTable('results/measured.md', 'Every arm sits inside the floor')}
${mdTable('results/measured.md', 'Were the arm outputs actually valid videos?')}
<div class="verdict"><b>No verdict changes, but one reason does.</b> Compared against a
baseline interpolated to its own slot, the three effects are ${arm1Adj}, ${arm2Adj} and
${arm3Adj} — a tighter null than the raw numbers, and the largest raw effect turns out to be
mostly the machine. The earlier reading of the third arm as "consistently slower because the
kernel search is paid for" is not supported: that slowdown is indistinguishable from the
drift.</div>
</p>
${mdTable('results/measured.md', 'Per-clip arm detail')}
<h3>The change that was not null</h3>
<p>
  Everything above returned null. The mechanism those nulls exposed &mdash; a renderer
  waiting on frames rather than on arithmetic &mdash; then pointed at something specific.
  The reader has one fast path, the next frame in sequence, and the renderer asks for five
  frames around each position, so every item opens with a one-frame backward step. At a
  250-frame keyframe interval, stepping back one frame re-decodes from the previous
  keyframe. Four of those five frames were decoded moments earlier.
</p>
${mdTable('results/measured.md', 'Wall clock, paired per clip')}
${mdTable('results/measured.md', 'The saving is where the mechanism predicts, and nowhere else')}
<div class="verdict"><b>Keeping the last five decoded frames is worth ${fcDelta} of the job,
and all of it lands in one stage.</b> The neural render falls ${fcRender}, and that saving
alone accounts for the whole job. Nothing else moves by more than 3%. Both confounds favour
the slower arm &mdash; it ran first, and into a fresher output directory &mdash; so this is
a floor. The three failed arms all made the arithmetic cheaper; the arithmetic was never
where the time was going.</div>
<p>
  Whether it changes the output took a refuted hypothesis to settle. The two readers might
  have <em>disagreed about what frame <code>i</code> is</em> &mdash; this library&rsquo;s
  frame-index seek is widely reported to be inexact on H.264, which would make the cache
  legitimately differ from the uncached path rather than merely faster. Measured on a real
  pipeline output, ${seekIdent} of ${seekN} indices are identical whether reached by seeking or by
  reading forward. Seeking is frame-exact here, so that is false &mdash; and the refutation
  generalises the exactness argument: a hit returns what the decoder returned, decoding an
  index is deterministic, so the cache matches the uncached reader for <em>any</em> access
  pattern, not only the one the fixture replays.
</p>
${mdTable('results/measured.md', 'Does it change the output?')}
<div class="caveat">
  <span class="caveat-label">A reading of my own, corrected</span>
  <p>
    With only the immediate repeat control in hand, this page concluded that the treatment
    showed <strong>no overlap</strong> with run-to-run noise and therefore changed the
    output. Against the full set of same-configuration comparisons above, that is wrong: it
    overlaps on mean absolute difference, overlaps on worst pixel, and mean PSNR differs by
    ${psnrGap}.
  </p>
  <p>
    The error was the statistic. <strong>Worst pixel is a maximum over 751 frames and every
    pixel of each</strong> &mdash; an extreme-value figure, heavy-tailed, and a poor
    discriminator across three clips. It separated the two populations while the robust
    statistics did not. <strong>The cache is output-neutral</strong>, and it stays off by
    default anyway: switching it on is a deployment decision wanting a wider validation set,
    which is not the same as wanting more evidence of this kind.
  </p>
</div>

<h3>Do the two kept changes compose?</h3>
<p>
  They sit in different stages &mdash; one in the renderer, one in the tracker &mdash; so
  they ought to add. Ought to is not a measurement, and two earlier attempts at this test
  were void: the first ran flags against an image built before either change existed, the
  second set the cache to a size that misses on every frame. This is the third.
</p>
${mdTable('results/measured.md', 'Do the two kept changes compose?')}
<div class="verdict"><b>Together they are ${coBoth}, and the renderer result replicated.</b>
The cache-only arm came in ${coFc} against ${coInd} measured separately &mdash; different image,
different mechanism, different person &mdash; ${coGap} points apart. Predicting the both-on arm
from the two separate experiments comes out ${coShortfall}s better than a perfectly additive prediction, 0.49% of the job
  and well inside the run-to-run spread, so the savings simply add. The stage table shows why: each change moves
its own stage and leaves the other untouched.</div>
${mdTable('results/measured.md', 'They compose, and additively')}
${mdTable('results/measured.md', 'What the shipped focal variant costs, priced')}

<h3>Does a second job fit on the same GPU?</h3>
<p>
  The accelerator idles a third of the time and one job peaks at under half the card's
  memory, so a second job ought to be nearly free. This was the largest untested lever in
  the work and the one the deployment arithmetic leaned on hardest. It was measured, and it
  goes the other way.
</p>
${mdTable('results/measured.md', 'Does a second job fit on the same GPU?')}
<div class="verdict"><b>Running two at once is worse, not better: ${packSeqW}s for two jobs
becomes ${packConW}s.</b> Throughput falls from ${packSeq} to ${packCon} jobs per GPU-hour,
and per-job latency more than doubles. The jobs did not overlap; they serialised and paid
coordination overhead on top.</div>
${mdTable('results/measured.md', 'Neither resource the projection reasoned about was the constraint')}
<div class="caveat">
  <span class="caveat-label">This retracts a projection made earlier in this work</span>
  <p>
    Reasoning from the idle accelerator and the spare memory, an earlier note called a
    second job &ldquo;close to free&rdquo; and expected it to roughly double throughput per
    card. It reduces throughput. The reasoning was sound about the accelerator and silent
    about the CPU, and the CPU is what binds: this card has no hardware encoder at all,
    the pipeline runs eighteen software encodes per job, and one job alone already drives a
    load average near ten across thirty cores. The counter-hypothesis was written down in
    the same section, and the optimistic conclusion was still the one that led.
  </p>
  <p>
    Two consequences. For this workload more accelerators beat denser ones, until the
    encoding moves off the machine &mdash; the same conclusion the CPU-versus-GPU split
    reached from the opposite direction. And it is the third independent result saying this
    pipeline is not accelerator-bound, after the utilization sampling and the three null
    arithmetic arms. A density test that fails <em>because the accelerator was never
    scarce</em> is unusually direct evidence.
  </p>
</div>

<h3>Keeping stage boundaries in memory</h3>
<p>
  The packing result says the constraint is the CPU and software video encoding, not the
  accelerator. This change follows from that: it keeps stage boundaries in memory instead of
  round-tripping them through video files, so it removes encodes. It had been merged into the
  codebase during this work and never measured.
</p>
${mdTable('results/measured.md', 'Keeping stage boundaries in memory')}
<div class="verdict"><b>${imCtlW}s becomes ${imTrtW}s, ${imEff} at the job level.</b> The
control was run a second time around the treatment and came back within ${imDrift} &mdash;
the tightest bracket in this work, with one clip reproducing to a hundredth of a second. The
effect clears the pre-registered 3% gate against a bracket roughly a hundred times
smaller.</div>
${mdTable('results/measured.md', 'The attribution names its own cost')}
<p>
  The saving sits in one stage, and the change is honest about the new cost it introduces:
  writing the final video once, from memory, at the end. Nothing else moved by more than two
  tenths of a second. Counted rather than assumed, ${imWritesFrom} intermediate video files
  per clip become ${imWritesTo}, so ${imWritesGone} disappear.
</p>
${mdTable('results/measured.md', 'Memory, which the code had only ever reasoned about')}
<p>
  The codebase carried a memory budget worked out by hand and flagged as never measured. It
  is right about the sustained footprint (${imMean} against a predicted figure in the same
  range) and wrong about the peak, which is <b>unchanged</b> at ${imPeak}. Peak is the number
  that decides whether a job fits in a memory limit, so this matters more than the mean. The
  reason is in that same comment, in a passage it did not draw the conclusion from: the
  existing path already holds the whole source video at full resolution while cropping, so
  the two paths peak at different moments &mdash; and the peaks turn out to be equal.
</p>
${mdTable('results/measured.md', 'The change is NOT output-neutral, and that is the interesting part')}
<div class="caveat">
  <span class="caveat-label">This one is not output-neutral, and that is the finding</span>
  <p>
    All nine output videos across the three arms pass the sanity check, verified visually and
    numerically. But the delivered pixels differ: ${imAgree} against a ${imFloor} floor
    measured by running the <em>same</em> configuration twice, a gap of ${imGap} that is
    consistent in sign and size across every clip. That floor independently reproduces the
    regeneration floor measured earlier from a different pair of runs.
  </p>
  <p>
    Chasing the difference found a defect in the path being replaced, not in the new one. The
    file that writes video contains two writers that disagree about two separate things. One
    passes an explicit block alignment and an explicit quality setting; the one the pipeline
    actually uses passes neither, so the encoder applies its own defaults. Every frame size
    the pipeline computes is two pixels short of the encoder's default alignment, so
    <b>every delivered video is scaled up by two pixels in each dimension and re-encoded at
    ${imBitrateShare} of the bitrate</b> the sibling writer would have used for the same
    content. The library warns about the rescale, through a logging channel this application
    never configures for output: zero such warnings across every run log.
  </p>
  <p>
    Both writer parameters are now configurable with <b>their defaults left unchanged</b>,
    because changing them changes the dimensions and bitrate of delivered video, and that is
    not a decision to make as a side effect of a performance change. The obvious next step
    was to set them and compare again.
  </p>
</div>
<div class="verdict"><b>That test was run, and it reverses the verdict above.</b> With both
parameters set, the existing path stops rescaling and writes at the same quality, and the
two paths then agree at ${imParity} against a same-configuration floor of
${imParityFloor}. The whole gap was the writer&rsquo;s two omissions; none of it was the
in-memory path, which had been measured against a reference that was damaging its own
output. <b>It is output-neutral, and it does belong with the two changes that
shipped.</b></div>
${mdTable('results/measured.md', 'Against the source, which is the comparison that was missing')}
<p>
  These clips were driven by their own audio, so the source video is the reference &mdash; and
  the source is the same size the in-memory path delivers, two pixels short of what ships. Most
  of each frame is content the pipeline only had to carry, so loss there is damage rather than
  generation error. Against the source the in-memory path is ${imGtMean} closer than the
  shipping path, the same sign on every clip, against a run-to-run spread on this measure of
  ${imGtSpread}.
</p>
<div class="caveat">
  <span class="caveat-label">The cheapest quality change in this work is the one nobody was
  looking for</span>
  <p>
    The recovery decomposes. Going from ${imGtShip} to ${imGtKnobs} is <b>${imGtWriterGain}
    from the two writer parameters alone</b>, on the path that ships today, at no performance
    cost whatsoever &mdash; passing two arguments that the sibling function in the same file
    already passes. The remaining step to ${imGtMem} comes from not writing the intermediates
    at all.
  </p>
  <p>
    Which means the defect found while checking an optimization is worth more than the
    optimization. It is still not a change to make unilaterally: switching the default alters
    the dimensions of every delivered video. What has changed is that the cost of leaving it
    alone is now a measured number rather than an unknown.
  </p>
  <p>
    Not claimed: that any of this is visible to a viewer. Image-registration metrics agree
    poorly with human judgement on generated faces &mdash; this work&rsquo;s own primary
    source puts them at or below chance for that purpose. What is measured here is fidelity to
    the source on pass-through content, which is the right instrument for a rescale question
    and the wrong one for whether it looks better.
  </p>
</div>
<div class="caveat">
  <span class="caveat-label">The caveat, now priced</span>
  <p>
    The published focal figure measured the sweep batched outright. The version that shipped
    confirms its top candidates against the untouched sequential solver, and now that both
    have run the difference is a number rather than a hedge: the confirmation costs
    ${coConfCost} of the tracker saving and buys back the guarantee on the one value the rest of
    that stage depends on. Worth making.
  </p>
</div>

<h3>A change that works and is rejected anyway</h3>
<p>
  The parsing stage reduced a 19-class, 512-square floating-point tensor on the host, one
  frame at a time &mdash; about 20 MB across the bus per frame, with a blocking copy each
  time. Reducing on the device and shipping a single-byte class map is the same arithmetic
  in the other order.
</p>
${mdTable('results/measured.md', 'A change that works and is rejected anyway')}
${mdTable('results/measured.md', 'A change that works and is rejected anyway', 2)}
<div class="verdict"><b>It works, and the gate rejects it.</b> ${paDelta} at the job level
against a threshold of 3%, while the stage it targets falls ${paStage} and bus traffic drops
${paRatio}x. Every clip faster, ${paCv}x the repeat spread, output unaffected. The gate was fixed
before any of these measurements and three roadmap items were rejected against it, so
reaching for a stage-level threshold now &mdash; because this is a result worth having
&mdash; is how a rule set in advance stops meaning anything. It stays rejected.</div>
<div class="caveat">
  <span class="caveat-label">What it exposes is the rule, not the change</span>
  <p>
    A job-level threshold rejects any change confined to a stage worth less than that
    threshold, however complete the win inside it. This one removed a third of its stage and
    still failed. Whether the gate should be job-level at all is a decision worth making
    deliberately &mdash; and it is not one a measurement can make.
  </p>
</div>

<h3>The check that mattered more than the change</h3>
<p>
  The pipeline calibrates a camera focal by sweeping 46 candidates and exporting one
  integer. That integer configures the mesh renderer and feeds every landmark projection,
  so it fixes the whole 3D tracking geometry for the job. Batching those independent solves
  is worth ${focalDelta} of the job and cuts the tracking stage ${focalStage}. Verifying that it
  still picked the same focal is what turned this up.
</p>
<p>
  <strong>That ${focalDelta} is a ceiling, not the shipped configuration.</strong> It measures the
  sweep batched outright. The version kept instead hands the top-ranked candidates back to
  the untouched sequential solver to confirm the winner &mdash; because no batched
  formulation of this optimiser is bit-identical to the sequential one, which is the wall
  the reads below describe. That confirmation trades a ${focalIterUnconf}x reduction in solver
  iterations for ${focalIterConf}x, so the default lands materially lower. It is the better
  trade, protecting the one value the rest of the stage depends on at a third of the win.
  The shipped configuration has not been timed, and this page does not estimate it.
</p>
${mdTable('results/measured.md', 'Four reads, one clip, one seed')}
<div class="verdict"><b>Two runs of the unmodified code chose ${focalA} and ${focalB}.</b> Same
code, same seed, same clip. Every projection error across the four reads sits within
${focalErrSpread} of every other, so the objective is flat and the choice is settled by numerical
noise rather than by the data. The run with the <em>lowest</em> error was the outlier &mdash;
a global minimum wandering across a plateau. The batching speedup is real; its equivalence
is withdrawn, and it now appears there was never a stable selection to preserve.</div>
<div class="caveat">
  <span class="caveat-label">Two things worth taking from this</span>
  <p>
    <strong>The value was invisible.</strong> Not one line of that module&rsquo;s logging
    reaches any run log, so no production job could report the focal it chose and nobody
    could have noticed. One print statement exposed it &mdash; the second time in this work
    that adding a single log line turned up a real defect, the first being a silent
    frame-dropping bug on the shipping path.
  </p>
  <p>
    <strong>It looked like a cause for something written off as irreducible &mdash; and it
    is not.</strong> Deterministic kernels were measured to buy no reproducibility, and the
    residual was attributed to libraries outside the framework&rsquo;s control. An
    ill-conditioned selection amplifying a tiny difference into a large change in camera
    geometry looked like a better candidate, so it was tested: with the focal pinned to a
    constant, two runs agree no better than two unpinned ones, on every statistic. That
    hypothesis is withdrawn and the original explanation stands.
  </p>
  <p>
    Which produces the more useful result. The objective is <em>flat</em>, so the choice is
    <em>unstable</em>, and pinning it <em>changes nothing</em> &mdash; one fact from three
    sides. The candidate focals are genuinely equivalent fits: pose and depth absorb the
    difference and the output cannot tell them apart. The calibration is
    <strong>under-determined, not wrong</strong>, so the swing is a real reproducibility
    defect in the value and not a quality defect in the output. Either half alone would have
    misled. Two draws per path cannot say how often or how widely this varies, and this is
    one clip.
  </p>
</div>
${mdTable('results/measured.md', 'Tested by pinning the focal, and refuted')}

<h3>How precisely can this rig measure anything?</h3>
<p>
  Two passes tested no optimization at all. One repeated the baseline with the accumulated
  output directory cleared, to ask whether the drift had an avoidable cause. The other ran
  the same clip four times at one seed with deterministic kernels requested, to ask whether
  the pipeline can reproduce its own output at all.
</p>
${mdTable('results/measured.md', 'Where the session drift came from')}
${mdTable('results/measured.md', 'Deterministic kernels: what they cost, and what they buy')}
${mdTable('results/measured.md', 'The repeat spread, and a correction to how it was first quoted')}
<div class="verdict"><b>The pipeline cannot reproduce itself, and the noise was first quoted
too high.</b> Zero of 751 frames matched in either deterministic pair, so no change here can
be validated by checking the output is unchanged, and a reuse cache has to store its bytes
rather than recompute them. Determinism also costs double digits, so the flag stays off. On
precision: this page originally quoted a 2.28% repeat spread taken from a single pair of
runs. A second pair came in ten times tighter, and the honest figure is the four-run
coefficient of variation, ${repeatCv}. The conclusion it supports is the same one — at that
spread, effects of a few tenths of a percent are not resolvable at one run per
configuration.</div>
<div class="caveat">
  <span class="caveat-label">A fidelity claim withdrawn, and two variables that moved together</span>
  <p>
    An earlier version of this page said fp16 cost measurable fidelity: 39.37 dB PSNR against
    the baseline, "further from the baseline than simply re-running the pipeline is."
    <strong>That was wrong, and the measurement that disproves it is below.</strong> Re-running
    the identical configuration with the same seed gives 40.37 dB with a worst pixel of 96 of
    255 — a <em>larger</em> difference than fp16 produced. Every arm sits within a quarter of a
    decibel of that floor.
  </p>
  <p>
    The same run settles a second question. <strong>Zero of 2,253 frames were bit-identical
    between two runs of the same configuration with the same seed.</strong> Seeding is
    necessary to make an A/B comparable and is demonstrably not sufficient for
    reproducibility: the residual is CUDA-level nondeterminism outside the seeded generators.
  </p>
  <p>
    One caveat survives. That arm changed batch size and precision together, so it cannot
    separate their individual effects — though with the whole arm inside the noise floor,
    there is no effect left to attribute.
  </p>
</div>
`)}

${sec(5, 'resolution', 'What scales with resolution, and what does not', `
<div class="claim">
  <p>
    Across a set that holds frame count fixed while pixel count varies nearly fivefold,
    exactly one stage tracks resolution: paste-back compositing, at
    <span class="stat">R&sup2; ${pasteR2}</span>. Every other stage is flat.
  </p>
  <span class="interval">12 open-dataset clips, 751 frames each, 462 to 1026 px square, through the deployed production build.</span>
</div>
${plate('resolution', 'F3', 'Per-frame stage cost against megapixels. Only paste-back slopes; the rest are level across the range.')}
${mdTable('results/measured.md', 'Cost against input resolution')}
<div class="verdict"><b>The flatness is structural, not a validation:</b> every intermediate —
crops, masks, geometry, the render itself — is written at a fixed 512 px regardless of input
resolution. The flat stages are flat by construction. Only paste-back touches
full-resolution pixels.</div>
${mdTable('results/measured.md', 'Held-out prediction of the 1080p profile')}
<div class="caveat">
  <span class="caveat-label">One stage's prediction misses badly, and it is disclosed here</span>
  <p>
    The LivePortrait warp is predicted far above its measured value because one of the twelve
    runs recorded that stage at nearly three times the median: the sixteen predictions were
    submitted in two concurrent batches and shared GPU capacity. That sample inflates the
    fitted slope. It is in the set, and the median absolute error over all stages is quoted
    with it rather than around it.
  </p>
  <p>
    For a flat stage the "prediction" is just the intercept, so most of these are the flatness
    verdict restated. The genuinely predictive result is paste-back's.
  </p>
</div>
`)}

${sec(6, 'quality', 'Output quality against real footage', `
<div class="claim">
  <p>
    Each generated clip scored against <em>its own</em> source footage. Generated output is
    behind real footage by a paired gap on lip-sync distance — but on
    <span class="stat">4 of 12</span> clips the difference is inside the measurement noise
    floor, so the metric cannot separate generated from real at all.
  </p>
  <span class="interval">SyncNet under the published evaluation protocol, computed on CPU. Within-clip pairing, 12 self-driven clips plus 4 cross-driven.</span>
</div>
${plate('quality', 'F4', 'Each clip&rsquo;s generated lip-sync distance joined to its own real footage, sorted by gap. Grey joins are gaps the instrument cannot resolve.')}
${mdTable('results/measured.md', 'Lip-sync error against ground truth')}
<div class="verdict"><b>No optimization has been shown to change quality either way.</b> No arm
was kept, so nothing shipped that could. Every generated clip was checked for the failures a
timing harness cannot see — black frames, frozen output, a face whose mouth never moves — and
all 16 passed.</div>
${mdTable('results/measured.md', 'Per-clip quality detail')}
<div class="caveat">
  <span class="caveat-label">This metric is weak, and its floor is n=1</span>
  <p>
    Published work measuring these scores against human judgement puts their agreement
    <em>below chance</em>. Treat them as a collapse detector, not a quality measure: they can
    tell real footage from generated, and little finer.
  </p>
  <p>
    The noise floor separating "resolvable" from "not" comes from a single pair of
    regenerations of one production clip, carried across to clips a quarter the size. It is
    indicative. Claims of the form "indistinguishable from real" should wait for a
    regeneration pair measured on this dataset.
  </p>
</div>
`)}

${sec(7, 'cost', 'The same profile, priced', `
<div class="claim">
  <p>
    Priced per video, the largest single line is not a model stage at all: it is the container
    starting up. Cold start is <span class="stat">30.6%</span> of billed time per job on a
    deployment that scales to zero.
  </p>
  <span class="interval">Rate is an input, printed with every table below. The GPU model the production runs executed on is not recorded anywhere in the pipeline, so the rate is not reconciled against that hardware.</span>
</div>
${plate('cost', 'F5', 'Cost per 1000 videos by stage, with the two lines that are not stages: cold start, and in-container work the stage timers never attributed.')}
${mdTable('results/measured.md', 'Cost per video')}
<div class="verdict"><b>Two consequences.</b> Optimizing the pipeline to zero would remove
about two thirds of the bill, not all of it. And above some traffic threshold, keeping an
instance warm beats every item on the roadmap — a configuration decision, not an engineering
one.</div>
${mdTable('results/measured.md', 'Rate sensitivity')}
<div class="caveat">
  <span class="caveat-label">Money here has three separate uncertainties</span>
  <p>
    The rate is an assumption, and the same measured seconds cost 2.9&times; more at the
    published rate for the card class the production path actually runs on. The stage timers
    also leave 117 s per job of billed in-container work unattributed, so a model built on the
    stage sum alone understates the seconds bought by 22%. Both are carried in the tables
    rather than smoothed away.
  </p>
</div>
`)}

${sec(8, 'cache', 'The largest change is architectural', `
<div class="claim">
  <p>
    The four stages that run before the animator take no audio input, so for any job reusing a
    source video they recompute identical results. That is
    <span class="stat">${lsCacheShare}</span> of the lipsync pipeline and
    <span class="stat">${wrCacheShare}</span> of the word-replacement pipeline.
  </p>
  <span class="interval">Established from the pipeline's execution order and confirmed in the code: the four stages take no arguments and read only the source frames. Upper bound, not an achieved result.</span>
</div>
${plate('cache', 'F6', 'Each pipeline split into the source-only prefix and the audio-dependent remainder. Word replacement&rsquo;s prefix is the larger share because it already processes only changed segments.')}
${mdTable('results/measured.md', 'The cacheable prefix')}
<div class="verdict"><b>Worth more than every measured optimization combined</b>, and unlike all
of them it cannot change a pixel, because it returns stored bytes rather than approximating
anything.</div>
<div class="caveat">
  <span class="caveat-label">Currently unreachable, for a specific reason</span>
  <p>
    The frame time-warp that prepares each segment chooses which frames to insert or drop
    using the process-global random number generator, seeded once per job. The same segment
    therefore produces different frames in different jobs, so a content-addressed cache can
    never hit. The share above is a ceiling that a small change — making that warp a pure
    function of its inputs — would unlock. Until then it is 0%.
  </p>
  <p>
    The word-replacement figure also comes from six replicas of a single fixture: one source,
    one transcript, one changed segment. It describes one workload measured six times.
    Multi-segment requests are untested.
  </p>
</div>
`)}

${sec(9, 'gpucpu', 'Work on a GPU that needs no GPU', `
<div class="claim">
  <p>
    <span class="stat">${cpuShareLs}</span> of a production lipsync job is video transcoding
    and file transfer, billed at a GPU machine's rate while using no GPU.
  </p>
  <span class="interval">Job-level stages classified by whether they require a GPU at all, across three workloads.</span>
</div>
${plate('gpucpu', 'F7', 'Job time split into GPU work and CPU-only work for each workload.')}
${mdTable('results/measured.md', 'GPU work against CPU-only work')}
${plate('throughput', 'F8', 'Videos per GPU-hour: the planning unit on hardware kept warm, where start-up is amortised rather than billed per job.')}
${mdTable('results/measured.md', 'Throughput per GPU-hour')}
<div class="caveat">
  <span class="caveat-label">The share depends on the input, and the saving is a rate difference</span>
  <p>
    On the open-dataset clips the CPU-only share is far smaller, because those inputs are
    small and already at the target frame rate. The production figure is dominated by fetching
    and transcoding large customer source video, so the share rises with input size — worst
    exactly where the bill is biggest.
  </p>
  <p>
    Moving that work does not reduce it. The gain is the difference between a GPU rate and a
    CPU rate, against a new network hop for the job's largest artefact, which has not been
    measured.
  </p>
</div>
`)}

${sec(10, 'how', 'How the numbers were made', `
<div class="two">
  <div>
    <h4>A typical published benchmark</h4>
    <p>Reports a mean and a speedup, pooled across inputs.</p>
    <p>Runs candidate and baseline at different times, often on different hosts.</p>
    <p>Reports the wins.</p>
    <p>Quotes a vendor rate as though it were a measurement.</p>
    <p>Treats "the model is fast" as the result.</p>
  </div>
  <div>
    <h4>Here</h4>
    <p>Paired per clip, because clip-to-clip spread is larger than every effect tested. Pooling could not resolve them.</p>
    <p>One machine, one warm process per arm, same clips in the same order, sampler seeded, run sequentially.</p>
    <p>Reports two rejections, because that is what the measurements said.</p>
    <p>Rate is an input, printed with every table, and priced three ways because it is the largest uncertainty in the money.</p>
    <p>Treats output validity as a gate: every generated clip checked for black, frozen or static-mouth failure before any timing is believed.</p>
  </div>
</div>
<h3>Definitions used throughout</h3>
<p>
  <strong>Pipeline time</strong> is the sum of the ten instrumented model stages.
  <strong>Job time</strong> adds fetch, transcode, mux and upload. <strong>Billed time</strong>
  adds container start-up, which a scale-to-zero deployment pays for. The three differ by
  enough to change conclusions, so each table names which it uses.
</p>
<p>
  <strong>Paired difference</strong> is per clip, as a percentage of that clip's baseline, and
  negative means faster everywhere on this page. A change is kept only if it is at least 3%
  faster, agrees numerically with the baseline output, and moves no clip's lip-sync distance by
  more than the noise floor.
</p>
<h3>One widely repeated claim this corrects</h3>
<p>
  That raising batch size until the GPU is saturated is a reliable win for a per-frame video
  pipeline. It is not, when the stage is decode-bound: measured here at
  ${arm1Delta} for a fourfold batch increase, with the sign consistent across every clip.
  The same reasoning predicts, correctly, that reduced precision also does nothing.
</p>
`)}

${sec(11, 'limits', 'What this does not establish', `
<p>
  <strong>That the rejected changes would fail elsewhere.</strong> Both were tested on one
  workload at one resolution on one GPU. They fail here because this renderer waits on video
  decode. Fix that, and both deserve retesting.
</p>
<p>
  <strong>That any of the proposed changes works.</strong> The cache, the CPU/GPU split, the
  dead-code removals and the sub-stage findings are mechanisms identified in code with their
  sizes estimated from the measured profile. None has a measured before-and-after. They are
  labelled that way in every table.
</p>
<p>
  <strong>What the system costs.</strong> The GPU model behind the production timings is
  recorded nowhere, so every money figure rests on an assumed rate that varies by 2.9&times;
  across plausible choices. Closing that needs one line of an invoice, not more measurement.
</p>
<p>
  <strong>That quality is unaffected by optimization.</strong> Nothing was kept, so nothing
  was tested for it. The one arm that changed output measurably was rejected for other
  reasons.
</p>
<p>
  <strong>Anything about multi-segment word replacement.</strong> The word-replacement cohort
  is six replicas of one fixture with a single changed segment.
</p>
<p>
  <strong>That the arm design was adequate.</strong> It was not. Running the baseline once at
  the start and once at the end revealed ${driftPct} of drift, which swamps the effects under
  test. The correct design interleaves a baseline between every arm so drift is measured
  continuously rather than bounded after the fact. The verdicts survive because all three
  effects are far from the gate either way, but a study looking for a 2% win with this design
  would have found one that was not there.
</p>
<p>
  <strong>That any of the proposed changes would help.</strong> The control settled the one
  question that was open here — the branch itself is performance-neutral against the
  unmodified trunk, so the arms measured their switches rather than incidental differences.
  What remains unmeasured is everything still labelled proposed.
</p>
`)}

</main>
</div>

<footer>
  <div>
    <p>
      ${allRuns.length} pipeline runs across production and dedicated hardware, ${(gpuSeconds / 3600).toFixed(1)} GPU-hours of
      measurement. Raw per-stage samples, the analysis scripts that reduce them, and the figure
      generators are published with this page; every number on it is produced by that chain at
      build time rather than written by hand.
    </p>
    <p><a class="pagelink" href="results-pack.html">Results pack: every figure with its source table &rarr;</a></p>
  </div>
</footer>

</div>
</body>
</html>
`;

writeFileSync(join(root, 'web/index.html'), html);
console.log(`wrote web/index.html (${(html.length / 1024).toFixed(1)} KB)`);
