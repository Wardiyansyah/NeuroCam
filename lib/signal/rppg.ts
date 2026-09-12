/**
 * Remote photoplethysmography (rPPG) - recovering the blood volume pulse from
 * per-ROI mean colour.
 *
 * Method is CHROM (de Haan & Jeanne, 2013): the pulse lives in the chrominance
 * subspace where specular reflection largely cancels, which makes it far more
 * robust to motion and skin tone than a raw green-channel trace. Steps are
 * resample -> per-channel normalisation -> chrominance projection -> detrend ->
 * window -> FFT -> peak pick inside the plausible heart-rate band.
 */

import type { HemodynamicMetrics, RoiName, RoiSample, SignalQuality } from "@/lib/types";
import { powerSpectrum } from "./fft";
import { detrend, hann, normalizeByMean, std } from "./stats";

/** 42-240 bpm. Wide on purpose: a stroke event is not the time to clip outliers. */
const HR_MIN_HZ = 0.7;
const HR_MAX_HZ = 4.0;

/** ROIs with enough perfusion to carry a usable pulse signal. */
const PULSE_ROIS: RoiName[] = ["forehead", "cheekL", "cheekR"];

/** Below this many usable frames the spectrum is too coarse to trust. */
const MIN_FRAMES = 64;

/** Zero-pad target - buys ~0.5 bpm frequency resolution at 30 fps. */
const FFT_PAD = 2048;

/** Half-width, in Hz, of the band counted as "signal" around a spectral peak. */
const PEAK_HALF_WIDTH_HZ = 0.1;

export interface PulseEstimate {
  bpm: number | null;
  snrDb: number;
  quality: SignalQuality;
  /** Effective sampling rate derived from frame timestamps. */
  fps: number;
}

/**
 * Resample an irregularly-timed series onto a uniform grid by linear
 * interpolation. Browser frame delivery jitters, and an FFT that assumes
 * uniform spacing on jittered input smears the pulse peak.
 */
function resampleUniform(times: number[], values: number[], fps: number): number[] {
  const n = times.length;
  if (n < 2) return [...values];

  const start = times[0];
  const end = times[n - 1];
  const step = 1000 / fps;
  const count = Math.floor((end - start) / step) + 1;
  if (count < 2) return [...values];

  const out = new Array<number>(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = start + i * step;
    while (j < n - 2 && times[j + 1] < t) j++;
    const t0 = times[j];
    const t1 = times[j + 1];
    const span = t1 - t0;
    const w = span === 0 ? 0 : (t - t0) / span;
    out[i] = values[j] * (1 - w) + values[j + 1] * w;
  }
  return out;
}

/** Median inter-frame interval -> frames per second. Median resists dropped frames. */
function effectiveFps(times: number[], fallback: number): number {
  if (times.length < 3) return fallback;
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return fallback;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  if (median <= 0) return fallback;
  return Math.min(120, Math.max(5, 1000 / median));
}

function qualityFromSnr(snrDb: number, faceRatio: number): SignalQuality {
  if (faceRatio < 0.6) return "poor";
  if (snrDb >= 3) return "good";
  if (snrDb >= 0) return "fair";
  return "poor";
}

/**
 * Estimate heart rate from a window of ROI samples.
 * Returns `bpm: null` whenever the signal does not support a call - the caller
 * must treat that as "unknown", never as "normal".
 */
export function estimatePulse(samples: RoiSample[], nominalFps: number): PulseEstimate {
  const usable = samples.filter((s) => s.faceFound);
  const faceRatio = samples.length === 0 ? 0 : usable.length / samples.length;

  if (usable.length < MIN_FRAMES) {
    return { bpm: null, snrDb: -Infinity, quality: "poor", fps: nominalFps };
  }

  const times = usable.map((s) => s.t);
  const fps = effectiveFps(times, nominalFps);

  // Average the pulse ROIs channel-wise: more skin area, less sensor noise.
  const channel = (idx: 0 | 1 | 2) =>
    usable.map((s) => {
      let sum = 0;
      for (const roi of PULSE_ROIS) sum += s.roi[roi][idx];
      return sum / PULSE_ROIS.length;
    });

  const r = resampleUniform(times, channel(0), fps);
  const g = resampleUniform(times, channel(1), fps);
  const b = resampleUniform(times, channel(2), fps);

  const rn = normalizeByMean(r);
  const gn = normalizeByMean(g);
  const bn = normalizeByMean(b);

  // CHROM projection into the two chrominance difference signals.
  const x = rn.map((v, i) => 3 * v - 2 * gn[i]);
  const y = rn.map((v, i) => 1.5 * v + gn[i] - 1.5 * bn[i]);

  const sx = std(x);
  const sy = std(y);
  const alpha = sy === 0 ? 0 : sx / sy;
  const pulse = hann(detrend(x.map((v, i) => v - alpha * y[i])));

  if (pulse.length < MIN_FRAMES) {
    return { bpm: null, snrDb: -Infinity, quality: "poor", fps };
  }

  const power = powerSpectrum(pulse, FFT_PAD);
  const binCount = power.length;
  const binHz = fps / (2 * (binCount - 1));

  const loBin = Math.max(1, Math.ceil(HR_MIN_HZ / binHz));
  const hiBin = Math.min(binCount - 1, Math.floor(HR_MAX_HZ / binHz));
  if (loBin >= hiBin) {
    return { bpm: null, snrDb: -Infinity, quality: "poor", fps };
  }

  let peakBin = loBin;
  for (let k = loBin; k <= hiBin; k++) {
    if (power[k] > power[peakBin]) peakBin = k;
  }
  const peakHz = peakBin * binHz;

  // de Haan SNR: energy at the pulse frequency and its second harmonic,
  // against everything else in the band.
  const halfWidth = Math.max(1, Math.round(PEAK_HALF_WIDTH_HZ / binHz));
  let signalPower = 0;
  let noisePower = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const nearFundamental = Math.abs(k - peakBin) <= halfWidth;
    const nearHarmonic = Math.abs(k - 2 * peakBin) <= halfWidth;
    if (nearFundamental || nearHarmonic) signalPower += power[k];
    else noisePower += power[k];
  }

  const snrDb =
    noisePower <= 0 || signalPower <= 0
      ? -Infinity
      : (10 * Math.log10(signalPower / noisePower)) + 10;

  const quality = qualityFromSnr(snrDb, faceRatio);
  // A poor-quality spectrum yields a number, but not one worth acting on.
  const bpm = quality === "poor" ? null : Math.round(peakHz * 60); //simulasi anomali warning

  return { bpm, snrDb, quality, fps };
}

/**
 * Fold a pulse estimate together with the session baseline into the metrics
 * the threshold stage consumes.
 */
export function toHemodynamicMetrics(
  estimate: PulseEstimate,
  baselineBpm: number | null,
): HemodynamicMetrics {
  const spikePct =
    estimate.bpm !== null && baselineBpm !== null && baselineBpm > 0
      ? ((estimate.bpm - baselineBpm) / baselineBpm) * 100
      : null;

  return {
    bpm: estimate.bpm,
    snrDb: Number.isFinite(estimate.snrDb) ? Number(estimate.snrDb.toFixed(2)) : -99,
    quality: estimate.quality,
    baselineBpm,
    spikePct: spikePct === null ? null : Number(spikePct.toFixed(1)),
  };
}
