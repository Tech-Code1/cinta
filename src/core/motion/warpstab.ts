// Warp Stabilizer (After Effects' «Estabilizador de deformación», ADBE SubspaceStabilizer): the footage is analysed
// once (feature points tracked between consecutive frames, a robust motion model fitted per pair — see
// src/core/warpstab-analyze.ts) and the result is kept in the effect; everything else is computed here, at render
// time, from that analysis: the camera path for the chosen Method, its smoothing (Smooth Motion / No Motion), the
// correction per frame, the framing (crop, auto-scale) and the local mesh of Subspace Warp.
//
// Parameters, defaults and ranges follow AE's Stabilizer: Smoothness 50 (0…1000, slider 0…100),
// Method Subspace Warp, Framing Stabilize, Crop, Auto-scale, Maximum Scale 150 % (100…10000), Action-safe Margin 0 %
// (0…100), Additional Scale 100 %, Crop Less <-> Smooth More 50, Synthesis Input Range 0.5 s, Synthesis Edge
// Feather 10, Synthesis Edge Cropping 0 on every side. Names from AE's Spanish interface.
//
// Coordinates of the analysis are normalised: u = (x − W/2) / W, v = (y − H/2) / W (W, H: the layer's size), so the
// same data serves any working resolution.
import type { FxDef } from './effects';
import { n, pc, bo, ch } from './fxparams';

export const WS_RESULT: [string, string][] = [['smooth', 'Suavizar movimiento'], ['none', 'Sin movimiento']];
export const WS_METHOD: [string, string][] = [['position', 'Posición'], ['similarity', 'Posición, Escala, Rotación'], ['perspective', 'Perspectiva'], ['subspace', 'Deformación de subespacio']];
export const WS_FRAMING: [string, string][] = [['stabilize', 'Sólo estabilizar'], ['crop', 'Estabilizar, Recortar'], ['cropScale', 'Estabilizar, Recortar, Escala automática'], ['synth', 'Estabilizar, Sintentizar bordes']];
export const WS_ROLLING: [string, string][] = [['auto', 'Reducción automática'], ['enhanced', 'Reducción mejorada']];

export const FX_ANALISIS: FxDef[] = [
  // still: a layer that is not footage is left as it is (the analysis reads the layer's video)
  { id: 'warpStabilizer', name: 'Estabilizador de deformación', cat: 'Distorsionar', still: true, params: [
    // Estabilización
    ch('result', 'Estabilización: resultado', WS_RESULT, 'smooth'), n('smoothness', 'Estabilización: suavidad (%)', 50, 0, 1000),
    ch('method', 'Estabilización: método', WS_METHOD, 'subspace'), bo('preserveScale', 'Estabilización: conservar escala'),
    // Bordes
    ch('framing', 'Bordes: encuadre', WS_FRAMING, 'cropScale'), n('maxScale', 'Bordes: escala automática: escala máxima (%)', 150, 100, 10000),
    n('actionSafe', 'Bordes: escala automática: margen seguro para acción (%)', 0, 0, 100), n('additionalScale', 'Bordes: escala adicional (%)', 100, 0, 10000),
    // Avanzadas
    bo('detailed', 'Avanzadas: análisis detallado'), ch('rollingShutter', 'Avanzadas: ondulación de obtur. de desplaz.', WS_ROLLING, 'auto'),
    n('cropSmooth', 'Avanzadas: recortar menos <-> suavizar más', 50, 0, 100), n('synthRange', 'Avanzadas: rango entrada síntesis (seg.)', 0.5, 0, 999),
    n('synthFeather', 'Avanzadas: calado de borde de síntesis', 10, 0, 999),
    n('synthCropLeft', 'Avanzadas: recorte de borde de síntesis: izquierda', 0, 0, 999), n('synthCropTop', 'Avanzadas: recorte de borde de síntesis: superior', 0, 0, 999),
    n('synthCropRight', 'Avanzadas: recorte de borde de síntesis: derecha', 0, 0, 999), n('synthCropBottom', 'Avanzadas: recorte de borde de síntesis: inferior', 0, 0, 999),
    bo('hideWarning', 'Avanzadas: ocultar advertencia'),
    // Objetos: puntos de seguimiento
    bo('showPoints', 'Avanzadas: mostrar puntos de seguimiento'), pc('pointSize', 'Avanzadas: tamaño del punto de seguimiento', 100, 1, 500),
    bo('autoDelete', 'Avanzadas: eliminar puntos autom. en tiempo', true),
  ] },
];
/** parameters that only change the stabilisation (step 2), not the analysis */
export const WS_ANALYSIS_PARAMS = ['detailed'];

// ───────────────────────── analysis data ─────────────────────────
export interface StabData {
  v: 1;
  /** what was analysed (see stabKey): a different key means the analysis is stale */
  key: string;
  /** layer aspect H / W */
  aspect: number;
  /** source time of frame 0 and frames per second of the analysis */
  t0: number;
  fps: number;
  n: number;
  /** per frame i, the motion from frame i−1 to i (frame 0: none): translation [du, dv] … */
  tr: number[];
  /** … similarity [a, b, tu, tv] (q = [a −b; b a]·p + t) … */
  sim: number[];
  /** … homography (8 numbers, h33 = 1) … */
  hom: number[];
  /** … and what is left at each mesh node once the homography is taken out (gx × gy × [du, dv]) */
  grid: [number, number];
  mesh: number[];
  /** track points found in each frame (normalised, flat u, v …) */
  pts: number[][];
  /** points per frame that agreed with the motion (for the panel / MCP) */
  inliers: number[];
}

/** What an analysis is valid for: the file, the analysed source span and rate, and Detailed Analysis. */
export function stabKey(path: string, srcIn: number, srcOut: number, fps: number, detailed: boolean): string {
  return `${path}|${srcIn.toFixed(3)}|${srcOut.toFixed(3)}|${fps.toFixed(3)}|${detailed ? 'd' : 'n'}`;
}

/** The span a stabilizer on a video layer analyses: its in…out in source time, at the footage's rate (≤ 60 fps). */
export function stabSpan(l: { in: number; out: number; start: number; stretch?: number }, m: { path: string; fps?: number }, compFps: number, detailed: boolean) {
  const stretch = l.stretch || 1, fps = Math.min(60, m.fps || compFps);
  const srcIn = Math.max(0, (l.in - l.start) / stretch), srcOut = Math.max(srcIn, (l.out - l.start) / stretch);
  const count = Math.max(2, Math.min(3600, Math.round((srcOut - srcIn) * fps)));
  return { srcIn, srcOut, fps, count, key: stabKey(m.path, srcIn, srcOut, fps, detailed) };
}

// ───────────────────────── 3×3 matrices (row-major) ─────────────────────────
export type M3 = number[];
export const I3 = (): M3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const mul3 = (a: M3, b: M3): M3 => Array.from({ length: 9 }, (_, i) => { const r = Math.floor(i / 3), c = i % 3; return a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; });
export function inv3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
export const ap3 = (m: M3, x: number, y: number): [number, number] => { const w = m[6] * x + m[7] * y + m[8] || 1e-12; return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]; };
const norm3 = (m: M3): M3 => m.map((v) => v / (m[8] || 1e-12));
/** linear scale of a matrix (square root of the determinant of its 2×2 part) */
const scaleOf = (m: M3) => { const k = norm3(m); return Math.sqrt(Math.abs(k[0] * k[4] - k[1] * k[3])) || 1; };

/** Least-squares similarity q ≈ [a −b; b a]·p + t. */
export function fitSimilarity(P: [number, number][], Q: [number, number][]): [number, number, number, number] {
  const n = P.length;
  if (!n) return [1, 0, 0, 0];
  let px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++) { px += P[i][0]; py += P[i][1]; qx += Q[i][0]; qy += Q[i][1]; }
  px /= n; py /= n; qx /= n; qy /= n;
  let sa = 0, sb = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const x = P[i][0] - px, y = P[i][1] - py, u = Q[i][0] - qx, v = Q[i][1] - qy;
    sa += x * u + y * v; sb += x * v - y * u; ss += x * x + y * y;
  }
  const a = ss > 1e-12 ? sa / ss : 1, b = ss > 1e-12 ? sb / ss : 0;
  return [a, b, qx - (a * px - b * py), qy - (b * px + a * py)];
}

// ───────────────────────── smoothing ─────────────────────────
/** Gaussian smoothing of a series (sigma in samples); the ends are extended by odd reflection, so a steady pan
 *  stays a pan up to the last frame instead of bending towards the inside. */
export function smoothSeries(x: number[], sigma: number): number[] {
  const n = x.length;
  if (n < 2 || sigma < 0.05) return x.slice();
  const r = Math.min(Math.ceil(sigma * 3), 4 * n), w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  // the ends are anchored on a line fitted to the first / last samples (not on the raw, jittery end sample)
  const m = Math.max(2, Math.min(n, Math.ceil(sigma * 2)));
  const endFit = (idx: number[]) => { const mx = mean(idx), my = mean(idx.map((i) => x[i])); let sxy = 0, sxx = 0; idx.forEach((i) => { sxy += (i - mx) * (x[i] - my); sxx += (i - mx) ** 2; }); const b = sxx ? sxy / sxx : 0; return (i: number) => my + b * (i - mx); };
  const f0 = endFit(Array.from({ length: m }, (_, i) => i)), f1 = endFit(Array.from({ length: m }, (_, i) => n - m + i)), a0 = f0(0), a1 = f1(n - 1);
  const at = (i: number): number => {
    if (i < 0) return 2 * a0 - at(-i);
    if (i >= n) return 2 * a1 - at(2 * (n - 1) - i);
    return x[i];
  };
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) { const j = i + k, v = j >= -(n - 1) && j <= 2 * (n - 1) ? at(j) : at(Math.max(-(n - 1), Math.min(2 * (n - 1), j))); s += v * w[k + r]; ws += w[k + r]; }
    out[i] = s / ws;
  }
  return out;
}
const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / (x.length || 1);

// ───────────────────────── stabilisation ─────────────────────────
export interface StabParams {
  result: string; smoothness: number; method: string; preserveScale: boolean;
  framing: string; maxScale: number; actionSafe: number; additionalScale: number;
  rollingShutter: string; cropSmooth: number;
}
export const STAB_DEFAULTS: StabParams = { result: 'smooth', smoothness: 50, method: 'subspace', preserveScale: false, framing: 'cropScale', maxScale: 150, actionSafe: 0, additionalScale: 100, rollingShutter: 'auto', cropSmooth: 50 };
export interface StabResult {
  n: number;
  /** per frame: output ← source (normalised coords), including the framing scale */
  fwd: M3[];
  /** per frame: mesh correction at the nodes (normalised, source-frame node positions), or null */
  mesh: Float32Array[] | null;
  grid: [number, number];
  /** framing scale (1 = none) and the crop: half size of the kept rectangle in output coords, or null */
  scale: number;
  crop: [number, number] | null;
  /** scale that would hide every border (Escala automática readout), ≥ 1 */
  needed: number;
  /** the auto-scale hit Maximum Scale: borders show (AE's «Para evitar un recorte extremo…» warning) */
  overcropped: boolean;
  edges: boolean;
}

/** Composes the per-frame motions into the camera path C_i (frame 0 → frame i) for a method. */
export function cameraPath(d: StabData, method: string): M3[] {
  const out: M3[] = [I3()];
  for (let i = 1; i < d.n; i++) {
    let M: M3;
    if (method === 'position') M = [1, 0, d.tr[i * 2], 0, 1, d.tr[i * 2 + 1], 0, 0, 1];
    else if (method === 'similarity') { const [a, b, tu, tv] = d.sim.slice(i * 4, i * 4 + 4); M = [a, -b, tu, b, a, tv, 0, 0, 1]; }
    else M = [...d.hom.slice(i * 8, i * 8 + 8), 1];
    out.push(norm3(mul3(M, out[i - 1])));
  }
  return out;
}

/** Smoothed path for the method: per-parameter Gaussian (Smooth Motion) or its mean (No Motion). */
function smoothPath(C: M3[], method: string, p: StabParams, fps: number): M3[] {
  const sm = (x: number[]) => (p.result === 'none' ? x.map(() => mean(x)) : smoothSeries(x, Math.max(0, p.smoothness) / 100 * fps * (0.5 + p.cropSmooth / 100)));
  if (method === 'position') { const u = sm(C.map((m) => m[2])), v = sm(C.map((m) => m[5])); return C.map((_, i) => [1, 0, u[i], 0, 1, v[i], 0, 0, 1]); }
  if (method === 'similarity') {
    let prev = 0;
    const ang = C.map((m) => { let a = Math.atan2(m[3], m[0]); while (a - prev > Math.PI) a -= 2 * Math.PI; while (a - prev < -Math.PI) a += 2 * Math.PI; prev = a; return a; });
    const ls = C.map((m) => Math.log(Math.hypot(m[0], m[3]) || 1));
    const A = sm(ang), L = p.preserveScale ? ls : sm(ls), U = sm(C.map((m) => m[2])), V = sm(C.map((m) => m[5]));
    return C.map((_, i) => { const s = Math.exp(L[i]); return [s * Math.cos(A[i]), -s * Math.sin(A[i]), U[i], s * Math.sin(A[i]), s * Math.cos(A[i]), V[i], 0, 0, 1]; });
  }
  const cols = Array.from({ length: 8 }, (_, k) => sm(C.map((m) => m[k])));
  return C.map((m, i) => {
    let S: M3 = [...cols.map((c) => c[i]), 1];
    // Preserve Scale: no zoom in the correction (the smoothed path keeps the shot's own scale)
    if (p.preserveScale) { const k = scaleOf(m) / scaleOf(S); S = mul3(S, [k, 0, 0, 0, k, 0, 0, 0, 1]); }
    return S;
  });
}

/** The scale about the centre that makes a W × H rectangle (shrunk by the margin) fit inside a convex quad. */
export function scaleToFill(quad: [number, number][], hw: number, hh: number): number {
  let cx = 0, cy = 0;
  quad.forEach(([x, y]) => { cx += x / quad.length; cy += y / quad.length; });
  let s = 0;
  for (let j = 0; j < quad.length; j++) {
    const [x0, y0] = quad[j], [x1, y1] = quad[(j + 1) % quad.length];
    let nx = -(y1 - y0), ny = x1 - x0;
    if (nx * (cx - x0) + ny * (cy - y0) < 0) { nx = -nx; ny = -ny; }
    const c = -(nx * x0 + ny * y0);
    if (c <= 1e-12) return Infinity;
    s = Math.max(s, (Math.abs(nx) * hw + Math.abs(ny) * hh) / c);
  }
  return s;
}

const cache = new Map<string, StabResult>();
/** Stabilisation of an analysis for the given parameters (memoised: scrubbing re-uses it). */
export function stabilize(d: StabData, p: StabParams): StabResult {
  const ck = `${d.key}|${d.n}|${JSON.stringify(p)}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  const method = p.method;
  const C = cameraPath(d, method === 'subspace' ? 'perspective' : method), S = smoothPath(C, method, p, d.fps);
  const F = C.map((c, i) => norm3(mul3(S[i], inv3(c))));
  // Subspace Warp: what the global model leaves at each mesh node, accumulated over time, is smoothed like the path
  // and the difference warps the frame locally (parallax, rolling-shutter wobble); Enhanced Reduction uses it with
  // Perspective too
  const [gx, gy] = d.grid;
  let mesh: Float32Array[] | null = null;
  if ((method === 'subspace' || (method === 'perspective' && p.rollingShutter === 'enhanced')) && d.mesh.length >= d.n * gx * gy * 2) {
    const K = gx * gy * 2, acc: number[][] = Array.from({ length: K }, () => []);
    const run = new Float64Array(K);
    for (let i = 0; i < d.n; i++) for (let k = 0; k < K; k++) { run[k] += d.mesh[i * K + k]; acc[k].push(run[k]); }
    const sig = (p.rollingShutter === 'enhanced' ? 0.5 : 1) * Math.max(0, p.smoothness) / 100 * d.fps;
    const sm = acc.map((x) => (p.result === 'none' ? x.map(() => mean(x)) : smoothSeries(x, sig)));
    const lim = 0.04;
    mesh = Array.from({ length: d.n }, (_, i) => Float32Array.from({ length: K }, (_, k) => Math.max(-lim, Math.min(lim, sm[k][i] - acc[k][i]))));
  }
  // framing: the scale each frame needs so no border shows, the largest one wins
  const a = d.aspect, corners: [number, number][] = [[-0.5, -a / 2], [0.5, -a / 2], [0.5, a / 2], [-0.5, a / 2]];
  const m = Math.max(0, Math.min(45, p.actionSafe)) / 100;
  let need = 1, needAll = 1;
  F.forEach((f) => { const q = corners.map(([x, y]) => ap3(f, x, y)); need = Math.max(need, scaleToFill(q, 0.5 * (1 - 2 * m), (a / 2) * (1 - 2 * m))); needAll = Math.max(needAll, scaleToFill(q, 0.5, a / 2)); });
  if (!Number.isFinite(need)) need = 10;
  if (!Number.isFinite(needAll)) needAll = 10;
  let scale = 1, crop: [number, number] | null = null, over = false;
  if (p.framing === 'crop') crop = [0.5 / needAll, a / 2 / needAll];
  else if (p.framing === 'cropScale') {
    scale = Math.min(need, Math.max(1, p.maxScale / 100));
    over = need > p.maxScale / 100 + 1e-6;
    const k = Math.min(1, scale / needAll);
    crop = k < 1 - 1e-6 ? [0.5 * k, (a / 2) * k] : null;
  }
  const add = Math.max(0, p.additionalScale) / 100, Z: M3 = [scale * add, 0, 0, 0, scale * add, 0, 0, 0, 1];
  const out: StabResult = { n: d.n, fwd: F.map((f) => mul3(Z, f)), mesh, grid: [gx, gy], scale: scale * add, crop: crop ? [crop[0] * add, crop[1] * add] : null, needed: need, overcropped: over, edges: p.framing === 'synth' };
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  cache.set(ck, out);
  return out;
}

/** Mesh correction at a source point (bilinear between nodes; nodes span the frame). */
export function meshAt(r: StabResult, i: number, u: number, v: number, aspect: number): [number, number] {
  const m = r.mesh?.[i];
  if (!m) return [0, 0];
  const [gx, gy] = r.grid;
  const fx = Math.max(0, Math.min(gx - 1, (u + 0.5) * (gx - 1))), fy = Math.max(0, Math.min(gy - 1, (v / aspect + 0.5) * (gy - 1)));
  const x0 = Math.min(gx - 2, Math.floor(fx)), y0 = Math.min(gy - 2, Math.floor(fy)), tx = fx - x0, ty = fy - y0;
  const g = (x: number, y: number, c: number) => m[(y * gx + x) * 2 + c];
  const b = (c: number) => (g(x0, y0, c) * (1 - tx) + g(x0 + 1, y0, c) * tx) * (1 - ty) + (g(x0, y0 + 1, c) * (1 - tx) + g(x0 + 1, y0 + 1, c) * tx) * ty;
  return [b(0), b(1)];
}

/** Where a source point (normalised) lands in the stabilised frame i. */
export function stabPoint(r: StabResult, i: number, u: number, v: number, aspect: number): [number, number] {
  const k = Math.max(0, Math.min(r.n - 1, i));
  const [x, y] = ap3(r.fwd[k], u, v), [mu, mv] = meshAt(r, k, u, v, aspect);
  return [x + mu * r.scale, y + mv * r.scale];
}

/** Frame index of a source time, or −1 outside the analysed span. */
export function stabFrame(d: StabData, srcTime: number): number {
  const f = Math.round((srcTime - d.t0) * d.fps);
  return f < 0 || f >= d.n ? (f === d.n && d.n > 0 ? d.n - 1 : -1) : f;
}

/** Residual frame-to-frame motion (mean displacement of the tracked points, in normalised units) before and after
 *  the stabilisation: what the MCP status and the tests report. */
export function residualMotion(d: StabData, r: StabResult | null): number {
  let s = 0, c = 0;
  for (let i = 1; i < d.n; i++) {
    const H: M3 = [...d.hom.slice(i * 8, i * 8 + 8), 1];
    // points of frame i−1 on a grid, carried to frame i by the measured motion
    for (const [u, v] of [[-0.3, -0.2], [0.3, -0.2], [0, 0], [-0.3, 0.2], [0.3, 0.2]] as [number, number][]) {
      const vv = v * d.aspect / 0.5625;
      const [qu, qv] = ap3(H, u, vv);
      const a = r ? stabPoint(r, i - 1, u, vv, d.aspect) : [u, vv], b = r ? stabPoint(r, i, qu, qv, d.aspect) : [qu, qv];
      s += Math.hypot(b[0] - a[0], b[1] - a[1]); c++;
    }
  }
  return c ? s / c : 0;
}
