// «capas» (After Effects 2024 layer / composition features): guide layers, crop comp to the work area or to the
// region of interest, Responsive Design – Time (protected regions), RotoBezier masks, variable mask feather and the
// Wiggle Transform shape operator. Pure helpers shared by the ops, the renderer and the MCP server.
import { noise1, valueAt } from './anim';
import type { Project } from '../model';
import type { Comp, CompMarker, FeatherPoint, Layer, Mask, ShapeItem } from './model';
import { P } from './model';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ───────────────────────── Responsive Design – Time ─────────────────────────
/** Protected regions of a comp ([start, end] in comp seconds), sorted, clipped to the comp and merged. */
export function protectedRegions(c: Pick<Comp, 'markers' | 'duration'>): [number, number][] {
  const r = (c.markers ?? []).filter((m) => m.protected && (m.dur ?? 0) > 0)
    .map((m) => [Math.max(0, m.t), Math.min(c.duration, m.t + (m.dur ?? 0))] as [number, number])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of r) { const last = out[out.length - 1]; if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push([...x]); }
  return out;
}
/** Segments of [0, D]: protected ones keep their length, the others share what is left of `L`. */
function segments(regions: [number, number][], D: number, L: number): { a: number; b: number; k: number }[] {
  const P = regions.reduce((s, [a, b]) => s + b - a, 0), U = D - P;
  const k = U > 1e-9 ? Math.max(0, (L - P) / U) : 1;
  const segs: { a: number; b: number; k: number }[] = [];
  let at = 0;
  for (const [a, b] of regions) { if (a > at) segs.push({ a: at, b: a, k }); segs.push({ a, b, k: 1 }); at = b; }
  if (at < D) segs.push({ a: at, b: D, k });
  return segs;
}
/** Source time → stretched time, when [0, D] becomes L long with the protected regions unchanged. */
export function protectedForward(regions: [number, number][], D: number, L: number, t: number): number {
  let out = 0;
  for (const s of segments(regions, D, L)) {
    if (t <= s.b) return out + Math.max(0, t - s.a) * s.k;
    out += (s.b - s.a) * s.k;
  }
  return out + (t - D);
}
/** Stretched time → source time (inverse of protectedForward). */
export function protectedInverse(regions: [number, number][], D: number, L: number, u: number): number {
  let at = 0;
  for (const s of segments(regions, D, L)) {
    const len = (s.b - s.a) * s.k;
    if (u <= at + len + 1e-12) return s.a + (s.k > 1e-12 ? (u - at) / s.k : 0);
    at += len;
  }
  return D + (u - at);
}
/** Source time of a layer at comp time t. A nested comp with protected regions, time-stretched, keeps the speed of
 *  its protected regions; the unprotected ones take the rest of the stretch (After Effects' Responsive Design – Time). */
export function layerSourceTime(comps: Comp[] | undefined, l: Layer, t: number): number {
  const s = l.stretch || 1;
  if (l.type === 'comp' && l.compId && s > 0 && Math.abs(s - 1) > 1e-9) {
    const sub = comps?.find((c) => c.id === l.compId);
    const reg = sub ? protectedRegions(sub) : [];
    if (sub && reg.length) return protectedInverse(reg, sub.duration, sub.duration * s, t - l.start);
  }
  return (t - l.start) / s;
}
/** The comp's duration changes from D0 to D1: with protected regions its contents are retimed so those regions keep
 *  their timing and the unprotected time stretches (keys, layer spans, markers, work area). Media and nested comp
 *  layers keep their length (they would play at another speed) and move with their in point. */
export function retimeProtected(c: Comp, D0: number, D1: number): boolean {
  const reg = protectedRegions({ markers: c.markers, duration: D0 });
  if (!reg.length || Math.abs(D1 - D0) < 1e-9) return false;
  const f = (t: number) => (t <= 0 ? t : t >= D0 ? D1 + (t - D0) : protectedForward(reg, D0, D1, t));
  const media = new Set(['video', 'audio', 'image', 'comp', 'sequence', 'model']);
  for (const l of c.layers) {
    const in0 = l.in, out0 = l.out;
    eachProp(l, (p) => p.k?.forEach((k) => { k.t = f(k.t); }));
    if (media.has(l.type)) { const d = f(in0) - in0; l.in += d; l.out += d; l.start += d; }
    else { l.in = f(in0); l.out = f(out0); }
  }
  for (const m of c.markers) {
    const end = m.t + (m.dur ?? 0);
    m.t = f(m.t);
    if (m.dur) m.dur = Math.max(0, f(end) - m.t);
  }
  c.workArea = [f(c.workArea[0]), f(c.workArea[1])];
  return true;
}
/** Every animatable property (keys only matter here); kept local to avoid an import cycle with ops.ts. */
function eachProp(l: Layer, fn: (p: { k?: { t: number }[] }) => void) {
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const r = o as Record<string, unknown>;
    if ('v' in r && (Array.isArray(r.k) || 'x' in r)) { fn(r as { k?: { t: number }[] }); return; }
    for (const [k, v] of Object.entries(r)) if (k !== 'open') walk(v, depth + 1);
  };
  walk(l, 0);
}

/** A comp marker (After Effects' composition marker: comment, duration, protected region). */
export function newMarker(t: number, o: Partial<Omit<CompMarker, 't'>> = {}): CompMarker {
  return { t, name: o.name ?? '', ...(o.dur ? { dur: o.dur } : {}), ...(o.protected ? { protected: true } : {}) };
}

// ───────────────────────── crop comp ─────────────────────────
/** Shifts a layer and its keyframes in time. */
export function shiftLayerTime(l: Layer, dt: number) {
  l.start += dt; l.in += dt; l.out += dt;
  eachProp(l, (p) => p.k?.forEach((k) => { k.t += dt; }));
}
/** Moves the top-level (unparented) layers by (dx, dy) comp px: position (or its separated X / Y) and its keys;
 *  cameras and lights move their point of interest too. */
export function shiftLayerSpace(l: Layer, dx: number, dy: number) {
  const mv = (p: { v: unknown; k?: { v: unknown }[] }) => {
    const f = (v: unknown) => (Array.isArray(v) ? [v[0] + dx, v[1] + dy, ...v.slice(2)] : v);
    p.v = f(p.v); p.k?.forEach((k) => { k.v = f(k.v); });
  };
  const add = (p: { v: unknown; k?: { v: unknown }[] } | undefined, d: number) => { if (!p) return; p.v = num(p.v) + d; p.k?.forEach((k) => { k.v = num(k.v) + d; }); };
  if (l.parent) return;
  if (l.transform.positionX) { add(l.transform.positionX, dx); add(l.transform.positionY, dy); }
  else mv(l.transform.position);
  if (l.camera) mv(l.camera.poi);
  if (l.light) mv(l.light.poi);
}

// ───────────────────────── guide layers ─────────────────────────
/** Layers drawn in this comp: guide layers only in the Composition panel's own comp (never nested, never rendered). */
export const isGuide = (l: Layer) => !!l.guide;

// ───────────────────────── RotoBezier ─────────────────────────
/** Default RotoBezier tension (After Effects: 33 %, the curve through the vertices like a Catmull-Rom spline). */
export const ROTO_TENSION = 33.33;
/** A mask path with RotoBezier: the tangents follow from the vertices and the tension of each (0 % round, 100 % a
 *  corner). Without RotoBezier the path is returned as is. */
export function rotoFlat(m: Pick<Mask, 'rotoBezier' | 'tension'>, flat: number[], closed = true): number[] {
  if (!m.rotoBezier || !Array.isArray(flat)) return flat;
  const n = Math.floor(flat.length / 6);
  if (n < 2) return flat;
  const out = flat.slice();
  for (let i = 0; i < n; i++) {
    const ip = closed ? (i - 1 + n) % n : Math.max(0, i - 1), inx = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const tn = Math.max(0, Math.min(100, num(m.tension?.[i], ROTO_TENSION))) / 100;
    // handle length: 1/6 of the chord at 33 % (Catmull-Rom), longer below, none at 100 %
    const k = ((1 - tn) / 4);
    const dx = flat[inx * 6] - flat[ip * 6], dy = flat[inx * 6 + 1] - flat[ip * 6 + 1];
    // open ends: the tangent from the one neighbour
    const kk = !closed && (i === 0 || i === n - 1) ? k * 0.5 : k;
    out[i * 6 + 2] = -dx * kk; out[i * 6 + 3] = -dy * kk; out[i * 6 + 4] = dx * kk; out[i * 6 + 5] = dy * kk;
  }
  return out;
}

// ───────────────────────── mask outline sampling ─────────────────────────
export interface MaskSample { x: number; y: number; seg: number; u: number; s: number }
/** Samples a closed flat bezier at a fixed number of steps per segment (each sample knows its segment and
 *  parameter), with the arc length so far. */
export function sampleMask(flat: number[], steps = 24): { pts: MaskSample[]; length: number; area: number } {
  const n = Math.floor(flat.length / 6);
  const pts: MaskSample[] = [];
  let s = 0, area = 0;
  for (let seg = 0; seg < n; seg++) {
    const a = seg * 6, b = ((seg + 1) % n) * 6;
    const x0 = flat[a], y0 = flat[a + 1], x1 = x0 + flat[a + 4], y1 = y0 + flat[a + 5];
    const x3 = flat[b], y3 = flat[b + 1], x2 = x3 + flat[b + 2], y2 = y3 + flat[b + 3];
    for (let i = 0; i < steps; i++) {
      const u = i / steps, v = 1 - u;
      const x = v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, y = v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3;
      const prev = pts[pts.length - 1];
      if (prev) s += Math.hypot(x - prev.x, y - prev.y);
      pts.push({ x, y, seg, u, s });
    }
  }
  if (pts.length) s += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p.x * q.y - q.x * p.y; }
  return { pts, length: s, area: area / 2 };
}
/** Point and outward normal of a closed flat bezier at segment `seg`, parameter u. */
export function maskPointAt(flat: number[], seg: number, u: number): { x: number; y: number; nx: number; ny: number } {
  const n = Math.floor(flat.length / 6);
  const a = (((seg % n) + n) % n) * 6, b = (((seg + 1) % n + n) % n) * 6;
  const x0 = flat[a], y0 = flat[a + 1], x1 = x0 + flat[a + 4], y1 = y0 + flat[a + 5];
  const x3 = flat[b], y3 = flat[b + 1], x2 = x3 + flat[b + 2], y2 = y3 + flat[b + 3];
  const v = 1 - u;
  const x = v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, y = v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3;
  let dx = 3 * v * v * (x1 - x0) + 6 * v * u * (x2 - x1) + 3 * u * u * (x3 - x2), dy = 3 * v * v * (y1 - y0) + 6 * v * u * (y2 - y1) + 3 * u * u * (y3 - y2);
  if (Math.hypot(dx, dy) < 1e-9) { dx = x3 - x0; dy = y3 - y0; }
  const len = Math.hypot(dx, dy) || 1;
  const sign = sampleMask(flat, 8).area >= 0 ? 1 : -1;
  return { x, y, nx: (sign * dy) / len, ny: (-sign * dx) / len };
}
/** The point of a closed flat bezier nearest to (x, y): segment, parameter, distance. */
export function nearestOnMask(flat: number[], x: number, y: number): { seg: number; u: number; d: number; x: number; y: number } | null {
  const { pts } = sampleMask(flat, 48);
  if (!pts.length) return null;
  let best = { seg: 0, u: 0, d: Infinity, x: 0, y: 0 };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const ex = q.x - p.x, ey = q.y - p.y, L2 = ex * ex + ey * ey;
    const w = L2 ? Math.max(0, Math.min(1, ((x - p.x) * ex + (y - p.y) * ey) / L2)) : 0;
    const px = p.x + ex * w, py = p.y + ey * w, d = Math.hypot(x - px, y - py);
    if (d < best.d) {
      // the parameter between the two samples (the last sample of a segment runs to u = 1)
      const u1 = q.seg === p.seg ? q.u : 1;
      best = { seg: p.seg, u: p.u + (u1 - p.u) * w, d, x: px, y: py };
    }
  }
  return best;
}

// ───────────────────────── variable mask feather ─────────────────────────
/** Feather radius along the outline: the feather points' radii, eased between neighbours (tension holds a point's
 *  radius over more of the way to the next one). One point gives its radius everywhere. */
export function featherRadii(samples: MaskSample[], length: number, fps: FeatherPoint[]): number[] {
  const n = samples.length;
  if (!fps.length || !n) return new Array(n).fill(0);
  const segS = new Map<number, number>();
  for (const p of samples) if (!segS.has(p.seg)) segS.set(p.seg, p.s);
  const segLen = (seg: number) => { const a = segS.get(seg) ?? 0, b = segS.get(seg + 1) ?? length; return b - a; };
  const at = fps.map((f) => ({ s: (segS.get(f.seg) ?? 0) + Math.max(0, Math.min(1, f.u)) * segLen(f.seg), r: f.r, k: Math.max(0, Math.min(100, f.tension ?? 0)) / 100 })).sort((a, b) => a.s - b.s);
  if (at.length === 1) return new Array(n).fill(at[0].r);
  return samples.map((p) => {
    let j = at.findIndex((q) => q.s > p.s);
    if (j < 0) j = 0;
    const A = at[(j - 1 + at.length) % at.length], B = at[j];
    const span = ((B.s - A.s) + length) % length || length;
    const d = ((p.s - A.s) + length) % length;
    let w = d / span;
    // tension: each end keeps its own radius over half its tension of the way
    const h0 = A.k / 2, h1 = B.k / 2;
    w = h0 + h1 >= 1 ? (w < 0.5 ? 0 : 1) : Math.max(0, Math.min(1, (w - h0) / (1 - h0 - h1)));
    w = w * w * (3 - 2 * w);
    return A.r + (B.r - A.r) * w;
  });
}
/** Contour of the feathered mask at alpha level a (0 < a ≤ 1): each sample moved along its outward normal by
 *  (1 − a)·r where the radius is outward (r > 0) or a·r where it is inward (r < 0); plus the mask expansion. */
export function featherContour(samples: MaskSample[], radii: number[], area: number, a: number, expansion = 0): number[] {
  const n = samples.length, sign = area >= 0 ? 1 : -1, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = samples[(i - 1 + n) % n], q = samples[(i + 1) % n], c = samples[i];
    const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
    const nx = (sign * dy) / len, ny = (-sign * dx) / len;
    const r = radii[i], off = (r > 0 ? (1 - a) * r : a * r) + expansion;
    out.push(c.x + nx * off, c.y + ny * off);
  }
  return out;
}

// ───────────────────────── Wiggle Transform (shape operator) ─────────────────────────
export type WiggleTransform = NonNullable<ShapeItem['wiggleTransform']>;
/** After Effects' defaults: 2 wiggles/s, correlation 50 %, phases 0, seed 0, no amounts. */
export function newWiggleTransform(): WiggleTransform {
  return { speed: P(2), correlation: P(50), temporalPhase: P(0), spatialPhase: P(0), seed: 0, anchor: P([0, 0]), position: P([0, 0]), scale: P([0, 0]), rotation: P(0) };
}
/** Offsets of one copy (repeater copy index, 0 without one) at time t: each amount times a smooth noise in [−1, 1].
 *  Copies share a part of their noise (correlation 100 %: all move together, 0 %: each on its own); the spatial
 *  phase shifts the noise from copy to copy. */
export function wiggleTransformAt(comp: Comp, l: Layer, s: ShapeItem, t: number, copy = 0): { anchor: [number, number]; position: [number, number]; scale: [number, number]; rotation: number } {
  const w = s.wiggleTransform!;
  const ev = (p: unknown, k: string) => valueAt(p as never, t, { comp, layer: l, path: `shapes.${s.id}.wiggleTransform.${k}` });
  const speed = num(ev(w.speed, 'speed'), 2), corr = Math.max(0, Math.min(100, num(ev(w.correlation, 'correlation'), 50))) / 100;
  const z = t * speed + num(ev(w.temporalPhase, 'temporalPhase')) / 360, sp = num(ev(w.spatialPhase, 'spatialPhase')) / 360;
  const seed = 1013 + (w.seed | 0) * 7919;
  const ch = (k: number) => {
    const shared = noise1(z + sp * copy, seed + k * 131);
    const own = noise1(z + sp * copy + copy * 17.31, seed + k * 131 + (copy + 1) * 977);
    return corr * shared + (1 - corr) * own;
  };
  const a = ev(w.anchor, 'anchor') as number[], p = ev(w.position, 'position') as number[], sc = ev(w.scale, 'scale') as number[], r = num(ev(w.rotation, 'rotation'));
  // one shared noise for both scale axes keeps a uniform wiggle uniform
  const sn = ch(4);
  return {
    anchor: [num(a?.[0]) * ch(0), num(a?.[1]) * ch(1)],
    position: [num(p?.[0]) * ch(2), num(p?.[1]) * ch(3)],
    scale: [num(sc?.[0]) * sn, num(sc?.[1]) * (Math.abs(num(sc?.[0]) - num(sc?.[1])) < 1e-9 ? sn : ch(5))],
    rotation: r * ch(6),
  };
}

// ───────────────────────── project helpers ─────────────────────────
/** Guide layers of a comp (for the summary). */
export const guideLayers = (c: Comp) => c.layers.filter((l) => l.guide).map((l) => l.name);
/** Does any comp of the project use these features? (nothing to migrate: every field is optional) */
export function usesCapas(p: Pick<Project, 'comps'>): boolean {
  return (p.comps ?? []).some((c) => !!c.roi || c.markers.some((m) => m.protected) || c.layers.some((l) => l.guide || l.masks.some((m) => m.rotoBezier || m.featherPts?.length) || l.shapes?.some((s) => s.wiggleTransform)));
}
