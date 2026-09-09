/**
 * Facial asymmetry scoring - the "facial droop" half of the pipeline.
 *
 * WHAT THIS IS: a photometric proxy. It compares the left and right ROI of each
 * feature pair on two axes - how much each side *moves* (temporal variation in
 * luminance) and how each side is *shaded* relative to the cheek beside it.
 * Unilateral weakness shows up as one side moving markedly less than the other.
 *
 * WHAT THIS IS NOT: FACS Action Unit coding. Real AU intensity needs facial
 * landmarks or a trained AU model, which in this architecture lives on the GPU
 * inference server (see `lib/inference.ts`). These proxies are what the local
 * fallback analyser can compute honestly from mean colour alone; they are named
 * after the AUs they stand in for, not the AUs they measure.
 *
 * Two confounders are handled explicitly:
 *  - Side lighting. Each feature is normalised against the cheek on its own
 *    side, which cancels a left-right illumination gradient to first order.
 *  - Natural asymmetry. Nobody is symmetric. Scores are meaningful only as an
 *    excess over the subject's own calibrated baseline - see `applyBaseline`.
 */

import type { AsymmetryMetrics, RoiSample, SignalQuality } from "@/lib/types";
import { clamp, luminance, mean, std } from "./stats";

/** Feature pairs, each with the cheek ROI used to cancel its local lighting. */
const PAIRS = [
  { key: "mouth", left: "mouthL", right: "mouthR" },
  { key: "eye", left: "eyeL", right: "eyeR" },
  { key: "brow", left: "browL", right: "browR" },
] as const;

const MIN_FRAMES = 32;

/** Motion asymmetry dominates: shading asymmetry is the more confounded signal. */
const MOTION_WEIGHT = 0.65;
const STATIC_WEIGHT = 0.35;

/** Guard against divide-by-zero on a flat or black ROI. */
const EPS = 1e-6;

export interface AsymmetryScores {
  mouth: number;
  eye: number;
  brow: number;
  overall: number;
  quality: SignalQuality;
}

/** Neutral result used before enough signal has accumulated. */
const UNKNOWN: AsymmetryScores = {
  mouth: 0,
  eye: 0,
  brow: 0,
  overall: 0,
  quality: "poor",
};

/**
 * Normalised difference between two non-negative quantities, in [0, 1].
 * 0 means identical, 1 means one side is entirely absent.
 */
function normalizedDiff(a: number, b: number): number {
  const denom = a + b;
  if (denom < EPS) return 0;
  return Math.abs(a - b) / denom;
}

export function computeAsymmetry(samples: RoiSample[]): AsymmetryScores {
  const usable = samples.filter((s) => s.faceFound);
  const faceRatio = samples.length === 0 ? 0 : usable.length / samples.length;

  if (usable.length < MIN_FRAMES) return UNKNOWN;

  const cheekL = usable.map((s) => luminance(s.roi.cheekL));
  const cheekR = usable.map((s) => luminance(s.roi.cheekR));
  const cheekLMean = mean(cheekL);
  const cheekRMean = mean(cheekR);

  const scores: Record<string, number> = {};

  for (const pair of PAIRS) {
    const left = usable.map((s) => luminance(s.roi[pair.left]));
    const right = usable.map((s) => luminance(s.roi[pair.right]));

    // --- Motion axis -------------------------------------------------------
    // Normalise each side by its own mean so that a brighter side does not
    // automatically look like a more mobile one, then compare variability.
    const leftMean = mean(left);
    const rightMean = mean(right);
    const leftMotion = leftMean < EPS ? 0 : std(left) / leftMean;
    const rightMotion = rightMean < EPS ? 0 : std(right) / rightMean;
    const motionAsym = normalizedDiff(leftMotion, rightMotion);

    // --- Shading axis ------------------------------------------------------
    // Ratio against the same-side cheek cancels a left-right lighting gradient.
    const leftRatio = cheekLMean < EPS ? 0 : leftMean / cheekLMean;
    const rightRatio = cheekRMean < EPS ? 0 : rightMean / cheekRMean;
    const staticAsym = normalizedDiff(leftRatio, rightRatio);

    const combined = MOTION_WEIGHT * motionAsym + STATIC_WEIGHT * staticAsym;
    scores[pair.key] = clamp(combined * 100, 0, 100);
  }

  // Mouth droop is the most specific of the three for stroke, so it leads the
  // aggregate; the brow term is kept because forehead *sparing* is what
  // separates a central lesion from a peripheral facial palsy.
  const overall = clamp(
    0.5 * scores.mouth + 0.3 * scores.eye + 0.2 * scores.brow,
    0,
    100,
  );

  let quality: SignalQuality = "good";
  if (faceRatio < 0.6) quality = "poor";
  else if (faceRatio < 0.85 || usable.length < MIN_FRAMES * 2) quality = "fair";

  return {
    mouth: Number(scores.mouth.toFixed(1)),
    eye: Number(scores.eye.toFixed(1)),
    brow: Number(scores.brow.toFixed(1)),
    overall: Number(overall.toFixed(1)),
    quality,
  };
}

/**
 * Express scores as an excess over the subject's calibrated resting asymmetry.
 * Without this step, a person with naturally uneven features reads as a
 * permanent alarm and the monitor is useless.
 */
export function applyBaseline(
  scores: AsymmetryScores,
  baseline: AsymmetryScores | null,
): AsymmetryMetrics {
  if (!baseline) {
    return {
      mouth: scores.mouth,
      eye: scores.eye,
      brow: scores.brow,
      overall: scores.overall,
      quality: scores.quality,
    };
  }

  const excess = (value: number, base: number) =>
    Number(clamp(value - base, 0, 100).toFixed(1));

  const mouth = excess(scores.mouth, baseline.mouth);
  const eye = excess(scores.eye, baseline.eye);
  const brow = excess(scores.brow, baseline.brow);

  return {
    mouth,
    eye,
    brow,
    overall: Number(clamp(0.5 * mouth + 0.3 * eye + 0.2 * brow, 0, 100).toFixed(1)),
    quality: scores.quality,
  };
}
