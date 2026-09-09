#!/usr/bin/env node
/**
 * Extracts the study's raw samples out of the pipeline's own container logs.
 *
 * Run once, offline, against the private benchmarking repository; its output in
 * results/raw/ is what this repository commits and every later script reads. The logs
 * themselves are NOT committed: they carry customer source-video URLs and, in the
 * harvested production cohort, the names of real people used as test subjects. This
 * script keeps the timings and drops all of that — see redact() and the assertion at the
 * end, which fails the extraction rather than writing a file it has not cleaned.
 *
 * Usage: SRC=/path/to/zero-shot-lipsync node analysis/extract.mjs
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SRC || join(root, '..', 'zero-shot-lipsync');
const outDir = join(root, 'results/raw');

// The pipeline prints each timing twice: once live, once in a recap block at the end.
// Summing naively double-counts every stage. Exact (name, value) pairs are collapsed.
const FQ = /Function '([^']+)' took ([\d.]+) seconds/;
const FP = /^([A-Za-z_][A-Za-z0-9_]*) took ([\d.]+) seconds/;
const TOTAL = /Total time: ([\d.]+) seconds/;
const FRAMES = /frame-count:\s*(\d+),\s*fps:\s*(\d+)/;
const GPU = /^gpu=(.+)$/m;
const TORCH = /^torch=(\S+)/m;

/** `run` and `run_lipsync` wrap the pipeline; they are not siblings of its stages. */
const WRAPPERS = new Set(['run', 'run_lipsync']);

function parseLog(text) {
  const pipeline = {};
  const job = {};
  const seen = new Set();
  let total = null;
  let frames = null;
  let fps = null;
  for (const line of text.split('\n')) {
    const l = line.trim();
    let m = FQ.exec(l);
    if (m) {
      const key = `${m[1]}|${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pipeline[m[1]] = (pipeline[m[1]] ?? 0) + Number(m[2]);
      continue;
    }
    m = FP.exec(l);
    if (m) { job[m[1]] = (job[m[1]] ?? 0) + Number(m[2]); continue; }
    m = TOTAL.exec(l);
    if (m) { total = Number(m[1]); continue; }
    m = FRAMES.exec(l);
    if (m) { frames = Number(m[1]); fps = Number(m[2]); }
  }
  // A stage name appearing in both tables is a job-level wrapper, not a pipeline stage.
  const stages = {};
  for (const [k, v] of Object.entries(pipeline)) {
    if (!(k in job) && !WRAPPERS.has(k)) stages[k] = v;
  }
  return { stages, job, total, frames, fps };
}

/**
 * Everything identifying is removed here, not filtered later.
 * Clip ids keep their dataset prefix and index because those are the study's labels; the
 * production cohort's ids are replaced with an opaque index, since they encode a real
 * person's name.
 */
function redact(s) {
  return String(s)
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/s3:\/\/\S+/g, '[s3]')
    .replace(/\/(?:home|Users)\/[^\s/]+/g, '[home]');
}

function readDir(dir, label) {
  const p = join(SRC, 'benchmarking/logs', dir);
  if (!existsSync(p)) { console.log(`  skip ${label}: ${dir} absent`); return []; }
  const out = [];
  for (const f of readdirSync(p).filter((x) => x.endsWith('.log')).sort()) {
    const text = readFileSync(join(p, f), 'utf8');
    const r = parseLog(text);
    if (!Object.keys(r.stages).length) continue;
    const gpu = GPU.exec(text);
    const torch = TORCH.exec(text);
    out.push({
      clip: basename(f).replace(/\.log$/, '').replace(/_[a-z0-9]{20,}$/, '').replace(/_local$/, ''),
      ...r,
      gpu: gpu ? redact(gpu[1].trim()) : null,
      torch: torch ? torch[1] : null,
    });
  }
  console.log(`  ${label}: ${out.length} runs from ${dir}`);
  return out;
}

const sets = {};

// Production lipsync: 5 driven predictions, 1920x1080, the study's reference profile.
sets['lipsync-prod'] = [...readDir('run_a', 'lipsync run_a'), ...readDir('run_b', 'lipsync run_b')];

// Open dataset, both protocols.
sets['hdtf-self'] = readDir('hdtf_prod', 'HDTF self-driven');
sets['hdtf-cross'] = readDir('hdtf_cross', 'HDTF cross-driven');

// Harvested production traffic, split by path. Word-replacement runs are identified by
// their job stages, not by a filename, because the filenames are prediction ids.
const harvested = readDir('harvested', 'harvested production');
const isWR = (r) => ['split_segments', 'stitch_segments', 'run_local_maskgct', 'run_maskgct']
  .some((k) => k in r.job);
sets['wordreplacement-prod'] = harvested.filter(isWR).map((r, i) => ({ ...r, clip: `wr${String(i + 1).padStart(2, '0')}` }));
sets['lipsync-harvested'] = harvested.filter((r) => !isWR(r)).map((r, i) => ({ ...r, clip: `ls${String(i + 1).padStart(2, '0')}` }));

// The A/B arms, each a directory. Config comes from the runner's own summary.
const arms = [];
for (const arm of ['arm0', 'arm1', 'arm2', 'arm3', 'arm0b', 'control_main']) {
  const runs = readDir(arm, `arm ${arm}`);
  if (!runs.length) continue;
  const sp = join(SRC, 'benchmarking/logs', arm, 'summary.json');
  const knobs = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')).knobs : {};
  const walls = existsSync(sp)
    ? Object.fromEntries(JSON.parse(readFileSync(sp, 'utf8')).cases.map((c) => [c.id, c.wall_s]))
    : {};
  for (const r of runs) arms.push({ arm, knobs, wall_s: walls[r.clip] ?? null, ...r });
}
sets['arms'] = arms;

for (const [name, rows] of Object.entries(sets)) {
  const blob = JSON.stringify(rows, null, 1);
  // Refuse to write anything still carrying an identifier.
  for (const pat of [/https?:\/\//, /s3:\/\//, /AKIA/, /\/Users\//, /\/home\/[a-z]/]) {
    if (pat.test(blob)) throw new Error(`redaction failed in ${name}: ${pat}`);
  }
  writeFileSync(join(outDir, `${name}.json`), `${blob}\n`);
  console.log(`wrote results/raw/${name}.json (${rows.length} runs)`);
}

// Committed side inputs that need no redaction.
for (const [src, dst] of [
  ['benchmarking/lse_results.json', 'lse.json'],
  ['benchmarking/hdtf/manifest.json', 'clips.json'],
]) {
  const p = join(SRC, src);
  if (existsSync(p)) { writeFileSync(join(outDir, dst), readFileSync(p)); console.log(`wrote results/raw/${dst}`); }
}
