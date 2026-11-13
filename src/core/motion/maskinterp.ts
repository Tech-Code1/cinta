// Smart Mask Interpolation (After Effects' keyframe assistant): between two mask-path keyframes, even with
// different vertex counts, adds one keyframe per frame so the shape morphs smoothly. Options follow the
// assistant (SmartMask): keyframe rate, fields, linear vertex paths, bending resistance, quality, added
// vertices, matching method, 1:1 vertex matches and first vertices match.
// The method is the one its options describe, from the published literature:
// · vertex correspondence that minimises the work of stretching and bending one outline into the other
//   (Sederberg & Greenwood, "A Physically Based Approach to 2-D Shape Blending", 1992), by dynamic programming
//   in a band around the diagonal whose width is the quality;
// · without linear vertex paths, the in-between outlines interpolate edge lengths and angles and are closed
//   by the least change of lengths (Sederberg et al., "2-D Shape Blending: An Intrinsic Solution to the Vertex
//   Path Problem", 1993), so parts that turn keep their size instead of collapsing.
// Paths are flat beziers [x, y, inX, inY, outX, outY…] with handles relative to their vertex.

export interface SmartMaskOptions {
  /** keyframes per second (null: the comp rate) */
  rate?: number | null;
  /** twice the rate */
  fields?: boolean;
  /** vertices move on straight lines (on: faster, for shapes that do not turn) */
  linear?: boolean;
  /** 0…100: how much bending costs against stretching in the matching */
  bending?: number;
  /** 0…100: 0 matches first to first, second to second…; 100 lets any pair of vertices match */
  quality?: number;
  /** add vertices on the outlines before matching (exact subdivisions) */
  addVertices?: false | { mode: 'pixels' | 'total' | 'percent'; value: number };
  /** curve: handles are kept and matched; polyline: the outlines are taken as straight segments */
  matching?: 'auto' | 'curve' | 'polyline';
  /** each original vertex of one key goes to the vertex of the same number in the other */
  oneToOne?: boolean;
  /** the first vertices correspond (off: every starting vertex is tried — slow) */
  firstMatch?: boolean;
}
/** The assistant's own defaults (its Restore Default Settings, read from SmartMask): rate Auto, fields off,
 *  linear vertex paths on, bending 50, quality 50, add vertices on at 9 pixels between vertices (100 total /
 *  1 % of outline in the other modes), matching Auto, 1:1 matches off, first vertices match on. */
export const SMART_MASK_DEFAULTS: Required<Omit<SmartMaskOptions, 'rate'>> & { rate: null } = {
  rate: null, fields: false, linear: true, bending: 50, quality: 50, addVertices: { mode: 'pixels', value: 9 }, matching: 'auto', oneToOne: false, firstMatch: true,
};
/** Value ranges of the spacing field per mode (as in the assistant). */
export const SPACING = { pixels: { min: 1, max: 10000, def: 9 }, total: { min: 2, max: 2500, def: 100 }, percent: { min: 0.04, max: 99, def: 1 } } as const;

type V = { x: number; y: number; ix: number; iy: number; ox: number; oy: number };
const toV = (f: number[]): V[] => { const v: V[] = []; for (let i = 0; i + 5 < f.length; i += 6) v.push({ x: f[i], y: f[i + 1], ix: f[i + 2], iy: f[i + 3], ox: f[i + 4], oy: f[i + 5] }); return v; };
const flat = (v: V[]) => v.flatMap((p) => [p.x, p.y, p.ix, p.iy, p.ox, p.oy]);
const hasHandles = (v: V[]) => v.some((p) => p.ix || p.iy || p.ox || p.oy);

/** Cubic of segment a→b: absolute control points. */
const seg = (a: V, b: V) => [a.x, a.y, a.x + a.ox, a.y + a.oy, b.x + b.ix, b.y + b.iy, b.x, b.y];
function segLen(a: V, b: V): number {
  const c = seg(a, b);
  if (!a.ox && !a.oy && !b.ix && !b.iy) return Math.hypot(b.x - a.x, b.y - a.y);
  let L = 0, px = c[0], py = c[1];
  for (let k = 1; k <= 16; k++) { const t = k / 16, u = 1 - t; const x = u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6], y = u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7]; L += Math.hypot(x - px, y - py); px = x; py = y; }
  return L;
}
/** Splits segment a→b in n equal-parameter pieces (de Casteljau): same curve, n−1 new vertices. */
function subdivide(a: V, b: V, n: number): V[] {
  const out: V[] = [];
  let [x0, y0, x1, y1, x2, y2, x3, y3] = seg(a, b);
  let first = { ...a };
  for (let k = n; k > 1; k--) {
    const t = 1 / k;
    const l = (p: number, q: number) => p + (q - p) * t;
    const ax = l(x0, x1), ay = l(y0, y1), bx = l(x1, x2), by = l(y1, y2), cx = l(x2, x3), cy = l(y2, y3);
    const dx = l(ax, bx), dy = l(ay, by), ex = l(bx, cx), ey = l(by, cy), fx = l(dx, ex), fy = l(dy, ey);
    first.ox = ax - x0; first.oy = ay - y0;
    out.push(first);
    first = { x: fx, y: fy, ix: dx - fx, iy: dy - fy, ox: 0, oy: 0 };
    [x0, y0, x1, y1, x2, y2] = [fx, fy, ex, ey, cx, cy];
  }
  first.ox = x1 - x0; first.oy = y1 - y0;
  out.push(first);
  // the end vertex keeps its own out-handle; its in-handle is the last piece's
  b.ix = x2 - x3; b.iy = y2 - y3;
  return out;
}
/** Adds vertices so the outline has `total` of them, spread by segment length (the shape does not change). */
function densify(v0: V[], closed: boolean, total: number): V[] {
  const v = v0.map((p) => ({ ...p }));
  const n = closed ? v.length : v.length - 1;
  if (total <= v.length || n < 1) return v;
  const lens = Array.from({ length: n }, (_, i) => segLen(v[i], v[(i + 1) % v.length]));
  const sum = lens.reduce((a, b) => a + b, 0) || 1;
  const extra = total - v.length;
  // pieces per segment: at least 1, the extra vertices by length (largest remainders)
  const share = lens.map((L) => (L / sum) * extra), pieces = share.map((s) => 1 + Math.floor(s));
  let left = extra - pieces.reduce((a, b) => a + b - 1, 0);
  share.map((s, i) => [s - Math.floor(s), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { pieces[i]++; left--; } });
  const out: V[] = [];
  for (let i = 0; i < n; i++) out.push(...subdivide(v[i], v[(i + 1) % v.length], pieces[i]));
  if (!closed) out.push(v[v.length - 1]);
  else out[0].ix = v[0].ix, out[0].iy = v[0].iy;
  return out;
}
const perimeter = (v: V[], closed: boolean) => { let L = 0; for (let i = 0; i < (closed ? v.length : v.length - 1); i++) L += segLen(v[i], v[(i + 1) % v.length]); return L; };

// ───────────────────────── matching (work of stretching + bending) ─────────────────────────
const ang = (ax: number, ay: number, bx: number, by: number) => Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
/** Correspondence between closed outlines A and B as a cyclic list of index pairs (monotone, wrapping once). */
function match(A: V[], B: V[], o: { bending: number; quality: number; firstMatch: boolean }): [number, number][] {
  const n = A.length, m = B.length;
  const kb = o.bending / 100, ks = 1 - kb, cs = 0.5, mp = 10;
  // edge lengths and turning angles of each outline (vertex i: angle between edge i−1 and edge i)
  const edge = (P: V[], i: number) => { const a = P[i % P.length], b = P[(i + 1) % P.length]; return [b.x - a.x, b.y - a.y]; };
  const turn = (P: V[], i: number) => { const e0 = edge(P, i - 1 + P.length), e1 = edge(P, i); return ang(e0[0], e0[1], e1[0], e1[1]); };
  const tA = A.map((_, i) => turn(A, i)), tB = B.map((_, i) => turn(B, i));
  const lA = A.map((_, i) => Math.hypot(...edge(A, i))), lB = B.map((_, i) => Math.hypot(...edge(B, i)));
  const scale = (lA.reduce((a, b) => a + b, 0) + lB.reduce((a, b) => a + b, 0)) / (n + m) || 1;
  const stretch = (L0: number, L1: number) => { const d = (L1 - L0) / scale; return ks * (d * d) / ((1 - cs) * Math.min(L0, L1) / scale + cs * Math.max(L0, L1) / scale + 1e-6); };
  // bending: change of turning angle, and a penalty when it flips side (the outline would fold over)
  const bend = (a: number, b: number) => { const d = Math.abs(b - a), flip = a * b < 0 && Math.abs(a) + Math.abs(b) > 0.2 ? 1 : 0; return kb * (d + mp * flip * Math.min(Math.abs(a), Math.abs(b))) ** 2; };
  const band = Math.max(0, Math.round((o.quality / 100) * Math.max(n, m)));
  const run = (s: number): { cost: number; path: [number, number][] } => {
    // DP over (i in A, j in B shifted by s); moves: both advance, only A, only B (the other vertex repeats)
    const W = n + 1, H = m + 1, INF = Infinity;
    const D = new Float64Array(W * H).fill(INF), from = new Int8Array(W * H);
    D[0] = 0;
    const jb = (j: number) => (j + s) % m;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
      const k = i * H + j, here = D[k];
      if (here === INF) continue;
      const diag = Math.abs(i / n - j / m) * Math.max(n, m);
      if (diag > band + 1e-9 && !(i === 0 && j === 0)) { D[k] = INF; continue; }
      const step = (di: number, dj: number, code: number) => {
        const ni = i + di, nj = j + dj;
        if (ni > n || nj > m) return;
        const L0 = di ? lA[i % n] : 0, L1 = dj ? lB[jb(j)] : 0;
        let c = stretch(L0, L1);
        if (ni < n || nj < m) c += bend(tA[ni % n], tB[jb(nj)]);
        const nk = ni * H + nj;
        if (here + c < D[nk]) { D[nk] = here + c; from[nk] = code; }
      };
      step(1, 1, 1); step(1, 0, 2); step(0, 1, 3);
    }
    const path: [number, number][] = [];
    let i = n, j = m;
    if (D[n * H + m] === INF) return { cost: INF, path };
    while (i > 0 || j > 0) { path.push([i % n, jb(j % m)]); const f = from[i * H + j]; if (f === 1) { i--; j--; } else if (f === 2) i--; else j--; }
    return { cost: D[n * H + m], path: path.reverse() };
  };
  let best = run(0);
  if (!o.firstMatch) for (let s = 1; s < m; s++) { const r = run(s); if (r.cost < best.cost) best = r; }
  return best.path.length ? best.path : A.map((_, i) => [i, Math.round((i * m) / n) % m]);
}

// ───────────────────────── in-between outlines ─────────────────────────
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** Vertex paths on straight lines (handles too). */
function linearAt(A: V[], B: V[], u: number): V[] {
  return A.map((a, i) => { const b = B[i]; return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), ix: lerp(a.ix, b.ix, u), iy: lerp(a.iy, b.iy, u), ox: lerp(a.ox, b.ox, u), oy: lerp(a.oy, b.oy, u) }; });
}
/** Intrinsic interpolation: edge lengths and directions (unwrapped) interpolate, the outline is closed by the
 *  least relative change of lengths, and its centroid travels in a straight line. */
function intrinsicAt(A: V[], B: V[], u: number, closed: boolean): V[] {
  const n = A.length, ne = closed ? n : n - 1;
  const dirs: number[] = [], lens: number[] = [], wts: number[] = [];
  let prevA = 0, prevB = 0;
  for (let k = 0; k < ne; k++) {
    const a0 = A[k], a1 = A[(k + 1) % n], b0 = B[k], b1 = B[(k + 1) % n];
    let ta = Math.atan2(a1.y - a0.y, a1.x - a0.x), tb = Math.atan2(b1.y - b0.y, b1.x - b0.x);
    // unwrap along the outline so turning stays continuous (zero-length edges take the previous direction)
    const la = Math.hypot(a1.x - a0.x, a1.y - a0.y), lb = Math.hypot(b1.x - b0.x, b1.y - b0.y);
    if (k === 0) { tb = ta + Math.atan2(Math.sin(tb - ta), Math.cos(tb - ta)); }
    else { if (la < 1e-9) ta = prevA; else ta = prevA + Math.atan2(Math.sin(ta - prevA), Math.cos(ta - prevA)); if (lb < 1e-9) tb = prevB; else tb = prevB + Math.atan2(Math.sin(tb - prevB), Math.cos(tb - prevB)); }
    prevA = ta; prevB = tb;
    dirs.push(lerp(ta, tb, u)); lens.push(lerp(la, lb, u)); wts.push(Math.max(la, lb, 1e-3));
  }
  if (closed) {
    // closure: change lengths by s_k = −w_k (λ · d_k) so Σ (L_k + s_k) d_k = 0
    let ex = 0, ey = 0, sxx = 0, sxy = 0, syy = 0;
    for (let k = 0; k < ne; k++) { const dx = Math.cos(dirs[k]), dy = Math.sin(dirs[k]); ex += lens[k] * dx; ey += lens[k] * dy; sxx += wts[k] * dx * dx; sxy += wts[k] * dx * dy; syy += wts[k] * dy * dy; }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) > 1e-9) { const lx = (syy * ex - sxy * ey) / det, ly = (sxx * ey - sxy * ex) / det; for (let k = 0; k < ne; k++) lens[k] -= wts[k] * (lx * Math.cos(dirs[k]) + ly * Math.sin(dirs[k])); }
  }
  const out: V[] = [{ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }];
  for (let k = 0; k < n - 1; k++) { const p = out[k]; out.push({ x: p.x + lens[k] * Math.cos(dirs[k]), y: p.y + lens[k] * Math.sin(dirs[k]), ix: 0, iy: 0, ox: 0, oy: 0 }); }
  // centroid on a straight line between the keys' centroids
  const cen = (P: V[]) => [P.reduce((a, p) => a + p.x, 0) / P.length, P.reduce((a, p) => a + p.y, 0) / P.length];
  const [cax, cay] = cen(A), [cbx, cby] = cen(B), [cox, coy] = cen(out), tx = lerp(cax, cbx, u) - cox, ty = lerp(cay, cby, u) - coy;
  // handles: interpolated in the frame of their edge (they turn with it)
  return out.map((p, i) => {
    const e = dirs[Math.min(i, ne - 1)], ep = dirs[(i - 1 + ne) % ne];
    const polar = (hx: number, hy: number, baseAng: number) => [Math.hypot(hx, hy), Math.atan2(hy, hx) - baseAng] as const;
    const edgeAng = (P: V[], j: number) => { const q0 = P[j], q1 = P[(j + 1) % n]; return Math.atan2(q1.y - q0.y, q1.x - q0.x); };
    const a = A[i], b = B[i];
    const jo = Math.min(i, ne - 1), ji = (i - 1 + ne) % ne;
    const [loa, aoa] = polar(a.ox, a.oy, edgeAng(A, jo)), [lob, aob] = polar(b.ox, b.oy, edgeAng(B, jo));
    const [lia, aia] = polar(a.ix, a.iy, edgeAng(A, ji)), [lib, aib] = polar(b.ix, b.iy, edgeAng(B, ji));
    const wrap = (x: number, y: number) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x));
    const lo = lerp(loa, lob, u), ao = lerp(aoa, wrap(aoa, aob), u) + e, li = lerp(lia, lib, u), ai = lerp(aia, wrap(aia, aib), u) + ep;
    return { x: p.x + tx, y: p.y + ty, ix: li * Math.cos(ai), iy: li * Math.sin(ai), ox: lo * Math.cos(ao), oy: lo * Math.sin(ao) };
  });
}

/** The two keyframe paths with matched vertices (same count), and the in-between outline at u ∈ (0, 1). */
export function smartMaskPair(pathA: number[], pathB: number[], closed: boolean, opts: SmartMaskOptions = {}): { a: number[]; b: number[]; at: (u: number) => number[] } {
  // options left out (or undefined) take the assistant defaults
  const o = { ...SMART_MASK_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as typeof SMART_MASK_DEFAULTS;
  let A = toV(pathA), B = toV(pathB);
  if (A.length < 2 || B.length < 2) throw new Error('Las máscaras necesitan al menos 2 vértices.');
  const curve = o.matching === 'curve' || (o.matching === 'auto' && (hasHandles(A) || hasHandles(B)));
  // polyline matching: the outlines as straight segments through their vertices (handles are dropped)
  if (!curve) { A = A.map((p) => ({ ...p, ix: 0, iy: 0, ox: 0, oy: 0 })); B = B.map((p) => ({ ...p, ix: 0, iy: 0, ox: 0, oy: 0 })); }
  let pairs: [number, number][];
  if (o.oneToOne && A.length === B.length) {
    // each original segment pair gets the same number of pieces: vertex k of A stays on vertex k of B
    const n = closed ? A.length : A.length - 1, per = (v: V[], i: number) => segLen(v[i], v[(i + 1) % v.length]);
    const spacing = o.addVertices ? (o.addVertices.mode === 'pixels' ? Math.max(1, o.addVertices.value) : Math.max(perimeter(A, closed), perimeter(B, closed)) / Math.max(2, o.addVertices.mode === 'total' ? o.addVertices.value : 100 / Math.max(0.1, o.addVertices.value))) : Infinity;
    const outA: V[] = [], outB: V[] = [];
    const a2 = A.map((p) => ({ ...p })), b2 = B.map((p) => ({ ...p }));
    for (let i = 0; i < n; i++) {
      const k = Number.isFinite(spacing) ? Math.max(1, Math.round(Math.max(per(A, i), per(B, i)) / spacing)) : 1;
      outA.push(...subdivide(a2[i], a2[(i + 1) % a2.length], k)); outB.push(...subdivide(b2[i], b2[(i + 1) % b2.length], k));
    }
    if (!closed) { outA.push(a2[a2.length - 1]); outB.push(b2[b2.length - 1]); } else { outA[0].ix = a2[0].ix; outA[0].iy = a2[0].iy; outB[0].ix = b2[0].ix; outB[0].iy = b2[0].iy; }
    A = outA; B = outB;
    pairs = A.map((_, i) => [i, i]);
  } else {
    if (o.addVertices) {
      const LA = perimeter(A, closed), LB = perimeter(B, closed);
      const want = o.addVertices.mode === 'pixels' ? Math.ceil(Math.max(LA, LB) / Math.max(1, o.addVertices.value))
        : o.addVertices.mode === 'total' ? Math.round(o.addVertices.value) : Math.ceil(100 / Math.max(0.1, o.addVertices.value));
      const N = Math.max(A.length, B.length, Math.min(2500, want));
      A = densify(A, closed, N); B = densify(B, closed, N);
    }
    if (!closed) {
      // open paths: ends correspond; the shorter list repeats vertices evenly
      const N = Math.max(A.length, B.length);
      pairs = Array.from({ length: N }, (_, i) => [Math.round((i * (A.length - 1)) / (N - 1)), Math.round((i * (B.length - 1)) / (N - 1))]);
    } else pairs = match(A, B, { bending: o.bending, quality: o.quality, firstMatch: o.firstMatch });
  }
  // both keys rebuilt on the matched list: a vertex matched several times repeats (its handles on the ends)
  const build = (P: V[], idx: number[]) => idx.map((i, k) => {
    const p = { ...P[i] };
    if (idx[k - 1] === i) { p.ix = 0; p.iy = 0; }
    if (idx[(k + 1) % idx.length] === i && (closed || k + 1 < idx.length)) { p.ox = 0; p.oy = 0; }
    return p;
  });
  const MA = build(A, pairs.map((x) => x[0])), MB = build(B, pairs.map((x) => x[1]));
  return {
    a: flat(MA), b: flat(MB),
    at: (u: number) => flat(o.linear ? linearAt(MA, MB, u) : intrinsicAt(MA, MB, u, closed)),
  };
}
