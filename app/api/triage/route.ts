/**
 * Triage assistant - step 5.
 *
 * Streams guidance text as it is generated. Metrics are read from server-side
 * session state, not from the request body, so the client cannot inject
 * arbitrary numbers into the clinical prompt.
 */

import { sessionStore, incidentStore } from "@/lib/store";
import { streamTriage } from "@/lib/triage";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body JSON tidak valid" }, { status: 400 });
  }

  const { sessionId } = (body ?? {}) as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return Response.json({ error: "sessionId wajib diisi" }, { status: 400 });
  }

  const state = await sessionStore.get(sessionId);
  if (!state?.lastResult) {
    return Response.json(
      { error: "belum ada hasil analisis untuk sesi ini" },
      { status: 404 },
    );
  }

  const result = state.lastResult;
  if (result.status !== "critical" && result.status !== "warning") {
    return Response.json(
      { error: "triase hanya tersedia untuk status warning atau critical" },
      { status: 409 },
    );
  }

  const [clientStream, storeStream] = streamTriage(result).tee();

  // Attach the finished narrative to the incident record without making the
  // patient's stream wait on the write.
  if (result.incidentId) {
    const incidentId = result.incidentId;
    void (async () => {
      const text = await new Response(storeStream).text();
      await incidentStore.update(incidentId, { triage: text });
    })();
  } else {
    void storeStream.cancel();
  }

  return new Response(clientStream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      // Stop proxies from buffering the stream into a single late chunk.
      "x-accel-buffering": "no",
    },
  });
}
