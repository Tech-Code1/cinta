// After Effects' keyframe velocity: the speed (value change per second at the key) and the influence (% of the
// segment's duration) of each side of a key, read from — and written back to — the normalised bezier handles
// Key.eo / Key.ei the evaluator uses (the storage format does not change). Like After Effects, spatial properties
// (position, anchor point, points of interest) measure the speed along the motion path, the others per dimension.
// In Cinta every dimension of a vector property shares one easing curve per segment, so the speeds of its
// dimensions keep the proportions of the segment's change: setting one sets the others.
// Also: Easy Ease / linear / hold / auto-bezier with After Effects' semantics, the speed graph samples and
// Separate Dimensions of Position (X / Y / Z as independent properties, keyframes converted both ways).
import { bezierEase, keyedAt, segmentLength, EASE_IN, EASE_OUT, LINEAR_IN, LINEAR_OUT } from './anim';
import type { Key, Layer, Prop } from './model';

export type Handle = [number, number];
/** After Effects shows a linear side as influence 16.67 % at the segment's average speed. */
export const LIN = 1 / 6;
const MIN_INF = 0.001;

/** Effective handles of the segment k0 → k1, as the evaluator uses them (null: hold). */
export function segHandles(k0: Key, k1: Key): { eo: Handle; ei: Handle } | null {
  const i = k0.i ?? 'linear';
  if (i === 'hold') return null;
  if (i === 'linear' && !k0.eo && !k1.ei) return { eo: [LIN, LIN], ei: [1 - LIN, 1 - LIN] };
  return { eo: [...(k0.eo ?? (i === 'linear' ? LINEAR_OUT : EASE_OUT))] as Handle, ei: [...(k1.ei ?? (i === 'linear' ? LINEAR_IN : EASE_IN))] as Handle };
}
/** Writes the effective handles of a segment into its keys (so changing one side keeps the other as it was). */
function materialize(k0: Key, k1: Key) {
  const h = segHandles(k0, k1);
  if (!h) { k0.i = 'bezier'; k0.eo = [LIN, LIN]; k1.ei = [1 - LIN, 1 - LIN]; return; }
  k0.eo = h.eo; k1.ei = h.ei;
}
/** Both handles on the diagonal: the segment is plain linear again. */
function tidy(k0: Key, k1: Key) {
  if (k0.i === 'hold' || !k0.eo || !k1.ei) return;
  if (Math.abs(k0.eo[0] - k0.eo[1]) < 1e-9 && Math.abs(k1.ei[0] - k1.ei[1]) < 1e-9) { delete k0.eo; delete k1.ei; k0.i = 'linear'; }
}

/** What kind of speed a property has: spatial (one speed along the path) or per dimension. */
export function velKind(prop: Prop, spatial: boolean): { spatial: boolean; dims: number } {
  const v = prop.k?.[0]?.v ?? prop.v;
  if (typeof v === 'number') return { spatial: false, dims: 1 };
  if (Array.isArray(v)) return spatial ? { spatial: true, dims: 1 } : { spatial: false, dims: v.length };
  throw new Error('Esta propiedad no tiene velocidad (colores y texto no se interpolan con velocidad).');
}
/** Change of the segment i → i+1 per dimension (spatial: its length along the motion path). */
export function segDeltas(keys: Key[], i: number, spatial: boolean, dims: number): number[] {
  const a = keys[i].v, b = keys[i + 1].v;
  if (spatial) return [segmentLength(keys, i)];
  if (typeof a === 'number') return [Number(b) - a];
  return Array.from({ length: dims }, (_, d) => Number((b as number[])[d] ?? 0) - Number((a as number[])[d] ?? 0));
}
/** dimension with the largest change (the one whose speed drives the shared curve) */
export const primaryDim = (ds: number[]) => ds.reduce((best, x, i) => (Math.abs(x) > Math.abs(ds[best]) ? i : best), 0);

export interface Side { speed: number[]; influence: number }
export interface KeyVel {
  index: number; t: number; dims: number; spatial: boolean;
  /** null: no segment on that side, or a hold one */
  in: Side | null; out: Side | null;
  continuous: boolean; autoBezier: boolean;
}
const outSlope = (h: { eo: Handle }) => h.eo[1] / Math.max(MIN_INF, h.eo[0]);
const inSlope = (h: { ei: Handle }) => (1 - h.ei[1]) / Math.max(MIN_INF, 1 - h.ei[0]);

/** Speed (units per second) and influence (%) of both sides of key `idx`. */
export function keyVelocity(prop: Prop, idx: number, spatial0: boolean): KeyVel {
  const ks = prop.k ?? [];
  const k = ks[idx];
  if (!k) throw new Error(`No existe el fotograma clave ${idx + 1} (hay ${ks.length}).`);
  const { spatial, dims } = velKind(prop, spatial0);
  const side = (i: number, which: 'in' | 'out'): Side | null => {
    const k0 = ks[i], k1 = ks[i + 1];
    if (!k0 || !k1) return null;
    const h = segHandles(k0, k1);
    if (!h) return null;
    const dt = k1.t - k0.t || 1, slope = which === 'out' ? outSlope(h) : inSlope(h);
    return { speed: segDeltas(ks, i, spatial, dims).map((x) => (slope * x) / dt), influence: (which === 'out' ? h.eo[0] : 1 - h.ei[0]) * 100 };
  };
  return { index: idx, t: k.t, dims, spatial, in: side(idx - 1, 'in'), out: side(idx, 'out'), continuous: !!k.tc, autoBezier: !!k.ta };
}

export interface SideIn { speed?: number | number[]; influence?: number }
/** Sets speed / influence of one or both sides of key `idx` (speeds in units per second, influence in %). With
 *  continuous, a speed given for one side is copied to the other (After Effects' Continuous Bezier). */
export function setKeyVelocity(prop: Prop, idx: number, spatial0: boolean, o: { in?: SideIn; out?: SideIn; continuous?: boolean }) {
  const ks = prop.k ?? [];
  const k = ks[idx];
  if (!k) throw new Error(`No existe el fotograma clave ${idx + 1} (hay ${ks.length}).`);
  const { spatial, dims } = velKind(prop, spatial0);
  if (o.continuous !== undefined) { if (o.continuous) k.tc = true; else delete k.tc; }
  const cur = keyVelocity(prop, idx, spatial0);
  // a speed is a number (the dimension that changes most) or a list (per dimension: that one is used)
  let sin = o.in?.speed, sout = o.out?.speed;
  if (k.tc) {
    // continuous: the side without a speed takes the other's (spatial: along the path; else the same dimension)
    if (sout !== undefined && sin === undefined && cur.in) sin = sout;
    else if (sin !== undefined && sout === undefined && cur.out) sout = sin;
  }
  const apply = (which: 'in' | 'out', s: number | number[] | undefined, inf: number | undefined) => {
    const i0 = which === 'out' ? idx : idx - 1, k0 = ks[i0], k1 = ks[i0 + 1];
    if (!k0 || !k1 || (k0.i ?? 'linear') === 'hold') return;
    if (s === undefined && inf === undefined) return;
    const ds = segDeltas(ks, i0, spatial, dims), pd = primaryDim(ds), dt = k1.t - k0.t || 1;
    const now = which === 'out' ? cur.out : cur.in;
    const f = Math.max(MIN_INF, Math.min(1, (inf ?? now?.influence ?? 100 / 3) / 100));
    let sp = Array.isArray(s) ? (s.length === dims ? s[pd] : s[0]) : s ?? now?.speed[pd] ?? 0;
    if (spatial) sp = Math.max(0, sp);
    const slope = Math.abs(ds[pd]) > 1e-9 ? (sp * dt) / ds[pd] : 0;
    materialize(k0, k1);
    if (which === 'out') { k0.eo = [f, slope * f]; } else { k1.ei = [1 - f, 1 - slope * f]; }
    if (k0.i !== 'bezier') k0.i = 'bezier';
    tidy(k0, k1);
  };
  apply('out', sout, o.out?.influence);
  apply('in', sin, o.in?.influence);
  delete k.ta;
}

export type EaseKind = 'easy' | 'in' | 'out' | 'linear' | 'hold' | 'auto';
/** After Effects' keyframe assistants and interpolation buttons on keys `idxs` of a property:
 *  easy (F9, speed 0 and influence 33.33 % both sides), in (Shift+F9, incoming side only), out (Ctrl+Shift+F9,
 *  outgoing side only), linear, hold (outgoing) and auto (Auto Bezier: smooth speed from the neighbours, 16.67 %). */
export function easeKeysAE(prop: Prop, idxs: number[], kind: EaseKind, spatial: boolean) {
  const ks = prop.k ?? [];
  // auto-bezier speeds are read from the keys before any change
  const autos = kind === 'auto' ? idxs.map((i) => autoSpeed(prop, i, spatial)) : [];
  idxs.forEach((idx, n) => {
    const k = ks[idx], prev = ks[idx - 1], next = ks[idx + 1];
    if (!k) return;
    if (kind === 'hold') { k.i = 'hold'; delete k.tc; delete k.ta; return; }
    if (kind === 'auto') { setKeyVelocity(prop, idx, spatial, { in: { speed: autos[n], influence: LIN * 100 }, out: { speed: autos[n], influence: LIN * 100 } }); k.tc = true; k.ta = true; return; }
    delete k.ta;
    const doIn = kind !== 'out', doOut = kind !== 'in';
    if (doIn && prev && (prev.i ?? 'linear') !== 'hold') {
      materialize(prev, k);
      k.ei = kind === 'linear' ? [1 - LIN, 1 - LIN] : [2 / 3, 1];
      if (prev.i !== 'bezier') prev.i = 'bezier';
      tidy(prev, k);
    }
    if (doOut && next) {
      if ((k.i ?? 'linear') === 'hold') { k.i = 'bezier'; next.ei ??= [1 - LIN, 1 - LIN]; } else materialize(k, next);
      k.eo = kind === 'linear' ? [LIN, LIN] : [1 / 3, 0];
      k.i = 'bezier';
      tidy(k, next);
    } else if (doOut && k.i !== 'hold') k.i = kind === 'linear' ? 'linear' : 'bezier';
    if (kind === 'easy') k.tc = true; else if (kind !== 'linear') delete k.tc;
  });
}
/** Auto-bezier speed of a key: the slope through its neighbours (per dimension; spatial: along the path). */
function autoSpeed(prop: Prop, idx: number, spatial0: boolean): number[] {
  const ks = prop.k ?? [];
  const { spatial, dims } = velKind(prop, spatial0);
  const prev = ks[idx - 1], next = ks[idx + 1], k = ks[idx];
  if (!prev && !next) return Array(dims).fill(0);
  const a = prev ?? k, b = next ?? k, ia = prev ? idx - 1 : idx;
  const dt = b.t - a.t || 1;
  if (spatial) {
    let len = 0;
    if (prev) len += segmentLength(ks, idx - 1);
    if (next) len += segmentLength(ks, idx);
    return [len / dt];
  }
  void ia;
  const va = typeof a.v === 'number' ? [a.v] : (a.v as number[]), vb = typeof b.v === 'number' ? [b.v] : (b.v as number[]);
  return Array.from({ length: dims }, (_, d) => ((vb[d] ?? 0) - (va[d] ?? 0)) / dt);
}

// ───────────────────────── speed graph ─────────────────────────
/** dy/dx of the ease bezier (0,0) (x1,y1) (x2,y2) (1,1) at x = u */
export function bezierSlope(u: number, x1: number, y1: number, x2: number, y2: number): number {
  u = Math.max(0, Math.min(1, u));
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  // the parameter s with x(s) = u (bisection: x is monotonic for x1, x2 in [0, 1])
  let lo = 0, hi = 1, s = u;
  for (let i = 0; i < 50; i++) { s = (lo + hi) / 2; const x = ((ax * s + bx) * s + cx) * s; if (x < u) lo = s; else hi = s; }
  const dx = (3 * ax * s + 2 * bx) * s + cx, dy = (3 * ay * s + 2 * by) * s + cy;
  if (Math.abs(dx) < 1e-9) return s < 0.5 ? y1 / Math.max(MIN_INF, x1) : (1 - y2) / Math.max(MIN_INF, 1 - x2);
  return dy / dx;
}
/** Speed per dimension (spatial: along the path) at time t inside segment i (one-sided at its ends). */
export function speedIn(prop: Prop, i: number, t: number, spatial0: boolean): number[] {
  const ks = prop.k ?? [];
  const { spatial, dims } = velKind(prop, spatial0);
  const k0 = ks[i], k1 = ks[i + 1];
  if (!k0 || !k1) return Array(dims).fill(0);
  const h = segHandles(k0, k1);
  if (!h) return Array(dims).fill(0);
  const dt = k1.t - k0.t || 1, u = (t - k0.t) / dt;
  const rate = bezierSlope(u, h.eo[0], h.eo[1], h.ei[0], h.ei[1]);
  return segDeltas(ks, i, spatial, dims).map((x) => (rate * x) / dt);
}
/** Progress of a segment (shared by all dimensions) — for tests and the graph. */
export const progressAt = (k0: Key, k1: Key, t: number) => { const h = segHandles(k0, k1); if (!h) return 0; return bezierEase((t - k0.t) / (k1.t - k0.t || 1), h.eo[0], h.eo[1], h.ei[0], h.ei[1]); };

// ───────────────────────── Separate Dimensions ─────────────────────────
export const isSeparated = (l: Layer) => !!l.transform.positionX;
const TOL = 0.01;

/** Keys with straight segments reproducing g on [a, b] (both ends included): one easing curve fitted to the
 *  dimension that changes most from the speeds at the ends, halving the segment while it misses by more than tol. */
function fitSegment(g: (t: number) => number[], a: number, b: number, depth = 0): Key[] {
  const va = g(a), vb = g(b), n = va.length;
  const dv = vb.map((x, d) => x - va[d]), pd = primaryDim(dv);
  const val = (v: number[]) => (n === 1 ? v[0] : v);
  const hh = (b - a) * 1e-4;
  let k0: Key, k1: Key;
  if (Math.abs(dv[pd]) < 1e-9) { k0 = { t: a, v: val(va), i: 'linear' }; k1 = { t: b, v: val(vb) }; }
  else {
    const s0 = ((g(a + hh)[pd] - va[pd]) / hh) * ((b - a) / dv[pd]), s1 = ((vb[pd] - g(b - hh)[pd]) / hh) * ((b - a) / dv[pd]);
    k0 = { t: a, v: val(va), i: 'bezier', eo: [1 / 3, s0 / 3] }; k1 = { t: b, v: val(vb), ei: [2 / 3, 1 - s1 / 3] };
  }
  if (depth < 8 && b - a > 1e-3) {
    let err = 0;
    for (let j = 1; j < 16; j++) {
      const t = a + ((b - a) * j) / 16, p = k0.eo ? bezierEase(j / 16, k0.eo[0], k0.eo[1], k1.ei![0], k1.ei![1]) : j / 16, gt = g(t);
      for (let d = 0; d < n; d++) err = Math.max(err, Math.abs(va[d] + dv[d] * p - gt[d]));
    }
    if (err > TOL) return joinFits(fitSegment(g, a, (a + b) / 2, depth + 1), fitSegment(g, (a + b) / 2, b, depth + 1));
  }
  return [k0, k1];
}
/** Concatenates key lists whose ends meet (the shared key keeps the left side's incoming handle). */
function joinFits(a: Key[], b: Key[]): Key[] {
  if (!a.length) return b;
  const last = a[a.length - 1], first = b[0];
  const merged: Key = { ...first, ...(last.ei ? { ei: last.ei } : {}) };
  if (!last.ei) delete merged.ei;
  return [...a.slice(0, -1), merged, ...b.slice(1)];
}

/** Separar dimensiones: Position becomes Position X / Y / Z with the same motion (straight segments copy their
 *  easing exactly; curved motion paths are refitted per dimension, with extra keys where needed). */
export function separatePosition(l: Layer) {
  const tr = l.transform;
  if (tr.positionX) return;
  const pos = tr.position, ks = pos.k ?? [];
  const v0 = (pos.v as number[]) ?? [0, 0, 0];
  const lists: Key[][] = [[], [], []];
  const dimOf = (v: unknown, d: number) => Number((v as number[])[d] ?? 0);
  if (ks.length === 1) for (let d = 0; d < 3; d++) lists[d].push({ t: ks[0].t, v: dimOf(ks[0].v, d) });
  for (let i = 0; i + 1 < ks.length; i++) {
    const k0 = ks[i], k1 = ks[i + 1];
    const straight = k0.sl || k1.sl || ks.length < 3;
    for (let d = 0; d < 3; d++) {
      let seg: Key[];
      if ((k0.i ?? 'linear') === 'hold' || straight) {
        const a: Key = { t: k0.t, v: dimOf(k0.v, d) }, b: Key = { t: k1.t, v: dimOf(k1.v, d) };
        if (k0.i) a.i = k0.i;
        if (k0.eo) a.eo = [...k0.eo];
        if (k1.ei) b.ei = [...k1.ei];
        seg = [a, b];
      } else seg = fitSegment((t) => [dimOf(keyedAt(pos, t, true), d)], k0.t, k1.t);
      lists[d] = joinFits(lists[d], seg);
    }
  }
  const mk = (d: number): Prop<number> => (lists[d].length ? { v: lists[d][0].v as number, k: lists[d] } : { v: dimOf(v0, d) });
  tr.positionX = mk(0); tr.positionY = mk(1); tr.positionZ = mk(2);
  if (ks.length) pos.v = [...(ks[0].v as number[])];
  delete pos.k;
}

/** Joins Position X / Y / Z back into Position: keys at every time any of them had one, straight segments with the
 *  easing of the dimension that changes most (more keys where the dimensions eased differently). */
export function joinPosition(l: Layer) {
  const tr = l.transform;
  if (!tr.positionX) return;
  const P3 = [tr.positionX, tr.positionY ?? { v: 0 }, tr.positionZ ?? { v: 0 }] as Prop[];
  const g = (t: number) => P3.map((p) => Number(keyedAt(p, t)) || 0);
  const times = [...new Set(P3.flatMap((p) => (p.k ?? []).map((k) => k.t)))].sort((a, b) => a - b).filter((t, i, a) => !i || t - a[i - 1] > 1e-6);
  const pos = tr.position;
  if (!times.length) { pos.v = g(0); delete pos.k; }
  else if (times.length === 1) { pos.v = g(times[0]); pos.k = [{ t: times[0], v: g(times[0]) }]; }
  else {
    let keys: Key[] = [];
    for (let i = 0; i + 1 < times.length; i++) {
      const a = times[i], b = times[i + 1];
      const va = g(a), vb = g(b), dv = vb.map((x, d) => x - va[d]);
      const at = (p: Prop, t: number) => p.k?.findIndex((k) => Math.abs(k.t - t) < 1e-6) ?? -1;
      // the dimensions that change on [a, b], each with keys exactly at a and b
      const moving = P3.map((p, d) => ({ p, d })).filter(({ d }) => Math.abs(dv[d]) > 1e-9);
      let seg: Key[] | null = null;
      const holds = P3.filter((p) => { const j = at(p, a); return j >= 0 && p.k![j].i === 'hold'; });
      if (holds.length && moving.every(({ p }) => holds.includes(p))) seg = [{ t: a, v: va, i: 'hold' }, { t: b, v: vb }];
      else if (moving.length && moving.every(({ p }) => at(p, a) >= 0 && at(p, b) >= 0)) {
        const hs = moving.map(({ p }) => segHandles(p.k![at(p, a)], p.k![at(p, b)]));
        const h0 = hs[0];
        if (h0 && hs.every((h) => h && Math.abs(h.eo[0] - h0.eo[0]) < 1e-9 && Math.abs(h.eo[1] - h0.eo[1]) < 1e-9 && Math.abs(h.ei[0] - h0.ei[0]) < 1e-9 && Math.abs(h.ei[1] - h0.ei[1]) < 1e-9))
          seg = [{ t: a, v: va, i: 'bezier', eo: h0.eo }, { t: b, v: vb, ei: h0.ei }];
      } else if (!moving.length) seg = [{ t: a, v: va, i: 'linear' }, { t: b, v: vb }];
      if (seg && seg[0].i !== 'hold') {
        // verify (a dimension without keys here may still curve inside the segment)
        let err = 0;
        for (let j = 1; j < 16; j++) { const p = seg[0].eo ? bezierEase(j / 16, seg[0].eo[0], seg[0].eo[1], seg[1].ei![0], seg[1].ei![1]) : j / 16, gt = g(a + ((b - a) * j) / 16); for (let d = 0; d < 3; d++) err = Math.max(err, Math.abs(va[d] + dv[d] * p - gt[d])); }
        if (err > TOL) seg = null;
      }
      keys = joinFits(keys, seg ?? fitSegment(g, a, b));
    }
    for (const k of keys) { k.sl = true; if (k.eo && k.i === 'linear') k.i = 'bezier'; }
    for (let i = 0; i + 1 < keys.length; i++) tidy(keys[i], keys[i + 1]);
    pos.k = keys;
    pos.v = keys[0].v as number[];
  }
  delete tr.positionX; delete tr.positionY; delete tr.positionZ;
}
