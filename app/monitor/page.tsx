import type { Metadata } from "next";
import { FastPanel } from "@/components/fast-panel";
import { MonitorClient } from "@/components/monitor-client";
import { CALIBRATION_SECONDS, CRISIS_WINDOW_SECONDS } from "@/lib/store";

export const metadata: Metadata = {
  title: "Pemantauan — SIPIJAR",
  description:
    "Pemantauan nirsentuh real-time: estimasi detak jantung via rPPG dan indeks asimetri wajah.",
};

export default function MonitorPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sesi pemantauan</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
          Kalibrasi berlangsung {CALIBRATION_SECONDS} detik pertama untuk merekam detak
          jantung istirahat dan asimetri wajah alami Anda. Setelah itu setiap{" "}
          {CRISIS_WINDOW_SECONDS} detik terakhir dievaluasi ulang secara terus-menerus.
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-border-subtle bg-surface-muted px-4 py-3 text-sm leading-relaxed">
        <strong>Video tidak pernah meninggalkan perangkat ini.</strong> Peramban
        mereduksi tiap bingkai menjadi sembilan nilai rata-rata warna sebelum
        dikirim. Tidak ada gambar, tidak ada rekaman, tidak ada berkas video di mana
        pun dalam sistem.
      </div>

      <MonitorClient />

      <section className="mt-10 rounded-xl border border-border-subtle bg-surface p-5">
        <h2 className="text-sm font-semibold tracking-tight">
          Panduan darurat — tersedia setiap saat
        </h2>
        <p className="mt-1 mb-4 text-xs text-muted">
          Panduan ini statis dan tidak bergantung pada jaringan, model AI, atau hasil
          pemantauan. Gunakan kapan pun Anda mencurigai stroke.
        </p>
        <div className="max-w-3xl">
          <FastPanel />
        </div>
      </section>
    </main>
  );
}
