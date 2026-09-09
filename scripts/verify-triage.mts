/**
 * Verifies the OpenRouter triage transport: SSE reassembly across chunk
 * boundaries, and that every failure path still delivers usable guidance.
 */
import { streamTriage, triageAvailable } from "@/lib/triage";
import type { AnalysisResult } from "@/lib/types";

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

const RESULT: AnalysisResult = {
  sessionId: "test",
  at: new Date().toISOString(),
  status: "critical",
  hemodynamic: { bpm: 125, snrDb: 11.6, quality: "good", baselineBpm: 72, spikePct: 73.6 },
  asymmetry: { overall: 54.8, mouth: 54.8, eye: 54.8, brow: 54.7, quality: "good" },
  triggered: [{ code: "HR_SPIKE", label: "Fluktuasi detak jantung", detail: "125 bpm, +73.6%" }],
  windowSeconds: 5,
  calibrated: true,
  incidentId: "inc-1",
};

const read = () => new Response(streamTriage(RESULT)).text();

async function main() {
  console.log("\n1. Credential detection");
  {
    delete process.env.OPENROUTER_API_KEY;
    check("no key → unavailable", !triageAvailable(), `${triageAvailable()}`);

    const text = await read();
    check(
      "no key still returns full FAST guidance",
      /119/.test(text) && /PROTOKOL FAST/.test(text),
      text.split("\n")[0].slice(0, 70) + "…",
    );

    process.env.OPENROUTER_API_KEY = "k";
    check("key present → available", triageAvailable(), `${triageAvailable()}`);
  }

  console.log("\n2. Request targets OpenRouter and nothing else");
  {
    let seenUrl = "";
    let seenAuth = "";
    let seenModel = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).authorization ?? "");
      seenModel = JSON.parse(String(init.body)).model;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
              ),
            );
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await read();
    globalThis.fetch = original;

    check("endpoint is openrouter.ai", seenUrl.startsWith("https://openrouter.ai/api/v1/"), seenUrl);
    check("no api.anthropic.com call", !seenUrl.includes("anthropic.com"), seenUrl);
    check("bearer uses OPENROUTER_API_KEY", seenAuth === "Bearer k", seenAuth);
    check("model slug is vendor-namespaced", seenModel === "anthropic/claude-sonnet-4.5", seenModel);
  }

  console.log("\n3. SSE reassembly across chunk boundaries");
  {
    const full = "Ringkasan klinis lengkap dengan angka 125 bpm.";
    const frames =
      full
        .split("")
        .map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`)
        .join("") + "data: [DONE]\n\n";

    // Slice the SSE bytes at awkward offsets so frames straddle chunks.
    const bytes = new TextEncoder().encode(frames);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const text = await read();
    globalThis.fetch = original;
    check("every token survives 7-byte chunking", text === full, JSON.stringify(text.slice(0, 60)));
  }

  console.log("\n4. Failure fallback (emergency path must never go blank)");
  for (const [label, impl] of [
    ["HTTP 401", async () => new Response("unauthorized", { status: 401 })],
    ["HTTP 429", async () => new Response("rate limited", { status: 429 })],
    ["HTTP 500", async () => new Response("boom", { status: 500 })],
    ["network throw", async () => { throw new Error("ECONNREFUSED"); }],
    ["empty stream", async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 })],
    ["malformed SSE", async () => new Response(
      new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode("data: {not json\n\n")); c.close(); },
      }), { status: 200 })],
  ] as [string, () => Promise<Response>][]) {
    const original = globalThis.fetch;
    globalThis.fetch = impl as typeof fetch;
    process.env.OPENROUTER_API_KEY = "k";
    const text = await read();
    globalThis.fetch = original;
    check(label, /119/.test(text) && /PROTOKOL FAST/.test(text), text.split("\n")[0].slice(0, 70) + "…");
  }

  console.log(failures === 0 ? "\nTriage layer OK.\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
