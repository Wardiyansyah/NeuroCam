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
import type { AnalysisResult, Incident, RoiSample, SessionMeta } from "@/lib/types";

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
  baselineAsymmetry: AsymmetryScores | null;
  /** Heart-rate readings collected during calibration. */
  calibrationBpm: number[];
  calibrationAsymmetry: AsymmetryScores[];
  calibrated: boolean;
  /** Most recent verdict, so the triage route can work from server state
   *  instead of trusting metrics posted back by the client. */
  lastResult?: AnalysisResult;
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
      baselineAsymmetry: null,
      calibrationBpm: [],
      calibrationAsymmetry: [],
      calibrated: false,
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

export const incidentStore: IncidentStore = {
  async append(incident: Incident) {
    incidents.unshift(incident);
    // Keep the demo store bounded; a real backend would page instead.
    if (incidents.length > 200) incidents.length = 200;
  },

  async update(id: string, patch: Partial<Incident>) {
    const found = incidents.find((i) => i.id === id);
    if (found) Object.assign(found, patch);
  },

  async list(limit = 50) {
    return incidents.slice(0, limit);
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
