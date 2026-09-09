#!/usr/bin/env node
/**
 * Copies the working record into docs/FINDINGS.md with organisational identifiers removed.
 *
 * The record is worth publishing — it holds every claim that was withdrawn and why, which
 * is the part of a study most often quietly deleted. But it is written for colleagues, so
 * it names an internal deployment and the vendors involved. Neither is load-bearing for
 * any finding: the results are about a pipeline's behaviour, not about who hosts it.
 *
 * Rewriting rather than hand-editing keeps this reproducible, and the assertion at the end
 * fails rather than publishing a file that still carries an identifier.
 *
 * Usage: SRC=/path/to/pipeline node analysis/sanitize-findings.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SRC || join(root, '..', 'zero-shot-lipsync');

/** Ordered: longer patterns first, so a short one cannot bite a longer one in half. */
const RULES = [
  [/tavus-engineering\/instant-model-prod/g, 'the production deployment'],
  [/tavus-engineering\/instant-model-test/g, 'the staging deployment'],
  [/`?instant-model-prod`?/g, 'the production deployment'],
  [/`?instant-model-test`?/g, 'the staging deployment'],
  [/\bTavusMetrics\b/g, "the platform's own metrics"],
  [/\bReplicate's\b/g, "the hosting platform's"],
  [/\bReplicate\b/gi, 'the hosting platform'],
  [/`?cerebrium\.toml`?/gi, 'the deployment configuration'],
  [/\bCerebrium\b/gi, 'the hosting platform'],
  [/\bDeepgram\b/gi, 'the transcription service'],
  [/s3:\/\/[a-z0-9._-]+/g, 'an object store bucket'],
  [/zero-shot-lipsync-[a-z-]+/g, 'an object store bucket'],
  [/https?:\/\/[^\s)]+/g, '[link removed]'],
];

let text = readFileSync(join(SRC, 'benchmarking/FINDINGS.md'), 'utf8');
const before = text.length;
for (const [re, to] of RULES) text = text.replace(re, to);

const header = `<!--
Published copy of the working record. Organisational identifiers were removed by
analysis/sanitize-findings.mjs; the findings themselves are unedited. Vendor and deployment
names are replaced with generic descriptions because no result here depends on them.
-->

`;
const out = header + text;

for (const pat of [/AKIA/, /BEGIN [A-Z ]*PRIVATE KEY/, /s3:\/\//, /https?:\/\//, /\bReplicate\b/, /\bCerebrium\b/i]) {
  if (pat.test(out)) throw new Error(`sanitiser missed ${pat} — refusing to publish`);
}

writeFileSync(join(root, 'docs/FINDINGS.md'), out);
console.log(`wrote docs/FINDINGS.md (${before} -> ${out.length} bytes, ${RULES.length} rules)`);
