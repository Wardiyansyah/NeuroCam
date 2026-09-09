import Link from "next/link";
import { CALIBRATION_SECONDS, CRISIS_WINDOW_SECONDS, PULSE_WINDOW_SECONDS } from "@/lib/store";
import { THRESHOLDS } from "@/lib/thresholds";

const PIPELINE = [
  {
    step: "1",
    title: "Inisiasi sesi",
    body: "Peramban meminta izin kamera dan membuka sesi pemantauan bernomor acak. Tidak ada akun, tidak ada identitas.",
  },
  {
    step: "2",
    title: "Reduksi bingkai di perangkat",
    body: "Tiap bingkai dipetakan ke sembilan region wajah dan direduksi menjadi rata-rata warna. Piksel dibuang seketika.",
  },
  {
    step: "3",
    title: "Ekstraksi metrik fisiologis",
    body: `Sinyal pulsa dipulihkan dengan metode CHROM pada jendela ${PULSE_WINDOW_SECONDS} detik, lalu spektrum daya menentukan detak jantung.`,
  },
  {
    step: "4",
    title: "Evaluasi ambang batas",
    body: `Agregasi ${CRISIS_WINDOW_SECONDS} detik terakhir. Bila fluktuasi detak jantung dan asimetri wajah terlampaui bersamaan, status menjadi Kritis.`,
  },
  {
    step: "5",
    title: "Asisten triase",
    body: "Metrik anomali dikirim ke Claude untuk menyusun ringkasan klinis dan langkah pertama. Panduan FAST statis selalu tampil lebih dulu.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      {/* --- Hero --------------------------------------------------------- */}
      <section className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">
          Pemantauan nirsentuh berbasis citra wajah
        </p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Skrining dini potensi stroke lewat kamera biasa
        </h1>
        <p className="mt-4 text-base leading-relaxed text-muted">
          SIPIJAR memantau dua indikator sekaligus: anomali hemodinamik melalui
          fotopletismografi jarak jauh (rPPG) dan asimetri wajah kritis melalui
          analisis pergerakan sisi kiri dan kanan. Ketika keduanya melewati ambang
          batas secara bersamaan, sistem memunculkan peringatan dan panduan
          penanganan pertama.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            href="/monitor"
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Mulai pemantauan
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg border border-border-subtle bg-surface px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface-muted"
          >
            Lihat dasbor insiden
          </Link>
        </div>
      </section>

      {/* --- Safety notice ------------------------------------------------ */}
      <section className="mt-10 rounded-xl border border-status-warning/40 bg-status-warning-bg p-5">
        <h2 className="text-sm font-semibold">Batasan yang perlu Anda ketahui</h2>
        <ul className="mt-2.5 space-y-1.5 text-sm leading-relaxed">
          <li>
            Sistem ini <strong>belum divalidasi secara klinis</strong> dan bukan alat
            diagnosis. Tidak ada penelitian yang menetapkan bahwa kombinasi rPPG dan
            asimetri fotometrik dapat mendeteksi stroke secara andal.
          </li>
          <li>
            Status <strong>Normal bukan jaminan</strong>. Stroke dapat terjadi tanpa
            perubahan yang tertangkap kamera. Jangan pernah menunda panggilan darurat
            karena sistem menampilkan Normal.
          </li>
          <li>
            Bila wajah tidak terlacak, sistem menampilkan{" "}
            <strong>Sinyal Hilang</strong>, bukan Normal — ketidaktahuan tidak pernah
            disamarkan sebagai kabar baik.
          </li>
        </ul>
      </section>

      {/* --- Pipeline ----------------------------------------------------- */}
      <section className="mt-14">
        <h2 className="text-lg font-semibold tracking-tight">Alur kerja sistem</h2>
        <ol className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PIPELINE.map((item) => (
            <li
              key={item.step}
              className="rounded-xl border border-border-subtle bg-surface p-5"
            >
              <span
                aria-hidden="true"
                className="grid h-7 w-7 place-items-center rounded-md bg-surface-muted text-xs font-bold text-accent"
              >
                {item.step}
              </span>
              <h3 className="mt-3 text-sm font-semibold">{item.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* --- Privacy ------------------------------------------------------ */}
      <section className="mt-14 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border-subtle bg-surface p-6">
          <h2 className="text-lg font-semibold tracking-tight">Privacy by design</h2>
          <dl className="mt-4 space-y-4 text-sm">
            <div>
              <dt className="font-medium">Reduksi di perangkat</dt>
              <dd className="mt-1 leading-relaxed text-muted">
                Draft awal mengirim video ke peladen lalu menghapusnya dari RAM dalam
                hitungan milidetik. Implementasi ini melangkah lebih jauh: video tidak
                pernah dikirim sama sekali. Yang menyeberang jaringan hanya sekitar 27
                angka per bingkai.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Anonimisasi peringatan</dt>
              <dd className="mt-1 leading-relaxed text-muted">
                Insiden yang tersimpan hanya berisi angka metrik dan stempel waktu —
                misalnya HR_Spike dan Asymmetry_AU12 — tanpa identitas maupun gambar.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Tidak ada berkas video</dt>
              <dd className="mt-1 leading-relaxed text-muted">
                Tidak ada MP4 atau format serupa yang ditulis ke penyimpanan, karena
                tidak ada bingkai yang pernah sampai ke peladen.
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-6">
          <h2 className="text-lg font-semibold tracking-tight">Ambang batas aktif</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Seluruh nilai berikut dapat diatur lewat variabel lingkungan. Angka bawaan
            adalah heuristik skrining yang dipilih agar mudah dibaca dan disetel, bukan
            hasil validasi klinis.
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            {[
              ["Jendela evaluasi", `${THRESHOLDS.windowSeconds} detik`],
              ["Lonjakan detak jantung", `±${THRESHOLDS.hrSpikePct}% dari baseline`],
              [
                "Rentang absolut detak jantung",
                `${THRESHOLDS.hrAbsoluteMin}–${THRESHOLDS.hrAbsoluteMax} bpm`,
              ],
              ["Asimetri — peringatan", `${THRESHOLDS.asymmetryWarn} / 100`],
              ["Asimetri — kritis", `${THRESHOLDS.asymmetryCritical} / 100`],
              ["Durasi kalibrasi", `${CALIBRATION_SECONDS} detik`],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-4 border-b border-border-subtle pb-2 last:border-0"
              >
                <dt className="text-muted">{label}</dt>
                <dd className="tnum font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </main>
  );
}
