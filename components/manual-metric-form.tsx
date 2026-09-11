"use client";

import { FormEvent, useState } from "react";

type SignalQuality = "good" | "fair";

const fields = [
  ["heartRate", "Detak jantung (bpm)", "75"],
  ["asymmetryIndex", "Asimetri keseluruhan (0-100)", "10"],
  ["au12", "AU12 mulut (0-100)", "10"],
  ["au6_7", "AU6/7 mata (0-100)", "10"],
  ["au4", "AU4 alis (0-100)", "10"],
] as const;

export function ManualMetricForm() {
  const [quality, setQuality] = useState<SignalQuality>("good");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());

    try {
      const response = await fetch("/api/simulate/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string; conclusion?: string; status?: string };
      if (!response.ok) throw new Error(data.error ?? "Metrik gagal disimpan.");
      event.currentTarget.reset();
      setQuality("good");
      setMessage(
        `${data.status === "critical" ? "Insiden kritis tersimpan. " : ""}Kesimpulan AI:\n${
          data.conclusion ?? "Tidak ada kesimpulan yang dikembalikan."
        }`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metrik gagal disimpan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-amber-300/40 bg-amber-50/40 p-5">
      <h2 className="text-sm font-semibold tracking-tight">Simulasi metrik manual</h2>
      <p className="mt-1 text-xs text-muted">
        Hanya untuk pengujian. Data disimpan tanpa menggunakan kamera.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([name, label, placeholder]) => (
          <label key={name} className="text-xs font-medium">
            {label}
            <input
              name={name}
              type="number"
              step="any"
              min="0"
              required
              defaultValue={placeholder}
              className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm font-normal"
            />
          </label>
        ))}
        <label className="text-xs font-medium">
          Kualitas sinyal
          <select
            name="quality"
            value={quality}
            onChange={(event) => setQuality(event.target.value as SignalQuality)}
            className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm font-normal"
          >
            <option value="good">Good (setara 10 detik)</option>
            <option value="fair">Fair (setara 20 detik)</option>
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Menyimpan…" : "Simpan metrik"}
          </button>
        </div>
      </form>
      {message ? (
        <pre className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-muted" role="status">
          {message}
        </pre>
      ) : null}
    </section>
  );
}
