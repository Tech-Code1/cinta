// Interactive segmentation of video for the Roto Brush (pure TypeScript, no model download): strokes mark
// foreground and background; a colour model of each (k-means clusters → a small Gaussian mixture) gives every pixel
// a probability, and a random walker on the image graph (edges weighted by colour contrast, Grady 2005, with those
// probabilities as priors) decides the pixels between the strokes, so the boundary snaps to the image's edges. The
// next frame starts from the previous matte moved by the subject's motion (an affine fitted to points tracked inside
// it, with AE's Motion Threshold / Motion Damping), and only a band of Search Radius round its edge is decided again,
// mixing the predicted shape with the colours (Edge Detection says which counts more).
import { trackFrames, textureAt } from './tracker';

export interface Img { w: number; h: number; /** RGB, 3 bytes per pixel */ d: Uint8Array }

// ───────────────────────── small image helpers ─────────────────────────
/** Separable max (r > 0) / min (r < 0) by a square of radius |r| on a 0/1 mask. */
export function morph(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const R = Math.round(Math.abs(r));
  if (!R) return src.slice();
  const mx = r > 0, t = new Uint8Array(src.length), o = new Uint8Array(src.length);
  // running count of ones in the window: O(N) per pass whatever the radius
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, R); x++) cnt += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - R), hi = Math.min(w - 1, x + R), n = hi - lo + 1;
      t[row + x] = mx ? (cnt > 0 ? 1 : 0) : (cnt === n ? 1 : 0);
      if (x + R + 1 < w) cnt += src[row + x + R + 1];
      if (x - R >= 0) cnt -= src[row + x - R];
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, R); y++) cnt += t[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - R), hi = Math.min(h - 1, y + R), n = hi - lo + 1;
      o[y * w + x] = mx ? (cnt > 0 ? 1 : 0) : (cnt === n ? 1 : 0);
      if (y + R + 1 < h) cnt += t[(y + R + 1) * w + x];
      if (y - R >= 0) cnt -= t[(y - R) * w + x];
    }
  }
  return o;
}
/** Box blur of a float plane, three passes (≈ Gaussian of that sigma). */
export function blurF(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let a = Float32Array.from(src);
  const b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w; let acc = a[o] * (r + 1);
      for (let x = 1; x <= r; x++) acc += a[o + Math.min(w - 1, x)];
      for (let x = 0; x < w; x++) { b[o + x] = acc / (2 * r + 1); acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let acc = b[x] * (r + 1);
      for (let y = 1; y <= r; y++) acc += b[Math.min(h - 1, y) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = acc / (2 * r + 1); acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; }
    }
  }
  return a;
}
/** Thick polyline (round caps) rasterised into a mask: points in mask px, radius in mask px. */
export function rasterStroke(out: Uint8Array, w: number, h: number, pts: number[], radius: number, value = 1) {
  const r = Math.max(0.5, radius), r2 = r * r;
  const dot = (cx: number, cy: number) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) out[y * w + x] = value;
  };
  if (pts.length < 4) { if (pts.length >= 2) dot(pts[0], pts[1]); return; }
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3], len = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(len / Math.max(0.5, r / 2)));
    for (let k = 0; k <= steps; k++) dot(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps);
  }
}
/** Connected components (4-neighbours) of the pixels where m === v; keeps those touching a seed (seed[i] = 1). */
export function keepConnected(m: Uint8Array, w: number, _h: number, v: number, seed: (i: number) => boolean): Uint8Array {
  const out = new Uint8Array(m.length), stack = new Int32Array(m.length);
  let sp = 0;
  for (let i = 0; i < m.length; i++) if (m[i] === v && seed(i) && !out[i]) { out[i] = 1; stack[sp++] = i; }
  while (sp) {
    const i = stack[--sp], x = i % w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < m.length - w ? i + w : -1];
    for (const j of nb) if (j >= 0 && !out[j] && m[j] === v) { out[j] = 1; stack[sp++] = j; }
  }
  return out;
}
/** Fills background holes (components of 0 not touching the border) smaller than maxArea pixels. */
export function fillSmallHoles(m: Uint8Array, w: number, h: number, maxArea: number): Uint8Array {
  const out = m.slice(), seen = new Uint8Array(m.length), stack = new Int32Array(m.length), comp: number[] = [];
  for (let s = 0; s < m.length; s++) {
    if (m[s] || seen[s]) continue;
    let sp = 0, border = false;
    comp.length = 0;
    seen[s] = 1; stack[sp++] = s;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      comp.push(i);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !seen[j] && !m[j]) { seen[j] = 1; stack[sp++] = j; }
    }
    if (!border && comp.length <= maxArea) for (const i of comp) out[i] = 1;
  }
  return out;
}

// ───────────────────────── colour models ─────────────────────────
export interface ColorModel { k: number; mu: Float32Array; inv: Float32Array; norm: Float32Array }
/** k clusters of the colours of the sampled pixels (deterministic: seeds spread by luminance), each a Gaussian. */
export function colorModel(img: Img, idx: ArrayLike<number>, k: number): ColorModel | null {
  const n = idx.length;
  if (!n) return null;
  // at most 6000 samples, evenly picked
  const step = Math.max(1, Math.floor(n / 6000)), S: number[] = [];
  for (let i = 0; i < n; i += step) S.push(idx[i]);
  const N = S.length, K = Math.max(1, Math.min(k, N));
  const col = (j: number, c: number) => img.d[S[j] * 3 + c];
  const order = S.map((_, j) => j).sort((a, b) => (col(a, 0) * 3 + col(a, 1) * 6 + col(a, 2)) - (col(b, 0) * 3 + col(b, 1) * 6 + col(b, 2)));
  const mu = new Float32Array(K * 3);
  for (let c = 0; c < K; c++) { const j = order[Math.floor(((c + 0.5) * N) / K)]; for (let q = 0; q < 3; q++) mu[c * 3 + q] = col(j, q); }
  const lab = new Int32Array(N);
  for (let it = 0; it < 8; it++) {
    for (let j = 0; j < N; j++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) { const d = (col(j, 0) - mu[c * 3]) ** 2 + (col(j, 1) - mu[c * 3 + 1]) ** 2 + (col(j, 2) - mu[c * 3 + 2]) ** 2; if (d < bd) { bd = d; best = c; } }
      lab[j] = best;
    }
    const s = new Float64Array(K * 3), cnt = new Float64Array(K);
    for (let j = 0; j < N; j++) { const c = lab[j]; cnt[c]++; for (let q = 0; q < 3; q++) s[c * 3 + q] += col(j, q); }
    for (let c = 0; c < K; c++) if (cnt[c]) for (let q = 0; q < 3; q++) mu[c * 3 + q] = s[c * 3 + q] / cnt[c];
  }
  const v = new Float64Array(K), cnt = new Float64Array(K);
  for (let j = 0; j < N; j++) { const c = lab[j]; cnt[c]++; v[c] += (col(j, 0) - mu[c * 3]) ** 2 + (col(j, 1) - mu[c * 3 + 1]) ** 2 + (col(j, 2) - mu[c * 3 + 2]) ** 2; }
  const inv = new Float32Array(K), norm = new Float32Array(K);
  for (let c = 0; c < K; c++) {
    const vv = Math.max(60, cnt[c] ? v[c] / (3 * cnt[c]) : 400);
    inv[c] = 1 / (2 * vv);
    // weight / (2πσ²)^(3/2)
    norm[c] = (cnt[c] / N) / Math.pow(2 * Math.PI * vv, 1.5);
  }
  return { k: K, mu, inv, norm };
}
export function likelihood(m: ColorModel, r: number, g: number, b: number): number {
  let p = 1e-30;
  for (let c = 0; c < m.k; c++) p += m.norm[c] * Math.exp(-((r - m.mu[c * 3]) ** 2 + (g - m.mu[c * 3 + 1]) ** 2 + (b - m.mu[c * 3 + 2]) ** 2) * m.inv[c]);
  return p;
}
/** Probability of foreground of every pixel from the two colour models (0.5 where neither knows). */
export function colorProb(img: Img, fg: ColorModel | null, bg: ColorModel | null, only?: Uint8Array): Float32Array {
  const N = img.w * img.h, P = new Float32Array(N).fill(0.5);
  if (!fg || !bg) return P;
  for (let i = 0; i < N; i++) {
    if (only && !only[i]) continue;
    const r = img.d[i * 3], g = img.d[i * 3 + 1], b = img.d[i * 3 + 2], f = likelihood(fg, r, g, b), q = likelihood(bg, r, g, b);
    P[i] = Math.min(0.98, Math.max(0.02, f / (f + q)));
  }
  return P;
}

// ───────────────────────── random walker with priors ─────────────────────────
/**
 * Solves (L + γ) x = γ·prior on the unknown pixels (fixed[i] = −1), the others held at their value (0 / 1), by
 * conjugate gradients. L is the graph Laplacian of the 4-connected grid with weights exp(−β‖ΔI‖²).
 */
export function randomWalker(img: Img, fixed: Int8Array, prior: Float32Array, gamma: number | Float32Array, x0: Float32Array | null, iters = 200): Float32Array {
  const { w, h, d } = img, N = w * h;
  // edge weights to the right and down
  const wr = new Float32Array(N), wd = new Float32Array(N);
  let sum = 0, cnt = 0;
  const diff = (i: number, j: number) => (d[i * 3] - d[j * 3]) ** 2 + (d[i * 3 + 1] - d[j * 3 + 1]) ** 2 + (d[i * 3 + 2] - d[j * 3 + 2]) ** 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (x < w - 1) { wr[i] = diff(i, i + 1); sum += wr[i]; cnt++; } if (y < h - 1) { wd[i] = diff(i, i + w); sum += wd[i]; cnt++; } }
  const beta = 1 / (2 * Math.max(1, sum / Math.max(1, cnt)));
  for (let i = 0; i < N; i++) { wr[i] = Math.exp(-beta * wr[i]) + 1e-4; wd[i] = Math.exp(-beta * wd[i]) + 1e-4; }
  const g = (i: number) => (typeof gamma === 'number' ? gamma : gamma[i]);
  const x = new Float32Array(N);
  const U: number[] = [];
  for (let i = 0; i < N; i++) { if (fixed[i] >= 0) x[i] = fixed[i]; else { x[i] = x0 ? x0[i] : prior[i]; U.push(i); } }
  const n = U.length;
  if (!n) return x;
  const pos = new Int32Array(N).fill(-1);
  for (let k = 0; k < n; k++) pos[U[k]] = k;
  // A·v over the unknowns; b = γ·prior + fixed neighbours
  const diag = new Float32Array(n), b = new Float32Array(n);
  const nbs = (i: number, fn: (j: number, wt: number) => void) => {
    const xx = i % w;
    if (xx > 0) fn(i - 1, wr[i - 1]);
    if (xx < w - 1) fn(i + 1, wr[i]);
    if (i >= w) fn(i - w, wd[i - w]);
    if (i < N - w) fn(i + w, wd[i]);
  };
  for (let k = 0; k < n; k++) {
    const i = U[k];
    let dg = g(i), bb = g(i) * prior[i];
    nbs(i, (j, wt) => { dg += wt; if (fixed[j] >= 0) bb += wt * fixed[j]; });
    diag[k] = dg; b[k] = bb;
  }
  const Av = (v: Float32Array, out: Float32Array) => {
    for (let k = 0; k < n; k++) {
      const i = U[k];
      let s = diag[k] * v[k];
      nbs(i, (j, wt) => { const q = pos[j]; if (q >= 0) s -= wt * v[q]; });
      out[k] = s;
    }
  };
  // Jacobi-preconditioned CG
  const xs = new Float32Array(n);
  for (let k = 0; k < n; k++) xs[k] = x[U[k]];
  const r = new Float32Array(n), z = new Float32Array(n), p = new Float32Array(n), Ap = new Float32Array(n);
  Av(xs, Ap);
  let bn = 0;
  for (let k = 0; k < n; k++) { r[k] = b[k] - Ap[k]; z[k] = r[k] / diag[k]; p[k] = z[k]; bn += b[k] * b[k]; }
  let rz = 0;
  for (let k = 0; k < n; k++) rz += r[k] * z[k];
  const tol = 1e-6 * Math.max(1e-12, bn);
  for (let it = 0; it < iters; it++) {
    Av(p, Ap);
    let pAp = 0;
    for (let k = 0; k < n; k++) pAp += p[k] * Ap[k];
    if (pAp <= 0) break;
    const a = rz / pAp;
    let rr = 0;
    for (let k = 0; k < n; k++) { xs[k] += a * p[k]; r[k] -= a * Ap[k]; rr += r[k] * r[k]; }
    if (rr < tol) break;
    let rz2 = 0;
    for (let k = 0; k < n; k++) { z[k] = r[k] / diag[k]; rz2 += r[k] * z[k]; }
    const bt = rz2 / (rz || 1e-30);
    rz = rz2;
    for (let k = 0; k < n; k++) p[k] = z[k] + bt * p[k];
  }
  for (let k = 0; k < n; k++) x[U[k]] = Math.max(0, Math.min(1, xs[k]));
  return x;
}

// ───────────────────────── one frame ─────────────────────────
export interface SegOptions {
  quality?: 'standard' | 'best';
  /** working px of the band decided again round the predicted edge */
  radius?: number;
  /** 'predicted' | 'balanced' | 'current' */
  edges?: string;
  /** local colour models (only from the band's neighbourhood): «Cálculo de color alternativo» */
  altColor?: boolean;
}
const EDGE_W: Record<string, { shape: number; gamma: number }> = { predicted: { shape: 0.7, gamma: 0.08 }, balanced: { shape: 0.45, gamma: 0.05 }, current: { shape: 0.2, gamma: 0.035 } };

/**
 * Segments one frame. fg / bg: stroke masks of this frame (1 where painted). pred: the previous matte moved to this
 * frame (null on the base frame: then only the strokes and colours decide). Returns the 0/1 matte.
 */
export function segmentFrame(img: Img, fg: Uint8Array, bg: Uint8Array, pred: Uint8Array | null, o: SegOptions = {}): Uint8Array {
  const { w, h } = img, N = w * h, best = o.quality === 'best';
  const ew = EDGE_W[o.edges ?? 'balanced'] ?? EDGE_W.balanced;
  const R = Math.max(2, Math.round(o.radius ?? w / 40));
  const fixed = new Int8Array(N).fill(-1);
  let prior: Float32Array, gamma: number, x0: Float32Array | null = null;
  const anyFg = fg.some((v) => v), anyBg = bg.some((v) => v);
  if (!pred) {
    // base frame: background is what was painted as such, else the border of the frame
    for (let i = 0; i < N; i++) { if (fg[i]) fixed[i] = 1; else if (bg[i]) fixed[i] = 0; }
    const bgS: number[] = [], fgS: number[] = [];
    for (let i = 0; i < N; i++) if (fg[i]) fgS.push(i); else if (bg[i]) bgS.push(i);
    if (!anyBg) {
      // samples far from the foreground strokes: outside their bounding box grown by half its size
      let x0b = w, y0b = h, x1b = 0, y1b = 0;
      for (let i = 0; i < N; i++) if (fg[i]) { const x = i % w, y = (i / w) | 0; x0b = Math.min(x0b, x); x1b = Math.max(x1b, x); y0b = Math.min(y0b, y); y1b = Math.max(y1b, y); }
      const gx = (x1b - x0b) * 0.5 + R, gy = (y1b - y0b) * 0.5 + R;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const out = x < x0b - gx || x > x1b + gx || y < y0b - gy || y > y1b + gy;
        if (out) bgS.push(y * w + x);
        if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && !fg[y * w + x]) fixed[y * w + x] = 0;
      }
    }
    if (!anyFg) return new Uint8Array(N);
    const k = best ? 8 : 5;
    prior = colorProb(img, colorModel(img, fgS, k), colorModel(img, bgS.length ? bgS : borderIdx(w, h), k));
    gamma = ew.gamma * 0.6;
  } else {
    // propagated frame: only a band of Search Radius round the predicted edge (and round new strokes) is decided
    const inner = morph(pred, w, h, -R), outer = morph(pred, w, h, R);
    const nearStroke = anyFg || anyBg ? morph(orMask(fg, bg), w, h, R) : null;
    for (let i = 0; i < N; i++) {
      if (fg[i]) fixed[i] = 1;
      else if (bg[i]) fixed[i] = 0;
      else if (nearStroke?.[i]) fixed[i] = -1;
      else if (inner[i]) fixed[i] = 1;
      else if (!outer[i]) fixed[i] = 0;
    }
    // colour samples: the predicted inside / outside a little away from the edge, plus the strokes
    const fgS: number[] = [], bgS: number[] = [];
    const fin = morph(pred, w, h, -2), fout = morph(pred, w, h, 2);
    const local = o.altColor ? morph(outer, w, h, R * 2) : null;
    for (let i = 0; i < N; i++) {
      if (local && !local[i]) continue;
      if (fg[i] || (fin[i] && !bg[i])) fgS.push(i);
      else if (bg[i] || !fout[i]) bgS.push(i);
    }
    const k = best ? 8 : 5;
    const band = new Uint8Array(N);
    for (let i = 0; i < N; i++) band[i] = fixed[i] < 0 ? 1 : 0;
    const cp = colorProb(img, colorModel(img, fgS, k), colorModel(img, bgS, k), band);
    const shape = blurF(Float32Array.from(pred), w, h, Math.max(1, R / 4));
    prior = new Float32Array(N);
    for (let i = 0; i < N; i++) prior[i] = (1 - ew.shape) * cp[i] + ew.shape * shape[i];
    for (let i = 0; i < N; i++) if (nearStroke?.[i] && fixed[i] < 0) prior[i] = cp[i];
    gamma = ew.gamma;
    x0 = shape;
  }
  const x = randomWalker(img, fixed, prior, gamma, x0, best ? 400 : 250);
  let m: Uint8Array = new Uint8Array(N);
  for (let i = 0; i < N; i++) m[i] = x[i] >= 0.5 ? 1 : 0;
  // islands of foreground with no stroke or sure inside are dropped; tiny holes filled
  m = keepConnected(m, w, h, 1, (i) => fixed[i] === 1);
  m = fillSmallHoles(m, w, h, Math.max(4, Math.round(N * 0.0015)));
  return m;
}
const orMask = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] | b[i]; return o; };
function borderIdx(w: number, h: number): number[] { const o: number[] = []; for (let x = 0; x < w; x++) o.push(x, (h - 1) * w + x); for (let y = 1; y < h - 1; y++) o.push(y * w, y * w + w - 1); return o; }

// ───────────────────────── motion between frames ─────────────────────────
export const toGray = (img: Img) => { const g = new Uint8Array(img.w * img.h); for (let i = 0; i < g.length; i++) g[i] = (img.d[i * 3] * 77 + img.d[i * 3 + 1] * 150 + img.d[i * 3 + 2] * 29) >> 8; return g; };
/** Affine [a b c; d e f] (x' = a x + b y + c) moving the matte's subject from gray frame A to B, or null. */
export function subjectMotion(A: Uint8Array, B: Uint8Array, w: number, h: number, mask: Uint8Array): number[] | null {
  const inner = morph(mask, w, h, -2);
  let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
  for (let i = 0; i < inner.length; i++) if (inner[i]) { const x = i % w, y = (i / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); area++; }
  if (area < 9) return null;
  // the most textured spots of a grid over the subject
  const r = Math.max(2, Math.round(w / 160)), cells = 7, pts: [number, number][] = [];
  const m = r * 3;
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
    const ax = Math.max(m, Math.floor(x0 + ((x1 - x0) * cx) / cells)), bx = Math.min(w - m, Math.floor(x0 + ((x1 - x0) * (cx + 1)) / cells));
    const ay = Math.max(m, Math.floor(y0 + ((y1 - y0) * cy) / cells)), by = Math.min(h - m, Math.floor(y0 + ((y1 - y0) * (cy + 1)) / cells));
    let best = 0, px = -1, py = -1;
    for (let y = ay; y < by; y += 2) for (let x = ax; x < bx; x += 2) { if (!inner[y * w + x]) continue; const t = textureAt(A, w, h, x, y, r); if (t > best) { best = t; px = x; py = y; } }
    if (px >= 0 && best >= 1.5) pts.push([px, py]);
  }
  if (pts.length < 3) return null;
  const tr = trackFrames([A, B], w, h, pts, Math.max(4, Math.round(w / 60)), Math.max(8, Math.round(w / 10)));
  let P: [number, number][] = [], Q: [number, number][] = [];
  tr.forEach((t, k) => { if (t.conf[1] >= 0.55) { P.push(pts[k]); Q.push(t.pts[1]); } });
  if (P.length < 2) return null;
  if (P.length < 4) {
    // translation only
    let dx = 0, dy = 0;
    P.forEach((p, k) => { dx += (Q[k][0] - p[0]) / P.length; dy += (Q[k][1] - p[1]) / P.length; });
    return [1, 0, dx, 0, 1, dy];
  }
  // least-squares affine, twice, dropping the points far from the first fit
  let Afit = fitAffine(P, Q);
  for (let pass = 0; pass < 2 && Afit; pass++) {
    const res = P.map((p, k) => Math.hypot(Afit![0] * p[0] + Afit![1] * p[1] + Afit![2] - Q[k][0], Afit![3] * p[0] + Afit![4] * p[1] + Afit![5] - Q[k][1]));
    const med = [...res].sort((a, b) => a - b)[Math.floor(res.length / 2)], tol = Math.max(1, med * 2.5);
    const keep = res.map((v, k) => (v <= tol ? k : -1)).filter((k) => k >= 0);
    if (keep.length < 4 || keep.length === P.length) break;
    P = keep.map((k) => P[k]); Q = keep.map((k) => Q[k]);
    Afit = fitAffine(P, Q);
  }
  if (!Afit) return null;
  // limit to a plausible motion (no flips, scale 0.5…2)
  const det = Afit[0] * Afit[4] - Afit[1] * Afit[3];
  if (!(det > 0.25 && det < 4)) { let dx = 0, dy = 0; P.forEach((p, k) => { dx += (Q[k][0] - p[0]) / P.length; dy += (Q[k][1] - p[1]) / P.length; }); return [1, 0, dx, 0, 1, dy]; }
  return Afit;
}
export function fitAffine(P: [number, number][], Q: [number, number][]): number[] | null {
  // normal equations of [x y 1]·[a b c]ᵀ = x', same for y'
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0], bx = [0, 0, 0], by = [0, 0, 0];
  P.forEach(([x, y], k) => { const v = [x, y, 1]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) M[i * 3 + j] += v[i] * v[j]; bx[i] += v[i] * Q[k][0]; by[i] += v[i] * Q[k][1]; } });
  const inv = inv3(M);
  if (!inv) return null;
  const sol = (b: number[]) => [0, 1, 2].map((i) => inv[i * 3] * b[0] + inv[i * 3 + 1] * b[1] + inv[i * 3 + 2] * b[2]);
  return [...sol(bx), ...sol(by)];
}
function inv3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
/** Motion Threshold / Motion Damping: displacements under the threshold (px) are damped (0…1). */
export function dampMotion(A: number[], w: number, h: number, threshold: number, damping: number): number[] {
  if (damping <= 0) return A;
  // the largest displacement the affine gives over the frame's corners and centre
  const pts = [[0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2]];
  const mag = Math.max(...pts.map(([x, y]) => Math.hypot(A[0] * x + A[1] * y + A[2] - x, A[3] * x + A[4] * y + A[5] - y)));
  if (mag >= threshold) return A;
  const k = 1 - Math.min(1, damping);
  return [1 + (A[0] - 1) * k, A[1] * k, A[2] * k, A[3] * k, 1 + (A[4] - 1) * k, A[5] * k];
}
/** A mask moved by an affine (nearest neighbour, by inverse mapping). */
export function warpMask(m: Uint8Array, w: number, h: number, A: number[] | null): Uint8Array {
  if (!A) return m.slice();
  const det = A[0] * A[4] - A[1] * A[3];
  if (Math.abs(det) < 1e-9) return m.slice();
  const ia = A[4] / det, ib = -A[1] / det, id = -A[3] / det, ie = A[0] / det;
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x - A[2], Y = y - A[5], sx = Math.round(ia * X + ib * Y), sy = Math.round(id * X + ie * Y);
    if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = m[sy * w + sx];
  }
  return out;
}
/** Region round the matte's edge (the painted Refine Edge region must lie on an alpha edge). */
export function edgeBand(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const a = morph(m, w, h, r), b = morph(m, w, h, -r), o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) o[i] = a[i] && !b[i] ? 1 : 0;
  return o;
}
