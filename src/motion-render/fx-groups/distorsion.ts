// Drawing of the effects in src/core/motion/fx-groups/distorsion.ts. Helpers come from ../fx: only use them inside
// the functions (fx.ts imports this file while it is still loading).
import type { FxCtx, FxFn } from '../fx';
import { mk, ctx2d, blurCanvas } from '../fx';
import { GLMesh } from '../gl';
import { parseColor } from '../../core/motion/anim';
import { opticalFlow } from '../flow';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rad = (d: number) => (d * Math.PI) / 180;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** a point parameter in canvas pixels */
const pt = (v: unknown, x: FxCtx): [number, number] => {
  const a = Array.isArray(v) ? num(v[0]) : 0, b = Array.isArray(v) ? num(v[1]) : 0;
  return [(a - (x.pox ?? 0) - x.ox) * x.res, (b - (x.poy ?? 0) - x.oy) * x.res];
};
const rgb = (c: unknown): [number, number, number] => { const [r, g, b] = parseColor(String(c ?? '#ffffff')); return [r * 255, g * 255, b * 255]; };
const data = (cv: HTMLCanvasElement) => ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height);
const toCanvas = (im: ImageData) => { const c = mk(im.width, im.height); ctx2d(c).putImageData(im, 0, 0); return c; };

/** Inverse warp: every output pixel takes the source at src(x, y) (bilinear, premultiplied; null or outside = clear). */
function remap(cv: HTMLCanvasElement, src: (x: number, y: number) => [number, number] | null): HTMLCanvasElement {
  const W = cv.width, H = cv.height, s = data(cv).data, out = new ImageData(W, H), o = out.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = src(x + 0.5, y + 0.5);
    if (!q) continue;
    const fx = q[0] - 0.5, fy = q[1] - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    if (x0 < -1 || y0 < -1 || x0 >= W || y0 >= H) continue;
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = 0; k < 4; k++) {
      const X = x0 + (k & 1), Y = y0 + (k >> 1);
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const w = ((k & 1) ? ax : 1 - ax) * ((k >> 1) ? ay : 1 - ay), i = (Y * W + X) * 4, al = s[i + 3] * w;
      r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al;
    }
    if (a <= 0) continue;
    const i = (y * W + x) * 4;
    o[i] = r / a; o[i + 1] = g / a; o[i + 2] = b / a; o[i + 3] = a;
  }
  return toCanvas(out);
}

let meshGL: GLMesh | null = null;
/** Forward warp: an n × n grid over the source whose vertices go where to(u, v) says (canvas px). */
function warpGrid(cv: HTMLCanvasElement, n: number, to: (u: number, v: number) => [number, number]): HTMLCanvasElement {
  const N = n + 1, pos = new Float32Array(N * N * 2), uv = new Float32Array(N * N * 2), tris: number[] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, u = i / n, v = j / n, p = to(u, v);
    uv[k * 2] = u; uv[k * 2 + 1] = v; pos[k * 2] = p[0]; pos[k * 2 + 1] = p[1];
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * N + i, b = a + 1, c = a + N, d = c + 1; tris.push(a, b, d, a, d, c); }
  meshGL ??= new GLMesh();
  const out = mk(cv.width, cv.height);
  ctx2d(out).drawImage(meshGL.draw(cv, cv.width, cv.height, pos, uv, new Uint32Array(tris)), 0, 0);
  return out;
}

/** Keeps the layer where keep(x, y) is 1, clears it where 0 (soft values fade it). */
function matte(cv: HTMLCanvasElement, keep: (x: number, y: number) => number): HTMLCanvasElement {
  const im = data(cv), d = im.data, W = cv.width;
  for (let i = 0; i < d.length; i += 4) { const k = clamp01(keep((i / 4) % W + 0.5, Math.floor(i / 4 / W) + 0.5)); if (k < 1) d[i + 3] *= k; }
  return toCanvas(im);
}

/** Lights an edge band: s in −1…1 (towards / away from the light) brightens with the light colour or darkens. */
function shade(d: Uint8ClampedArray, i: number, s: number, L: [number, number, number], k: number) {
  if (s > 0) { const t = s * k; for (let c = 0; c < 3; c++) d[i + c] += (L[c] - d[i + c]) * t; }
  else { const t = 1 + s * k; for (let c = 0; c < 3; c++) d[i + c] *= t; }
}

/** Separable box blur of a float field (radius r px), twice: close to a Gaussian. Outside the canvas counts as 0
 *  (the layer's border is an alpha edge). */
function boxBlur(a: Float32Array, W: number, H: number, r: number): Float32Array {
  if (r < 1) return a;
  const n = r * 2 + 1;
  let src = a;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
    const at = (f: Float32Array, x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : f[y * W + x]);
    for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x <= r; x++) s += at(src, x, y); for (let x = 0; x < W; x++) { tmp[y * W + x] = s / n; s += at(src, x + r + 1, y) - at(src, x - r, y); } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += at(tmp, x, y); for (let y = 0; y < H; y++) { out[y * W + x] = s / n; s += at(tmp, x, y + r + 1) - at(tmp, x, y - r); } }
    src = out;
  }
  return src;
}

/** Normalised warp of the Warp effect: (u, v) in −1…1 → where it goes, b = bend (−1…1). */
function cannedWarp(style: string, u: number, v: number, b: number): [number, number] {
  switch (style) {
    case 'arc': {
      // rows become concentric arcs (constant thickness) round a centre below (b > 0) or above
      if (Math.abs(b) < 1e-3) return [u, v];
      const a = b * Math.PI / 2, c = 1 / a, phi = u * a;
      return [(c - v) * Math.sin(phi), c - (c - v) * Math.cos(phi)];
    }
    case 'arcLower': return [u, v + b * (1 - u * u) * (v + 1) / 2];
    case 'arcUpper': return [u, v - b * (1 - u * u) * (1 - v) / 2];
    case 'arch': return [u, v - b * (1 - u * u) * 0.5];
    case 'bulge': return [u, v * (1 + b * (1 - u * u) * 0.5)];
    case 'shellLower': return [u, v - b * u * u * (v + 1) / 2];
    case 'shellUpper': return [u, v + b * u * u * (1 - v) / 2];
    case 'flag': return [u, v + b * 0.5 * Math.sin(u * Math.PI)];
    // wave: like the flag, but the top edge waves more than the bottom one
    case 'wave': return [u, v + b * 0.5 * Math.sin(u * Math.PI) * (1 - 0.5 * v)];
    // fish: a fat body and a waving tail
    case 'fish': return [u, v * (1 + b * 0.5 * Math.sin((u + 1) * Math.PI / 2)) + b * 0.15 * Math.sin(u * Math.PI)];
    case 'rise': return [u, v - b * 0.5 * Math.sin(u * Math.PI / 2)];
    case 'fisheye': { const r2 = u * u + v * v, k = 1 + b * 0.5 * Math.max(0, 1 - r2); return [u * k, v * k]; }
    case 'inflate': { const k = 1 + b * 0.5 * (1 - u * u) * (1 - v * v); return [u * k, v * k]; }
    case 'twist': { const r = Math.min(1, Math.hypot(u, v) / Math.SQRT2), a = b * Math.PI * (1 - r); const c = Math.cos(a), s = Math.sin(a); return [u * c - v * s, u * s + v * c]; }
    case 'squeeze': return [u * (1 - b * 0.5 * (1 - v * v)), v * (1 + b * 0.5 * (1 - u * u))];
  }
  return [u, v];
}

// ── a small ray tracer for the 3D effects (Basic 3D, CC Cylinder, CC Sphere…). Space: x right, y down, z away from
//    the viewer, origin at the layer's centre; the eye sits at z = −F, F like After Effects' default 50 mm camera ──
type V3 = [number, number, number];
type M3 = number[]; // row-major 3 × 3
const mul = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const mulT = (m: M3, v: V3): V3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
const mm = (a: M3, b: M3): M3 => { const r: M3 = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]); return r; };
const rotAxis = (axis: string, deg: number): M3 => {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return axis === 'x' ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 'y' ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1];
};
/** rotation applying the axes in `order` (e.g. 'xyz': X first) */
const rotation = (rx: number, ry: number, rz: number, order = 'xyz'): M3 => {
  const A: Record<string, number> = { x: rx, y: ry, z: rz };
  let m: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const a of order) m = mm(rotAxis(a, A[a]), m);
  return m;
};
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** focal distance in px of After Effects' default camera for a frame of width w (2666.7 px for 1920) */
const focal = (w: number) => w * 1.38889;

/** Bilinear premultiplied sampling of a canvas: s(x, y, out) writes r, g, b, a (premultiplied, 0–255) */
function sampler(cv: HTMLCanvasElement, wrapX = false) {
  const W = cv.width, H = cv.height, s = data(cv).data;
  return (fx: number, fy: number, o: Float32Array, k = 0) => {
    fx -= 0.5; fy -= 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    o[k] = o[k + 1] = o[k + 2] = o[k + 3] = 0;
    for (let q = 0; q < 4; q++) {
      let X = x0 + (q & 1); const Y = y0 + (q >> 1);
      if (wrapX) X = ((X % W) + W) % W;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const w = ((q & 1) ? ax : 1 - ax) * ((q >> 1) ? ay : 1 - ay), i = (Y * W + X) * 4, al = s[i + 3] * w / 255;
      o[k] += s[i] * al; o[k + 1] += s[i + 1] * al; o[k + 2] += s[i + 2] * al; o[k + 3] += s[i + 3] * w;
    }
  };
}
/** Builds a W × H canvas from px(x, y, out) writing premultiplied r, g, b, a (0–255) */
function paint(W: number, H: number, px: (x: number, y: number, o: Float32Array) => void): HTMLCanvasElement {
  const im = new ImageData(W, H), d = im.data, o = new Float32Array(4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    o[0] = o[1] = o[2] = o[3] = 0;
    px(x + 0.5, y + 0.5, o);
    const a = o[3];
    if (a <= 0.5) continue;
    const i = (y * W + x) * 4, k = 255 / a;
    d[i] = o[0] * k; d[i + 1] = o[1] * k; d[i + 2] = o[2] * k; d[i + 3] = a;
  }
  return toCanvas(im);
}
/** a over b, both premultiplied (in place into b) */
const over = (a: Float32Array, ka: number, b: Float32Array) => { const t = 1 - a[ka + 3] / 255; for (let c = 0; c < 4; c++) b[c] = a[ka + c] + b[c] * t; };
/** Phong-like shading of a premultiplied colour (CC Cylinder / CC Sphere's Light and Shading groups) */
function shadePx(o: Float32Array, k: number, n: V3, view: V3, L: V3, lc: [number, number, number], sh: { amb: number; dif: number; spec: number; rough: number; metal: number; inten: number }) {
  const a = o[k + 3];
  if (a <= 0) return;
  const nl = Math.max(0, dot(n, L)), h = norm([L[0] + view[0], L[1] + view[1], L[2] + view[2]]);
  const sp = nl > 0 ? sh.spec * Math.pow(Math.max(0, dot(n, h)), 1 / Math.max(1e-3, sh.rough)) * sh.inten : 0;
  for (let c = 0; c < 3; c++) {
    const col = o[k + c], lit = col * (sh.amb + sh.dif * nl * sh.inten * lc[c] / 255);
    // Metal: the highlight takes the surface colour (100 %) or the light's (0 %)
    const hi = sp * (lc[c] / 255) * (sh.metal * col + (1 - sh.metal) * a);
    o[k + c] = Math.min(a, lit + hi);
  }
}

/** light vector of CycoreFX's Light group: Direction (0° = up, clockwise) and Height (−100…100 → −90°…90° over the
 *  layer, towards the viewer) */
const ccLight = (p: Record<string, unknown>, dh: number, dd: number): V3 => {
  const a = rad(num(p.lightDirection, dd)), e = rad(num(p.lightHeight, dh) * 0.9);
  return norm([Math.sin(a) * Math.cos(e), -Math.cos(a) * Math.cos(e), -Math.sin(e)]);
};
const ccShading = (p: Record<string, unknown>, d: [number, number, number, number, number]) => ({ amb: num(p.ambient, d[0]) / 100, dif: num(p.diffuse, d[1]) / 100, spec: num(p.specular, d[2]) / 100, rough: num(p.roughness, d[3]), metal: num(p.metal, d[4]) / 100, inten: num(p.lightIntensity, 100) / 100 });
/** another layer (a layer parameter) stretched over this canvas, or null */
function other(id: unknown, cv: HTMLCanvasElement, x: FxCtx): HTMLCanvasElement | null {
  const L = typeof id === 'string' && id && x.layer ? x.layer(id) : null;
  if (!L || !L.cv.width || !L.cv.height) return null;
  const out = mk(cv.width, cv.height);
  ctx2d(out).drawImage(L.cv, 0, 0, cv.width, cv.height);
  return out;
}
/** 0…1 value of a pixel's property (straight RGBA) */
function prop(d: Uint8ClampedArray, i: number, k: string): number {
  const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  switch (k) {
    case 'red': return r;
    case 'green': return g;
    case 'blue': return b;
    case 'alpha': return d[i + 3] / 255;
    case 'lightness': return (mx + mn) / 2;
    case 'saturation': return mx ? (mx - mn) / mx : 0;
    case 'hue': { if (mx === mn) return 0; const c = mx - mn; const h = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4; return h / 6; }
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) * (d[i + 3] / 255);
}
/** a 0…1 map of a canvas' property, optionally blurred (radius px) */
function propMap(cv: HTMLCanvasElement, k: string, blur = 0): Float32Array {
  const d = data(cv).data, m = new Float32Array(cv.width * cv.height);
  for (let i = 0; i < m.length; i++) m[i] = prop(d, i * 4, k);
  return blur >= 1 ? boxBlurEdge(m, cv.width, cv.height, Math.round(blur)) : m;
}
/** box blur (twice) that repeats the edge values instead of fading to 0 */
function boxBlurEdge(a: Float32Array, W: number, H: number, r: number): Float32Array {
  let src = a;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(a.length), out = new Float32Array(a.length), n = r * 2 + 1;
    const cx = (v: number) => (v < 0 ? 0 : v >= W ? W - 1 : v), cy = (v: number) => (v < 0 ? 0 : v >= H ? H - 1 : v);
    for (let y = 0; y < H; y++) { let s = 0; for (let k = -r; k <= r; k++) s += src[y * W + cx(k)]; for (let x = 0; x < W; x++) { tmp[y * W + x] = s / n; s += src[y * W + cx(x + r + 1)] - src[y * W + cx(x - r)]; } }
    for (let x = 0; x < W; x++) { let s = 0; for (let k = -r; k <= r; k++) s += tmp[cy(k) * W + x]; for (let y = 0; y < H; y++) { out[y * W + x] = s / n; s += tmp[cy(y + r + 1) * W + x] - tmp[cy(y - r) * W + x]; } }
    src = out;
  }
  return src;
}
const smooth = (e0: number, e1: number, v: number) => { const t = clamp01((v - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };
/** deterministic 0…1 random of integers */
const hash = (a: number, b: number, c = 0) => { const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return h - Math.floor(h); };
/** smooth −1…1 noise in time for jitter (sum of sines with random phases) */
const wob = (t: number, a: number, b: number, c: number) => (Math.sin(t * 2.1 + hash(a, b, c) * 6.283) + Math.sin(t * 3.7 + hash(b, c, a) * 6.283) * 0.5) / 1.5;

// ── Card Wipe's Camera System and Lighting / Material groups (After Effects' CAMLIGHT groups) ──
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** inverse of a row-major 3 × 3 matrix, null when it is singular */
function inv3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
/** homography of the unit square onto a quad given clockwise from the top-left corner: (u, v, 1) → screen */
function squareToQuad(q: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1 || 1e-12;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
/** the focal length (px) of the camera that sees a plane through homography Hp (principal point at the centre): from
 *  the two columns of K⁻¹·Hp being perpendicular, or else of equal length; null for an affine view */
function autoFocal(Hp: number[], W: number, H: number): number | null {
  const h = mm([1, 0, -W / 2, 0, 1, -H / 2, 0, 0, 1], Hp);
  let f2 = Math.abs(h[6] * h[7]) > 1e-14 ? -(h[0] * h[1] + h[3] * h[4]) / (h[6] * h[7]) : NaN;
  if (!(f2 > 0)) { const den = h[6] * h[6] - h[7] * h[7]; f2 = Math.abs(den) > 1e-14 ? (h[1] * h[1] + h[4] * h[4] - h[0] * h[0] - h[3] * h[3]) / den : NaN; }
  return f2 > 0 && Number.isFinite(f2) ? Math.max(0.05 * W, Math.min(1000 * W, Math.sqrt(f2))) : null;
}
/** a camera: K (camera → screen px) and its inverse, R and T (layer space → camera space). Layer space is in px from
 *  the layer's centre, z away from the viewer */
interface CardView { K: number[]; Ki: number[]; R: M3; T: V3 }
/**
 * The Camera System group. Camera Position: the layer is turned by X / Y / Z Rotation, its centre goes to X,Y Position
 * and the camera stands Z Position away, with a Focal Length of 70 at Z 2 showing the layer at its own size (After
 * Effects' unit: half the layer's width; focal length as a share of a 70-wide film). Corner Pins: the camera (and
 * its focal length when Auto Focal Length is on) that puts the layer's corners on the four pins. Comp Camera: the
 * composition's camera, solved like Corner Pins from where it puts the layer's corners, with its own focal length
 * (no camera in the comp: Camera Position serves). Projects saved before the group existed (no Camera System value)
 * keep the fixed camera Cinta used then (After Effects' default 50 mm comp camera).
 */
function cardCamera(p: Record<string, unknown>, x: FxCtx, W: number, H: number): CardView {
  const view = (f: number, R: M3, T: V3): CardView => ({ K: [f, 0, W / 2, 0, f, H / 2, 0, 0, 1], Ki: [1 / f, 0, -W / 2 / f, 0, 1 / f, -H / 2 / f, 0, 0, 1], R, T });
  if (p.cameraSystem === undefined) { const F = focal(W); return view(F, I3, [0, 0, F]); }
  // the camera that puts the layer's corners (clockwise from the top-left) on q, with focal length f
  const fromQuad = (q: [number, number][], f: number, auto: boolean): CardView => {
    const Hp = mm(squareToQuad(q), [1 / W, 0, 0.5, 0, 1 / H, 0.5, 0, 0, 1]);
    if (auto) f = autoFocal(Hp, W, H) ?? f;
    const M = mm([1 / f, 0, -W / 2 / f, 0, 1 / f, -H / 2 / f, 0, 0, 1], Hp), m1: V3 = [M[0], M[3], M[6]], m2: V3 = [M[1], M[4], M[7]], m3: V3 = [M[2], M[5], M[8]];
    let lam = 2 / ((Math.hypot(...m1) + Math.hypot(...m2)) || 1);
    if (m3[2] * lam < 0) lam = -lam;
    const r1 = norm([m1[0] * lam, m1[1] * lam, m1[2] * lam]), r3 = norm(cross(r1, [m2[0] * lam, m2[1] * lam, m2[2] * lam])), r2 = cross(r3, r1);
    return view(f, [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]], [m3[0] * lam, m3[1] * lam, m3[2] * lam]);
  };
  const corners: [number, number][] = [[0, 0], [W, 0], [W, H], [0, H]];
  if (p.cameraSystem === 'cornerPins') {
    const q = ['pinUL', 'pinUR', 'pinLR', 'pinLL'].map((k, i) => (Array.isArray(p[k]) ? pt(p[k], x) : corners[i]));
    return fromQuad(q, W * num(p.pinFocal, 70) / 70, !!num(p.autoFocal));
  }
  if (p.cameraSystem === 'comp') {
    const sc = x.scene?.();
    if (sc?.camera) {
      const q = corners.map(([cx, cy]): [number, number] => { const b = sc.project(cx / x.res + x.ox, cy / x.res + x.oy, 0); return [(b[0] - x.ox) * x.res, (b[1] - x.oy) * x.res]; });
      return fromQuad(q, sc.zoom * x.res, false);
    }
  }
  const f = W * num(p.camFocal, 70) / 70, zc = num(p.camZ, 2) * W / 2, ord = String(p.transformOrder ?? 'rxyzPos'), posFirst = ord.startsWith('pos');
  const R = rotation(num(p.camRotX), num(p.camRotY), num(p.camRotZ), posFirst ? ord.slice(4) : ord.slice(1, 4));
  const [cx, cy] = Array.isArray(p.camXY) ? pt(p.camXY, x) : [W / 2, H / 2], tx = (cx - W / 2) * zc / f, ty = (cy - H / 2) * zc / f;
  if (posFirst) { const t = mul(R, [tx, ty, 0]); return view(f, R, [t[0], t[1], t[2] + zc]); }
  return view(f, R, [tx, ty, zc]);
}
/**
 * The Lighting and Material groups: a flat card lit by a Distant or Point Source at Light Position, Light Depth half
 * layer widths in front of the layer, or the composition's first light (First Comp Light; none: the distant source). Returns, per card, the factors of each channel and the specular highlight added (× alpha):
 * ambient + diffuse × intensity × N·L, and specular × intensity × (N·H)^sharpness, in the light's colour. Null for
 * projects saved before the groups existed (the cards were not shaded).
 */
function cardLight(p: Record<string, unknown>, x: FxCtx, W: number, H: number) {
  if (p.lightType === undefined) return null;
  let I = num(p.lightIntensity, 1), lc = rgb(p.lightColor).map((v) => v / 255);
  const [lx, ly] = Array.isArray(p.lightPos) ? pt(p.lightPos, x) : [W / 2, H / 2];
  let Lp: V3 = [lx - W / 2, ly - H / 2, -num(p.lightDepth, 1) * W / 2], point = p.lightType === 'point';
  const CL = p.lightType === 'comp' ? x.scene?.()?.lights.find((q) => q.type !== 'ambient') : undefined;
  if (CL) {
    // its colour already carries its intensity; a parallel light shines along its direction, the others from where they are
    I = 1; lc = CL.color.slice(0, 3);
    point = CL.type !== 'parallel';
    Lp = point ? [(CL.pos[0] - x.ox) * x.res - W / 2, (CL.pos[1] - x.oy) * x.res - H / 2, CL.pos[2] * x.res] : [-CL.dir[0], -CL.dir[1], -CL.dir[2]];
  }
  const amb = num(p.ambient, 0.25), dif = num(p.diffuse, 0.75), spec = num(p.specular, 0), sharp = Math.max(0, num(p.sharpness, 10));
  return (M: M3, C: V3, view: CardView): number[] => {
    // the camera in layer space (−Rᵀ·T); the card's normal turned towards it
    const E = mulT(view.R, view.T), V = norm([-E[0] - C[0], -E[1] - C[1], -E[2] - C[2]]);
    let n = mul(M, [0, 0, -1]);
    if (dot(n, V) < 0) n = [-n[0], -n[1], -n[2]];
    const L = norm(point ? [Lp[0] - C[0], Lp[1] - C[1], Lp[2] - C[2]] : Lp), nl = Math.max(0, dot(n, L));
    const h = norm([L[0] + V[0], L[1] + V[1], L[2] + V[2]]), sp = spec > 0 ? spec * I * Math.pow(Math.max(0, dot(n, h)), sharp) : 0;
    return [0, 1, 2].map((c) => amb + dif * I * nl * lc[c]).concat([0, 1, 2].map((c) => sp * lc[c]));
  };
}

// ── mask-driven warps (Reshape, Smear): the layer's masks by name, outlines in canvas px ──
type MaskLine = NonNullable<FxCtx['masks']>[number];
/** one of the layer's masks by name or id (any letter case); undefined for an empty name */
function findMask(x: FxCtx, name: unknown): MaskLine | undefined {
  const s = String(name ?? '').trim(), ms = x.masks ?? [];
  return s ? ms.find((m) => m.name === s || m.id === s) ?? ms.find((m) => m.name.toLowerCase() === s.toLowerCase()) : undefined;
}
/** a mask's outline as flat x, y canvas px (not closed) */
function maskPoly(m: MaskLine, x: FxCtx): number[] {
  const o: number[] = [];
  for (let i = 0; i + 1 < m.pts.length; i += 2) o.push((m.pts[i] - x.ox) * x.res, (m.pts[i + 1] - x.oy) * x.res);
  if (o.length >= 4 && o[0] === o[o.length - 2] && o[1] === o[o.length - 1]) o.length -= 2;
  return o;
}
const polyArea = (P: number[]) => { let a = 0; for (let i = 0; i < P.length; i += 2) { const j = (i + 2) % P.length; a += P[i] * P[j + 1] - P[j] * P[i + 1]; } return a / 2; };
/** the same outline run the other way round, still starting at its first vertex */
const reversePoly = (P: number[]) => { const o = [P[0], P[1]]; for (let i = P.length - 2; i >= 2; i -= 2) o.push(P[i], P[i + 1]); return o; };
/** the point a share u (0…1) of the way round a closed outline, from its first vertex */
function polyAt(P: number[], u: number): [number, number] {
  const n = P.length / 2, seg: number[] = [];
  let L = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, l = Math.hypot(P[j * 2] - P[i * 2], P[j * 2 + 1] - P[i * 2 + 1]); seg.push(l); L += l; }
  let d = (u - Math.floor(u)) * L;
  for (let i = 0; i < n; i++) {
    if (d <= seg[i] || i === n - 1) { const j = (i + 1) % n, f = seg[i] ? Math.min(1, d / seg[i]) : 0; return [P[i * 2] + (P[j * 2] - P[i * 2]) * f, P[i * 2 + 1] + (P[j * 2 + 1] - P[i * 2 + 1]) * f]; }
    d -= seg[i];
  }
  return [P[0], P[1]];
}
/** Correspondence points: the share of the destination outline that matches share ua of the source one (piecewise
 *  linear between the pairs, round the loop) */
function corresp(pairs: [number, number][], ua: number): [number, number] {
  const ps = [...pairs].sort((a, b) => a[0] - b[0]), n = ps.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) if (ps[i][0] <= ua) j = i;
  const [s0, d0] = ps[j], [s1r, d1r] = ps[(j + 1) % n];
  let s1 = s1r, d1 = d1r;
  if (s1 <= s0) s1 += 1;
  if (d1 <= d0) d1 += 1;
  let u = ua;
  if (u < s0) u += 1;
  const f = (u - s0) / (s1 - s0 || 1);
  return [ua, d0 + (d1 - d0) * f];
}
/** even-odd point in polygon */
function inPoly(P: number[], X: number, Y: number): boolean {
  let c = false;
  for (let i = 0, j = P.length - 2; i < P.length; j = i, i += 2) {
    const yi = P[i + 1], yj = P[j + 1];
    if ((yi > Y) !== (yj > Y) && X < ((P[j] - P[i]) * (Y - yi)) / (yj - yi) + P[i]) c = !c;
  }
  return c;
}
/** Elasticity: how fast a control point's pull fades with distance (the weight exponent of the warp) */
const elasticity = (v: unknown) => 1 + Math.max(0, ['stiff', 'lessStiff', 'belowNormal', 'normal', 'absNormal', 'aboveAverage', 'loose', 'liquid', 'superFluid'].indexOf(String(v ?? 'stiff'))) * 0.25;
/** As-rigid-as-possible moving least squares (Schaefer et al. 2006): where (X, Y) goes when points P move to Q */
function mlsRigid(P: [number, number][], Q: [number, number][], X: number, Y: number, alpha: number): [number, number] {
  const n = P.length, w = new Float64Array(n);
  let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++) {
    const d2 = (P[i][0] - X) ** 2 + (P[i][1] - Y) ** 2;
    if (d2 < 1e-8) return [Q[i][0], Q[i][1]];
    const wi = 1 / d2 ** alpha;
    w[i] = wi; sw += wi; px += wi * P[i][0]; py += wi * P[i][1]; qx += wi * Q[i][0]; qy += wi * Q[i][1];
  }
  px /= sw; py /= sw; qx /= sw; qy /= sw;
  // Σ w q̂ · conj(p̂) as a complex number: the local rotation (and scale, dropped below)
  let zr = 0, zi = 0;
  for (let i = 0; i < n; i++) { const ax = P[i][0] - px, ay = P[i][1] - py, bx = Q[i][0] - qx, by = Q[i][1] - qy; zr += w[i] * (bx * ax + by * ay); zi += w[i] * (by * ax - bx * ay); }
  const vx = X - px, vy = Y - py, fx = zr * vx - zi * vy, fy = zr * vy + zi * vx, fl = Math.hypot(fx, fy), vl = Math.hypot(vx, vy);
  if (fl < 1e-12) return [qx + vx, qy + vy];
  return [qx + fx * vl / fl, qy + fy * vl / fl];
}
/** Forward warp of the layer by control points P → Q (canvas px); the Boundary Mask's outline (or else the layer's
 *  border) stays put and nothing outside the boundary moves */
function maskWarp(cv: HTMLCanvasElement, x: FxCtx, ps: [number, number][], qs: [number, number][], bound: MaskLine | undefined, alpha: number): HTMLCanvasElement {
  const W = cv.width, H = cv.height, P = ps.slice(), Q = qs.slice();
  let inside: ((X: number, Y: number) => boolean) | null = null;
  if (bound) {
    const B = maskPoly(bound, x);
    if (B.length >= 6) {
      for (let i = 0; i < 48; i++) { const b = polyAt(B, i / 48); P.push(b); Q.push(b); }
      inside = (X, Y) => inPoly(B, X, Y) !== bound.inverted;
    }
  }
  // without a boundary the layer's border holds (a fixed point at every grid vertex on it)
  const G = 48;
  if (!inside) for (let i = 0; i < G; i++) { const f = i / G; for (const b of [[f * W, 0], [W - f * W, H], [0, H - f * H], [W, f * H]] as [number, number][]) { P.push(b); Q.push(b); } }
  return warpGrid(cv, G, (u, v) => { const X = u * W, Y = v * H; return inside && !inside(X, Y) ? [X, Y] : mlsRigid(P, Q, X, Y, alpha); });
}

const BLEND: Record<string, GlobalCompositeOperation> = { normal: 'source-over', add: 'lighter', multiply: 'multiply', screen: 'screen', overlay: 'overlay', softLight: 'soft-light', hardLight: 'hard-light', colorDodge: 'color-dodge', colorBurn: 'color-burn', darken: 'darken', lighten: 'lighten', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };

export const IMPL_DISTORSION: Record<string, FxFn> = {
  // Bevel Alpha: a height field from the blurred alpha, lit from Light Angle (towards it lighter, away darker)
  bevelAlpha: (cv, p, x) => {
    const W = cv.width, H = cv.height, t = num(p.thickness, 2) * x.res, k = clamp01(num(p.intensity, 0.4));
    if (t <= 0 || k <= 0) return cv;
    const im = data(cv), d = im.data, a = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
    const h = boxBlur(a, W, H, Math.max(1, Math.round(t / 2))), L = rgb(p.lightColor), la = rad(num(p.lightAngle, -60));
    // towards the light: angle 0 = up, clockwise
    const lx = Math.sin(la), ly = -Math.cos(la);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const i = y * W + X;
      if (!d[i * 4 + 3]) continue;
      const gx = (h[y * W + Math.min(W - 1, X + 1)] - h[y * W + Math.max(0, X - 1)]) / 2, gy = (h[Math.min(H - 1, y + 1) * W + X] - h[Math.max(0, y - 1) * W + X]) / 2;
      // the slope rises inwards: an edge whose outside faces the light has a slope pointing away from it
      const s = Math.max(-1, Math.min(1, -(gx * lx + gy * ly) * t * 2));
      if (s) shade(d, i * 4, s, L, k);
    }
    return toCanvas(im);
  },
  // Bevel Edges: four bevelled faces round the layer's rectangle, each lit by how much it faces the light
  bevelEdges: (cv, p) => {
    const W = cv.width, H = cv.height, t = num(p.thickness, 0.1) * Math.min(W, H), k = clamp01(num(p.intensity, 0.4));
    if (t <= 0 || k <= 0) return cv;
    const im = data(cv), d = im.data, L = rgb(p.lightColor), la = rad(num(p.lightAngle, -60)), lx = Math.sin(la), ly = -Math.cos(la);
    const face = [-lx, -ly, lx, ly]; // left, top, right, bottom faces: dot of their outward normal with the light
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const e = [X + 0.5, y + 0.5, W - X - 0.5, H - y - 0.5];
      let m = 0; for (let j = 1; j < 4; j++) if (e[j] < e[m]) m = j;
      if (e[m] >= t) continue;
      shade(d, (y * W + X) * 4, face[m], L, k);
    }
    return toCanvas(im);
  },
  // Magnify: the area round Center (circle or square of Size) shows the layer enlarged by Magnification
  magnify: (cv, p, x) => {
    const W = cv.width, H = cv.height, [cx, cy] = pt(p.center, x), m = Math.max(1, num(p.magnification, 150) / 100), link = String(p.link ?? 'none');
    let size = num(p.size, 100) * x.res, feather = num(p.feather) * x.res;
    if (link !== 'none') size *= m;
    if (link === 'sizeFeather') feather *= m;
    const sq = p.shape === 'square', scatter = p.scaling === 'scatter', R = size + feather / 2;
    let lens = remap(cv, (px, py) => {
      const dx = px - cx, dy = py - cy;
      if ((sq ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy)) > R) return null;
      let sx = cx + dx / m, sy = cy + dy / m;
      // Scatter: enlarged pixels are jittered instead of interpolated
      if (scatter) { const h = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453; sx += ((h - Math.floor(h)) - 0.5) * m; sy += (((h * 1.7) - Math.floor(h * 1.7)) - 0.5) * m; }
      return [sx, sy];
    });
    if (p.scaling === 'soft') lens = blurCanvas(lens, Math.min(3, (m - 1) * 0.5));
    // feathered edge and opacity
    const op = clamp01(num(p.opacity, 100) / 100);
    lens = matte(lens, (px, py) => { const dx = px - cx, dy = py - cy, r = sq ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy); return op * (feather > 0 ? clamp01((R - r) / feather) : r <= size ? 1 : 0); });
    if (p.blend === 'none') return lens;
    const out = mk(W, H), g = ctx2d(out);
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = BLEND[String(p.blend ?? 'normal')] ?? 'source-over';
    g.drawImage(lens, 0, 0);
    return out;
  },
  // Warp: the Photoshop-style warp styles over the layer's box, along the horizontal or vertical axis, then the
  // horizontal / vertical distortion tapers it like a perspective
  warp: (cv, p) => {
    const W = cv.width, H = cv.height, b = num(p.bend, 50) / 100, hd = num(p.hDistortion) / 100, vd = num(p.vDistortion) / 100, vert = p.axis === 'vertical', st = String(p.style ?? 'arc');
    if (!b && !hd && !vd) return cv;
    return warpGrid(cv, 48, (s, t) => {
      let u = s * 2 - 1, v = t * 2 - 1;
      if (vert) [u, v] = [v, u];
      let [a, c] = cannedWarp(st, u, v, b);
      if (vert) [a, c] = [c, a];
      // distortion: one side grows, the other shrinks
      const a2 = a * (1 + vd * c * 0.5), c2 = c * (1 + hd * a * 0.5);
      return [(a2 + 1) / 2 * W, (c2 + 1) / 2 * H];
    });
  },
  // CC Lens: a round lens of Size round Center; Convergence > 0 magnifies the middle like a glass ball, < 0
  // shrinks it; outside the lens nothing is left
  ccLens: (cv, p, x) => {
    const [cx, cy] = pt(p.center, x), R = (num(p.size, 50) / 100) * Math.max(cv.width, cv.height) / 2, k = num(p.convergence, 100) / 100;
    if (R <= 0) return mk(cv.width, cv.height);
    return remap(cv, (px, py) => {
      const dx = px - cx, dy = py - cy, r = Math.hypot(dx, dy) / R;
      if (r >= 1) return null;
      // the sphere's height bends the rays: sqrt(1 − r²) is 1 in the middle and 0 at the rim
      const f = 1 - k * 0.5 * Math.sqrt(1 - r * r);
      return [cx + dx * f, cy + dy * f];
    });
  },
  // CC Slant: the layer leans sideways over the Floor point (sheared with Stretching, turned without it), scaled
  // in height from the floor; Set Color fills it with Color
  ccSlant: (cv, p, x) => {
    const fy = pt(p.floor, x)[1], s = num(p.slant) / 100, hgt = num(p.height, 100) / 100, stretch = num(p.stretching, 1);
    if (Math.abs(hgt) < 1e-3) return mk(cv.width, cv.height);
    // without stretching the slanted layer keeps its length (it is turned, so it ends lower)
    const k = stretch ? hgt : hgt * Math.cos(Math.atan(s));
    const out = s || k !== 1 ? remap(cv, (px, py) => { const up = fy - py; return [px - s * up, fy - up / k]; }) : (() => { const c2 = mk(cv.width, cv.height); ctx2d(c2).drawImage(cv, 0, 0); return c2; })();
    if (num(p.setColor)) { const g = ctx2d(out), [r, gg, b] = rgb(p.color); g.globalCompositeOperation = 'source-in'; g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(0, 0, cv.width, cv.height); }
    return out;
  },
  // CC Tiler: copies of the layer scaled to Scale, tiled round Center
  ccTiler: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = Math.max(0.005, num(p.scale, 100) / 100), [cx, cy] = pt(p.center, x), tw = W * s, th = H * s;
    const out = mk(W, H), g = ctx2d(out);
    const blend = clamp01(num(p.blend) / 100);
    g.globalAlpha = 1;
    const x0 = cx - tw / 2 - Math.ceil((cx - tw / 2) / tw) * tw, y0 = cy - th / 2 - Math.ceil((cy - th / 2) / th) * th;
    for (let ty = y0; ty < H; ty += th) for (let tx = x0; tx < W; tx += tw) g.drawImage(cv, tx, ty, tw, th);
    if (blend > 0) { g.globalAlpha = blend; g.drawImage(cv, 0, 0); }
    return out;
  },
  // CC Radial ScaleWipe: a hole opens at Center and the layer is pushed (scaled) outwards off the frame;
  // Reverse sucks it into the centre instead
  ccRadialScaleWipe: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    if (c >= 1) return mk(cv.width, cv.height);
    const [cx, cy] = pt(p.center, x), W = cv.width, H = cv.height;
    const Rm = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy));
    const rev = !!num(p.reverse);
    return remap(cv, (px, py) => {
      const dx = px - cx, dy = py - cy, r = Math.hypot(dx, dy);
      if (!rev) {
        const rh = c * Rm * 1.5;
        if (r <= rh) return null;
        // the old edge of the hole (the centre) is at rh now, and everything moves out by rh
        const f = (r - rh) / r;
        return [cx + dx * f, cy + dy * f];
      }
      const keep = (1 - c) * Rm;
      if (r >= keep) return null;
      const f = Rm / keep;
      return [cx + dx * f, cy + dy * f];
    });
  },
  // CC Scale Wipe: from the line through Center (across Direction) onwards the layer is stretched along
  // Direction by Stretch: the edge pixels smear off the layer
  ccScaleWipe: (cv, p, x) => {
    const st = num(p.stretch);
    if (!st) return cv;
    const [cx, cy] = pt(p.center, x), a = rad(num(p.direction)), ux = Math.sin(a), uy = -Math.cos(a), f = Math.exp(-st * 0.5);
    return remap(cv, (px, py) => {
      const d = (px - cx) * ux + (py - cy) * uy;
      if (d <= 0) return [px, py];
      return [px - ux * d * (1 - f), py - uy * d * (1 - f)];
    });
  },
  // CC Grid Wipe: a grid of Tiles (turned by Rotation round Center) whose tiles shrink away one after another,
  // in the order of the Shape (Doors: from the centre line, Radial: from the centre, Rectangular: in squares);
  // Border widens the band of tiles shrinking at the same time
  ccGridWipe: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    if (c >= 1) return mk(cv.width, cv.height);
    const W = cv.width, H = cv.height, [cx, cy] = pt(p.center, x), rot = rad(num(p.rotation, 45)), n = Math.max(1, Math.round(num(p.tiles, 10)));
    const tile = Math.max(W, H) / n, shape = String(p.shape ?? 'radial'), rev = !!num(p.reverse), spread = Math.max(0.02, num(p.border, 75) / 300);
    const co = Math.cos(rot), si = Math.sin(rot), maxD = Math.hypot(W, H) / 2 / tile + 1;
    return matte(cv, (px, py) => {
      const dx = px - cx, dy = py - cy, u = (dx * co + dy * si) / tile, v = (-dx * si + dy * co) / tile;
      const iu = Math.floor(u), iv = Math.floor(v), lu = u - iu - 0.5, lv = v - iv - 0.5, mu = iu + 0.5, mv = iv + 0.5;
      let ord = shape === 'doors' ? Math.abs(mu) : shape === 'rectangular' ? Math.max(Math.abs(mu), Math.abs(mv)) : Math.hypot(mu, mv);
      ord = clamp01(ord / maxD);
      if (rev) ord = 1 - ord;
      // this tile's own progress: 0 → whole, 1 → gone (shrunk to its centre)
      const t = clamp01((c * (1 + spread) - ord) / spread);
      const half = 0.5 * (1 - t);
      return Math.abs(lu) <= half && Math.abs(lv) <= half ? 1 : 0;
    });
  },
  // CC Jaws: the layer splits along a toothed line through Center (across Direction) and both halves move apart
  ccJaws: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    const W = cv.width, H = cv.height, [cx, cy] = pt(p.center, x), a = rad(num(p.direction)), nx = Math.sin(a), ny = -Math.cos(a), tx = -ny, ty = nx;
    const amp = (num(p.height, 10) / 100) * Math.max(W, H) / 2, period = Math.max(W, H) / Math.max(1, num(p.width, 10)), shape = String(p.shape ?? 'spikes');
    const D = c * (Math.hypot(W, H) + amp * 2) / 2;
    const edge = (s: number) => {
      const f = ((s / period) % 1 + 1) % 1;
      if (shape === 'block') return f < 0.5 ? amp : -amp;
      if (shape === 'waves') return Math.sin(f * Math.PI * 2) * amp;
      if (shape === 'roboJaw') return f < 0.25 ? amp : f < 0.5 ? -amp * 0.5 : f < 0.75 ? amp * 0.5 : -amp;
      return (1 - 4 * Math.abs(f - 0.5)) * amp;
    };
    return remap(cv, (px, py) => {
      const dx = px - cx, dy = py - cy, s = dx * tx + dy * ty, t = dx * nx + dy * ny;
      // the half behind the edge (t < edge) moves back by D, the other forward by D
      if (t + D < edge(s)) return [px + nx * D, py + ny * D];
      if (t - D > edge(s)) return [px - nx * D, py - ny * D];
      return null;
    });
  },
  // CC Line Sweep: the layer is wiped in strips of Thickness, each with a slanted edge, sweeping along Direction
  ccLineSweep: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    if (c >= 1) return mk(cv.width, cv.height);
    const W = cv.width, H = cv.height, a = rad(num(p.direction, 180)) * (num(p.flip) ? -1 : 1), th = Math.max(1, num(p.thickness, 50) * x.res), sl = num(p.slant, 50) / 100;
    const ux = Math.sin(a), uy = -Math.cos(a), vx = -uy, vy = ux;
    const half = (Math.abs(ux) * W + Math.abs(uy) * H) / 2, span = half * 2 + th * Math.abs(sl);
    return matte(cv, (px, py) => {
      const dx = px - W / 2, dy = py - H / 2, u = dx * ux + dy * uy + half, v = dx * vx + dy * vy;
      const w = (((v / th) % 1) + 1) % 1;
      // the edge reaches further into each strip at one side: a sawtooth front
      return u + w * sl * th - (sl < 0 ? sl * th : 0) >= c * span ? 1 : 0;
    });
  },

  // ── Perspective ──
  // Radial Shadow: the alpha is projected from the Light Source onto a surface Projection Distance behind the layer
  // (the shadow grows by distance / 100 away from the light), softened, in Shadow Color (Regular) or tinted by the
  // layer's own colours (Glass Edge, by Color Influence), under the layer or alone
  radialShadow: (cv, p, x) => {
    const W = cv.width, H = cv.height, [lx, ly] = pt(p.light, x), s = 1 + Math.max(0, num(p.distance, 10)) / 100, op = clamp01(num(p.opacity, 50) / 100);
    const glass = p.render === 'glass', inf = Math.max(0, num(p.influence, 100) / 100), [cr, cg, cb] = rgb(p.color ?? '#000000');
    const src = data(cv).data, im = new ImageData(W, H), d = im.data;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      // the shadow pixel comes from the layer point on the ray towards the light
      const sx = Math.floor(lx + (X + 0.5 - lx) / s), sy = Math.floor(ly + (y + 0.5 - ly) / s);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const j = (sy * W + sx) * 4, a = src[j + 3];
      if (!a) continue;
      const i = (y * W + X) * 4;
      if (glass) {
        const k = Math.min(1, inf);
        d[i] = cr + (src[j] - cr) * k; d[i + 1] = cg + (src[j + 1] - cg) * k; d[i + 2] = cb + (src[j + 2] - cb) * k;
      } else { d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; }
      d[i + 3] = a * op;
    }
    let sh = toCanvas(im);
    const soft = num(p.softness) * x.res;
    if (soft > 0) sh = blurCanvas(sh, soft / 2);
    if (num(p.only)) return sh;
    const out = mk(W, H), g = ctx2d(out);
    g.drawImage(sh, 0, 0);
    g.drawImage(cv, 0, 0);
    return out;
  },
  // Basic 3D: the layer turned round its vertical (Swivel) and horizontal (Tilt) axes and moved away (Distance to
  // Image), seen in perspective; the back shows the layer's reverse. Specular Highlight adds the glint of a light
  // above left behind the viewer (the preview wireframe is a draft aid of After Effects only)
  basic3d: (cv, p, x) => {
    const W = cv.width, H = cv.height, F = focal(W), M = rotation(num(p.tilt), num(p.swivel), 0, 'yx'), C: V3 = [0, 0, num(p.distance) * x.res];
    if (!num(p.swivel) && !num(p.tilt) && !C[2] && !num(p.specular)) return cv;
    const S = sampler(cv), spec = !!num(p.specular), L = norm([-1, -1, -1.6]), o = mulT(M, [-C[0], -C[1], -F - C[2]]);
    const tmp = new Float32Array(4);
    return paint(W, H, (px, py, out) => {
      const d = mulT(M, [px - W / 2, py - H / 2, F]);
      if (Math.abs(d[2]) < 1e-9) return;
      const t = -o[2] / d[2];
      if (t <= 0) return;
      S(o[0] + d[0] * t + W / 2, o[1] + d[1] * t + H / 2, tmp);
      for (let c = 0; c < 4; c++) out[c] = tmp[c];
      if (spec && tmp[3] > 0) {
        const nw = mul(M, [0, 0, d[2] > 0 ? -1 : 1]), v = norm([-(px - W / 2), -(py - H / 2), -F]), h = norm([L[0] + v[0], L[1] + v[1], L[2] + v[2]]);
        const k = Math.pow(Math.max(0, dot(nw, h)), 80) * tmp[3];
        for (let c = 0; c < 3; c++) out[c] = Math.min(tmp[3], out[c] + k);
      }
    });
  },
  // CC Cylinder: the layer wrapped once round a vertical cylinder (Radius 100 % = the layer's width is the
  // circumference), moved and turned in 3D, lit by the Light group and shaded with Ambient / Diffuse / Specular;
  // Render shows the outside, the inside or both
  ccCylinder: (cv, p, x) => {
    const W = cv.width, H = cv.height, F = focal(W), R = Math.max(0, num(p.radius, 100)) / 100 * W / (2 * Math.PI);
    if (R <= 0) return mk(W, H);
    const M = rotation(num(p.rotX), num(p.rotY), num(p.rotZ), String(p.rotOrder ?? 'yxz')), C: V3 = [num(p.posX) * x.res, num(p.posY) * x.res, num(p.posZ) * x.res];
    const mode = String(p.render ?? 'full'), L = ccLight(p, 25, -45), lc = rgb(p.lightColor), sh = ccShading(p, [50, 50, 50, 0.04, 100]);
    const S = sampler(cv, true), o = mulT(M, [-C[0], -C[1], -F - C[2]]), hit = new Float32Array(8);
    return paint(W, H, (px, py, out) => {
      const dw: V3 = [px - W / 2, py - H / 2, F], d = mulT(M, dw), a = d[0] * d[0] + d[2] * d[2];
      if (a < 1e-12) return;
      const b = 2 * (o[0] * d[0] + o[2] * d[2]), c = o[0] * o[0] + o[2] * o[2] - R * R, disc = b * b - 4 * a * c;
      if (disc < 0) return;
      const q = Math.sqrt(disc), view = norm([-dw[0], -dw[1], -dw[2]]);
      // far hit first, then the near one over it
      for (const t of [(-b + q) / (2 * a), (-b - q) / (2 * a)]) {
        if (t <= 0) continue;
        const P: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
        if (Math.abs(P[1]) > H / 2) continue;
        const nl: V3 = [P[0] / R, 0, P[2] / R], outside = dot(d, nl) < 0;
        if ((mode === 'outside' && !outside) || (mode === 'inside' && outside)) continue;
        S((Math.atan2(P[0], -P[2]) / (2 * Math.PI) + 0.5) * W, P[1] + H / 2, hit, 4);
        if (hit[7] <= 0) continue;
        const nw = mul(M, outside ? nl : [-nl[0], 0, -nl[2]]);
        shadePx(hit, 4, nw, view, L, lc, sh);
        over(hit, 4, out);
      }
    });
  },
  // CC Sphere: the layer mapped round a sphere of Radius at Offset (longitude across, latitude down), turned in 3D,
  // lit and shaded; Reflective mixes in the Reflection Map (or the layer) seen in the mirror direction
  ccSphere: (cv, p, x) => {
    const W = cv.width, H = cv.height, F = focal(W), R = Math.max(0, num(p.radius, 200)) * x.res, [cx, cy] = pt(p.offset, x);
    if (R <= 0) return mk(W, H);
    const M = rotation(num(p.rotX), num(p.rotY), num(p.rotZ), String(p.rotOrder ?? 'xyz')), mode = String(p.render ?? 'full');
    const L = ccLight(p, 40, -85), lc = rgb(p.lightColor), sh = ccShading(p, [10, 100, 10, 0.05, 100]), refl = clamp01(num(p.reflective) / 100);
    const map = refl > 0 ? (other(p.reflectionMap, cv, x) ?? cv) : null, RS = map ? sampler(map, true) : null;
    const inShadow = !!num(p.internalShadows), falloff = !!num(p.transparencyFalloff);
    const S = sampler(cv, true), C: V3 = [cx - W / 2, cy - H / 2, 0], o = mulT(M, [-C[0], -C[1], -F]), hit = new Float32Array(12);
    return paint(W, H, (px, py, out) => {
      const dw: V3 = [px - W / 2, py - H / 2, F], d = mulT(M, dw), a = dot(d, d), b = 2 * dot(o, d), c = dot(o, o) - R * R, disc = b * b - 4 * a * c;
      if (disc < 0) return;
      const q = Math.sqrt(disc), view = norm([-dw[0], -dw[1], -dw[2]]), dn = norm(d);
      for (const t of [(-b + q) / (2 * a), (-b - q) / (2 * a)]) {
        if (t <= 0) continue;
        const P: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], nl: V3 = [P[0] / R, P[1] / R, P[2] / R], outside = dot(d, nl) < 0;
        if ((mode === 'outside' && !outside) || (mode === 'inside' && outside)) continue;
        S((Math.atan2(nl[0], -nl[2]) / (2 * Math.PI) + 0.5) * W, (Math.asin(Math.max(-1, Math.min(1, nl[1]))) / Math.PI + 0.5) * H, hit, 4);
        if (hit[7] <= 0) continue;
        const ns: V3 = outside ? nl : [-nl[0], -nl[1], -nl[2]];
        shadePx(hit, 4, mul(M, ns), view, L, lc, sh);
        if (RS) {
          // the mirror direction, looked up in the map as a surrounding sphere
          const k = 2 * dot(dn, ns), r: V3 = [dn[0] - k * ns[0], dn[1] - k * ns[1], dn[2] - k * ns[2]];
          RS((Math.atan2(r[0], -r[2]) / (2 * Math.PI) + 0.5) * W, (Math.asin(Math.max(-1, Math.min(1, r[1]))) / Math.PI + 0.5) * H, hit, 8);
          const ka = hit[7] / 255;
          if (hit[11] > 0) for (let ch = 0; ch < 3; ch++) hit[4 + ch] += (hit[8 + ch] / hit[11] * 255 * ka - hit[4 + ch]) * refl;
        }
        if (!outside && inShadow) for (let ch = 0; ch < 3; ch++) hit[4 + ch] *= 0.5;
        // seen through the front, the back half fades with Transparency Falloff
        if (!outside && falloff) for (let ch = 0; ch < 4; ch++) hit[4 + ch] *= 0.5;
        over(hit, 4, out);
      }
    });
  },

  // ── Distort ──
  // CC Page Turn: the page curls over a cylinder of Fold Radius along the fold line. With a corner control, that
  // corner is pulled to Fold Position; with the classic controls the fold line passes through Fold Position, across
  // Fold Direction. The turned back shows the Back Page layer (or the Paper Color) with the front showing through by
  // 100 − Back Opacity, and the curl is shaded from Light Direction
  ccPageTurn: (cv, p, x) => {
    const W = cv.width, H = cv.height, r = Math.max(1, num(p.foldRadius, 50) * x.res), [fx, fy] = pt(p.foldPosition, x), ctl = String(p.controls ?? 'bottomRight');
    let mx: number, my: number, nx: number, ny: number;
    if (ctl === 'classic') {
      const a = rad(num(p.foldDirection, -60));
      [mx, my, nx, ny] = [fx, fy, -Math.sin(a), Math.cos(a)];
    } else {
      const cx = ctl === 'topLeft' || ctl === 'bottomLeft' ? 0 : W, cy = ctl === 'topLeft' || ctl === 'topRight' ? 0 : H, D = Math.hypot(cx - fx, cy - fy);
      if (D < 0.5) return cv;
      nx = (cx - fx) / D; ny = (cy - fy) / D;
      // the fold line sits where the curled corner lands on Fold Position
      const m = (D - Math.PI * r) / 2;
      mx = fx + nx * m; my = fy + ny * m;
    }
    const mode = String(p.render ?? 'frontBack'), la = rad(num(p.lightDirection, -60)), lx = Math.sin(la), ly = -Math.cos(la), ln = nx * lx + ny * ly;
    const S = sampler(cv), back = other(p.backPage, cv, x), BS = back ? sampler(back) : null, bo = clamp01(num(p.backOpacity, 85) / 100), [pr, pg, pb] = rgb(p.paperColor ?? '#c4c4b4');
    const f = new Float32Array(8);
    return paint(W, H, (px, py, out) => {
      const to = (px - mx) * nx + (py - my) * ny;
      const layer = (ts: number, side: number, sin: number) => {
        // side 0: front, 1: back; sin: the in-plane part of the surface normal along n (for the shading)
        if ((side && mode === 'front') || (!side && mode === 'back')) return;
        S(px + nx * (ts - to), py + ny * (ts - to), f, 0);
        if (f[3] <= 0) return;
        if (side) {
          if (BS) { BS(px, py, f, 4); const k = f[7] / 255; for (let c = 0; c < 3; c++) f[4 + c] = f[4 + c] + [pr, pg, pb][c] * (1 - k); } else { f[4] = pr; f[5] = pg; f[6] = pb; }
          const a = f[3] / 255;
          for (let c = 0; c < 3; c++) f[c] = f[4 + c] * a * bo + f[c] * (1 - bo);
        }
        const k = 1 + 0.45 * sin * ln * (side ? -1 : 1);
        for (let c = 0; c < 3; c++) f[c] = Math.min(f[3], f[c] * k);
        over(f, 0, out);
      };
      if (to < 0) layer(to, 0, 0);
      if (to >= 0 && to <= r) { const th = Math.asin(to / r); layer(r * th, 0, Math.sin(th)); layer(r * (Math.PI - th), 1, Math.sin(th)); }
      if (to < 0) layer(Math.PI * r - to, 1, 0);
    });
  },
  // CC Bender: the part of the layer from Base towards Top bends sideways by Amount (a share of the layer's height, or
  // of the Base–Top distance with Adjust To Distance): Bend curves it, Sharp leans it straight, Marilyn flares it
  // like a skirt and Boxer swerves it and back
  ccBender: (cv, p, x) => {
    const k = num(p.amount) / 100;
    if (!k) return cv;
    const [tx, ty] = pt(p.top, x), [bx, by] = pt(p.base, x), L = Math.hypot(tx - bx, ty - by);
    if (L < 1) return cv;
    const ax = (tx - bx) / L, ay = (ty - by) / L, nx = -ay, ny = ax, amp = k * (num(p.adjust) ? L : cv.height) / 2, st = String(p.style ?? 'bend');
    const off = (s: number) => {
      if (s <= 0) return 0;
      switch (st) {
        case 'sharp': return amp * s;
        case 'boxer': return s >= 1 ? 0 : amp * Math.sin(Math.PI * s);
        default: return s <= 1 ? amp * s * s : amp * (2 * s - 1);
      }
    };
    return remap(cv, (px, py) => {
      const s = ((px - bx) * ax + (py - by) * ay) / L, q = (px - bx) * nx + (py - by) * ny;
      if (st === 'marilyn') { const f = 1 + k * Math.max(0, Math.min(s, 1)) ** 2; const qs = q / Math.max(0.05, f); return [px + nx * (qs - q), py + ny * (qs - q)]; }
      const o = off(s);
      return [px - nx * o, py - ny * o];
    });
  },
  // CC Flo Motion: two knots pull the image into them (positive Amount) or push it out (negative), weaker with
  // distance as Falloff grows; Tile Edges wraps what comes from outside the layer
  ccFloMotion: (cv, p, x) => {
    const W = cv.width, H = cv.height, a1 = num(p.amount1) / 100, a2 = num(p.amount2) / 100;
    if (!a1 && !a2) return cv;
    const k1 = pt(p.knot1, x), k2 = pt(p.knot2, x), fo = Math.max(0, num(p.falloff, 1)), D = Math.hypot(W, H) / 2, tile = !!num(p.tileEdges);
    const pull = (q: [number, number], k: [number, number], a: number): [number, number] => {
      if (!a) return q;
      const dx = q[0] - k[0], dy = q[1] - k[1], w = Math.exp(-fo * Math.hypot(dx, dy) / D), s = Math.pow(2, a * w);
      return [k[0] + dx * s, k[1] + dy * s];
    };
    return remap(cv, (px, py) => {
      let q = pull(pull([px, py], k1, a1), k2, a2);
      if (tile) q = [((q[0] % W) + W) % W, ((q[1] % H) + H) % H];
      return q;
    });
  },
  // CC Griddler: the layer cut into square tiles of Tile Size (a share of its width); each tile shows its own part
  // scaled and turned round the tile's centre. Cut Tiles keeps every tile inside its square
  ccGriddler: (cv, p) => {
    const W = cv.width, H = cv.height, sx = num(p.hScale, 100) / 100, sy = num(p.vScale, 100) / 100, T = Math.max(1, num(p.tileSize, 10) / 100 * W), a = rad(num(p.rotation)), cut = !!num(p.cut);
    if (sx === 1 && sy === 1 && !a) return cv;
    const c = Math.cos(a), s = Math.sin(a);
    return remap(cv, (px, py) => {
      const ix = Math.floor((px - W / 2) / T), iy = Math.floor((py - H / 2) / T), cx = W / 2 + (ix + 0.5) * T, cy = H / 2 + (iy + 0.5) * T;
      const lx = px - cx, ly = py - cy, ux = (lx * c + ly * s) / (sx || 1e-6), uy = (-lx * s + ly * c) / (sy || 1e-6);
      if (cut && (Math.abs(ux) > T / 2 || Math.abs(uy) > T / 2)) return null;
      return [cx + ux, cy + uy];
    });
  },
  // CC Split / CC Split 2: a lens-shaped hole opens along A–B (widest in the middle, Split = its half width in % of
  // half the A–B distance), pushing the image aside; Split 2 opens each side by its own amount
  ccSplit: (cv, p, x) => splitFx(cv, p, x, num(p.split), num(p.split)),
  ccSplit2: (cv, p, x) => splitFx(cv, p, x, num(p.split1), num(p.split2)),
  // CC RepeTile: the layer is repeated round itself, Expand px to each side, with each copy flipped or turned by
  // Tiling (Repeat, checkers, Unfold, Rosette, Random…)
  ccRepeTile: (cv, p, x) => {
    const W = cv.width, H = cv.height, ox = -x.ox * x.res, oy = -x.oy * x.res, lw = W - 2 * Math.max(0, ox), lh = H - 2 * Math.max(0, oy);
    const r = num(p.right) * x.res, l = num(p.left) * x.res, dn = num(p.down) * x.res, u = num(p.up) * x.res, tl = String(p.tiling ?? 'repeat');
    if ((!r && !l && !dn && !u) || lw < 1 || lh < 1 || tl === 'none') return cv;
    const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
    return remap(cv, (px, py) => {
      if (px < x0 - l || px > x0 + lw + r || py < y0 - u || py > y0 + lh + dn) return null;
      let fx = (px - x0) / lw, fy = (py - y0) / lh;
      const j = Math.floor(fy);
      if (tl === 'slide' || tl === 'brick') fx += (tl === 'brick' ? (j & 1) * 0.5 : j * 0.25);
      const i = Math.floor(fx);
      let a = fx - i, b = fy - j;
      const odd = (i + j) & 1, k = tl === 'random' ? Math.floor(hash(i, j) * 8) : -1;
      const T = (t: number) => { // the 8 flips / turns of a tile
        if (t & 4) [a, b] = [b, a];
        if (t & 1) a = 1 - a;
        if (t & 2) b = 1 - b;
      };
      if (i || j) switch (tl) {
        case 'flipH': if (odd) T(1); break;
        case 'flipV': if (odd) T(2); break;
        case 'unfold': T((i & 1) | ((j & 1) << 1)); break;
        case 'rot180': if (odd) T(3); break;
        case 'flip45': if (odd) T(4); break;
        case 'rot90ccw': if (odd) T(6); break;
        case 'rot90cw': if (odd) T(5); break;
        case 'rosette': T([0, 5, 3, 6][((i & 1) | ((j & 1) << 1))]); break;
        case 'random': T(k); break;
        case 'turnCW': T([0, 5, 3, 6][((i + j) % 4 + 4) % 4]); break;
        case 'turnCCW': T([0, 6, 3, 5][((i + j) % 4 + 4) % 4]); break;
        case 'twist': T([0, 5, 3, 6][((i - j) % 4 + 4) % 4]); break;
      }
      return [x0 + a * lw, y0 + b * lh];
    });
  },
  // CC Smear: the area round From is dragged to To (Reach % of the way), stretching what lies between; Radius is the
  // width of the smear
  ccSmear: (cv, p, x) => {
    const [fx, fy] = pt(p.from, x), [tx0, ty0] = pt(p.to, x), k = num(p.reach, 100) / 100, R = num(p.radius, 80) * x.res;
    const vx = (tx0 - fx) * k, vy = (ty0 - fy) * k, L2 = vx * vx + vy * vy;
    if (R <= 0 || L2 < 1e-6) return cv;
    return remap(cv, (px, py) => {
      const t = Math.max(0, Math.min(1, ((px - fx) * vx + (py - fy) * vy) / L2)), d = Math.hypot(px - fx - vx * t, py - fy - vy * t);
      if (d >= R) return [px, py];
      const w = (1 - d / R) ** 2;
      return [px - vx * t * w, py - vy * t * w];
    });
  },
  // Rolling Shutter Repair: drawn by rollingShutterRepair (below), which the renderer calls with the frames before and
  // after; on its own the effect leaves the layer as it is
  rollingShutter: (cv) => cv,
  // Optics Compensation: the lens distortion of a lens with this Field of View (across the FOV Orientation's
  // dimension) round View Center: barrel (a wide lens) or, reversed, the pincushion that removes it
  opticsComp: (cv, p, x) => {
    const W = cv.width, H = cv.height, fov = Math.min(179.9, Math.max(0, num(p.fov)));
    if (fov < 0.01) return cv;
    const [cx, cy] = pt(p.center, x), o = String(p.orientation ?? 'horizontal'), D = o === 'vertical' ? H : o === 'diagonal' ? Math.hypot(W, H) : W;
    const f = (D / 2) / rad(fov / 2), rev = !!num(p.reverse) && !num(p.optimal);
    return remap(cv, (px, py) => {
      const dx = px - cx, dy = py - cy, ro = Math.hypot(dx, dy);
      if (ro < 1e-6) return [px, py];
      let rs: number;
      if (rev) rs = f * Math.atan(ro / f);
      else { const th = ro / f; if (th >= Math.PI / 2) return null; rs = f * Math.tan(th); }
      return [cx + dx * rs / ro, cy + dy * rs / ro];
    });
  },

  // 3D Glasses: two views of a scene (the Left / Right View layers, or this one) slid apart by Scene Convergence and
  // up / down by Vertical Alignment (pixels or % of the source), shown side by side, over / under, interlaced (even
  // rows left, odd rows right), as their difference, or as an anaglyph: the left view's brightness in red and the
  // right one's in green or blue; the balanced kinds take out the other eye's ghost by Balance, and Balanced Colored
  // Red Blue keeps the colours (red from the left view, green and blue from the right one)
  glasses3d: (cv, p, x) => {
    const W = cv.width, H = cv.height;
    let L = other(p.left, cv, x) ?? cv, R = other(p.right, cv, x) ?? cv;
    if (num(p.swap)) [L, R] = [R, L];
    const per = p.units === 'percent', cx = num(p.convergence) * (per ? W / 100 : x.res), vy = num(p.vertical) * (per ? H / 100 : x.res);
    const shift = (c: HTMLCanvasElement, dx: number, dy: number) => { if (!dx && !dy) return c; const o = mk(W, H); ctx2d(o).drawImage(c, dx, dy); return o; };
    L = shift(L, cx / 2, vy / 2); R = shift(R, -cx / 2, -vy / 2);
    const view = String(p.view ?? 'stereoPair'), out = mk(W, H), g = ctx2d(out);
    if (view === 'stereoPair') { g.drawImage(L, 0, 0, W / 2, H); g.drawImage(R, W / 2, 0, W / 2, H); return out; }
    if (view === 'overUnder') { g.drawImage(L, 0, 0, W, H / 2); g.drawImage(R, 0, H / 2, W, H / 2); return out; }
    if (view === 'difference') { g.drawImage(L, 0, 0); g.globalCompositeOperation = 'difference'; g.drawImage(R, 0, 0); return out; }
    const a = data(L).data, b = data(R).data, im = new ImageData(W, H), o = im.data, bal = Math.min(0.95, Math.max(0, num(p.balance, 8) / 100));
    const lum = (d: Uint8ClampedArray, i: number) => (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * d[i + 3] / 255;
    for (let y = 0, i = 0; y < H; y++) for (let X = 0; X < W; X++, i += 4) {
      if (view === 'interlace') { const s = y & 1 ? b : a; for (let c = 0; c < 4; c++) o[i + c] = s[i + c]; continue; }
      const al = Math.max(a[i + 3], b[i + 3]);
      if (al <= 0) continue;
      // premultiplied channels (0–255 × alpha / 255)
      let r = lum(a, i), gg = 0, bb = 0, rr = lum(b, i);
      if (view === 'balancedRedGreen' || view === 'balancedRedBlue') { const l0 = r; r = Math.max(0, (r - bal * rr) / (1 - bal)); rr = Math.max(0, (rr - bal * l0) / (1 - bal)); }
      if (view === 'redGreen' || view === 'balancedRedGreen') gg = rr;
      else if (view === 'redBlue' || view === 'balancedRedBlue') bb = rr;
      else { r = (1 - bal) * a[i] * a[i + 3] / 255 + bal * r; gg = b[i + 1] * b[i + 3] / 255; bb = b[i + 2] * b[i + 3] / 255; }
      const k = 255 / al;
      o[i] = r * k; o[i + 1] = gg * k; o[i + 2] = bb * k; o[i + 3] = al;
    }
    return toCanvas(im);
  },
  // CC Blobbylize: the Blob Layer's Property (or this layer's), blurred by Softness, is a height field: below Cut Away
  // the layer is cut out, above it the surface bulges like a liquid and is lit by the effect's light (Distant: from
  // Direction and Height; Point: from Light Position) with the Shading group. AE Lights: the composition's first light
  // instead (none in the comp: the effect light)
  ccBlobbylize: (cv, p, x) => {
    const W = cv.width, H = cv.height, src = other(p.blobLayer, cv, x) ?? cv, soft = Math.max(0, num(p.softness, 20)) * x.res;
    const m0 = propMap(src, String(p.property ?? 'lightness')), hgt = boxBlur(m0, W, H, Math.round(soft / 2));
    const cut = clamp01(num(p.cutAway, 25) / 100), band = 0.02, S = sampler(cv), sh = ccShading(p, [75, 25, 100, 0.025, 100]);
    let lc = rgb(p.lightColor), point = p.lightType === 'point', Ld = ccLight(p, 65, -45), [lpx, lpy] = pt(p.lightPosition, x);
    let lz = -Math.max(0.01, (num(p.lightHeight, 65) + 100) / 200) * Math.max(W, H);
    const view: V3 = [0, 0, -1], AL = p.using === 'ae' ? x.scene?.()?.lights.find((q) => q.type !== 'ambient') : undefined;
    if (AL) {
      lc = [AL.color[0] * 255, AL.color[1] * 255, AL.color[2] * 255];
      point = AL.type !== 'parallel';
      if (point) { lpx = (AL.pos[0] - x.ox) * x.res; lpy = (AL.pos[1] - x.oy) * x.res; lz = AL.pos[2] * x.res; } else Ld = norm([-AL.dir[0], -AL.dir[1], -AL.dir[2]]);
    }
    // the bulge's steepness grows as the blur widens the slopes
    const k = Math.max(4, soft) * 1.5;
    const at = (X: number, Y: number) => hgt[Math.max(0, Math.min(H - 1, Y)) * W + Math.max(0, Math.min(W - 1, X))];
    return paint(W, H, (px, py, out) => {
      const X = Math.floor(px), Y = Math.floor(py), v = at(X, Y), keep = smooth(cut - band, cut + band, v);
      if (keep <= 0) return;
      const n = norm([-(at(X + 1, Y) - at(X - 1, Y)) * k, -(at(X, Y + 1) - at(X, Y - 1)) * k, -1]);
      S(px, py, out);
      for (let c = 0; c < 4; c++) out[c] *= keep;
      shadePx(out, 0, n, view, point ? norm([lpx - px, lpy - py, lz]) : Ld, lc, sh);
    });
  },
  // Reshape: the Source Mask's outline is pulled onto the Destination Mask's (Percent of the way), the image inside
  // and round it following like an elastic sheet (Elasticity: Stiff spreads the pull far, Super Fluid keeps it close
  // to the outline); outside the Boundary Mask nothing moves. Correspondence Points tie places of both outlines
  // («s,d» shares 0–1 along each; by default their first vertices). Every frame is computed exactly (Discrete; Linear
  // and Smooth only change how After Effects caches the in-betweens)
  reshape: (cv, p, x) => {
    const t = clamp01(num(p.percent) / 100), sm = findMask(x, p.source), dm = findMask(x, p.destination);
    if (t <= 0 || !sm || !dm || sm === dm) return cv;
    const N = 96, S = maskPoly(sm, x), D = maskPoly(dm, x);
    if (S.length < 6 || D.length < 6) return cv;
    // same turning sense for both outlines
    const Dd = polyArea(S) * polyArea(D) < 0 ? reversePoly(D) : D;
    const pairs = String(p.points ?? '').trim().split(/\s+/).map((q) => q.split(',').map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite)).map(([a, b]) => [a - Math.floor(a), b - Math.floor(b)] as [number, number]);
    if (!pairs.length) pairs.push([0, 0]);
    const ps: [number, number][] = [], qs: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const [ua, ub] = corresp(pairs, i / N), a = polyAt(S, ua), b = polyAt(Dd, ub);
      ps.push(a); qs.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return maskWarp(cv, x, ps, qs, findMask(x, p.boundary), elasticity(p.elasticity));
  },
  // Smear: the Source Mask and what it holds are carried to Mask Offset (its centre goes there), turned by Mask
  // Rotation and scaled by Mask Scale, Percent of the way; the image between stretches like an elastic sheet
  // (Elasticity) and outside the Boundary Mask nothing moves
  smear: (cv, p, x) => {
    const t = clamp01(num(p.percent) / 100), sm = findMask(x, p.source) ?? x.masks?.[0];
    if (t <= 0 || !sm) return cv;
    const S = maskPoly(sm, x);
    if (S.length < 6) return cv;
    let cx = 0, cy = 0;
    const n = S.length / 2;
    for (let i = 0; i < S.length; i += 2) { cx += S[i] / n; cy += S[i + 1] / n; }
    const [ox, oy] = pt(p.offset, x), a = rad(num(p.rotation)), co = Math.cos(a), si = Math.sin(a), k = Math.max(0.1, num(p.scale, 1));
    const ps: [number, number][] = [], qs: [number, number][] = [];
    const add = (X: number, Y: number) => {
      const dx = (X - cx) * k, dy = (Y - cy) * k, tx = ox + dx * co - dy * si, ty = oy + dx * si + dy * co;
      ps.push([X, Y]); qs.push([X + (tx - X) * t, Y + (ty - Y) * t]);
    };
    // the outline, a ring inside it and the centre: the inside moves as one piece
    for (let i = 0; i < 64; i++) { const [X, Y] = polyAt(S, i / 64); add(X, Y); if (i % 4 === 0) add(cx + (X - cx) * 0.5, cy + (Y - cy) * 0.5); }
    add(cx, cy);
    const bm = p.boundary ? findMask(x, p.boundary) : undefined;
    return maskWarp(cv, x, ps, qs, bm === sm ? undefined : bm, elasticity(p.elasticity));
  },

  // ── Transition ──
  // Card Wipe: the layer cut into Rows × Columns cards that flip over one after another (in Flip Order, or by the
  // Gradient Layer's brightness, with Timing Randomness), showing the Back Layer on their backs; Transition Width is
  // how many flip at once, Card Scale shrinks them and the jitter shakes them in position and rotation. The cards are
  // seen through the Camera System (Camera Position: an orbit / pan / dolly camera; Corner Pins: the camera that puts
  // the layer's corners on the four pins) and lit by the Lighting and Material groups. Each card is a plane, so it
  // is drawn through the 3 × 3 homography from its own coordinates to the screen
  cardWipe: (cv, p, x) => {
    const W = cv.width, H = cv.height, comp = clamp01(num(p.completion, 25) / 100), tw = Math.max(1e-3, num(p.width, 50) / 100);
    const rows = Math.max(1, Math.round(num(p.rows, 9))), cols = p.rowsCols === 'follow' ? rows : Math.max(1, Math.round(num(p.columns, 12)));
    const cw = W / cols, chh = H / rows, sc = Math.max(0, num(p.cardScale, 1)), seed = num(p.seed, 1), timing = clamp01(num(p.timing));
    const backCv = other(p.back, cv, x) ?? cv, S = sampler(cv), B = sampler(backCv), ord = String(p.flipOrder ?? 'lr');
    const grad = ord === 'gradient' ? other(p.gradient, cv, x) : null, gd = grad ? data(grad).data : null;
    const jit = (k: string) => num(p[k]), t = x.t;
    const view = cardCamera(p, x, W, H), lit = cardLight(p, x, W, H);
    const acc = new Float32Array(W * H * 4), f = new Float32Array(4);
    const cards: { cx: number; cy: number; C: V3; M: M3; local: number; ix: number; iy: number; depth: number }[] = [];
    for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
      const u = cols > 1 ? ix / (cols - 1) : 0, v = rows > 1 ? iy / (rows - 1) : 0, cx = (ix + 0.5) * cw, cy = (iy + 0.5) * chh;
      let o = ({ lr: u, rl: 1 - u, tb: v, bt: 1 - v, tlbr: (u + v) / 2, trbl: (1 - u + v) / 2, bltr: (u + 1 - v) / 2, brtl: (2 - u - v) / 2 } as Record<string, number>)[ord] ?? 0;
      if (ord === 'gradient') o = gd ? prop(gd, (Math.min(H - 1, Math.floor(cy)) * W + Math.min(W - 1, Math.floor(cx))) * 4, 'luminance') : 0.5;
      o = o * (1 - timing) + hash(ix, iy, seed) * timing;
      const local = clamp01((comp * (1 + tw) - o) / tw);
      const axis = p.flipAxis === 'y' ? 'y' : p.flipAxis === 'random' ? (hash(ix, iy, seed + 7) < 0.5 ? 'x' : 'y') : 'x';
      const sign = p.flipDirection === 'negative' ? -1 : p.flipDirection === 'random' ? (hash(ix, iy, seed + 13) < 0.5 ? -1 : 1) : 1;
      const w = (k: string, n: number) => (jit(k) ? jit(k) * wob(t * jit(k + 'Speed'), ix, iy, seed + n) : 0);
      const ang = local * 180 * sign;
      const M = rotation((axis === 'x' ? ang : 0) + w('xRotJitter', 4), (axis === 'y' ? ang : 0) + w('yRotJitter', 5), w('zRotJitter', 6), 'xyz');
      const C: V3 = [cx - W / 2 + w('xJitter', 1) * cw, cy - H / 2 + w('yJitter', 2) * chh, w('zJitter', 3) * cw];
      cards.push({ cx, cy, C, M, local, ix, iy, depth: dot(view.R.slice(6, 9) as V3, C) + view.T[2] });
    }
    // still cards first, then the turning ones (they reach over their neighbours), the farthest first
    cards.sort((a, b) => ((a.local > 0 && a.local < 1 ? 1 : 0) - (b.local > 0 && b.local < 1 ? 1 : 0)) || (b.depth - a.depth));
    const hw = cw * sc / 2, hh = chh * sc / 2, flipX = p.flipAxis !== 'y', K = view.K;
    for (const k of cards) {
      // card plane → camera: columns R·M·e1, R·M·e2 and R·C + T; → screen: K·that
      const RM = mm(view.R, k.M), P0 = mul(view.R, k.C), cam: V3 = [P0[0] + view.T[0], P0[1] + view.T[1], P0[2] + view.T[2]];
      const G: number[] = [];
      for (let r = 0; r < 3; r++) G.push(K[r * 3] * RM[0] + K[r * 3 + 1] * RM[3] + K[r * 3 + 2] * RM[6], K[r * 3] * RM[1] + K[r * 3 + 1] * RM[4] + K[r * 3 + 2] * RM[7], K[r * 3] * cam[0] + K[r * 3 + 1] * cam[1] + K[r * 3 + 2] * cam[2]);
      const Gi = inv3(G);
      if (!Gi) continue;
      // the card's screen box from its projected corners (all of the screen when one is behind the camera)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [a, b] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
        const z = G[6] * a + G[7] * b + G[8];
        if (z <= 1) { x0 = 0; y0 = 0; x1 = W; y1 = H; break; }
        const sx = (G[0] * a + G[1] * b + G[2]) / z, sy = (G[3] * a + G[4] * b + G[5]) / z;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      // which side a pixel sees: the viewing ray in the card's own axes (its z towards the card's back = the front)
      const Ki = view.Ki, RMt = (v: V3): V3 => [RM[0] * v[0] + RM[3] * v[1] + RM[6] * v[2], RM[1] * v[0] + RM[4] * v[1] + RM[7] * v[2], RM[2] * v[0] + RM[5] * v[1] + RM[8] * v[2]];
      const sh = lit?.(k.M, k.C, view);
      for (let py = Math.max(0, Math.floor(y0)); py < Math.min(H, Math.ceil(y1)); py++) for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, Math.ceil(x1)); px++) {
        const X = px + 0.5, Y = py + 0.5, q2 = Gi[6] * X + Gi[7] * Y + Gi[8];
        if (q2 <= 0) continue;
        const lx = (Gi[0] * X + Gi[1] * Y + Gi[2]) / q2, ly = (Gi[3] * X + Gi[4] * Y + Gi[5]) / q2;
        if (Math.abs(lx) > hw || Math.abs(ly) > hh) continue;
        const ray = RMt([Ki[0] * X + Ki[1] * Y + Ki[2], Ki[3] * X + Ki[4] * Y + Ki[5], 1]);
        const ux = lx / Math.max(sc, 1e-6), uy = ly / Math.max(sc, 1e-6), front = ray[2] > 0;
        // the back reads the right way round once the card has turned over
        if (front) S(k.cx + ux, k.cy + uy, f); else if (flipX) B(k.cx + ux, k.cy - uy, f); else B(k.cx - ux, k.cy + uy, f);
        if (sh) for (let c = 0; c < 3; c++) f[c] = Math.min(f[3], f[c] * sh[c] + f[3] * sh[c + 3]);
        const i = (py * W + px) * 4, a = 1 - f[3] / 255;
        for (let c = 0; c < 4; c++) acc[i + c] = f[c] + acc[i + c] * a;
      }
    }
    return paint(W, H, (px, py, out) => { const i = (Math.floor(py) * W + Math.floor(px)) * 4; for (let c = 0; c < 4; c++) out[c] = acc[i + c]; });
  },
  // CC Glass Wipe: the layer melts away from the dark parts of the Gradient Layer (or its own) to the bright ones,
  // and the melting edge refracts like glass (Displacement Amount) over the Layer to Reveal
  ccGlassWipe: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    const W = cv.width, H = cv.height, rev = other(p.reveal, cv, x);
    if (c >= 1) return rev ?? mk(W, H);
    const soft = Math.max(0.05, num(p.softness, 10) / 100), g = propMap(other(p.gradient, cv, x) ?? cv, 'luminance', 2 * x.res), amt = num(p.displacement, 25) * x.res;
    const th = c * (1 + soft) - soft, S = sampler(cv), f = new Float32Array(4);
    const at = (X: number, Y: number) => g[Math.max(0, Math.min(H - 1, Y)) * W + Math.max(0, Math.min(W - 1, X))];
    const lay = paint(W, H, (px, py, out) => {
      const X = Math.floor(px), Y = Math.floor(py), v = at(X, Y), keep = smooth(th, th + soft, v);
      if (keep <= 0) return;
      // the edge (keep between 0 and 1) bends the image along the gradient's slope
      const e = 1 - Math.abs(2 * keep - 1), gx = (at(X + 1, Y) - at(X - 1, Y)) * W / 2, gy = (at(X, Y + 1) - at(X, Y - 1)) * H / 2;
      S(px + gx * amt * e / W * 4, py + gy * amt * e / H * 4, f);
      for (let ch = 0; ch < 4; ch++) out[ch] = f[ch] * keep;
    });
    if (!rev) return lay;
    const out = mk(W, H), gg = ctx2d(out);
    gg.drawImage(rev, 0, 0); gg.drawImage(lay, 0, 0);
    return out;
  },
  // CC Image Wipe: the layer is wiped from the lowest values of the gradient's Property (another layer, or its own)
  // to the highest, with a soft border
  ccImageWipe: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    if (c >= 1) return mk(cv.width, cv.height);
    let s = clamp01(num(p.softness, 10) / 100);
    if (num(p.autoSoftness)) s = Math.max(s, 0.1) * (0.5 + c);
    const g = propMap(other(p.gradient, cv, x) ?? cv, String(p.property ?? 'luminance'), num(p.blur) * x.res), inv = !!num(p.inverse), W = cv.width, th = c * (1 + s) - s;
    return matte(cv, (px, py) => { const v = g[Math.floor(py) * W + Math.floor(px)]; return smooth(th, th + Math.max(s, 1e-3), inv ? 1 - v : v); });
  },
  // CC Light Wipe: a shape (Round, Square or Doors along Direction) grows from Center and wipes the layer, its edge
  // glowing with Color (or the layer's own colour) by Intensity; Reverse shrinks it instead
  ccLightWipe: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    const W = cv.width, H = cv.height, [cx, cy] = pt(p.center, x), a = rad(num(p.direction)), co = Math.cos(a), si = Math.sin(a), shape = String(p.shape ?? 'round');
    const dist = (px: number, py: number) => {
      const dx = px - cx, dy = py - cy, u = dx * co + dy * si, v = -dx * si + dy * co;
      return shape === 'doors' ? Math.abs(u) : shape === 'square' ? Math.max(Math.abs(u), Math.abs(v)) : Math.hypot(u, v);
    };
    const Rm = Math.max(dist(0, 0), dist(W, 0), dist(0, H), dist(W, H)) * 1.02, rev = !!num(p.reverse), R = (rev ? 1 - c : c) * Rm, band = Math.max(1, Rm * 0.06);
    const k = num(p.intensity, 100) / 100, src = !!num(p.fromSource), L = rgb(p.color), S = sampler(cv), f = new Float32Array(4);
    return paint(W, H, (px, py, out) => {
      const d = dist(px, py), keep = rev ? smooth(R + band * 0.5, R - band * 0.5, d) : smooth(R - band * 0.5, R + band * 0.5, d);
      S(px, py, f);
      for (let ch = 0; ch < 4; ch++) out[ch] = f[ch] * keep;
      const gl = Math.min(1, k * Math.exp(-(((d - R) / band) ** 2)));
      if (gl <= 0.002) return;
      const col = src && f[3] > 0 ? [f[0] / f[3] * 255, f[1] / f[3] * 255, f[2] / f[3] * 255] : L, ga = gl * 255;
      for (let ch = 0; ch < 3; ch++) out[ch] = Math.min(255, out[ch] + col[ch] * gl);
      out[3] = Math.min(255, out[3] + ga * (1 - out[3] / 255));
      for (let ch = 0; ch < 3; ch++) out[ch] = Math.min(out[3], out[ch]);
    });
  },
  // CC Twister: the layer twists like a ribbon round the Axis through Center, the twist travelling along it with
  // Completion until the layer has turned over to its Backside; Shading darkens the turned parts
  ccTwister: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    const W = cv.width, H = cv.height, [cx, cy] = pt(p.center, x), a = rad(num(p.axis, -120)), ax = Math.sin(a), ay = -Math.cos(a), nx = -ay, ny = ax;
    const Ls = (Math.abs(ax) * W + Math.abs(ay) * H) / 2, back = other(p.backside, cv, x) ?? cv, S = sampler(cv), B = sampler(back), shade = !!num(p.shading);
    // the twist runs along the axis over the layer's extent round the centre
    const lo = Math.min(...[[0, 0], [W, 0], [0, H], [W, H]].map(([X, Y]) => (X - cx) * ax + (Y - cy) * ay)), span = Math.max(1, Ls * 2);
    return paint(W, H, (px, py, out) => {
      const s = (px - cx) * ax + (py - cy) * ay, q = (px - cx) * nx + (py - cy) * ny, sig = (s - lo) / span;
      const phi = Math.PI * clamp01(c * 2 - sig), cs = Math.cos(phi);
      if (Math.abs(cs) < 1e-3) return;
      const qs = q / Math.abs(cs), X = cx + ax * s, Y = cy + ay * s;
      if (cs > 0) S(X + nx * qs, Y + ny * qs, out); else B(X - nx * qs, Y - ny * qs, out);
      if (shade) { const k = 0.35 + 0.65 * Math.abs(cs); for (let ch = 0; ch < 3; ch++) out[ch] *= k; }
    });
  },
  // CC WarpoMatic: the layer turns into the Layer to Reveal in the order of the Reactor map (brightness, or the
  // differences between both), smoothed by Smoothness; both images warp along the map's slope by Warp Amount
  // (together, against each other or across) while they blend over Blend Span
  ccWarpoMatic: (cv, p, x) => {
    const c = clamp01(num(p.completion) / 100);
    if (c <= 0) return cv;
    const W = cv.width, H = cv.height, rev = other(p.reveal, cv, x) ?? mk(W, H);
    if (c >= 1) return rev;
    const ra = String(p.reactor ?? 'brightness'), sm = Math.max(1, num(p.smoothness, 50) / 10 * x.res);
    const A = propMap(cv, 'luminance'), Bm = propMap(rev, 'luminance');
    let m: Float32Array = new Float32Array(W * H);
    if (ra === 'brightness') m = A;
    else if (ra === 'brightnessDiff' || ra === 'localDiff') { const da = data(cv).data, db = data(rev).data; for (let i = 0; i < m.length; i++) m[i] = ra === 'brightnessDiff' ? Math.abs(A[i] - Bm[i]) : Math.min(1, Math.hypot(da[i * 4] - db[i * 4], da[i * 4 + 1] - db[i * 4 + 1], da[i * 4 + 2] - db[i * 4 + 2]) / 255); }
    else { const ab = boxBlurEdge(A, W, H, 4), bb = boxBlurEdge(Bm, W, H, 4); for (let i = 0; i < m.length; i++) m[i] = Math.min(1, Math.abs(Math.abs(A[i] - ab[i]) - Math.abs(Bm[i] - bb[i])) * 4); }
    m = boxBlurEdge(m, W, H, Math.round(sm));
    const span = clamp01(num(p.blendSpan, 75) / 100), amt = num(p.warpAmount, 25) * x.res, dir = String(p.warpDirection ?? 'joint');
    const SA = sampler(cv), SB = sampler(rev), fa = new Float32Array(4), fb = new Float32Array(4);
    const at = (X: number, Y: number) => m[Math.max(0, Math.min(H - 1, Y)) * W + Math.max(0, Math.min(W - 1, X))];
    return paint(W, H, (px, py, out) => {
      const X = Math.floor(px), Y = Math.floor(py), t = clamp01((c * (1 + span) - at(X, Y)) / Math.max(span, 1e-3)), b = Math.sin(Math.PI * t);
      let gx = (at(X + 1, Y) - at(X - 1, Y)) * 0.5 * sm, gy = (at(X, Y + 1) - at(X, Y - 1)) * 0.5 * sm;
      if (dir === 'twisting') [gx, gy] = [-gy, gx];
      const k = amt * b, kb = dir === 'opposing' ? -k : k;
      SA(px + gx * k, py + gy * k, fa); SB(px + gx * kb, py + gy * kb, fb);
      for (let ch = 0; ch < 4; ch++) out[ch] = fa[ch] * (1 - t) + fb[ch] * t;
    });
  },
};

/** CC Split / CC Split 2: the hole's half width on each side is s1 / s2 % of half the A–B distance */
function splitFx(cv: HTMLCanvasElement, p: Record<string, unknown>, x: FxCtx, s1: number, s2: number): HTMLCanvasElement {
  if (s1 <= 0 && s2 <= 0) return cv;
  const [ax, ay] = pt(p.a, x), [bx, by] = pt(p.b, x), L = Math.hypot(bx - ax, by - ay);
  if (L < 1) return cv;
  const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux;
  return remap(cv, (px, py) => {
    const s = ((px - ax) * ux + (py - ay) * uy) / L, q = (px - ax) * nx + (py - ay) * ny;
    if (s <= 0 || s >= 1) return [px, py];
    const h = Math.max(0, (q >= 0 ? s1 : s2) / 100) * (L / 2) * Math.sin(Math.PI * s), aq = Math.abs(q), K = Math.max(L, h * 2);
    if (aq < h) return null;
    if (aq >= K) return [px, py];
    // the image between the hole and K is squeezed outwards
    const qs = (aq - h) * K / (K - h) * Math.sign(q);
    return [px + nx * (qs - q), py + ny * (qs - q)];
  });
}

/**
 * Rolling Shutter Repair. A rolling shutter reads the frame line by line over Rolling Shutter Rate % of the frame
 * time, in Scan Direction, so moving things lean and wobble. The motion of every pixel comes from optical flow
 * between this frame and the ones before and after (prev / next: the layer then, placed on this canvas); each pixel
 * was captured τ = rate × (s − ½) frames off the frame's middle (s: 0…1 along the scan), so the corrected frame takes
 * it from where the motion had carried it by then. Warp: one motion per scan line (smoothed over the lines: camera
 * pans and shake); Pixel Motion: the dense per-pixel motion (Pixel Motion Detail). Detailed Analysis tracks a finer
 * grid. Called by the renderer, which fetches the neighbouring frames (the effect itself is a pass-through).
 */
export function rollingShutterRepair(cur: HTMLCanvasElement, prev: HTMLCanvasElement | null, next: HTMLCanvasElement | null, p: (k: string) => unknown): HTMLCanvasElement {
  const W = cur.width, H = cur.height, rate = Math.max(0, Math.min(100, num(p('rate'), 50))) / 100;
  if (rate <= 0 || (!prev && !next)) return cur;
  const pix = String(p('method') ?? 'warp') === 'pixelMotion', detail = pix ? Math.max(5, Math.min(100, num(p('pixelDetail'), 20))) : num(p('detailed')) ? 60 : 20;
  const c = data(cur).data, n = next ? opticalFlow(c, data(next).data, W, H, detail, 0.5) : null, b = prev ? opticalFlow(c, data(prev).data, W, H, detail, 0.5) : null;
  // velocity in px per frame at each pixel of this frame
  const vx = new Float32Array(W * H), vy = new Float32Array(W * H), k = n && b ? 0.5 : 1;
  for (let i = 0; i < vx.length; i++) { vx[i] = ((n ? n.u[i] : 0) - (b ? b.u[i] : 0)) * k; vy[i] = ((n ? n.v[i] : 0) - (b ? b.v[i] : 0)) * k; }
  const scan = String(p('scan') ?? 'topBottom'), rowsScan = scan === 'topBottom' || scan === 'bottomTop';
  if (!pix) {
    // Warp: the mean motion of each scan line, smoothed across the lines (an eighth of the frame)
    const L = rowsScan ? H : W, A = rowsScan ? W : H, mx = new Float32Array(L), my = new Float32Array(L);
    for (let l = 0; l < L; l++) { let sx = 0, sy = 0; for (let a = 0; a < A; a++) { const i = rowsScan ? l * W + a : a * W + l; sx += vx[i]; sy += vy[i]; } mx[l] = sx / A; my[l] = sy / A; }
    const r = Math.max(1, Math.round(L / 16)), bx = boxBlurEdge(mx, L, 1, r), by = boxBlurEdge(my, L, 1, r);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) { const l = rowsScan ? y : X; vx[y * W + X] = bx[l]; vy[y * W + X] = by[l]; }
  }
  const tau = (X: number, Y: number) => rate * ((scan === 'topBottom' ? Y / H : scan === 'bottomTop' ? 1 - Y / H : scan === 'leftRight' ? X / W : 1 - X / W) - 0.5);
  const vAt = (X: number, Y: number): [number, number] => { const i = Math.max(0, Math.min(H - 1, Math.floor(Y))) * W + Math.max(0, Math.min(W - 1, Math.floor(X))); return [vx[i], vy[i]]; };
  return remap(cur, (X, Y) => {
    // where the pixel was captured: two fixed-point steps (its scan time depends on that place)
    let qx = X, qy = Y;
    for (let it = 0; it < 2; it++) { const t = tau(qx, qy), [ux, uy] = vAt(qx, qy); qx = X + ux * t; qy = Y + uy * t; }
    return [qx, qy];
  });
}
