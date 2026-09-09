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

  // Require skin at the two highest-perfusion sites plus one cheek. Demanding
  // all nine would flag on a blink or a hand near the mouth.
  const skinVotes = [roi.forehead, roi.cheekL, roi.cheekR].filter(looksLikeSkin).length;

  return { roi, faceFound: skinVotes >= 2 };
}

/** Minimal shape of the Shape Detection API, which TS does not ship types for. */
interface DetectedFace {
  boundingBox: { x: number; y: number; width: number; height: number };
}
interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedFace[]>;
}

/**
 * Create a face tracker if the browser exposes the Shape Detection API,
 * otherwise null - callers then fall back to `GUIDE_BOX` and the on-screen
 * alignment oval.
 */
export function createFaceDetector(): FaceDetectorLike | null {
  const ctor = (
    globalThis as unknown as {
      FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;
    }
  ).FaceDetector;

  if (!ctor) return null;
  try {
    return new ctor({ fastMode: true, maxDetectedFaces: 1 });
  } catch {
    return null;
  }
}

/** Convert a detector result in pixels to a normalised face box, padded a little. */
export function toFaceBox(
  face: DetectedFace,
  frameWidth: number,
  frameHeight: number,
): FaceBox {
  const pad = 0.08;
  const w = (face.boundingBox.width / frameWidth) * (1 + pad * 2);
  const h = (face.boundingBox.height / frameHeight) * (1 + pad * 2);
  const x = face.boundingBox.x / frameWidth - (w * pad) / (1 + pad * 2);
  const y = face.boundingBox.y / frameHeight - (h * pad) / (1 + pad * 2);

  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    w: Math.max(0.05, Math.min(1, w)),
    h: Math.max(0.05, Math.min(1, h)),
  };
}

export function toRoiSample(sample: FrameSample, t: number): RoiSample {
  return { t, faceFound: sample.faceFound, roi: sample.roi };
}
