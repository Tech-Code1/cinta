// 3D Camera Tracker (After Effects' 3D Camera Tracker): follows many points of a video, solves the camera that
// filmed it and the 3D positions of those points (structure from motion), and creates a 3D camera with that
// motion plus track points as 3D nulls, so 3D layers added to the comp sit in the shot.
// The method is the classic one: two views with enough parallax give the essential matrix (normalised 8-point
// in RANSAC; Hartley & Zisserman), its decomposition gives the relative pose (the one with points in front),
// points are triangulated (DLT), every frame's pose is fitted to them (Levenberg-Marquardt on the reprojection
// error) and points and poses are refined in turns. The angle of view is searched (lowest reprojection error)
// unless it is given.
import type { Editor } from './ops';
import { motionOps } from './motion/ops';
import { apply, defaultZoom, findComp, findLayer, worldMatrix, type Comp } from './motion';
import { grayFrames, textureAt, trackFrames } from './tracker';

type V3 = [number, number, number];
type M3 = number[]; // row-major 3×3

// ───────────────────────── small linear algebra ─────────────────────────
/** Eigen decomposition of a symmetric matrix (Jacobi rotations): eigenvalues ascending, vectors as columns. */
export function eigSym(A0: number[][]): { values: number[]; vectors: number[][] } {
  const n = A0.length, A = A0.map((r) => [...r]), V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const idx = A.map((_, i) => i).sort((a, b) => A[a][a] - A[b][b]);
  return { values: idx.map((i) => A[i][i]), vectors: idx.map((i) => V.map((r) => r[i])) };
}
const mm3 = (a: M3, b: M3): M3 => Array.from({ length: 9 }, (_, i) => { const r = Math.floor(i / 3), c = i % 3; return a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; });
const tr3 = (a: M3): M3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const mv3 = (a: M3, v: number[]): V3 => [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]];
const det3 = (a: M3) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
const cross = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
/** Rotation vector (axis × angle) → matrix (Rodrigues). */
export function rodrigues(r: number[]): M3 {
  const th = norm(r);
  if (th < 1e-12) return [1, -r[2], r[1], r[2], 1, -r[0], -r[1], r[0], 1];
  const [x, y, z] = r.map((v) => v / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
/** Matrix → rotation vector. */
function unrodrigues(R: M3): V3 {
  const c = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)), th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}
/** 3×3 SVD through the eigenvectors of AᵀA (enough for essential matrices). */
function svd3(E: M3): { U: M3; S: V3; V: M3 } {
  const EtE = mm3(tr3(E), E);
  const { values, vectors } = eigSym([[EtE[0], EtE[1], EtE[2]], [EtE[3], EtE[4], EtE[5]], [EtE[6], EtE[7], EtE[8]]]);
  // descending
  const v = [vectors[2], vectors[1], vectors[0]], s = [values[2], values[1], values[0]].map((x) => Math.sqrt(Math.max(0, x)));
  const u0 = mv3(E, v[0]).map((x) => x / (s[0] || 1)), u1 = mv3(E, v[1]).map((x) => x / (s[1] || 1)), u2 = cross(u0, u1);
  const U: M3 = [u0[0], u1[0], u2[0], u0[1], u1[1], u2[1], u0[2], u1[2], u2[2]], V: M3 = [v[0][0], v[1][0], v[2][0], v[0][1], v[1][1], v[2][1], v[0][2], v[1][2], v[2][2]];
  return { U, S: s as V3, V };
}

// ───────────────────────── geometry of views ─────────────────────────
interface Pose { R: M3; t: V3 }
const proj = (P: Pose, X: number[]): [number, number, number] => { const c = mv3(P.R, X); return [c[0] + P.t[0], c[1] + P.t[1], c[2] + P.t[2]]; };
/** Essential matrix from normalised correspondences x2ᵀ E x1 = 0 (8 or more points). */
function essential8(a: [number, number][], b: [number, number][]): M3 | null {
  if (a.length < 8) return null;
  const AtA = Array.from({ length: 9 }, () => new Array(9).fill(0));
  a.forEach(([x1, y1], i) => { const [x2, y2] = b[i], r = [x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1]; for (let p = 0; p < 9; p++) for (let q = 0; q < 9; q++) AtA[p][q] += r[p] * r[q]; });
  const e = eigSym(AtA).vectors[0];
  // project onto essential matrices: singular values (1, 1, 0)
  const { U, V } = svd3(e as M3);
  return mm3(mm3(U, [1, 0, 0, 0, 1, 0, 0, 0, 0]), tr3(V));
}
/** Point from several views (linear DLT on normalised coordinates). */
function triangulate(views: { P: Pose; x: [number, number] }[]): V3 | null {
  if (views.length < 2) return null;
  const A = Array.from({ length: 4 }, () => new Array(4).fill(0));
  for (const { P, x } of views) {
    const R = P.R, t = P.t, row = (k: number) => [R[k * 3], R[k * 3 + 1], R[k * 3 + 2], t[k]];
    for (const r of [row(0).map((v, i) => x[0] * row(2)[i] - v), row(1).map((v, i) => x[1] * row(2)[i] - v)]) for (let p = 0; p < 4; p++) for (let q = 0; q < 4; q++) A[p][q] += r[p] * r[q];
  }
  const h = eigSym(A).vectors[0];
  if (Math.abs(h[3]) < 1e-12) return null;
  return [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
}
/** Pose that best reprojects 3D points onto their observations (Levenberg-Marquardt, from `init`). */
function solvePose(X: V3[], x: [number, number][], init: Pose, iters = 20): Pose {
  let r: number[] = unrodrigues(init.R), t = [...init.t] as V3, lambda = 1e-3;
  const err = (rv: number[], tv: number[]) => { const P = { R: rodrigues(rv), t: tv as V3 }; let e = 0; const res: number[] = []; X.forEach((p, i) => { const c = proj(P, p); const u = c[0] / c[2] - x[i][0], v = c[1] / c[2] - x[i][1]; res.push(u, v); e += u * u + v * v; }); return { e, res }; };
  let cur = err(r, t);
  for (let it = 0; it < iters; it++) {
    const p0 = [...r, ...t], J: number[][] = [];
    for (let k = 0; k < 6; k++) { const d = 1e-6, pp = [...p0]; pp[k] += d; const rs = err(pp.slice(0, 3), pp.slice(3)).res; J.push(rs.map((v, i) => (v - cur.res[i]) / d)); }
    const JtJ = Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
    const g = Array.from({ length: 6 }, (_, a) => J[a].reduce((s, v, i) => s + v * cur.res[i], 0));
    for (let a = 0; a < 6; a++) JtJ[a][a] *= 1 + lambda;
    // solve JtJ · d = −g (Gauss-Jordan)
    const M = JtJ.map((row, a) => [...row, -g[a]]);
    let ok = true;
    for (let c = 0; c < 6 && ok; c++) { let pv = c; for (let rr = c + 1; rr < 6; rr++) if (Math.abs(M[rr][c]) > Math.abs(M[pv][c])) pv = rr; if (Math.abs(M[pv][c]) < 1e-18) { ok = false; break; } [M[c], M[pv]] = [M[pv], M[c]]; for (let rr = 0; rr < 6; rr++) if (rr !== c) { const f = M[rr][c] / M[c][c]; for (let j = c; j < 7; j++) M[rr][j] -= f * M[c][j]; } }
    if (!ok) break;
    const dlt = M.map((row, a) => row[6] / row[a]), np = p0.map((v, i) => v + dlt[i]), next = err(np.slice(0, 3), np.slice(3));
    if (next.e < cur.e) { r = np.slice(0, 3); t = np.slice(3) as V3; cur = next; lambda /= 3; if (dlt.every((d) => Math.abs(d) < 1e-9)) break; } else lambda *= 4;
  }
  return { R: rodrigues(r), t };
}

/** Solves camera poses and points from tracks (normalised image coordinates, null where lost). Several starts are
 *  tried — partner frames and essential-matrix hypotheses (a scene dominated by one plane has a «twin» solution
 *  that fits two views) — and the one that explains the most tracks over the whole sequence wins (tracks that
 *  slid along an occlusion edge fit no camera, so counting beats averaging). px: one pixel in those units. */
export function solveScene(tracks: ([number, number] | null)[][], nFrames: number, px = 1 / 1000): { poses: Pose[]; points: (V3 | null)[]; error: number; init: number; kept: number } | null {
  const seen = (i: number, f: number) => tracks[i][f] !== null;
  // partner views: the largest median parallax to frame 0, the last frame and the middle one
  const parallax = (f: number) => { const d = tracks.map((tk) => (tk[0] && tk[f] ? Math.hypot(tk[f]![0] - tk[0]![0], tk[f]![1] - tk[0]![1]) : NaN)).filter(Number.isFinite).sort((a, b) => a - b); return d.length < 12 ? 0 : d[Math.floor(d.length / 2)]; };
  let best = -1, bestPar = 0;
  for (let f = 1; f < nFrames; f++) { const p = parallax(f); if (p > bestPar) { bestPar = p; best = f; } }
  if (best < 0 || bestPar < 1e-3) return null;
  const partners = [...new Set([best, nFrames - 1, Math.floor(nFrames / 2)])].filter((f) => f > 0 && parallax(f) > bestPar * 0.3);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const algErr = (E: M3, a: [number, number], b: [number, number]) => { const l = mv3(E, [a[0], a[1], 1]); const v = b[0] * l[0] + b[1] * l[1] + l[2]; return (v * v) / (l[0] * l[0] + l[1] * l[1] + 1e-12); };
  const tol = (2 * px) ** 2;
  const P0: Pose = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  // the relative poses to start from: for each partner, the best RANSAC models (different inlier sets) and,
  // for each model, the decompositions that put most points in front
  const starts: { f: number; P1: Pose; inl: number[] }[] = [];
  for (const pf of partners) {
    const pairs = tracks.map((_, i) => i).filter((i) => seen(i, 0) && seen(i, pf));
    if (pairs.length < 8) continue;
    const models: number[][] = [];
    for (let it = 0; it < 500; it++) {
      const sm = new Set<number>(); while (sm.size < 8) sm.add(pairs[Math.floor(rand() * pairs.length)]);
      const E = essential8([...sm].map((i) => tracks[i][0]!), [...sm].map((i) => tracks[i][pf]!));
      if (!E) continue;
      const inl = pairs.filter((i) => algErr(E, tracks[i][0]!, tracks[i][pf]!) < tol);
      if (inl.length < 8) continue;
      // a new model if it is not (almost) the same set as one already kept
      const same = models.findIndex((m) => { const set = new Set(m); return inl.filter((i) => set.has(i)).length > 0.9 * Math.min(m.length, inl.length) && Math.abs(m.length - inl.length) < 0.1 * m.length; });
      if (same >= 0) { if (inl.length > models[same].length) models[same] = inl; } else models.push(inl);
      models.sort((a, b) => b.length - a.length); models.length = Math.min(models.length, 3);
    }
    for (const inl of models) {
      const E = essential8(inl.map((i) => tracks[i][0]!), inl.map((i) => tracks[i][pf]!));
      if (!E) continue;
      const { U, V } = svd3(E), Wm: M3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
      const fix = (R: M3) => (det3(R) < 0 ? R.map((v) => -v) : R);
      const u3: V3 = [U[2], U[5], U[8]];
      const cands = [fix(mm3(mm3(U, Wm), tr3(V))), fix(mm3(mm3(U, tr3(Wm)), tr3(V)))].flatMap((R) => [1, -1].map((sg) => ({ R, t: u3.map((v) => v * sg) as V3 })));
      const scored = cands.map((cand) => { let n = 0; for (const i of inl) { const X = triangulate([{ P: P0, x: tracks[i][0]! }, { P: cand, x: tracks[i][pf]! }]); if (X && X[2] > 0 && proj(cand, X)[2] > 0) n++; } return { cand, n }; }).sort((a, b) => b.n - a.n);
      for (const sc of scored.slice(0, 2)) if (sc.n > inl.length * 0.5) starts.push({ f: pf, P1: sc.cand, inl });
    }
  }
  let bestSol: ReturnType<typeof refineScene> | null = null;
  for (const st of starts.slice(0, 8)) {
    const sol = refineScene(tracks, nFrames, P0, st.P1, st.f, st.inl, px);
    if (sol.kept < 8) continue;
    // more tracks explained wins; nearly as many (within 5 %) with a clearly lower error, too
    if (!bestSol || sol.kept > bestSol.kept * 1.05 || (sol.kept >= bestSol.kept * 0.95 && sol.error < bestSol.error)) bestSol = sol;
  }
  return bestSol;
}
/**
 * Bundle adjustment: every pose (but the first, which fixes the frame) and every point together, Levenberg–Marquardt
 * on the reprojection error with Huber weights (tracks that slid count less), points eliminated per point (Schur
 * complement) so the system left is 6 numbers per camera. Alternating poses and points crawls along the valley a
 * small-parallax scene has (travel against pan); solving them together crosses it. frames: the cameras to adjust.
 * focal: also adjust one scale k of the image coordinates (the angle of view: true zoom = zoom used × k).
 */
export function bundleAdjust(tracks: ([number, number] | null)[][], poses: Pose[], points: (V3 | null)[], frames: number[], px: number, iters = 15, focal = false): number {
  const fi = new Map(frames.filter((f) => f !== 0).map((f, k) => [f, k] as [number, number])), nc = fi.size, huber = 1.5 * px;
  // blocks: one per adjusted camera (6 numbers), then the focal scale (1)
  const dim = (b: number) => (b < nc ? 6 : 1), off = (b: number) => (b < nc ? b * 6 : nc * 6), n = nc * 6 + (focal ? 1 : 0);
  const obs: { i: number; f: number; x: [number, number] }[] = [];
  tracks.forEach((tk, i) => { if (points[i]) for (const f of frames) if (tk[f]) obs.push({ i, f, x: tk[f]! }); });
  const cost = (P: Pose[], X: (V3 | null)[], k: number) => { let e = 0; for (const o of obs) { const c = proj(P[o.f], X[o.i]!); if (c[2] <= 1e-6) { e += 1e6 * huber * huber; continue; } const d = Math.hypot((k * c[0]) / c[2] - o.x[0], (k * c[1]) / c[2] - o.x[1]); e += d <= huber ? d * d : 2 * huber * d - huber * huber; } return e; };
  let lambda = 1e-3, kf = 1, cur = cost(poses, points, kf);
  for (let it = 0; it < iters; it++) {
    const S = Array.from({ length: n }, () => new Array(n).fill(0)), bv = new Array(n).fill(0);
    const V = new Map<number, number[][]>(), eX = new Map<number, number[]>(), Wm = new Map<number, Map<number, number[][]>>();
    for (const o of obs) {
      const P = poses[o.f], X = points[o.i]!, RX = mv3(P.R, X), c: V3 = [RX[0] + P.t[0], RX[1] + P.t[1], RX[2] + P.t[2]];
      if (c[2] <= 1e-6) continue;
      const iz = 1 / c[2], res = [kf * c[0] * iz - o.x[0], kf * c[1] * iz - o.x[1]], d = Math.hypot(res[0], res[1]), w = d <= huber ? 1 : huber / d;
      // d(u,v)/dc, then dc/dX = R, dc/dω = −[RX]×, dc/dt = I; d(u,v)/dk = the unscaled projection
      const du = [kf * iz, 0, -kf * c[0] * iz * iz], dv = [0, kf * iz, -kf * c[1] * iz * iz];
      const Jx = [du, dv].map((g) => [0, 1, 2].map((j) => g[0] * P.R[j] + g[1] * P.R[3 + j] + g[2] * P.R[6 + j]));
      const blocks: [number, number[][]][] = [];
      const b = fi.get(o.f);
      if (b !== undefined) blocks.push([b, [du, dv].map((g) => [g[2] * RX[1] - g[1] * RX[2], g[0] * RX[2] - g[2] * RX[0], g[1] * RX[0] - g[0] * RX[1], ...g])]);
      if (focal) blocks.push([nc, [[c[0] * iz], [c[1] * iz]]]);
      if (!V.has(o.i)) { V.set(o.i, [[0, 0, 0], [0, 0, 0], [0, 0, 0]]); eX.set(o.i, [0, 0, 0]); Wm.set(o.i, new Map()); }
      const Vi = V.get(o.i)!, ei = eX.get(o.i)!, Wf = Wm.get(o.i)!;
      for (let a = 0; a < 3; a++) { ei[a] -= w * (Jx[0][a] * res[0] + Jx[1][a] * res[1]); for (let q = 0; q < 3; q++) Vi[a][q] += w * (Jx[0][a] * Jx[0][q] + Jx[1][a] * Jx[1][q]); }
      for (const [ba, Ja] of blocks) {
        const oa = off(ba), da = dim(ba);
        for (let a = 0; a < da; a++) bv[oa + a] -= w * (Ja[0][a] * res[0] + Ja[1][a] * res[1]);
        for (const [bb, Jb] of blocks) { const ob = off(bb); for (let a = 0; a < da; a++) for (let q = 0; q < dim(bb); q++) S[oa + a][ob + q] += w * (Ja[0][a] * Jb[0][q] + Ja[1][a] * Jb[1][q]); }
        if (!Wf.has(ba)) Wf.set(ba, Array.from({ length: da }, () => [0, 0, 0]));
        const Wk = Wf.get(ba)!; for (let a = 0; a < da; a++) for (let q = 0; q < 3; q++) Wk[a][q] += w * (Ja[0][a] * Jx[0][q] + Ja[1][a] * Jx[1][q]);
      }
    }
    // damping, then the point blocks eliminated: S −= W·V⁻¹·Wᵀ, b −= W·V⁻¹·eX
    for (let a = 0; a < n; a++) S[a][a] = S[a][a] * (1 + lambda) + 1e-12;
    const Vinv = new Map<number, number[][]>();
    for (const [i, Vi] of V) {
      const D = Vi.map((row, a) => row.map((v, q) => (a === q ? v * (1 + lambda) + 1e-12 : v)));
      const inv = [0, 1, 2].map((cI) => solveLin(D, [0, 1, 2].map((q) => (q === cI ? 1 : 0))));
      if (inv.some((x) => !x)) continue;
      const Vi1 = [0, 1, 2].map((a) => [0, 1, 2].map((q) => inv[q]![a]));
      Vinv.set(i, Vi1);
      const Wf = [...Wm.get(i)!.entries()], ei = eX.get(i)!;
      for (const [ba, Wa] of Wf) {
        const A = Wa.map((row) => [0, 1, 2].map((q) => row[0] * Vi1[0][q] + row[1] * Vi1[1][q] + row[2] * Vi1[2][q])), oa = off(ba);
        for (let a = 0; a < A.length; a++) bv[oa + a] -= A[a][0] * ei[0] + A[a][1] * ei[1] + A[a][2] * ei[2];
        for (const [bb, Wb] of Wf) { const ob = off(bb); for (let a = 0; a < A.length; a++) for (let q = 0; q < Wb.length; q++) S[oa + a][ob + q] -= A[a][0] * Wb[q][0] + A[a][1] * Wb[q][1] + A[a][2] * Wb[q][2]; }
      }
    }
    const dp = n ? solveLin(S, bv) : [];
    if (!dp) { lambda *= 10; continue; }
    const nPoses = poses.map((P, f) => { const b = fi.get(f); if (b === undefined) return P; const d = dp.slice(b * 6, b * 6 + 6); return { R: mm3(rodrigues(d.slice(0, 3)), P.R), t: [P.t[0] + d[3], P.t[1] + d[4], P.t[2] + d[5]] as V3 }; });
    const nk = focal ? kf + dp[nc * 6] : kf;
    const nPoints = points.map((X, i) => {
      const Vi1 = Vinv.get(i); if (!X || !Vi1) return X;
      const rhs = [...eX.get(i)!];
      for (const [ba, Wa] of Wm.get(i)!) { const oa = off(ba); for (let q = 0; q < 3; q++) for (let a = 0; a < Wa.length; a++) rhs[q] -= Wa[a][q] * dp[oa + a]; }
      return [0, 1, 2].map((a) => X[a] + Vi1[a][0] * rhs[0] + Vi1[a][1] * rhs[1] + Vi1[a][2] * rhs[2]) as V3;
    });
    const next = nk > 0.2 && nk < 5 ? cost(nPoses, nPoints, nk) : Infinity;
    if (next < cur) {
      const gain = (cur - next) / cur;
      poses.splice(0, poses.length, ...nPoses); points.splice(0, points.length, ...nPoints); kf = nk; cur = next; lambda = Math.max(1e-7, lambda / 3);
      if (gain < 1e-7) break;
    } else lambda *= 5;
  }
  return kf;
}
/** From a two-view start: the two views adjusted together, every other frame fitted to their points, then bundle
 *  adjustment and re-triangulation of every track in turns, the outlier gate tightening each turn. */
function refineScene(tracks: ([number, number] | null)[][], nFrames: number, P0: Pose, P1: Pose, partner: number, inl: number[], px: number) {
  const seen = (i: number, f: number) => tracks[i][f] !== null;
  let points: (V3 | null)[] = tracks.map((tk, i) => (inl.includes(i) ? triangulate([{ P: P0, x: tk[0]! }, { P: P1, x: tk[partner]! }]) : null));
  const poses: Pose[] = new Array(nFrames).fill(null);
  poses[0] = P0; poses[partner] = P1;
  bundleAdjust(tracks, poses, points, [0, partner], px, 30);
  const fitFrame = (f: number, init: Pose) => {
    const idx = tracks.map((_, i) => i).filter((i) => points[i] && seen(i, f));
    if (idx.length < 6) return init;
    return solvePose(idx.map((i) => points[i]!), idx.map((i) => tracks[i][f]!), init);
  };
  // frames on either side of the partner, each from its neighbour
  for (let f = 1; f < partner; f++) poses[f] = fitFrame(f, poses[f - 1]);
  for (let f = partner + 1; f < nFrames; f++) poses[f] = fitFrame(f, poses[f - 1]);
  // bundle adjustment on the frames (at most ~60 of them, evenly spread; the rest are fitted to the result)
  const step = Math.max(1, Math.ceil(nFrames / 60)), keyF = Array.from({ length: nFrames }, (_, f) => f).filter((f) => f % step === 0 || f === nFrames - 1 || f === partner);
  const regate = (thr: number) => {
    points = tracks.map((tk) => {
      const vs = tk.map((x, f) => (x ? { P: poses[f], x } : null)).filter(Boolean) as { P: Pose; x: [number, number] }[];
      const X = vs.length >= 2 ? triangulate(vs) : null;
      if (!X) return null;
      for (const v of vs) { const c = proj(v.P, X); if (c[2] <= 0 || Math.hypot(c[0] / c[2] - v.x[0], c[1] / c[2] - v.x[1]) > thr) return null; }
      return X;
    });
  };
  for (const thrPx of [8, 4, 2, 2]) {
    regate(thrPx * px);
    if (points.filter(Boolean).length < 8) break;
    bundleAdjust(tracks, poses, points, keyF, px, 40);
    for (let f = 1; f < nFrames; f++) if (!keyF.includes(f)) poses[f] = fitFrame(f, poses[f - 1]);
  }
  regate(2 * px);
  let e = 0, n = 0;
  tracks.forEach((tk, i) => { const X = points[i]; if (!X) return; tk.forEach((x, f) => { if (!x) return; const c = proj(poses[f], X); e += Math.hypot(c[0] / c[2] - x[0], c[1] / c[2] - x[1]); n++; }); });
  return { poses, points, error: n ? e / n : Infinity, init: partner, kept: points.filter(Boolean).length };
}

/** Bilinear sample of a gray frame (clamped to the edge). */
function sample(d: Uint8Array, w: number, h: number, x: number, y: number): number {
  const xi = Math.max(0, Math.min(w - 2, Math.floor(x))), yi = Math.max(0, Math.min(h - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - xi)), fy = Math.max(0, Math.min(1, y - yi)), i = yi * w + xi;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}
/** Solves A·x = b (small dense system, partial pivoting); null if singular. */
function solveLin(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < n; i++) { const k = M[i][c] / M[c][c]; for (let j = c; j <= n; j++) M[i][j] -= k * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let v = M[i][n]; for (let j = i + 1; j < n; j++) v -= M[i][j] * x[j]; x[i] = v / M[i][i]; }
  return x;
}
/**
 * Re-measures a track against its first frame instead of the previous one (frame-to-frame matching drifts a little
 * every frame, and a camera solve needs sub-pixel tracks): Lucas–Kanade with an affine warp of the first frame's
 * patch (planes seen in perspective change scale and shear) and gain/bias for lighting. The frame-to-frame track
 * is the starting guess. Returns the refined positions, null from the frame where the patch stops matching.
 */
export function refineTrackAffine(frames: Uint8Array[], w: number, h: number, start: [number, number][], r: number): ([number, number] | null)[] {
  const [x0, y0] = start[0], offs: [number, number][] = [];
  for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) offs.push([u, v]);
  const T = offs.map(([u, v]) => sample(frames[0], w, h, x0 + u, y0 + v));
  const tm = T.reduce((a, b) => a + b, 0) / T.length, ts = Math.sqrt(T.reduce((a, b) => a + (b - tm) ** 2, 0) / T.length) || 1;
  const Tn = T.map((v) => (v - tm) / ts);
  const out: ([number, number] | null)[] = [[x0, y0]];
  // p = [x, y, a11, a12, a21, a22]: point (u, v) of the patch lands at (x + a11·u + a12·v, y + a21·u + a22·v)
  let A = [1, 0, 0, 1], prev: [number, number] = [x0, y0];
  for (let f = 1; f < frames.length; f++) {
    const I = frames[f];
    // the guess: the frame-to-frame step from the previous refined position
    let px = prev[0] + start[f][0] - start[f - 1][0], py = prev[1] + start[f][1] - start[f - 1][1], a = [...A], ok = false, zncc = 0;
    for (let it = 0; it < 20; it++) {
      const vals: number[] = [], gx: number[] = [], gy: number[] = [];
      for (const [u, v] of offs) {
        const X = px + a[0] * u + a[1] * v, Y = py + a[2] * u + a[3] * v;
        if (X < 1 || Y < 1 || X > w - 2 || Y > h - 2) { vals.length = 0; break; }
        vals.push(sample(I, w, h, X, Y));
        gx.push((sample(I, w, h, X + 1, Y) - sample(I, w, h, X - 1, Y)) / 2); gy.push((sample(I, w, h, X, Y + 1) - sample(I, w, h, X, Y - 1)) / 2);
      }
      if (!vals.length) break;
      const im = vals.reduce((s2, v) => s2 + v, 0) / vals.length, is = Math.sqrt(vals.reduce((s2, v) => s2 + (v - im) ** 2, 0) / vals.length) || 1;
      const H6 = Array.from({ length: 6 }, () => new Array(6).fill(0)), g6 = new Array(6).fill(0);
      zncc = 0;
      offs.forEach(([u, v], i) => {
        const e = (vals[i] - im) / is - Tn[i]; zncc += ((vals[i] - im) / is) * Tn[i];
        const J = [gx[i], gy[i], gx[i] * u, gx[i] * v, gy[i] * u, gy[i] * v].map((q) => q / is);
        for (let m = 0; m < 6; m++) { g6[m] -= J[m] * e; for (let n = 0; n < 6; n++) H6[m][n] += J[m] * J[n]; }
      });
      zncc /= offs.length;
      const d = solveLin(H6, g6);
      if (!d) break;
      px += d[0]; py += d[1]; a = [a[0] + d[2], a[1] + d[3], a[2] + d[4], a[3] + d[5]];
      ok = true;
      if (Math.abs(d[0]) + Math.abs(d[1]) < 0.005) break;
    }
    // stop where the patch no longer looks like the first frame's, or the warp went wild
    const detA = a[0] * a[3] - a[1] * a[2];
    if (!ok || zncc < 0.85 || detA < 0.25 || detA > 4 || Math.hypot(px - start[f][0], py - start[f][1]) > 3) { for (let k = f; k < frames.length; k++) out.push(null); break; }
    out.push([px, py]); prev = [px, py]; A = a;
  }
  return out;
}

export interface CameraTrackOptions { at?: number; to?: number; zoom?: number; nulls?: number; signal?: AbortSignal }
/** Tracks the video layer, solves the camera, adds «Cámara 3D rastreada» (and track-point nulls). */
export async function cameraTrack(e: Editor, compId: string, layerId: string, o: CameraTrackOptions = {}): Promise<{ frames: number; points: number; error: number; zoom: number; camera: string; nulls: string[] }> {
  const comps = (e.project as unknown as { comps?: Comp[] }).comps;
  const c = findComp(comps, compId), l = findLayer(c, layerId);
  if (l.type !== 'video') throw new Error(`«${l.name}» no es una capa de vídeo: el rastreador de cámara analiza un vídeo.`);
  if (l.threeD) throw new Error('El rastreador de cámara analiza capas de vídeo 2D (la cámara se crea aparte).');
  const m = e.project.media.find((x) => x.id === l.mediaId);
  if (!m?.path || !m.width || !m.height) throw new Error('No se encuentra el vídeo de la capa.');
  const fps = c.fps, t0 = Math.max(l.in, o.at ?? l.in), t1 = Math.min(l.out, o.to ?? l.out), stretch = l.stretch || 1;
  const count = Math.max(3, Math.round((t1 - t0) * fps) + 1);
  if (count > 1200) throw new Error('Analice como mucho 1200 fotogramas por vez (use at / to).');
  const k = Math.min(1, 640 / m.width), W = Math.max(32, Math.round(m.width * k)), H = Math.max(32, Math.round(m.height * k));
  const frames = await grayFrames(m.path, (t0 - l.start) / stretch, count, fps / stretch, W, H, o.signal);
  if (frames.length < 3) throw new Error('No se pudieron leer fotogramas de ese tramo del vídeo.');
  // features: the most detailed spots on a grid, kept apart
  const fr = Math.max(5, Math.round(10 * k)), step = Math.max(fr * 2, Math.round(Math.min(W, H) / 14)), cand: [number, number, number][] = [];
  for (let y = fr * 2; y < H - fr * 2; y += step / 2) for (let x = fr * 2; x < W - fr * 2; x += step / 2) cand.push([x, y, textureAt(frames[0], W, H, x, y, fr)]);
  cand.sort((a, b) => b[2] - a[2]);
  const pts: [number, number][] = [];
  for (const q of cand) { if (q[2] < 2) break; if (pts.every((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) > step * 0.7)) pts.push([q[0], q[1]]); if (pts.length >= 160) break; }
  if (pts.length < 20) throw new Error(`El vídeo tiene poco detalle para resolver la cámara (${pts.length} puntos útiles; hacen falta al menos 20).`);
  const tr = trackFrames(frames, W, H, pts, fr, Math.max(6, Math.round(48 * k)));
  // forward–backward check: each track is followed back from its last frame; where the two disagree the track
  // drifted (or slid along an occlusion edge) and is cut from there on
  const back = trackFrames([...frames].reverse(), W, H, tr.map((t) => t.pts[t.pts.length - 1]), fr, Math.max(6, Math.round(48 * k)));
  tr.forEach((t, i) => {
    const n = t.pts.length, bp = back[i].pts;
    let cut = n;
    for (let f = 0; f < n; f++) { const q = bp[n - 1 - f]; if (back[i].conf[n - 1 - f] < 0.6 || Math.hypot(q[0] - t.pts[f][0], q[1] - t.pts[f][1]) > 0.75) { cut = f; break; } }
    for (let f = cut; f < n; f++) t.conf[f] = 0;
  });
  // to comp px through the layer, per frame
  const times = frames.map((_, f) => t0 + f / fps);
  const compPx = tr.map((t) => {
    // the frame-to-frame track up to where it holds, then measured again against its first frame
    const n = t.conf.findIndex((q) => q < 0.6), good = n < 0 ? t.pts : t.pts.slice(0, n);
    const ref = good.length > 1 ? refineTrackAffine(frames.slice(0, good.length), W, H, good, fr) : [];
    return times.map((tt, f) => (ref[f] ? apply(worldMatrix(c, l, tt), ref[f]![0] / k, ref[f]![1] / k, 0) : null));
  });

  // angle of view: given, or found — a solve from each of a few lenses, the focal length then adjusted with the
  // rest (bundle adjustment), and the start that explains the most tracks wins; the scene is solved again at it
  const normAt = (zoom: number) => compPx.map((tk) => tk.map((p) => (p ? [(p[0] - c.width / 2) / zoom, (p[1] - c.height / 2) / zoom] as [number, number] : null)));
  const solveAt = (zoom: number) => solveScene(normAt(zoom), frames.length, 1 / zoom);
  let best: { zoom: number; sol: NonNullable<ReturnType<typeof solveScene>> } | null = null;
  const z0 = defaultZoom(c.width);
  for (const zoom of o.zoom ? [o.zoom] : [0.5, 0.8, 1.25, 2].map((f) => z0 * f)) {
    const sol = solveAt(zoom);
    if (!sol || (best && !(sol.kept > best.sol.kept * 1.05 || (sol.kept >= best.sol.kept * 0.95 && sol.error * zoom < best.sol.error * best.zoom)))) continue;
    best = { zoom, sol };
  }
  if (best && !o.zoom) {
    const step = Math.max(1, Math.ceil(frames.length / 60)), keyF = frames.map((_, f) => f).filter((f) => f % step === 0 || f === frames.length - 1);
    const kf = bundleAdjust(normAt(best.zoom), best.sol.poses.map((P) => ({ R: [...P.R], t: [...P.t] as V3 })), best.sol.points.map((X) => (X ? [...X] as V3 : null)), keyF, 1 / best.zoom, 100, true);
    const zoom = best.zoom * kf, sol = Math.abs(kf - 1) > 1e-3 ? solveAt(zoom) : best.sol;
    if (sol && sol.kept >= best.sol.kept * 0.9) best = { zoom, sol };
  }
  if (!best) throw new Error('No se pudo resolver la cámara: el vídeo necesita movimiento de cámara con paralaje (no solo zoom o giro sobre el sitio).');
  const { zoom, sol } = best;
  // world: frame 0 is the comp's default camera (eye at the centre, −zoom in z, looking +z), points scaled so their
  // median depth sits on z = 0, like After Effects places the solve
  const depths = sol.points.filter(Boolean).map((p) => p![2]).sort((a, b) => a - b), s = zoom / (depths[Math.floor(depths.length / 2)] || 1);
  const toWorld = (p: number[]): V3 => [c.width / 2 + p[0] * s, c.height / 2 + p[1] * s, -zoom + p[2] * s];
  const cam = motionOps.layerAdd(e, c.id, 'camera', { name: 'Cámara 3D rastreada' });
  const pos: { t: number; v: number[] }[] = [], poi: { t: number; v: number[] }[] = [], roll: { t: number; v: number }[] = [];
  sol.poses.forEach((P, f) => {
    const Rt = tr3(P.R), eye = mv3(Rt, P.t.map((v) => -v)), fwd = mv3(Rt, [0, 0, 1]), yAxis = mv3(Rt, [0, 1, 0]);
    const ew = toWorld(eye);
    pos.push({ t: times[f], v: ew });
    poi.push({ t: times[f], v: [ew[0] + fwd[0] * zoom, ew[1] + fwd[1] * zoom, ew[2] + fwd[2] * zoom] });
    // roll: the camera's own down axis against the one lookAt would give (world up, y down)
    let rx = cross([0, 1, 0], fwd); const lr = norm(rx) || 1; rx = rx.map((v) => v / lr) as V3;
    const uy = cross(fwd, rx);
    roll.push({ t: times[f], v: (Math.atan2(rx[0] * yAxis[0] + rx[1] * yAxis[1] + rx[2] * yAxis[2], uy[0] * yAxis[0] + uy[1] * yAxis[1] + uy[2] * yAxis[2]) * 180) / Math.PI });
  });
  motionOps.propSet(e, c.id, cam.id, 'position', { keys: pos, clearKeys: true });
  motionOps.propSet(e, c.id, cam.id, 'camera.poi', { keys: poi, clearKeys: true });
  if (roll.some((r) => Math.abs(r.v) > 0.01)) motionOps.propSet(e, c.id, cam.id, 'rotation', { keys: roll, clearKeys: true });
  motionOps.propSet(e, c.id, cam.id, 'camera.zoom', { value: zoom });
  // track points: 3D nulls at the best-seen points
  const nulls: string[] = [];
  const order = sol.points.map((p, i) => ({ p, i, seen: compPx[i].filter(Boolean).length })).filter((q) => q.p).sort((a, b) => b.seen - a.seen).slice(0, Math.max(0, o.nulls ?? 12));
  for (const q of order) {
    const nl = motionOps.layerAdd(e, c.id, 'null', { name: `Punto de rastreo ${nulls.length + 1}` });
    motionOps.layerSet(e, c.id, nl.id, { threeD: true });
    motionOps.propSet(e, c.id, nl.id, 'position', { value: toWorld(q.p!) });
    nulls.push(nl.id);
  }
  return { frames: frames.length, points: sol.points.filter(Boolean).length, error: Math.round(sol.error * zoom * 100) / 100, zoom: Math.round(zoom * 10) / 10, camera: cam.id, nulls };
}
