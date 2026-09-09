/**
 * Exercises the OpenRouter transport: provider selection, SSE reassembly
 * across chunk boundaries, and failure fallback.
 */
import { activeProvider, streamTriage, __testables } from "@/lib/triage";
import type { AnalysisResult } from "@/lib/types";

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

const RESULT: AnalysisResult = {
  sessionId: "test", at: new Date().toISOString(), status: "critical",
  hemodynamic: { bpm: 125, snrDb: 11.6, quality: "good", baselineBpm: 72, spikePct: 73.6 },
  asymmetry: { overall: 54.8, mouth: 54.8, eye: 54.8, brow: 54.7, quality: "good" },
  triggered: [{ code: "HR_SPIKE", label: "Fluktuasi detak jantung", detail: "125 bpm, +73.6%" }],
  windowSeconds: 5, calibrated: true, incidentId: "inc-1",
};

const read = async () => {
  const text = await new Response(streamTriage(RESULT)).text();
  return text;
};

console.log("\n1. Provider selection");
for (const [env, expected] of [
  [{}, "none"],
  [{ OPENROUTER_API_KEY: "k" }, "openrouter"],
  [{ ANTHROPIC_API_KEY: "k" }, "anthropic"],
  [{ OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "k" }, "openrouter"],
  [{ OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "k", TRIAGE_PROVIDER: "anthropic" }, "anthropic"],
  [{ ANTHROPIC_API_KEY: "k", TRIAGE_PROVIDER: "openrouter" }, "none"],
] as [Record<string,string>, string][]) {
  for (const k of ["OPENROUTER_API_KEY","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","TRIAGE_PROVIDER"]) delete process.env[k];
  Object.assign(process.env, env);
  const got = activeProvider();
  check(JSON.stringify(env) || "(no keys)", got === expected, `→ ${got}`);
}

console.log("\n2. SSE reassembly across chunk boundaries");
{
  const full = "Ringkasan klinis lengkap dengan angka 125 bpm.";
  const frames = full.split("").map((ch) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`,
  ).join("") + "data: [DONE]\n\n";

  // Slice the SSE bytes at deliberately awkward offsets so frames straddle chunks.
  const bytes = new TextEncoder().encode(frames);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  }), { status: 200 })) as typeof fetch;

  for (const k of ["ANTHROPIC_API_KEY","TRIAGE_PROVIDER"]) delete process.env[k];
  process.env.OPENROUTER_API_KEY = "k";
  const text = await read();
  globalThis.fetch = original;
  check("every token survives 7-byte chunking", text === full, `got ${JSON.stringify(text.slice(0, 60))}`);
}

console.log("\n3. Failure fallback (emergency path must never go blank)");
for (const [label, impl] of [
  ["HTTP 429", async () => new Response("rate limited", { status: 429 })],
  ["HTTP 500", async () => new Response("boom", { status: 500 })],
  ["network throw", async () => { throw new Error("ECONNREFUSED"); }],
  ["empty stream", async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 })],
] as [string, () => Promise<Response>][]) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  process.env.OPENROUTER_API_KEY = "k";
  const text = await read();
  globalThis.fetch = original;
  check(label, /119/.test(text) && /PROTOKOL FAST/.test(text), `${text.split("\n")[0].slice(0, 70)}…`);
}

console.log("\n4. Reasoning params gated by model capability");
for (const [model, expected] of [
  // Pre-4.6 models reject `output_config.effort` and adaptive thinking.
  ["claude-sonnet-4-5", false],
  ["claude-haiku-4-5", false],
  ["claude-3-5-sonnet-20241022", false],
  // Unknown/user-supplied values must take the conservative branch.
  ["some-unknown-model", false],
  ["", false],
  ["claude-opus-5", true],
  ["claude-sonnet-5", true],
  ["claude-sonnet-4-6", true],
  ["claude-opus-4-8", true],
  ["claude-fable-5-1", true],
] as [string, boolean][]) {
  const got = __testables.supportsAdaptiveEffort(model);
  check(
    model === "" ? "(empty string)" : model,
    got === expected,
    `adaptive+effort ${got ? "sent" : "omitted"}`,
  );
}

console.log(failures === 0 ? "\nTriage layer OK.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
