/** Small numeric helpers shared by the rPPG and asymmetry stages. */

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Divide by the temporal mean and subtract 1, giving a zero-centred relative
 * fluctuation. This is the standard first step for chrominance-based rPPG: it
 * cancels the per-channel gain that skin tone and lighting impose.
 */
export function normalizeByMean(xs: number[]): number[] {
  const m = mean(xs);
  if (m === 0) return xs.map(() => 0);
  return xs.map((x) => x / m - 1);
}

/** Remove the least-squares linear trend (drift from lighting, slow motion). */
export function detrend(xs: number[]): number[] {
  const n = xs.length;
  if (n < 2) return [...xs];

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += xs[i];
    sumXY += i * xs[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return [...xs];

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return xs.map((x, i) => x - (slope * i + intercept));
}

/** Hann window, to stop spectral leakage from smearing the pulse peak. */
export function hann(xs: number[]): number[] {
  const n = xs.length;
  if (n < 2) return [...xs];
  return xs.map((x, i) => x * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
}

/** Relative luminance of an [r, g, b] triple (Rec. 709). */
export function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Exponential moving average, used to keep displayed metrics from flickering. */
export function ema(previous: number | null, next: number, alpha: number): number {
  return previous === null ? next : previous * (1 - alpha) + next * alpha;
}
