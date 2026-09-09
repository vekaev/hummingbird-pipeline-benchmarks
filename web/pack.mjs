#!/usr/bin/env node
/**
 * Builds web/results-pack.html: the evidence pack a writer works from.
 *
 * Same tokens and type as the article page, different composition — this one is scanned,
 * not read. Every figure is followed by the exact table it was drawn from, every table
 * carries a note on how to read it, and the F/T numbers are stable citation handles.
 *
 * Usage: node web/pack.mjs
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS, HEAD, FIGURE_COLOURS } from './tokens.mjs';
import { mdTable, mdCell, inline } from './md.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = (n) => JSON.parse(readFileSync(join(root, 'results/raw', `${n}.json`), 'utf8'));

const EXTRA = `
.pack .cols { grid-template-columns:250px minmax(0,1fr); }
.pack h1 { font-size:33px; }
.tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--rule); border:1px solid var(--rule); margin:0 0 26px; }
@media (max-width:900px) { .tiles { grid-template-columns:repeat(2,1fr); } }
.tiles div { background:var(--surface); padding:13px 15px; }
.tiles dt { font-family:var(--mono); font-size:10px; letter-spacing:0.06em; text-transform:uppercase; color:var(--muted); margin:0 0 6px; line-height:1.35; }
.tiles dd { margin:0; font-family:var(--mono); font-size:17px; font-weight:600; color:var(--ink); font-variant-numeric:tabular-nums; }
.tiles dd small { display:block; font-family:var(--sans); font-size:10.5px; font-weight:400; color:var(--muted); margin-top:5px; line-height:1.4; }
.qa { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--rule); border:1px solid var(--rule); margin:0 0 26px; }
@media (max-width:820px) { .qa { grid-template-columns:1fr; } }
.qa > div { background:var(--surface); padding:15px 18px; }
.qa blockquote { margin:0; font-size:14.5px; color:var(--ink); border-left:2px solid var(--rule); padding-left:13px; }
.qa p { font-size:14.4px; margin:0 0 9px; max-width:none; }
.qa p:last-child { margin-bottom:0; }
.ft { font-family:var(--mono); font-size:11px; background:var(--sunk); border:1px solid var(--rule); padding:1px 6px; color:var(--ink); white-space:nowrap; }
.item { border-top:1px solid var(--rule); padding:26px 0 6px; }
.item:first-of-type { border-top:0; }
.item h3 { margin:0 0 4px; font-size:17px; }
.item .id { font-family:var(--mono); font-size:11.5px; color:var(--muted); letter-spacing:0.05em; }
.meta { font-size:13.4px; color:var(--ink-soft); margin:0 0 6px; max-width:76ch; }
.meta b { font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); font-weight:500; margin-right:7px; }
.files { font-family:var(--mono); font-size:11.5px; color:var(--muted); }
ol.changes { counter-reset:c; list-style:none; padding:0; margin:0 0 26px; }
ol.changes li { counter-increment:c; border-top:1px solid var(--rule); padding:13px 0 13px 42px; position:relative; max-width:none; margin:0; font-size:14.5px; }
ol.changes li::before { content:counter(c,decimal-leading-zero); position:absolute; left:0; top:13px; font-family:var(--mono); font-size:12px; color:var(--muted); }
ol.changes b { color:var(--ink); }
ol.sources { padding-left:26px; }
ol.sources li { font-size:13.8px; margin:0 0 11px; max-width:82ch; }
`;

function figureSvg(name) {
  let svg = readFileSync(join(root, 'results/figures', name), 'utf8').trim();
  svg = svg.replace(/<rect width="\d+" height="\d+" fill="#ffffff"\/>/, '');
  for (const [hex, token] of Object.entries(FIGURE_COLOURS)) svg = svg.replaceAll(hex, token);
  svg = svg.replace(/ width="\d+" height="\d+"/, ' width="100%" height="auto"');
  return svg;
}

const changes = raw('changes');
const arms = raw('arms');
const allRuns = ['lipsync-prod', 'wordreplacement-prod', 'hdtf-self', 'hdtf-cross', 'lipsync-harvested', 'arms']
  .flatMap((n) => raw(n));

/** Figure registry: the F-numbers writers will cite. Source tables travel with each. */
const FIGURES = [
  { id: 'F1', file: '01-stage-profile.svg', title: 'Per-stage profile, production lipsync',
    shows: 'Mean seconds per pipeline stage for production lipsync, in execution order, with each stage’s share of the pipeline. The four stages before the animator take no audio input and are marked as the cacheable prefix.',
    basis: 'Measured, n=5 driven predictions at 1920×1080.',
    tables: [['results/measured.md', 'Stage profile, production lipsync', 1]] },
  { id: 'F2', file: '02-arms-paired.svg', title: 'A/B arms, paired per clip',
    shows: 'Per-clip difference against the baseline arm for each candidate, as a percentage. The shaded band is the ±3% acceptance gate. Negative is faster; every arm measured sits on the slower side of zero.',
    basis: 'Measured on a dedicated A100 40GB, three clips per arm, one warm process per arm, sampler seeded, sequential.',
    tables: [['results/measured.md', 'Optimization arms, paired per clip', 1], ['results/measured.md', 'Per-clip arm detail', 1]] },
  { id: 'F3', file: '03-resolution-decomposition.svg', title: 'Stage cost against input resolution',
    shows: 'Per-frame cost of each stage against megapixels across twelve clips that hold frame count fixed. Only paste-back compositing slopes; the others are level because every intermediate is written at a fixed 512 px.',
    basis: 'Measured, 12 open-dataset clips, 751 frames each, 462–1026 px square.',
    tables: [['results/measured.md', 'Cost against input resolution', 1], ['results/measured.md', 'Held-out prediction of the 1080p profile', 1]] },
  { id: 'F4', file: '04-quality-paired.svg', title: 'Lip-sync distance, generated against its own source',
    shows: 'Each generated clip joined to the real footage it was made from, sorted by gap. Joins are coloured by whether the gap clears the measurement noise floor; grey means the instrument cannot separate generated from real on that clip.',
    basis: 'Measured with SyncNet under the published protocol, on CPU, within-clip pairing, 12 clips.',
    tables: [['results/measured.md', 'Lip-sync error against ground truth', 1], ['results/measured.md', 'Per-clip quality detail', 1]] },
  { id: 'F5', file: '05-cost-composition.svg', title: 'Cost per 1000 videos, by line',
    shows: 'The pipeline stages priced per thousand videos, alongside two lines that are not stages: container start-up, and in-container work the stage timers never attributed. Cold start is the largest single line.',
    basis: 'Modelled from measured seconds at a stated rate. The rate is an input, not an observation.',
    tables: [['results/measured.md', 'Cost per video', 1], ['results/measured.md', 'Rate sensitivity', 1]] },
  { id: 'F6', file: '06-cacheable-prefix.svg', title: 'The cacheable prefix, both workloads',
    shows: 'Each pipeline split into the source-only prefix and the audio-dependent remainder. Word replacement’s prefix is the larger share because that path already processes only the changed segments.',
    basis: 'Measured stage times; the split is established from the pipeline’s execution order. An upper bound, not an achieved saving.',
    tables: [['results/measured.md', 'The cacheable prefix', 1]] },
  { id: 'F7', file: '07-gpu-vs-cpu.svg', title: 'GPU work against CPU-only work',
    shows: 'Job time split into work that requires a GPU and work that does not — video transcoding, muxing and file transfer — for each of three workloads.',
    basis: 'Measured; the classification is by stage, listed in the source table’s note.',
    tables: [['results/measured.md', 'GPU work against CPU-only work', 1]] },
  { id: 'F8', file: '08-throughput.svg', title: 'Videos per GPU-hour',
    shows: 'Throughput for each workload as deployed, and for word replacement with the source prefix cached. Rate-independent, and the planning unit on hardware kept warm.',
    basis: 'Derived from measured seconds. Excludes container start-up by construction.',
    tables: [['results/measured.md', 'Throughput per GPU-hour', 1]] },
];

/** Table registry: the T-numbers, each with how to read it. */
const TABLES = [
  { id: 'T1', file: 'results/reporting.md', heading: 'Changes made', title: 'The change ledger',
    note: 'Every change in the order it was made. The Effect column is either a measured number or the literal phrase "not measured" with the reason — the underlying schema has no field for an estimate, so a change cannot be credited with a projection.' },
  { id: 'T2', file: 'results/reporting.md', heading: 'Per-stage timing by configuration', title: 'Per-stage timing by configuration', wide: true,
    note: 'The table the brief asked for. Seconds, mean across each configuration’s runs. Hardware is an observation only for the A/B row, where the runner writes the GPU model and driver into every log header; the production rows carry the deployment configuration and are labelled as such.' },
  { id: 'T3', file: 'results/reporting.md', heading: 'Measurement precision by configuration', title: 'Measurement precision',
    note: 'Whether a configuration can resolve the effects under test. The production cohorts cannot: their clip-to-clip spread exceeds every effect measured. This is why the A/B ran on a dedicated machine and is paired per clip rather than pooled.' },
  { id: 'T4', file: 'results/measured.md', heading: 'Stage profile, production lipsync', title: 'Stage profile, production lipsync',
    note: 'The reference profile. Stages sum to the independently printed job total within 0.03 s, which is the internal consistency check on the instrumentation.' },
  { id: 'T5', file: 'results/measured.md', heading: 'Stage profile, production word replacement', title: 'Stage profile, word replacement',
    note: 'A different shape from lipsync: this path processes only changed segments, so the source-analysis stages dominate. Six replicas of one fixture, so read it as one workload measured six times.' },
  { id: 'T6', file: 'results/measured.md', heading: 'Stage profile, HDTF self-driven', title: 'Stage profile, open dataset (self-driven)',
    note: 'The open-dataset run the brief asked for, through the deployed production build. A clip’s own audio drives it, so ground truth exists for the quality comparison.' },
  { id: 'T7', file: 'results/measured.md', heading: 'Stage profile, HDTF cross-driven', title: 'Stage profile, open dataset (cross-driven)',
    note: 'The actual zero-shot task: one speaker’s audio driving another’s video. No ground truth exists by construction, so only lip-sync distance is available here.' },
  { id: 'T8', file: 'results/measured.md', heading: 'Optimization arms, paired per clip', title: 'A/B arms, paired',
    note: 'Negative would mean faster. Read the "signs" column with the mean: at these magnitudes a consistent direction across every clip is a small real effect, while mixed signs are noise. The gate needs 3% before a change is kept.' },
  { id: 'T9', file: 'results/measured.md', heading: 'Per-clip arm detail', title: 'A/B arms, per clip',
    note: 'The pairing in full, so the spread can be checked against the effect. The baseline column repeats per arm because each arm is compared to the same three baseline runs.' },
  { id: 'T10', file: 'results/measured.md', heading: 'Cost against input resolution', title: 'Resolution decomposition',
    note: 'Fitted per frame against megapixels. A stage counts as resolution-dependent only when the fit explains most of the variance and the slope matters over the observed range. Exactly one stage qualifies.' },
  { id: 'T11', file: 'results/measured.md', heading: 'Held-out prediction of the 1080p profile', title: 'Held-out prediction',
    note: 'The model is fitted on the open-dataset clips only; the 1080p profile is held out of every fit and then predicted. For a flat stage the prediction is just the intercept, so most rows restate flatness — the genuinely predictive row is paste-back.' },
  { id: 'T12', file: 'results/measured.md', heading: 'Lip-sync error against ground truth', title: 'Quality against ground truth',
    note: 'Within-clip pairing: each generated clip is scored against its own source footage, because absolute values are not comparable across datasets. Lower LSE-D is better, higher LSE-C is better.' },
  { id: 'T13', file: 'results/measured.md', heading: 'Per-clip quality detail', title: 'Quality per clip',
    note: 'Sorted by gap. The "within noise floor" column marks clips where the instrument cannot separate generated output from real footage. That floor is a single measured pair, carried across from a different dataset.' },
  { id: 'T14', file: 'results/measured.md', heading: 'GPU work against CPU-only work', title: 'GPU against CPU-only work',
    note: 'Stages classified CPU-only: fetch and preprocess, length adjustment, segment split and stitch, audio mux, upload. None touches the GPU; all are billed at the GPU machine’s rate.' },
  { id: 'T15', file: 'results/measured.md', heading: 'Cost per video', title: 'Cost per video by stage',
    note: 'Priced at the rate named in the header above the table. Rate is an input. This table covers pipeline stages only — it excludes container start-up and the unattributed in-container work, both of which are billed.' },
  { id: 'T16', file: 'results/measured.md', heading: 'The cacheable prefix', title: 'The cacheable prefix',
    note: 'The four stages before the animator take no audio input, so a job reusing a source video recomputes them identically. An upper bound: a content-addressed cache cannot hit today, for the reason in the caveats.' },
  { id: 'T17', file: 'results/measured.md', heading: 'Throughput per GPU-hour', title: 'Throughput per GPU-hour',
    note: 'Rate-independent, so it survives the rate uncertainty that affects every money table. This is the unit capacity is planned in on hardware kept warm.' },
  { id: 'T18', file: 'results/measured.md', heading: 'Rate sensitivity', title: 'Rate sensitivity',
    note: 'The same measured seconds priced three ways. The spread between them is larger than any optimization measured in this study, which is why the rate is stated as an input everywhere rather than folded into a headline.' },
  { id: 'T19', file: 'results/measured.md', heading: 'Run-to-run spread', title: 'Run-to-run spread',
    note: 'Coefficient of variation on total pipeline time per cohort. Compare against the effect sizes in T8: the production cohorts are an order of magnitude too noisy to resolve them.' },
  { id: 'T20', file: 'results/measured.md', heading: 'Does a second job fit on the same GPU?', title: 'Two jobs per accelerator',
    note: 'The density question, measured rather than projected. Running two jobs at once is worse than running them in sequence: throughput falls and per-job latency more than doubles. Neither memory nor utilization was the constraint — both are recorded in the row beneath — so the binding resource is the CPU-side encoding, which this accelerator cannot help with.' },
  { id: 'T21', file: 'results/measured.md', heading: 'Neither resource the projection reasoned about was the constraint', title: 'What was not the constraint',
    note: 'The two resources the projection reasoned from, measured during the concurrent phase. Both had headroom while throughput fell, which is what rules them out and points at the CPU instead.' },
  { id: 'T22', file: 'results/measured.md', heading: 'Keeping stage boundaries in memory', title: 'Stage boundaries in memory',
    note: 'Paired per clip, with the treatment bracketed by two runs of the control — the rightmost column is that second control run, and it is the drift measurement the effect has to beat. It beats it by roughly a hundredfold, which is why this one is reportable. Follows directly from T20: if the constraint is CPU-side encoding, the change to try is the one that removes encodes.' },
  { id: 'T23', file: 'results/measured.md', heading: 'The attribution names its own cost', title: 'Where the saving comes from',
    note: 'One stage gives up the time, and the change declares the new cost it introduces in exchange: writing the final video once, from memory, at the end. No other stage moved by more than two tenths of a second.' },
  { id: 'T24', file: 'results/measured.md', heading: 'Memory, which the code had only ever reasoned about', title: 'Memory cost of holding frames',
    note: 'The codebase carried this budget as hand arithmetic, explicitly flagged as never measured. It is right about the sustained footprint and wrong about the peak, which is unchanged — and peak is the number that decides whether a job fits a memory limit. The reason is in that same comment, in a passage that did not draw the conclusion.' },
  { id: 'T25', file: 'results/measured.md', heading: 'The change is NOT output-neutral, and that is the interesting part', title: 'Output agreement, in-memory arm',
    note: 'The middle column only means something against the left one, which is the same configuration run twice — the floor. The gap is consistent across every clip, so the difference is real. It traces to a defect in the path being replaced: two writers in the same file disagree about frame alignment and about rate control, so delivered video is scaled up two pixels per dimension and encoded at roughly half the bitrate the sibling writer would use. This arm is therefore NOT counted with the two bit-exact changes that shipped.' },
  { id: 'T26', file: 'results/measured.md', heading: 'That test was run, and it reverses the verdict', title: 'Output parity once both writers agree',
    note: 'The follow-up to T25, and it reverses it. With both writer parameters set the existing path stops rescaling and writes at the same quality; the two paths then agree at the same-configuration floor to within 0.03 dB. So the whole gap in T25 was the writer, and the in-memory change is output-neutral after all. Read T25 and T26 together — T25 is left standing because the reasoning in it was sound and the conclusion was still premature.' },
  { id: 'T27', file: 'results/measured.md', heading: 'Against the source, which is the comparison that was missing', title: 'Fidelity against the source clip',
    note: 'Self-driven protocol, so the source video is the reference and most of each frame is content the pipeline only had to carry. The middle row is the important one: the two writer parameters alone are worth that much on the path that ships today, at no performance cost. A fidelity measure on pass-through content, NOT a perceptual score — image-registration metrics agree poorly with human judgement on generated faces.' },
  { id: 'T28', file: 'results/measured.md', heading: 'Where all three changes land, against the unmodified branch', title: 'All kept changes vs the unmodified branch',
    note: 'The headline comparison: every kept change on, against the unmodified trunk, same clips and seed. Read the caveat with it — the treated column is a single pass, bracketed for the in-memory change but not re-run against the trunk, so this is the sum of three separately bracketed effects rather than a bracketed measurement in its own right. It agrees with the parts.' },
  { id: 'T29', file: 'results/measured.md', heading: 'Where all three changes land, against the unmodified branch', nth: 2, title: 'Which stages actually moved',
    note: 'The distribution is the control on the row above. Two stages carry almost all of the saving and nothing else moves much; a change that shifted every stage would indicate a measurement artefact rather than an optimization. Both of those two stages came out of the per-stage profile, and neither appeared on the optimization roadmap.' },
  { id: 'T30', file: 'results/measured.md', heading: 'What the largest stage is actually doing', title: 'Inside the largest stage',
    note: 'The stage that remains largest after every kept change, split into its two phases for the first time. The code had always emitted this split and nothing had ever captured it. Read the caveat on the page with it: the first attempt at this measurement was inflated ~15% by the instrumentation itself, caught by comparing against three earlier uninstrumented runs of the same clip, and the contaminated ratio was discarded rather than rescaled because the inflation was uneven.' },
  { id: 'T31', file: 'results/measured.md', heading: 'Writes that nobody reads', title: 'Removing writes nobody reads',
    note: 'Bit-exact by construction: the files removed have no reachable reader, established by parsing the source rather than searching it. Read it together with T32, which is why it is REJECTED on latency despite the stage numbers here. The recommendation rests on output volume, not speed.' },
  { id: 'T32', file: 'results/measured.md', heading: 'And it still fails the gate', title: 'Why that change fails the gate',
    note: 'The control runs span nearly 3% among themselves and the treated run sits under 1% below the fastest of them, so a single pair cannot resolve a roughly 1% job effect. Comparing against the slowest control alone would read as clearing the 3% gate; that comparison is chosen after the fact and is not quoted. Included because a rejected change with a clean stage-level effect is the case where the gate does real work.' },
  { id: 'T33', file: 'results/reporting.md', heading: 'Configuration key', title: 'Configuration key',
    note: 'What each configuration in T2 actually is: which deployment produced it and under what protocol. "Harvested" means taken from live traffic rather than driven for the study.' },
];

const CAVEATS = [
  ['Hardware is measured for one configuration only',
    'The A/B arms record GPU model, driver, torch and cuDNN build in every log header. The production container never prints its GPU, so those rows carry the deployment configuration instead. Any sentence attributing production timings to a specific card is repeating a config file, not a measurement.'],
  ['The rate behind every money figure is an assumption',
    'The same measured seconds cost 2.9× more at the published rate for the card class the production path runs on than at the rate used as the default. Closing that gap needs one line of an invoice. Until then, quote throughput per GPU-hour, which is rate-independent, or quote the rate alongside the money.'],
  ['The stage timers miss 117 s per job of billed work',
    'Job time exceeds the sum of the instrumented stages by roughly two minutes: fetch, transcode, mux and upload. Any cost model built on the stage sum alone understates the seconds actually bought by about 22%.'],
  ['Two of the twelve HDTF timing runs shared GPU capacity',
    'The sixteen open-dataset predictions were submitted in two concurrent batches of eight. One run recorded the LivePortrait stage at nearly three times the median as a result, and it is inside the reported means. Eight predictions at once is not the same measurement as eight run serially.'],
  ['The quality noise floor is a single pair, from a different dataset',
    'It comes from two regenerations of one production clip and is carried across to clips a quarter the size. It is also a single difference rather than a standard deviation. Treat "within the noise floor" as indicative, and do not print "indistinguishable from real footage" until a regeneration pair is measured on this dataset.'],
  ['Lip-sync distance is a weak instrument',
    'Published work measuring these scores against human judgement puts their agreement below chance. They separate real footage from generated and little finer. Use them as a collapse detector; do not present a small difference between two generated outputs as a quality difference.'],
  ['The word-replacement cohort is one workload, six times',
    'Same source video, same transcript, one changed segment, identical time offset in every run. The run-to-run spread is machine noise, not workload diversity. Multi-segment requests are untested, and its cacheable share should be read with that in mind.'],
  ['The cache share is a ceiling that is currently zero',
    'The frame time-warp preparing each segment picks frames using the process-global random number generator, seeded once per job, so the same segment yields different frames in different jobs. A content-addressed cache therefore cannot hit at all until that warp is made a pure function of its inputs.'],
  ['Resolution-flatness is structural, not a validation of the instrument',
    'Every intermediate — crops, masks, geometry, the render — is written at a fixed 512 px regardless of input resolution. The flat stages are flat by design. Only the compositing stage touches full-resolution pixels, and it is the only one that slopes.'],
  ['The A/B is incomplete',
    'A seeded repeat of the baseline and a control built from the unmodified branch were still running when this page was built. The control is what separates the effect of the code changes from the effect of the rebuilt environment; without it, the arms are internally paired but not isolated from the rebuild.'],
];

const SOURCES = readFileSync(join(root, 'docs/SOURCES.md'), 'utf8')
  .split('\n').filter((l) => l.startsWith('|') && /^\|\s*\d+\s*\|/.test(l))
  .map((l) => {
    const c = l.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    return { n: c[0], claim: c[1], src: c[2] };
  });

const brief = readFileSync(join(root, 'docs/BRIEF.md'), 'utf8');
const briefQuote = brief.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, '')).join('\n');

const ANSWERS = [
  ['Per-stage timing output across several runs, with hardware and video parameters noted.',
    `<p><b>Answered.</b> Five configurations, ${allRuns.length} runs. Hardware is measured for the A/B row and is the deployment configuration for the production rows, labelled in the table.</p><p><span class="ft">T2</span> <span class="ft">T4</span> <span class="ft">T5</span> <span class="ft">T6</span> <span class="ft">T7</span> <span class="ft">F1</span></p>`],
  ['LSE-C values added to the existing LSE-D harness (he mentioned this is a quick add).',
    '<p><b>Answered, and the premise was mistaken.</b> LSE-C was not pending: it has been computed on every release since March 2025 and comes from the same forward pass as LSE-D, so there was nothing to add. Both are also now computed independently on the open dataset with within-clip ground-truth pairing.</p><p><span class="ft">T12</span> <span class="ft">T13</span> <span class="ft">F4</span></p>'],
  ['One or two before/after comparisons for a specific optimization, with numbers.',
    '<p><b>Answered, and all of them are negative.</b> Three candidate changes measured against a common baseline, paired per clip on a dedicated machine. Every one was rejected. The write-up treats that as the result rather than a gap, because the mechanism behind the nulls is identified and it predicted the second and third outcomes in advance.</p><p><span class="ft">T8</span> <span class="ft">T9</span> <span class="ft">F2</span></p>'],
  ['Running the current production pipeline on an open dataset like HDTF, capturing per-stage timings and computing LSE-D/LSE-C on the outputs.',
    '<p><b>Answered.</b> Sixteen runs through the deployed production build, twelve self-driven and four cross-driven, with per-stage timings and both metrics on the outputs. Every generated clip was also checked for black, frozen or static-mouth failure; all sixteen passed.</p><p><span class="ft">T6</span> <span class="ft">T7</span> <span class="ft">T12</span> <span class="ft">T13</span> <span class="ft">F3</span> <span class="ft">F4</span></p>'],
];

/** Headline tiles. Every value is lifted from a generated table and names its source. */
const TILES = [
  ['Pipeline total, lipsync', mdCell('results/measured.md', 'Stage profile, production lipsync', 'Pipeline total', 1) + ' s', 'T4'],
  ['3D face tracking share', mdCell('results/measured.md', 'Stage profile, production lipsync', '3D face tracking', 3), 'T4'],
  ['Neural render share', mdCell('results/measured.md', 'Stage profile, production lipsync', 'Neural render', 3), 'T4'],
  ['Audio-to-expression share', mdCell('results/measured.md', 'Stage profile, production lipsync', 'Audio to expression', 3), 'T4'],
  // Drift-adjusted, not raw: the repeated baseline moved 1.85% across the session, so the
  // raw paired figures carry the machine in them. The ledger quotes the same corrected
  // numbers, and these tiles must not disagree with it.
  ['Batch 4 to 16, drift-adjusted', mdCell('results/measured.md', 'Arms, adjusted for drift', '>arm1<', 3), 'T8'],
  ['fp16 autocast, drift-adjusted', mdCell('results/measured.md', 'Arms, adjusted for drift', '>arm2<', 3), 'T8'],
  ['cuDNN autotuning, drift-adjusted', mdCell('results/measured.md', 'Arms, adjusted for drift', '>arm3<', 3), 'T8'],
  ['Baseline repeat, no code change', mdCell('results/measured.md', 'Session drift', 'run last', 2), 'T8'],
  // Both halves are read from the table: the identical count and the frame count, so the
  // "N of M" phrasing types neither number.
  ['Determinism, frames reproduced',
    `${mdCell('results/measured.md', 'Deterministic kernels', '>det1 vs det2<', 3)} of `
    + `${mdCell('results/measured.md', 'Deterministic kernels', '>det1 vs det2<', 2)}`, 'T8'],
  ['Frame cache, paired', mdCell('results/measured.md', 'Wall clock, paired per clip', '>mean<', 4), 'T8'],
  ['Neural render, frame cache', mdCell('results/measured.md', 'The saving is where the mechanism predicts', 'render_rgb', 4), 'T8'],
  ['Both changes together', mdCell('results/measured.md', 'Do the two kept changes compose?', '>j3both<', 4), 'T8'],
  ['Frame cache, replicated', mdCell('results/measured.md', 'Do the two kept changes compose?', '>j3fc5<', 4), 'T8'],
  ['Focal search batched (ceiling)', mdCell('results/measured.md', 'What it cost to find, and what the batching is worth', '>mean<', 3), 'T8'],
  ['Parsing reduce on device, paired', mdCell('results/measured.md', 'A change that works and is rejected anyway', '>mean<', 3), 'T8'],
  // Deliberately NOT a combined figure. The three kept-or-measured wins sit in three
  // different stages, so they ought to compose -- but "ought to" is not a measurement,
  // and no run has been done with more than one of them enabled.
  ['Repeat spread, 4 identical runs',
    mdCell('results/measured.md', 'The repeat spread', 'all four', 3), 'T8'],
  ['Baseline arm CV', mdCell('results/reporting.md', 'Measurement precision', 'A/B arms', 4), 'T3'],
  ['Paste-back fit vs pixels', 'R² ' + mdCell('results/measured.md', 'Cost against input resolution', 'Paste-back compositing', 1), 'T10'],
  ['Quality gap, paired', mdCell('results/measured.md', 'Lip-sync error against ground truth', 'Paired gap', 1), 'T12'],
  ['Cacheable, word replacement', mdCell('results/measured.md', 'The cacheable prefix', 'word replacement', 3), 'T16'],
  ['CPU-only share, lipsync', mdCell('results/measured.md', 'GPU work against CPU-only work', 'Production lipsync', 4), 'T14'],
  ['Throughput, lipsync', mdCell('results/measured.md', 'Throughput per GPU-hour', 'Lipsync, as deployed', 2) + '/GPU-h', 'T17'],
];

const figSection = FIGURES.map((f) => {
  const png = `results/figures/png/${f.file.replace(/\.svg$/, '.png')}`;
  const hasPng = existsSync(join(root, png));
  return `
<div class="item" id="${f.id.toLowerCase()}">
  <span class="id">${f.id}</span>
  <h3>${f.title}</h3>
  <div class="figure-plate">${figureSvg(f.file)}</div>
  <p class="meta"><b>What it shows</b>${f.shows}</p>
  <p class="meta"><b>Basis</b>${f.basis}</p>
  <p class="meta files"><b>Files</b>results/figures/${f.file}${hasPng ? ` &middot; ${png}` : ' &middot; PNG pending'}</p>
  ${f.tables.map(([file, heading, nth]) => mdTable(file, heading, nth)).join('\n')}
</div>`;
}).join('\n');

const tabSection = TABLES.map((t) => `
<div class="item" id="${t.id.toLowerCase()}">
  <span class="id">${t.id}</span>
  <h3>${t.title}</h3>
  <p class="meta">${t.note}</p>
  ${mdTable(t.file, t.heading, t.nth ?? 1, { wide: t.wide })}
</div>`).join('\n');

const html = `${HEAD('Results pack — lip-sync pipeline profiling', 'Every figure with its source table, the brief mapped to its answers, the caveats that must travel with the numbers, and sources.')}
<style>${EXTRA}</style>
<div class="shell pack">

<header class="masthead">
  <p class="eyebrow">Evidence pack &middot; for the writers &middot; figures F1&ndash;F${FIGURES.length}, tables T1&ndash;T${TABLES.length}</p>
  <h1>Results pack: every number, with the table it came from</h1>
  <p class="standfirst">
    The companion to the <a href="index.html">article page</a>. Each figure is followed by the
    exact table it was drawn from, each table by a note on how to read it, and each caveat is
    restated in full so none is lost in transit. F- and T-numbers are stable citation handles.
  </p>
</header>

<div class="cols">
<aside class="rail">
  <h2>Start</h2>
  <ul>
    <li><a href="#brief">The brief, answered</a></li>
    <li><a href="#headline">Headline numbers</a></li>
    <li><a href="#changes">The changes</a></li>
  </ul>
  <h2>Figures</h2>
  <ul>${FIGURES.map((f) => `<li><a href="#${f.id.toLowerCase()}"><span class="tag">${f.id}</span>${f.title}</a></li>`).join('\n')}</ul>
  <h2>Tables</h2>
  <ul>${TABLES.map((t) => `<li><a href="#${t.id.toLowerCase()}"><span class="tag">${t.id}</span>${t.title}</a></li>`).join('\n')}</ul>
  <h2>Carry with the numbers</h2>
  <ul>
    <li><a href="#measured">What was measured</a></li>
    <li><a href="#caveats">Caveats</a></li>
    <li><a href="#sources">Sources</a></li>
  </ul>
</aside>

<main>

<section id="brief">
  <span class="sec-no">01</span>
  <h2>The brief, answered</h2>
  <div class="qa">
    <div>
      <h4>Asked for</h4>
      <blockquote>${inline(briefQuote).replace(/\n/g, '<br>')}</blockquote>
    </div>
    <div>
      <h4>Reading it</h4>
      <p>Four deliverables, not three: the closing paragraph adds the open-dataset run as a distinct item.</p>
      <p>One premise is mistaken and the answer below says so, because it is a stronger position than the request assumes rather than a weaker one.</p>
    </div>
  </div>
  ${ANSWERS.map(([q, a], i) => `
  <div class="qa">
    <div><h4>Item ${i + 1}</h4><blockquote>${q}</blockquote></div>
    <div><h4>What exists</h4>${a}</div>
  </div>`).join('')}
</section>

<section id="headline">
  <span class="sec-no">02</span>
  <h2>Headline numbers</h2>
  <p>Each tile names the table it is lifted from. No value here is typed by hand.</p>
  <dl class="tiles">${TILES.map(([dt, dd, t]) => `
    <div><dt>${dt}</dt><dd>${dd}<small>${t}</small></dd></div>`).join('')}</dl>
</section>

<section id="changes">
  <span class="sec-no">03</span>
  <h2>The changes</h2>
  <p>In the order made. A change is credited with an effect only where a measurement exists.</p>
  <ol class="changes">${changes.changes.map((c) => `
    <li><b>${c.change}.</b> ${c.effect === 'measured' ? c.detail : `Not measured &mdash; ${c.detail}`} <span class="ft">${c.section === 'arms' ? 'F2 T8' : c.section === 'stage-profile' ? 'F1 T4' : c.section === 'quality' ? 'F4 T12' : c.section === 'unproposed' ? 'T1' : 'T1'}</span></li>`).join('')}</ol>
</section>

<section id="figures">
  <span class="sec-no">04</span>
  <h2>Figures</h2>
  ${figSection}
</section>

<section id="tables">
  <span class="sec-no">05</span>
  <h2>Tables</h2>
  ${tabSection}
</section>

<section id="measured">
  <span class="sec-no">06</span>
  <h2>What was measured</h2>
  <dl class="tiles">
    <div><dt>Pipeline runs</dt><dd>${allRuns.length}<small>production and dedicated</small></dd></div>
    <div><dt>Configurations</dt><dd>5<small>T2, T20</small></dd></div>
    <div><dt>A/B arms</dt><dd>${[...new Set(arms.map((a) => a.arm))].length}<small>incl. baseline</small></dd></div>
    <div><dt>Open-dataset clips</dt><dd>16<small>12 self, 4 cross</small></dd></div>
    <div><dt>Clips scored for quality</dt><dd>16<small>paired to source</small></dd></div>
    <div><dt>Output checks passed</dt><dd>16 / 16<small>black, frozen, static mouth</small></dd></div>
    <div><dt>GPU time measuring</dt><dd>${(allRuns.reduce((a, r) => a + (r.total ?? 0), 0) / 3600).toFixed(1)} h<small>sum of all runs</small></dd></div>
    <div><dt>Instrumented stages</dt><dd>10<small>plus job level</small></dd></div>
  </dl>
  <p>
    <strong>Definitions.</strong> <em>Pipeline time</em> is the sum of the ten instrumented model
    stages. <em>Job time</em> adds fetch, transcode, mux and upload. <em>Billed time</em> adds
    container start-up, which a scale-to-zero deployment pays for. The three differ by enough to
    change conclusions, so each table names which it uses. <em>Paired difference</em> is per clip
    as a percentage of that clip&rsquo;s own baseline, and negative means faster everywhere in this
    pack. Statistics are distribution-free throughout: order statistics and paired differences,
    because at three clips per arm a normal-theory interval would assert precision the design
    cannot support. A change is kept only if it is at least 3% faster, agrees numerically with the
    baseline output, and moves no clip&rsquo;s lip-sync distance by more than the noise floor.
  </p>
</section>

<section id="caveats">
  <span class="sec-no">07</span>
  <h2>Caveats</h2>
  <p>Each of these must travel with the number it qualifies.</p>
  ${CAVEATS.map(([label, body]) => `
  <div class="caveat"><span class="caveat-label">${label}</span><p>${body}</p></div>`).join('')}
</section>

<section id="sources">
  <span class="sec-no">08</span>
  <h2>Sources</h2>
  <p>Every claim in this pack that is not our own measurement. Retrieved 2026-09-09.</p>
  <ol class="sources">${SOURCES.map((s) => `
    <li>${inline(s.claim)} &mdash; ${inline(s.src)}</li>`).join('')}</ol>
</section>

</main>
</div>

<footer>
  <div>
    <p>
      Generated from committed samples by the analysis chain at build time: raw per-stage
      samples, the scripts that reduce them to the tables above, and the figure generators are
      all published with this pack.
    </p>
    <p><a class="pagelink" href="index.html">&larr; Article page</a></p>
  </div>
</footer>

</div>
</body>
</html>
`;

writeFileSync(join(root, 'web/results-pack.html'), html);
console.log(`wrote web/results-pack.html (${(html.length / 1024).toFixed(1)} KB)`);
