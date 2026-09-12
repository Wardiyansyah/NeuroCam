/**
 * Session and incident storage.
 *
 * The draft calls for Redis (hot session state) and Supabase/Postgres (incident
 * history). This module defines the interfaces both of those would implement
 * and ships an in-process implementation so the app runs with zero external
 * services.
 *
 * PRODUCTION NOTE: the in-memory store is per-process. On a serverless or
 * multi-instance deployment, sessions will scatter across instances and rolling
 * windows will break. Swap `sessionStore` for a Redis-backed implementation and
 * `incidentStore` for Supabase before deploying anywhere that autoscales - the
 * interfaces below are the whole contract you need to satisfy.
 */

import { randomUUID } from "node:crypto";
import type { AsymmetryScores } from "@/lib/signal/asymmetry";
import type { AnalysisResult, Incident, MetricAverages, RoiSample, SessionMeta } from "@/lib/types";
import { getPostgresPool } from "@/lib/postgres";

/** How much history each session retains. */
export const BUFFER_SECONDS = 12;
/**
 * Pulse needs a longer window than crisis evaluation does: frequency resolution
 * scales with window length, and a 5-second window cannot separate 70 from 76
 * bpm. Asymmetry and the crisis verdict use the draft's 5-second window; the
 * heart-rate estimate underneath them looks back further.
 */
export const PULSE_WINDOW_SECONDS = 10;
export const CRISIS_WINDOW_SECONDS = 5;
/**
 * Face tracking is gated on a short recent window, not the whole buffer, so a
 * subject who leaves the frame is noticed in ~2 s instead of being masked by
 * the good history still sitting in the buffer behind them.
 */
export const FACE_GATE_SECONDS = 2;
/** Resting baselines are established over this long before any verdict. */
export const CALIBRATION_SECONDS = 20;

/** Sessions untouched for this long are dropped. */
const SESSION_TTL_MS = 5 * 60 * 1000;

export interface SessionState {
  meta: SessionMeta;
  /** Rolling window of reduced frames. Never contains pixels. */
  samples: RoiSample[];
  baselineBpm: number | null;
  /** Last accepted pulse estimate, used to reject abrupt spectral jumps. */
  lastPulseBpm: number | null;
  baselineAsymmetry: AsymmetryScores | null;
  /** Heart-rate readings collected during calibration. */
  calibrationBpm: number[];
  calibrationAsymmetry: AsymmetryScores[];
  calibrated: boolean;
  /** Most recent verdict, so the triage route can work from server state
   *  instead of trusting metrics posted back by the client. */
  lastResult?: AnalysisResult;
  metricAggregate?: {
    count: number;
    bpmSum: number;
    bpmCount: number;
    spikePctSum: number;
    spikePctCount: number;
    asymmetryOverallSum: number;
    asymmetryMouthSum: number;
    asymmetryEyeSum: number;
    asymmetryBrowSum: number;
    snrDbSum: number;
  };
  increasingSpikeCount: number;
  previousSpikeMagnitude: number | null;
}

export interface SessionStore {
  create(fps: number): Promise<SessionState>;
  get(id: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface IncidentStore {
  append(incident: Incident): Promise<void>;
  update(id: string, patch: Partial<Incident>): Promise<void>;
  list(limit?: number): Promise<Incident[]>;
}

/**
 * Hold state on globalThis so the dev server's hot reload does not wipe live
 * sessions on every edit.
 */
const globalState = globalThis as unknown as {
  __strokeSessions?: Map<string, SessionState>;
  __strokeIncidents?: Incident[];
};

const sessions = (globalState.__strokeSessions ??= new Map<string, SessionState>());
const incidents = (globalState.__strokeIncidents ??= []);

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asStatus(value: unknown): Incident["status"] | null {
  if (typeof value !== "string") return null;
  const status = value.toLowerCase();
  return status === "warning" || status === "critical" ? status : null;
}

function parseTriggered(value: unknown): Incident["triggered"] {
  if (Array.isArray(value)) return value as Incident["triggered"];
  if (typeof value !== "string") return [];

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Incident["triggered"]) : [];
  } catch {
    return [];
  }
}

function mapDatabaseIncident(row: Record<string, unknown>): Incident | null {
  const status = asStatus(row.scan_status);
  if (!status) return null;

  return {
    id: String(row.id ?? `${row.session_id ?? "incident"}-${row.created_at ?? row.at}`),
    sessionId: String(row.session_id ?? ""),
    at: String(row.created_at ?? row.at ?? new Date().toISOString()),
    status,
    metrics: {
      bpm: asNumber(row.heart_rate_bpm),
      baselineBpm: null,
      hrSpikePct: null,
      asymmetryOverall: asNumber(row.asymmetry_index) ?? 0,
      asymmetryMouth: asNumber(row.au12_mouth) ?? 0,
      asymmetryEye: asNumber(row.au6_7_eye) ?? 0,
      asymmetryBrow: asNumber(row.au4_eyebrow) ?? 0,
      snrDb: 0,
    },
    triggered: parseTriggered(row.triggered_rules),
    triage: typeof row.scan_notes === "string" ? row.scan_notes : undefined,
  };
}

function pruneExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, state] of sessions) {
    if (new Date(state.meta.lastSeenAt).getTime() < cutoff) sessions.delete(id);
  }
}

export const sessionStore: SessionStore = {
  async create(fps: number) {
    pruneExpired();
    const now = new Date().toISOString();
    const state: SessionState = {
      meta: { id: randomUUID(), startedAt: now, lastSeenAt: now, fps },
      samples: [],
      baselineBpm: null,
      lastPulseBpm: null,
      baselineAsymmetry: null,
      calibrationBpm: [],
      calibrationAsymmetry: [],
      calibrated: false,
      metricAggregate: undefined,
      increasingSpikeCount: 0,
      previousSpikeMagnitude: null,
    };

    sessions.set(state.meta.id, state);
    return state;
  },

  async get(id: string) {
    pruneExpired();
    return sessions.get(id) ?? null;
  },

  async save(state: SessionState) {
    state.meta.lastSeenAt = new Date().toISOString();
    sessions.set(state.meta.id, state);
  },

  async delete(id: string) {
    sessions.delete(id);
  },
};

export function metricAverages(state: SessionState): MetricAverages {
  const aggregate = state.metricAggregate;
  if (!aggregate || aggregate.count === 0) {
    return {
      samples: 0,
      bpm: null,
      spikePct: null,
      asymmetryOverall: 0,
      asymmetryMouth: 0,
      asymmetryEye: 0,
      asymmetryBrow: 0,
      snrDb: 0,
    };
  }

  return {
    samples: aggregate.count,
    bpm:
      aggregate.bpmCount > 0
        ? Number((aggregate.bpmSum / aggregate.bpmCount).toFixed(1))
        : null,
    spikePct:
      aggregate.spikePctCount > 0
        ? Number((aggregate.spikePctSum / aggregate.spikePctCount).toFixed(1))
        : null,
    asymmetryOverall: Number((aggregate.asymmetryOverallSum / aggregate.count).toFixed(1)),
    asymmetryMouth: Number((aggregate.asymmetryMouthSum / aggregate.count).toFixed(1)),
    asymmetryEye: Number((aggregate.asymmetryEyeSum / aggregate.count).toFixed(1)),
    asymmetryBrow: Number((aggregate.asymmetryBrowSum / aggregate.count).toFixed(1)),
    snrDb: Number((aggregate.snrDbSum / aggregate.count).toFixed(2)),
  };
}

export const incidentStore: IncidentStore = {
  async append(incident: Incident) {
    const existingIndex = incidents.findIndex(
      (storedIncident) => storedIncident.sessionId === incident.sessionId,
    );
    if (existingIndex >= 0) {
      Object.assign(incidents[existingIndex], incident);
    } else {
      incidents.unshift(incident);
    }
    // Keep the demo store bounded; a real backend would page instead.
    if (incidents.length > 200) incidents.length = 200;

    const pool = getPostgresPool();
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [incident.sessionId],
        );

        const existing = await client.query<{ id: string }>(
          `SELECT id
           FROM public.face_scan_metrics
           WHERE session_id = $1
           ORDER BY created_at ASC
           LIMIT 1`,
          [incident.sessionId],
        );
        const values = [
          incident.at,
          incident.metrics.bpm,
          incident.metrics.asymmetryOverall,
          incident.metrics.asymmetryMouth,
          incident.metrics.asymmetryEye,
          incident.metrics.asymmetryBrow,
          incident.status,
          JSON.stringify(incident.triggered),
          incident.sessionId,
        ];

        if (existing.rows[0]) {
          await client.query(
            `UPDATE public.face_scan_metrics
             SET created_at = $1,
                 heart_rate_bpm = $2,
                 asymmetry_index = $3,
                 au12_mouth = $4,
                 au6_7_eye = $5,
                 au4_eyebrow = $6,
                 scan_status = $7,
                 triggered_rules = $8
             WHERE id = $9`,
            [...values.slice(0, 8), existing.rows[0].id],
          );
          await client.query(
            `DELETE FROM public.face_scan_metrics
             WHERE session_id = $1 AND id <> $2`,
            [incident.sessionId, existing.rows[0].id],
          );
        } else {
          await client.query(
            `INSERT INTO public.face_scan_metrics (
               session_id, created_at, heart_rate_bpm, asymmetry_index, au12_mouth,
               au6_7_eye, au4_eyebrow, scan_status, scan_notes, triggered_rules
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              incident.sessionId,
              incident.at,
              ...values.slice(1, 7),
              null,
              values[7],
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  },

  async update(id: string, patch: Partial<Incident>) {
    const found = incidents.find((i) => i.id === id);
    if (found) Object.assign(found, patch);

    if (patch.triage) {
      const pool = getPostgresPool();
      if (pool) {
        await pool.query(
          `UPDATE public.face_scan_metrics
           SET scan_notes = $1
           WHERE session_id = $2
             AND created_at = $3`,
          [patch.triage, found?.sessionId, found?.at],
        );
      }
    }
  },

  async list(limit?: number) {
    const pool = getPostgresPool();
    if (pool) {
      const query = `SELECT *
        FROM public.face_scan_metrics
        WHERE LOWER(scan_status) IN ('warning', 'critical')
        ORDER BY created_at DESC${limit === undefined ? "" : " LIMIT $1"}`;
      const result = await pool.query<Record<string, unknown>>(
        query,
        limit === undefined ? [] : [limit],
      );

      return result.rows
        .map(mapDatabaseIncident)
        .filter((incident): incident is Incident => incident !== null);
    }

    return limit === undefined ? incidents : incidents.slice(0, limit);
  },
};

/**
 * Append new frames and drop anything older than the retention window.
 * Samples arrive with timestamps relative to session start.
 */
export function appendSamples(state: SessionState, incoming: RoiSample[]): void {
  if (incoming.length === 0) return;

  state.samples.push(...incoming);
  state.samples.sort((a, b) => a.t - b.t);

  const latest = state.samples[state.samples.length - 1].t;
  const cutoff = latest - BUFFER_SECONDS * 1000;
  const firstKept = state.samples.findIndex((s) => s.t >= cutoff);
  if (firstKept > 0) state.samples.splice(0, firstKept);
}

/** The most recent `seconds` of samples. */
export function windowOf(state: SessionState, seconds: number): RoiSample[] {
  if (state.samples.length === 0) return [];
  const latest = state.samples[state.samples.length - 1].t;
  const cutoff = latest - seconds * 1000;
  return state.samples.filter((s) => s.t >= cutoff);
}

/** Seconds of signal currently buffered. */
export function bufferedSeconds(state: SessionState): number {
  if (state.samples.length < 2) return 0;
  const first = state.samples[0].t;
  const last = state.samples[state.samples.length - 1].t;
  return (last - first) / 1000;
}
