import {
  EMERGENCY_NUMBER,
  EMERGENCY_NUMBER_ALT,
  FAST_STEPS,
  IMMEDIATE_ACTIONS,
} from "@/lib/fast-protocol";

/**
 * Static emergency guidance. Rendered on the server and present in the markup
 * before any JavaScript runs, so it is on screen even if the triage API, the
 * network, or the client bundle fails.
 */
export function FastPanel({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-4">
      <a
        href={`tel:${EMERGENCY_NUMBER}`}
        className="flex items-center justify-center gap-2 rounded-lg bg-status-critical px-4 py-3 text-base font-semibold text-white transition-opacity hover:opacity-90"
      >
        Hubungi {EMERGENCY_NUMBER} sekarang
      </a>

      <p className="text-xs text-muted">
        Alternatif: {EMERGENCY_NUMBER_ALT} (panggilan darurat umum). Jangan menyetir
        sendiri ke rumah sakit.
      </p>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Protokol FAST
        </h3>
        <dl className="mt-2 space-y-2">
          {FAST_STEPS.map((step) => (
            <div key={step.letter} className="flex gap-3">
              <dt
                aria-hidden="true"
                className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded bg-surface-muted text-xs font-bold"
              >
                {step.letter}
              </dt>
              <dd className="text-sm leading-snug">
                <span className="font-medium">{step.title}.</span>{" "}
                <span className="text-muted">{step.body}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {compact ? null : (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Tindakan segera
          </h3>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-snug text-muted">
            {IMMEDIATE_ACTIONS.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
