/**
 * Metric extraction and crisis evaluation - steps 3 and 4.
 *
 * Accepts a batch of reduced frames (per-ROI mean colour, no pixels), folds
 * them into the session's rolling window, and returns the current verdict.
 */

import { analyzeSession } from "@/lib/inference";
import { sessionStore } from "@/lib/store";
import { ROI_NAMES, type Rgb, type RoiSample } from "@/lib/types";

/** One second of 60 fps capture, with headroom for a delayed flush. */
const MAX_BATCH = 200;

function parseRgb(value: unknown): Rgb | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out = value.map(Number);
  if (out.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return null;
  return out as Rgb;
}

/**
 * Validate the batch rather than trusting it. Malformed samples would otherwise
 * propagate NaN through the FFT and produce a confident-looking wrong answer.
 */
function parseSamples(value: unknown): RoiSample[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH) {
    return null;
  }

  const samples: RoiSample[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const candidate = raw as Record<string, unknown>;

    const t = Number(candidate.t);
    if (!Number.isFinite(t) || t < 0) return null;

    const roiInput = candidate.roi;
    if (typeof roiInput !== "object" || roiInput === null) return null;

    const roi = {} as Record<(typeof ROI_NAMES)[number], Rgb>;
    for (const name of ROI_NAMES) {
      const rgb = parseRgb((roiInput as Record<string, unknown>)[name]);
      if (!rgb) return null;
      roi[name] = rgb;
    }

    samples.push({ t, faceFound: candidate.faceFound !== false, roi });
  }

  return samples;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body JSON tidak valid" }, { status: 400 });
  }

  const { sessionId, samples: rawSamples } = (body ?? {}) as Record<string, unknown>;

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return Response.json({ error: "sessionId wajib diisi" }, { status: 400 });
  }

  const samples = parseSamples(rawSamples);
  if (!samples) {
    return Response.json(
      { error: `samples tidak valid (maksimum ${MAX_BATCH} frame per batch)` },
      { status: 400 },
    );
  }

  const state = await sessionStore.get(sessionId);
  if (!state) {
    // Expired or served by another instance - the client restarts the session.
    return Response.json({ error: "sesi tidak ditemukan", code: "SESSION_GONE" }, { status: 404 });
  }

  const result = await analyzeSession(state, samples);
  await sessionStore.save(state);

  return Response.json(result);
}
