/**
 * Session lifecycle - step 1 of the pipeline.
 *
 * The draft opens a WebRTC peer connection here. This implementation keeps the
 * signalling contract (create a session, get an id, tear it down) but carries
 * reduced metrics over HTTPS instead of raw video over WebRTC - see README for
 * why, and `lib/inference.ts` for the remote-GPU path that WebRTC would feed.
 */

import { sessionStore } from "@/lib/store";

const MIN_FPS = 5;
const MAX_FPS = 60;
const DEFAULT_FPS = 30;

export async function POST(request: Request) {
  let fps = DEFAULT_FPS;

  try {
    const body = await request.json();
    const parsed = Number(body?.fps);
    if (Number.isFinite(parsed)) {
      fps = Math.min(MAX_FPS, Math.max(MIN_FPS, parsed));
    }
  } catch {
    // Body is optional; the default capture rate is fine.
  }

  const state = await sessionStore.create(fps);

  return Response.json({
    sessionId: state.meta.id,
    startedAt: state.meta.startedAt,
    fps: state.meta.fps,
  });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "parameter 'id' wajib diisi" }, { status: 400 });
  }

  await sessionStore.delete(id);
  return new Response(null, { status: 204 });
}
