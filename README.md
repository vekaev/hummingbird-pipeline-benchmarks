# Profiling a ten-stage lip-sync pipeline in production

Per-stage profiling, an open-dataset run, and paired A/B measurement of proposed
optimizations for a production zero-shot lip-sync pipeline.

Two pages are published from this repository:

- **the article page** — what was done and what each change measured
- **the results pack** — every figure with the exact table it was drawn from, the brief
  mapped to its answers, the caveats that must travel with the numbers, and sources

## The one rule this repository exists to enforce

**No number is typed by hand.** The chain is:

```
results/raw/*.json          committed samples, extracted from the pipeline's own logs
  -> analysis/analyze.mjs   -> results/measured.md
  -> analysis/reporting.mjs -> results/reporting.md
  -> analysis/figures.mjs   -> results/figures/*.svg      (hand-authored SVG, no chart library)
  -> web/build.mjs          -> web/index.html
  -> web/pack.mjs           -> web/results-pack.html
```

The page builders never compute a value. They lift tables out of `results/*.md` by heading
and inline the SVGs, rewriting each literal hex to a CSS custom property so charts follow
the page theme. `mdTable()` throws when a heading or table is missing, so renaming a heading
in an analysis script fails the build rather than silently dropping a table from the page.

Vercel runs that whole chain on every deploy, so what is served cannot drift from the
committed samples.

## What is here, and what is deliberately not

`results/raw/` holds the samples: per-stage and job-level timings for every run, the quality
scores, the clip parameters, and the change ledger. `analysis/extract.mjs` produced them from
container logs in the private pipeline repository, and it **refuses to write a file that
still contains a URL, an S3 path or a home directory** — the harvested production logs carry
customer source-video URLs and the names of real people used as test subjects, and none of
that belongs in a public repository. The logs themselves are not committed here.

This repository contains no application code, no credentials, and no customer data.

## Reproducing

```bash
node analysis/analyze.mjs      # -> results/measured.md
node analysis/reporting.mjs    # -> results/reporting.md
node analysis/figures.mjs      # -> results/figures/*.svg
node web/build.mjs             # -> web/index.html
node web/pack.mjs              # -> web/results-pack.html
node analysis/rasterize.mjs    # -> results/figures/png/*.png  (local only, drives headless Chrome)
```

Or `npm run build`, which is the chain the deploy runs.

Node 22 or later. No dependencies: everything uses Node builtins, which is why the deploy
needs no install step.

### The two steps the deploy cannot run

Both read the private pipeline repository, which is not present on the build host, so they
are deliberately outside `npm run build` and their outputs are committed instead:

```bash
SRC=/path/to/pipeline node analysis/extract.mjs   # -> results/raw/*.json
npm run sanitize                                  # -> docs/FINDINGS.md
```

Because they are manual, `docs/FINDINGS.md` can fall behind the working record it is copied
from without anything failing. **Use `npm run refresh`** — sanitize, then the full build —
whenever the working record has changed. The deploy will still succeed with a stale copy;
that is exactly the failure this note exists to prevent.

## Reading the numbers

Three time bases appear and they differ by enough to change conclusions, so every table
names which it uses. **Pipeline time** is the sum of the ten instrumented model stages.
**Job time** adds fetch, transcode, mux and upload. **Billed time** adds container start-up,
which a scale-to-zero deployment pays for.

**Paired difference** is per clip, as a percentage of that clip's own baseline, and negative
means faster everywhere. Statistics are distribution-free: order statistics and paired
differences, because at three clips per arm a normal-theory interval would assert precision
the design cannot support.

**Money is modelled, not measured.** The hourly rate is an input, printed with every table
that spends it, and `results/measured.md` prices the same measured seconds three ways
because the rate is the largest uncertainty in every cost figure here. The GPU model the
production runs executed on is recorded nowhere in the pipeline, so that rate is not
reconciled against the hardware that produced the timings.

`docs/FINDINGS.md` is the working record, including every claim that was withdrawn and why.
`docs/BRIEF.md` is the request this work answers, verbatim. `docs/SOURCES.md` lists every
external claim with its source.
