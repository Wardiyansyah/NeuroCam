/**
 * Shared domain types for the contactless stroke pre-screening pipeline.
 *
 * Privacy note: nothing in this module carries pixels or frames. The client
 * reduces each video frame to a handful of per-ROI mean RGB triples before
 * anything leaves the browser, so `RoiSample` is the widest data type that
 * ever crosses the network.
 */

/** Regions of interest sampled from each frame. */
export const ROI_NAMES = [
  "forehead",
  "cheekL",
  "cheekR",
  "browL",
  "browR",
  "eyeL",
  "eyeR",
  "mouthL",
  "mouthR",
] as const;

export type RoiName = (typeof ROI_NAMES)[number];

/** Mean colour of an ROI as [r, g, b], each 0-255. */
export type Rgb = [number, number, number];

/** One frame, reduced to per-ROI mean colour. */
export interface RoiSample {
  /** Milliseconds since session start. */
  t: number;
  /** False when the face tracker lost the face on this frame. */
  faceFound: boolean;
  roi: Record<RoiName, Rgb>;
}

export type SignalQuality = "good" | "fair" | "poor";

/** Output of the rPPG stage. */
export interface HemodynamicMetrics {
  /** Estimated heart rate, or null when the signal is too poor to call. */
  bpm: number | null;
  /** Blood-volume-pulse signal-to-noise ratio, in dB. */
  snrDb: number;
  quality: SignalQuality;
  /** Rolling baseline the session has settled on, once calibrated. */
  baselineBpm: number | null;
  /** Percent deviation of `bpm` from `baselineBpm`. */
  spikePct: number | null;
}

/**
 * Output of the facial-asymmetry stage.
 *
 * These are *photometric proxies* for the named Action Units, not FACS coding.
 * They are computed from left/right ROI luminance dynamics, so they respond to
 * asymmetric movement and shading, not to landmark geometry. See
 * `lib/signal/asymmetry.ts` for what each one actually measures.
 */
export interface AsymmetryMetrics {
  /** Aggregate 0-100 asymmetry index. */
  overall: number;
  /** AU12 (lip-corner puller) proxy - the classic droop indicator. */
  mouth: number;
  /** AU6/AU7 (orbital) proxy - eyelid droop. */
  eye: number;
  /** AU4 (brow lowerer) proxy - forehead sparing is diagnostic in stroke. */
  brow: number;
  quality: SignalQuality;
}

export type MonitorStatus =
  | "idle"
  | "calibrating"
  | "normal"
  | "warning"
  | "critical"
  | "signal_lost";

/** Which rule fired, for display and for the triage prompt. */
export interface TriggeredRule {
  code: string;
  label: string;
  detail: string;
}

/** Result of one evaluation cycle over the rolling window. */
export interface AnalysisResult {
  sessionId: string;
  /** Server clock, ISO 8601. */
  at: string;
  status: MonitorStatus;
  hemodynamic: HemodynamicMetrics;
  asymmetry: AsymmetryMetrics;
  triggered: TriggeredRule[];
  /** Seconds of usable signal accumulated so far. */
  windowSeconds: number;
  /** True once a baseline heart rate has been established. */
  calibrated: boolean;
  /** Running averages used when the monitoring session is auto-completed. */
  averages: MetricAverages;
  /** Set when this cycle escalated to critical and an incident was recorded. */
  incidentId?: string;
}

export interface MetricAverages {
  samples: number;
  bpm: number | null;
  spikePct: number | null;
  asymmetryOverall: number;
  asymmetryMouth: number;
  asymmetryEye: number;
  asymmetryBrow: number;
  snrDb: number;
}

/**
 * An anonymised incident record. Per the privacy design this holds numbers and
 * a timestamp only - no video, no images, no identifying fields.
 */
export interface Incident {
  id: string;
  sessionId: string;
  at: string;
  status: Extract<MonitorStatus, "warning" | "critical">;
  metrics: {
    bpm: number | null;
    baselineBpm: number | null;
    hrSpikePct: number | null;
    asymmetryOverall: number;
    asymmetryMouth: number;
    asymmetryEye: number;
    asymmetryBrow: number;
    snrDb: number;
  };
  triggered: TriggeredRule[];
  /** Triage text, filled in asynchronously once the LLM responds. */
  triage?: string;
}

export interface SessionMeta {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  /** Frames per second the client reports it is capturing at. */
  fps: number;
}
