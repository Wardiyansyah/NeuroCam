/**
 * Minimal iterative radix-2 Cooley-Tukey FFT.
 *
 * The rPPG stage needs a power spectrum a few times per second over windows of
 * a few hundred samples. That is small enough that pulling in a DSP dependency
 * would cost more than it saves, and an in-place radix-2 transform is exact
 * enough for peak-picking once the input is zero-padded.
 */

/** Smallest power of two that is >= n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * In-place complex FFT. `re` and `im` must have the same power-of-two length.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) {
    throw new Error(`fft: length must be a power of two, got ${n}`);
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;

        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * One-sided power spectrum of a real signal, zero-padded to `padTo` samples.
 * Returns bins `0 .. padTo/2`, where bin k sits at `k * fs / padTo` Hz.
 */
export function powerSpectrum(signal: number[], padTo: number): Float64Array {
  const n = nextPow2(Math.max(padTo, signal.length));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i];

  fft(re, im);

  const half = n / 2;
  const power = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    power[k] = re[k] * re[k] + im[k] * im[k];
  }
  return power;
}
