// «Trazado automático» (After Effects' Layer > Auto-trace): the outlines of a layer's channel turned into mask paths.
// Own code: channel → optional blur → marching squares at the threshold (sub-pixel crossings) → minimum-area filter
// → corners found on a tolerance-simplified polygon (corner roundness decides how sharp a turn must be) → cubic
// beziers fitted between corners within the tolerance (least squares + Newton reparameterisation, split at the worst
// point). Pure TypeScript: runs in the renderer (pixels) and in the unit tests.

export type TraceChannel = 'alpha' | 'red' | 'green' | 'blue' | 'luminance';
export interface TraceOptions {
  channel: TraceChannel;
  invert: boolean;
  /** px of blur before tracing (0 = off) */
  blur: number;
  /** px the path may stray from the outline */
  tolerance: number;
  /** % of the channel's range that counts as inside */
  threshold: number;
  /** px² — smaller features are dropped */
  minArea: number;
  /** % — 0 = straight segments, higher = rounder corners */
  cornerRoundness: number;
}
/** After Effects' defaults (Auto-trace dialog). */
export const TRACE_DEFAULTS: TraceOptions = { channel: 'alpha', invert: false, blur: 1, tolerance: 1, threshold: 50, minArea: 10, cornerRoundness: 50 };
export const TRACE_CHANNELS: { id: TraceChannel; name: string }[] = [
  { id: 'alpha', name: 'Alfa' }, { id: 'red', name: 'Rojo' }, { id: 'green', name: 'Verde' }, { id: 'blue', name: 'Azul' }, { id: 'luminance', name: 'Luminancia' },
];

/** The traced channel as 0..1 (colour channels count only where the pixel is opaque). */
export function channelField(rgba: ArrayLike<number>, w: number, h: number, ch: TraceChannel, invert: boolean): Float32Array {
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3] / 255;
    let v = ch === 'alpha' ? a : ch === 'red' ? (r / 255) * a : ch === 'green' ? (g / 255) * a : ch === 'blue' ? (b / 255) * a : ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * a;
    if (invert) v = 1 - v;
    f[i] = v;
  }
  return f;
}

/** Three box blurs ≈ a gaussian of the given radius (edges clamp). */
export function blurField(f: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (!r) return f;
  let a = Float32Array.from(f), b = new Float32Array(w * h);
  const pass = (src: Float32Array, dst: Float32Array, horiz: boolean) => {
    const n = horiz ? w : h, m = horiz ? h : w, k = 1 / (2 * r + 1);
    for (let j = 0; j < m; j++) {
      const at = (i: number) => src[horiz ? j * w + Math.max(0, Math.min(n - 1, i)) : Math.max(0, Math.min(n - 1, i)) * w + j];
      let s = 0;
      for (let i = -r; i <= r; i++) s += at(i);
      for (let i = 0; i < n; i++) { dst[horiz ? j * w + i : i * w + j] = s * k; s += at(i + r + 1) - at(i - r); }
    }
  };
  for (let p = 0; p < 3; p++) { pass(a, b, true); pass(b, a, false); }
  return a;
}

/** Closed outlines of the region f ≥ level, as flat point lists [x0, y0, x1, y1, …] in image pixels (pixel centres at
 *  +0.5). Outer outlines and holes turn opposite ways; the image border closes everything. */
export function marchingSquares(f: Float32Array, w: number, h: number, level: number): number[][] {
  const PW = w + 2, PH = h + 2;
  const pad = Math.min(0, level - 1e-3);
  const val = (i: number, j: number) => (i <= 0 || j <= 0 || i > w || j > h ? pad : f[(j - 1) * w + (i - 1)]);
  const inside = new Uint8Array(PW * PH);
  for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) inside[j * PW + i] = val(i, j) >= level ? 1 : 0;
  const next = new Int32Array(PW * PH * 2).fill(-1);
  // corners of edge key k
  const ends = (k: number): [number, number, number, number] => { const c = k >> 1, i = c % PW, j = (c - i) / PW; return k & 1 ? [i, j, i, j + 1] : [i, j, i + 1, j]; };
  const pt = (k: number): [number, number] => {
    const [i0, j0, i1, j1] = ends(k), a = val(i0, j0), b = val(i1, j1);
    const t = b === a ? 0.5 : Math.max(0, Math.min(1, (level - a) / (b - a)));
    return [i0 + (i1 - i0) * t - 0.5, j0 + (j1 - j0) * t - 0.5];
  };
  const starts: number[] = [];
  for (let j = 0; j < PH - 1; j++) for (let i = 0; i < PW - 1; i++) {
    const tl = inside[j * PW + i], tr = inside[j * PW + i + 1], br = inside[(j + 1) * PW + i + 1], bl = inside[(j + 1) * PW + i];
    const sum = tl + tr + br + bl;
    if (sum === 0 || sum === 4) continue;
    // clockwise: top (tl→tr), right (tr→br), bottom (br→bl), left (bl→tl)
    const e = [(j * PW + i) * 2, (j * PW + i + 1) * 2 + 1, ((j + 1) * PW + i) * 2, (j * PW + i) * 2 + 1];
    const c = [tl, tr, br, bl];
    const cross: { k: number; enter: boolean }[] = [];
    for (let s = 0; s < 4; s++) { const a = c[s], b = c[(s + 1) % 4]; if (a !== b) cross.push({ k: e[s], enter: !a }); }
    if (cross.length === 2) { const en = cross[0].enter ? cross[0] : cross[1], ex = cross[0].enter ? cross[1] : cross[0]; next[en.k] = ex.k; starts.push(en.k); continue; }
    const centre = (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4 >= level;
    for (let s = 0; s < 4; s++) {
      if (!cross[s].enter) continue;
      const ex = centre ? cross[(s + 3) % 4] : cross[(s + 1) % 4];
      next[cross[s].k] = ex.k;
      starts.push(cross[s].k);
    }
  }
  const out: number[][] = [];
  const seen = new Uint8Array(next.length);
  for (const s of starts) {
    if (seen[s]) continue;
    const poly: number[] = [];
    let k = s, guard = 0;
    while (k >= 0 && !seen[k] && guard++ < next.length) { seen[k] = 1; const p = pt(k); poly.push(p[0], p[1]); k = next[k]; }
    if (poly.length >= 6) out.push(poly);
  }
  return out;
}

/** Signed area (shoelace) of a closed flat point list. */
export function polyArea(p: number[]): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) { const j = (i + 2) % n; a += p[i] * p[j + 1] - p[j] * p[i + 1]; }
  return a / 2;
}
function pointIn(p: number[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Douglas–Peucker on a closed outline: indices of the points kept (within tol px). */
export function simplifyClosed(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n <= 3) return Array.from({ length: n }, (_, i) => i);
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const rdp = (a: number, b: number) => {
    // b may wrap past the end (b > n − 1 means index b − n)
    const stack: [number, number][] = [[a, b]];
    while (stack.length) {
      const [s, e] = stack.pop()!;
      if (e - s < 2) continue;
      const ax = p[(s % n) * 2], ay = p[(s % n) * 2 + 1], bx = p[(e % n) * 2], by = p[(e % n) * 2 + 1];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      let best = -1, bd = -1;
      for (let i = s + 1; i < e; i++) {
        const x = p[(i % n) * 2], y = p[(i % n) * 2 + 1];
        const d = L > 1e-9 ? Math.abs(dy * (x - ax) - dx * (y - ay)) / L : Math.hypot(x - ax, y - ay);
        if (d > bd) { bd = d; best = i; }
      }
      if (bd > tol) { keep[best % n] = 1; stack.push([s, best], [best, e]); }
    }
  };
  rdp(0, far);
  rdp(far, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// ───────────────────────── bezier fitting ─────────────────────────
type V = [number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
const mulv = (a: V, k: number): V => [a[0] * k, a[1] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const unit = (a: V): V => { const l = Math.hypot(a[0], a[1]); return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0]; };
const bez = (b: V[], t: number): V => { const s = 1 - t; return [s * s * s * b[0][0] + 3 * s * s * t * b[1][0] + 3 * s * t * t * b[2][0] + t * t * t * b[3][0], s * s * s * b[0][1] + 3 * s * s * t * b[1][1] + 3 * s * t * t * b[2][1] + t * t * t * b[3][1]]; };
const bez1 = (b: V[], t: number): V => { const s = 1 - t; return [3 * (s * s * (b[1][0] - b[0][0]) + 2 * s * t * (b[2][0] - b[1][0]) + t * t * (b[3][0] - b[2][0])), 3 * (s * s * (b[1][1] - b[0][1]) + 2 * s * t * (b[2][1] - b[1][1]) + t * t * (b[3][1] - b[2][1]))]; };
const bez2 = (b: V[], t: number): V => [6 * ((1 - t) * (b[2][0] - 2 * b[1][0] + b[0][0]) + t * (b[3][0] - 2 * b[2][0] + b[1][0])), 6 * ((1 - t) * (b[2][1] - 2 * b[1][1] + b[0][1]) + t * (b[3][1] - 2 * b[2][1] + b[1][1]))];

function generate(d: V[], u: number[], t1: V, t2: V): V[] {
  const p0 = d[0], p3 = d[d.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < d.length; i++) {
    const t = u[i], s = 1 - t, b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const a0 = mulv(t1, b1), a1 = mulv(t2, b2);
    c00 += dot(a0, a0); c01 += dot(a0, a1); c11 += dot(a1, a1);
    const tmp = sub(d[i], add(mulv(p0, b0 + b1), mulv(p3, b2 + b3)));
    x0 += dot(a0, tmp); x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01, seg = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  let al = det ? (x0 * c11 - x1 * c01) / det : 0, ar = det ? (c00 * x1 - c01 * x0) / det : 0;
  if (!det || al < seg * 1e-6 || ar < seg * 1e-6) al = ar = seg / 3;
  return [p0, add(p0, mulv(t1, al)), add(p3, mulv(t2, ar)), p3];
}
function fitCubic(d: V[], t1: V, t2: V, err2: number, out: V[][], depth = 0) {
  if (d.length === 2 || depth > 24) { const k = Math.hypot(d[d.length - 1][0] - d[0][0], d[d.length - 1][1] - d[0][1]) / 3; out.push([d[0], add(d[0], mulv(t1, k)), add(d[d.length - 1], mulv(t2, k)), d[d.length - 1]]); return; }
  const u = [0];
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + Math.hypot(d[i][0] - d[i - 1][0], d[i][1] - d[i - 1][1]));
  const L = u[u.length - 1] || 1;
  for (let i = 0; i < u.length; i++) u[i] /= L;
  let b = generate(d, u, t1, t2);
  const worst = (): [number, number] => { let m = 0, at = Math.floor(d.length / 2); for (let i = 1; i < d.length - 1; i++) { const q = sub(bez(b, u[i]), d[i]); const e = dot(q, q); if (e >= m) { m = e; at = i; } } return [m, at]; };
  let [m, at] = worst();
  if (m < err2) { out.push(b); return; }
  if (m < err2 * 16) {
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < u.length; i++) {
        const q = sub(bez(b, u[i]), d[i]), q1 = bez1(b, u[i]), q2 = bez2(b, u[i]);
        const den = dot(q1, q1) + dot(q, q2);
        if (Math.abs(den) > 1e-12) u[i] = Math.max(0, Math.min(1, u[i] - dot(q, q1) / den));
      }
      b = generate(d, u, t1, t2);
      [m, at] = worst();
      if (m < err2) { out.push(b); return; }
    }
  }
  at = Math.max(1, Math.min(d.length - 2, at));
  const tc = unit(sub(d[at - 1], d[at + 1]));
  fitCubic(d.slice(0, at + 1), t1, tc, err2, out, depth + 1);
  fitCubic(d.slice(at), mulv(tc, -1), t2, err2, out, depth + 1);
}

/** Turning angle (degrees) at polygon vertex b. */
const turn = (a: V, b: V, c: V) => { const u = unit(sub(b, a)), v = unit(sub(c, b)); return (Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * 180) / Math.PI; };

/** A traced outline → closed flat bezier [x, y, inX, inY, outX, outY, …]: straight segments at 0 % roundness; else
 *  cubic curves fitted within `tol` px between the corners (turns sharper than the roundness allows). */
export function fitOutline(p: number[], tol: number, roundness: number): number[] {
  const n = p.length / 2;
  const P = (i: number): V => [p[((i % n) + n) % n * 2], p[((i % n) + n) % n * 2 + 1]];
  const keep = simplifyClosed(p, Math.max(0.05, tol));
  if (roundness <= 0 || n < 8 || keep.length < 3) { const out: number[] = []; for (const i of keep) out.push(...P(i), 0, 0, 0, 0); return out; }
  const limit = 30 + Math.min(100, roundness) * 1.0;
  const corners = keep.filter((idx, k) => turn(P(keep[(k - 1 + keep.length) % keep.length]), P(idx), P(keep[(k + 1) % keep.length])) > limit);
  const segs: V[][] = [];
  const err2 = Math.max(0.05, tol) ** 2;
  // tangent at a corner: towards the neighbouring vertex of the simplified polygon (a chamfered pixel corner does
  // not tilt it)
  const tangentAt = (i: number, dir: 1 | -1): V => { const k = keep.indexOf(((i % n) + n) % n); return unit(sub(P(keep[(k + dir + keep.length) % keep.length]), P(i))); };
  if (!corners.length) {
    // smooth all round: start at the simplified polygon's first point with its central tangent
    const s = keep[0], pts: V[] = [];
    for (let i = 0; i <= n; i++) pts.push(P(s + i));
    const tc = unit(sub(P(s + 1), P(s - 1)));
    fitCubic(pts, tc, mulv(tc, -1), err2, segs);
  } else {
    for (let k = 0; k < corners.length; k++) {
      const a = corners[k], b0 = corners[(k + 1) % corners.length], b = b0 > a ? b0 : b0 + n;
      const pts: V[] = [];
      for (let i = a; i <= b; i++) pts.push(P(i));
      if (pts.length < 2) continue;
      if (pts.length <= 3) { const k3 = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) / 3, t1 = unit(sub(pts[pts.length - 1], pts[0])); segs.push([pts[0], add(pts[0], mulv(t1, k3)), sub(pts[pts.length - 1], mulv(t1, k3)), pts[pts.length - 1]]); continue; }
      fitCubic(pts, tangentAt(a, 1), tangentAt(b, -1), err2, segs);
    }
  }
  // segments → vertices with relative tangents (a straight segment keeps zero tangents)
  const out: number[] = [];
  for (const s of segs) out.push(s[0][0], s[0][1], 0, 0, s[1][0] - s[0][0], s[1][1] - s[0][1]);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], j = ((i + 1) % segs.length) * 6;
    out[j + 2] = s[2][0] - s[3][0]; out[j + 3] = s[2][1] - s[3][1];
  }
  return out;
}

export interface TracedPath { path: number[]; area: number; depth: number; hole: boolean }
/** Auto-trace of an RGBA image: the outlines (image pixels), outer ones first then holes by nesting depth. */
export function autoTraceImage(rgba: ArrayLike<number>, w: number, h: number, o0: Partial<TraceOptions> = {}): TracedPath[] {
  const o = { ...TRACE_DEFAULTS, ...o0 };
  let f = channelField(rgba, w, h, o.channel, o.invert);
  if (o.blur > 0) f = blurField(f, w, h, o.blur);
  const level = Math.max(0.001, Math.min(0.999, o.threshold / 100));
  const polys = marchingSquares(f, w, h, level).map((p) => ({ p, area: Math.abs(polyArea(p)) })).filter((x) => x.area >= Math.max(0, o.minArea));
  polys.sort((a, b) => b.area - a.area);
  const simple = polys.map((x) => simplifyClosed(x.p, 1).flatMap((i) => [x.p[i * 2], x.p[i * 2 + 1]]));
  return polys.map((x, i) => {
    let depth = 0;
    // only bigger outlines can contain this one
    for (let j = 0; j < i; j++) if (pointIn(simple[j], x.p[0], x.p[1])) depth++;
    return { path: fitOutline(x.p, o.tolerance, o.cornerRoundness), area: x.area, depth, hole: depth % 2 === 1 };
  }).sort((a, b) => a.depth - b.depth || b.area - a.area);
}
