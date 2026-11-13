// Content-Aware Fill («Relleno según el contenido»): the transparent areas of a footage layer — made by its masks
// (usually one in Subtract mode, as in After Effects) and by a Roto Brush matte — are filled over time and the result
// is rendered as a new image sequence (PNG, in a «Rellenos» folder next to the project) placed above the layer as
// «Rellenar …», like AE's «Generar capa de relleno». All local and free:
//  · Object: every hole pixel is looked for in the other frames (nearest first), where the background — aligned by a
//    homography fitted to points tracked outside the hole — showed it; reference frames come first; what no frame
//    ever saw is made up by patch-based completion (inpaint.ts), seeded with the previous frame's fill so it holds still.
//  · Surface: one frame (a reference frame, else the middle one) is filled and that fill rides the background's motion
//    through the range (one consistent surface).
//  · Edge Blend: a smooth membrane from the hole's border (fast; for plain surfaces).
// Lighting Correction (Subtle / Moderate / Strong) matches each borrowed patch's colours to the ring round the hole.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Editor } from './ops';
import { runFfmpeg } from './ffmpeg';
import { cacheDir } from './graphics';
import { encodePng } from './png';
import { findComp, findLayer, valueAt, flattenBezier, rleDecode, type Comp, type Layer } from './motion';
import { motionOps } from './motion/ops';
import { ransacHomography, trackFrames } from './tracker';
import { detectFeatures } from './warpstab-analyze';
import { rgbFrames } from './roto-analyze';
import { inpaint, laplaceFill, type FImg } from './inpaint';
import { morph, toGray } from './segment';

export type CafMethod = 'object' | 'surface' | 'edge';
export const CAF_METHODS: [CafMethod, string][] = [['object', 'Objeto'], ['surface', 'Superficie'], ['edge', 'Fusión de borde']];
export const CAF_LIGHTING: [string, string][] = [['subtle', 'Sutil'], ['moderate', 'Moderar'], ['strong', 'Fuerte']];
export const CAF_RANGES: [string, string][] = [['workArea', 'Entorno de trabajo'], ['all', 'Toda la duración']];
export const REF_LAYER_NAME = 'Fotograma de referencia';
const LIGHT_K: Record<string, number> = { subtle: 0.35, moderate: 0.7, strong: 1 };

export interface CafOptions {
  method?: CafMethod;
  /** Corrección de la luz: off when absent */
  lighting?: 'subtle' | 'moderate' | 'strong' | null;
  /** Expansión de alfa (layer px; negative shrinks) */
  expansion?: number;
  range?: 'workArea' | 'all' | [number, number];
  signal?: AbortSignal;
  onProgress?: (msg: string, frac: number) => void;
}

// ───────────────────────── the hole ─────────────────────────
/** Even–odd scanline fill of a polygon (flat x, y …) into a 0/1 mask (pixel centres). */
export function fillPolygon(out: Uint8Array, w: number, h: number, pts: number[]) {
  const n = pts.length / 2;
  if (n < 3) return;
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = pts[i * 2 + 1], yj = pts[j * 2 + 1];
      if ((yi > yc) !== (yj > yc)) xs.push(pts[i * 2] + ((yc - yi) * (pts[j * 2] - pts[i * 2])) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) out[y * w + x] = 1;
  }
}
/** The layer's alpha from its masks (and Roto Brush matte) at comp time t, at w×h over the layer's W×H: 1 = opaque. */
export function layerCoverage(comp: Comp, l: Layer, t: number, w: number, h: number, W: number, H: number): Uint8Array {
  const sx = w / W, sy = h / H, N = w * h;
  const act = l.masks.filter((m) => m.mode !== 'none');
  let M = new Uint8Array(N).fill(act.length && act[0].mode !== 'subtract' ? 0 : 1);
  for (const m of act) {
    const ev = (k: string) => valueAt((m as unknown as Record<string, never>)[k], t, { comp, layer: l, path: `masks.${m.id}.${k}` });
    if (Number(ev('opacity') ?? 100) < 50) continue;
    const flat = ev('path') as unknown as number[];
    const pts = flattenBezier(Array.isArray(flat) ? flat : [], true).map((v, i) => (i % 2 ? v * sy : v * sx));
    let s: Uint8Array = new Uint8Array(N);
    fillPolygon(s, w, h, pts);
    const exp = Number(ev('expansion') ?? 0) * sx;
    if (Math.abs(exp) >= 0.5) s = morph(s, w, h, exp);
    if (m.inverted) s = s.map((v) => 1 - v);
    for (let i = 0; i < N; i++) {
      const a = M[i], b = s[i];
      const md = m.mode as string;
      M[i] = md === 'add' || md === 'lighten' ? a | b : md === 'subtract' ? a & (1 - b) : md === 'intersect' || md === 'darken' ? a & b : md === 'difference' ? a ^ b : a;
    }
  }
  // a Roto Brush matte cuts the layer too
  const f = l.effects.find((x) => x.fx === 'rotoBrush' && x.on);
  const seg = f?.roto?.seg;
  if (f && seg && f.roto?.strokes.length) {
    const st = (t - l.start) / (l.stretch || 1), i = seg.n === 1 ? 0 : Math.round((st - seg.t0) * seg.fps);
    const inv = !!Number(f.params.invert?.v ?? 0);
    const m = i >= 0 && i < seg.n && seg.m[i] ? rleDecode(seg.m[i]!, seg.w * seg.h) : null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const mx = Math.min(seg.w - 1, Math.floor(((x + 0.5) / w) * seg.w)), my = Math.min(seg.h - 1, Math.floor(((y + 0.5) / h) * seg.h));
      let v = m ? m[my * seg.w + mx] : 0;
      if (inv) v = 1 - v;
      M[y * w + x] &= v;
    }
  }
  return M;
}

// ───────────────────────── geometry between frames ─────────────────────────
type H3 = number[];
const I3: H3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul = (a: H3, b: H3): H3 => Array.from({ length: 9 }, (_, i) => { const r = Math.floor(i / 3), c = i % 3; return a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; });
function inv(m: H3): H3 {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
/** Background motion from gray frame A to B (pixels of the holes left out): a homography, identity when unsure. */
export function backgroundMotion(A: Uint8Array, B: Uint8Array, w: number, h: number, holeA: Uint8Array): H3 {
  const r = Math.max(3, Math.round(w / 120)), avoid = morph(holeA, w, h, r * 4);
  const pts = detectFeatures(A, w, h, 10, 7, r).filter(([x, y]) => !avoid[Math.round(y) * w + Math.round(x)]);
  if (pts.length < 8) return I3;
  const tr = trackFrames([A, B], w, h, pts, Math.max(4, Math.round(w / 80)), Math.max(6, Math.round(w / 14)));
  const P: [number, number][] = [], Q: [number, number][] = [];
  tr.forEach((t, k) => { if (t.conf[1] >= 0.6) { P.push(pts[k]); Q.push(t.pts[1]); } });
  if (P.length < 6) return I3;
  const R = ransacHomography(P, Q, 1.5, 200);
  if (!R || R.inliers < 6) return I3;
  return R.H.map((v) => v / R.H[8]);
}

// ───────────────────────── filling ─────────────────────────
interface Frame { img: Uint8Array; hole: Uint8Array }
const sample = (d: Uint8Array | Float32Array, w: number, h: number, x: number, y: number, c: number) => {
  const xi = Math.max(0, Math.min(w - 2, Math.floor(x))), yi = Math.max(0, Math.min(h - 2, Math.floor(y))), u = Math.max(0, Math.min(1, x - xi)), v = Math.max(0, Math.min(1, y - yi)), i = (yi * w + xi) * 3 + c;
  return (d[i] * (1 - u) + d[i + 3] * u) * (1 - v) + (d[i + w * 3] * (1 - u) + d[i + w * 3 + 3] * u) * v;
};
/** Ring round the hole (for lighting correction): pixels within r of the hole but outside it. */
const ringOf = (hole: Uint8Array, w: number, h: number, r: number) => { const d = morph(hole, w, h, r); const o: number[] = []; for (let i = 0; i < hole.length; i++) if (d[i] && !hole[i]) o.push(i); return o; };

/**
 * Fills the holes of a run of frames (w×h RGB, hole 1 = to fill); refs: frames without holes (reference frames) at
 * frame indexes. Returns the filled frames (float RGB).
 */
export function fillFrames(frames: Frame[], w: number, h: number, o: { method: CafMethod; lighting?: string | null; refs?: { at: number; img: Uint8Array }[]; motion?: H3[]; onFrame?: (i: number) => void; /** fill only this frame (the others are sources) */ only?: number }): Float32Array[] {
  const n = frames.length, N = w * h;
  // cumulative background motion: C[k] maps frame 0 → frame k
  const C: H3[] = [I3];
  for (let k = 1; k < n; k++) C.push(mul(o.motion?.[k] ?? I3, C[k - 1]));
  const map = (from: number, to: number) => mul(C[to], inv(C[from]));
  const lk = o.lighting ? LIGHT_K[o.lighting] ?? 0 : 0;
  const ap = (H: H3, x: number, y: number): [number, number] => { const z = H[6] * x + H[7] * y + H[8] || 1e-12; return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z]; };
  const out: Float32Array[] = [];
  const holeSafe = frames.map((f) => morph(f.hole, w, h, 1));
  /** colours of a source frame at the target's pixels, matched to the target's ring when lighting correction is on */
  const borrow = (t: number, src: Uint8Array, srcHole: Uint8Array | null, s: number, img: Float32Array, todo: Uint8Array, ring: number[]) => {
    const H = map(t, s);
    let gain = [1, 1, 1];
    if (lk > 0 && ring.length) {
      const a = [0, 0, 0], b = [0, 0, 0];
      let cnt = 0;
      for (const i of ring) { const [X, Y] = ap(H, i % w, (i / w) | 0); if (X < 0 || Y < 0 || X > w - 1 || Y > h - 1) continue; cnt++; for (let c = 0; c < 3; c++) { a[c] += frames[t].img[i * 3 + c]; b[c] += sample(src, w, h, X, Y, c); } }
      if (cnt > 8) gain = a.map((v, c) => 1 + (Math.max(0.5, Math.min(2, (v + 1) / (b[c] + 1))) - 1) * lk);
    }
    let got = 0;
    for (let i = 0; i < N; i++) {
      if (!todo[i]) continue;
      const [X, Y] = ap(H, i % w, (i / w) | 0);
      if (X < 0 || Y < 0 || X > w - 1 || Y > h - 1) continue;
      if (srcHole && srcHole[Math.round(Y) * w + Math.round(X)]) continue;
      for (let c = 0; c < 3; c++) img[i * 3 + c] = Math.max(0, Math.min(255, sample(src, w, h, X, Y, c) * gain[c]));
      todo[i] = 0; got++;
    }
    return got;
  };
  const objectFill = (t: number, prev: Float32Array | null): Float32Array => {
    const f = frames[t], img = Float32Array.from(f.img), todo = f.hole.slice();
    if (!todo.some((v) => v)) return img;
    const ring = lk > 0 ? ringOf(f.hole, w, h, 4) : [];
    // reference frames first (nearest), then the other frames outwards
    for (const r of [...(o.refs ?? [])].sort((a, b) => Math.abs(a.at - t) - Math.abs(b.at - t))) borrow(t, r.img, null, Math.max(0, Math.min(n - 1, r.at)), img, todo, ring);
    for (let d = 1; d < n && todo.some((v) => v); d++) for (const s of [t - d, t + d]) if (s >= 0 && s < n) borrow(t, frames[s].img, holeSafe[s], s, img, todo, ring);
    if (todo.some((v) => v)) {
      // never seen: patch-based completion, starting from the previous fill (steady) or the membrane
      let prior: Float32Array | null = null;
      if (prev && t > 0) {
        prior = Float32Array.from(img);
        const H = map(t, t - 1);
        for (let i = 0; i < N; i++) if (todo[i]) { const [X, Y] = ap(H, i % w, (i / w) | 0); for (let c = 0; c < 3; c++) prior[i * 3 + c] = sample(prev, w, h, X, Y, c); }
      }
      const fi: FImg = { w, h, d: img };
      inpaint(fi, todo, { prior, iterations: prior ? 2 : undefined, seed: 1000 + t });
    }
    return img;
  };
  if (o.method === 'edge') {
    for (let t = 0; t < n; t++) { const img = Float32Array.from(frames[t].img); laplaceFill({ w, h, d: img }, frames[t].hole); out.push(img); o.onFrame?.(t); }
    return out;
  }
  if (o.method === 'surface') {
    // the key frame: a reference frame, else the middle; its fill then rides the background's motion
    const key = o.refs?.length ? Math.max(0, Math.min(n - 1, o.refs[0].at)) : Math.floor(n / 2);
    const keyImg = o.refs?.length ? Float32Array.from(o.refs[0].img) : objectFill(key, null);
    const keyU8 = Uint8Array.from(keyImg, (v) => Math.round(v));
    for (let t = 0; t < n; t++) {
      const f = frames[t], img = Float32Array.from(f.img), todo = f.hole.slice();
      if (todo.some((v) => v)) {
        borrow(t, keyU8, null, key, img, todo, lk > 0 ? ringOf(f.hole, w, h, 4) : []);
        if (todo.some((v) => v)) inpaint({ w, h, d: img }, todo, { seed: 2000 + t });
      }
      out.push(img); o.onFrame?.(t);
    }
    return out;
  }
  if (o.only !== undefined) return frames.map((f, t) => (t === o.only ? objectFill(t, null) : Float32Array.from(f.img)));
  let prev: Float32Array | null = null;
  for (let t = 0; t < n; t++) { const img = objectFill(t, prev); out.push(img); prev = img; o.onFrame?.(t); }
  return out;
}

// ───────────────────────── the job ─────────────────────────
export interface CafTarget { comp: Comp; layer: Layer; path: string; still: boolean; W: number; H: number; from: number; to: number; fps: number; count: number }
export function cafTarget(project: { media: { id: string; path: string; kind?: string; width?: number; height?: number }[]; comps?: Comp[] }, compId: string, layerId: string, range: CafOptions['range'] = 'workArea'): CafTarget {
  const c = findComp(project.comps, compId), l = findLayer(c, layerId);
  if (l.type !== 'video' && l.type !== 'image') throw new Error('Relleno según el contenido: elija una capa de metraje (vídeo o imagen) con un área transparente (por ejemplo, una máscara en modo Restar).');
  if (l.timeRemap) throw new Error('Relleno según el contenido no admite capas con reasignación de tiempo.');
  const m = project.media.find((x) => x.id === l.mediaId);
  if (!m?.path || !m.width || !m.height) throw new Error('No se encuentra el metraje de la capa.');
  const [a0, b0] = Array.isArray(range) ? range : range === 'all' ? [0, c.duration] : (c.workArea ?? [0, c.duration]);
  const from = Math.max(a0, l.in), to = Math.min(b0, l.out);
  if (to - from < 1 / c.fps / 2) throw new Error('La capa no está en el rango elegido.');
  const count = Math.max(1, Math.min(1800, Math.round((to - from) * c.fps)));
  return { comp: c, layer: l, path: m.path, still: m.kind === 'image', W: m.width, H: m.height, from, to: from + count / c.fps, fps: c.fps, count };
}
/** Working size of the fill: ≤ 640 px on the long side. */
const cafSize = (W: number, H: number): [number, number] => { const k = Math.min(1, 640 / Math.max(W, H)); return [Math.max(16, Math.round(W * k)), Math.max(16, Math.round(H * k))]; };

async function readRange(T: CafTarget, w: number, h: number, signal?: AbortSignal) {
  const st = (T.from - T.layer.start) / (T.layer.stretch || 1);
  const imgs = await rgbFrames(T.path, Math.max(0, st), T.count, T.fps / (T.layer.stretch || 1), w, h, T.still, signal);
  if (!imgs.length) throw new Error('No se pudieron leer fotogramas del metraje de la capa.');
  return Array.from({ length: T.count }, (_, k) => imgs[Math.min(imgs.length - 1, k)]);
}
/** Reference frame layers of the comp (image layers named «Fotograma de referencia…», visible) as frames of the range. */
async function readRefs(T: CafTarget, project: { media: { id: string; path: string }[] }, w: number, h: number) {
  const out: { at: number; img: Uint8Array }[] = [];
  for (const r of T.comp.layers) {
    if (r.type !== 'image' || r.hidden || !r.name.startsWith(REF_LAYER_NAME) || r.id === T.layer.id) continue;
    const m = project.media.find((x) => x.id === r.mediaId);
    if (!m) continue;
    const at = Math.round((r.in - T.from) * T.fps);
    const [img] = await rgbFrames(m.path, 0, 1, T.fps, w, h, true);
    if (img) out.push({ at, img });
  }
  return out;
}
const encodeFrame = (fill: Float32Array, hole: Uint8Array, w: number, h: number, W: number, H: number, opaque: Uint8Array | null) => {
  // fill enlarged to the layer's size; alpha: the hole (smooth edge) or opaque
  const holeF = Float32Array.from(hole);
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = ((x + 0.5) / W) * w - 0.5, fy = ((y + 0.5) / H) * h - 0.5, o = (y * W + x) * 4;
    const a = opaque ? 1 : (() => { const xi = Math.max(0, Math.min(w - 2, Math.floor(fx))), yi = Math.max(0, Math.min(h - 2, Math.floor(fy))), u = Math.max(0, Math.min(1, fx - xi)), v = Math.max(0, Math.min(1, fy - yi)), i = yi * w + xi; return (holeF[i] * (1 - u) + holeF[i + 1] * u) * (1 - v) + (holeF[i + w] * (1 - u) + holeF[i + w + 1] * u) * v; })();
    if (opaque) { const i = o; px[i] = opaque[i]; px[i + 1] = opaque[i + 1]; px[i + 2] = opaque[i + 2]; px[i + 3] = 255; }
    if (a <= 0) continue;
    if (!opaque || a > 0) {
      const k = opaque ? Math.min(1, a) : 1;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(px[o + c] * (1 - (opaque ? k : 1)) + sample(fill, w, h, fx, fy, c) * (opaque ? k : 1));
      if (!opaque) px[o + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return encodePng(W, H, px);
};
function outDir(e: Editor, name: string): string {
  const base = e.path ? join(dirname(e.path), 'Rellenos') : cacheDir('rellenos');
  for (let i = 1; ; i++) { const d = join(base, `${name}_${i}`); try { mkdirSync(d, { recursive: false }); return d; } catch { if (i > 999) throw new Error('CAF: No se puede crear el archivo de imágenes de relleno.'); mkdirSync(base, { recursive: true }); } }
}
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'Capa';
/** A new layer above the target with its transform (the fill lines up with it), spanning [from, to]. */
function placeAbove(e: Editor, T: CafTarget, mediaId: string, type: 'video' | 'image', name: string, from: number, to: number) {
  const idx = T.comp.layers.findIndex((x) => x.id === T.layer.id);
  const nl = motionOps.layerAdd(e, T.comp.id, type, { mediaId, name, start: from, duration: to - from, index: Math.max(0, idx) });
  e.mutate('Generar capa de relleno', (p) => {
    const c = findComp((p as unknown as { comps?: Comp[] }).comps, T.comp.id), src = findLayer(c, T.layer.id), l = findLayer(c, nl.id);
    l.transform = JSON.parse(JSON.stringify(src.transform));
    if (src.parent) l.parent = src.parent;
    l.threeD = src.threeD;
    l.start = from; l.in = from; l.out = to; l.stretch = 1;
    // right above the target
    c.layers.splice(c.layers.indexOf(l), 1);
    c.layers.splice(c.layers.indexOf(src), 0, l);
  });
  return nl;
}

/** «Generar capa de relleno»: fills the layer's transparent areas over the range and adds the fill layer above it. */
export async function contentAwareFill(e: Editor, compId: string, layerId: string, o: CafOptions = {}): Promise<{ layer: { id: string; name: string }; media: string; frames: number; folder: string; holePixels: number; seconds: number }> {
  const t0 = Date.now(), method = o.method ?? 'object';
  const T = cafTarget(e.project as never, compId, layerId, o.range);
  const [w, h] = cafSize(T.W, T.H);
  o.onProgress?.('Analizando (0%)…', 0);
  const imgs = await readRange(T, w, h, o.signal);
  const exp = (o.expansion ?? 5) * (w / T.W);
  const frames: Frame[] = imgs.map((img, k) => {
    const cov = layerCoverage(T.comp, T.layer, T.from + k / T.fps, w, h, T.W, T.H);
    let hole: Uint8Array = cov.map((v) => 1 - v);
    if (Math.abs(exp) >= 0.5) hole = morph(hole, w, h, exp);
    return { img, hole };
  });
  const holePixels = frames.reduce((s, f) => s + f.hole.reduce((a, v) => a + v, 0), 0);
  if (!holePixels) throw new Error('Todos los fotogramas de destino son completamente opacos (no hay huecos para rellenar). La generación de la capa de relleno sensible al contenido se ha cancelado.');
  const refs = await readRefs(T, e.project as never, w, h);
  // background motion between consecutive frames
  const motion: H3[] = [I3];
  if (method !== 'edge' && !T.still) {
    const grays = imgs.map((d) => toGray({ w, h, d }));
    for (let k = 1; k < frames.length; k++) {
      if (o.signal?.aborted) throw new Error('Error de relleno sensible al contenido: interrupción del usuario');
      motion.push(backgroundMotion(grays[k - 1], grays[k], w, h, frames[k - 1].hole));
      o.onProgress?.(`Analizando (${Math.round((k / frames.length) * 100)}%)…`, (k / frames.length) * 0.3);
    }
  } else for (let k = 1; k < frames.length; k++) motion.push(I3);
  const fills = fillFrames(frames, w, h, {
    method, lighting: o.lighting ?? null, refs, motion,
    onFrame: (k) => { if (o.signal?.aborted) throw new Error('Error de relleno sensible al contenido: interrupción del usuario'); o.onProgress?.(`Procesando (${k + 1} de ${frames.length})...`, 0.3 + (0.6 * (k + 1)) / frames.length); },
  });
  // the image sequence (PNG) and a movie of it with alpha for playback
  const dir = outDir(e, safeName(T.layer.name));
  try {
    fills.forEach((f, k) => writeFileSync(join(dir, `${safeName(T.layer.name)}_${String(k).padStart(5, '0')}.png`), encodeFrame(f, frames[k].hole, w, h, T.W, T.H, null)));
    o.onProgress?.('Generando imágenes de relleno', 0.95);
    const movie = join(dir, `Rellenar ${safeName(T.layer.name)}.webm`);
    await runFfmpeg(['-y', '-framerate', String(T.fps), '-i', join(dir, `${safeName(T.layer.name)}_%05d.png`), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '12', '-b:v', '0', '-auto-alt-ref', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', movie], { signal: o.signal });
    const [m] = await e.importMedia([movie]);
    const name = `Rellenar ${T.layer.name}`;
    const nl = placeAbove(e, T, m.id, 'video', name, T.from, T.to);
    o.onProgress?.('Generar capa de relleno', 1);
    return { layer: { id: nl.id, name }, media: m.id, frames: fills.length, folder: dir, holePixels, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (err) {
    if (o.signal?.aborted) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** «Crear fotograma de referencia»: the frame at comp time t, filled (Object method), at the layer's full size, as a
 *  one-frame image layer «Fotograma de referencia» above the target (edit it in an image editor, then generate). */
export async function cafReferenceFrame(e: Editor, compId: string, layerId: string, t: number, o: CafOptions = {}): Promise<{ layer: { id: string; name: string }; file: string }> {
  const T0 = cafTarget(e.project as never, compId, layerId, 'all');
  const fps = T0.fps, k0 = Math.round((t - T0.from) * fps);
  if (k0 < 0 || k0 >= T0.count) throw new Error('El instante actual está fuera de la capa.');
  // a window of frames round t gives the fill
  const a = Math.max(0, k0 - 30), b = Math.min(T0.count, k0 + 31);
  const T: CafTarget = { ...T0, from: T0.from + a / fps, count: b - a, to: T0.from + b / fps };
  const [w, h] = cafSize(T.W, T.H);
  const imgs = await readRange(T, w, h, o.signal);
  const exp = (o.expansion ?? 5) * (w / T.W);
  const frames: Frame[] = imgs.map((img, k) => { let hole: Uint8Array = layerCoverage(T.comp, T.layer, T.from + k / fps, w, h, T.W, T.H).map((v) => 1 - v); if (Math.abs(exp) >= 0.5) hole = morph(hole, w, h, exp); return { img, hole }; });
  const motion: H3[] = [I3];
  const grays = imgs.map((d) => toGray({ w, h, d }));
  for (let k = 1; k < frames.length; k++) motion.push(T.still ? I3 : backgroundMotion(grays[k - 1], grays[k], w, h, frames[k - 1].hole));
  // only the frame at t is needed: fill it alone with its neighbours as sources
  const at = k0 - a;
  const fills = fillFrames(frames, w, h, { method: o.method === 'edge' ? 'edge' : 'object', lighting: o.lighting ?? null, motion, only: o.method === 'edge' ? undefined : at }).slice(at, at + 1);
  const st = (T0.from + k0 / fps - T.layer.start) / (T.layer.stretch || 1);
  const [full] = await rgbFrames(T.path, Math.max(0, st), 1, fps, T.W, T.H, T.still);
  const rgba = new Uint8Array(T.W * T.H * 4);
  for (let i = 0; i < T.W * T.H; i++) { rgba[i * 4] = full[i * 3]; rgba[i * 4 + 1] = full[i * 3 + 1]; rgba[i * 4 + 2] = full[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
  const dir = outDir(e, `${safeName(T.layer.name)}_ref`);
  const file = join(dir, `${REF_LAYER_NAME} ${safeName(T.layer.name)} ${k0}.png`);
  writeFileSync(file, encodeFrame(fills[0], frames[at].hole, w, h, T.W, T.H, rgba));
  const [m] = await e.importMedia([file]);
  const tt = T0.from + k0 / fps;
  const nl = placeAbove(e, T, m.id, 'image', `${REF_LAYER_NAME} ${k0}`, tt, tt + 1 / fps);
  return { layer: { id: nl.id, name: `${REF_LAYER_NAME} ${k0}` }, file };
}
