/**
 * LLM triage assistant - step 5 of the pipeline.
 *
 * Takes the anomaly metrics and produces two things: a handover summary a
 * clinician can read in seconds, and plain-language first-response steps for
 * whoever is in the room. Streamed, so text appears while it is still being
 * written rather than after a round trip.
 *
 * Provider is OpenRouter, per the draft. Raw HTTPS + SSE against the
 * chat-completions endpoint - no OpenAI SDK shim, because the wire format is
 * small enough that a dependency would only add surface area to audit.
 *
 * The deterministic FAST protocol in `lib/fast-protocol.ts` is rendered by the
 * UI immediately and independently. This module only ever *adds* context; if
 * the call fails, the emergency instructions are already on screen.
 */

import { fastProtocolText } from "@/lib/fast-protocol";
import type { AnalysisResult } from "@/lib/types";

/**
 * OpenRouter namespaces every model by vendor, so the slug for Claude Sonnet
 * 4.5 is `anthropic/claude-sonnet-4.5`. The `anthropic/` prefix is part of the
 * model name on OpenRouter - it does not mean the Anthropic API is called.
 */
const MODEL = process.env.TRIAGE_MODEL ?? "anthropic/claude-sonnet-4.5";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MAX_TOKENS = 2000;

/** Abort a stalled provider rather than leave the panel spinning. */
const REQUEST_TIMEOUT_MS = 20000;

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

const SUMMARY_SYSTEM_PROMPT = `Anda adalah asisten yang membuat kesimpulan pemantauan sinyal wajah dan hemodinamik.
Tulis dalam Bahasa Indonesia, maksimal 180 kata, dengan tepat dua bagian Markdown:

## Kesimpulan Pemantauan
Tiga sampai lima poin yang menyebutkan durasi pemantauan, kualitas sinyal, dan metrik rata-rata yang tersedia.

## Catatan Keterbatasan
Dua atau tiga poin singkat yang menegaskan bahwa ini bukan diagnosis dan bahwa penilaian klinis langsung tetap diperlukan.

Jangan mengarang angka atau menyatakan sistem dapat memastikan maupun menyingkirkan stroke.`;

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

METRIK RATA-RATA SELAMA SESI
- Jumlah evaluasi: ${result.averages.samples}
- Detak jantung rata-rata: ${result.averages.bpm ?? "tidak terukur"} bpm
- Asimetri rata-rata: ${result.averages.asymmetryOverall}/100
- Mulut/mata/alis rata-rata: ${result.averages.asymmetryMouth}/${result.averages.asymmetryEye}/${result.averages.asymmetryBrow}
- SNR rata-rata: ${result.averages.snrDb} dB

ATURAN AMBANG YANG TERPICU
${rules}`;
}

/** True when an OpenRouter key is configured. */
export function triageAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

type Emit = (text: string) => void;

/**
 * Stream from OpenRouter over SSE.
 *
 * Chunks do not align to line boundaries, so `data:` frames are reassembled
 * from a buffer rather than parsed per chunk - splitting naively drops tokens
 * whenever a frame straddles a TCP segment.
 */
async function streamFromOpenRouter(
  result: AnalysisResult,
  emit: Emit,
  mode: "incident" | "summary",
): Promise<void> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      // Optional attribution headers OpenRouter shows on its dashboard.
      ...(process.env.OPENROUTER_SITE_URL
        ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
        : {}),
      "X-Title": "SIPIJAR Stroke Screening",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [
        { role: "system", content: mode === "summary" ? SUMMARY_SYSTEM_PROMPT : SYSTEM_PROMPT },
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

/**
 * Stream triage guidance as plain text chunks.
 * Falls back to the deterministic protocol on any failure.
 */
export function streamTriage(
  result: AnalysisResult,
  mode: "incident" | "summary" = "incident",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit: Emit = (text) => controller.enqueue(encoder.encode(text));

      if (!triageAvailable()) {
        emit(
          "> Asisten triase AI tidak aktif (OPENROUTER_API_KEY belum diatur). " +
            "Panduan standar ditampilkan.\n\n" +
            fastProtocolText(),
        );
        controller.close();
        return;
      }

      try {
        await streamFromOpenRouter(result, emit, mode);
      } catch (error) {
        const reason =
          error instanceof DOMException && error.name === "TimeoutError"
            ? "waktu tunggu habis"
            : error instanceof Error
              ? error.message
              : "galat jaringan";
        emit(
          `> Asisten triase tidak tersedia (${reason}). Panduan standar ditampilkan.\n\n` +
            fastProtocolText(),
        );
      } finally {
        controller.close();
      }
    },
  });
}
