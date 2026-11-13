// Motion tracker of the advanced mode (After Effects' Track Motion / Stabilize Motion): follows feature points of a
// video layer frame by frame (normalised cross-correlation, coarse-to-fine with sub-pixel refinement) and turns the
// track into keyframes: a null that follows the point, another layer's position, a 4-point corner pin, or the
// layer stabilised (anchor point following the feature, rotation / scale from a second point).
import type { Editor } from './ops';
import { runFfmpeg } from './ffmpeg';
import { motionOps } from './motion/ops';
import { apply, invert, worldMatrix } from './motion/geom';
import { findComp, findLayer, type Comp, type Layer } from './motion';

export interface TrackResult {
  /** source time of each tracked frame (s) */
  times: number[];
  /** per point: positions (source px) and match quality 0…1 per frame */
  tracks: { pts: [number, number][]; conf: number[] }[];
}

// ───────────────────────── the tracker (pure) ─────────────────────────
interface Img { d: Uint8Array | Float32Array; w: number; h: number }
const half = (im: Img): Img => {
  const w = Math.max(1, im.w >> 1), h = Math.max(1, im.h >> 1), d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * 2 * im.w + x * 2;
    d[y * w + x] = (im.d[i] + im.d[i + 1] + im.d[i + im.w] + im.d[i + im.w + 1]) / 4;
  }
  return { d, w, h };
};
/** Template (r = half size) centred on integer (cx, cy), with its mean removed; null when it leaves the image. */
function template(im: Img, cx: number, cy: number, r: number): { t: Float32Array; norm: number } | null {
  if (cx - r < 0 || cy - r < 0 || cx + r >= im.w || cy + r >= im.h) return null;
  const n = (2 * r + 1) ** 2, t = new Float32Array(n);
  let s = 0, k = 0;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) { const v = im.d[(cy + y) * im.w + cx + x]; t[k++] = v; s += v; }
  const m = s / n;
  let q = 0;
  for (let i = 0; i < n; i++) { t[i] -= m; q += t[i] * t[i]; }
  return { t, norm: Math.sqrt(q) };
}
/** Normalised cross-correlation of a template with the image at (cx, cy); −1 outside. */
function ncc(im: Img, tp: { t: Float32Array; norm: number }, cx: number, cy: number, r: number): number {
  if (cx - r < 0 || cy - r < 0 || cx + r >= im.w || cy + r >= im.h || tp.norm < 1e-6) return -1;
  let s = 0, s2 = 0, st = 0, k = 0;
  const n = (2 * r + 1) ** 2;
  for (let y = -r; y <= r; y++) {
    const row = (cy + y) * im.w + cx;
    for (let x = -r; x <= r; x++) { const v = im.d[row + x]; s += v; s2 += v * v; st += v * tp.t[k++]; }
  }
  const varI = s2 - (s * s) / n;
  return varI < 1e-6 ? -1 : st / (Math.sqrt(varI) * tp.norm);
}
/** Best match of `tp` around (px, py) within ±radius, integer position and score. */
function search(im: Img, tp: { t: Float32Array; norm: number }, px: number, py: number, radius: number, r: number): [number, number, number] {
  // nothing better than −1 (flat or out of the image): stay at the prediction
  let best = -1, bx = px, by = py;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const c = ncc(im, tp, px + dx, py + dy, r);
    if (c > best) { best = c; bx = px + dx; by = py + dy; }
  }
  return [bx, by, best];
}
/** Bilinear sample (clamped). */
function bil(im: Img, x: number, y: number): number {
  const xi = Math.max(0, Math.min(im.w - 2, Math.floor(x))), yi = Math.max(0, Math.min(im.h - 2, Math.floor(y)));
  const u = Math.max(0, Math.min(1, x - xi)), v = Math.max(0, Math.min(1, y - yi)), i = yi * im.w + xi;
  return (im.d[i] * (1 - u) + im.d[i + 1] * u) * (1 - v) + (im.d[i + im.w] * (1 - u) + im.d[i + im.w + 1] * u) * v;
}
/**
 * Sub-pixel refinement (Lucas–Kanade, Gauss–Newton): moves (qx, qy) in `cur` until the patch around it matches the
 * patch around (px, py) in `prev`, both sampled bilinearly — no rounding, so no drift from frame to frame.
 */
function refine(prev: Img, cur: Img, px: number, py: number, qx: number, qy: number, r: number): [number, number] {
  const n = (2 * r + 1) ** 2, T = new Float32Array(n);
  let k = 0;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) T[k++] = bil(prev, px + x, py + y);
  for (let it = 0; it < 8; it++) {
    let gxx = 0, gxy = 0, gyy = 0, bx = 0, by = 0;
    k = 0;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const X = qx + x, Y = qy + y;
      const gx = (bil(cur, X + 0.5, Y) - bil(cur, X - 0.5, Y)), gy = (bil(cur, X, Y + 0.5) - bil(cur, X, Y - 0.5));
      const e = T[k++] - bil(cur, X, Y);
      gxx += gx * gx; gxy += gx * gy; gyy += gy * gy; bx += gx * e; by += gy * e;
    }
    const det = gxx * gyy - gxy * gxy;
    if (Math.abs(det) < 1e-9) break;
    const dx = (gyy * bx - gxy * by) / det, dy = (gxx * by - gxy * bx) / det;
    qx += Math.max(-1, Math.min(1, dx)); qy += Math.max(-1, Math.min(1, dy));
    if (Math.abs(dx) < 0.003 && Math.abs(dy) < 0.003) break;
  }
  return [qx, qy];
}

/**
 * Tracks points through grayscale frames (w×h, one byte per pixel). `feature` and `search` are the half sizes of
 * the feature box and of the search region (px). The template is taken from the previous frame (adapts to slow
 * changes); the search starts where the point would be at its last speed.
 */
export function trackFrames(frames: Uint8Array[], w: number, h: number, points: [number, number][], feature = 12, searchR = 24): { pts: [number, number][]; conf: number[] }[] {
  const imgs: Img[] = frames.map((d) => ({ d, w, h }));
  const halves = imgs.map(half);
  return points.map(([x0, y0]) => {
    const pts: [number, number][] = [[x0, y0]], conf = [1];
    let vx = 0, vy = 0, lost = false;
    for (let f = 1; f < imgs.length; f++) {
      const [px, py] = pts[f - 1];
      if (lost) { pts.push([px, py]); conf.push(0); continue; }
      const prev = imgs[f - 1], cur = imgs[f];
      // coarse: half resolution, the whole search region
      const hr = Math.max(2, Math.round(feature / 2));
      const tpH = template(halves[f - 1], Math.round(px / 2), Math.round(py / 2), hr);
      if (!tpH) { lost = true; pts.push([px, py]); conf.push(0); continue; }
      const [cx, cy] = search(halves[f], tpH, Math.round((px + vx) / 2), Math.round((py + vy) / 2), Math.max(2, Math.ceil(searchR / 2)), hr);
      // fine: full resolution ±2 px, then the sub-pixel peak
      const tp = template(prev, Math.round(px), Math.round(py), feature);
      if (!tp) { lost = true; pts.push([px, py]); conf.push(0); continue; }
      const off = [px - Math.round(px), py - Math.round(py)];
      const [bx, by, score] = search(cur, tp, cx * 2, cy * 2, 2, feature);
      const [nx, ny] = refine(prev, cur, px, py, bx + off[0], by + off[1], feature);
      vx = nx - px; vy = ny - py;
      pts.push([nx, ny]);
      conf.push(Math.max(0, score));
    }
    return { pts, conf };
  });
}

/**
 * How well a point can be tracked (Shi–Tomasi): the smaller eigenvalue of the gradient structure tensor of the
 * feature box, as an RMS gradient. 0 on flat areas AND on straight edges (they only fix one direction).
 */
export function textureAt(d: Uint8Array, w: number, h: number, x: number, y: number, r: number): number {
  const cx = Math.round(x), cy = Math.round(y);
  if (cx - r < 1 || cy - r < 1 || cx + r >= w - 1 || cy + r >= h - 1) return 0;
  let a = 0, b = 0, c = 0;
  for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) {
    const gx = (d[j * w + i + 1] - d[j * w + i - 1]) / 2, gy = (d[(j + 1) * w + i] - d[(j - 1) * w + i]) / 2;
    a += gx * gx; b += gx * gy; c += gy * gy;
  }
  const n = (2 * r + 1) ** 2, tr = (a + c) / 2, det = a * c - b * b;
  const lmin = tr - Math.sqrt(Math.max(0, tr * tr - det));
  return Math.sqrt(Math.max(0, lmin) / n);
}
/** The most textured spot within `radius` of (x, y) (for the hint when the chosen point is flat). */
export function bestFeatureNear(d: Uint8Array, w: number, h: number, x: number, y: number, r: number, radius: number): [number, number, number] {
  let best: [number, number, number] = [x, y, textureAt(d, w, h, x, y, r)];
  const step = Math.max(1, Math.round(r / 2));
  for (let dy = -radius; dy <= radius; dy += step) for (let dx = -radius; dx <= radius; dx += step) {
    const t = textureAt(d, w, h, x + dx, y + dy, r);
    if (t > best[2]) best = [x + dx, y + dy, t];
  }
  return best;
}

// ───────────────────────── frames from the video ─────────────────────────
/** Grayscale frames of a video from `start` (s), `count` frames at `fps`, scaled to `w`×`h`.
 *  Frame i is the one on screen at start + i/fps, as the renderer shows it: fps's default rounding (near)
 *  hands over a source frame one step late when it drops frames (30 → 10 fps: 1, 4, 7… instead of 0, 3, 6…). */
export async function grayFrames(path: string, start: number, count: number, fps: number, w: number, h: number, signal?: AbortSignal): Promise<Uint8Array[]> {
  const r = await runFfmpeg(['-ss', start.toFixed(4), '-i', path, '-frames:v', String(count), '-vf', `fps=${fps}:round=up,scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { stdout: 'buffer', signal });
  const size = w * h, out: Uint8Array[] = [];
  for (let i = 0; i + size <= r.stdout.length; i += size) out.push(new Uint8Array(r.stdout.buffer, r.stdout.byteOffset + i, size));
  return out;
}

// ───────────────────────── track a layer and apply ─────────────────────────
export type TrackApply = 'null' | 'position' | 'cornerPin' | 'stabilize' | 'none';
export interface TrackOptions {
  /** points to follow, comp px at time `at` (1 point; 4 for a corner pin: top-left, top-right, bottom-right, bottom-left; 2 for stabilize with rotation / scale) */
  points: number[][];
  at: number;
  /** comp seconds (default: `at` → end of the layer) */
  to?: number;
  /** half sizes in source px */
  feature?: number;
  search?: number;
  apply?: TrackApply;
  /** layer that receives the track (position / cornerPin) */
  target?: string;
  /** stabilize: also rotation and scale (needs 2 points) */
  rotateScale?: boolean;
  signal?: AbortSignal;
}

/** Tracks feature points of a video layer and applies the result. Runs in Node (ffmpeg). */
export async function trackLayer(e: Editor, compId: string, layerId: string, o: TrackOptions): Promise<{ frames: number; lost: number; minConfidence: number; applied: TrackApply; layer?: string }> {
  const comps = (e.project as unknown as { comps?: Comp[] }).comps;
  const c = findComp(comps, compId);
  const l = findLayer(c, layerId);
  if (l.type !== 'video') throw new Error(`«${l.name}» no es una capa de vídeo: el rastreador sigue puntos de un vídeo.`);
  if (l.timeRemap) throw new Error('El rastreador no admite capas con reasignación de tiempo.');
  const m = e.project.media.find((x) => x.id === l.mediaId);
  if (!m?.path || !m.width || !m.height) throw new Error('No se encuentra el vídeo de la capa.');
  const fps = c.fps, t0 = Math.max(l.in, o.at), t1 = Math.min(l.out, o.to ?? l.out);
  const count = Math.max(2, Math.round((t1 - t0) * fps) + 1);
  if (count > 3600) throw new Error('Rastree como mucho 3600 fotogramas por vez (divida el tramo con «to»).');
  const stretch = l.stretch || 1;
  if (stretch < 0) throw new Error('El rastreador no admite capas invertidas en el tiempo.');
  // work at ≤ 960 px wide; points in source px → working px
  const k = Math.min(1, 960 / m.width), W = Math.max(16, Math.round(m.width * k)), H = Math.max(16, Math.round(m.height * k));
  const inv = invert(worldMatrix(c, l, t0));
  const src = o.points.map((p) => { const q = apply(inv, p[0], p[1], 0); return [q[0] * k, q[1] * k] as [number, number]; });
  const srcStart = (t0 - l.start) / stretch;
  const frames = await grayFrames(m.path, srcStart, count, fps / stretch, W, H, o.signal);
  if (frames.length < 2) throw new Error('No se pudieron leer fotogramas de ese tramo del vídeo.');
  const fr = Math.max(4, Math.round((o.feature ?? 16) * k));
  // a flat spot (sky, a wall) cannot be followed: say so and point at the nearest detailed one
  src.forEach(([x, y], i) => {
    if (textureAt(frames[0], W, H, x, y, fr) >= 1.5) return;
    const [bx, by] = bestFeatureNear(frames[0], W, H, x, y, fr, fr * 4);
    const q = apply(worldMatrix(c, l, t0), bx / k, by / k, 0);
    throw new Error(`El punto ${i + 1} (${o.points[i].map((v) => Math.round(v)).join(', ')}) está en una zona lisa o sobre un borde recto (solo se sabría cómo se mueve en una dirección). Elija una esquina o una marca; cerca hay uno en (${Math.round(q[0])}, ${Math.round(q[1])}).`);
  });
  const tr = trackFrames(frames, W, H, src, fr, Math.max(4, Math.round((o.search ?? 40) * k)));
  const times = frames.map((_, i) => t0 + i / fps);
  // back to layer px (= source px)
  const layerPts = tr.map((t) => t.pts.map(([x, y]) => [x / k, y / k] as [number, number]));
  const conf = tr.flatMap((t) => t.conf);
  const result = { frames: frames.length, lost: conf.filter((x) => x < 0.5).length, minConfidence: Math.round(Math.min(...conf) * 100) / 100, applied: o.apply ?? 'null' };
  const keys = (vals: (i: number) => number[]) => times.map((t, i) => ({ t, v: vals(i) }));
  const world = (i: number, p: [number, number]) => { const q = apply(worldMatrix(c, l, times[i]), p[0], p[1], 0); return [q[0], q[1]]; };
  const how = o.apply ?? 'null';
  if (how === 'none') return result;
  if (how === 'null' || how === 'position') {
    let id: string;
    if (how === 'null') { const nl = motionOps.layerAdd(e, c.id, 'null', { name: `Seguimiento de ${l.name}` }); id = nl.id; }
    else { if (!o.target) throw new Error('Indique target: la capa que seguirá el punto.'); id = findLayer(c, o.target).id; }
    const tgt = findLayer(c, id);
    if (tgt.parent) throw new Error(`«${tgt.name}» tiene primario: quítelo antes de aplicarle el seguimiento.`);
    motionOps.propSet(e, c.id, id, 'position', { keys: keys((i) => { const w = world(i, layerPts[0][i]); return tgt.threeD ? [w[0], w[1], (tgt.transform.position.v as number[])[2] ?? 0] : w; }), clearKeys: true });
    return { ...result, layer: id };
  }
  if (how === 'cornerPin') {
    if (layerPts.length !== 4) throw new Error('Esquina fija necesita 4 puntos: superior izquierda, superior derecha, inferior derecha, inferior izquierda.');
    if (!o.target) throw new Error('Indique target: la capa que se fijará a las 4 esquinas.');
    const tgt = findLayer(c, o.target);
    const fxId = tgt.effects.find((f) => f.fx === 'cornerPin')?.id ?? motionOps.effectAdd(e, c.id, tgt.id, 'cornerPin', {}).id;
    // comp px of each corner → the target's layer px at each frame
    const toTarget = (i: number, p: [number, number]) => { const w = world(i, p); const q = apply(invert(worldMatrix(c, tgt, times[i])), w[0], w[1], 0); return [q[0], q[1]]; };
    const names = ['tl', 'tr', 'br', 'bl'];
    names.forEach((n, j) => motionOps.propSet(e, c.id, tgt.id, `effects.${fxId}.${n}`, { keys: keys((i) => toTarget(i, layerPts[j][i])), clearKeys: true }));
    return { ...result, layer: tgt.id };
  }
  // stabilize: the anchor point follows the feature, the position stays → the feature holds still on screen
  const p0 = layerPts[0][0];
  const w0 = world(0, p0);
  motionOps.propSet(e, c.id, l.id, 'anchor', { keys: keys((i) => [layerPts[0][i][0], layerPts[0][i][1], 0]), clearKeys: true });
  motionOps.propSet(e, c.id, l.id, 'position', { value: l.threeD ? [w0[0], w0[1], 0] : w0, clearKeys: true });
  if (o.rotateScale) {
    if (layerPts.length < 2) throw new Error('Para estabilizar la rotación y la escala hacen falta 2 puntos.');
    const ang = (i: number) => Math.atan2(layerPts[1][i][1] - layerPts[0][i][1], layerPts[1][i][0] - layerPts[0][i][0]);
    const len = (i: number) => Math.hypot(layerPts[1][i][1] - layerPts[0][i][1], layerPts[1][i][0] - layerPts[0][i][0]) || 1;
    const r0 = Number(l.transform.rotation.v) || 0, s0 = (l.transform.scale.v as number[]) ?? [100, 100];
    motionOps.propSet(e, c.id, l.id, 'rotation', { keys: keys((i) => [r0 - ((ang(i) - ang(0)) * 180) / Math.PI]).map((q) => ({ t: q.t, v: q.v[0] })), clearKeys: true });
    motionOps.propSet(e, c.id, l.id, 'scale', { keys: keys((i) => [s0[0] * (len(0) / len(i)), s0[1] * (len(0) / len(i))]), clearKeys: true });
  }
  return { ...result, layer: l.id };
}

// ───────────────────────── planar tracking (homography) ─────────────────────────
/** Homography H (row-major 3×3, h33 = 1) with H·p ≈ q, least squares on Hartley-normalised points. */
export function fitHomography(P: [number, number][], Q: [number, number][]): number[] | null {
  if (P.length < 4) return null;
  const norm = (A: [number, number][]) => {
    const cx = A.reduce((s, a) => s + a[0], 0) / A.length, cy = A.reduce((s, a) => s + a[1], 0) / A.length;
    const d = A.reduce((s, a) => s + Math.hypot(a[0] - cx, a[1] - cy), 0) / A.length || 1, k = Math.SQRT2 / d;
    return { T: [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1], pts: A.map(([x, y]) => [(x - cx) * k, (y - cy) * k] as [number, number]) };
  };
  const a = norm(P), b = norm(Q);
  // 8 unknowns: normal equations of the 2n linear rows
  const M = Array.from({ length: 8 }, () => new Float64Array(9));
  const row = (r: number[], rhs: number) => { for (let i = 0; i < 8; i++) { for (let j = 0; j < 8; j++) M[i][j] += r[i] * r[j]; M[i][8] += r[i] * rhs; } };
  a.pts.forEach(([x, y], i) => { const [u, v] = b.pts[i]; row([x, y, 1, 0, 0, 0, -u * x, -u * y], u); row([0, 0, 0, x, y, 1, -v * x, -v * y], v); });
  for (let c = 0; c < 8; c++) {
    let piv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j < 9; j++) M[r][j] -= f * M[c][j]; }
  }
  const hn = [...Array.from({ length: 8 }, (_, i) => M[i][8] / M[i][i]), 1];
  // undo the normalisation: H = Tb⁻¹ · Hn · Ta
  const mm = (A: number[], B: number[]) => Array.from({ length: 9 }, (_, i) => { const r = Math.floor(i / 3), c = i % 3; return A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; });
  const kb = b.T[0], tbi = [1 / kb, 0, -b.T[2] / kb, 0, 1 / kb, -b.T[5] / kb, 0, 0, 1];
  const H = mm(tbi, mm(hn, a.T));
  return H.map((v) => v / H[8]);
}
export const applyH = (H: number[], x: number, y: number): [number, number] => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
/** RANSAC: the homography most points agree with (within `tol` px), refitted on them. */
export function ransacHomography(P: [number, number][], Q: [number, number][], tol = 2, iters = 300): { H: number[]; inliers: number } | null {
  if (P.length < 4) return null;
  let best: number[] = [], bestH: number[] | null = null;
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    const idx = new Set<number>(); while (idx.size < 4) idx.add(Math.floor(rand() * P.length));
    const s = [...idx], H = fitHomography(s.map((i) => P[i]), s.map((i) => Q[i]));
    if (!H) continue;
    const inl = P.map((_, i) => i).filter((i) => { const [x, y] = applyH(H, P[i][0], P[i][1]); return Math.hypot(x - Q[i][0], y - Q[i][1]) < tol; });
    if (inl.length > best.length) { best = inl; bestH = H; if (inl.length === P.length) break; }
  }
  if (!bestH || best.length < 4) return null;
  return { H: fitHomography(best.map((i) => P[i]), best.map((i) => Q[i])) ?? bestH, inliers: best.length };
}

// ───────────────────────── mask tracking ─────────────────────────
export interface MaskTrackOptions { at: number; to?: number; method?: 'position' | 'similarity' | 'perspective'; signal?: AbortSignal; target?: string }

/**
 * Tracks the area inside a mask (After Effects' mask tracker: Position, or Position, Scale & Rotation): picks the
 * most detailed spots inside it, follows them and fits a move (or move + scale + turn) per frame, which then
 * becomes keyframes of the mask path.
 */
export async function trackMask(e: Editor, compId: string, layerId: string, maskId: string, o: MaskTrackOptions): Promise<{ frames: number; points: number; minConfidence: number }> {
  const comps = (e.project as unknown as { comps?: Comp[] }).comps;
  const c = findComp(comps, compId);
  const l = findLayer(c, layerId);
  if (l.type !== 'video') throw new Error(`«${l.name}» no es una capa de vídeo: el seguimiento de máscaras sigue el vídeo de la capa.`);
  const mask = l.masks.find((m) => m.id === maskId || m.name === maskId);
  if (!mask) throw new Error(`«${l.name}» no tiene la máscara «${maskId}».`);
  const m = e.project.media.find((x) => x.id === l.mediaId);
  if (!m?.path || !m.width || !m.height) throw new Error('No se encuentra el vídeo de la capa.');
  const fps = c.fps, t0 = Math.max(l.in, o.at), t1 = Math.min(l.out, o.to ?? l.out), stretch = l.stretch || 1;
  const count = Math.max(2, Math.round((t1 - t0) * fps) + 1);
  const k = Math.min(1, 960 / m.width), W = Math.max(16, Math.round(m.width * k)), H = Math.max(16, Math.round(m.height * k));
  const frames = await grayFrames(m.path, (t0 - l.start) / stretch, count, fps / stretch, W, H, o.signal);
  if (frames.length < 2) throw new Error('No se pudieron leer fotogramas de ese tramo del vídeo.');
  const path0 = (mask.path.k?.length ? (mask.path.k.reduce((a, b) => (Math.abs(b.t - t0) < Math.abs(a.t - t0) ? b : a)).v) : mask.path.v) as number[];
  const vx: number[] = [], vy: number[] = [];
  for (let i = 0; i + 1 < path0.length; i += 6) { vx.push(path0[i] * k); vy.push(path0[i + 1] * k); }
  const inside = (x: number, y: number) => { let r = false; for (let i = 0, j = vx.length - 1; i < vx.length; j = i++) if ((vy[i] > y) !== (vy[j] > y) && x < ((vx[j] - vx[i]) * (y - vy[i])) / (vy[j] - vy[i] || 1e-9) + vx[i]) r = !r; return r; };
  // candidate spots on a grid inside the mask, the most trackable first, kept apart
  const fr = Math.max(4, Math.round(12 * k)), x0 = Math.min(...vx), x1 = Math.max(...vx), y0 = Math.min(...vy), y1 = Math.max(...vy);
  const step = Math.max(fr, Math.round(Math.min(x1 - x0, y1 - y0) / 8));
  const cand: [number, number, number][] = [];
  for (let y = y0 + fr; y < y1 - fr; y += step) for (let x = x0 + fr; x < x1 - fr; x += step) if (inside(x, y)) cand.push([x, y, textureAt(frames[0], W, H, x, y, fr)]);
  cand.sort((a, b) => b[2] - a[2]);
  const pts: [number, number][] = [];
  const persp = o.method === 'perspective', maxPts = persp ? 40 : 8, gap = persp ? step * 0.9 : step * 1.5;
  for (const q of cand) { if (q[2] < 1.5) break; if (pts.every((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) > gap)) pts.push([q[0], q[1]]); if (pts.length >= maxPts) break; }
  if (persp && pts.length < 4) throw new Error(`El seguimiento en perspectiva necesita al menos 4 zonas con detalle dentro de la máscara (hay ${pts.length}): agrándela sobre una superficie con textura.`);
  if (!pts.length) throw new Error('Dentro de la máscara no hay detalle que seguir (zona lisa): agrándela o muévala a una zona con textura.');
  const tr = trackFrames(frames, W, H, pts, fr, Math.max(4, Math.round(40 * k)));
  if (persp) return planarApply(e, c, l, mask.id, path0, pts, tr, frames.length, k, t0, fps, o.target);
  const sim = o.method === 'similarity' && pts.length >= 2;
  const keys: { t: number; v: number[] }[] = [];
  let minC = 1;
  for (let f = 0; f < frames.length; f++) {
    // points still well matched in this frame
    const ok = tr.map((_, i) => i).filter((i) => tr[i].conf[f] >= 0.5);
    const use = ok.length ? ok : tr.map((_, i) => i);
    minC = Math.min(minC, ...use.map((i) => tr[i].conf[f]));
    const P = use.map((i) => pts[i]), Q = use.map((i) => tr[i].pts[f]);
    const pc = [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
    const qc = [Q.reduce((s, p) => s + p[0], 0) / Q.length, Q.reduce((s, p) => s + p[1], 0) / Q.length];
    // similarity (complex least squares): q − qc = z (p − pc), z = scale · e^{i·angle}
    let zr = 1, zi = 0;
    if (sim && P.length >= 2) {
      let nr = 0, ni = 0, dd = 0;
      P.forEach((p, i) => { const ax = p[0] - pc[0], ay = p[1] - pc[1], bx = Q[i][0] - qc[0], by = Q[i][1] - qc[1]; nr += bx * ax + by * ay; ni += by * ax - bx * ay; dd += ax * ax + ay * ay; });
      if (dd > 1e-6) { zr = nr / dd; zi = ni / dd; }
    }
    const map = (x: number, y: number) => { const ax = x * k - pc[0], ay = y * k - pc[1]; return [(zr * ax - zi * ay + qc[0]) / k, (zi * ax + zr * ay + qc[1]) / k]; };
    const v: number[] = [];
    for (let i = 0; i + 5 < path0.length; i += 6) {
      const [x, y] = map(path0[i], path0[i + 1]);
      // tangents turn and scale with the shape
      v.push(x, y, zr * path0[i + 2] - zi * path0[i + 3], zi * path0[i + 2] + zr * path0[i + 3], zr * path0[i + 4] - zi * path0[i + 5], zi * path0[i + 4] + zr * path0[i + 5]);
    }
    keys.push({ t: t0 + f / fps, v });
  }
  motionOps.propSet(e, c.id, l.id, `masks.${mask.id}.path`, { keys, clearKeys: true });
  return { frames: frames.length, points: pts.length, minConfidence: Math.round(minC * 100) / 100 };
}

/** Planar result: a homography per frame (RANSAC over the tracked points), applied to the mask path or, with a
 *  target layer, as Corner Pin keyframes on it (the mask's first four vertices are the surface: top-left,
 *  top-right, bottom-right, bottom-left — like Mocha's corner pin export). */
function planarApply(e: Editor, c: Comp, l: Layer, maskId: string, path0: number[], pts: [number, number][], tr: { pts: [number, number][]; conf: number[] }[], n: number, k: number, t0: number, fps: number, target?: string) {
  const Hs: number[][] = [];
  let minInl = 1, minC = 1;
  let last = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let f = 0; f < n; f++) {
    const ok = tr.map((_, i) => i).filter((i) => tr[i].conf[f] >= 0.5);
    minC = Math.min(minC, ...ok.map((i) => tr[i].conf[f]), 1);
    const r = ransacHomography(ok.map((i) => pts[i]), ok.map((i) => tr[i].pts[f]), Math.max(1.5, 2 * k));
    // a frame without enough agreement keeps the previous plane
    if (r) { last = r.H; minInl = Math.min(minInl, r.inliers / Math.max(1, ok.length)); }
    Hs.push(last);
  }
  // working px ↔ layer px
  const map = (H: number[], x: number, y: number) => { const [u, v] = applyH(H, x * k, y * k); return [u / k, v / k]; };
  const times = Hs.map((_, f) => t0 + f / fps);
  const result = { frames: n, points: pts.length, minConfidence: Math.round(minC * 100) / 100, inliers: Math.round(minInl * 100) / 100 };
  if (target) {
    if (path0.length < 24) throw new Error('Para la esquina fija la máscara necesita 4 vértices (las esquinas de la superficie).');
    const tgt = findLayer(c, target);
    const fxId = tgt.effects.find((x) => x.fx === 'cornerPin')?.id ?? motionOps.effectAdd(e, c.id, tgt.id, 'cornerPin', {}).id;
    const corners = [0, 1, 2, 3].map((j) => [path0[j * 6], path0[j * 6 + 1]]);
    // layer px of the video → comp px → the target's layer px, every frame
    const toTarget = (f: number, p: number[]) => { const w = apply(worldMatrix(c, l, times[f]), p[0], p[1], 0); const q = apply(invert(worldMatrix(c, tgt, times[f])), w[0], w[1], 0); return [q[0], q[1]]; };
    ['tl', 'tr', 'br', 'bl'].forEach((nm, j) => motionOps.propSet(e, c.id, tgt.id, `effects.${fxId}.${nm}`, { keys: Hs.map((H, f) => ({ t: times[f], v: toTarget(f, map(H, corners[j][0], corners[j][1])) })), clearKeys: true }));
    return { ...result, layer: tgt.id };
  }
  const keys = Hs.map((H, f) => {
    const v: number[] = [];
    for (let i = 0; i + 5 < path0.length; i += 6) {
      // the vertex and the ends of its tangents through the plane's homography
      const [x, y] = map(H, path0[i], path0[i + 1]);
      const [ix, iy] = map(H, path0[i] + path0[i + 2], path0[i + 1] + path0[i + 3]), [ox, oy] = map(H, path0[i] + path0[i + 4], path0[i + 1] + path0[i + 5]);
      v.push(x, y, ix - x, iy - y, ox - x, oy - y);
    }
    return { t: times[f], v };
  });
  motionOps.propSet(e, c.id, l.id, `masks.${maskId}.path`, { keys, clearKeys: true });
  return result;
}
