// Geometry for the motion engine: 4×4 matrices (column-major, like WebGL), layer transforms with parenting,
// shape outlines (flattened beziers), trim paths and the default camera.
import { hash2, segmentProgress, valueAt } from './anim';
import { defaultZoom, ellipsePath, type Comp, type Layer, type ShapeItem } from './model';

export type Mat4 = Float64Array;
export const ident = (): Mat4 => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
export const translate = (x: number, y: number, z = 0): Mat4 => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; };
export const scaleM = (x: number, y: number, z = 1): Mat4 => { const m = ident(); m[0] = x; m[5] = y; m[10] = z; return m; };
export function rotZ(deg: number): Mat4 { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), m = ident(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
export function rotX(deg: number): Mat4 { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), m = ident(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
export function rotY(deg: number): Mat4 { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), m = ident(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
export function apply(m: Mat4, x: number, y: number, z = 0): [number, number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
}
export function invert(m: Mat4): Mat4 {
  const inv = new Float64Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (Math.abs(det) < 1e-12) return ident();
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: unknown, n: number, d: number[]): number[] => {
  const a = Array.isArray(v) ? v : [];
  return Array.from({ length: n }, (_, i) => num(a[i], d[i] ?? 0));
};

/** Evaluated transform of a layer (no parent). */
export function layerTransform(comp: Comp, l: Layer, t: number) {
  const ev = (p: keyof Layer['transform']) => valueAt(l.transform[p], t, { comp, layer: l, path: `transform.${p}` });
  const anchor = vec(ev('anchor'), 3, [0, 0, 0]);
  const position = vec(ev('position'), 3, [0, 0, 0]);
  const scale = vec(ev('scale'), 3, [100, 100, 100]);
  return {
    anchor, position, scale,
    rotation: num(ev('rotation')),
    rotationX: num(ev('rotationX')),
    rotationY: num(ev('rotationY')),
    opacity: Math.max(0, Math.min(100, num(ev('opacity'), 100))) / 100,
  };
}

export function localMatrix(comp: Comp, l: Layer, t: number): Mat4 {
  const tr = layerTransform(comp, l, t);
  const d3 = l.threeD;
  let m = translate(tr.position[0], tr.position[1], d3 ? tr.position[2] : 0);
  m = mul(m, rotZ(tr.rotation));
  if (d3) { m = mul(m, rotY(tr.rotationY)); m = mul(m, rotX(tr.rotationX)); }
  m = mul(m, scaleM(tr.scale[0] / 100, tr.scale[1] / 100, d3 ? tr.scale[2] / 100 : 1));
  m = mul(m, translate(-tr.anchor[0], -tr.anchor[1], d3 ? -tr.anchor[2] : 0));
  return m;
}

/** Layer → comp matrix including parents (parent chain stops on cycles). */
export function worldMatrix(comp: Comp, l: Layer, t: number, seen = new Set<string>()): Mat4 {
  const local = localMatrix(comp, l, t);
  if (!l.parent || seen.has(l.id)) return local;
  seen.add(l.id);
  const p = comp.layers.find((x) => x.id === l.parent);
  return p ? mul(worldMatrix(comp, p, t, seen), local) : local;
}

/** Active camera (topmost visible camera layer in its time span) or the default 50 mm one. */
export function cameraAt(comp: Comp, t: number): { view: Mat4; zoom: number; layer?: Layer } {
  const cam = comp.layers.find((l) => l.type === 'camera' && !l.hidden && t >= l.in && t < l.out);
  const W = comp.width, H = comp.height;
  if (!cam) {
    const z = defaultZoom(W);
    return { view: lookAt([W / 2, H / 2, -z], [W / 2, H / 2, 0]), zoom: z };
  }
  const zoom = num(valueAt(cam.camera?.zoom, t, { comp, layer: cam, path: 'camera.zoom' }), defaultZoom(W));
  const world = worldMatrix(comp, cam, t);
  const pos = apply(world, cam.transform.anchor.v[0] ?? 0, cam.transform.anchor.v[1] ?? 0, cam.transform.anchor.v[2] ?? 0);
  const poi = vec(valueAt(cam.camera?.poi, t, { comp, layer: cam, path: 'camera.poi' }), 3, [W / 2, H / 2, 0]);
  const tr = layerTransform(comp, cam, t);
  let view = lookAt([pos[0], pos[1], pos[2]], poi);
  if (tr.rotation) view = mul(rotZ(-tr.rotation), view);
  return { view, zoom, layer: cam };
}

/** View matrix: camera at eye looking at target, y down (After Effects convention). */
export function lookAt(eye: number[], target: number[]): Mat4 {
  let fz = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const lz = Math.hypot(fz[0], fz[1], fz[2]) || 1;
  fz = fz.map((x) => x / lz);
  let up = [0, 1, 0];
  if (Math.abs(fz[1]) > 0.999) up = [0, 0, 1];
  // right = up × forward ; real up = forward × right
  let rx = [up[1] * fz[2] - up[2] * fz[1], up[2] * fz[0] - up[0] * fz[2], up[0] * fz[1] - up[1] * fz[0]];
  const lr = Math.hypot(rx[0], rx[1], rx[2]) || 1;
  rx = rx.map((x) => x / lr);
  const uy = [fz[1] * rx[2] - fz[2] * rx[1], fz[2] * rx[0] - fz[0] * rx[2], fz[0] * rx[1] - fz[1] * rx[0]];
  const m = ident();
  m[0] = rx[0]; m[4] = rx[1]; m[8] = rx[2];
  m[1] = uy[0]; m[5] = uy[1]; m[9] = uy[2];
  m[2] = fz[0]; m[6] = fz[1]; m[10] = fz[2];
  m[12] = -(rx[0] * eye[0] + rx[1] * eye[1] + rx[2] * eye[2]);
  m[13] = -(uy[0] * eye[0] + uy[1] * eye[1] + uy[2] * eye[2]);
  m[14] = -(fz[0] * eye[0] + fz[1] * eye[1] + fz[2] * eye[2]);
  return m;
}

/** Projects a camera-space point to comp pixels. */
export function project(W: number, H: number, zoom: number, p: number[]): [number, number, number] {
  const z = Math.max(1e-3, p[2]);
  return [W / 2 + (zoom * p[0]) / z, H / 2 + (zoom * p[1]) / z, z];
}

// ───────────────────────── bezier paths ─────────────────────────
/** Flat bezier [x, y, inX, inY, outX, outY, …] → polyline [x, y, …] (adaptive). */
export function flattenBezier(flat: number[], closed: boolean, tol = 1.5): number[] {
  const n = Math.floor(flat.length / 6);
  if (!n) return [];
  const out: number[] = [flat[0], flat[1]];
  const segs = closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = s * 6, b = ((s + 1) % n) * 6;
    const x0 = flat[a], y0 = flat[a + 1], x1 = x0 + flat[a + 4], y1 = y0 + flat[a + 5];
    const x3 = flat[b], y3 = flat[b + 1], x2 = x3 + flat[b + 2], y2 = y3 + flat[b + 3];
    const straight = !flat[a + 4] && !flat[a + 5] && !flat[b + 2] && !flat[b + 3];
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const steps = straight ? 1 : Math.max(2, Math.min(96, Math.ceil(len / (tol * 4))));
    for (let i = 1; i <= steps; i++) {
      const u = i / steps, v = 1 - u;
      out.push(v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3);
    }
  }
  return out;
}

export interface Outline { pts: number[]; closed: boolean }

/** Outline of a shape item in its own space (centred on 0,0), at time t, after its path modifiers (zigzag, wiggle). */
export function shapeOutline(comp: Comp, l: Layer, s: ShapeItem, t: number): Outline {
  if (s.kind === 'merge') return { pts: [], closed: true };
  const ev = (p: unknown, path: string) => num(valueAt(p as never, t, { comp, layer: l, path: `shapes.${s.id}.${path}` }));
  // operators in a fixed order: pucker & bloat (on the vertices), round corners, offset, zigzag, twist, wiggle
  const pk = s.pucker ? ev(s.pucker.amount, 'pucker.amount') : 0;
  let o = pk ? puckerOutline(baseBezier(comp, l, s, t), s.kind === 'path' ? s.closed : true, pk) : baseOutline(comp, l, s, t);
  if (s.roundCorners) o = roundCornersOutline(o, ev(s.roundCorners.radius, 'roundCorners.radius'));
  if (s.offset) o = offsetOutline(o, ev(s.offset.amount, 'offset.amount'), s.offset.join, s.offset.miterLimit);
  if (s.zigzag) o = zigzagOutline(o, ev(s.zigzag.size, 'zigzag.size'), Math.round(ev(s.zigzag.ridges, 'zigzag.ridges')), s.zigzag.smooth);
  if (s.twist) {
    const c = valueAt(s.twist.center as never, t, { comp, layer: l, path: `shapes.${s.id}.twist.center` }) as number[];
    o = twistOutline(o, ev(s.twist.angle, 'twist.angle'), [num(c?.[0]), num(c?.[1])]);
  }
  if (s.wiggle) o = wiggleOutline(o, ev(s.wiggle.size, 'wiggle.size'), Math.round(ev(s.wiggle.detail, 'wiggle.detail')), t * ev(s.wiggle.speed, 'wiggle.speed') + ev(s.wiggle.phase, 'wiggle.phase') / 360, s.wiggle.seed, s.wiggle.smooth);
  return o;
}

/** The shape's vertices as a flat bezier [x, y, inX, inY, outX, outY…] (rect corners, 4-point ellipse, star /
 *  polygon points, the path itself): what pucker & bloat works on. */
export function baseBezier(comp: Comp, l: Layer, s: ShapeItem, t: number): number[] {
  const ev = (p: unknown, path: string) => valueAt(p as never, t, { comp, layer: l, path: `shapes.${s.id}.${path}` });
  if (s.kind === 'ellipse') { const [w, h] = vec(ev(s.size, 'size'), 2, [100, 100]); return ellipsePath(0, 0, w / 2, h / 2); }
  if (s.kind === 'path') { const f = ev(s.path, 'path'); return Array.isArray(f) ? (f as number[]) : []; }
  let o: number[];
  if (s.kind === 'rect') { const [w, h] = vec(ev(s.size, 'size'), 2, [100, 100]); o = [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2]; }
  else o = baseOutline(comp, l, s, t).pts;
  const f: number[] = [];
  for (let i = 0; i < o.length; i += 2) f.push(o[i], o[i + 1], 0, 0, 0, 0);
  return f;
}

export function baseOutline(comp: Comp, l: Layer, s: ShapeItem, t: number): Outline {
  const ev = (p: unknown, path: string) => valueAt(p as never, t, { comp, layer: l, path: `shapes.${s.id}.${path}` });
  if (s.kind === 'rect') {
    const [w, h] = vec(ev(s.size, 'size'), 2, [100, 100]);
    const r = Math.max(0, Math.min(num(ev(s.roundness, 'roundness')), Math.abs(w) / 2, Math.abs(h) / 2));
    const x = -w / 2, y = -h / 2;
    if (r <= 0) return { pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true };
    const k = r * 0.5523;
    const f = [
      x + r, y, -k, 0, 0, 0, x + w - r, y, 0, 0, k, 0,
      x + w, y + r, 0, -k, 0, 0, x + w, y + h - r, 0, 0, 0, k,
      x + w - r, y + h, k, 0, 0, 0, x + r, y + h, 0, 0, -k, 0,
      x, y + h - r, 0, k, 0, 0, x, y + r, 0, 0, 0, -k,
    ];
    return { pts: flattenBezier(f, true), closed: true };
  }
  if (s.kind === 'ellipse') {
    const [w, h] = vec(ev(s.size, 'size'), 2, [100, 100]);
    const N = Math.max(24, Math.min(160, Math.ceil((Math.abs(w) + Math.abs(h)) / 6)));
    const pts: number[] = [];
    for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2 - Math.PI / 2; pts.push(Math.cos(a) * w / 2, Math.sin(a) * h / 2); }
    return { pts, closed: true };
  }
  if (s.kind === 'star' || s.kind === 'polygon') {
    const n = Math.max(3, Math.round(num(ev(s.points, 'points'), 5)));
    const ro = num(ev(s.outerRadius, 'outerRadius'), 100), ri = num(ev(s.innerRadius, 'innerRadius'), 50);
    const pts: number[] = [];
    const count = s.kind === 'star' ? n * 2 : n;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      const r = s.kind === 'star' && i % 2 ? ri : ro;
      pts.push(Math.cos(a) * r, Math.sin(a) * r);
    }
    return { pts, closed: true };
  }
  // keys with different vertex counts (egg → ball → flame): morph the flattened outlines
  const ks = s.path.k;
  if (ks && ks.length > 1 && !s.path.x && t > ks[0].t && t < ks[ks.length - 1].t) {
    let i = 0;
    while (i < ks.length - 2 && t >= ks[i + 1].t) i++;
    const a = ks[i].v as number[], b = ks[i + 1].v as number[];
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length && (ks[i].i ?? 'linear') !== 'hold') {
      return { pts: morphOutlines({ pts: flattenBezier(a, s.closed), closed: s.closed }, { pts: flattenBezier(b, s.closed), closed: s.closed }, segmentProgress(ks[i], ks[i + 1], t)), closed: s.closed };
    }
  }
  const flat = ev(s.path, 'path') as number[];
  return { pts: flattenBezier(Array.isArray(flat) ? flat : [], s.closed), closed: s.closed };
}

const signedArea = (p: number[]) => { let a = 0; for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; } return a / 2; };
/** Morph between two outlines of any vertex count: both are resampled, wound the same way and the start of
 * the second is rotated to the closest match, then the points are blended (u may overshoot for elastic keys). */
export function morphOutlines(a: Outline, b: Outline, u: number): number[] {
  const N = 128;
  const pa = resampleOutline(a, N);
  let pb = resampleOutline(b, N);
  if (pa.length !== pb.length) return u < 0.5 ? a.pts : b.pts;
  const n = pa.length / 2;
  if (a.closed && b.closed) {
    if (Math.sign(signedArea(pa)) !== Math.sign(signedArea(pb))) { const r: number[] = []; for (let i = n - 1; i >= 0; i--) r.push(pb[i * 2], pb[i * 2 + 1]); pb = r; }
    let best = 0, bestD = Infinity;
    for (let off = 0; off < n; off++) { let d = 0; for (let i = 0; i < n; i += 4) { const j = (i + off) % n; d += (pa[i * 2] - pb[j * 2]) ** 2 + (pa[i * 2 + 1] - pb[j * 2 + 1]) ** 2; } if (d < bestD) { bestD = d; best = off; } }
    if (best) { const r: number[] = []; for (let i = 0; i < n; i++) { const j = (i + best) % n; r.push(pb[j * 2], pb[j * 2 + 1]); } pb = r; }
  }
  return pa.map((v, i) => v + (pb[i] - v) * u);
}

/** n points evenly spaced along the outline (closed: around the loop; open: both ends included). */
export function resampleOutline(o: Outline, n: number): number[] {
  const acc = polyLen(o.pts, o.closed);
  const L = acc[acc.length - 1];
  const m = o.pts.length / 2;
  if (!(L > 0) || m < 2) return o.pts.slice();
  const out: number[] = [];
  const count = o.closed ? n : n + 1;
  let seg = 1;
  for (let i = 0; i < count; i++) {
    const d = (i / n) * L;
    while (seg < acc.length - 1 && acc[seg] < d) seg++;
    const a = ((seg - 1) % m) * 2, b = (seg % m) * 2;
    const f = (d - acc[seg - 1]) / (acc[seg] - acc[seg - 1] || 1);
    out.push(o.pts[a] + (o.pts[b] - o.pts[a]) * f, o.pts[a + 1] + (o.pts[b + 1] - o.pts[a + 1]) * f);
  }
  return out;
}
/** unit normal at every point of a polyline */
function normals(pts: number[], closed: boolean): number[] {
  const n = pts.length / 2, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1), b = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const dx = pts[b * 2] - pts[a * 2], dy = pts[b * 2 + 1] - pts[a * 2 + 1], d = Math.hypot(dx, dy) || 1;
    out.push(dy / d, -dx / d);
  }
  return out;
}
/** Pucker & bloat on bezier vertices: amount +100 pulls every vertex to the centre and pushes the segments out
 *  (petals); −100 pushes the vertices out and pulls the segments in (spikes). */
export function puckerOutline(flat: number[], closed: boolean, amount: number): Outline {
  const n = Math.floor(flat.length / 6), a = Math.max(-2, Math.min(2, amount / 100));
  if (n < 2 || !a) return { pts: flattenBezier(flat, closed), closed };
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += flat[i * 6]; cy += flat[i * 6 + 1]; }
  cx /= n; cy /= n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = flat[i * 6], y = flat[i * 6 + 1], dx = x - cx, dy = y - cy;
    // the vertex moves towards (+) or away from (−) the centre; its handles point the other way
    out.push(x - dx * a, y - dy * a, flat[i * 6 + 2] + dx * a, flat[i * 6 + 3] + dy * a, flat[i * 6 + 4] + dx * a, flat[i * 6 + 5] + dy * a);
  }
  return { pts: flattenBezier(out, closed), closed };
}
/** Round corners: every corner of the polyline becomes a curve that starts `radius` px before it. */
export function roundCornersOutline(o: Outline, radius: number): Outline {
  const n = o.pts.length / 2;
  if (radius <= 0 || n < 3) return o;
  const p = o.pts, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const bx = p[i * 2], by = p[i * 2 + 1];
    if (!o.closed && (i === 0 || i === n - 1)) { out.push(bx, by); continue; }
    const a = (i - 1 + n) % n, c = (i + 1) % n;
    const ax = p[a * 2] - bx, ay = p[a * 2 + 1] - by, cx = p[c * 2] - bx, cy = p[c * 2 + 1] - by;
    const la = Math.hypot(ax, ay), lc = Math.hypot(cx, cy);
    const inner = Math.abs(Math.atan2(ax * cy - ay * cx, ax * cx + ay * cy));
    // nearly straight (outlines that are already curves): keep the point
    if (!la || !lc || inner > Math.PI * 0.94) { out.push(bx, by); continue; }
    const d = Math.min(radius, la / 2, lc / 2);
    const x0 = bx + (ax / la) * d, y0 = by + (ay / la) * d, x1 = bx + (cx / lc) * d, y1 = by + (cy / lc) * d;
    const steps = Math.max(3, Math.min(24, Math.ceil(d / 3)));
    for (let k = 0; k <= steps; k++) { const u = k / steps, v = 1 - u; out.push(v * v * x0 + 2 * v * u * bx + u * u * x1, v * v * y0 + 2 * v * u * by + u * u * y1); }
  }
  return { pts: out, closed: o.closed };
}
/** Offset paths: every point moves `amount` px outwards (− inwards); sharp corners are joined with a miter (up to
 *  miterLimit, then a bevel), a round arc or a bevel. */
export function offsetOutline(o: Outline, amount: number, join: 'miter' | 'round' | 'bevel', miterLimit = 4): Outline {
  const p = o.pts, n = p.length / 2;
  if (!amount || n < 2) return o;
  // outward normal: depends on the winding (shoelace area sign)
  let area = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  const sgn = area < 0 ? -1 : 1;
  const nrm = (i: number, j: number): [number, number] => { const dx = p[j * 2] - p[i * 2], dy = p[j * 2 + 1] - p[i * 2 + 1], d = Math.hypot(dx, dy) || 1; return [(dy / d) * sgn, (-dx / d) * sgn]; };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = p[i * 2], y = p[i * 2 + 1];
    const n1 = o.closed || i > 0 ? nrm((i - 1 + n) % n, i) : null, n2 = o.closed || i < n - 1 ? nrm(i, (i + 1) % n) : null;
    if (!n1 || !n2) { const m = (n1 ?? n2)!; out.push(x + m[0] * amount, y + m[1] * amount); continue; }
    const mx = n1[0] + n2[0], my = n1[1] + n2[1], ml = Math.hypot(mx, my);
    const cos = ml / 2; // cos of half the angle between the two normals
    if (cos > 0.985) { out.push(x + (mx / ml) * amount, y + (my / ml) * amount); continue; } // straight enough
    // the offset edges leave a gap only on the outer side of a corner (the next normal leans forward along the
    // incoming edge); on the inner side they cross: their intersection is the point (joins would make loops)
    const e1x = x - p[((i - 1 + n) % n) * 2], e1y = y - p[((i - 1 + n) % n) * 2 + 1];
    const gap = (n2[0] * e1x + n2[1] * e1y) * amount > 0;
    if (!gap && ml > 1e-6) { const k = Math.min(Math.abs(amount) * miterLimit, Math.abs(amount / cos)) * Math.sign(amount); out.push(x + (mx / ml) * k, y + (my / ml) * k); continue; }
    if (join === 'round') {
      const a0 = Math.atan2(n1[1], n1[0]);
      let da = Math.atan2(n2[1], n2[0]) - a0;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const steps = Math.max(2, Math.ceil(Math.abs(da) / 0.2));
      for (let k = 0; k <= steps; k++) { const an = a0 + (da * k) / steps; out.push(x + Math.cos(an) * amount, y + Math.sin(an) * amount); }
    } else if (join === 'bevel' || ml < 1e-6 || 1 / cos > miterLimit) {
      out.push(x + n1[0] * amount, y + n1[1] * amount, x + n2[0] * amount, y + n2[1] * amount);
    } else {
      const k = amount / cos;
      out.push(x + (mx / ml) * k, y + (my / ml) * k);
    }
  }
  return { pts: out, closed: o.closed };
}
/** Twist: each point turns `angle` degrees × its distance from `center` / the farthest distance. */
export function twistOutline(o: Outline, angle: number, center: [number, number]): Outline {
  if (!angle) return o;
  const pts = resampleOutline(o, Math.max(o.pts.length / 2, 240));
  let rmax = 0;
  for (let i = 0; i < pts.length; i += 2) rmax = Math.max(rmax, Math.hypot(pts[i] - center[0], pts[i + 1] - center[1]));
  if (!rmax) return o;
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i] - center[0], dy = pts[i + 1] - center[1], a = ((angle * Math.PI) / 180) * (Math.hypot(dx, dy) / rmax);
    pts[i] = center[0] + dx * Math.cos(a) - dy * Math.sin(a);
    pts[i + 1] = center[1] + dx * Math.sin(a) + dy * Math.cos(a);
  }
  return { pts, closed: o.closed };
}
/** Zigzag: ridges alternate ±size along the normal (corners, or a sine wave when smooth). */
export function zigzagOutline(o: Outline, size: number, ridges: number, smooth: boolean): Outline {
  const R = Math.max(1, Math.min(2000, ridges));
  if (!size) return o;
  const n = smooth ? Math.min(16000, R * 16) : R * 2;
  const pts = resampleOutline(o, n);
  const nm = normals(pts, o.closed);
  for (let i = 0; i < pts.length / 2; i++) {
    const k = smooth ? Math.sin((i / n) * R * Math.PI * 2) : i % 2 ? 1 : -1;
    pts[i * 2] += nm[i * 2] * size * k;
    pts[i * 2 + 1] += nm[i * 2 + 1] * size * k;
  }
  return { pts, closed: o.closed };
}
/** 3-D value noise in [-1, 1] (smooth in every axis). */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const s3 = (u: number) => u * u * (3 - 2 * u);
  const u = s3(fx), v = s3(fy), w = s3(fz);
  const h = (a: number, b: number, c: number) => hash2(hash2(seed, a), hash2(b, c)) / 2147483648 - 1;
  const l = (a: number, b: number, k: number) => a + (b - a) * k;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
/** Wiggle paths: `detail` noise features along the outline, each moving up to `size` px; z is the evolution
 * (time × wiggles per second). Closed outlines use noise on a circle so the seam does not jump. */
export function wiggleOutline(o: Outline, size: number, detail: number, z: number, seed: number, smooth: boolean): Outline {
  const M = Math.max(2, Math.min(2000, detail));
  if (!size) return o;
  const n = smooth ? Math.min(16000, Math.max(48, M * 10)) : M;
  const pts = resampleOutline(o, n);
  const R = M / (Math.PI * 2);
  for (let i = 0; i < pts.length / 2; i++) {
    const u = i / n;
    const cx = o.closed ? Math.cos(u * Math.PI * 2) * R : u * M, cy = o.closed ? Math.sin(u * Math.PI * 2) * R : 0;
    pts[i * 2] += size * noise3(cx, cy, z, seed);
    pts[i * 2 + 1] += size * noise3(cx + 31.7, cy + 17.3, z, seed + 7919);
  }
  return { pts, closed: o.closed };
}

function polyLen(pts: number[], closed: boolean): number[] {
  const n = pts.length / 2;
  const acc = [0];
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = ((i - 1) % n) * 2, b = (i % n) * 2;
    acc.push(acc[i - 1] + Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1]));
  }
  return acc;
}
function slice(pts: number[], acc: number[], closed: boolean, d0: number, d1: number): number[] {
  const n = pts.length / 2, out: number[] = [];
  const at = (d: number) => {
    let i = 1;
    while (i < acc.length - 1 && acc[i] < d) i++;
    const a = ((i - 1) % n) * 2, b = (i % n) * 2;
    const f = (d - acc[i - 1]) / (acc[i] - acc[i - 1] || 1);
    return [pts[a] + (pts[b] - pts[a]) * f, pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f, i];
  };
  const [x0, y0, i0] = at(d0);
  const [x1, y1, i1] = at(d1);
  out.push(x0, y0);
  for (let i = i0; i < i1; i++) { const p = (i % n) * 2; out.push(pts[p], pts[p + 1]); }
  out.push(x1, y1);
  void closed;
  return out;
}
/** Trim paths: keeps [start, end] % of the outline, rotated by offset degrees (wraps on closed outlines). */
export function trimOutline(o: Outline, start: number, end: number, offset: number): Outline[] {
  let s = Math.max(0, Math.min(100, start)) / 100, e = Math.max(0, Math.min(100, end)) / 100;
  if (s > e) [s, e] = [e, s];
  if (e - s >= 0.9999 && !offset) return [o];
  if (e - s <= 1e-5) return [];
  const acc = polyLen(o.pts, o.closed);
  const L = acc[acc.length - 1];
  if (L <= 0) return [];
  const off = ((offset / 360) % 1 + 1) % 1;
  let a = (s + off) * L, b = (e + off) * L;
  if (!o.closed) { a = Math.min(a, L); b = Math.min(b, L); return a < b ? [{ pts: slice(o.pts, acc, false, a, b), closed: false }] : []; }
  if (b <= L) return [{ pts: slice(o.pts, acc, true, a, b), closed: false }];
  if (a >= L) return [{ pts: slice(o.pts, acc, true, a - L, b - L), closed: false }];
  return [{ pts: slice(o.pts, acc, true, a, L), closed: false }, { pts: slice(o.pts, acc, true, 0, b - L), closed: false }];
}

export function outlineBounds(pts: number[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}
