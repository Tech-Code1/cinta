// «extrusion»: After Effects' extruded and bevelled 3D text and shape layers (AE 2024 Advanced 3D renderer,
// «Opciones de geometría»). This file holds the options, their value at a time, and the mesh of a set of outlines
// (filled regions with holes) extruded along +z (into the screen) with a bevel on the front and back: plain maths
// on arrays, so it runs (and is tested) in Node. src/motion-render/extrude3d.ts turns the meshes into three.js
// objects drawn by scene3d.ts like 3D models.
//
// Layout of an extruded solid (layer px; z = 0 is the layer's plane, as when it is flat):
//   front face  z = 0, the outline inset by the bevel             (surface 0, «Frontal»)
//   front bevel from the inset outline at z = 0 to the outline at z = bevel                    (1, «Bisel»)
//   side        the outline from z = bevel to z = depth − bevel                                 (2, «Lateral»)
//   back bevel  mirror of the front one (only with an extrusion)                                (1)
//   back face   z = depth (or z = bevel when there is no extrusion)                             (3, «Posterior»)
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import { valueAt } from './anim';
import { P, type Comp, type Layer, type Prop } from './model';

export type BevelStyle = 'none' | 'angular' | 'concave' | 'convex';
/** Estilo de bisel (AE: Ninguno|Angular|Cóncavo|Convexo). */
export const BEVEL_STYLES: { id: BevelStyle; name: string }[] = [
  { id: 'none', name: 'Ninguno' }, { id: 'angular', name: 'Angular' }, { id: 'concave', name: 'Cóncavo' }, { id: 'convex', name: 'Convexo' },
];
/** Opciones de geometría of a 3D text or shape layer. Lengths in px. */
export interface GeometryOptions {
  bevelStyle: BevelStyle;
  /** Profundidad de bisel: size of the bevel, horizontally and vertically (px) */
  bevelDepth: Prop<number>;
  /** Profundidad de bisel de hueco: the bevel of holes (the counter of an «O») as % of the bevel depth */
  holeBevelDepth: Prop<number>;
  /** Profundidad de extrusión (px) */
  extrusionDepth: Prop<number>;
}
/** After Effects' defaults: no bevel, bevel depth 2, hole bevel depth 100 %, extrusion depth 0 (flat). */
export const newGeometry = (): GeometryOptions => ({ bevelStyle: 'none', bevelDepth: P(2), holeBevelDepth: P(100), extrusionDepth: P(0) });
export const GEOMETRY_KEYS = ['bevelDepth', 'holeBevelDepth', 'extrusionDepth'] as const;
/** Ranges of the geometry properties (UI sliders and clamping). */
export const GEOMETRY_RANGE: Record<(typeof GEOMETRY_KEYS)[number], [number, number]> = { bevelDepth: [0, 1000], holeBevelDepth: [1, 100], extrusionDepth: [0, 10000] };
/** The per-surface colours of Opciones de material (AE's names: «Color de fondo» is its Back Color) (absent = automatic: front and back the fill, bevel and side
 *  the stroke when the text has one, else the fill). Text animators can colour them per character too. */
export const SURFACE_KEYS = ['frontColor', 'bevelColor', 'sideColor', 'backColor'] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];
export const SURFACE_NAMES: Record<SurfaceKey, string> = { frontColor: 'Color frontal', bevelColor: 'Color de bisel', sideColor: 'Color lateral', backColor: 'Color de fondo' };

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The geometry of a layer at t. */
export interface GeomAt { style: BevelStyle; bevel: number; hole: number; depth: number }
/** Geometry at time t, or null when the layer is drawn flat (not 3D, or no extrusion and no bevel: as before). */
export function geometryAt(comp: Comp, l: Layer, t: number): GeomAt | null {
  const g = l.geometry;
  if (!g || !l.threeD || (l.type !== 'text' && l.type !== 'shape')) return null;
  const ev = (p: Prop | undefined, k: (typeof GEOMETRY_KEYS)[number], d: number) => clamp(num(valueAt(p, t, { comp, layer: l, path: `geometry.${k}` }), d), ...GEOMETRY_RANGE[k]);
  const depth = ev(g.extrusionDepth, 'extrusionDepth', 0);
  const bevel = g.bevelStyle === 'none' ? 0 : ev(g.bevelDepth, 'bevelDepth', 2);
  if (depth <= 0 && bevel <= 0) return null;
  return { style: bevel > 0 ? g.bevelStyle : 'none', bevel, hole: ev(g.holeBevelDepth, 'holeBevelDepth', 100) / 100, depth };
}
export const isExtruded = (comp: Comp, l: Layer, t: number) => !!geometryAt(comp, l, t);
/** Does the layer have an extrusion at some time (animated depth)? Cheap test for the renderer's planning. */
export function mayExtrude(l: Layer): boolean {
  const g = l.geometry;
  if (!g || !l.threeD || (l.type !== 'text' && l.type !== 'shape')) return false;
  const any = (p: Prop<number>) => !!p.x || p.v > 0 || !!p.k?.some((k) => num(k.v) > 0);
  return any(g.extrusionDepth) || g.bevelStyle !== 'none';
}

// ───────────────────────── rings and solids ─────────────────────────
/** A closed polygon [x, y, …] (not repeating the first point). */
export type Ring = number[];
/** A filled region: its outline and holes. */
export interface Solid { outer: Ring; holes: Ring[] }

export function ringArea(r: Ring): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]; }
  return a / 2;
}
/** Drops repeated points (and a last point equal to the first). */
export function cleanRing(r: Ring, eps = 1e-6): Ring {
  const out: number[] = [];
  for (let i = 0; i < r.length; i += 2) {
    const n = out.length;
    if (n && Math.abs(out[n - 2] - r[i]) < eps && Math.abs(out[n - 1] - r[i + 1]) < eps) continue;
    out.push(r[i], r[i + 1]);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < eps && Math.abs(out[1] - out[out.length - 1]) < eps) out.length -= 2;
  // collinear points add nothing but triangles
  const res: number[] = [];
  const n = out.length / 2;
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    const cr = (out[i * 2] - out[a * 2]) * (out[b * 2 + 1] - out[i * 2 + 1]) - (out[i * 2 + 1] - out[a * 2 + 1]) * (out[b * 2] - out[i * 2]);
    const len = Math.hypot(out[b * 2] - out[a * 2], out[b * 2 + 1] - out[a * 2 + 1]);
    if (n > 3 && Math.abs(cr) < 1e-9 * Math.max(1, len * len)) continue;
    res.push(out[i * 2], out[i * 2 + 1]);
  }
  return res.length >= 6 ? res : out;
}
const toPoly = (r: Ring): Polygon => { const ring: [number, number][] = []; for (let i = 0; i < r.length; i += 2) ring.push([Math.round(r[i] * 1024) / 1024, Math.round(r[i + 1] * 1024) / 1024]); ring.push(ring[0]); return [ring]; };
/** polygon-clipping's result as solids (outer counter-clockwise, holes clockwise in y-up terms). */
export function solidsOf(mp: MultiPolygon): Solid[] {
  const out: Solid[] = [];
  for (const poly of mp) {
    const rings = poly.map((ring) => cleanRing(ring.flat())).filter((r) => r.length >= 6);
    if (!rings.length) continue;
    const [o, ...hs] = rings;
    out.push({ outer: ringArea(o) > 0 ? o : reverse(o), holes: hs.map((h) => (ringArea(h) < 0 ? h : reverse(h))) });
  }
  return out;
}
function reverse(r: Ring): Ring { const o: number[] = []; for (let i = r.length - 2; i >= 0; i -= 2) o.push(r[i], r[i + 1]); return o; }

/** Filled regions of a set of closed contours. evenodd: their exclusive or. nonzero: the contours turning like the
 *  largest one are joined and the others cut out of them (a glyph's counters, a compound path's holes). */
export function solidsFromRings(rings0: Ring[], rule: 'nonzero' | 'evenodd' = 'nonzero'): Solid[] {
  const rings = rings0.map((r) => cleanRing(r)).filter((r) => r.length >= 6 && Math.abs(ringArea(r)) > 1e-6);
  if (!rings.length) return [];
  let mp: MultiPolygon;
  try {
    if (rule === 'evenodd') mp = polygonClipping.xor(toPoly(rings[0]), ...rings.slice(1).map(toPoly));
    else {
      const big = rings.reduce((a, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(a)) ? r : a));
      const sg = Math.sign(ringArea(big));
      const pos = rings.filter((r) => Math.sign(ringArea(r)) === sg), neg = rings.filter((r) => Math.sign(ringArea(r)) !== sg);
      mp = polygonClipping.union(toPoly(pos[0]), ...pos.slice(1).map(toPoly));
      if (neg.length) mp = polygonClipping.difference(mp, ...neg.map(toPoly));
    }
  } catch { return []; }
  return solidsOf(mp);
}
/** Region a minus region b. */
export function subtractSolids(a: Solid[], b: Solid[]): Solid[] {
  if (!a.length || !b.length) return a;
  const mp = (s: Solid[]): MultiPolygon => s.map((x) => [toPoly(x.outer)[0], ...x.holes.map((h) => toPoly(h)[0])]);
  try { return solidsOf(polygonClipping.difference(mp(a), mp(b))); } catch { return a; }
}

/** The area covered by a stroke of width w along a polyline (After Effects extrudes strokes as this ring): every
 *  segment as a band, joined with round or bevelled corners, with butt / round / square caps when open. */
export function strokeSolids(pts: number[], closed: boolean, w: number, join: 'miter' | 'round' | 'bevel' = 'miter', cap: 'butt' | 'round' | 'square' = 'butt'): Solid[] {
  const p = cleanRing(pts);
  const n = p.length / 2, r = w / 2;
  if (n < 2 || !(r > 0)) return [];
  const polys: Polygon[] = [];
  const disc = (x: number, y: number) => { const ring: [number, number][] = []; for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; ring.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); } ring.push(ring[0]); polys.push([ring]); };
  const segs = closed ? n : n - 1;
  const nrm = (i: number) => { const j = (i + 1) % n, dx = p[j * 2] - p[i * 2], dy = p[j * 2 + 1] - p[i * 2 + 1], L = Math.hypot(dx, dy) || 1; return [-dy / L * r, dx / L * r, dx / L * r, dy / L * r]; };
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, [nx, ny, tx, ty] = nrm(i);
    let ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
    if (!closed && cap === 'square') { if (i === 0) { ax -= tx; ay -= ty; } if (i === segs - 1) { bx += tx; by += ty; } }
    polys.push([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny], [ax + nx, ay + ny]]]);
  }
  // joins: the gap at every inner vertex closed by a disc (round) or a triangle each side (bevel; miter ≈ miter)
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const x = p[i * 2], y = p[i * 2 + 1];
    if (join === 'round') { disc(x, y); continue; }
    const a = nrm((i + n - 1) % n), b = nrm(i);
    // nearly straight: the bands already overlap (slivers upset the boolean operations)
    if (Math.abs(a[0] * b[1] - a[1] * b[0]) < r * r * 0.02 && a[0] * b[0] + a[1] * b[1] > 0) continue;
    polys.push([[[x, y], [x + a[0], y + a[1]], [x + b[0], y + b[1]], [x, y]]], [[[x, y], [x - a[0], y - a[1]], [x - b[0], y - b[1]], [x, y]]]);
    if (join === 'miter') {
      // the miter point, when the corner is not too sharp (After Effects' miter limit 4)
      for (const s of [1, -1]) {
        const m0 = a[0] + b[0], m1 = a[1] + b[1], ml = Math.hypot(m0, m1);
        if (ml < 1e-9) continue;
        const cos = (a[0] * b[0] + a[1] * b[1]) / (r * r), k = r / Math.sqrt(Math.max(1e-9, (1 + cos) / 2));
        if (k / r > 4) continue;
        polys.push([[[x, y], [x + s * a[0], y + s * a[1]], [x + (s * m0 / ml) * k, y + (s * m1 / ml) * k], [x + s * b[0], y + s * b[1]], [x, y]]]);
      }
    }
  }
  if (!closed && cap === 'round') { disc(p[0], p[1]); disc(p[(n - 1) * 2], p[(n - 1) * 2 + 1]); }
  // on a fine grid (the boolean operations dislike floating-point noise); without the joins if it still fails
  const snap = (q: Polygon[]) => q.map((pl) => pl.map((ring) => ring.map(([x, y]) => [Math.round(x * 1024) / 1024, Math.round(y * 1024) / 1024] as [number, number])));
  try { return solidsOf(polygonClipping.union(...(snap(polys) as [Polygon, ...Polygon[]]))); } catch { /* retry */ }
  try { const bands = snap(polys.slice(0, segs)); return solidsOf(polygonClipping.union(bands[0], ...bands.slice(1))); } catch { return []; }
}

// ───────────────────────── triangulation (ear clipping with holes bridged in) ─────────────────────────
interface V { x: number; y: number; i: number }
/** Triangles (indices into the points of outer then holes, in order) of a solid; outer counter-clockwise. */
export function triangulate(s: Solid): number[] {
  const pts: V[] = [];
  const ring = (r: Ring) => { const o: V[] = []; for (let k = 0; k < r.length; k += 2) { const v = { x: r[k], y: r[k + 1], i: pts.length }; pts.push(v); o.push(v); } return o; };
  let poly = ring(s.outer);
  const holes = s.holes.map(ring).filter((h) => h.length >= 3);
  // holes from the rightmost: bridge each to the nearest outline vertex it can see
  holes.sort((a, b) => Math.max(...b.map((v) => v.x)) - Math.max(...a.map((v) => v.x)));
  for (const h of holes) {
    let mi = 0;
    for (let k = 1; k < h.length; k++) if (h[k].x > h[mi].x) mi = k;
    const M = h[mi];
    const edges: [V, V][] = [];
    for (let k = 0; k < poly.length; k++) edges.push([poly[k], poly[(k + 1) % poly.length]]);
    for (const o of holes) for (let k = 0; k < o.length; k++) edges.push([o[k], o[(k + 1) % o.length]]);
    let best = -1, bd = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const P0 = poly[k], d = (P0.x - M.x) ** 2 + (P0.y - M.y) ** 2;
      if (d >= bd) continue;
      if (edges.some(([a, b]) => a !== P0 && b !== P0 && a !== M && b !== M && segCross(M, P0, a, b))) continue;
      best = k; bd = d;
    }
    if (best < 0) for (let k = 0; k < poly.length; k++) { const d = (poly[k].x - M.x) ** 2 + (poly[k].y - M.y) ** 2; if (d < bd) { bd = d; best = k; } }
    const hh = [...h.slice(mi), ...h.slice(0, mi), M];
    poly = [...poly.slice(0, best + 1), ...hh, poly[best], ...poly.slice(best + 1)];
  }
  return earClip(poly);
}
const cross = (a: V, b: V, c: V) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function segCross(p: V, q: V, a: V, b: V): boolean {
  const d1 = cross(p, q, a), d2 = cross(p, q, b), d3 = cross(a, b, p), d4 = cross(a, b, q);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function inTri(a: V, b: V, c: V, p: V): boolean {
  // on an edge counts as inside (a vertex touching the ear would be cut off)
  return cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
}
function earClip(poly0: V[]): number[] {
  const out: number[] = [];
  const poly = [...poly0];
  let guard = poly.length * poly.length + 10;
  while (poly.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[(k + poly.length - 1) % poly.length], b = poly[k], c = poly[(k + 1) % poly.length];
      if (cross(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const p of poly) {
        if (p === a || p === b || p === c) continue;
        if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y) || (p.x === c.x && p.y === c.y)) continue;
        if (inTri(a, b, c, p)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(a.i, b.i, c.i);
      poly.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate rest (overlapping points): drop the flattest vertex
      let k0 = 0, best = Infinity;
      for (let k = 0; k < poly.length; k++) { const v = Math.abs(cross(poly[(k + poly.length - 1) % poly.length], poly[k], poly[(k + 1) % poly.length])); if (v < best) { best = v; k0 = k; } }
      const a = poly[(k0 + poly.length - 1) % poly.length], c = poly[(k0 + 1) % poly.length];
      if (cross(a, poly[k0], c) > 0) out.push(a.i, poly[k0].i, c.i);
      poly.splice(k0, 1);
    }
  }
  if (poly.length === 3 && cross(poly[0], poly[1], poly[2]) > 0) out.push(poly[0].i, poly[1].i, poly[2].i);
  return out;
}

// ───────────────────────── extrusion ─────────────────────────
/** Offset of a ring by d towards the solid's inside (outer rings shrink, holes grow); mitred corners, limited. */
export function insetRing(r: Ring, d: number): Ring {
  if (!d) return r.slice();
  const n = r.length / 2, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    let e1x = r[i * 2] - r[a * 2], e1y = r[i * 2 + 1] - r[a * 2 + 1], e2x = r[b * 2] - r[i * 2], e2y = r[b * 2 + 1] - r[i * 2 + 1];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    // left normals (the inside of a counter-clockwise outline, the solid around a clockwise hole)
    const n1x = -e1y, n1y = e1x, n2x = -e2y, n2y = e2x;
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { mx = n1x; my = n1y; } else { mx /= ml; my /= ml; }
    const k = d / Math.max(0.35, mx * n1x + my * n1y);
    out.push(r[i * 2] + mx * k, r[i * 2 + 1] + my * k);
  }
  return out;
}
/** Bevel profile: inset (fraction of the bevel width, 1 = fully inset) and depth (fraction of the bevel depth) from
 *  the front face's edge (u = 0) to the side (u = 1). */
export function bevelProfile(style: BevelStyle, segments = 6): { h: number; z: number }[] {
  if (style === 'none') return [{ h: 0, z: 0 }];
  if (style === 'angular') return [{ h: 1, z: 0 }, { h: 0, z: 1 }];
  const out: { h: number; z: number }[] = [];
  for (let j = 0; j <= segments; j++) {
    const a = (j / segments) * (Math.PI / 2);
    // convex: a rounded edge (flat towards the face and the side); concave: a cove
    out.push(style === 'convex' ? { h: 1 - Math.sin(a), z: 1 - Math.cos(a) } : { h: Math.cos(a), z: Math.sin(a) });
  }
  return out;
}

export interface ExtrudedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** index ranges per surface: 0 front, 1 bevel, 2 side, 3 back */
  groups: { start: number; count: number; surface: 0 | 1 | 2 | 3 }[];
  bbox: { min: number[]; max: number[] };
}
/** The extruded mesh of filled regions (layer px) with this geometry. Corners sharper than ~35° keep hard edges. */
export function extrude(solids: Solid[], g: GeomAt, curveSegments = 6): ExtrudedMesh {
  const P: number[] = [], N: number[] = [];
  const I: number[][] = [[], [], [], []];
  const bevelOn = g.style !== 'none' && g.bevel > 0;
  const prof = bevelProfile(bevelOn ? g.style : 'none', curveSegments);
  const D = Math.max(0, g.depth);
  // vertical bevel: at most half the extrusion (front and back bevels meet); without extrusion only the front one
  const bz = bevelOn ? (D > 0 ? Math.min(g.bevel, D / 2) : g.bevel) : 0;
  const T = D > 0 ? D : bz;
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => { P.push(x, y, z); N.push(nx, ny, nz); return P.length / 3 - 1; };
  /** a triangle facing along its vertices' normals */
  const tri = (s: number, a: number, b: number, c: number) => {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (cx * nx + cy * ny + cz * nz < 0) I[s].push(a, c, b); else I[s].push(a, b, c);
  };
  for (const sd of solids) {
    const rings = [sd.outer, ...sd.holes];
    // horizontal / vertical bevel of each ring (holes: Hole Bevel Depth)
    const bw = rings.map((_, k) => (bevelOn ? g.bevel * (k ? g.hole : 1) : 0));
    const bzr = rings.map((_, k) => bz * (k ? g.hole : 1));
    // caps: the rings inset by the full bevel, triangulated once (same topology front and back)
    const capRings = rings.map((r, k) => insetRing(r, bw[k]));
    const tris = triangulate({ outer: capRings[0], holes: capRings.slice(1) });
    const flatPts = capRings.flatMap((r) => r);
    const backInset = D > 0;
    for (const [s, z, nz] of [[0, 0, -1], [3, T, 1]] as const) {
      const base = P.length / 3;
      const src = s === 3 && !backInset ? rings.flat() : flatPts;
      for (let i = 0; i < src.length; i += 2) vert(src[i], src[i + 1], z, 0, 0, nz);
      for (let i = 0; i < tris.length; i += 3) tri(s, base + tris[i], base + tris[i + 1], base + tris[i + 2]);
    }
    // walls: per ring, per edge (normals smoothed across gentle corners)
    rings.forEach((r, k) => {
      const n = r.length / 2;
      const en: [number, number][] = [];
      for (let i = 0; i < n; i++) { const j = (i + 1) % n, dx = r[j * 2] - r[i * 2], dy = r[j * 2 + 1] - r[i * 2 + 1], L = Math.hypot(dx, dy) || 1; en.push([dy / L, -dx / L]); }
      // vertex normal seen from edge e at its start (end = false) or end
      const vn = (e: number, end: boolean): [number, number] => {
        const o = end ? (e + 1) % n : (e + n - 1) % n, a = en[e], b = en[o];
        if (a[0] * b[0] + a[1] * b[1] < Math.cos((35 * Math.PI) / 180)) return a;
        const x = a[0] + b[0], y = a[1] + b[1], L = Math.hypot(x, y) || 1;
        return [x / L, y / L];
      };
      // the wall's cross-section: front bevel, side, back bevel — (inset px, z, radial normal, z normal, surface)
      type S = { h: number; z: number; nr: number; nz: number };
      const strip = (sec: S[], surface: 1 | 2) => {
        for (let e = 0; e < n; e++) {
          const i0 = e, i1 = (e + 1) % n;
          const n0 = vn(e, false), n1 = vn(e, true);
          const ids: number[][] = [];
          for (const s of sec) {
            const r0 = insetRing([r[(i0 + n - 1) % n * 2], r[(i0 + n - 1) % n * 2 + 1], r[i0 * 2], r[i0 * 2 + 1], r[i1 * 2], r[i1 * 2 + 1]], s.h);
            const r1 = insetRing([r[i0 * 2], r[i0 * 2 + 1], r[i1 * 2], r[i1 * 2 + 1], r[(i1 + 1) % n * 2], r[(i1 + 1) % n * 2 + 1]], s.h);
            ids.push([vert(r0[2], r0[3], s.z, n0[0] * s.nr, n0[1] * s.nr, s.nz), vert(r1[2], r1[3], s.z, n1[0] * s.nr, n1[1] * s.nr, s.nz)]);
          }
          for (let j = 0; j + 1 < ids.length; j++) { tri(surface, ids[j][0], ids[j][1], ids[j + 1][1]); tri(surface, ids[j][0], ids[j + 1][1], ids[j + 1][0]); }
        }
      };
      const w = bw[k], zz = bzr[k];
      if (bevelOn && w > 0 && zz > 0) {
        // profile normals: perpendicular to each segment, averaged at inner samples
        const seg = prof.slice(1).map((q, j) => { const o = (prof[j].h - q.h) * w, dz = (q.z - prof[j].z) * zz, L = Math.hypot(o, dz) || 1; return [dz / L, -o / L]; });
        const pn = prof.map((_, j) => { const a = seg[Math.max(0, j - 1)], b = seg[Math.min(seg.length - 1, j)], x = a[0] + b[0], y = a[1] + b[1], L = Math.hypot(x, y) || 1; return [x / L, y / L]; });
        strip(prof.map((q, j) => ({ h: q.h * w, z: q.z * zz, nr: pn[j][0], nz: pn[j][1] })), 1);
        if (D > 0) strip(prof.map((q, j) => ({ h: q.h * w, z: T - q.z * zz, nr: pn[j][0], nz: -pn[j][1] })).reverse(), 1);
      }
      const z0 = bevelOn ? zz : 0, z1 = D > 0 ? T - z0 : T;
      if (z1 - z0 > 1e-6) strip([{ h: 0, z: z0, nr: 1, nz: 0 }, { h: 0, z: z1, nr: 1, nz: 0 }], 2);
    });
  }
  const groups: ExtrudedMesh['groups'] = [];
  const idx: number[] = [];
  for (const s of [0, 1, 2, 3] as const) { if (I[s].length) groups.push({ start: idx.length, count: I[s].length, surface: s }); idx.push(...I[s]); }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], P[i + c]); max[c] = Math.max(max[c], P[i + c]); }
  return { positions: Float32Array.from(P), normals: Float32Array.from(N), indices: Uint32Array.from(idx), groups, bbox: Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] } };
}

/** Geometry facts for comp_get. */
export function geometrySummary(l: Layer) {
  const g = l.geometry;
  if (!g) return undefined;
  const v = (p: Prop<number>) => (p.k?.length ? `${p.k.length} claves` : p.v);
  const cols = Object.fromEntries(SURFACE_KEYS.filter((k) => l.material?.[k]).map((k) => [k, l.material![k]!.k?.length ? `${l.material![k]!.k!.length} claves` : l.material![k]!.v]));
  return { bevelStyle: g.bevelStyle, bevelDepth: v(g.bevelDepth), holeBevelDepth: v(g.holeBevelDepth), extrusionDepth: v(g.extrusionDepth), extruded: mayExtrude(l), ...cols };
}
