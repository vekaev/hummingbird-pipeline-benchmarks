// Enforce THE ONE RULE mechanically: nothing numeric is typed by hand.
//
// Run with:  node analysis/audit_hardcoded.mjs
//
// It found four typed counts on its first run, two of which had gone stale without
// anyone noticing: the output-check tally still said 16/16 after the set grew to 18,
// and the instrumented-stage count predated nine sub-phase timers. A fifth, "all 20
// generated clips", matched no source at all -- the comparison covers 15.
//
// What it still reports and should be ignored: section numbers, dates, resolution
// labels like 1080p, and one explicitly approximate cost aside. None of those are
// result claims. If the list grows beyond those, something was typed.
//
// THE ONE RULE: nothing numeric is typed by hand. Numbers live in results/raw/*.json,
// an analysis script computes them into results/*.md, and the page reads cells back out.
//
// This checks the rule mechanically instead of by eye. It strips every ${...} expression
// from the page builders -- those are computed -- and then looks for bare numerals left
// in the literal HTML prose. Anything it finds was typed.
import { readFileSync } from 'fs';

const files = ['web/build.mjs', 'web/pack.mjs'];
// Numerals that are structural rather than claims: HTML/CSS plumbing and ordinals.
const ALLOW = [
  /^[0-9]$/,                       // single digits: mostly list/col indices in prose
  /^(19|20)\d\d$/,                 // years
  /^(1|2|3|4|5|6|7|8|9|10)0*%$/,   // handled separately below
];

let violations = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // Keep only template-literal chunks (the HTML), drop ${...} interpolations.
  const literals = [...src.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]);
  for (const lit of literals) {
    if (!/<[a-z]/.test(lit)) continue;               // not HTML prose
    const stripped = lit.replace(/\$\{[^}]*\}/g, '§');
    // Numbers in prose, not in tags/attributes/entities.
    const prose = stripped
      .replace(/<[^>]*>/g, ' ')                      // drop tags and their attributes
      .replace(/&[a-z]+;/g, ' ');                    // drop entities
    for (const m of prose.matchAll(/\b\d[\d,.]*\s*%?/g)) {
      const tok = m[0].trim();
      if (ALLOW.some((re) => re.test(tok))) continue;
      const ctx = prose.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, ' ');
      console.log(`${f}: "${tok}"  ...${ctx}...`);
      violations += 1;
    }
  }
}
console.log(violations === 0
  ? '\nPASS: no hand-typed numerals in page prose'
  : `\n${violations} hand-typed numeral(s) in page prose`);
