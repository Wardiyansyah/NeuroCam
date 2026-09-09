/**
 * LLM triage assistant - step 5 of the pipeline.
 *
 * Takes the anomaly metrics and produces two things: a handover summary a
 * clinician can read in seconds, and plain-language first-response steps for
 * whoever is in the room. Streamed, so text appears while it is still being
 * written rather than after a round trip.
 *
 * Two providers, selected by `TRIAGE_PROVIDER` (or inferred from whichever key
 * is present):
 *
 *  - `openrouter` - the draft's choice. Raw HTTPS + SSE against OpenRouter's
 *    chat-completions endpoint. No OpenAI SDK shim; the wire format is simple
 *    enough that a dependency would only add surface area.
 *  - `anthropic`  - the official `@anthropic-ai/sdk`, which gives typed access
 *    to adaptive thinking and effort control that OpenRouter does not expose
 *    uniformly.
 *
 * The prompt, the model, and the output contract are identical either way -
 * only the transport differs - so switching providers cannot change what the
 * clinician reads.
 *
 * The deterministic FAST protocol in `lib/fast-protocol.ts` is rendered by the
 * UI immediately and independently. This module only ever *adds* context; if
 * every provider fails, the emergency instructions are already on screen.
 */

import Anthropic from "@anthropic-ai/sdk";
import { fastProtocolText } from "@/lib/fast-protocol";
import type { AnalysisResult } from "@/lib/types";

/** Same model on both providers; OpenRouter namespaces it under the vendor. */
const ANTHROPIC_MODEL = process.env.TRIAGE_MODEL ?? "claude-sonnet-4-5";
const OPENROUTER_MODEL = process.env.TRIAGE_MODEL ?? "anthropic/claude-sonnet-4.5";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Low effort on purpose. This runs on an emergency path where latency is the
 * dominant cost, the output is a short structured note rather than a reasoning
 * problem, and the safety-critical instructions are already covered by the
 * deterministic protocol. Raise it if you widen the assistant's remit.
 *
 * Anthropic-only: OpenRouter's reasoning controls are not uniform across
 * providers, so the OpenRouter path sends no effort hint rather than an
 * unverified parameter that could 400 mid-emergency.
 */
const EFFORT = "low" as const;

/**
 * Adaptive thinking and `output_config.effort` only exist on the Claude 4.6
 * generation and later. Sending either to Sonnet 4.5 or Haiku 4.5 returns a
 * 400 - which on this path means the triage panel silently degrades to static
 * text in the middle of an emergency.
 *
 * The match is therefore an allowlist, not a denylist: an unrecognised or
 * user-supplied `TRIAGE_MODEL` gets neither parameter. Omitting them is valid
 * on every Claude model, so the conservative branch is always safe.
 */
const SUPPORTS_ADAPTIVE_EFFORT =
  /^claude-(opus-(5|4-6|4-7|4-8)|sonnet-(5|4-6)|fable-5(-1)?|mythos-5(-1)?)\b/;

function supportsAdaptiveEffort(model: string): boolean {
  return SUPPORTS_ADAPTIVE_EFFORT.test(model);
}

/** Exposed for `scripts/verify-triage.mts`; not part of the runtime surface. */
export const __testables = { supportsAdaptiveEffort };

const MAX_TOKENS = 2000;

/** Abort a stalled provider rather than leave the panel spinning. */
const REQUEST_TIMEOUT_MS = 20000;

export type TriageProvider = "anthropic" | "openrouter" | "none";

const SYSTEM_PROMPT = `Anda adalah asisten triase untuk sistem skrining dini stroke berbasis kamera.

Sistem mengirimkan metrik anomali dari dua kanal: estimasi detak jantung (rPPG kontaktless) dan indeks asimetri wajah (proksi fotometrik untuk facial droop). Metrik ini adalah SINYAL SKRINING, bukan diagnosis, dan berasal dari sensor kamera yang dapat keliru.

Tugas Anda menghasilkan keluaran ringkas dalam Bahasa Indonesia dengan tepat dua bagian, dalam format Markdown:

## Ringkasan Klinis
Tiga sampai lima poin untuk tenaga medis. Sebutkan angka metrik yang memicu peringatan, aturan ambang mana yang terlampaui, dan keterbatasan pengukuran yang relevan (kualitas sinyal, durasi jendela pengamatan). Sebutkan diagnosis banding singkat yang layak dipertimbangkan. Jangan menyatakan diagnosis pasti.

## Langkah Pertama untuk Pendamping
Empat sampai enam instruksi berurutan, kalimat pendek, bahasa awam. Instruksi pertama SELALU menghubungi layanan gawat darurat 119 atau 112. Sertakan pencatatan waktu awal gejala.

Aturan yang mengikat:
- Jangan pernah menyarankan menunggu, mengamati dulu, atau menunda panggilan darurat.
- Jangan pernah menyebut sistem ini dapat memastikan atau menyingkirkan stroke.
- Jangan mengarang metrik yang tidak diberikan.
- Jika kualitas sinyal rendah, katakan eksplisit bahwa pengukuran tidak dapat diandalkan dan penilaian klinis langsung tetap menentukan.
- Maksimal 250 kata total.`;

function buildUserMessage(result: AnalysisResult): string {
  const h = result.hemodynamic;
  const a = result.asymmetry;

  const rules =
    result.triggered.length > 0
      ? result.triggered.map((t) => `- [${t.code}] ${t.label}: ${t.detail}`).join("\n")
      : "- (tidak ada aturan yang tercatat)";

  return `Status sistem: ${result.status.toUpperCase()}
Waktu deteksi: ${result.at}
Durasi jendela evaluasi: ${result.windowSeconds} detik
Kalibrasi baseline selesai: ${result.calibrated ? "ya" : "belum"}

METRIK HEMODINAMIK (rPPG)
- Detak jantung: ${h.bpm ?? "tidak terukur"} bpm
- Baseline pribadi: ${h.baselineBpm ?? "belum ada"} bpm
- Deviasi dari baseline: ${h.spikePct ?? "n/a"}%
- SNR sinyal pulsa: ${h.snrDb} dB
- Kualitas sinyal: ${h.quality}

METRIK ASIMETRI WAJAH (proksi fotometrik, kelebihan di atas baseline pribadi, skala 0-100)
- Indeks keseluruhan: ${a.overall}
- Mulut (proksi AU12): ${a.mouth}
- Mata (proksi AU6/AU7): ${a.eye}
- Alis (proksi AU4): ${a.brow}
- Kualitas sinyal: ${a.quality}

ATURAN AMBANG YANG TERPICU
${rules}`;
}

/**
 * Which provider will actually be used.
 * An explicit `TRIAGE_PROVIDER` wins; otherwise whichever key is present, with
 * OpenRouter first because naming it is a deliberate choice.
 */
export function activeProvider(): TriageProvider {
  const explicit = process.env.TRIAGE_PROVIDER?.toLowerCase();

  if (explicit === "openrouter") {
    return process.env.OPENROUTER_API_KEY ? "openrouter" : "none";
  }
  if (explicit === "anthropic") {
    return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
      ? "anthropic"
      : "none";
  }

  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  return "none";
}

/** True when some provider is configured; the route uses this to skip the call. */
export function triageAvailable(): boolean {
  return activeProvider() !== "none";
}

type Emit = (text: string) => void;

/** Shared failure path: say what broke, then give the full standard protocol. */
function emitFallback(emit: Emit, reason: string): void {
  emit(
    `> Asisten triase tidak tersedia (${reason}). Panduan standar ditampilkan.\n\n` +
      fastProtocolText(),
  );
}

// --- OpenRouter -------------------------------------------------------------

/**
 * Stream from OpenRouter over SSE.
 *
 * Chunks do not align to line boundaries, so `data:` frames are reassembled
 * from a buffer rather than parsed per chunk - splitting naively drops tokens
 * whenever a frame straddles a TCP segment.
 */
async function streamViaOpenRouter(result: AnalysisResult, emit: Emit): Promise<void> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      // Optional attribution headers OpenRouter uses for its dashboard.
      ...(process.env.OPENROUTER_SITE_URL
        ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
        : {}),
      "X-Title": "SIPIJAR Stroke Screening",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(result) },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let emitted = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Keep the trailing partial line in the buffer for the next chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          emit(delta);
          emitted = true;
        }
      } catch {
        // OpenRouter interleaves keep-alive comments; skip anything unparseable.
      }
    }
  }

  if (!emitted) throw new Error("OpenRouter mengembalikan aliran kosong");
}

// --- Anthropic --------------------------------------------------------------

async function streamViaAnthropic(result: AnalysisResult, emit: Emit): Promise<void> {
  const client = new Anthropic();

  // Only attach reasoning controls the target model actually accepts.
  const reasoning = supportsAdaptiveEffort(ANTHROPIC_MODEL)
    ? { thinking: { type: "adaptive" as const }, output_config: { effort: EFFORT } }
    : {};

  const stream = client.messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    ...reasoning,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Stable across every alert - worth caching.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildUserMessage(result) }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      emit(event.delta.text);
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    emit(
      "\n\n> Asisten triase tidak dapat menjawab permintaan ini. " +
        "Panduan standar ditampilkan.\n\n" +
        fastProtocolText(),
    );
  }
}

// --- Entry point ------------------------------------------------------------

/**
 * Stream triage guidance as plain text chunks.
 * Falls back to the deterministic protocol on any provider failure.
 */
export function streamTriage(result: AnalysisResult): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const provider = activeProvider();

  return new ReadableStream({
    async start(controller) {
      const emit: Emit = (text) => controller.enqueue(encoder.encode(text));

      if (provider === "none") {
        emit(
          "> Asisten triase AI tidak aktif (kredensial belum diatur). " +
            "Panduan standar ditampilkan.\n\n" +
            fastProtocolText(),
        );
        controller.close();
        return;
      }

      try {
        if (provider === "openrouter") {
          await streamViaOpenRouter(result, emit);
        } else {
          await streamViaAnthropic(result, emit);
        }
      } catch (error) {
        let reason: string;
        if (error instanceof Anthropic.APIError) {
          reason = `galat API ${error.status}`;
        } else if (error instanceof DOMException && error.name === "TimeoutError") {
          reason = "waktu tunggu habis";
        } else if (error instanceof Error) {
          reason = error.message;
        } else {
          reason = "galat jaringan";
        }
        emitFallback(emit, reason);
      } finally {
        controller.close();
      }
    },
  });
}
