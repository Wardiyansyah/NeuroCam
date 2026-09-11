import { randomUUID } from "node:crypto";
import { getPostgresPool } from "@/lib/postgres";
import { simulationEnabled } from "@/lib/simulation";
import { incidentStore } from "@/lib/store";
import { streamTriage } from "@/lib/triage";
import { evaluate } from "@/lib/thresholds";
import type { AnalysisResult, HemodynamicMetrics, Incident } from "@/lib/types";

const NUMERIC_FIELDS = ["heartRate", "asymmetryIndex", "au12", "au6_7", "au4"] as const;

export async function POST(request: Request) {
  if (!simulationEnabled()) {
    return Response.json({ error: "Simulasi tidak diaktifkan." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body JSON tidak valid." }, { status: 400 });
  }

  const values = Object.fromEntries(
    NUMERIC_FIELDS.map((field) => [field, Number(body[field])]),
  ) as Record<(typeof NUMERIC_FIELDS)[number], number>;
  if (
    Object.values(values).some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
  values.asymmetryIndex > 100 ||
  values.au12 > 100 ||
  values.au6_7 > 100 ||
  values.au4 > 100
  ) {
    return Response.json({ error: "Semua metrik harus berupa angka dalam rentang valid." }, { status: 400 });
  }

  const quality = body.quality;
  if (quality !== "good" && quality !== "fair") {
    return Response.json({ error: "Kualitas sinyal tidak valid." }, { status: 400 });
  }

  const at = new Date().toISOString();
  const sessionId = `simulation-${randomUUID()}`;
  const hemodynamic: HemodynamicMetrics = {
    bpm: values.heartRate,
    baselineBpm: 75,
    spikePct: Number((((values.heartRate - 75) / 75) * 100).toFixed(1)),
    snrDb: quality === "good" ? 6 : 2,
    quality,
  };
  const asymmetry = {
    overall: values.asymmetryIndex,
    mouth: values.au12,
    eye: values.au6_7,
    brow: values.au4,
    quality,
  } as const;
  const evaluation = evaluate({
    hemodynamic,
    asymmetry,
    windowSeconds: quality === "good" ? 10 : 20,
    calibrated: true,
    faceTrackingRatio: 1,
    elapsedSeconds: quality === "good" ? 10 : 20,
  });
  const result: AnalysisResult = {
    sessionId,
    at,
    status: evaluation.status,
    hemodynamic,
    asymmetry,
    triggered: evaluation.triggered,
    windowSeconds: quality === "good" ? 10 : 20,
    calibrated: true,
    averages: {
      samples: 1,
      bpm: values.heartRate,
      asymmetryOverall: values.asymmetryIndex,
      asymmetryMouth: values.au12,
      asymmetryEye: values.au6_7,
      asymmetryBrow: values.au4,
      snrDb: hemodynamic.snrDb,
    },
  };

  const conclusion = await new Response(streamTriage(result, "summary")).text();
  let incidentId: string | undefined;
  if (result.status === "critical") {
    const incident: Incident = {
      id: randomUUID(),
      sessionId,
      at,
      status: "critical",
      metrics: {
        bpm: values.heartRate,
        baselineBpm: 75,
        hrSpikePct: hemodynamic.spikePct,
        asymmetryOverall: values.asymmetryIndex,
        asymmetryMouth: values.au12,
        asymmetryEye: values.au6_7,
        asymmetryBrow: values.au4,
        snrDb: hemodynamic.snrDb,
      },
      triggered: evaluation.triggered,
      triage: conclusion,
    };
    if (!getPostgresPool()) {
      return Response.json({ error: "DATABASE_URL belum dikonfigurasi untuk menyimpan insiden kritis." }, { status: 503 });
    }
    await incidentStore.append(incident);
    await incidentStore.update(incident.id, { triage: conclusion });
    incidentId = incident.id;
  }

  return Response.json({ success: true, status: result.status, conclusion, incidentId });
}
