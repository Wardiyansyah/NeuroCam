/**
 * Medical threshold evaluation - step 4 of the pipeline.
 *
 * The rule the draft specifies: aggregate the last 5 seconds, and when heart
 * rate fluctuation AND facial asymmetry both breach their limits at the same
 * time, escalate to "critical". One alone is a warning.
 *
 * The gate that comes before all of that is the important one: a poor-quality
 * signal must never be reported as "normal". Reading "no anomaly detected" off
 * a lost face track is the failure mode that actually hurts someone, so an
 * unusable signal resolves to `signal_lost` and the UI says so plainly.
 *
 * Every number here is a screening heuristic chosen to be legible and tunable.
 * None of it is clinically validated - see README.
 * High facial asymmetry is also critical on its
 * own because it is the facial sign in the FAST protocol.
 */

import type {
  AsymmetryMetrics,
  HemodynamicMetrics,
  MonitorStatus,
  TriggeredRule,
} from "@/lib/types";

export interface Thresholds {
  /** Seconds of signal that must accumulate before any verdict is issued. */
  windowSeconds: number;
  /** Percent deviation from personal baseline HR that counts as a spike. */
  hrSpikePct: number;
  /** Extreme deviation that escalates immediately, even with good signal. */
  hrCriticalSpikePct: number;
  /** Absolute heart-rate bounds, outside which we flag regardless of baseline. */
  hrAbsoluteMin: number;
  hrAbsoluteMax: number;
  /** Asymmetry excess over baseline, 0-100. */
  asymmetryWarn: number;
  asymmetryCritical: number;
  /** Minimum pulse SNR in dB before an HR reading is allowed to drive a rule. */
  minSnrDb: number;
  /** Fraction of recent frames that must contain a face to issue any verdict. */
  minFaceRatio: number;
  /** After this long without a baseline, calibration is treated as failed. */
  calibrationTimeoutSeconds: number;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const THRESHOLDS: Thresholds = {
  windowSeconds: numberFromEnv("STROKE_WINDOW_SECONDS", 5),
  hrSpikePct: numberFromEnv("STROKE_HR_SPIKE_PCT", 30),
  hrCriticalSpikePct: numberFromEnv("STROKE_HR_CRITICAL_SPIKE_PCT", 50),
  hrAbsoluteMin: numberFromEnv("STROKE_HR_MIN", 40),
  hrAbsoluteMax: numberFromEnv("STROKE_HR_MAX", 130),
  asymmetryWarn: 1,//numberFromEnv("STROKE_ASYMMETRY_WARN", 25),
  asymmetryCritical: 2,//numberFromEnv("STROKE_ASYMMETRY_CRITICAL", 40),
  minSnrDb: numberFromEnv("STROKE_MIN_SNR_DB", 0),
  minFaceRatio: numberFromEnv("STROKE_MIN_FACE_RATIO", 0.5),
  calibrationTimeoutSeconds: numberFromEnv("STROKE_CALIBRATION_TIMEOUT_SECONDS", 60),
};

export interface EvaluationInput {
  hemodynamic: HemodynamicMetrics;
  asymmetry: AsymmetryMetrics;
  windowSeconds: number;
  calibrated: boolean;
  /**
   * Fraction of frames in the last couple of seconds that had a face.
   *
   * Deliberately measured over a *short recent* window rather than the whole
   * buffer. A patient who walks away leaves ten seconds of perfectly good
   * history behind them, and averaging over that history would keep reporting
   * "normal" from stale data long after there was anyone to report on.
   */
  faceTrackingRatio: number;
  /** Seconds since the session began, used to spot calibration that never converges. */
  elapsedSeconds: number;
  /** Number of non-decreasing qualifying spikes seen in this session. */
  increasingSpikeCount?: number;
}

export interface Evaluation {
  status: MonitorStatus;
  triggered: TriggeredRule[];
}

function signalLost(detail: string, code = "SIGNAL_LOST"): Evaluation {
  return {
    status: "signal_lost",
    triggered: [
      {
        code,
        label: "Sinyal tidak memadai",
        detail: `${detail} Status ini TIDAK dapat diartikan sebagai normal.`,
      },
    ],
  };
}

export function evaluate(
  input: EvaluationInput,
  thresholds: Thresholds = THRESHOLDS,
): Evaluation {
  const {
    hemodynamic,
    asymmetry,
    windowSeconds,
    calibrated,
    faceTrackingRatio,
    elapsedSeconds,
    increasingSpikeCount = 0,
  } = input;
  const triggered: TriggeredRule[] = [];

  // --- Signal gates. These run before every other rule. --------------------

  // 1. The face is not being tracked *right now*. Checked first and against
  //    recent frames only, so stale history can never stand in for a subject
  //    who is no longer in front of the camera.
  if (faceTrackingRatio < thresholds.minFaceRatio) {
    return signalLost(
      `Wajah tidak terdeteksi pada ${Math.round((1 - faceTrackingRatio) * 100)}% bingkai terakhir.`,
      "FACE_NOT_TRACKED",
    );
  }

  // 2. Not enough signal yet. This is a normal startup condition, not a fault -
  //    reporting "signal lost" for the first seconds of every session would
  //    train users to ignore the one status that must never be ignored.
  if (windowSeconds < thresholds.windowSeconds || !calibrated) {
    // Unless calibration has had far longer than it needs and still failed,
    // in which case the session really is stuck and should say so.
    if (elapsedSeconds > thresholds.calibrationTimeoutSeconds && !calibrated) {
      return signalLost(
        "Kalibrasi tidak selesai dalam waktu yang wajar; kualitas sinyal terlalu rendah untuk membentuk baseline.",
        "CALIBRATION_FAILED",
      );
    }
    return { status: "calibrating", triggered: [] };
  }

  // 3. Face present and enough data, but the signal itself is unusable.
  if (hemodynamic.quality === "poor" || asymmetry.quality === "poor") {
    return signalLost("Kualitas sinyal terlalu rendah untuk dinilai.");
  }

  // --- Hemodynamic rules ---------------------------------------------------
  let hrAnomaly = false;
  const snrOk = hemodynamic.snrDb >= thresholds.minSnrDb;

  if (hemodynamic.bpm !== null && snrOk) {
    if (
      hemodynamic.spikePct !== null &&
      Math.abs(hemodynamic.spikePct) >= thresholds.hrSpikePct
    ) {
      hrAnomaly = true;
      triggered.push({
        code: "HR_SPIKE",
        label: "Fluktuasi detak jantung",
        detail:
          `Detak jantung ${hemodynamic.bpm} bpm, menyimpang ` +
          `${hemodynamic.spikePct > 0 ? "+" : ""}${hemodynamic.spikePct}% dari ` +
          `baseline ${hemodynamic.baselineBpm} bpm (ambang ±${thresholds.hrSpikePct}%).`,
      });
    }

    if (increasingSpikeCount >= 3) {
      triggered.push({
        code: "HR_SPIKE_ESCALATED",
        label: "Lonjakan meningkat tiga kali",
        detail:
          `Terdapat ${increasingSpikeCount} lonjakan berturut-turut yang masing-masing ` +
          `sama atau lebih tinggi dari lonjakan sebelumnya.`,
      });
    }

    if (
      hemodynamic.bpm < thresholds.hrAbsoluteMin ||
      hemodynamic.bpm > thresholds.hrAbsoluteMax
    ) {
      hrAnomaly = true;
      triggered.push({
        code: "HR_OUT_OF_RANGE",
        label: "Detak jantung di luar rentang",
        detail:
          `Detak jantung ${hemodynamic.bpm} bpm berada di luar rentang ` +
          `${thresholds.hrAbsoluteMin}-${thresholds.hrAbsoluteMax} bpm.`,
      });
    }
  }

  // --- Asymmetry rules -----------------------------------------------------
  const asymCritical = asymmetry.overall >= thresholds.asymmetryCritical;
  const asymAnomaly = asymmetry.overall >= thresholds.asymmetryWarn;

  if (asymAnomaly) {
    triggered.push({
      code: asymCritical ? "ASYMMETRY_CRITICAL" : "ASYMMETRY_ELEVATED",
      label: "Asimetri wajah",
      detail:
        `Indeks asimetri ${asymmetry.overall}/100 di atas baseline pribadi ` +
        `(mulut ${asymmetry.mouth}, mata ${asymmetry.eye}, alis ${asymmetry.brow}). ` +
        `Ambang: peringatan ${thresholds.asymmetryWarn}, kritis ${thresholds.asymmetryCritical}.`,
    });
  }

  // --- Combination ---------------------------------------------------------
  // High facial asymmetry is itself an emergency FAST finding; it must not
  // wait for a separate heart-rate escalation before becoming critical.
  if (asymCritical) {
    return { status: "critical", triggered };
  }

  // Simultaneous breach on both axes is the draft's escalation condition.
  if (hrAnomaly && asymAnomaly) {
    return { status: "critical", triggered };
  }
  if (hrAnomaly || asymAnomaly) {
    return { status: "warning", triggered };
  }

  return { status: "normal", triggered };
}
