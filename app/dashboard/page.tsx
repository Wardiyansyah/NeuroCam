import type { Metadata } from "next";
import { IncidentTable } from "@/components/incident-table";

export const metadata: Metadata = {
  title: "Dasbor Insiden — SIPIJAR",
  description:
    "Riwayat insiden teranonimisasi: angka metrik dan stempel waktu, tanpa rekaman video.",
};

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dasbor insiden</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
          Setiap baris adalah satu peringatan yang tercatat saat sebuah sesi melewati
          ambang batas. Isinya hanya angka metrik, stempel waktu, dan nomor sesi
          sementara — tidak ada gambar, rekaman, maupun identitas pasien.
        </p>
      </div>

      <IncidentTable />
    </main>
  );
}
