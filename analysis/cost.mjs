/**
 * Cost inputs, kept separate from every measurement.
 *
 * The hourly rate is an INPUT, not an observation, and it is the single largest source of
 * uncertainty in the money figures on this site: the GPU model the production runs
 * executed on is not recorded anywhere in the pipeline's logs or deployment config, so the
 * rate cannot be reconciled against the hardware that produced the timings. Every table
 * that spends this rate prints it.
 */

export const RATES = {
  // The card this study's A/B ran on, at its provider's published on-demand rate.
  measured: { id: 'a100-40gb', label: 'A100 40GB, on-demand', usdPerHour: 1.99 },
  // Published per-second rate for the serverless class the production path runs on.
  serverless: { id: 'serverless-a100-80gb', label: 'Serverless A100 80GB, published', usdPerHour: 5.04 },
  // Derived all-in cost of owning the same card: hardware amortised over three years plus
  // power at published industrial rates and colocation at published asking rates. A band,
  // reported as its centre.
  owned: { id: 'owned-a100-40gb', label: 'Owned A100 40GB, all-in centre', usdPerHour: 0.89 },
};

export const DEFAULT_RATE = RATES.measured;

export const perSecond = (rate) => rate.usdPerHour / 3600;
export const cost = (seconds, rate = DEFAULT_RATE) => seconds * perSecond(rate);
export const per1000 = (seconds, rate = DEFAULT_RATE) => cost(seconds, rate) * 1000;
export const throughputPerGpuHour = (seconds) => 3600 / seconds;

export const usd = (x) => (x < 1 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
