// Drawing of the effects in src/core/motion/fx-groups/lente.ts. Helpers come from ../fx: only use them inside the
// functions (fx.ts imports this file while it is still loading).
import type { FxCtx, FxFn, Params } from '../fx';
import { mk, ctx2d, FX_IMPL } from '../fx';
import { opticalFlow, type Flow } from '../flow';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const rad = (d: number) => (d * Math.PI) / 180;

const read = (cv: HTMLCanvasElement) => ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height);
function write(w: number, h: number, d: Uint8ClampedArray): HTMLCanvasElement {
  const out = mk(w, h), g = ctx2d(out), img = g.createImageData(out.width, out.height);
  img.data.set(d);
  g.putImageData(img, 0, 0);
  return out;
}

// ───────────────────────── Camera Lens Blur ─────────────────────────

const SIDES: Record<string, number> = { triangle: 3, square: 4, pentagon: 5, hexagon: 6, heptagon: 7, octagon: 8, nonagon: 9, decagon: 10 };
/** sRGB ↔ linear light (0…1) */
const toLin = Float32Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * The iris outline (unit radius, 256 points): a regular polygon of n sides whose corners are rounded towards the
 * circle by `round` (0…1), stretched horizontally by the aspect ratio and turned by `rot` degrees.
 */
export function irisOutline(n: number, round: number, aspect: number, rot: number): number[] {
  const pts: number[] = [], seg = (2 * Math.PI) / n, a0 = rad(rot) - Math.PI / 2, ax = Math.sqrt(Math.max(0.01, aspect));
  for (let i = 0; i < 256; i++) {
    const th = (i / 256) * 2 * Math.PI;
    // distance to the polygon's edge (circumradius 1) along th, then rounded towards the circle
    const loc = ((((th - a0) % seg) + seg) % seg) - seg / 2, poly = Math.cos(seg / 2) / Math.cos(loc), r = poly + (1 - poly) * round;
    pts.push(Math.cos(th) * r * ax, Math.sin(th) * r / ax);
  }
  return pts;
}
/** The rows of the iris of radius R: for each integer dy, the span [a, b] of x inside it (scan-line intersections). */
export function irisSpans(outline: number[], R: number): { dy: number; a: number; b: number }[] {
  let ymax = 0;
  for (let i = 1; i < outline.length; i += 2) ymax = Math.max(ymax, Math.abs(outline[i] * R));
  const out: { dy: number; a: number; b: number }[] = [];
  const m = outline.length / 2;
  for (let dy = -Math.floor(ymax); dy <= Math.floor(ymax); dy++) {
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < m; i++) {
      const x0 = outline[i * 2] * R, y0 = outline[i * 2 + 1] * R, j = (i + 1) % m, x1 = outline[j * 2] * R, y1 = outline[j * 2 + 1] * R;
      if ((y0 <= dy && y1 >= dy) || (y1 <= dy && y0 >= dy)) {
        const x = y1 === y0 ? Math.min(x0, x1) : x0 + ((dy - y0) / (y1 - y0)) * (x1 - x0);
        const xb = y1 === y0 ? Math.max(x0, x1) : x;
        a = Math.min(a, x); b = Math.max(b, xb);
      }
    }
    if (b >= a) out.push({ dy, a, b });
  }
  if (!out.length) out.push({ dy: 0, a: -0.5, b: 0.5 });
  return out;
}

/**
 * Convolution of a premultiplied float RGBA image with a flat kernel given by its rows (spans): each row is a box sum
 * read from per-row prefix sums, with fractional ends (anti-aliased iris edges). Outside the image repeats the edge
 * pixels (`repeat`) or is transparent. Returns the sums and the kernel area (the caller normalises).
 */
function spanSum(src: Float32Array, w: number, h: number, spans: { dy: number; a: number; b: number }[], repeat: boolean): { sum: Float32Array; area: number } {
  let P = 2;
  for (const s of spans) P = Math.max(P, Math.ceil(Math.max(-s.a, s.b)) + 2);
  const Wp = w + 2 * P, stride = (Wp + 1) * 4;
  // prefix sums of every padded row
  const pre = new Float64Array(h * stride);
  for (let y = 0; y < h; y++) {
    const o = y * stride;
    for (let X = 0; X < Wp; X++) {
      const sx = X - P, inside = sx >= 0 && sx < w;
      const xi = inside ? sx : repeat ? (sx < 0 ? 0 : w - 1) : -1, k = (y * w + xi) * 4;
      for (let c = 0; c < 4; c++) pre[o + (X + 1) * 4 + c] = pre[o + X * 4 + c] + (xi >= 0 ? src[k + c] : 0);
    }
  }
  // F(u): the integral of the row up to u (pixel X covers [X, X + 1))
  const F = (o: number, u: number, c: number) => {
    if (u <= 0) return 0;
    if (u >= Wp) return pre[o + Wp * 4 + c];
    const i = Math.floor(u), f = u - i;
    return pre[o + i * 4 + c] + f * (pre[o + (i + 1) * 4 + c] - pre[o + i * 4 + c]);
  };
  let area = 0;
  for (const s of spans) area += s.b - s.a + 1;
  const sum = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (const s of spans) {
      let yy = y + s.dy;
      if (yy < 0 || yy >= h) { if (!repeat) continue; yy = yy < 0 ? 0 : h - 1; }
      const o = yy * stride;
      for (let x = 0; x < w; x++) {
        const u0 = x + P + s.a, u1 = x + P + s.b + 1, k = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) sum[k + c] += F(o, u1, c) - F(o, u0, c);
      }
    }
  }
  return { sum, area };
}
/** box-average downscale of a float RGBA image by an integer factor f */
function shrink(src: Float32Array, w: number, h: number, f: number): [Float32Array, number, number] {
  const W = Math.ceil(w / f), H = Math.ceil(h / f), o = new Float32Array(W * H * 4), n = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = Math.floor(y / f) * W + Math.floor(x / f), i = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) o[j * 4 + c] += src[i + c];
    n[j]++;
  }
  for (let j = 0; j < W * H; j++) for (let c = 0; c < 4; c++) o[j * 4 + c] /= n[j] || 1;
  return [o, W, H];
}
/** bilinear sample (c channel) of a small float RGBA image at full-size pixel (x, y), f = the shrink factor */
function grow(src: Float32Array, W: number, H: number, f: number, x: number, y: number, c: number): number {
  const fx = Math.max(0, Math.min(W - 1, (x + 0.5) / f - 0.5)), fy = Math.max(0, Math.min(H - 1, (y + 0.5) / f - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), u = fx - x0, v = fy - y0;
  return (src[(y0 * W + x0) * 4 + c] * (1 - u) + src[(y0 * W + x1) * 4 + c] * u) * (1 - v) + (src[(y1 * W + x0) * 4 + c] * (1 - u) + src[(y1 * W + x1) * 4 + c] * u) * v;
}
/**
 * The image blurred by the iris of radius R (canvas px): a flat iris plus Diffraction Fringe (100 = flat; more lights
 * the rim, the outer 30 % of the radius, and less darkens it), as two flat kernels. Big radii are done on a smaller
 * copy (the kernel stays within ~20 px) and scaled back.
 */
function irisBlur(src: Float32Array, w: number, h: number, R: number, outline: number[], fringe: number, repeat: boolean): Float32Array {
  if (R < 0.5) return src;
  const f = Math.max(1, Math.ceil(R / 20));
  const [s, W, H] = f > 1 ? shrink(src, w, h, f) : [src, w, h];
  const r = R / f, full = spanSum(s, W, H, irisSpans(outline, r), repeat);
  let res: Float32Array;
  if (Math.abs(fringe - 1) < 1e-3 || r < 2) {
    res = full.sum;
    for (let i = 0; i < res.length; i++) res[i] /= full.area;
  } else {
    // rim weight = fringe, inside weight 1: fringe × full − (fringe − 1) × inner
    const inner = spanSum(s, W, H, irisSpans(outline, r * 0.7), repeat), A = fringe * full.area - (fringe - 1) * inner.area;
    res = new Float32Array(full.sum.length);
    for (let i = 0; i < res.length; i++) res[i] = Math.max(0, (fringe * full.sum[i] - (fringe - 1) * inner.sum[i]) / A);
  }
  if (f === 1) return res;
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = grow(res, W, H, f, x, y, c);
  return out;
}
/** a channel of straight RGBA bytes, 0…1 (Camera Lens Blur's map channels) */
function mapValue(d: Uint8ClampedArray, i: number, ch: string): number {
  const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
  return (ch === 'red' ? r : ch === 'green' ? g : ch === 'blue' ? b : ch === 'alpha' ? a : 0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Camera Lens Blur: every pixel spread over the iris shape (bokeh), in linear light by default so bright points bloom.
 * Highlight lifts the pixels brighter than Threshold by Gain (and saturates them) before the blur, so they turn into
 * bright iris shapes. With a Blur Map, each pixel's radius is Blur Radius × |map − focal distance| (the map's channel,
 * centred or stretched, optionally inverted); the radius is taken from blurs at a few levels, mixed per pixel.
 */
function cameraLensBlur(cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const R = Math.max(0, num(p.radius, 5)) * x.res;
  if (R < 0.5) return cv;
  const W = cv.width, H = cv.height, d = read(cv).data, lin = !!num(p.linear, 1), repeat = !!num(p.repeat, 1);
  const outline = irisOutline(SIDES[String(p.shape ?? 'hexagon')] ?? 6, clamp(num(p.roundness) / 100), clamp(num(p.aspect, 1), 0.01, 100), num(p.rotation));
  const fringe = Math.max(0, num(p.fringe, 100)) / 100;
  // premultiplied float, linear or not, with the highlights lifted
  const thr = clamp(num(p.threshold, 204) / 255), gain = Math.max(0, num(p.gain)), sat = clamp(num(p.saturation) / 100);
  const src = new Float32Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    let r = lin ? toLin[d[i]] : d[i] / 255, g = lin ? toLin[d[i + 1]] : d[i + 1] / 255, b = lin ? toLin[d[i + 2]] : d[i + 2] / 255;
    if (gain > 0) {
      const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      if (l > thr) {
        const s = clamp((l - thr) / Math.max(1e-3, 1 - thr)), k = 1 + (gain / 10) * s, m = (r + g + b) / 3, ks = 1 + 2 * sat * s;
        r = Math.max(0, m + (r - m) * ks) * k; g = Math.max(0, m + (g - m) * ks) * k; b = Math.max(0, m + (b - m) * ks) * k;
      }
    }
    src[i] = r * a; src[i + 1] = g * a; src[i + 2] = b * a; src[i + 3] = a;
  }
  let res: Float32Array;
  const map = p.map && x.layer ? x.layer(String(p.map)) : null;
  if (!map) res = irisBlur(src, W, H, R, outline, fringe, repeat);
  else {
    // the map on this canvas: centred on the layer or stretched over it
    const m = mk(W, H), mg = ctx2d(m);
    if (String(p.mapPlacement) === 'stretch') mg.drawImage(map.cv, 0, 0, W, H);
    else mg.drawImage(map.cv, (W - map.cv.width * (x.res / map.res)) / 2, (H - map.cv.height * (x.res / map.res)) / 2, map.cv.width * (x.res / map.res), map.cv.height * (x.res / map.res));
    const md = read(m).data, ch = String(p.mapChannel ?? 'luma'), inv = !!num(p.mapInvert), focal = clamp(num(p.focal) / 255);
    const rr = new Float32Array(W * H);
    for (let i = 0; i < rr.length; i++) { let v = mapValue(md, i * 4, ch); if (inv) v = 1 - v; rr[i] = Math.abs(v - focal); }
    const L = 6, levels: Float32Array[] = [src];
    for (let k = 1; k < L; k++) levels.push(irisBlur(src, W, H, (R * k) / (L - 1), outline, fringe, repeat));
    res = new Float32Array(src.length);
    for (let i = 0; i < rr.length; i++) {
      const q = rr[i] * (L - 1), k0 = Math.min(L - 2, Math.floor(q)), f = q - k0;
      for (let c = 0; c < 4; c++) res[i * 4 + c] = levels[k0][i * 4 + c] * (1 - f) + levels[k0 + 1][i * 4 + c] * f;
    }
  }
  const o = new Uint8ClampedArray(d.length);
  for (let i = 0; i < o.length; i += 4) {
    const a = clamp(res[i + 3]);
    if (a <= 1e-4) continue;
    for (let c = 0; c < 3; c++) { const v = clamp(res[i + c] / res[i + 3]); o[i + c] = (lin ? toSrgb(v) : v) * 255 + 0.5; }
    o[i + 3] = a * 255 + 0.5;
  }
  return write(W, H, o);
}

// ───────────────────────── Pixel Motion Blur ─────────────────────────

/** straight RGBA → premultiplied float */
function premulOf(d: Uint8ClampedArray): Float32Array {
  const f = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; f[i] = d[i] * a; f[i + 1] = d[i + 1] * a; f[i + 2] = d[i + 2] * a; f[i + 3] = d[i + 3]; }
  return f;
}
function unpremulTo(f: Float32Array, o: Uint8ClampedArray) {
  for (let i = 0; i < f.length; i += 4) { const a = f[i + 3]; if (a > 0.01) { o[i] = f[i] / (a / 255); o[i + 1] = f[i + 1] / (a / 255); o[i + 2] = f[i + 2] / (a / 255); } o[i + 3] = a; }
}
/** bilinear read of a premultiplied float RGBA image (transparent outside) */
function bil(f: Float32Array, w: number, h: number, x: number, y: number, out: number[]) {
  const x0 = Math.floor(x), y0 = Math.floor(y), u = x - x0, v = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 4; j++) {
    const xx = x0 + (j & 1), yy = y0 + (j >> 1);
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const wt = ((j & 1) ? u : 1 - u) * ((j >> 1) ? v : 1 - v), k = (yy * w + xx) * 4;
    out[0] += f[k] * wt; out[1] += f[k + 1] * wt; out[2] += f[k + 2] * wt; out[3] += f[k + 3] * wt;
  }
}
/** velocity (px per frame) of every pixel of `cur`: flow to the next frame and back from the previous one, averaged */
function velocity(c: Uint8ClampedArray, prev: HTMLCanvasElement | null, next: HTMLCanvasElement | null, W: number, H: number, detail: number): Flow | null {
  const n = next ? opticalFlow(c, read(next).data, W, H, detail, 0.5) : null, b = prev ? opticalFlow(c, read(prev).data, W, H, detail, 0.5) : null;
  if (!n && !b) return null;
  const u = new Float32Array(W * H), v = new Float32Array(W * H), k = n && b ? 0.5 : 1;
  for (let i = 0; i < u.length; i++) { u[i] = ((n ? n.u[i] : 0) - (b ? b.u[i] : 0)) * k; v[i] = ((n ? n.v[i] : 0) - (b ? b.v[i] : 0)) * k; }
  return { w: W, h: H, u, v };
}

/**
 * Pixel Motion Blur: the motion of every pixel comes from optical flow between this frame and the source frames before
 * and after it (Vector Detail = the density of the tracked grid); each pixel is then averaged along its motion over the
 * shutter (Shutter Angle / 360 of a frame, centred on the frame) with Shutter Samples samples. Automatic takes the
 * angle and samples of the composition's motion blur, and blurs only when the layer's and the comp's switches are on.
 * Called by the renderer, which fetches the neighbouring frames.
 */
export function pixelMotionBlur(cur: HTMLCanvasElement, prev: HTMLCanvasElement | null, next: HTMLCanvasElement | null, p: (k: string) => unknown, comp: { on: boolean; angle: number; samples: number }): HTMLCanvasElement {
  const auto = String(p('shutterControl') ?? 'manual') === 'auto';
  if (auto && !comp.on) return cur;
  const angle = auto ? comp.angle : Math.max(0, num(p('shutterAngle'), 180)), n = Math.max(1, Math.min(256, Math.round(auto ? comp.samples : num(p('shutterSamples'), 5))));
  const span = angle / 360;
  if (span <= 0 || n < 2) return cur;
  const W = cur.width, H = cur.height, d = read(cur).data;
  const vel = velocity(d, prev, next, W, H, clamp(num(p('vectorDetail'), 20), 5, 100));
  if (!vel) return cur;
  const f = premulOf(d), acc = new Float32Array(f.length), s = [0, 0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, u = vel.u[i], v = vel.v[i];
    if (Math.abs(u) * span < 0.05 && Math.abs(v) * span < 0.05) { for (let c = 0; c < 4; c++) acc[i * 4 + c] = f[i * 4 + c]; continue; }
    for (let k = 0; k < n; k++) {
      const t = span * (k / (n - 1) - 0.5);
      bil(f, W, H, x - u * t, y - v * t, s);
      for (let c = 0; c < 4; c++) acc[i * 4 + c] += s[c] / n;
    }
  }
  const o = new Uint8ClampedArray(d.length);
  unpremulTo(acc, o);
  return write(W, H, o);
}

// ───────────────────────── Camera-Shake Deblur ─────────────────────────

/** sharpness of an image: mean squared Laplacian of its luma (on every other pixel) */
export function sharpness(d: Uint8ClampedArray, w: number, h: number): number {
  const L = (i: number) => (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) * (d[i * 4 + 3] / 255);
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const i = y * w + x, lap = 4 * L(i) - L(i - 1) - L(i + 1) - L(i - w) - L(i + w);
    s += lap * lap; n++;
  }
  return n ? s / n : 0;
}
/** separable gaussian (3 box passes) of a float RGBA image, edges repeated */
function soft(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let a = src.slice(), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) for (const horiz of [true, false]) {
    const len = horiz ? w : h, lines = horiz ? h : w;
    for (let l = 0; l < lines; l++) for (let c = 0; c < 4; c++) {
      const at = (i: number) => { const k = Math.max(0, Math.min(len - 1, i)); return a[((horiz ? l * w + k : k * w + l) * 4) + c]; };
      let s = 0;
      for (let k = -r; k <= r; k++) s += at(k);
      for (let i = 0; i < len; i++) { b[((horiz ? l * w + i : i * w + l) * 4) + c] = s / (2 * r + 1); s += at(i + r + 1) - at(i - r); }
    }
    [a, b] = [b, a];
  }
  return a;
}

/**
 * Camera-Shake Deblur: the frames within Blur Duration around this one are rated for sharpness; when this frame is
 * blurrier than the sharpest of them by more than Shake Sensitivity allows (shake = 1 − its sharpness / the best), the
 * detail (high frequencies) of the sharpest frame — or of the two sharpest, with High Quality, which also tracks a
 * finer grid — is aligned to this frame with optical flow and added in place of its own, by Strength (100 = all of
 * it). Sharp frames are left alone. Called by the renderer with the neighbouring frames placed on this canvas.
 */
export function cameraShakeDeblur(cur: HTMLCanvasElement, frames: (HTMLCanvasElement | null)[], p: (k: string) => unknown): HTMLCanvasElement {
  const W = cur.width, H = cur.height, d = read(cur).data, own = sharpness(d, W, H);
  const hq = String(p('method') ?? 'standard') === 'high', strength = clamp(num(p('strength'), 100), 0, 200) / 100, sens = clamp(num(p('sensitivity'), 50), 0, 100) / 100;
  const rated: { d: Uint8ClampedArray; s: number }[] = [];
  for (const c of frames) { if (!c) continue; const fd = read(c).data; const sh = sharpness(fd, W, H); if (sh > own) rated.push({ d: fd, s: sh }); }
  if (!rated.length || strength <= 0) return cur;
  rated.sort((a, b) => b.s - a.s);
  const best = rated[0].s, shake = 1 - own / best;
  // Shake Sensitivity: 0 fixes only frames that lost most of their detail, 100 any frame softer than its neighbours
  const thr = (1 - sens) * 0.6, amt = clamp((shake - thr) / 0.15) * strength;
  if (amt <= 0) return cur;
  const use = rated.slice(0, hq ? 2 : 1), detail = hq ? 60 : 20;
  const f = premulOf(d), base = soft(f, W, H, 1.5), add = new Float32Array(f.length), s = [0, 0, 0, 0];
  let wsum = 0;
  for (const r of use) {
    const fl = opticalFlow(d, r.d, W, H, detail, 0.5), g = premulOf(r.d), warped = new Float32Array(f.length);
    // the sharp frame pulled onto this one: this pixel went to x + flow in it
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; bil(g, W, H, x + fl.u[i], y + fl.v[i], s); for (let c = 0; c < 4; c++) warped[i * 4 + c] = s[c]; }
    const wl = soft(warped, W, H, 1.5), wt = r.s;
    for (let i = 0; i < f.length; i++) add[i] += (warped[i] - wl[i]) * wt;
    wsum += wt;
  }
  const o = new Float32Array(f.length);
  for (let i = 0; i < f.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const mine = f[i + c] - base[i + c], hi = add[i + c] / wsum;
      o[i + c] = Math.max(0, Math.min(255, f[i + c] + amt * (hi - mine)));
    }
    o[i] = Math.min(o[i], o[i + 3]); o[i + 1] = Math.min(o[i + 1], o[i + 3]); o[i + 2] = Math.min(o[i + 2], o[i + 3]);
  }
  const out = new Uint8ClampedArray(d.length);
  unpremulTo(o, out);
  return write(W, H, out);
}

// ───────────────────────── Detail-preserving Upscale ─────────────────────────

/** Upscale's scale (1 = 100 %): Fit to Comp Width / Height from the layer and comp sizes, else Scale */
export function upscaleFactor(p: Params, lw: number, lh: number, cw: number, ch: number): number {
  if (num(p.fitWidth) && lw > 0 && cw > 0) return Math.max(1, cw / lw);
  if (num(p.fitHeight) && lh > 0 && ch > 0) return Math.max(1, ch / lh);
  return Math.max(1, Math.min(300, num(p.scale, 100) / 100));
}
/** Room (layer px) that Detail-preserving Upscale needs around a layer of w × h already padded by `grow` (≤ 4096 px). */
export function upscalePad(fxs: { fx: string; p: Params }[], w: number, h: number, cw: number, ch: number, grow: number): number {
  let pad = 0, half = Math.max(w, h) / 2 + grow;
  for (const { fx, p } of fxs) {
    if (fx !== 'upscale') continue;
    const k = upscaleFactor(p, w, h, cw, ch), more = half * (k - 1);
    pad += more; half += more;
  }
  return Math.min(4096, Math.ceil(pad));
}

/**
 * Detail-preserving Upscale: the layer enlarged about its centre by Scale (or to the comp's width / height). Reduce
 * Noise smooths flat areas first (edges are kept); the enlargement is bicubic, and Detail then restores the edges with
 * an unsharp mask sized to the enlargement whose result is held within the local minimum and maximum (no halos).
 * Alpha: Bicubic leaves the alpha as enlarged; Detail-preserving sharpens it too. The layer's room comes from upscalePad.
 */
function upscale(cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const W = cv.width, H = cv.height, lw = W / x.res + 2 * x.ox, lh = H / x.res + 2 * x.oy;
  const [cw, ch] = x.compSize ?? [0, 0];
  const k = upscaleFactor(p, lw, lh, cw, ch);
  let src = cv;
  const nr = clamp(num(p.noise) / 100);
  if (nr > 0) {
    // edge-aware smoothing: the blurred image where the local contrast is low
    const d = read(cv).data, b = read(FX_IMPL.gaussianBlur(cv, { amount: 1 + nr * 3, repeat: 1 }, { ...x, res: 1 })).data, o = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const e = clamp((Math.abs(d[i] - b[i]) + Math.abs(d[i + 1] - b[i + 1]) + Math.abs(d[i + 2] - b[i + 2])) / (40 + 60 * (1 - nr)));
      const m = nr * (1 - e);
      for (let c = 0; c < 4; c++) o[i + c] = d[i + c] * (1 - m) + b[i + c] * m;
    }
    src = write(W, H, o);
  }
  if (k <= 1.0001 && nr <= 0) return cv;
  // bicubic enlargement about the layer's centre
  const cx = -x.ox * x.res + (lw * x.res) / 2, cy = -x.oy * x.res + (lh * x.res) / 2;
  const big = mk(W, H), g = ctx2d(big);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.setTransform(k, 0, 0, k, cx - k * cx, cy - k * cy);
  g.drawImage(src, 0, 0);
  const amt = clamp(num(p.detail, 50) / 100) * 1.5;
  if (amt <= 0 || k <= 1.0001) return big;
  const bd = read(big).data, sharpA = String(p.alpha ?? 'bicubic') === 'detail';
  const f = premulOf(bd), bl = soft(f, W, H, Math.max(0.6, 0.5 * k)), o = new Float32Array(f.length);
  for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
    const i = (y * W + X) * 4;
    for (let c = 0; c < 4; c++) {
      if (c === 3 && !sharpA) { o[i + 3] = f[i + 3]; continue; }
      // local range of the 3 × 3 neighbourhood: the sharpened value stays inside it
      let lo = Infinity, hi = -Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.max(0, Math.min(W - 1, X + dx)), yy = Math.max(0, Math.min(H - 1, y + dy)), v = f[(yy * W + xx) * 4 + c];
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      o[i + c] = Math.max(lo, Math.min(hi, f[i + c] + amt * (f[i + c] - bl[i + c])));
    }
    o[i] = Math.min(o[i], o[i + 3]); o[i + 1] = Math.min(o[i + 1], o[i + 3]); o[i + 2] = Math.min(o[i + 2], o[i + 3]);
  }
  const out = new Uint8ClampedArray(bd.length);
  unpremulTo(o, out);
  return write(W, H, out);
}

/** extra room (layer px) these effects draw outside the layer, for fxGrowth (size-independent part) */
export function lenteGrowth(fx: string, p: Params): number {
  if (fx === 'cameraLensBlur' && !num(p.repeat, 1)) return Math.max(0, num(p.radius, 5)) * Math.max(1, Math.sqrt(Math.max(0.01, num(p.aspect, 1)))) + 2;
  if (fx === 'fastBlur' && !num(p.repeat, 1)) return num(p.blurriness) * 1.6;
  return 0;
}
/** source frames (relative to now) that the time effects of this line read */
export function lenteFrames(fx: string, p: (k: string) => unknown): number[] {
  if (fx === 'pixelMotionBlur') return [-1, 1];
  const n = (Math.max(5, Math.min(9, Math.round(Number(p('duration') ?? 5)) || 5)) - 1) / 2;
  return Array.from({ length: 2 * n + 1 }, (_, i) => i - n).filter((k) => k !== 0);
}

export const IMPL_LENTE: Record<string, FxFn> = {
  cameraLensBlur,
  // Fast Blur (Legacy): After Effects' box-approximated gaussian, the same blur as Gaussian Blur
  fastBlur: (cv, p, x) => FX_IMPL.gaussianBlur(cv, { amount: num(p.blurriness), dir: p.dims ?? 'both', repeat: num(p.repeat, 1) }, x),
  // time effects: done by the renderer (they need the layer at other moments)
  pixelMotionBlur: (cv) => cv,
  cameraShakeDeblur: (cv) => cv,
  upscale,
};
