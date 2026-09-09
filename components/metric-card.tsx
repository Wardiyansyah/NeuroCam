/** A single live metric with its value, unit, and supporting detail. */
export function MetricCard({
  label,
  value,
  unit,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  tone?: "neutral" | "normal" | "warning" | "critical";
}) {
  const toneClass = {
    neutral: "text-foreground",
    normal: "text-status-normal",
    warning: "text-status-warning",
    critical: "text-status-critical",
  }[tone];

  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className={`mt-1.5 flex items-baseline gap-1.5 ${toneClass}`}>
        <span className="tnum text-2xl font-semibold leading-none">{value}</span>
        {unit ? <span className="text-xs text-muted">{unit}</span> : null}
      </div>
      {detail ? (
        <div className="mt-1.5 text-xs leading-snug text-muted">{detail}</div>
      ) : null}
    </div>
  );
}

/** A 0-100 index rendered as a labelled bar. */
export function IndexBar({
  label,
  value,
  warnAt,
  criticalAt,
}: {
  label: string;
  value: number;
  warnAt: number;
  criticalAt: number;
}) {
  const tone =
    value >= criticalAt
      ? "bg-status-critical"
      : value >= warnAt
        ? "bg-status-warning"
        : "bg-status-normal";

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="tnum font-medium">{value.toFixed(1)}</span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${tone}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
    </div>
  );
}
