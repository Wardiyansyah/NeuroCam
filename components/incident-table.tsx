"use client";

import { Fragment, useEffect, useState } from "react";
import { STATUS_DISPLAY, formatBpm, formatPct, formatTime } from "@/lib/status-display";
import type { Incident } from "@/lib/types";

/**
 * Live incident feed.
 *
 * The draft specifies secure WebSockets (WSS) for pushing triage instructions to
 * the hospital dashboard. This polls instead - same data, no socket server to
 * operate. Swap in a WSS subscription here when one exists; nothing else in the
 * component needs to change.
 */
const POLL_INTERVAL_MS = 5000;

export function IncidentTable() {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/incidents", { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setError("Riwayat insiden tidak dapat dibaca dari database.");
          return;
        }
        const data = await response.json();
        if (!cancelled) {
          setError(null);
          setIncidents(data.incidents as Incident[]);
        }
      } catch {
        if (!cancelled) setError("Riwayat insiden tidak dapat dibaca dari database.");
      }
    };

    void load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error !== null) {
    return (
      <div className="rounded-xl border border-dashed border-border-subtle p-10 text-center">
        <p className="text-sm font-medium">{error}</p>
        <p className="mt-1.5 text-sm text-muted">Percobaan berikutnya akan berjalan otomatis.</p>
      </div>
    );
  }

  if (incidents === null) {
    return <p className="text-sm text-muted">Memuat riwayat insiden…</p>;
  }

  if (incidents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-subtle p-10 text-center">
        <p className="text-sm font-medium">Belum ada insiden tercatat</p>
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted">
          Insiden muncul di sini ketika sebuah sesi pemantauan melewati ambang batas
          peringatan atau kritis. Setiap baris hanya berisi angka metrik dan stempel
          waktu.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-4 py-3 font-medium">Waktu</th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 font-medium">Detak jantung</th>
            <th scope="col" className="px-4 py-3 font-medium">Deviasi</th>
            <th scope="col" className="px-4 py-3 font-medium">Asimetri</th>
            <th scope="col" className="px-4 py-3 font-medium">Sesi</th>
            <th scope="col" className="px-4 py-3 font-medium">
              <span className="sr-only">Rincian</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((incident) => {
            const display = STATUS_DISPLAY[incident.status];
            const isOpen = expanded === incident.id;

            return (
              <Fragment key={incident.id}>
                <tr className="border-b border-border-subtle last:border-0">
                  <td className="tnum px-4 py-3 whitespace-nowrap">
                    {formatTime(incident.at)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${display.bg} ${display.fg}`}
                    >
                      <span aria-hidden="true">{display.glyph}</span>
                      {display.label}
                    </span>
                  </td>
                  <td className="tnum px-4 py-3">
                    {formatBpm(incident.metrics.bpm)}
                    <span className="ml-1 text-xs text-muted">bpm</span>
                  </td>
                  <td className="tnum px-4 py-3">{formatPct(incident.metrics.hrSpikePct)}</td>
                  <td className="tnum px-4 py-3">
                    {incident.metrics.asymmetryOverall.toFixed(1)}
                    <span className="ml-1 text-xs text-muted">/100</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {incident.sessionId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : incident.id)}
                      aria-expanded={isOpen}
                      className="rounded px-2 py-1 text-xs font-medium text-accent hover:bg-surface-muted"
                    >
                      {isOpen ? "Tutup" : "Rincian"}
                    </button>
                  </td>
                </tr>

                {isOpen ? (
                  <tr className="border-b border-border-subtle bg-surface-muted last:border-0">
                    <td colSpan={7} className="px-4 py-4">
                      <div className="grid gap-5 md:grid-cols-2">
                        <div>
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                            Metrik tersimpan
                          </h3>
                          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                            {[
                              ["Asymmetry_AU12 (mulut)", incident.metrics.asymmetryMouth.toFixed(1)],
                              ["Asymmetry_AU6/7 (mata)", incident.metrics.asymmetryEye.toFixed(1)],
                              ["Asymmetry_AU4 (alis)", incident.metrics.asymmetryBrow.toFixed(1)],
                              ["Baseline HR", formatBpm(incident.metrics.baselineBpm)],
                              ["SNR pulsa", `${incident.metrics.snrDb} dB`],
                            ].map(([label, value]) => (
                              <div key={label} className="contents">
                                <dt className="text-muted">{label}</dt>
                                <dd className="tnum font-medium">{value}</dd>
                              </div>
                            ))}
                          </dl>

                          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
                            Aturan terpicu
                          </h3>
                          <ul className="mt-2 space-y-1.5 text-xs">
                            {incident.triggered.map((rule) => (
                              <li key={rule.code}>
                                <span className="font-medium">{rule.code}</span>
                                <span className="mt-0.5 block text-muted">{rule.detail}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div>
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                            Ringkasan triase
                          </h3>
                          {incident.triage ? (
                            <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground/90">
                              {incident.triage}
                            </pre>
                          ) : (
                            <p className="mt-2 text-xs text-muted">
                              Tidak ada ringkasan triase untuk insiden ini.
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
