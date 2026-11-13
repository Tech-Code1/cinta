// Drawing of the Canal 3D effects and of the Refine mattes (catalogue: src/core/motion/fx-groups/canal3d.ts, which
// also says what input each 3D Channel effect reads). Helpers come from ../fx: only use them inside the functions
// (fx.ts imports this file while it is still loading).
import type { FxCtx, FxFn, Params } from '../fx';
import { mk, ctx2d } from '../fx';
import { parseColor } from '../../core/motion/anim';
import { zOfDepth } from '../../core/motion/model3d';
import { canal3dChannels } from '../../core/motion/fx-groups/canal3d';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => (b <= a ? (v >= a ? 1 : 0) : cl((v - a) / (b - a)));

/** Per-pixel 3D data of the effect's canvas: camera depth (Infinity = nothing there), object and material IDs,
 *  coverage, and where known the surface normal (x right, y up, z towards the viewer) and texture UV. */
export interface Depth3D { w: number; h: number; z: Float32Array; obj: Uint32Array; mat: Uint32Array; cov: Float32Array; n?: Float32Array; uv?: Float32Array; /** a whole comp (adjustment layer) */ comp?: boolean }

// ───────────────────────── Cinta's own 3D data ─────────────────────────
/** A layer seen by the comp camera: its plane's depth at every canvas pixel (z is affine on a plane), its index as
 *  object / material ID, its alpha as coverage (transparent = background, infinitely far), the plane's normal and
 *  the canvas position as UV. */
export function layerDepth(cv: HTMLCanvasElement, x: FxCtx, index: number): Depth3D | null {
  const sc = x.scene?.();
  if (!sc) return null;
  const W = cv.width, H = cv.height, N = W * H;
  const L = (px: number, py: number): [number, number] => [x.ox + px / x.res, x.oy + py / x.res];
  const zAt = (px: number, py: number) => { const [a, b] = L(px, py); return sc.project(a, b, 0)[2]; };
  const z0 = zAt(0, 0), zx = zAt(W, 0) - z0, zy = zAt(0, H) - z0;
  const a = ctx2d(cv, true).getImageData(0, 0, W, H).data;
  const z = new Float32Array(N), cov = new Float32Array(N), obj = new Uint32Array(N).fill(index), uv = new Float32Array(N * 2), n = new Float32Array(N * 3);
  const R = sc.rot;
  let nx = R[2], ny = R[5], nz = R[8];
  if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  for (let py = 0, i = 0; py < H; py++) for (let px = 0; px < W; px++, i++) {
    const c = a[i * 4 + 3] / 255;
    cov[i] = c;
    z[i] = c > 0 ? z0 + (zx * (px + 0.5)) / W + (zy * (py + 0.5)) / H : Infinity;
    uv[i * 2] = (px + 0.5) / W; uv[i * 2 + 1] = 1 - (py + 0.5) / H;
    n[i * 3] = nx; n[i * 3 + 1] = -ny; n[i * 3 + 2] = -nz;
  }
  return { w: W, h: H, z, obj, mat: obj, cov, n, uv };
}

/** What one layer adds to a comp's depth buffer: a textured quad (its content on screen, camera z at the corners,
 *  normal in camera space, z-tested when 3D) or a 3D model's own colour and packed depth (scene3d.ts). */
export type DepthItem = { id: number; cv: HTMLCanvasElement; pts: [number, number][]; z: number[]; n: number[]; test: boolean } | { id: number; model: { color: HTMLCanvasElement; depth: Uint8Array; W: number; H: number } };

/** Square → quad projective map (Heckbert), as a 3×3 row-major matrix. */
function sq2quad(p: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** The comp's depth buffer (output pixels): layers from the bottom up, 3D ones z-tested against what is there, 2D ones
 *  on top of it as they are drawn. */
export function rasterDepth(W: number, H: number, items: DepthItem[]): Depth3D {
  const N = W * H, z = new Float32Array(N).fill(Infinity), obj = new Uint32Array(N), cov = new Float32Array(N), n = new Float32Array(N * 3), uv = new Float32Array(N * 2);
  for (const it of items) {
    if ('model' in it) {
      const m = it.model, a = ctx2d(m.color.width === W ? m.color : (() => { const c = mk(W, H); ctx2d(c).drawImage(m.color, 0, 0, W, H); return c; })(), true).getImageData(0, 0, W, H).data;
      for (let y = 0; y < H; y++) {
        const sy = Math.min(m.H - 1, Math.floor(((H - 1 - y) * m.H) / H));
        for (let x = 0; x < W; x++) {
          const i = y * W + x, al = a[i * 4 + 3] / 255;
          if (al <= 0.02) continue;
          const j = (sy * m.W + Math.min(m.W - 1, Math.floor((x * m.W) / W))) * 4, d = (m.depth[j] * 65536 + m.depth[j + 1] * 256 + m.depth[j + 2]) / 16777215;
          if (d >= 1) continue;
          const zz = zOfDepth(d);
          if (zz >= z[i]) continue;
          z[i] = zz; obj[i] = it.id; cov[i] = al; uv[i * 2] = uv[i * 2 + 1] = 0; n[i * 3] = n[i * 3 + 1] = n[i * 3 + 2] = NaN;
        }
      }
      continue;
    }
    const cw = it.cv.width, chh = it.cv.height;
    if (cw < 1 || chh < 1) continue;
    const Hm = inv3(sq2quad(it.pts));
    const a = ctx2d(it.cv, true).getImageData(0, 0, cw, chh).data;
    const xs = it.pts.map((p) => p[0]), ys = it.pts.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W, Math.ceil(Math.max(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H, Math.ceil(Math.max(...ys)));
    // the plane's normal towards the viewer (camera space: x right, y down, z away) → x right, y up, z to the viewer
    let [nx, ny, nz] = it.n;
    if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const X = x + 0.5, Y = y + 0.5, w = Hm[6] * X + Hm[7] * Y + Hm[8];
      if (Math.abs(w) < 1e-12) continue;
      const u = (Hm[0] * X + Hm[1] * Y + Hm[2]) / w, v = (Hm[3] * X + Hm[4] * Y + Hm[5]) / w;
      if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
      const al = a[(Math.floor(v * chh) * cw + Math.floor(u * cw)) * 4 + 3] / 255;
      if (al <= 0.02) continue;
      const i = y * W + x;
      // z on the plane: bilinear between the corners (exact for an affine z), perspective-correct through u, v
      const zz = (it.z[0] * (1 - u) + it.z[1] * u) * (1 - v) + (it.z[3] * (1 - u) + it.z[2] * u) * v;
      if (it.test ? zz >= z[i] : al < 0.5 && z[i] !== Infinity) continue;
      z[i] = zz; obj[i] = it.id; cov[i] = al; uv[i * 2] = u; uv[i * 2 + 1] = 1 - v;
      n[i * 3] = nx; n[i * 3 + 1] = -ny; n[i * 3 + 2] = -nz;
    }
  }
  // models: normals from the depth's slope (screen-space)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!Number.isNaN(n[i * 3])) continue;
    const zl = z[y * W + Math.max(0, x - 1)], zr = z[y * W + Math.min(W - 1, x + 1)], zu = z[Math.max(0, y - 1) * W + x], zd = z[Math.min(H - 1, y + 1) * W + x];
    const gx = Number.isFinite(zl) && Number.isFinite(zr) ? (zr - zl) / 2 : 0, gy = Number.isFinite(zu) && Number.isFinite(zd) ? (zd - zu) / 2 : 0;
    const f = Math.max(1e-3, z[i]) / 400, l = Math.hypot(gx, gy, f) || 1;
    n[i * 3] = -gx / l; n[i * 3 + 1] = gy / l; n[i * 3 + 2] = f / l;
  }
  return { w: W, h: H, z, obj, mat: obj, cov, n, uv, comp: true };
}

// ───────────────────────── EXR channels ─────────────────────────
/** For every canvas pixel, the EXR pixel under it (the layer's own coordinates), or −1 outside. */
function auxIndex(W: number, H: number, x: FxCtx, aw: number, ah: number): Int32Array {
  const idx = new Int32Array(W * H);
  for (let py = 0; py < H; py++) {
    const Y = Math.floor(x.oy + (py + 0.5) / x.res);
    for (let px = 0; px < W; px++) { const X = Math.floor(x.ox + (px + 0.5) / x.res); idx[py * W + px] = X >= 0 && Y >= 0 && X < aw && Y < ah ? Y * aw + X : -1; }
  }
  return idx;
}
/** EXR channels of the footage this effect reads (by name), sampled on the canvas: values, or null when absent. */
function exrSample(cv: HTMLCanvasElement, p: Params, x: FxCtx, fx: string): { names: string[]; get: (name: string, asId?: boolean) => Float32Array } | null {
  const a = x.aux;
  if (!a) return null;
  const want = canal3dChannels(fx, (k) => String(p[k] ?? ''), a.names);
  if (!want.length || !want.every((c) => a.get(c))) return null;
  const idx = auxIndex(cv.width, cv.height, x, a.w, a.h);
  return {
    names: want,
    get: (name, asId) => {
      const c = a.get(name)!, out = new Float32Array(idx.length);
      for (let i = 0; i < idx.length; i++) { const k = idx[i]; out[i] = k < 0 ? NaN : asId && c.type === 0 ? c.bits[k] : asId ? Math.round(c.f[k]) : c.type === 0 ? c.bits[k] : c.f[k]; }
      return out;
    },
  };
}
/** Depth of every canvas pixel: the footage's EXR Z channel, else Cinta's 3D render (layer or comp). */
function depthOf(cv: HTMLCanvasElement, p: Params, x: FxCtx, fx: string): Float32Array | null {
  const e = exrSample(cv, p, x, fx);
  if (e) { const z = e.get(e.names[0]); for (let i = 0; i < z.length; i++) if (Number.isNaN(z[i])) z[i] = Infinity; return z; }
  return x.depth3d?.(cv)?.z ?? null;
}

// ───────────────────────── float image helpers ─────────────────────────
/** Box blur of a float plane (three passes ≈ Gaussian of the given sigma). */
function blurF(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src;
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) { boxH(a, b, W, H, r); boxV(b, a, W, H, r); }
  return a;
}
function boxH(s: Float32Array, d: Float32Array, W: number, H: number, r: number) {
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let acc = s[o] * (r + 1);
    for (let x = 1; x <= r; x++) acc += s[o + Math.min(W - 1, x)];
    for (let x = 0; x < W; x++) { d[o + x] = acc * k; acc += s[o + Math.min(W - 1, x + r + 1)] - s[o + Math.max(0, x - r)]; }
  }
}
function boxV(s: Float32Array, d: Float32Array, W: number, H: number, r: number) {
  const k = 1 / (2 * r + 1);
  for (let x = 0; x < W; x++) {
    let acc = s[x] * (r + 1);
    for (let y = 1; y <= r; y++) acc += s[Math.min(H - 1, y) * W + x];
    for (let y = 0; y < H; y++) { d[y * W + x] = acc * k; acc += s[Math.min(H - 1, y + r + 1) * W + x] - s[Math.max(0, y - r) * W + x]; }
  }
}
/** Single box mean of radius r (guided filter). */
function boxMean(s: Float32Array, W: number, H: number, r: number): Float32Array { const t = new Float32Array(s.length), o = new Float32Array(s.length); boxH(s, t, W, H, r); boxV(t, o, W, H, r); return o; }
/** Grey dilation (r > 0) or erosion (r < 0) by a square of radius |r| (separable max / min). */
function morph(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const R = Math.round(Math.abs(r));
  if (!R) return src;
  const mx = r > 0, t = new Float32Array(src.length), o = new Float32Array(src.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = mx ? 0 : 1; for (let k = Math.max(0, x - R); k <= Math.min(W - 1, x + R); k++) { const q = src[y * W + k]; v = mx ? Math.max(v, q) : Math.min(v, q); } t[y * W + x] = v; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = mx ? 0 : 1; for (let k = Math.max(0, y - R); k <= Math.min(H - 1, y + R); k++) { const q = t[k * W + x]; v = mx ? Math.max(v, q) : Math.min(v, q); } o[y * W + x] = v; }
  return o;
}
const imgOf = (cv: HTMLCanvasElement) => ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height);
const toCanvas = (img: ImageData) => { const o = mk(img.width, img.height); ctx2d(o).putImageData(img, 0, 0); return o; };
/** A content canvas of another moment, placed on this canvas (layer space). */
function align(c: { cv: HTMLCanvasElement; ox: number; oy: number; res: number } | null, W: number, H: number, x: FxCtx): Float32Array | null {
  if (!c) return null;
  const m = mk(W, H);
  ctx2d(m).drawImage(c.cv, (c.ox - x.ox) * x.res, (c.oy - x.oy) * x.res, (c.cv.width / c.res) * x.res, (c.cv.height / c.res) * x.res);
  const d = ctx2d(m, true).getImageData(0, 0, W, H).data, a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
  return a;
}

/** Variable blur: every pixel blurred by its own radius (0…R canvas px), from a stack of blurred copies
 *  (premultiplied, interpolated between the two nearest radii). */
function variableBlur(cv: HTMLCanvasElement, radius: Float32Array, R: number): HTMLCanvasElement {
  const W = cv.width, H = cv.height, src = imgOf(cv), d = src.data, N = W * H;
  const levels = Math.max(2, Math.min(8, Math.ceil(R / 3) + 1));
  const planes = [0, 1, 2, 3].map((c) => { const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = c === 3 ? d[i * 4 + 3] : (d[i * 4 + c] * d[i * 4 + 3]) / 255; return f; });
  const stack = Array.from({ length: levels + 1 }, (_, k) => (k ? planes.map((f) => blurF(f, W, H, ((R * k) / levels) / 2)) : planes));
  const out = new ImageData(W, H), o = out.data;
  for (let i = 0; i < N; i++) {
    const t = cl(radius[i] / (R || 1)) * levels, k = Math.min(levels - 1, Math.floor(t)), f = t - k, A = stack[k], B = stack[k + 1];
    const al = A[3][i] * (1 - f) + B[3][i] * f;
    o[i * 4 + 3] = al;
    if (al > 0) for (let c = 0; c < 3; c++) o[i * 4 + c] = ((A[c][i] * (1 - f) + B[c][i] * f) * 255) / al;
  }
  return toCanvas(out);
}

// ───────────────────────── Refine mattes ─────────────────────────
/** Other moments of the layer up to the effect (render.ts): the frames before and after (chatter) and the shutter
 *  samples (motion blur). */
export interface MatteWindow { prev: Content | null; next: Content | null; blur: (Content | null)[] }
type Content = { cv: HTMLCanvasElement; ox: number; oy: number; res: number };
/** The moments a Refine matte needs at t: neighbours for Reduce Chatter, the shutter for Use Motion Blur. */
export function matteTimes(v: (k: string) => unknown, t: number, fps: number): { prev?: number; next?: number; blur: number[] } {
  const out: { prev?: number; next?: number; blur: number[] } = { blur: [] };
  if (num(v('reduceChatter')) > 0) { out.prev = t - 1 / fps; out.next = t + 1 / fps; }
  if (num(v('useMotionBlur'))) {
    // Higher Quality takes up to 8 moments of the shutter, else 4 (AE samples the matte's motion the same way)
    const n = Math.max(1, Math.min(num(v('mbHigherQuality'), 1) ? 8 : 4, Math.round(num(v('mbSamples'), 16)))), sh = num(v('mbShutter'), 180) / 360 / fps;
    if (sh > 0 && n > 1) for (let k = 0; k < n; k++) out.blur.push(t + sh * ((k + 0.5) / n - 0.5));
  }
  return out;
}

/** ro.alpha: the matte to refine instead of the canvas' alpha (the canvas keeps its colours: Roto Brush); ro.band:
 *  the edge region to work in instead of the band round the matte's edge (Refine Edge strokes). */
export function refine(cv: HTMLCanvasElement, p: Params, x: FxCtx, soft: boolean, ro: { alpha?: Float32Array; band?: Float32Array } = {}): HTMLCanvasElement {
  const W = cv.width, H = cv.height, N = W * H, img = imgOf(cv), d = img.data, res = x.res;
  const A0 = new Float32Array(N);
  for (let i = 0; i < N; i++) A0[i] = ro.alpha ? ro.alpha[i] * (d[i * 4 + 3] / 255) : d[i * 4 + 3] / 255;
  let A: Float32Array = Float32Array.from(A0);
  const win = p._matte as MatteWindow | undefined;
  // motion blur: the matte averaged over the shutter
  if (num(p.useMotionBlur) && win?.blur.length) {
    const fr = win.blur.map((c) => align(c, W, H, x)).filter((f): f is Float32Array => !!f);
    if (fr.length) for (let i = 0; i < N; i++) { let s = 0; for (const f of fr) s += f[i]; A[i] = s / fr.length; }
  }
  // Reduce Chatter: along the edge the matte is averaged with the frames before and after
  const rc = num(p.reduceChatter) / 100;
  if (rc > 0 && win) {
    const pa = align(win.prev, W, H, x), na = align(win.next, W, H, x);
    if (pa || na) for (let i = 0; i < N; i++) {
      const q = pa ? pa[i] : A[i], r = na ? na[i] : A[i];
      if (q === A[i] && r === A[i]) continue;
      A[i] = A[i] * (1 - rc) + ((q + A[i] + r) / 3) * rc;
    }
  }
  // the edge region: a band round the 50 % contour (Refine Soft Matte: plus Additional Edge Radius)
  const bandR = Math.max(1, ((soft ? num(p.edgeRadius) : 0) + 2) * res);
  const hard = new Float32Array(N); for (let i = 0; i < N; i++) hard[i] = A[i] >= 0.5 ? 1 : 0;
  const band = ro.band ?? (() => { const dl = morph(hard, W, H, bandR), er = morph(hard, W, H, -bandR), b = new Float32Array(N); for (let i = 0; i < N; i++) b[i] = dl[i] - er[i] > 0 || (A[i] > 0.01 && A[i] < 0.99) ? 1 : 0; return b; })();
  // Calculate Edge Details: inside the band the matte follows the image (guided filter with the luminance as guide)
  if (soft && num(p.edgeDetails, 1)) {
    const I = new Float32Array(N);
    for (let i = 0; i < N; i++) I[i] = ((0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255) * ((ro.alpha ? d[i * 4 + 3] : A0[i]) > 0 ? 1 : 0);
    const r = Math.max(1, Math.round(bandR)), eps = 1e-3;
    const mI = boxMean(I, W, H, r), mA = boxMean(A, W, H, r), II = new Float32Array(N), IA = new Float32Array(N);
    for (let i = 0; i < N; i++) { II[i] = I[i] * I[i]; IA[i] = I[i] * A[i]; }
    const mII = boxMean(II, W, H, r), mIA = boxMean(IA, W, H, r), ca = new Float32Array(N), cb = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = mII[i] - mI[i] * mI[i], cv2 = mIA[i] - mI[i] * mA[i]; ca[i] = cv2 / (v + eps); cb[i] = mA[i] - ca[i] * mI[i]; }
    const ma = boxMean(ca, W, H, r), mb = boxMean(cb, W, H, r);
    for (let i = 0; i < N; i++) if (band[i]) A[i] = cl(ma[i] * I[i] + mb[i]);
  }
  const before = Float32Array.from(A);
  // Smooth: the outline's jaggedness evened out (Hard: then made crisp again)
  const sm = num(p.smooth);
  if (sm > 0) {
    const b = blurF(A, W, H, (sm * res) / 2);
    if (soft) { for (let i = 0; i < N; i++) if (band[i]) A[i] = b[i]; }
    else { const k = Math.max(1, 1 / Math.max(0.05, (sm * res) / 4)); for (let i = 0; i < N; i++) A[i] = cl((b[i] - 0.5) * k * 2 + 0.5); }
  }
  // Choke (Hard): the matte shrinks (> 0) or spreads (< 0), up to 10 px at ±100 %
  const chk = soft ? 0 : num(p.choke);
  if (chk) A = morph(A, W, H, (-chk / 100) * 10 * res);
  // Feather: a softer edge, up to 10 px at 100 %
  const fe = num(p.feather);
  if (fe > 0) A = blurF(A, W, H, (fe / 100) * 10 * res / 2);
  // Contrast (Soft): a harder edge transition
  const ct = soft ? num(p.contrast) / 100 : 0;
  if (ct > 0) { const k = 1 / Math.max(0.01, 1 - ct); for (let i = 0; i < N; i++) A[i] = cl((A[i] - 0.5) * k + 0.5); }
  // Shift Edge: the edge moves outwards (> 0) or inwards within its transition (and by up to 5 px past it)
  const se = num(p.shiftEdge) / 100;
  if (se) { const M = morph(A, W, H, se * 5 * res); for (let i = 0; i < N; i++) A[i] = cl(M[i] + se * 0.25 * (A[i] > 0 && A[i] < 1 ? 1 : 0)); }

  // View Edge Region (Soft): the matte in grey with the band where edge details are computed
  if (soft && num(p.viewEdge)) {
    const out = new ImageData(W, H), o = out.data;
    for (let i = 0; i < N; i++) { const v = A[i] * 255; if (band[i]) { o[i * 4] = 128 + v / 2; o[i * 4 + 1] = 128 + v / 2; o[i * 4 + 2] = 32; } else o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255; }
    return toCanvas(out);
  }
  // Decontaminate Edge Colors: in the transition (and where smoothing changed the matte) the colour moves towards
  // the solid foreground colour nearby, in proportion to the transparency
  const deco = num(p.decontaminate, 1), amt = num(p.deconAmount, 100) / 100;
  const solid = new Float32Array(N), cr = new Float32Array(N), cg = new Float32Array(N), cb2 = new Float32Array(N);
  for (let i = 0; i < N; i++) if (A0[i] > 0.95) { solid[i] = 1; cr[i] = d[i * 4]; cg[i] = d[i * 4 + 1]; cb2[i] = d[i * 4 + 2]; }
  const fr = 2 * res + num(p.deconRadius) * res, sw = blurF(solid, W, H, fr), sr = blurF(cr, W, H, fr), sg = blurF(cg, W, H, fr), sb = blurF(cb2, W, H, fr);
  // wider estimate for pixels the matte spread over (they had no colour)
  const wide = 8 * res + fr, ww = blurF(solid, W, H, wide), wr = blurF(cr, W, H, wide), wg = blurF(cg, W, H, wide), wb = blurF(cb2, W, H, wide);
  const region = morph(band, W, H, num(p.deconRadius) * res);
  const map = new Float32Array(N);
  const out = new ImageData(W, H), o = out.data;
  for (let i = 0; i < N; i++) {
    const a = A[i];
    let r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const fg: [number, number, number] | null = sw[i] > 1e-3 ? [sr[i] / sw[i], sg[i] / sw[i], sb[i] / sw[i]] : ww[i] > 1e-4 ? [wr[i] / ww[i], wg[i] / ww[i], wb[i] / ww[i]] : null;
    if ((ro.alpha ? d[i * 4 + 3] / 255 : A0[i]) <= 0.004 && fg) { r = fg[0]; g = fg[1]; b = fg[2]; }
    if (deco && fg && a > 0 && a < 1) {
      const inR = region[i] > 0 || (num(p.deconExtend, 1) && Math.abs(a - before[i]) > 0.01);
      if (inR) { const k = amt * (1 - a); map[i] = k; r += (fg[0] - r) * k; g += (fg[1] - g) * k; b += (fg[2] - b) * k; }
    }
    o[i * 4] = r; o[i * 4 + 1] = g; o[i * 4 + 2] = b; o[i * 4 + 3] = a * 255;
  }
  if (deco && num(p.deconView)) { for (let i = 0; i < N; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = map[i] * 255; o[i * 4 + 3] = 255; } }
  return toCanvas(out);
}

// ───────────────────────── effects ─────────────────────────
export const IMPL_CANAL3D: Record<string, FxFn> = {
  // 3D Channel Extract: one channel as an image — Z between the black and white points (clamped, inverted), IDs as
  // greys, UV in red / green, normals as RGB, coverage, the background colour or the unclamped colour
  channel3dExtract: (cv, p, x) => {
    const W = cv.width, H = cv.height, N = W * H, ch = String(p.channel ?? 'zDepth');
    const src = imgOf(cv), s = src.data, out = new ImageData(W, H), o = out.data;
    const e = exrSample(cv, p, x, 'channel3dExtract'), D = e ? null : x.depth3d?.(cv) ?? null;
    if (!e && !D) return cv;
    const val = new Float32Array(N * 3).fill(NaN);
    const set = (i: number, r: number, g: number, b: number) => { val[i * 3] = r; val[i * 3 + 1] = g; val[i * 3 + 2] = b; };
    const bp = num(p.blackPoint, -10000), wp = num(p.whitePoint, 10000), span = wp - bp || 1e-6, clamp = num(p.clamp, 1), inv = num(p.invert);
    if (ch === 'zDepth') {
      const z = e ? e.get(e.names[0]) : D!.z;
      for (let i = 0; i < N; i++) { const zz = z[i]; if (Number.isNaN(zz)) continue; let v = zz === Infinity ? (span > 0 ? Infinity : -Infinity) : (zz - bp) / span; if (clamp || !Number.isFinite(v)) v = cl(v); if (inv) v = 1 - v; set(i, v, v, v); }
    } else if (ch === 'objectId' || ch === 'materialId') {
      const id = e ? e.get(e.names[0], true) : Float32Array.from(ch === 'objectId' ? D!.obj : D!.mat);
      let mx = 1; for (let i = 0; i < N; i++) if (id[i] > mx) mx = id[i];
      for (let i = 0; i < N; i++) if (!Number.isNaN(id[i])) { const v = id[i] / mx; set(i, v, v, v); }
    } else if (ch === 'uv') {
      if (e) { const u = e.get(e.names[0]), v = e.get(e.names[1]); for (let i = 0; i < N; i++) if (!Number.isNaN(u[i])) set(i, u[i], v[i], 0); }
      else if (D!.uv) for (let i = 0; i < N; i++) if (D!.z[i] !== Infinity) set(i, D!.uv[i * 2], D!.uv[i * 2 + 1], 0);
    } else if (ch === 'normals') {
      if (e) { const [a, b, c] = e.names.map((nm) => e.get(nm)); for (let i = 0; i < N; i++) if (!Number.isNaN(a[i])) set(i, (a[i] + 1) / 2, (b[i] + 1) / 2, (c[i] + 1) / 2); }
      else if (D!.n) for (let i = 0; i < N; i++) if (D!.z[i] !== Infinity) set(i, (D!.n[i * 3] + 1) / 2, (D!.n[i * 3 + 1] + 1) / 2, (D!.n[i * 3 + 2] + 1) / 2);
    } else if (ch === 'coverage') {
      const c = e ? e.get(e.names[0]) : D!.cov;
      for (let i = 0; i < N; i++) if (!Number.isNaN(c[i])) set(i, c[i], c[i], c[i]);
    } else if (ch === 'bgRgb' || ch === 'unclampedRgb') {
      // EXR: the background / beauty channels; Cinta: no background behind its layers (black), its own colour
      if (e) { const [a, b, c] = e.names.map((nm) => e.get(nm)); for (let i = 0; i < N; i++) if (!Number.isNaN(a[i])) set(i, a[i], b[i], c[i]); }
      else for (let i = 0; i < N; i++) { if (ch === 'bgRgb') set(i, 0, 0, 0); else set(i, s[i * 4] / 255, s[i * 4 + 1] / 255, s[i * 4 + 2] / 255); }
    }
    // Anti-alias: the channel's hard steps softened (3×3)
    if (num(p.antiAlias)) for (let c = 0; c < 3; c++) {
      const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = val[i * 3 + c];
      for (let y = 0; y < H; y++) for (let x0 = 0; x0 < W; x0++) {
        let acc = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x0 + dx; if (yy < 0 || xx < 0 || yy >= H || xx >= W) continue; const q = f[yy * W + xx]; if (!Number.isNaN(q)) { acc += q; k++; } }
        if (k && !Number.isNaN(f[y * W + x0])) val[(y * W + x0) * 3 + c] = acc / k;
      }
    }
    const comp = !!D?.comp;
    for (let i = 0; i < N; i++) {
      if (Number.isNaN(val[i * 3])) { if (comp || e) { o[i * 4 + 3] = 255; } continue; }
      o[i * 4] = val[i * 3] * 255; o[i * 4 + 1] = val[i * 3 + 1] * 255; o[i * 4 + 2] = val[i * 3 + 2] * 255;
      // footage and comps give an opaque image; a layer keeps its own shape
      o[i * 4 + 3] = comp || e ? 255 : s[i * 4 + 3];
    }
    return toCanvas(out);
  },
  // Depth of Field: the blur grows with the distance from the focal plane (outside its thickness) up to Maximum
  // Radius at the farthest depth in view; Focal Bias bends how fast it gets there (50 = linearly)
  depthOfField: (cv, p, x) => {
    const R = num(p.maxRadius) * x.res;
    if (R < 0.5) return cv;
    const z = depthOf(cv, p, x, 'depthOfField');
    if (!z) return cv;
    const F = num(p.focalPlane), T = num(p.thickness) / 2, N = z.length, dist = new Float32Array(N);
    let mx = 0;
    for (let i = 0; i < N; i++) { const q = z[i]; dist[i] = Number.isFinite(q) ? Math.max(0, Math.abs(q - F) - T) : -1; if (dist[i] > mx) mx = dist[i]; }
    if (mx <= 0 && !dist.some((v) => v < 0)) return cv;
    const g = Math.pow(2, (50 - num(p.bias, 50)) / 25), r = new Float32Array(N);
    for (let i = 0; i < N; i++) r[i] = dist[i] < 0 ? R : mx > 0 ? R * Math.pow(dist[i] / mx, g) : 0;
    return variableBlur(cv, r, R);
  },
  // Depth Matte: what is nearer than Depth is removed (Invert keeps only that), with a soft step of Feather depth units
  depthMatte: (cv, p, x) => {
    const z = depthOf(cv, p, x, 'depthMatte');
    if (!z) return cv;
    const D = num(p.depth), f = num(p.feather) / 2, inv = num(p.invert), img = imgOf(cv), d = img.data;
    for (let i = 0; i < z.length; i++) { let m = z[i] === Infinity ? 1 : smooth(D - f, D + f, z[i]); if (inv) m = 1 - m; d[i * 4 + 3] *= m; }
    return toCanvas(img);
  },
  // Fog 3D: fog from the start to the end depth (none when they are equal), thicker sooner with more scattering
  // density, scaled by the opacity; the background (no depth) is all fog with Foggy Background; a gradient layer's
  // luminance thins it by its Layer Contribution
  fog3d: (cv, p, x) => {
    const s0 = num(p.start), e0 = num(p.end);
    if (s0 === e0) return cv;
    const z = depthOf(cv, p, x, 'fog3d');
    if (!z) return cv;
    const W = cv.width, H = cv.height, img = imgOf(cv), d = img.data, op = cl(num(p.opacity, 100) / 100), bg = num(p.foggyBg, 1);
    const k = (num(p.density, 50) - 50) / 10, shape = (v: number) => (Math.abs(k) < 1e-3 ? v : (1 - Math.exp(-k * v)) / (1 - Math.exp(-k)));
    const [fr, fg, fb] = parseColor(String(p.color ?? '#ffffff'));
    let grad: Uint8ClampedArray | null = null;
    const contrib = cl(num(p.contribution) / 100), gid = String(p.gradient ?? '');
    if (gid && contrib > 0) { const L = x.layer?.(gid); if (L) { const m = mk(W, H); ctx2d(m).drawImage(L.cv, 0, 0, W, H); grad = ctx2d(m, true).getImageData(0, 0, W, H).data; } }
    for (let i = 0; i < z.length; i++) {
      const isBg = z[i] === Infinity || d[i * 4 + 3] === 0;
      let f = isBg ? (bg ? 1 : 0) : shape(cl((z[i] - s0) / (e0 - s0)));
      if (grad) f *= 1 - contrib + contrib * ((0.2126 * grad[i * 4] + 0.7152 * grad[i * 4 + 1] + 0.0722 * grad[i * 4 + 2]) / 255) * (grad[i * 4 + 3] / 255);
      f *= op;
      if (f <= 0) continue;
      const a = d[i * 4 + 3] / 255, na = isBg ? a + (1 - a) * f : a;
      // the colour mixed with the fog (over a transparent background the fog's own colour shows)
      const mixc = (c: number, fc: number) => (na > 0 ? ((c / 255) * a * (1 - f) + fc * (isBg ? na - a * (1 - f) : a * f)) / na : fc) * 255;
      d[i * 4] = mixc(d[i * 4], fr); d[i * 4 + 1] = mixc(d[i * 4 + 1], fg); d[i * 4 + 2] = mixc(d[i * 4 + 2], fb); d[i * 4 + 3] = na * 255;
    }
    return toCanvas(img);
  },
  // ID Matte: only the pixels of one object / material ID stay (Invert: all but those), the matte feathered by
  // Feather px and multiplied by the coverage when Use Coverage is on
  idMatte: (cv, p, x) => {
    const W = cv.width, H = cv.height, N = W * H, want = Math.round(num(p.id)), mat = String(p.aux ?? 'objectId') === 'materialId';
    const e = exrSample(cv, p, x, 'idMatte'), D = e ? null : x.depth3d?.(cv) ?? null;
    if (!e && !D) return cv;
    const id = e ? e.get(e.names[0], true) : null, cov = num(p.coverage) ? (e ? (e.names[1] ? e.get(e.names[1]) : null) : D!.cov) : null;
    let m: Float32Array = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = id ? id[i] : D!.z[i] === Infinity ? 0 : mat ? D!.mat[i] : D!.obj[i]; m[i] = v === want ? 1 : 0; }
    const fe = num(p.feather) * x.res;
    if (fe > 0.3) m = blurF(m, W, H, fe / 2);
    const img = imgOf(cv), d = img.data, inv = num(p.invert);
    for (let i = 0; i < N; i++) {
      let k = m[i];
      if (cov && !Number.isNaN(cov[i]) && k > 0) k *= cl(cov[i]) / Math.max(1e-3, D && !e ? Math.max(cov[i], d[i * 4 + 3] / 255) : 1);
      if (inv) k = 1 - k;
      d[i * 4 + 3] *= k;
    }
    return toCanvas(img);
  },
  refineHardMatte: (cv, p, x) => refine(cv, p, x, false),
  refineSoftMatte: (cv, p, x) => refine(cv, p, x, true),
};
