/**
 * Browser-side frame reduction - step 2 of the pipeline.
 *
 * This is where the privacy guarantee is actually enforced. Each video frame is
 * drawn to an offscreen canvas, reduced to nine mean-colour triples, and thrown
 * away. What crosses the network is ~27 numbers per frame. The pixels never
 * leave the device, so there is no raw video to leak, buffer, or forget to
 * delete - a stronger position than the draft's "delete it from server RAM
 * quickly", reached by never sending it.
 *
 * SIDE NAMING: `L`/`R` are *image* left and right, not anatomical sides. With
 * the usual mirrored self-view preview, image-left is the patient's right side.
 * The asymmetry index compares magnitudes and is side-agnostic, but anything
 * that reports *which* side drooped must resolve this against the mirror state.
 */

import { ROI_NAMES, type Rgb, type RoiName, type RoiSample } from "@/lib/types";
import type { FaceMesh as FaceMeshType, NormalizedLandmark, Results } from "@mediapipe/face_mesh";

/** Working canvas width. Small on purpose - rPPG wants averaged area, not detail. */
export const CAPTURE_WIDTH = 320;

export interface FaceBox {
  /** All values are fractions of the frame, 0-1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fallback box, matching the alignment oval drawn over the preview. */
export const GUIDE_BOX: FaceBox = { x: 0.3, y: 0.14, w: 0.4, h: 0.66 };

/** ROI rectangles as fractions of the face box. */
type Rect = { x0: number; x1: number; y0: number; y1: number };

export const ROI_LAYOUT: Record<RoiName, Rect> = {
  forehead: { x0: 0.3, x1: 0.7, y0: 0.08, y1: 0.2 },
  browL: { x0: 0.18, x1: 0.42, y0: 0.2, y1: 0.3 },
  browR: { x0: 0.58, x1: 0.82, y0: 0.2, y1: 0.3 },
  eyeL: { x0: 0.2, x1: 0.4, y0: 0.3, y1: 0.42 },
  eyeR: { x0: 0.6, x1: 0.8, y0: 0.3, y1: 0.42 },
  cheekL: { x0: 0.15, x1: 0.38, y0: 0.48, y1: 0.65 },
  cheekR: { x0: 0.62, x1: 0.85, y0: 0.48, y1: 0.65 },
  mouthL: { x0: 0.3, x1: 0.48, y0: 0.68, y1: 0.84 },
  mouthR: { x0: 0.52, x1: 0.7, y0: 0.68, y1: 0.84 },
};

/** Mean colour of one rectangle of an ImageData buffer. */
function meanRgb(
  data: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
): Rgb {
  const x0 = Math.max(0, Math.floor(rect.x0));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const x1 = Math.min(imgW, Math.ceil(rect.x1));
  const y1 = Math.min(imgH, Math.ceil(rect.y1));

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let y = y0; y < y1; y++) {
    let idx = (y * imgW + x0) * 4;
    for (let x = x0; x < x1; x++) {
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      idx += 4;
      n++;
    }
  }

  if (n === 0) return [0, 0, 0];
  return [r / n, g / n, b / n];
}

/**
 * Coarse presence check in YCbCr chrominance space.
 *
 * This is a *presence* gate, not a face detector: it answers "is there skin
 * roughly where a face should be" so the pipeline can report `signal_lost`
 * instead of confidently analysing an empty chair. Chrominance thresholds are
 * used rather than the classic RGB rule because separating luma from chroma
 * holds up considerably better across skin tones - though no fixed threshold is
 * neutral across all of them, which is one reason the production path in
 * `lib/inference.ts` delegates to a trained detector.
 */
export function looksLikeSkin(rgb: Rgb): boolean {
  const [r, g, b] = rgb;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;

  // Very dark or blown-out pixels carry no reliable chrominance.
  if (y < 20 || y > 250) return false;
  return cb >= 70 && cb <= 135 && cr >= 130 && cr <= 180;
}

export interface FrameSample {
  roi: Record<RoiName, Rgb>;
  faceFound: boolean;
}

/** Reduce one frame to per-ROI mean colour. */
export function sampleFrame(
  image: ImageData,
  box: FaceBox,
  faceFound: boolean,
): FrameSample {
  const { width, height, data } = image;
  const bx = box.x * width;
  const by = box.y * height;
  const bw = box.w * width;
  const bh = box.h * height;

  const roi = {} as Record<RoiName, Rgb>;
  for (const name of ROI_NAMES) {
    const layout = ROI_LAYOUT[name];
    roi[name] = meanRgb(data, width, height, {
      x0: bx + layout.x0 * bw,
      y0: by + layout.y0 * bh,
      x1: bx + layout.x1 * bw,
      y1: by + layout.y1 * bh,
    });
  }

  return { roi, faceFound };
}

export interface FaceMeshTracker {
  detect(source: HTMLCanvasElement): Promise<FaceBox | null>;
  close(): Promise<void>;
}

/**
 * Create the browser-local MediaPipe Face Mesh tracker. Model assets are
 * fetched by the browser, and only normalized landmarks remain in memory.
 */
export async function createFaceMesh(): Promise<FaceMeshTracker> {
  const module = (await import("@mediapipe/face_mesh")) as unknown as {
    FaceMesh: new (config: {
      locateFile: (file: string) => string;
    }) => FaceMeshType;
  };
  const mesh = new module.FaceMesh({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`,
  });
  mesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  let pending: { resolve: (box: FaceBox | null) => void; reject: (error: unknown) => void } | null =
    null;
  mesh.onResults((results: Results) => {
    const request = pending;
    pending = null;
    request?.resolve(results.multiFaceLandmarks[0] ? landmarksToFaceBox(results.multiFaceLandmarks[0]) : null);
  });

  return {
    detect(source: HTMLCanvasElement) {
      if (pending) return Promise.reject(new Error("Face Mesh masih memproses frame sebelumnya."));
      return new Promise<FaceBox | null>((resolve, reject) => {
        pending = { resolve, reject };
        void mesh.send({ image: source }).catch((error: unknown) => {
          if (pending) {
            pending = null;
            reject(error);
          }
        });
      });
    },
    close() {
      return mesh.close();
    },
  };
}

/** Convert normalized Face Mesh landmarks to a padded sampling box. */
function landmarksToFaceBox(landmarks: NormalizedLandmark[]): FaceBox {
  const pad = 0.08;
  const xs = landmarks.map((landmark) => landmark.x);
  const ys = landmarks.map((landmark) => landmark.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;

  return {
    x: Math.max(0, minX - width * pad),
    y: Math.max(0, minY - height * pad),
    w: Math.min(1, width * (1 + pad * 2)),
    h: Math.min(1, height * (1 + pad * 2)),
  };
}

export function toRoiSample(sample: FrameSample, t: number): RoiSample {
  return { t, faceFound: sample.faceFound, roi: sample.roi };
}
