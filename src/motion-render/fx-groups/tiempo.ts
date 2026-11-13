// Drawing of the effects in src/core/motion/fx-groups/tiempo.ts. Those that read the layer at other moments are drawn
// by TIME_TIEMPO, which the time-effects block of render.ts calls with the frames it asked for; CC Time Blend FX's
// buffer is kept by render.ts (timeBlendStep blends it). Helpers come from ../fx: only use them inside the functions
// (fx.ts imports this file while it is still loading).
import type { FxCtx, FxFn } from '../fx';
import { mk, ctx2d } from '../fx';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const c255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const read = (cv: HTMLCanvasElement) => ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height).data as Uint8ClampedArray;
function write(w: number, h: number, d: Uint8ClampedArray): HTMLCanvasElement {
  const out = mk(w, h), g = ctx2d(out), img = g.createImageData(w, h);
  img.data.set(d);
  g.putImageData(img, 0, 0);
  return out;
}
/** another layer (a layer parameter) stretched over this canvas, or null */
function other(id: unknown, cv: HTMLCanvasElement, x: FxCtx): HTMLCanvasElement | null {
  const L = typeof id === 'string' && id && x.layer ? x.layer(id) : null;
  if (!L || !L.cv.width || !L.cv.height) return null;
  const out = mk(cv.width, cv.height);
  ctx2d(out).drawImage(L.cv, 0, 0, cv.width, cv.height);
  return out;
}
/** a point parameter (layer px) in canvas px */
const ptPx = (v: unknown, x: { ox: number; oy: number; res: number; pox?: number; poy?: number }): [number, number] => {
  const a = Array.isArray(v) ? v : [0, 0];
  return [(num(a[0]) - (x.pox ?? 0) - x.ox) * x.res, (num(a[1]) - (x.poy ?? 0) - x.oy) * x.res];
};
function hsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

/** Vertical Gaussian of standard deviation s (canvas px) on premultiplied values: Reduce Interlace Flicker. */
function blurV(cv: HTMLCanvasElement, s: number): HTMLCanvasElement {
  const W = cv.width, H = cv.height, d = read(cv), r = Math.ceil(s * 3);
  if (s < 0.05 || !H) return cv;
  const k: number[] = []; let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * s * s)); k.push(v); ks += v; }
  const out = new Uint8ClampedArray(d.length), col = new Float32Array(H * 4);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { const i = (y * W + x) * 4, a = d[i + 3] / 255; col[y * 4] = d[i] * a; col[y * 4 + 1] = d[i + 1] * a; col[y * 4 + 2] = d[i + 2] * a; col[y * 4 + 3] = d[i + 3]; }
    for (let y = 0; y < H; y++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let j = -r; j <= r; j++) { const yy = y + j; if (yy < 0 || yy >= H) continue; const w = k[j + r]; R += col[yy * 4] * w; G += col[yy * 4 + 1] * w; B += col[yy * 4 + 2] * w; A += col[yy * 4 + 3] * w; }
      const i = (y * W + x) * 4, a = A / ks;
      out[i + 3] = a;
      if (a > 0.01) { const u = 255 / a / ks; out[i] = R * u; out[i + 1] = G * u; out[i + 2] = B * u; }
    }
  }
  return write(W, H, out);
}

/** Box averages from a summed-area table of premultiplied RGBA (CC Mr. Smoothie's samples). */
function integral(d: Uint8ClampedArray, W: number, H: number): Float64Array {
  const S = new Float64Array((W + 1) * (H + 1) * 4);
  for (let y = 0; y < H; y++) {
    const r = [0, 0, 0, 0];
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, a = d[i + 3] / 255;
      r[0] += d[i] * a; r[1] += d[i + 1] * a; r[2] += d[i + 2] * a; r[3] += d[i + 3];
      const o = ((y + 1) * (W + 1) + x + 1) * 4, u = (y * (W + 1) + x + 1) * 4;
      for (let c = 0; c < 4; c++) S[o + c] = S[u + c] + r[c];
    }
  }
  return S;
}
function boxAvg(S: Float64Array, W: number, H: number, cx: number, cy: number, r: number): number[] {
  const x0 = clamp(Math.floor(cx - r), 0, W - 1), x1 = clamp(Math.floor(cx + r), 0, W - 1), y0 = clamp(Math.floor(cy - r), 0, H - 1), y1 = clamp(Math.floor(cy + r), 0, H - 1);
  const at = (x: number, y: number, c: number) => S[(y * (W + 1) + x) * 4 + c], n = (x1 - x0 + 1) * (y1 - y0 + 1);
  return [0, 1, 2, 3].map((c) => (at(x1 + 1, y1 + 1, c) - at(x0, y1 + 1, c) - at(x1 + 1, y0, c) + at(x0, y0, c)) / n);
}

/** Deflicker: each frame's level (Timelapse: per channel over the frame; High Frequency: per row) is brought to the
 *  window's average; Detail Preservation mixes that with the average of the evened-out frames. */
function deflickerDraw(cur: HTMLCanvasElement, frames: (HTMLCanvasElement | null)[], at: number, p: (k: string) => unknown): HTMLCanvasElement {
  const W = cur.width, H = cur.height, rows = String(p('mode')) === 'highFrequency', det = clamp(num(p('detail'), 100) / 100);
  const ds = frames.map((f, k) => (k === at ? read(cur) : f ? read(f) : null)).filter((x) => !!x) as Uint8ClampedArray[];
  if (ds.length < 2) return cur;
  const self = read(cur);
  // levels: one per channel (Timelapse) or per row and channel (High Frequency), alpha-weighted
  const bins = rows ? H : 1;
  const level = (d: Uint8ClampedArray) => {
    const s = new Float64Array(bins * 3), a = new Float64Array(bins);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, w = d[i + 3], b = rows ? y : 0; s[b * 3] += d[i] * w; s[b * 3 + 1] += d[i + 1] * w; s[b * 3 + 2] += d[i + 2] * w; a[b] += w; }
    for (let b = 0; b < bins; b++) for (let c = 0; c < 3; c++) s[b * 3 + c] = a[b] > 0 ? s[b * 3 + c] / a[b] : 0;
    return s;
  };
  const lv = ds.map(level), tgt = new Float64Array(bins * 3);
  for (const l of lv) for (let i = 0; i < tgt.length; i++) tgt[i] += l[i] / lv.length;
  const gain = (l: Float64Array, b: number, c: number) => (l[b * 3 + c] > 0.5 ? tgt[b * 3 + c] / l[b * 3 + c] : 1);
  const own = level(self), out = new Uint8ClampedArray(self.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, b = rows ? y : 0;
    for (let c = 0; c < 3; c++) {
      const fixed = self[i + c] * gain(own, b, c);
      let avg = fixed;
      if (det < 1) { avg = 0; ds.forEach((d, k) => { avg += d[i + c] * gain(lv[k], b, c); }); avg /= ds.length; }
      out[i + c] = c255(fixed * det + avg * (1 - det));
    }
    out[i + 3] = self[i + 3];
  }
  return write(W, H, out);
}

/** Time Difference (as the plug-in): RGB 127.5 + (layer − target) × c, or |layer − target| × 2c with Absolute
 *  Difference (c = contrast / 100); the alpha from the chosen source; with no target, flat «no difference». */
export function timeDifference(cur: HTMLCanvasElement, tgt: HTMLCanvasElement | null, p: (k: string) => unknown): HTMLCanvasElement {
  const W = cur.width, H = cur.height, abs = !!num(p('absolute')), c = num(p('contrast'), 50) / 100, gain = abs ? 2 * c : c, mode = String(p('alpha') ?? 'original');
  const s = read(cur), out = new Uint8ClampedArray(s.length);
  if (!tgt) { for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = abs ? 0 : 127; out[i + 3] = 255; } return write(W, H, out); }
  const t = read(tgt), dif = (a: number, b: number) => (abs ? Math.min(255, Math.abs((a - b) * gain)) : c255((a - b) * gain + 127.5));
  for (let i = 0; i < s.length; i += 4) {
    const r = dif(s[i], t[i]), g = dif(s[i + 1], t[i + 1]), b = dif(s[i + 2], t[i + 2]), ad = Math.min(255, Math.abs((s[i + 3] - t[i + 3]) * gain));
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
    switch (mode) {
      case 'target': out[i + 3] = t[i + 3]; break;
      case 'blend': out[i + 3] = (s[i + 3] + t[i + 3]) >> 1; break;
      case 'max': out[i + 3] = Math.max(s[i + 3], t[i + 3]); break;
      case 'full': out[i + 3] = 255; break;
      // the result as a matte of the original colours
      case 'lightness': out[i + 3] = (r + g + b) / 3; out[i] = s[i]; out[i + 1] = s[i + 1]; out[i + 2] = s[i + 2]; break;
      case 'maxResult': out[i + 3] = Math.max(r, g, b); out[i] = s[i]; out[i + 1] = s[i + 1]; out[i + 2] = s[i + 2]; break;
      case 'alphaDiff': out[i + 3] = ad; break;
      case 'alphaDiffOnly': out[i] = out[i + 1] = out[i + 2] = 255; out[i + 3] = ad; break;
      default: out[i + 3] = s[i + 3];
    }
  }
  return write(W, H, out);
}

/** canvas geometry of the frame a time effect draws on (layer px of its top-left, px per layer px, effect point
 *  origin of text and shape layers) */
export interface Geo { ox: number; oy: number; res: number; pox?: number; poy?: number }
/** now (comp time), frame rate, the layer's in / out points and start, its id */
export interface TimeIn { t: number; fps: number; inPt: number; outPt: number; start: number; self: string }
/** the canvas geometry, now, the moments read and another layer read (stretched over this canvas) */
export interface TimeOut { g: Geo; t: number; times: number[]; other: HTMLCanvasElement | null }
/** The time effects of this file for render.ts: the moments to read (comp time) given the parameters now, and the
 *  drawing from the current frame and those moments (placed on its canvas; null where the layer isn't there). */
export const TIME_TIEMPO: Record<string, {
  times: (p: (k: string) => unknown, c: TimeIn) => number[];
  draw: (cur: HTMLCanvasElement, frames: (HTMLCanvasElement | null)[], p: (k: string) => unknown, c: TimeOut) => HTMLCanvasElement;
  /** another layer read at another moment (Time Difference's target) */
  other?: (p: (k: string) => unknown, t: number, self: string) => { id: string; t: number } | null;
}> = {
  // the window: the frames to average, widened in High Frequency to a whole beat of the flicker against the frame
  // rate (its aliased frequency), up to 31 frames; the current frame is among them
  deflicker: {
    times: (p, { t, fps, inPt, outPt }) => {
      let n = Math.round(clamp(num(p('frames'), 5), 2, 31));
      if (String(p('mode')) === 'highFrequency') { const f = num(p('frequency'), 100), beat = Math.abs(f - fps * Math.round(f / fps)); if (beat > 1e-3) n = Math.max(n, Math.min(31, Math.ceil(fps / beat))); }
      const f0 = Math.round(t * fps), lo = -Math.floor((n - 1) / 2), out: number[] = [];
      for (let k = lo; k < lo + n; k++) { const tt = (f0 + k) / fps; if (tt >= inPt - 1e-6 && tt < outPt - 1e-6) out.push(tt); }
      return out;
    },
    draw: (cur, f, p, { t, times }) => { let at = 0, best = Infinity; times.forEach((tt, k) => { if (Math.abs(tt - t) < best) { best = Math.abs(tt - t); at = k; } }); return deflickerDraw(cur, f, at, p); },
  },
  // the target: this layer at now + offset, or another layer then
  timeDifference: {
    times: (p, c) => (String(p('target') ?? '') === c.self ? [c.t + num(p('offset'))] : []),
    other: (p, t, self) => { const id = String(p('target') ?? ''); return id && id !== self ? { id, t: t + num(p('offset')) } : null; },
    draw: (cur, f, p, c) => timeDifference(cur, c.times.length ? f[0] ?? mk(cur.width, cur.height) : c.other, p),
  },
};

const GCO: Record<string, GlobalCompositeOperation> = { over: 'source-over', under: 'destination-over', screen: 'screen', add: 'lighter', softLight: 'soft-light', hardLight: 'hard-light', lighten: 'lighten', darken: 'darken', multiply: 'multiply', difference: 'difference', color: 'color', overlay: 'overlay', luminosity: 'luminosity', overClassic: 'source-over', underClassic: 'destination-over' };
/** CC Time Blend (FX): the buffer fades by the accumulation and the frame goes on with the transfer mode (Blend:
 *  accumulation × buffer + (1 − accumulation) × frame). A missing buffer is cleared to transparent or to the frame. */
export function timeBlendStep(buf: HTMLCanvasElement | null, cur: HTMLCanvasElement, a: number, mode: string, clearTo: string): HTMLCanvasElement {
  const W = cur.width, H = cur.height, out = mk(W, H), g = ctx2d(out);
  const b = buf ?? (clearTo === 'current' ? cur : null);
  g.globalAlpha = clamp(a);
  if (b) g.drawImage(b, 0, 0);
  if (mode === 'blend' || mode === 'blendClassic') { g.globalAlpha = 1 - clamp(a); g.globalCompositeOperation = 'lighter'; }
  else { g.globalAlpha = 1; g.globalCompositeOperation = GCO[mode] ?? 'source-over'; }
  g.drawImage(cur, 0, 0);
  return out;
}

/** CC Composite's modes on straight 0…1 values: s = original (on top), d = the effects' result */
function ccBlend(mode: string, s: number, d: number): number {
  switch (mode) {
    case 'darken': return Math.min(s, d);
    case 'multiply': return s * d;
    case 'linearBurn': return Math.max(0, s + d - 1);
    case 'colorBurn': return s <= 0 ? (d >= 1 ? 1 : 0) : 1 - Math.min(1, (1 - d) / s);
    case 'classicColorBurn': return s <= 0 ? 0 : clamp(1 - (1 - d) / s);
    case 'add': case 'linearDodge': return Math.min(1, s + d);
    case 'lighten': return Math.max(s, d);
    case 'screen': return 1 - (1 - s) * (1 - d);
    case 'colorDodge': return s >= 1 ? (d <= 0 ? 0 : 1) : Math.min(1, d / (1 - s));
    case 'classicColorDodge': return s >= 1 ? 1 : clamp(d / (1 - s));
    case 'overlay': return d < 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
    case 'softLight': return s < 0.5 ? d - (1 - 2 * s) * d * (1 - d) : d + (2 * s - 1) * ((d < 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d)) - d);
    case 'hardLight': return s < 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
    case 'linearLight': return clamp(d + 2 * s - 1);
    case 'vividLight': return s < 0.5 ? (s <= 0 ? 0 : clamp(1 - (1 - d) / (2 * s))) : s >= 1 ? 1 : clamp(d / (2 * (1 - s)));
    case 'pinLight': return s < 0.5 ? Math.min(d, 2 * s) : Math.max(d, 2 * s - 1);
    case 'hardMix': return s + d >= 1 ? 1 : 0;
    case 'difference': case 'classicDifference': return Math.abs(s - d);
    case 'exclusion': return s + d - 2 * s * d;
    default: return s;
  }
}
const lumOf = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
/** colour with the lightness of l (the non-separable modes) */
function setLum(c: number[], l: number): number[] {
  const d = l - lumOf(c[0], c[1], c[2]), o = c.map((v) => v + d), L = lumOf(o[0], o[1], o[2]), n = Math.min(...o), x = Math.max(...o);
  return o.map((v) => (n < 0 ? L + ((v - L) * L) / (L - n) : x > 1 ? L + ((v - L) * (1 - L)) / (x - L) : v));
}
function setSat(c: number[], s: number): number[] {
  const mx = Math.max(...c), mn = Math.min(...c);
  return c.map((v) => (mx > mn ? ((v - mn) * s) / (mx - mn) : 0));
}

export const IMPL_TIEMPO: Record<string, FxFn> = {
  // drawn by the time-effects block of render.ts (TIME_TIEMPO) or by its CC Time Blend FX buffer
  deflicker: (cv) => cv,
  timeDifference: (cv) => cv,
  ccTimeBlendFx: (cv) => cv,
  reduceInterlaceFlicker: (cv, p, x) => blurV(cv, num(p.softness) * x.res),
  // CC Block Load: Scans passes, the k-th with blocks of 2^(Scans − 1 − k) px, each loading from the top down; the
  // rows still to come show the pass before (or nothing at first with Start Cleared)
  ccBlockLoad: (cv, p, x) => {
    const W = cv.width, H = cv.height, S = Math.round(clamp(num(p.scans, 4), 1, 16)), clr = !!num(p.startCleared, 1), lin = !!num(p.bilinear);
    const c = clamp(num(p.completion) / 100), pos = clr ? c * S : 1 + c * (S - 1);
    if (pos >= S - 1e-9) return cv;
    const k = Math.floor(pos), fr = pos - k;
    // one pass: the image averaged over blocks (drawn small, then scaled up sharp or bilinear)
    const pass = (j: number) => {
      const bs = Math.max(1, (2 ** (S - 1 - j)) * x.res), sw = Math.max(1, Math.ceil(W / bs)), sh = Math.max(1, Math.ceil(H / bs));
      const sm = mk(sw, sh), sg = ctx2d(sm); sg.imageSmoothingQuality = 'high'; sg.drawImage(cv, 0, 0, sw, sh);
      const o = mk(W, H), og = ctx2d(o); og.imageSmoothingEnabled = lin; og.drawImage(sm, 0, 0, W, H);
      return { o, bs };
    };
    const out = mk(W, H), g = ctx2d(out);
    const now = pass(k), y = Math.min(H, Math.round((fr * H) / now.bs) * now.bs);
    if (k > 0) g.drawImage(pass(k - 1).o, 0, 0);
    if (y > 0) { g.clearRect(0, 0, W, y); g.drawImage(now.o, 0, 0, W, y, 0, 0, W, y); }
    return out;
  },
  // CC Mr. Smoothie: a 256-colour palette sampled along A → B (each sample the average of a square of side
  // 2 × Smoothness), read through the colour loop at the flow layer's property + Phase; the layer keeps its alpha
  ccMrSmoothie: (cv, p, x) => {
    const W = cv.width, H = cv.height, d = read(cv), S = integral(d, W, H), r = Math.max(0, num(p.smoothness, 4) * x.res);
    const A = ptPx(p.sampleA, x), B = ptPx(p.sampleB, x), N = 256, pal = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1), s = boxAvg(S, W, H, A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, r), a = s[3] / 255;
      for (let c = 0; c < 3; c++) pal[i * 3 + c] = a > 1e-3 ? s[c] / a : 0;
    }
    const flow = other(p.flow, cv, x), f = flow ? read(flow) : d, prop = String(p.property ?? 'luminance'), ph = num(p.phase) / 360, loop = String(p.loop ?? 'AB');
    const out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const R = f[i] / 255, G = f[i + 1] / 255, Bl = f[i + 2] / 255;
      let v: number;
      switch (prop) {
        case 'red': v = R; break; case 'green': v = G; break; case 'blue': v = Bl; break; case 'alpha': v = f[i + 3] / 255; break;
        case 'lightness': v = hsl(R, G, Bl)[2]; break; case 'hue': v = hsl(R, G, Bl)[0]; break; case 'saturation': v = hsl(R, G, Bl)[1]; break;
        default: v = 0.299 * R + 0.587 * G + 0.114 * Bl;
      }
      let u = v + ph; u -= Math.floor(u); if (v + ph === Math.floor(v + ph) && v + ph > 0) u = 1;
      if (loop === 'BA') u = 1 - u; else if (loop === 'ABA') u = u < 0.5 ? 2 * u : 2 - 2 * u; else if (loop === 'BAB') u = u < 0.5 ? 1 - 2 * u : 2 * u - 1;
      const j = Math.round(u * (N - 1)) * 3;
      out[i] = pal[j]; out[i + 1] = pal[j + 1]; out[i + 2] = pal[j + 2]; out[i + 3] = d[i + 3];
    }
    return write(W, H, out);
  },
  // CC Composite: the layer before its effects (x.src) composited with their result in the mode, at Opacity; RGB
  // Only keeps the result's alpha
  ccComposite: (cv, p, x) => {
    const src = x.src;
    if (!src) return cv;
    const W = cv.width, H = cv.height, mode = String(p.mode ?? 'inFront'), op = clamp(num(p.opacity, 100) / 100), rgbOnly = !!num(p.rgbOnly, 1);
    const s = read(src.width === W && src.height === H ? src : (() => { const m = mk(W, H); ctx2d(m).drawImage(src, 0, 0, W, H); return m; })()), d = read(cv), out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const sa = s[i + 3] / 255, da = d[i + 3] / 255, S3 = [s[i] / 255, s[i + 1] / 255, s[i + 2] / 255], D3 = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
      let rgb: number[], a: number;
      const mix = (f: number[]) => {
        // the blended colour where both are, each one alone elsewhere (straight colours, «over» coverage)
        const as = sa * op, ao = as + da * (1 - as);
        const c = [0, 1, 2].map((k) => (ao > 0 ? (as * da * f[k] + as * (1 - da) * S3[k] + da * (1 - as) * D3[k]) / ao : 0));
        return { c, ao };
      };
      switch (mode) {
        case 'copy': rgb = S3.map((v, k) => v * op + D3[k] * (1 - op)); a = sa * op + da * (1 - op); break;
        case 'behind': { const ao = da + sa * op * (1 - da); rgb = [0, 1, 2].map((k) => (ao > 0 ? (D3[k] * da + S3[k] * sa * op * (1 - da)) / ao : 0)); a = ao; break; }
        case 'inFront': { const as = sa * op, ao = as + da * (1 - as); rgb = [0, 1, 2].map((k) => (ao > 0 ? (S3[k] * as + D3[k] * da * (1 - as)) / ao : 0)); a = ao; break; }
        case 'hue': case 'saturation': case 'color': case 'luminosity': {
          const sat = (c: number[]) => Math.max(...c) - Math.min(...c);
          const f = mode === 'hue' ? setLum(setSat(S3, sat(D3)), lumOf(D3[0], D3[1], D3[2])) : mode === 'saturation' ? setLum(setSat(D3, sat(S3)), lumOf(D3[0], D3[1], D3[2])) : mode === 'color' ? setLum(S3, lumOf(D3[0], D3[1], D3[2])) : setLum(D3, lumOf(S3[0], S3[1], S3[2]));
          const m = mix(f); rgb = m.c; a = m.ao; break;
        }
        // stencils and silhouettes: the original's alpha / luma cuts the result
        case 'stencilAlpha': case 'stencilLuma': case 'silhouetteAlpha': case 'silhouetteLuma': {
          const k = mode.endsWith('Alpha') ? sa : lumOf(S3[0], S3[1], S3[2]) * sa, m = mode.startsWith('stencil') ? k : 1 - k;
          rgb = D3; a = da * (1 - op + op * m); break;
        }
        case 'addAlpha': rgb = [0, 1, 2].map((k) => { const ao = Math.min(1, da + sa * op); return ao > 0 ? Math.min(1, (D3[k] * da + S3[k] * sa * op) / ao) : 0; }); a = Math.min(1, da + sa * op); break;
        // the original added as light (its premultiplied colour on top, alpha unchanged)
        case 'luminescentPremul': rgb = [0, 1, 2].map((k) => (da > 0 ? Math.min(1, (D3[k] * da + S3[k] * sa * op) / da) : 0)); a = da; break;
        default: { const m = mix(S3.map((v, k) => ccBlend(mode, v, D3[k]))); rgb = m.c; a = m.ao; }
      }
      if (rgbOnly) {
        // the result's alpha stays: where it is 0 the colour doesn't matter
        out[i + 3] = d[i + 3];
      } else out[i + 3] = a * 255;
      out[i] = rgb[0] * 255; out[i + 1] = rgb[1] * 255; out[i + 2] = rgb[2] * 255;
    }
    return write(W, H, out);
  },
  // CC Ripple Pulse: the ripple's height at distance r from Center is Pulse Level Time Span × r / R ago (R: to the
  // farthest corner); each pixel looks inwards / outwards by Amplitude × the height's slope
  ccRipplePulse: (cv, p, x) => {
    const W = cv.width, H = cv.height, span = Math.max(0, num(p.timeSpan, 1)), amp = num(p.amplitude, 100) / 100;
    const [cx, cy] = ptPx(p.center, x), R = Math.max(1, ...[[0, 0], [W, 0], [0, H], [W, H]].map(([a, b]) => Math.hypot(a - cx, b - cy)));
    const N = 512, h = new Float32Array(N + 1), now = num(p.pulse, 100);
    for (let i = 0; i <= N; i++) h[i] = (span > 0 && x.at ? num(x.at('pulse', x.t - (span * i) / N), now) : now) / 100;
    const bump = !!num(p.bumpMap);
    const d = read(cv), out = new Uint8ClampedArray(d.length);
    let flat = true; for (let i = 1; i <= N; i++) if (h[i] !== h[0]) { flat = false; break; }
    if (flat && !bump) return cv;
    const hAt = (r: number) => { const u = clamp(r / R) * N, i = Math.min(N - 1, Math.floor(u)), f = u - i; return h[i] * (1 - f) + h[i + 1] * f; };
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const o = (y * W + X) * 4, dx = X + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy);
      if (bump) { const v = c255(127.5 + hAt(r) * 127.5); out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; continue; }
      // slope per unit of R (one whole span), 5 layer px of shift per unit at amplitude 100
      const slope = ((hAt(r + 1) - hAt(r - 1)) / 2) * R, sh = amp * slope * 5 * x.res;
      const k = r > 1e-6 ? sh / r : 0, sx = X + 0.5 - dx * k - 0.5, sy = y + 0.5 - dy * k - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      let R0 = 0, G0 = 0, B0 = 0, A0 = 0;
      for (const [ix, iy, w] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]]) {
        if (ix < 0 || iy < 0 || ix >= W || iy >= H || w <= 0) continue;
        const j = (iy * W + ix) * 4, a = d[j + 3] * w;
        R0 += d[j] * a; G0 += d[j + 1] * a; B0 += d[j + 2] * a; A0 += a;
      }
      out[o + 3] = A0;
      if (A0 > 0) { out[o] = R0 / A0; out[o + 1] = G0 / A0; out[o + 2] = B0 / A0; }
    }
    return write(W, H, out);
  },
};
