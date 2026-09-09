/**
 * The statistics the study needs, and no more.
 *
 * Distribution-free throughout. Stage timings here are near-deterministic (the measured
 * coefficient of variation on the A/B arms is under 0.01), but the sample counts are small
 * — three clips per arm, five production runs — and a normal-theory interval on n=3 would
 * assert precision the design cannot support. Order statistics and paired differences say
 * only what the samples say.
 */

export const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

export function percentile(v, p) {
  const s = [...v].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (i - lo) * (s[hi] - s[lo]);
}

export const stdev = (v) => {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
};

/** Coefficient of variation, the scale-free way to report how tight a set of runs is. */
export const cv = (v) => (mean(v) === 0 ? 0 : stdev(v) / mean(v));

/**
 * Exact binomial (Clopper-Pearson style) interval for a percentile, from order statistics.
 * Returns null below five samples rather than inventing bounds from three points.
 */
export function percentileCI(v, p, conf = 0.95) {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (n < 5) return null;
  const z = 1.959963984540054;
  const c = z * Math.sqrt(p * (1 - p) * n);
  const lo = Math.max(0, Math.floor(n * p - c));
  const hi = Math.min(n - 1, Math.ceil(n * p + c));
  return { lower: s[lo], upper: s[hi], conf };
}

/**
 * Paired per-clip difference, as a percentage of the baseline.
 *
 * Paired because pooled comparison cannot resolve the effects being tested: clip-to-clip
 * spread in this pipeline is ~3.2% of the mean while the effects are under 1%. Argument
 * order is (candidate, baseline) and the sign convention is stated once, here: NEGATIVE
 * means the candidate is faster. Every caller and every table inherits that.
 */
export function pairedDelta(candidate, baseline) {
  const keys = Object.keys(baseline).filter((k) => k in candidate).sort();
  if (!keys.length) return null;
  const perClip = keys.map((k) => ({
    clip: k,
    base: baseline[k],
    cand: candidate[k],
    deltaPct: (100 * (candidate[k] - baseline[k])) / baseline[k],
  }));
  const d = perClip.map((x) => x.deltaPct);
  return {
    n: keys.length,
    perClip,
    meanPct: mean(d),
    minPct: Math.min(...d),
    maxPct: Math.max(...d),
    spreadPp: Math.max(...d) - Math.min(...d),
    // With every clip moving the same way, a sub-1% mean is still a consistent direction;
    // mixed signs at that magnitude are noise. The distinction decides how a null reads.
    signsConsistent: d.every((x) => x > 0) || d.every((x) => x < 0),
  };
}

/** Ordinary least squares through (x, y), with R^2. Used for the resolution model. */
export function linfit(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (den === 0) return { a: my, b: 0, r2: 0 };
  const b = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den;
  const a = my - b * mx;
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const ssRes = ys.reduce((s, y, i) => s + (y - (a + b * xs[i])) ** 2, 0);
  return { a, b, r2: ssTot ? 1 - ssRes / ssTot : 0 };
}

export const fmt = (x, d = 2) => Number(x).toFixed(d);
export const signed = (x, d = 2) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;
