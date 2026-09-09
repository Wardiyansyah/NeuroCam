/**
 * Analysis orchestration - step 3 and 4 of the pipeline.
 *
 * Two execution modes:
 *
 *  1. LOCAL (default). The CHROM rPPG and photometric asymmetry stages in
 *     `lib/signal/` run in the Node process. No GPU, no external service, and
 *     no raw video ever leaves the browser - the client sends reduced per-ROI
 *     colour means only.
 *
 *  2. REMOTE. Set `INFERENCE_SERVER_URL` and metric extraction is delegated to
 *     the FastAPI + PyTorch service described in the draft (RunPod serverless
 *     GPU). The request/response contract is defined below. Thresholding,
 *     baselines and incident recording stay here either way, so the crisis
 *     logic has exactly one implementation.
 */

import { randomUUID } from "node:crypto";
import { applyBaseline, computeAsymmetry, type AsymmetryScores } from "@/lib/signal/asymmetry";
import { estimatePulse, toHemodynamicMetrics } from "@/lib/signal/rppg";
import { mean } from "@/lib/signal/stats";
import {
  CALIBRATION_SECONDS,
  CRISIS_WINDOW_SECONDS,
  FACE_GATE_SECONDS,
  PULSE_WINDOW_SECONDS,
  appendSamples,
  bufferedSeconds,
  incidentStore,
  windowOf,
  type SessionState,
} from "@/lib/store";
import { evaluate } from "@/lib/thresholds";
import type { AnalysisResult, HemodynamicMetrics, Incident, RoiSample } from "@/lib/types";

const INFERENCE_SERVER_URL = process.env.INFERENCE_SERVER_URL;
const INFERENCE_SERVER_TOKEN = process.env.INFERENCE_SERVER_TOKEN;
const INFERENCE_TIMEOUT_MS = 2000;

/** Shape the GPU inference server must return from `POST /extract`. */
interface RemoteMetrics {
  bpm: number | null;
  snrDb: number;
  quality: "good" | "fair" | "poor";
  asymmetry: { mouth: number; eye: number; brow: number; overall: number };
}

/**
 * Call the remote inference server. Returns null on any failure so the caller
 * can fall back to local extraction - a monitoring session must not go blind
 * because a GPU worker cold-started.
 */
async function extractRemote(
  samples: RoiSample[],
  fps: number,
): Promise<RemoteMetrics | null> {
  if (!INFERENCE_SERVER_URL) return null;

  try {
    const response = await fetch(`${INFERENCE_SERVER_URL.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(INFERENCE_SERVER_TOKEN
          ? { authorization: `Bearer ${INFERENCE_SERVER_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ fps, samples }),
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    return (await response.json()) as RemoteMetrics;
  } catch {
    return null;
  }
}

/** Median-ish central value that ignores the tails of a noisy calibration run. */
function robustMean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = Math.floor(sorted.length * 0.2);
  const hi = Math.ceil(sorted.length * 0.8);
  const trimmed = sorted.slice(lo, Math.max(hi, lo + 1));
  return trimmed.length === 0 ? null : Number(mean(trimmed).toFixed(1));
}

function averageAsymmetry(runs: AsymmetryScores[]): AsymmetryScores | null {
  if (runs.length === 0) return null;
  return {
    mouth: Number(mean(runs.map((r) => r.mouth)).toFixed(1)),
    eye: Number(mean(runs.map((r) => r.eye)).toFixed(1)),
    brow: Number(mean(runs.map((r) => r.brow)).toFixed(1)),
    overall: Number(mean(runs.map((r) => r.overall)).toFixed(1)),
    quality: "good",
  };
}

/**
 * Ingest a batch of frames and produce the current verdict.
 * Mutates `state` - the caller is responsible for persisting it.
 */
export async function analyzeSession(
  state: SessionState,
  incoming: RoiSample[],
): Promise<AnalysisResult> {
  appendSamples(state, incoming);

  const pulseWindow = windowOf(state, PULSE_WINDOW_SECONDS);
  const crisisWindow = windowOf(state, CRISIS_WINDOW_SECONDS);

  const remote = await extractRemote(pulseWindow, state.meta.fps);

  let hemodynamicRaw: HemodynamicMetrics;
  let asymmetryRaw: AsymmetryScores;

  if (remote) {
    hemodynamicRaw = {
      bpm: remote.bpm,
      snrDb: remote.snrDb,
      quality: remote.quality,
      baselineBpm: null,
      spikePct: null,
    };
    asymmetryRaw = { ...remote.asymmetry, quality: remote.quality };
  } else {
    const pulse = estimatePulse(pulseWindow, state.meta.fps);
    hemodynamicRaw = toHemodynamicMetrics(pulse, null);
    asymmetryRaw = computeAsymmetry(crisisWindow);
  }

  // --- Calibration ---------------------------------------------------------
  const elapsedSeconds =
    state.samples.length === 0 ? 0 : state.samples[state.samples.length - 1].t / 1000;

  if (!state.calibrated) {
    if (hemodynamicRaw.bpm !== null && hemodynamicRaw.quality !== "poor") {
      state.calibrationBpm.push(hemodynamicRaw.bpm);
    }
    if (asymmetryRaw.quality !== "poor") {
      state.calibrationAsymmetry.push(asymmetryRaw);
    }

    if (elapsedSeconds >= CALIBRATION_SECONDS && state.calibrationBpm.length >= 3) {
      state.baselineBpm = robustMean(state.calibrationBpm);
      state.baselineAsymmetry = averageAsymmetry(state.calibrationAsymmetry);
      state.calibrated = state.baselineBpm !== null;
    }
  }

  const hemodynamic: HemodynamicMetrics = {
    ...hemodynamicRaw,
    baselineBpm: state.baselineBpm,
    spikePct:
      hemodynamicRaw.bpm !== null && state.baselineBpm !== null && state.baselineBpm > 0
        ? Number(
            (((hemodynamicRaw.bpm - state.baselineBpm) / state.baselineBpm) * 100).toFixed(1),
          )
        : null,
  };

  const asymmetry = applyBaseline(asymmetryRaw, state.baselineAsymmetry);

  // Face presence is judged on the most recent frames only - see FACE_GATE_SECONDS.
  const gateWindow = windowOf(state, FACE_GATE_SECONDS);
  const faceTrackingRatio =
    gateWindow.length === 0
      ? 0
      : gateWindow.filter((s) => s.faceFound).length / gateWindow.length;

  const windowSeconds = Math.min(bufferedSeconds(state), CRISIS_WINDOW_SECONDS);
  const { status, triggered } = evaluate({
    hemodynamic,
    asymmetry,
    windowSeconds,
    calibrated: state.calibrated,
    faceTrackingRatio,
    elapsedSeconds,
  });

  const result: AnalysisResult = {
    sessionId: state.meta.id,
    at: new Date().toISOString(),
    status,
    hemodynamic,
    asymmetry,
    triggered,
    windowSeconds: Number(windowSeconds.toFixed(1)),
    calibrated: state.calibrated,
  };

  if (status === "critical" || status === "warning") {
    result.incidentId = await recordIncident(result);
  }

  state.lastResult = result;
  return result;
}

/**
 * Persist an anonymised incident: metric numbers and a timestamp, nothing else.
 * No frames, no images, no identifiers beyond the ephemeral session id.
 */
async function recordIncident(result: AnalysisResult): Promise<string> {
  const incident: Incident = {
    id: randomUUID(),
    sessionId: result.sessionId,
    at: result.at,
    status: result.status as "warning" | "critical",
    metrics: {
      bpm: result.hemodynamic.bpm,
      baselineBpm: result.hemodynamic.baselineBpm,
      hrSpikePct: result.hemodynamic.spikePct,
      asymmetryOverall: result.asymmetry.overall,
      asymmetryMouth: result.asymmetry.mouth,
      asymmetryEye: result.asymmetry.eye,
      asymmetryBrow: result.asymmetry.brow,
      snrDb: result.hemodynamic.snrDb,
    },
    triggered: result.triggered,
  };

  await incidentStore.append(incident);
  return incident.id;
}
