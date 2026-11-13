// Drawing of «Pincel rotoscopia y Perf. borde»: the propagated matte of the frame (core/motion/roto.ts) cuts the
// layer; with «Ajustar Mate pincel rotoscopia» its Feather / Contrast / Shift Edge / Reduce Chatter, and with
// «Procesar perfec. de borde» the Refine Edge region (painted with the Refine Edge tool, plus the Base Refine Edge
// Radius round the whole edge) becomes a soft matte that follows the image, with edge colours decontaminated. Both
// matte stages are the Refine Soft Matte maths of fx-groups/canal3d.ts.
import type { FxInstance } from '../core/motion/model';
import { rleDecode, rotoFrame, type RotoSeg } from '../core/motion/roto';
import { blurF, morph } from '../core/segment';
import { ctx2d, mk, type FxCtx, type Params } from './fx';
import { refine } from './fx-groups/canal3d';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** propagation in progress per effect id (set by the window while the main process propagates) */
export const rotoBusy = new Map<string, { done: number; total: number }>();

const decoded = new Map<string, Uint8Array>();
function decode(s: string, size: number): Uint8Array {
  let m = decoded.get(s);
  if (!m) { m = rleDecode(s, size); decoded.set(s, m); if (decoded.size > 48) decoded.delete(decoded.keys().next().value!); }
  return m;
}
/** A matte (working resolution, 0/1) resampled onto the effect's canvas (layer space), smooth edges. */
export function sampleMatte(seg: RotoSeg, s: string | null, W: number, H: number, x: FxCtx): Float32Array {
  const out = new Float32Array(W * H);
  if (!s) return out;
  const m = decode(s, seg.w * seg.h), kx = seg.w / seg.W, ky = seg.h / seg.H;
  for (let py = 0; py < H; py++) {
    const my = (x.oy + (py + 0.5) / x.res) * ky - 0.5;
    const y0 = Math.floor(my), fy = my - y0, ya = Math.max(0, Math.min(seg.h - 1, y0)), yb = Math.max(0, Math.min(seg.h - 1, y0 + 1));
    for (let px = 0; px < W; px++) {
      const mx = (x.ox + (px + 0.5) / x.res) * kx - 0.5;
      const lx = (x.ox + (px + 0.5) / x.res), ly = (x.oy + (py + 0.5) / x.res);
      if (lx < 0 || ly < 0 || lx >= seg.W || ly >= seg.H) continue;
      const x0 = Math.floor(mx), fx = mx - x0, xa = Math.max(0, Math.min(seg.w - 1, x0)), xb = Math.max(0, Math.min(seg.w - 1, x0 + 1));
      out[py * W + px] = (m[ya * seg.w + xa] * (1 - fx) + m[ya * seg.w + xb] * fx) * (1 - fy) + (m[yb * seg.w + xa] * (1 - fx) + m[yb * seg.w + xb] * fx) * fy;
    }
  }
  // enlarged: the steps of the working grid are smoothed, then the edge made crisp again
  const k = x.res / kx;
  if (k > 1.5) {
    const b = blurF(out, W, H, k * 0.5);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(1, (b[i] - 0.5) * 2 + 0.5));
  }
  return out;
}
const alphaCanvas = (a: Float32Array, W: number, H: number) => {
  const c = mk(W, H), img = new ImageData(W, H);
  for (let i = 0; i < a.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = Math.round(a[i] * 255); }
  ctx2d(c).putImageData(img, 0, 0);
  return c;
};

/** Draws the effect (canvas in layer space: px = (layer px − origin) × res); srcTime: the layer's source time. */
export function rotoBrushFx(cv: HTMLCanvasElement, f: FxInstance, p: Params, x: FxCtx, srcTime: number): HTMLCanvasElement {
  const d = f.roto, seg = d?.seg;
  if (!d?.strokes.length || !seg) return cv;
  const W = cv.width, H = cv.height, N = W * H;
  const i = rotoFrame(seg, srcTime);
  let A = sampleMatte(seg, i >= 0 ? seg.m[i] : null, W, H, x);
  if (num(p.invert)) for (let k = 0; k < N; k++) A[k] = 1 - A[k];
  const layerA = ctx2d(cv, true).getImageData(0, 0, W, H).data;
  // Fine-tune Roto Brush Matte: Feather, Contrast, Shift Edge and Reduce Chatter (neighbouring frames' mattes)
  if (num(p.rbFineTune)) {
    const nb = (j: number) => {
      if (j < 0 || j >= seg.n || !seg.m[j]) return null;
      let a = sampleMatte(seg, seg.m[j], W, H, x);
      if (num(p.invert)) a = a.map((v) => 1 - v);
      return { cv: alphaCanvas(a, W, H), ox: x.ox, oy: x.oy, res: x.res };
    };
    const chatter = num(p.rbChatter);
    const q = { smooth: 0, feather: num(p.rbFeather), contrast: num(p.rbContrast), shiftEdge: num(p.rbShift), reduceChatter: chatter, edgeDetails: 0, decontaminate: 0, ...(chatter > 0 && i >= 0 ? { _matte: { prev: nb(i - 1), next: nb(i + 1), blur: [] } } : {}) };
    const o1 = ctx2d(refine(cv, q, x, true, { alpha: A, band: new Float32Array(N) }), true).getImageData(0, 0, W, H).data;
    A = new Float32Array(N);
    for (let k = 0; k < N; k++) A[k] = layerA[k * 4 + 3] ? Math.min(1, o1[k * 4 + 3] / layerA[k * 4 + 3]) : 0;
  }
  // View Search Region: the band the propagation decides again round the edge, in yellow
  const view = num(p.viewSearch);
  // Refine Edge: the painted region (propagated) and Base Refine Edge Radius round the whole edge
  let band: Float32Array | null = null;
  if (num(p.renderRefine, 1) && i >= 0) {
    const reg = seg.r[i] ? sampleMatte(seg, seg.r[i], W, H, x) : null;
    const base = num(p.baseRadius) * x.res;
    if (reg || base > 0.5) {
      band = new Float32Array(N);
      if (reg) for (let k = 0; k < N; k++) band[k] = reg[k] >= 0.5 ? 1 : 0;
      if (base > 0.5) {
        const hard = new Uint8Array(N); for (let k = 0; k < N; k++) hard[k] = A[k] >= 0.5 ? 1 : 0;
        const a = morph(hard, W, H, base), b = morph(hard, W, H, -base);
        for (let k = 0; k < N; k++) if (a[k] && !b[k]) band[k] = 1;
      }
      if (!band.some((v) => v)) band = null;
    }
  }
  let out: HTMLCanvasElement;
  if (band) {
    const ft = num(p.reFineTune), chat = ft && String(p.reChatterMode ?? 'detailed') !== 'off' ? num(p.reChatter) : 0;
    const refD = d.strokes.filter((s) => s.kind === 'refine').map((s) => s.d);
    const rad = Math.max(2, num(p.baseRadius), refD.length ? refD.reduce((a, b) => a + b, 0) / refD.length / 4 : 0);
    const q = {
      edgeDetails: 1, edgeRadius: rad, smooth: ft ? num(p.reSmooth) : 0, feather: ft ? num(p.reFeather) : 0, contrast: ft ? num(p.reContrast) : 0, shiftEdge: ft ? num(p.reShift) : 0,
      reduceChatter: chat, decontaminate: num(p.reDecontaminate, 1), deconAmount: num(p.reDeconAmount, 100), deconExtend: num(p.reDeconExtend, 1), deconRadius: num(p.reDeconRadius), deconView: num(p.reDeconView),
    };
    out = refine(cv, q, x, true, { alpha: A, band });
  } else {
    out = mk(W, H);
    const g = ctx2d(out);
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(alphaCanvas(A, W, H), 0, 0);
  }
  if (view) {
    const R = Math.max(2, (num(p.searchRadius, 50) / 50) * (seg.W / 40)) * x.res;
    const hard = new Uint8Array(N); for (let k = 0; k < N; k++) hard[k] = A[k] >= 0.5 ? 1 : 0;
    const a = morph(hard, W, H, R), b = morph(hard, W, H, -R), img = new ImageData(W, H);
    for (let k = 0; k < N; k++) if (a[k] && !b[k]) { img.data[k * 4] = 255; img.data[k * 4 + 1] = 220; img.data[k * 4 + 2] = 0; img.data[k * 4 + 3] = 90; }
    const ov = mk(W, H);
    ctx2d(ov).putImageData(img, 0, 0);
    ctx2d(out).drawImage(ov, 0, 0);
  }
  return out;
}
