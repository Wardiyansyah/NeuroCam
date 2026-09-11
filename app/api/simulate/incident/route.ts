import { randomUUID } from "node:crypto";
import { getPostgresPool } from "@/lib/postgres";
import { simulationEnabled } from "@/lib/simulation";
import type { Incident } from "@/lib/types";

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

  const status = body.status;
  if (status !== "warning" && status !== "critical") {
    return Response.json({ error: "Status insiden tidak valid." }, { status: 400 });
  }

  const critical = status === "critical";
  const sessionId = `simulation-${randomUUID().slice(0, 8)}`;
  const at = new Date().toISOString();
  const incident: Incident = {
    id: randomUUID(),
    sessionId,
    at,
    status,
    metrics: {
      bpm: critical ? 180 : 130,
      baselineBpm: 60,
      hrSpikePct: critical ? 200 : 116.7,
      asymmetryOverall: critical ? 100 : 75,
      asymmetryMouth: critical ? 100 : 75,
      asymmetryEye: critical ? 100 : 75,
      asymmetryBrow: critical ? 100 : 75,
      snrDb: 30,
    },
    triggered: [
      {
        code: critical ? "SIM_CRITICAL" : "SIM_WARNING",
        label: critical ? "Simulasi critical" : "Simulasi warning",
        detail: "Insiden dibuat secara manual untuk pengujian.",
      },
    ],
  };

  const pool = getPostgresPool();
  if (!pool) {
    return Response.json(
      { error: "DATABASE_URL belum dikonfigurasi." },
      { status: 503 },
    );
  }

  try {
    await pool.query(
      `INSERT INTO public.face_scan_metrics (
         session_id, heart_rate_bpm, asymmetry_index, au12_mouth,
         au6_7_eye, au4_eyebrow, scan_status, scan_notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        incident.sessionId,
        incident.metrics.bpm,
        incident.metrics.asymmetryOverall,
        incident.metrics.asymmetryMouth,
        incident.metrics.asymmetryEye,
        incident.metrics.asymmetryBrow,
        incident.status,
        "Insiden simulasi manual",
      ],
    );
  } catch (error) {
    console.error(
      "Gagal menyimpan insiden simulasi:",
      error instanceof Error ? error.message : error,
    );
    return Response.json(
      { error: "Insiden simulasi gagal disimpan ke database." },
      { status: 500 },
    );
  }

  return Response.json({ success: true, incident });
}
