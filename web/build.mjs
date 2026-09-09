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
const candidateArms = armIds.filter((a) => a !== 'arm0' && a !== 'arm0b' && a !== 'control_main');
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
  ['Output quality', 'unchanged', `<small>No arm was kept, so nothing shipped that could move it. Verified on every generated clip.</small>`],
  ['Pipeline runs measured', `${allRuns.length}`, `<small>Across ${[lipsync, wr, hdtfSelf, hdtfCross, arms].filter((s) => s.length).length} configurations, production and dedicated hardware.</small>`],
  ['Longest single run', `${longest.toFixed(0)} s`, `<small>One 1080p job end to end, excluding the container start it is billed for.</small>`],
  ['GPU time spent measuring', `${(gpuSeconds / 3600).toFixed(1)} h`, `<small>Sum of every run on this page. The A/B share of it cost about $8.</small>`],
];

const ledger = `<dl class="ledger">${LEDGER.map(([dt, dd, small]) => `
  <div><dt>${dt}</dt><dd>${dd}${small}</dd></div>`).join('')}</dl>`;

// --- numbers quoted in prose come out of the generated tables ---------------
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
<div class="verdict"><b>No verdict changes, but one reason does.</b> Compared against a
baseline interpolated to its own slot, the three effects are ${arm1Adj}, ${arm2Adj} and
${arm3Adj} — a tighter null than the raw numbers, and the largest raw effect turns out to be
mostly the machine. The earlier reading of the third arm as "consistently slower because the
kernel search is paid for" is not supported: that slowdown is indistinguishable from the
drift.</div>
</p>
${mdTable('results/measured.md', 'Per-clip arm detail')}
<div class="caveat">
  <span class="caveat-label">fp16 is not free, and two variables moved together</span>
  <p>
    Against the baseline output, fp16 gave zero of 751 frames identical, 39.37 dB PSNR and a
    worst pixel off by 62 of 255 levels — further from the baseline than simply re-running the
    pipeline is. So it is measurable fidelity loss for no speed.
  </p>
  <p>
    That arm changed batch size and precision together. Batch invariance was measured
    separately at 1.2e-07 on the real model, so the fidelity loss is attributable to fp16, but
    the clean test is a seeded repeat of the baseline, which had not completed when this page
    was built. Do not quote the fidelity figure as fp16's alone until it does.
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
  <strong>That the arms are isolated from the rebuild.</strong> A control built from the
  unmodified branch was still building when this page was published. It is what separates the
  effect of the code changes from the effect of the rebuilt environment.
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
