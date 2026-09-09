/**
 * Verification harness for the signal pipeline.
 * Synthesises ROI samples with a known ground truth and checks what comes back.
 */

import { estimatePulse, toHemodynamicMetrics } from "@/lib/signal/rppg";
import { computeAsymmetry, applyBaseline } from "@/lib/signal/asymmetry";
import { evaluate } from "@/lib/thresholds";
import { ROI_NAMES, type RoiName, type Rgb, type RoiSample } from "@/lib/types";

let failures = 0;
function check(name: string, condition: boolean, detail: string) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${name} — ${detail}`);
}

/** Blood-volume-pulse signature across RGB (de Haan): green carries the most. */
const BVP = [0.33, 0.77, 0.53];

interface SynthOptions {
  bpm: number;
  seconds: number;
  fps: number;
  /** Fractional modulation depth, e.g. 0.008 = 0.8% - realistic for skin. */
  depth: number;
  noise: number;
  /** ROIs whose motion is suppressed, to emulate unilateral weakness. */
  frozen?: RoiName[];
  /** Amplitude of the voluntary facial-motion component. */
  motion?: number;
}

function synth(opts: SynthOptions): RoiSample[] {
  const { bpm, seconds, fps, depth, noise, frozen = [], motion = 0.05 } = opts;
  const n = Math.round(seconds * fps);
  const hz = bpm / 60;
  const samples: RoiSample[] = [];

  // Deterministic PRNG so the check is reproducible.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 - 0.5;
  };

  for (let i = 0; i < n; i++) {
    const t = (i / fps) * 1000;
    const pulse = Math.sin(2 * Math.PI * hz * (i / fps));
    // Slow voluntary movement (e.g. speaking / smiling) at ~0.4 Hz.
    const move = Math.sin(2 * Math.PI * 0.4 * (i / fps));

    const roi = {} as Record<RoiName, Rgb>;
    for (const name of ROI_NAMES) {
      const base = [170, 130, 115];
      const moving = frozen.includes(name) ? 0 : move * motion;
      roi[name] = base.map((c, ch) =>
        Math.max(
          0,
          Math.min(255, c * (1 + depth * BVP[ch] * pulse + moving) + rand() * noise),
        ),
      ) as Rgb;
    }
    samples.push({ t, faceFound: true, roi });
  }
  return samples;
}

console.log("\n1. rPPG heart-rate recovery (12 s @ 30 fps, 0.8% modulation)");
for (const trueBpm of [55, 72, 98, 124]) {
  const samples = synth({ bpm: trueBpm, seconds: 12, fps: 30, depth: 0.008, noise: 0.3 });
  const est = estimatePulse(samples, 30);
  const err = est.bpm === null ? Infinity : Math.abs(est.bpm - trueBpm);
  check(
    `HR ${trueBpm} bpm`,
    err <= 3,
    `estimated ${est.bpm ?? "null"} bpm (error ${err.toFixed(1)}), SNR ${est.snrDb.toFixed(1)} dB, quality ${est.quality}`,
  );
}

console.log("\n2. Signal gate — noise-dominated input must not yield a confident HR");
{
  const samples = synth({ bpm: 72, seconds: 12, fps: 30, depth: 0.0, noise: 8 });
  const est = estimatePulse(samples, 30);
  check(
    "pure noise",
    est.quality === "poor" || est.bpm === null,
    `quality ${est.quality}, bpm ${est.bpm ?? "null"}, SNR ${est.snrDb.toFixed(1)} dB`,
  );
}

console.log("\n3. Face lost — must report poor, never a number");
{
  const samples = synth({ bpm: 72, seconds: 12, fps: 30, depth: 0.008, noise: 0.3 }).map(
    (s) => ({ ...s, faceFound: false }),
  );
  const est = estimatePulse(samples, 30);
  check("all frames faceFound=false", est.bpm === null, `bpm ${est.bpm ?? "null"}`);
}

console.log("\n4. Asymmetry — symmetric vs unilateral suppression");
{
  const symmetric = synth({ bpm: 72, seconds: 6, fps: 30, depth: 0.008, noise: 0.3 });
  const symScores = computeAsymmetry(symmetric);
  check(
    "symmetric face scores low",
    symScores.overall < 10,
    `overall ${symScores.overall}, mouth ${symScores.mouth}, quality ${symScores.quality}`,
  );

  const drooped = synth({
    bpm: 72,
    seconds: 6,
    fps: 30,
    depth: 0.008,
    noise: 0.3,
    frozen: ["mouthR", "eyeR", "browR"],
    motion: 0.06,
  });
  const droopScores = computeAsymmetry(drooped);
  check(
    "unilateral suppression scores high",
    droopScores.overall > symScores.overall + 20,
    `overall ${droopScores.overall} vs symmetric ${symScores.overall}, mouth ${droopScores.mouth}`,
  );

  // Baseline subtraction: a person with a permanent asymmetry should read ~0.
  const adjusted = applyBaseline(droopScores, droopScores);
  check(
    "own baseline cancels to zero",
    adjusted.overall < 1,
    `excess over own baseline = ${adjusted.overall}`,
  );
}

console.log("\n5. Threshold evaluation");
{
  const good = { quality: "good" as const };
  const base = {
    hemodynamic: { bpm: 72, snrDb: 6, baselineBpm: 72, spikePct: 0, ...good },
    asymmetry: { overall: 5, mouth: 5, eye: 5, brow: 5, ...good },
    windowSeconds: 6,
    calibrated: true,
    faceTrackingRatio: 1,
    elapsedSeconds: 30,
  };

  check("baseline case is normal", evaluate(base).status === "normal", evaluate(base).status);

  const hrOnly = { ...base, hemodynamic: { ...base.hemodynamic, bpm: 110, spikePct: 52.8 } };
  check("HR spike alone is warning", evaluate(hrOnly).status === "warning", evaluate(hrOnly).status);

  const asymOnly = { ...base, asymmetry: { ...base.asymmetry, overall: 30, mouth: 30 } };
  check(
    "moderate asymmetry alone is warning",
    evaluate(asymOnly).status === "warning",
    evaluate(asymOnly).status,
  );

  const both = {
    ...base,
    hemodynamic: { ...base.hemodynamic, bpm: 110, spikePct: 52.8 },
    asymmetry: { ...base.asymmetry, overall: 30, mouth: 30 },
  };
  check("both channels together is critical", evaluate(both).status === "critical", evaluate(both).status);

  const severeAsym = { ...base, asymmetry: { ...base.asymmetry, overall: 55, mouth: 55 } };
  check(
    "severe droop alone is critical",
    evaluate(severeAsym).status === "critical",
    evaluate(severeAsym).status,
  );

  const poorSignal = {
    ...base,
    hemodynamic: { ...base.hemodynamic, quality: "poor" as const },
  };
  const poorResult = evaluate(poorSignal);
  check(
    "poor signal is signal_lost, NOT normal",
    poorResult.status === "signal_lost",
    poorResult.status,
  );

  const shortWindow = { ...base, windowSeconds: 2, calibrated: false, elapsedSeconds: 3 };
  check(
    "short window defers verdict (not a false signal_lost)",
    evaluate(shortWindow).status === "calibrating",
    evaluate(shortWindow).status,
  );

  const faceGone = { ...base, faceTrackingRatio: 0 };
  check(
    "face untracked overrides good buffered history",
    evaluate(faceGone).status === "signal_lost",
    `${evaluate(faceGone).status} / ${evaluate(faceGone).triggered[0]?.code}`,
  );

  const faceGoneWhileCalibrating = {
    ...base,
    calibrated: false,
    windowSeconds: 2,
    elapsedSeconds: 3,
    faceTrackingRatio: 0,
  };
  check(
    "face gate outranks calibration",
    evaluate(faceGoneWhileCalibrating).status === "signal_lost",
    evaluate(faceGoneWhileCalibrating).status,
  );

  const stuckCalibration = {
    ...base,
    calibrated: false,
    windowSeconds: 6,
    elapsedSeconds: 120,
  };
  check(
    "calibration that never converges is reported, not left hanging",
    evaluate(stuckCalibration).status === "signal_lost" &&
      evaluate(stuckCalibration).triggered[0]?.code === "CALIBRATION_FAILED",
    `${evaluate(stuckCalibration).status} / ${evaluate(stuckCalibration).triggered[0]?.code}`,
  );

  const uncalibrated = { ...base, calibrated: false };
  check(
    "uncalibrated defers verdict",
    evaluate(uncalibrated).status === "calibrating",
    evaluate(uncalibrated).status,
  );
}

console.log("\n6. Metric assembly");
{
  const est = estimatePulse(
    synth({ bpm: 96, seconds: 12, fps: 30, depth: 0.008, noise: 0.3 }),
    30,
  );
  const metrics = toHemodynamicMetrics(est, 72);
  check(
    "spike percentage computed against baseline",
    metrics.spikePct !== null && Math.abs(metrics.spikePct - 33.3) < 6,
    `bpm ${metrics.bpm}, baseline 72, spike ${metrics.spikePct}%`,
  );
}

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
