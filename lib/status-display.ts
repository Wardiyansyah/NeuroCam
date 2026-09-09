/**
 * Presentation metadata for each monitor status.
 *
 * Status is never signalled by colour alone - each entry carries a label and a
 * glyph too, so the state survives greyscale, colour-blindness, and a phone
 * screen in daylight.
 */

import type { MonitorStatus } from "@/lib/types";

export interface StatusPresentation {
  label: string;
  glyph: string;
  description: string;
  /** Tailwind classes for the text/border colour. */
  fg: string;
  /** Tailwind classes for the surface behind it. */
  bg: string;
}

export const STATUS_DISPLAY: Record<MonitorStatus, StatusPresentation> = {
  idle: {
    label: "Siaga",
    glyph: "○",
    description: "Pemantauan belum dimulai.",
    fg: "text-status-idle",
    bg: "bg-status-idle-bg",
  },
  calibrating: {
    label: "Kalibrasi",
    glyph: "◐",
    description:
      "Mengukur detak jantung istirahat dan asimetri wajah alami Anda sebagai pembanding.",
    fg: "text-status-calibrating",
    bg: "bg-status-calibrating-bg",
  },
  normal: {
    label: "Normal",
    glyph: "✓",
    description: "Tidak ada anomali terdeteksi pada jendela pengamatan terakhir.",
    fg: "text-status-normal",
    bg: "bg-status-normal-bg",
  },
  warning: {
    label: "Peringatan",
    glyph: "!",
    description:
      "Satu kanal melewati ambang batas. Perhatikan pasien dan ulangi pemeriksaan FAST secara manual.",
    fg: "text-status-warning",
    bg: "bg-status-warning-bg",
  },
  critical: {
    label: "Kritis",
    glyph: "!!",
    description: "Ambang batas krisis terlampaui. Hubungi layanan gawat darurat sekarang.",
    fg: "text-status-critical",
    bg: "bg-status-critical-bg",
  },
  signal_lost: {
    label: "Sinyal Hilang",
    glyph: "⊘",
    description:
      "Wajah tidak terdeteksi stabil. Status ini BUKAN berarti normal - tidak ada penilaian yang dapat dibuat.",
    fg: "text-status-idle",
    bg: "bg-status-idle-bg",
  },
};

export function formatBpm(bpm: number | null): string {
  return bpm === null ? "--" : String(bpm);
}

export function formatPct(pct: number | null): string {
  if (pct === null) return "--";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
