/**
 * Anonymised incident history for the hospital dashboard.
 *
 * Returns metric numbers and timestamps only - the same shape that is written
 * to storage. There is no endpoint that returns video, because no video is
 * ever retained.
 */

import { incidentStore } from "@/lib/store";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("limit");
  const parsed = Number(raw);
  const limit = Number.isFinite(parsed)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)))
    : DEFAULT_LIMIT;

  try {
    const incidents = await incidentStore.list(limit);
    return Response.json({ incidents, count: incidents.length });
  } catch (error) {
    console.error("Gagal membaca insiden dari PostgreSQL:", error);
    return Response.json(
      { error: "Gagal membaca riwayat insiden dari database." },
      { status: 503 },
    );
  }
}
