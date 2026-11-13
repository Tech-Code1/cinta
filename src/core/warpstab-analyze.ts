// Analysis of the Warp Stabilizer («Análisis en segundo plano (paso 1 de 2)»): the layer's video is read in gray at a
// working size, the most textured spots of each frame are followed into the next one (the motion tracker's
// normalised cross-correlation + Lucas–Kanade, src/core/tracker.ts) and a robust model is fitted per pair (RANSAC
// homography, then the similarity and translation of its inliers, and what the homography leaves on a coarse mesh).
// Step 2 («Estabilización») is the fitting; the smoothing and framing happen at render time (motion/warpstab.ts).
import type { Editor } from './ops';
import { findComp, findLayer, type Comp } from './motion';
import { fitSimilarity, stabSpan, type StabData } from './motion/warpstab';
import { grayFrames, ransacHomography, textureAt, trackFrames } from './tracker';

export interface AnalyzeFramesOptions { detailed?: boolean; onFrame?: (i: number, n: number) => void }

/** Feature points of a frame: the most textured spot of each cell of a grid (Shi–Tomasi score). */
export function detectFeatures(d: Uint8Array, w: number, h: number, cols: number, rows: number, r: number): [number, number][] {
  const out: [number, number][] = [], m = r * 3, step = Math.max(2, Math.round(r / 1.5));
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const x0 = Math.max(m, Math.floor((cx * w) / cols)), x1 = Math.min(w - m, Math.floor(((cx + 1) * w) / cols));
    const y0 = Math.max(m, Math.floor((cy * h) / rows)), y1 = Math.min(h - m, Math.floor(((cy + 1) * h) / rows));
    let best = 0, bx = 0, by = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const t = textureAt(d, w, h, x, y, r); if (t > best) { best = t; bx = x; by = y; } }
    if (best >= 2) out.push([bx, by]);
  }
  return out;
}

/** The analysis of consecutive gray frames (w × h), without key / times (see analyzeWarpStab). */
export function analyzeFrames(frames: Uint8Array[], w: number, h: number, o: AnalyzeFramesOptions = {}): Omit<StabData, 'key' | 't0' | 'fps'> {
  const n = frames.length, gx = 6, gy = 4;
  const cols = o.detailed ? 12 : 8, rows = o.detailed ? 8 : 6;
  const r = Math.max(3, Math.round(w / 120)), feature = Math.max(4, Math.round(w / 80)), search = Math.max(6, Math.round(w / 14));
  const N = (x: number, y: number): [number, number] => [(x - w / 2) / w, (y - h / 2) / w];
  const tr = [0, 0], sim = [1, 0, 0, 0], hom = [1, 0, 0, 0, 1, 0, 0, 0], mesh = new Array<number>(gx * gy * 2).fill(0), inliers = [0];
  const pts: number[][] = [];
  let prevPts: [number, number][] = detectFeatures(frames[0], w, h, cols, rows, r);
  pts.push(prevPts.flatMap(([x, y]) => N(x, y)).map((v) => Math.round(v * 1e5) / 1e5));
  const tol = 1.5 / w, meshTol = 5 / w;
  for (let i = 1; i < n; i++) {
    o.onFrame?.(i, n);
    const tracks = prevPts.length ? trackFrames([frames[i - 1], frames[i]], w, h, prevPts, feature, search) : [];
    const P: [number, number][] = [], Q: [number, number][] = [];
    tracks.forEach((t, k) => { if (t.conf[1] >= 0.6) { P.push(N(...prevPts[k])); Q.push(N(...t.pts[1])); } });
    const R = P.length >= 6 ? ransacHomography(P, Q, tol, 200) : null;
    let H = [1, 0, 0, 0, 1, 0, 0, 0, 1], inl: number[] = [];
    if (R && R.inliers >= 5) {
      H = R.H;
      const ap = (x: number, y: number) => { const z = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z]; };
      inl = P.map((_, k) => k).filter((k) => { const [x, y] = ap(P[k][0], P[k][1]); return Math.hypot(x - Q[k][0], y - Q[k][1]) < tol * 2; });
      // the coarse mesh: what the homography leaves near each node (points that roughly agree, weighted by distance)
      const m = new Array<number>(gx * gy * 2).fill(0);
      for (let yy = 0; yy < gy; yy++) for (let xx = 0; xx < gx; xx++) {
        const nu = -0.5 + xx / (gx - 1), nv = (-0.5 + yy / (gy - 1)) * (h / w);
        let su = 0, sv = 0, ws = 0;
        P.forEach((p, k) => {
          const [x, y] = ap(p[0], p[1]), du = Q[k][0] - x, dv = Q[k][1] - y;
          if (Math.hypot(du, dv) > meshTol) return;
          const wt = Math.exp(-((p[0] - nu) ** 2 + (p[1] - nv) ** 2) / (2 * 0.12 * 0.12));
          su += du * wt; sv += dv * wt; ws += wt;
        });
        // few points near a node: the residual fades to none
        const k = ws / (ws + 0.5);
        if (ws > 1e-6) { m[(yy * gx + xx) * 2] = (su / ws) * k; m[(yy * gx + xx) * 2 + 1] = (sv / ws) * k; }
      }
      mesh.push(...m);
    } else mesh.push(...new Array<number>(gx * gy * 2).fill(0));
    const IP = inl.length ? inl.map((k) => P[k]) : P, IQ = inl.length ? inl.map((k) => Q[k]) : Q;
    const s = IP.length >= 2 ? fitSimilarity(IP, IQ) : [1, 0, 0, 0];
    let du = 0, dv = 0;
    IP.forEach((p, k) => { du += (IQ[k][0] - p[0]) / IP.length; dv += (IQ[k][1] - p[1]) / IP.length; });
    tr.push(du, dv);
    sim.push(...s);
    const Hn = H.map((v) => v / H[8]);
    hom.push(...Hn.slice(0, 8));
    inliers.push(inl.length);
    // points of this frame: the tracked inliers (shown with «Mostrar puntos de seguimiento»), new ones for the next pair
    pts.push(IQ.slice(0, 48).flatMap(([u, v]) => [u, v]).map((v) => Math.round(v * 1e5) / 1e5));
    prevPts = detectFeatures(frames[i], w, h, cols, rows, r);
  }
  const rd = (a: number[]) => a.map((v) => Math.round(v * 1e7) / 1e7);
  return { v: 1, aspect: h / w, n, tr: rd(tr), sim: rd(sim), hom: rd(hom), grid: [gx, gy], mesh: rd(mesh), pts, inliers };
}

export interface WarpStabOptions { signal?: AbortSignal; onProgress?: (phase: 1 | 2, frac: number) => void }
export interface WarpStabSpan { path: string; srcIn: number; srcOut: number; fps: number; count: number; detailed: boolean; key: string; width: number; height: number }

/** What a warp stabilizer on a layer analyses: the layer's video over its in…out span, at the footage's rate. */
export function warpStabSpan(project: { media: { id: string; path: string; width?: number; height?: number; fps?: number }[]; comps?: Comp[] }, compId: string, layerId: string, fxId: string): WarpStabSpan {
  const c = findComp(project.comps, compId), l = findLayer(c, layerId);
  const f = l.effects.find((x) => x.id === fxId || x.name === fxId);
  if (!f || f.fx !== 'warpStabilizer') throw new Error(`«${l.name}» no tiene ese Estabilizador de deformación.`);
  if (l.type !== 'video') throw new Error(`«${l.name}» no es una capa de vídeo: el Estabilizador de deformación analiza el metraje de la capa.`);
  if (l.timeRemap) throw new Error('El Estabilizador de deformación no admite capas con reasignación de tiempo.');
  const m = project.media.find((x) => x.id === l.mediaId);
  if (!m?.path || !m.width || !m.height) throw new Error('No se encuentra el vídeo de la capa.');
  if ((l.stretch || 1) < 0) throw new Error('El Estabilizador de deformación no admite capas invertidas en el tiempo.');
  const detailed = !!Number(f.params.detailed?.v ?? 0);
  const { srcIn, srcOut, fps, count, key } = stabSpan(l, m, c.fps, detailed);
  return { path: m.path, srcIn, srcOut, fps, count, detailed, key, width: m.width, height: m.height };
}

/** Analyses the layer's footage for a Warp Stabilizer and stores the result in the effect (one undo step). */
export async function analyzeWarpStab(e: Editor, compId: string, layerId: string, fxId: string, o: WarpStabOptions = {}): Promise<{ frames: number; points: number; seconds: number; key: string }> {
  const t0 = Date.now();
  const s = warpStabSpan(e.project as never, compId, layerId, fxId);
  // working size: 480 px wide (960 with Detailed Analysis)
  const k = Math.min(1, (s.detailed ? 960 : 480) / s.width), W = Math.max(32, Math.round((s.width * k) / 2) * 2), H = Math.max(32, Math.round((s.height * k) / 2) * 2);
  // read in chunks (memory, and progress while reading); each chunk starts on the last frame of the previous one
  const frames: Uint8Array[] = [];
  const CH = 240;
  for (let i = 0; i < s.count; i += CH) {
    if (o.signal?.aborted) throw new Error('Análisis del estabilizador cancelado.');
    const part = await grayFrames(s.path, s.srcIn + i / s.fps, Math.min(CH, s.count - i), s.fps, W, H, o.signal);
    frames.push(...part.map((f) => new Uint8Array(f)));
    o.onProgress?.(1, Math.min(1, (i + CH) / s.count) * 0.3);
    if (part.length < Math.min(CH, s.count - i)) break;
  }
  if (frames.length < 2) throw new Error('No se pudieron leer fotogramas del vídeo de la capa.');
  let last = Date.now();
  const a = analyzeFrames(frames, W, H, {
    detailed: s.detailed,
    onFrame: (i, n) => {
      if (o.signal?.aborted) throw new Error('Análisis del estabilizador cancelado.');
      if (Date.now() - last > 100) { last = Date.now(); o.onProgress?.(1, 0.3 + (0.7 * i) / n); }
    },
  });
  o.onProgress?.(2, 1);
  const data: StabData = { ...a, key: s.key, t0: s.srcIn, fps: s.fps };
  e.mutate('Analizar estabilizador de deformación', (p) => {
    const l = findLayer(findComp((p as unknown as { comps?: Comp[] }).comps, compId), layerId);
    const f = l.effects.find((x) => x.id === fxId || x.name === fxId);
    if (!f) throw new Error('El efecto ya no existe.');
    f.stab = data;
  });
  return { frames: a.n, points: Math.round(a.pts.reduce((x, p) => x + p.length / 2, 0) / Math.max(1, a.n)), seconds: Math.round((Date.now() - t0) / 100) / 10, key: s.key };
}
