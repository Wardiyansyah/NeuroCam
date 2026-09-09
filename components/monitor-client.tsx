"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IndexBar, MetricCard } from "@/components/metric-card";
import {
  CAPTURE_WIDTH,
  GUIDE_BOX,
  ROI_LAYOUT,
  createFaceDetector,
  sampleFrame,
  toFaceBox,
  toRoiSample,
  type FaceBox,
} from "@/lib/capture";
import { STATUS_DISPLAY, formatBpm, formatPct } from "@/lib/status-display";
import { ROI_NAMES, type AnalysisResult, type MonitorStatus, type RoiSample } from "@/lib/types";

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
/** How often reduced frames are shipped to the server. */
const FLUSH_INTERVAL_MS = 1000;
/** Face detection is the expensive call - run it a few times a second, not every frame. */
const DETECT_EVERY_N_FRAMES = 10;

/** Threshold mirrors, used only to colour the bars. */
const ASYM_WARN = 25;
const ASYM_CRITICAL = 40;

type Phase = "idle" | "starting" | "running" | "error";
type Detector = NonNullable<ReturnType<typeof createFaceDetector>>;

export function MonitorClient() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const sessionIdRef = useRef<string | null>(null);
  const bufferRef = useRef<RoiSample[]>([]);
  const startTimeRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const detectorRef = useRef<Detector | null>(null);
  /** Guards against overlapping detect() calls when detection runs slow. */
  const detectingRef = useRef(false);
  const faceBoxRef = useRef<FaceBox>(GUIDE_BOX);
  const streamRef = useRef<MediaStream | null>(null);
  const flushingRef = useRef(false);
  const triagedIncidentRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [faceBox, setFaceBox] = useState<FaceBox>(GUIDE_BOX);
  const [detectorActive, setDetectorActive] = useState(false);
  const [triage, setTriage] = useState<string>("");
  const [triageLoading, setTriageLoading] = useState(false);

  const status: MonitorStatus =
    phase === "running" ? (result?.status ?? "calibrating") : "idle";
  const display = STATUS_DISPLAY[status];

  /** Ship the buffered samples and take the verdict back. */
  const flush = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || flushingRef.current) return;
    if (bufferRef.current.length === 0) return;

    const batch = bufferRef.current;
    bufferRef.current = [];
    flushingRef.current = true;

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, samples: batch }),
      });

      if (response.status === 404) {
        // Session expired server-side while the loop kept running - re-open one.
        const created = await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fps: TARGET_FPS }),
        });
        if (created.ok) {
          const data = await created.json();
          sessionIdRef.current = data.sessionId;
          startTimeRef.current = performance.now();
        }
        return;
      }

      if (!response.ok) return;
      setResult((await response.json()) as AnalysisResult);
    } catch {
      // A dropped batch is recoverable - the next one carries fresh signal.
    } finally {
      flushingRef.current = false;
    }
  }, []);

  /** Per-frame capture: draw, reduce to ROI means, discard the pixels. */
  const captureFrame = useCallback(async (now: number) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const aspect = video.videoHeight / video.videoWidth || 0.75;
    canvas.width = CAPTURE_WIDTH;
    canvas.height = Math.round(CAPTURE_WIDTH * aspect);

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Read pixels before yielding. Awaiting face detection first would let a
    // later frame redraw the canvas underneath us, pairing this sample's
    // timestamp with a different frame's pixels.
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sample = sampleFrame(image, faceBoxRef.current);
    bufferRef.current.push(toRoiSample(sample, now - startTimeRef.current));

    // Detection is refreshed out of band and applies to subsequent frames.
    frameCountRef.current += 1;
    const shouldDetect =
      detectorRef.current &&
      !detectingRef.current &&
      frameCountRef.current % DETECT_EVERY_N_FRAMES === 0;

    if (shouldDetect) {
      detectingRef.current = true;
      try {
        const faces = await detectorRef.current!.detect(canvas);
        if (faces.length > 0) {
          const box = toFaceBox(faces[0], canvas.width, canvas.height);
          faceBoxRef.current = box;
          setFaceBox(box);
        }
      } catch {
        // Detection is best-effort; the guide box stays valid.
      } finally {
        detectingRef.current = false;
      }
    }
  }, []);

  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame(loop);
    const now = performance.now();
    if (now - lastFrameRef.current < FRAME_INTERVAL_MS) return;
    lastFrameRef.current = now;
    void captureFrame(now);
  }, [captureFrame]);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void fetch(`/api/session?id=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      sessionIdRef.current = null;
    }

    bufferRef.current = [];
    setPhase("idle");
    setResult(null);
    setTriage("");
    triagedIncidentRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: TARGET_FPS },
          facingMode: "user",
        },
        audio: false,
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }

      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fps: TARGET_FPS }),
      });
      if (!response.ok) throw new Error("Gagal membuat sesi pemantauan.");

      const data = await response.json();
      sessionIdRef.current = data.sessionId;

      const detector = createFaceDetector();
      detectorRef.current = detector;
      setDetectorActive(Boolean(detector));

      startTimeRef.current = performance.now();
      lastFrameRef.current = 0;
      frameCountRef.current = 0;
      bufferRef.current = [];
      faceBoxRef.current = GUIDE_BOX;
      setFaceBox(GUIDE_BOX);

      setPhase("running");
      rafRef.current = requestAnimationFrame(loop);
    } catch (caught) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setPhase("error");
      setError(
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "Izin kamera ditolak. Berikan akses kamera untuk memulai pemantauan."
          : caught instanceof Error
            ? caught.message
            : "Tidak dapat mengakses kamera.",
      );
    }
  }, [loop]);

  // Periodic flush while running.
  useEffect(() => {
    if (phase !== "running") return;
    const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase, flush]);

  // Release the camera if the component unmounts mid-session.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Stream the triage narrative once per critical incident.
  const incidentId = result?.incidentId;
  const resultStatus = result?.status;
  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (!incidentId || !sessionId) return;
    if (resultStatus !== "critical") return;
    if (triagedIncidentRef.current === incidentId) return;

    triagedIncidentRef.current = incidentId;
    setTriage("");
    setTriageLoading(true);

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/triage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          setTriage((prev) => prev + decoder.decode(value, { stream: true }));
        }
      } catch {
        // The deterministic FAST panel is already on screen.
      } finally {
        setTriageLoading(false);
      }
    })();

    return () => controller.abort();
  }, [incidentId, resultStatus]);

  const hemo = result?.hemodynamic;
  const asym = result?.asymmetry;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        {/* --- Video with ROI overlay ------------------------------------- */}
        <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            className="block aspect-video w-full scale-x-[-1] object-cover"
          />
          <canvas ref={canvasRef} className="hidden" />

          {phase === "running" ? (
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full scale-x-[-1]"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <ellipse
                cx={(faceBox.x + faceBox.w / 2) * 100}
                cy={(faceBox.y + faceBox.h / 2) * 100}
                rx={(faceBox.w / 2) * 100}
                ry={(faceBox.h / 2) * 100}
                fill="none"
                stroke="rgba(255,255,255,0.45)"
                strokeWidth="0.3"
                strokeDasharray="2 1.5"
                vectorEffect="non-scaling-stroke"
              />
              {ROI_NAMES.map((name) => {
                const r = ROI_LAYOUT[name];
                return (
                  <rect
                    key={name}
                    x={(faceBox.x + r.x0 * faceBox.w) * 100}
                    y={(faceBox.y + r.y0 * faceBox.h) * 100}
                    width={(r.x1 - r.x0) * faceBox.w * 100}
                    height={(r.y1 - r.y0) * faceBox.h * 100}
                    fill="rgba(91,155,255,0.12)"
                    stroke="rgba(91,155,255,0.7)"
                    strokeWidth="0.2"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </svg>
          ) : null}

          {phase !== "running" ? (
            <div className="absolute inset-0 grid place-items-center bg-black/70 px-6 text-center">
              <div className="max-w-sm space-y-3">
                <p className="text-sm text-white/80">
                  {phase === "starting"
                    ? "Meminta akses kamera…"
                    : "Posisikan wajah di dalam bingkai dengan pencahayaan merata dari depan, lalu mulai pemantauan."}
                </p>
                {error ? (
                  <p className="rounded-md bg-status-critical/20 px-3 py-2 text-sm text-white">
                    {error}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {/* --- Controls ---------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-3">
          {phase === "running" ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-lg border border-border-subtle bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-muted"
            >
              Hentikan pemantauan
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={phase === "starting"}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {phase === "starting" ? "Menghubungkan…" : "Mulai pemantauan"}
            </button>
          )}

          <span className="text-xs text-muted">
            {detectorActive
              ? "Pelacakan wajah otomatis aktif."
              : "Pelacakan otomatis tidak tersedia di peramban ini — gunakan panduan oval."}
          </span>
        </div>

        {/* --- Metrics ----------------------------------------------------- */}
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard
            label="Detak jantung"
            value={formatBpm(hemo?.bpm ?? null)}
            unit="bpm"
            detail={
              hemo?.baselineBpm
                ? `Baseline ${hemo.baselineBpm} bpm · ${formatPct(hemo.spikePct)}`
                : "Baseline belum terbentuk"
            }
            tone={
              status === "critical"
                ? "critical"
                : status === "warning"
                  ? "warning"
                  : "neutral"
            }
          />
          <MetricCard
            label="Indeks asimetri"
            value={asym ? asym.overall.toFixed(1) : "--"}
            unit="/ 100"
            detail="Kelebihan di atas baseline pribadi"
            tone={
              asym && asym.overall >= ASYM_CRITICAL
                ? "critical"
                : asym && asym.overall >= ASYM_WARN
                  ? "warning"
                  : "neutral"
            }
          />
          <MetricCard
            label="Kualitas sinyal"
            value={hemo ? hemo.quality : "--"}
            detail={hemo ? `SNR pulsa ${hemo.snrDb} dB` : "Menunggu data"}
            tone={hemo?.quality === "poor" ? "warning" : "neutral"}
          />
        </div>

        <div className="rounded-lg border border-border-subtle bg-surface p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Rincian asimetri (proksi Action Unit)
          </h2>
          <div className="mt-3 space-y-3">
            <IndexBar
              label="Mulut — proksi AU12"
              value={asym?.mouth ?? 0}
              warnAt={ASYM_WARN}
              criticalAt={ASYM_CRITICAL}
            />
            <IndexBar
              label="Mata — proksi AU6/AU7"
              value={asym?.eye ?? 0}
              warnAt={ASYM_WARN}
              criticalAt={ASYM_CRITICAL}
            />
            <IndexBar
              label="Alis — proksi AU4"
              value={asym?.brow ?? 0}
              warnAt={ASYM_WARN}
              criticalAt={ASYM_CRITICAL}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Nilai ini adalah proksi fotometrik dari pergerakan sisi kiri dan kanan
            wajah, bukan pengkodean FACS. Angka tinggi menandakan satu sisi bergerak
            jauh lebih sedikit dibanding sisi lainnya.
          </p>
        </div>
      </div>

      {/* --- Status column ------------------------------------------------- */}
      <aside className="space-y-4">
        <div
          className={`rounded-xl border border-border-subtle p-5 ${display.bg} ${
            status === "critical" ? "alert-pulse" : ""
          }`}
          role="status"
          aria-live="polite"
        >
          <div className={`flex items-center gap-2 ${display.fg}`}>
            <span aria-hidden="true" className="text-lg font-bold">
              {display.glyph}
            </span>
            <span className="text-lg font-semibold tracking-tight">{display.label}</span>
          </div>
          <p className="mt-2 text-sm leading-snug text-foreground/80">
            {display.description}
          </p>

          {result ? (
            <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border-subtle pt-3 text-xs">
              <div>
                <dt className="text-muted">Jendela</dt>
                <dd className="tnum font-medium">{result.windowSeconds}s</dd>
              </div>
              <div>
                <dt className="text-muted">Kalibrasi</dt>
                <dd className="font-medium">{result.calibrated ? "Selesai" : "Berjalan"}</dd>
              </div>
            </dl>
          ) : null}
        </div>

        {result && result.triggered.length > 0 ? (
          <div className="rounded-xl border border-border-subtle bg-surface p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Aturan yang terpicu
            </h2>
            <ul className="mt-2 space-y-2">
              {result.triggered.map((rule) => (
                <li key={rule.code} className="text-sm leading-snug">
                  <span className="font-medium">{rule.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{rule.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {status === "critical" || triage ? (
          <div className="rounded-xl border border-status-critical/40 bg-surface p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-status-critical">
              Asisten triase
            </h2>
            {triageLoading && !triage ? (
              <p className="mt-2 text-sm text-muted">Menyusun panduan…</p>
            ) : null}
            {triage ? (
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-snug text-foreground/90">
                {triage}
              </pre>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
