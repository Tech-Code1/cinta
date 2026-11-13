// Drawing of the effects in src/core/motion/fx-groups/desenfoque.ts. Helpers come from ../fx: only use them inside
// the functions (fx.ts imports this file while it is still loading).
import type { FxCtx, FxFn, Params } from '../fx';
import { mk, ctx2d } from '../fx';
import { hash2, parseColor } from '../../core/motion/anim';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const rgb255 = (c: unknown) => parseColor(String(c ?? '#000000')).slice(0, 3).map((v) => v * 255);

/** straight RGBA bytes of a canvas (a copy) */
const read = (cv: HTMLCanvasElement) => ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height);
/** writes straight RGBA bytes to a new canvas of the same size */
function write(cv: HTMLCanvasElement, d: Uint8ClampedArray): HTMLCanvasElement {
  const out = mk(cv.width, cv.height), g = ctx2d(out), img = g.createImageData(out.width, out.height);
  img.data.set(d);
  g.putImageData(img, 0, 0);
  return out;
}
/** premultiplied float RGBA (0…255) of straight bytes, and back */
function premul(d: Uint8ClampedArray): Float32Array {
  const f = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; f[i] = d[i] * a; f[i + 1] = d[i + 1] * a; f[i + 2] = d[i + 2] * a; f[i + 3] = d[i + 3]; }
  return f;
}
function unpremul(f: Float32Array, out = new Uint8ClampedArray(f.length)): Uint8ClampedArray {
  for (let i = 0; i < f.length; i += 4) { const a = f[i + 3], k = a > 0.001 ? 255 / a : 0; out[i] = f[i] * k; out[i + 1] = f[i + 1] * k; out[i + 2] = f[i + 2] * k; out[i + 3] = a; }
  return out;
}

/**
 * One box pass along x (horiz) or y over an interleaved float image of nc channels: each sample becomes the mean of
 * the 2r + 1 samples around it (r may be fractional: the two end samples get the fractional weight). Outside the
 * image counts as transparent (0), or repeats the edge sample with clamp.
 */
function boxPass(src: Float32Array, w: number, h: number, nc: number, r: number, horiz: boolean, clampEdge: boolean, chans?: number[]): Float32Array {
  const out = new Float32Array(src);
  if (r <= 0) return out;
  const ri = Math.floor(r), fr = r - ri, norm = 1 / (2 * r + 1);
  const len = horiz ? w : h, lines = horiz ? h : w, step = (horiz ? 1 : w) * nc;
  const cs = chans ?? Array.from({ length: nc }, (_, i) => i);
  const line = new Float32Array(len);
  for (let l = 0; l < lines; l++) {
    const base = (horiz ? l * w : l) * nc;
    for (const c of cs) {
      for (let i = 0; i < len; i++) line[i] = src[base + i * step + c];
      const at = (i: number) => (i < 0 ? (clampEdge ? line[0] : 0) : i >= len ? (clampEdge ? line[len - 1] : 0) : line[i]);
      let s = 0;
      for (let k = -ri; k <= ri; k++) s += at(k);
      for (let i = 0; i < len; i++) {
        out[base + i * step + c] = (s + fr * (at(i - ri - 1) + at(i + ri + 1))) * norm;
        s += at(i + ri + 1) - at(i - ri);
      }
    }
  }
  return out;
}
/** Gaussian of standard deviation sigma approximated by three box passes per direction (dims: both | h | v). */
function gauss(src: Float32Array, w: number, h: number, nc: number, sigma: number, dims = 'both', clampEdge = false, chans?: number[]): Float32Array {
  if (sigma < 0.2) return src;
  const r = (Math.sqrt((12 * sigma * sigma) / 3 + 1) - 1) / 2;
  let f = src;
  for (let k = 0; k < 3; k++) {
    if (dims !== 'v') f = boxPass(f, w, h, nc, r, true, clampEdge, chans);
    if (dims !== 'h') f = boxPass(f, w, h, nc, r, false, clampEdge, chans);
  }
  return f;
}
/** separable minimum / maximum over a (2r + 1) square (or one direction) of the chosen channels; outside the layer
 * counts as 0 unless keepEdges (After Effects' «Don't Shrink Edges») */
function minmax(src: Float32Array, w: number, h: number, r: number, max: boolean, dir: string, chans: number[], keepEdges = true): Float32Array {
  let f = src;
  const pass = (horiz: boolean) => {
    const out = new Float32Array(f), len = horiz ? w : h, lines = horiz ? h : w, step = (horiz ? 1 : w) * 4;
    for (let l = 0; l < lines; l++) {
      const base = (horiz ? l * w : l) * 4;
      for (const c of chans) for (let i = 0; i < len; i++) {
        let v = f[base + i * step + c];
        if (!keepEdges && !max && (i - r < 0 || i + r >= len)) v = 0;
        for (let k = Math.max(0, i - r), e = Math.min(len - 1, i + r); k <= e; k++) { const q = f[base + k * step + c]; if (max ? q > v : q < v) v = q; }
        out[base + i * step + c] = v;
      }
    }
    f = out;
  };
  if (r <= 0) return f;
  if (dir !== 'v') pass(true);
  if (dir !== 'h') pass(false);
  return f;
}
/** median of each chosen channel over a (2r + 1)² square, with a running 256-bin histogram per row */
function median(d: Uint8ClampedArray, w: number, h: number, r: number, chans: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(d);
  if (r <= 0) return out;
  const hist = new Int32Array(256);
  for (const c of chans) for (let y = 0; y < h; y++) {
    hist.fill(0);
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    let n = 0;
    const col = (x: number, s: number) => { if (x < 0 || x >= w) return; for (let yy = y0; yy <= y1; yy++) hist[d[(yy * w + x) * 4 + c]] += s; n += s * (y1 - y0 + 1); };
    for (let x = -r; x <= r; x++) col(x, 1);
    for (let x = 0; x < w; x++) {
      const half = n >> 1;
      let acc = 0, v = 0;
      while (v < 255 && acc + hist[v] <= half) acc += hist[v++];
      out[(y * w + x) * 4 + c] = v;
      col(x - r, -1);
      col(x + r + 1, 1);
    }
  }
  return out;
}
/** another layer of the composition as a canvas the size of this one ('center' at its real size or 'stretch') */
function layerInput(id: unknown, cv: HTMLCanvasElement, x: FxCtx, fit: unknown): HTMLCanvasElement | null {
  const src = typeof id === 'string' && id ? x.layer?.(id) : null;
  if (!src || !src.cv.width || !src.cv.height) return null;
  const out = mk(cv.width, cv.height), g = ctx2d(out);
  if (fit === 'stretch') g.drawImage(src.cv, 0, 0, cv.width, cv.height);
  else { const k = x.res / src.res, w = src.cv.width * k, h = src.cv.height * k; g.drawImage(src.cv, (cv.width - w) / 2, (cv.height - h) / 2, w, h); }
  return out;
}
/** 0…1 value of one of After Effects' channel choices for a straight RGBA pixel */
function chanOf(d: Uint8ClampedArray, i: number, c: unknown): number {
  const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
  switch (c) {
    case 'red': return r;
    case 'green': return g;
    case 'blue': return b;
    case 'alpha': return d[i + 3] / 255;
    case 'luma': return lum(r, g, b);
    case 'full': return 1;
    case 'off': case 'none': return 0;
    default: {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn;
      if (c === 'lightness') return l;
      if (c === 'saturation') return dd === 0 ? 0 : dd / (1 - Math.abs(2 * l - 1));
      if (dd === 0) return 0;
      const hh = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      return hh / 6;
    }
  }
}
/** a 0…1 random value per pixel / cell, stable for a seed */
const rnd01 = (seed: number, i: number) => hash2(seed, i) / 4294967296;

/** box blur repeated `it` times over premultiplied RGBA (After Effects' Box Blur) */
function boxBlurred(cv: HTMLCanvasElement, r: number, it: number, dims: string, rep: boolean): Float32Array {
  const w = cv.width, h = cv.height;
  let f = premul(read(cv).data);
  for (let k = 0; k < it; k++) { if (dims !== 'v') f = boxPass(f, w, h, 4, r, true, rep); if (dims !== 'h') f = boxPass(f, w, h, 4, r, false, rep); }
  return f;
}
/** Gaussian-blurred copy (premultiplied, then back to straight bytes) */
const gaussBytes = (cv: HTMLCanvasElement, sigma: number) => unpremul(gauss(premul(read(cv).data), cv.width, cv.height, 4, sigma, 'both', true));

export const IMPL_DESENFOQUE: Record<string, FxFn> = {
  // CC Force Motion Blur: drawn by the renderer (render.ts, time effects): the samples of the layer averaged
  ccForceMotionBlur: (cv) => cv,
  boxBlur: (cv, p, x) => {
    const r = num(p.radius) * x.res, it = Math.round(clamp(num(p.iterations, 3), 1, 50));
    return r <= 0 ? cv : write(cv, unpremul(boxBlurred(cv, r, it, String(p.dims ?? 'both'), !!num(p.repeat))));
  },
  channelBlur: (cv, p, x) => {
    // each channel with its own blurriness (σ = blurriness / 2, like Gaussian Blur), alpha too; colour is blurred
    // premultiplied so it does not bleed black from transparent pixels
    const w = cv.width, h = cv.height, dims = String(p.dims ?? 'both'), rep = !!num(p.repeat);
    const s = [p.red, p.green, p.blue, p.alpha].map((v) => (num(v) / 2) * x.res);
    if (s.every((v) => v < 0.2)) return cv;
    let f = premul(read(cv).data);
    for (let c = 0; c < 4; c++) f = gauss(f, w, h, 4, s[c], dims, rep, [c]);
    return write(cv, unpremul(f));
  },
  unsharpMask: (cv, p, x) => {
    // Unsharp Mask: v + amount × (v − blur(v)) where the difference is above the threshold (levels 0–255)
    const amt = num(p.amount) / 100, sigma = num(p.radius) * x.res, th = num(p.threshold);
    if (amt <= 0 || sigma < 0.2) return cv;
    const d = read(cv).data, b = gaussBytes(cv, sigma);
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const diff = d[i + c] - b[i + c]; if (Math.abs(diff) > th) d[i + c] = d[i + c] + amt * diff; }
    return write(cv, d);
  },
  smartBlur: (cv, p, x) => {
    // Smart Blur: only neighbours whose value stays within the threshold of the pixel are averaged (edges stay sharp);
    // Edge Only draws the edges (white on black), Overlay Edge draws them white over the blurred image
    const w = cv.width, h = cv.height, r = Math.round(num(p.radius) * x.res), th = num(p.threshold), mode = String(p.mode ?? 'normal');
    const src = read(cv).data;
    let f = new Float32Array(src);
    const pass = (horiz: boolean) => {
      const out = new Float32Array(f), len = horiz ? w : h, lines = horiz ? h : w, step = (horiz ? 1 : w) * 4;
      for (let l = 0; l < lines; l++) {
        const base = (horiz ? l * w : l) * 4;
        for (let i = 0; i < len; i++) {
          const o = base + i * step;
          for (let c = 0; c < 4; c++) {
            const v0 = f[o + c];
            let s = 0, n = 0;
            for (let k = Math.max(0, i - r), e = Math.min(len - 1, i + r); k <= e; k++) { const v = f[base + k * step + c]; if (Math.abs(v - v0) <= th) { s += v; n++; } }
            out[o + c] = s / n;
          }
        }
      }
      f = out;
    };
    if (mode !== 'edge' && r > 0) { pass(true); pass(false); }
    if (mode === 'normal') return write(cv, Uint8ClampedArray.from(f));
    // edges: a pixel differing from a neighbour (right or below) by more than the threshold
    const out = mode === 'edge' ? new Uint8ClampedArray(src.length) : Uint8ClampedArray.from(f);
    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0++) {
      const i = (y * w + x0) * 4;
      let edge = false;
      for (const j of [x0 + 1 < w ? i + 4 : -1, y + 1 < h ? i + w * 4 : -1]) if (j >= 0) for (let c = 0; c < 3; c++) if (Math.abs(src[i + c] - src[j + c]) > th) edge = true;
      if (mode === 'edge') { const v = edge ? 255 : 0; out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255; }
      else if (edge) out[i] = out[i + 1] = out[i + 2] = 255;
    }
    return write(cv, out);
  },
  bilateralBlur: (cv, p, x) => {
    // Bilateral Blur: a Gaussian whose weights also fall with the colour difference (σ_range from the threshold), so
    // edges are kept; done as a horizontal then a vertical pass. Colorize off gives a black & white result
    if (num(p.radius) <= 0) return cv;
    const w = cv.width, h = cv.height, sig = Math.max(0.5, (num(p.radius) * x.res) / 2), r = Math.ceil(sig * 2.5), sr = Math.max(1, (num(p.threshold) / 100) * 255);
    let f: Float32Array = new Float32Array(read(cv).data);
    const ws = Float32Array.from({ length: r + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sig * sig)));
    const pass = (horiz: boolean) => {
      const out = new Float32Array(f), len = horiz ? w : h, lines = horiz ? h : w, step = (horiz ? 1 : w) * 4;
      for (let l = 0; l < lines; l++) {
        const base = (horiz ? l * w : l) * 4;
        for (let i = 0; i < len; i++) {
          const o = base + i * step, r0 = f[o], g0 = f[o + 1], b0 = f[o + 2];
          let sw = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0;
          for (let k = Math.max(0, i - r), e = Math.min(len - 1, i + r); k <= e; k++) {
            const q = base + k * step, dr = f[q] - r0, dg = f[q + 1] - g0, db = f[q + 2] - b0;
            const wt = ws[Math.abs(k - i)] * Math.exp(-(dr * dr + dg * dg + db * db) / (6 * sr * sr));
            sw += wt; s0 += f[q] * wt; s1 += f[q + 1] * wt; s2 += f[q + 2] * wt; s3 += f[q + 3] * wt;
          }
          out[o] = s0 / sw; out[o + 1] = s1 / sw; out[o + 2] = s2 / sw; out[o + 3] = s3 / sw;
        }
      }
      f = out;
    };
    pass(true); pass(false);
    const out = Uint8ClampedArray.from(f);
    if (!num(p.colorize, 1)) for (let i = 0; i < out.length; i += 4) out[i] = out[i + 1] = out[i + 2] = lum(out[i], out[i + 1], out[i + 2]);
    return write(cv, out);
  },
  median: (cv, p, x) => {
    const r = Math.round(num(p.radius) * x.res);
    return r <= 0 ? cv : write(cv, median(read(cv).data, cv.width, cv.height, r, num(p.alpha) ? [0, 1, 2, 3] : [0, 1, 2]));
  },
  dustScratches: (cv, p, x) => {
    // Dust & Scratches: the median of the radius replaces only the pixels that differ from it by more than the threshold
    const r = Math.round(num(p.radius) * x.res), th = num(p.threshold), chans = num(p.alpha) ? [0, 1, 2, 3] : [0, 1, 2];
    if (r <= 0) return cv;
    const d = read(cv).data, m = median(d, cv.width, cv.height, r, chans);
    for (let i = 0; i < d.length; i += 4) { let far = false; for (const c of chans) if (Math.abs(d[i + c] - m[i + c]) > th) far = true; if (far) for (const c of chans) d[i + c] = m[i + c]; }
    return write(cv, d);
  },
  noiseHLS: (cv, p, x) => noiseHLS(cv, p, x, num(p.phase)),
  // the Auto one: «speed» new noise patterns per second
  noiseHLSAuto: (cv, p, x) => noiseHLS(cv, p, x, x.t * num(p.speed, 24) * 360),
  noiseAlpha: (cv, p) => {
    // Noise Alpha: random alpha per pixel; the angle is the random seed of the random types and the phase of the
    // animation ones (moving smoothly, or cycling); the original alpha is added to, clamps, scales or only touches
    // the edges of the noise; overflow clips or wraps
    const amt = num(p.amount) / 100;
    if (amt <= 0) return cv;
    const type = String(p.type ?? 'uniform'), sq = type.startsWith('squared'), anim = type.endsWith('Anim');
    let ph = num(p.phase) / 360;
    if (anim && num(p.cycle)) ph = ph % Math.max(1, Math.round(num(p.cycles, 1)));
    const s0 = Math.floor(ph), fr = anim ? ph - s0 : 0, seed = hash2(anim ? s0 : Math.round(num(p.phase)), 7) | 0, seed2 = hash2(s0 + 1, 7) | 0;
    const orig = String(p.original ?? 'clamp'), over = String(p.overflow ?? 'wrapBack');
    const d = read(cv).data;
    for (let i = 0, k = 0; i < d.length; i += 4, k++) {
      let r = rnd01(seed, k);
      if (fr) r = r * (1 - fr) + rnd01(seed2, k) * fr;
      if (sq) r *= r;
      const a = d[i + 3] / 255, nz = (r - 0.5) * 2 * amt;
      let v = orig === 'add' ? a + nz : orig === 'scale' ? a * (1 + nz) : orig === 'edges' ? a + nz * 4 * a * (1 - a) : a > 0 ? a + nz : 0;
      if (over === 'wrap') v = ((v % 1) + 1) % 1;
      else if (over === 'wrapBack') { v = ((v % 2) + 2) % 2; if (v > 1) v = 2 - v; }
      d[i + 3] = clamp(v) * 255;
    }
    return write(cv, d);
  },
  minimax: (cv, p, x) => {
    // Minimax: each channel takes the minimum / maximum of the radius (min then max opens, max then min closes)
    const r = Math.round(num(p.radius) * x.res);
    if (r <= 0) return cv;
    const op = String(p.op ?? 'max'), dir = String(p.dir ?? 'both'), c = String(p.channel ?? 'color');
    const chans = c === 'color' ? [0, 1, 2] : c === 'alphaColor' ? [0, 1, 2, 3] : [['red', 'green', 'blue', 'alpha'].indexOf(c)];
    let f: Float32Array = new Float32Array(read(cv).data);
    const steps = op === 'min' ? [false] : op === 'max' ? [true] : op === 'minMax' ? [false, true] : [true, false];
    for (const mx of steps) f = minmax(f, cv.width, cv.height, r, mx, dir, chans, !!num(p.noShrink));
    return write(cv, Uint8ClampedArray.from(f));
  },
  shiftChannels: (cv, p) => {
    const src = ['alpha', 'red', 'green', 'blue'].map((k) => String(p[k] ?? k)), d = read(cv).data;
    for (let i = 0; i < d.length; i += 4) {
      const [a, r, g, b] = src.map((c) => chanOf(d, i, c) * 255);
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    }
    return write(cv, d);
  },
  setChannels: (cv, p, x) => {
    // Set Channels: each channel from one channel of a layer (empty: this layer); centred or stretched
    const own = read(cv).data, fit = num(p.stretch, 1) ? 'stretch' : 'center';
    const srcs = [1, 2, 3, 4].map((k) => { const c = layerInput(p[`source${k}`], cv, x, fit); return c ? read(c).data : own; });
    const out = new Uint8ClampedArray(own.length);
    const keys = ['red', 'green', 'blue', 'alpha'];
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 4; c++) out[i + c] = chanOf(srcs[c], i, String(p[keys[c]] ?? keys[c])) * 255;
    return write(cv, out);
  },
  arithmetic: (cv, p) => {
    // Arithmetic: each colour channel combined with its value (0–255) by the operator; without clipping, results wrap
    const op = String(p.op ?? 'and'), k = [num(p.red), num(p.green), num(p.blue)].map((v) => Math.round(clamp(v, 0, 255))), clip = num(p.clip, 1) !== 0;
    const f = (a: number, b: number): number => {
      switch (op) {
        case 'and': return a & b;
        case 'or': return a | b;
        case 'xor': return a ^ b;
        case 'add': return a + b;
        case 'subtract': return a - b;
        case 'difference': return Math.abs(a - b);
        case 'min': return Math.min(a, b);
        case 'max': return Math.max(a, b);
        case 'blockAbove': return a > b ? 0 : a;
        case 'blockBelow': return a < b ? 0 : a;
        case 'slice': return a >= b ? 255 : 0;
        case 'multiply': return (a * b) / 255;
        default: return 255 - ((255 - a) * (255 - b)) / 255; // screen
      }
    };
    const L = [0, 1, 2].map((c) => Uint8ClampedArray.from({ length: 256 }, (_, v) => { const r = Math.round(f(v, k[c])); return clip ? r : ((r % 256) + 256) % 256; }));
    const d = read(cv).data;
    for (let i = 0; i < d.length; i += 4) { d[i] = L[0][d[i]]; d[i + 1] = L[1][d[i + 1]]; d[i + 2] = L[2][d[i + 2]]; }
    return write(cv, d);
  },
  solidComposite: (cv, p) => {
    // Solid Composite: the layer (at its source opacity) composited with the blending mode over a solid colour
    const out = mk(cv.width, cv.height), g = ctx2d(out);
    g.globalAlpha = clamp(num(p.opacity, 100) / 100);
    g.fillStyle = String(p.color ?? '#ffffff');
    g.fillRect(0, 0, out.width, out.height);
    g.globalAlpha = clamp(num(p.sourceOpacity, 100) / 100);
    const m = String(p.mode ?? 'normal');
    g.globalCompositeOperation = (m === 'normal' ? 'source-over' : m === 'add' ? 'lighter' : m.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) as GlobalCompositeOperation;
    g.drawImage(cv, 0, 0);
    return out;
  },
  linearColorKey: (cv, p) => {
    // Linear Color Key: distance to the key colour (RGB, hue or chroma) → 0 inside the tolerance, ramping to 1 over
    // the softness; Keep Colors inverts it (keeps only the matching colours)
    const k = rgb255(p.color ?? '#0000ff'), tol = num(p.tolerance, 10) / 100, soft = num(p.softness) / 100, keep = p.operation === 'keep', view = String(p.view ?? 'final'), match = String(p.match ?? 'rgb');
    const [kh, , ks] = hsl(k[0], k[1], k[2]);
    const d = read(cv).data;
    for (let i = 0; i < d.length; i += 4) {
      let dist: number;
      if (match === 'rgb') dist = Math.max(Math.abs(d[i] - k[0]), Math.abs(d[i + 1] - k[1]), Math.abs(d[i + 2] - k[2])) / 255;
      else {
        const [h, , s] = hsl(d[i], d[i + 1], d[i + 2]), dh = Math.min(Math.abs(h - kh), 1 - Math.abs(h - kh)) * 2;
        dist = match === 'hue' ? dh : Math.hypot(s * Math.cos(h * 2 * Math.PI) - ks * Math.cos(kh * 2 * Math.PI), s * Math.sin(h * 2 * Math.PI) - ks * Math.sin(kh * 2 * Math.PI)) / 2;
      }
      let m = dist <= tol ? 0 : soft > 0 ? clamp((dist - tol) / soft) : 1;
      if (keep) m = 1 - m;
      if (view === 'matte') { d[i] = d[i + 1] = d[i + 2] = m * d[i + 3]; d[i + 3] = 255; }
      else if (view === 'final') d[i + 3] *= m;
    }
    return write(cv, d);
  },
  extract: (cv, p) => {
    // Extract: keeps the pixels whose channel lies between the black and white points, with soft ramps outside
    const c = String(p.channel ?? 'luma'), bp = num(p.black), wp = num(p.white, 255), bs = num(p.blackSoft), ws = num(p.whiteSoft), inv = !!num(p.invert);
    const d = read(cv).data;
    for (let i = 0; i < d.length; i += 4) {
      const v = chanOf(d, i, c) * 255;
      let m = v < bp ? (bs > 0 ? clamp(1 - (bp - v) / bs) : 0) : v > wp ? (ws > 0 ? clamp(1 - (v - wp) / ws) : 0) : 1;
      if (inv) m = 1 - m;
      d[i + 3] *= m;
    }
    return write(cv, d);
  },
  differenceMatte: (cv, p, x) => {
    // Difference Matte: transparent where the layer matches the difference layer (a clean plate), within the tolerance
    // and ramped over the softness; both can be blurred first to ignore noise
    const other = layerInput(p.layer, cv, x, p.fit === 'stretch' ? 'stretch' : 'center');
    if (!other) return cv;
    const blur = num(p.blur) * x.res, tol = num(p.tolerance, 15) / 100, soft = num(p.softness) / 100, view = String(p.view ?? 'final');
    const d = read(cv).data, a = blur > 0 ? gaussBytes(cv, blur / 2) : d, b = blur > 0 ? gaussBytes(other, blur / 2) : read(other).data;
    for (let i = 0; i < d.length; i += 4) {
      const dist = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
      const m = dist <= tol ? 0 : soft > 0 ? clamp((dist - tol) / soft) : 1;
      if (view === 'matte') { d[i] = d[i + 1] = d[i + 2] = m * 255; d[i + 3] = 255; }
      else if (view === 'final') d[i + 3] *= m;
    }
    return write(cv, d);
  },
};
/** h, l, s in 0…1 of 0…255 RGB */
function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn;
  if (dd === 0) return [0, l, 0];
  const s = dd / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return [h / 6, l, s];
}
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 1) + 1) % 1) * 6, xx = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, xx, 0] : hp < 2 ? [xx, c, 0] : hp < 3 ? [0, c, xx] : hp < 4 ? [0, xx, c] : hp < 5 ? [xx, 0, c] : [c, 0, xx];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
/**
 * Noise HLS (and Auto): random hue, lightness and saturation offsets per pixel. Uniform, squared (fewer strong
 * values) or grain (cells of «grain size», smoothed). The phase picks the pattern and moves smoothly between two.
 */
function noiseHLS(cv: HTMLCanvasElement, p: Params, x: FxCtx, phase: number): HTMLCanvasElement {
  const amt = [num(p.hue), num(p.lightness), num(p.saturation)].map((v) => v / 100);
  if (amt.every((v) => v === 0)) return cv;
  const w = cv.width, h = cv.height, type = String(p.type ?? 'uniform'), g = type === 'grain' ? Math.max(1, num(p.grain, 1) * x.res) : 1;
  const ph = phase / 360, s0 = Math.floor(ph), fr = ph - s0;
  const gw = Math.ceil(w / g) + 2, gh = Math.ceil(h / g) + 2;
  const field = (ch: number) => {
    const f = new Float32Array(gw * gh), a = hash2(x.seed | 0, s0 * 3 + ch) | 0, b = hash2(x.seed | 0, (s0 + 1) * 3 + ch) | 0;
    for (let i = 0; i < f.length; i++) { let r = (rnd01(a, i) * (1 - fr) + rnd01(b, i) * fr) * 2 - 1; if (type === 'squared') r = Math.sign(r) * r * r; f[i] = r; }
    return f;
  };
  const F = [0, 1, 2].map(field);
  const at = (f: Float32Array, px: number, py: number) => {
    if (g <= 1) return f[py * gw + px];
    const fx = px / g, fy = py / g, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
    const q = (xx: number, yy: number) => f[yy * gw + xx];
    return (q(ix, iy) * (1 - u) + q(ix + 1, iy) * u) * (1 - v) + (q(ix, iy + 1) * (1 - u) + q(ix + 1, iy + 1) * u) * v;
  };
  const d = read(cv).data;
  for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0++) {
    const i = (y * w + x0) * 4, [hh, l, s] = hsl(d[i], d[i + 1], d[i + 2]);
    const [r, gg, b] = hsl2rgb(hh + at(F[0], x0, y) * amt[0] * 0.5, clamp(s + at(F[2], x0, y) * amt[2]), clamp(l + at(F[1], x0, y) * amt[1] * 0.5));
    d[i] = r; d[i + 1] = gg; d[i + 2] = b;
  }
  return write(cv, d);
}

// ───────────── round 2: channel ─────────────
const L3 = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c: number[]): number[] {
  const l = L3(c), n0 = Math.min(c[0], c[1], c[2]), x0 = Math.max(c[0], c[1], c[2]);
  if (n0 < 0) c = c.map((v) => l + ((v - l) * l) / (l - n0 || 1));
  if (x0 > 1) c = c.map((v) => l + ((v - l) * (1 - l)) / (x0 - l || 1));
  return c;
}
const setLum = (c: number[], l: number) => { const d = l - L3(c); return clipColor(c.map((v) => v + d)); };
const satOf = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: number[], s: number): number[] {
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
  return c.map((v) => (mx > mn ? ((v - mn) * s) / (mx - mn) : 0));
}
const burn = (b: number, s: number) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const dodge = (b: number, s: number) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
/** one colour channel of a separable blending mode: b the backdrop, s the source (0…1) */
function blendCh(m: string, b: number, s: number): number {
  switch (m) {
    case 'darken': return Math.min(b, s);
    case 'multiply': return b * s;
    case 'colorBurn': case 'classicColorBurn': return burn(b, s);
    case 'add': case 'alphaAdd': return Math.min(1, b + s);
    case 'lighten': return Math.max(b, s);
    case 'screen': return b + s - b * s;
    case 'colorDodge': case 'classicColorDodge': return dodge(b, s);
    case 'overlay': return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'softLight': return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
    case 'hardLight': return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'linearLight': return clamp(b + 2 * s - 1);
    case 'vividLight': return s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1);
    case 'pinLight': return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
    case 'difference': case 'classicDifference': return Math.abs(b - s);
    case 'exclusion': return b + s - 2 * b * s;
    default: return s;
  }
}
/**
 * Composites a straight source pixel over a straight backdrop pixel (0…1 colour, 0…1 alpha) with one of After
 * Effects' blending modes (the W3C formulas; stencil / silhouette modes cut the backdrop, Alpha Add adds coverage,
 * Luminescent Add adds premultiplied colour). Returns [r, g, b, a].
 */
function composite(m: string, cb: number[], ab: number, cs: number[], as: number): number[] {
  if (m === 'copy') return [...cs, as];
  if (m === 'stencilAlpha' || m === 'stencilLuma' || m === 'silhouetteAlpha' || m === 'silhouetteLuma') {
    const k = m.endsWith('Luma') ? L3(cs) * as : as;
    return [...cb, ab * (m.startsWith('stencil') ? k : 1 - k)];
  }
  if (m === 'luminescentAdd') {
    const a = Math.min(1, ab + as);
    return [0, 1, 2].map((i) => (a > 0 ? Math.min(1, (cb[i] * ab + cs[i] * as) / a) : 0)).concat(a);
  }
  let mixd: number[];
  if (m === 'hue') mixd = setLum(setSat(cs, satOf(cb)), L3(cb));
  else if (m === 'saturation') mixd = setLum(setSat(cb, satOf(cs)), L3(cb));
  else if (m === 'color') mixd = setLum(cs, L3(cb));
  else if (m === 'luminosity') mixd = setLum(cb, L3(cs));
  else mixd = [0, 1, 2].map((i) => blendCh(m, cb[i], cs[i]));
  const a = m === 'alphaAdd' ? Math.min(1, ab + as) : as + ab * (1 - as);
  if (a <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map((i) => ((1 - as) * ab * cb[i] + as * ((1 - ab) * cs[i] + ab * mixd[i])) / a).concat(a);
}
/** Calculations' channel view of a straight RGBA pixel: [r, g, b] 0…1 (alpha is kept) */
function calcChannel(d: Uint8ClampedArray, i: number, c: string, inv: boolean): number[] {
  const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
  const v = c === 'gray' ? lum(r, g, b) : c === 'red' ? r : c === 'green' ? g : c === 'blue' ? b : c === 'alpha' ? d[i + 3] / 255 : -1;
  const out = v < 0 ? [r, g, b] : [v, v, v];
  return inv ? out.map((q) => 1 - q) : out;
}
Object.assign(IMPL_DESENFOQUE, {
  blend: (cv, p, x) => {
    // Blend: the layer mixed with another one — crossfade, its colour (hue and saturation) only, the same only where the
    // layer already has colour (tint), or the darker / lighter of both per channel; then mixed back with the original
    const k = 1 - clamp(num(p.original, 100) / 100);
    const other = layerInput(p.layer, cv, x, p.fit === 'stretch' ? 'stretch' : 'center');
    if (!other || k <= 0) return cv;
    const d = read(cv).data, o = read(other).data, mode = String(p.mode ?? 'crossfade');
    for (let i = 0; i < d.length; i += 4) {
      const a0 = d[i + 3] / 255, a1 = o[i + 3] / 255;
      if (mode === 'crossfade') {
        const a = a0 + (a1 - a0) * k;
        for (let c = 0; c < 3; c++) d[i + c] = a > 0 ? (d[i + c] * a0 * (1 - k) + o[i + c] * a1 * k) / a : 0;
        d[i + 3] = a * 255;
        continue;
      }
      let res: number[];
      const cb = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255], cs = [o[i] / 255, o[i + 1] / 255, o[i + 2] / 255];
      if (mode === 'darkenOnly') res = cb.map((v, c) => Math.min(v, cs[c]));
      else if (mode === 'lightenOnly') res = cb.map((v, c) => Math.max(v, cs[c]));
      else {
        const [, l0, s0] = hsl(d[i], d[i + 1], d[i + 2]), [h1, , s1] = hsl(o[i], o[i + 1], o[i + 2]);
        res = mode === 'tintOnly' && s0 <= 0.001 ? cb : hsl2rgb(h1, s1, l0).map((v) => v / 255);
      }
      const w = k * a1;
      for (let c = 0; c < 3; c++) d[i + c] = (cb[c] + (res[c] - cb[c]) * w) * 255;
    }
    return write(cv, d);
  },
  calculations: (cv, p, x) => {
    // Calculations: one channel (or RGBA) of the layer, optionally inverted, with one channel of a second layer
    // composited over it by a blending mode at the second layer's opacity; Preserve Transparency keeps the layer's alpha
    const d = read(cv).data, ic = String(p.inChannel ?? 'rgba'), inv = !!num(p.inInvert);
    const other = layerInput(p.layer, cv, x, num(p.stretch, 1) ? 'stretch' : 'center'), op = clamp(num(p.layerOpacity) / 100);
    if (ic === 'rgba' && !inv && (!other || op <= 0)) return cv;
    const o = other ? read(other).data : null, oc = String(p.layerChannel ?? 'rgba'), oinv = !!num(p.layerInvert), mode = String(p.mode ?? 'normal'), keep = num(p.preserve, 1) !== 0;
    for (let i = 0; i < d.length; i += 4) {
      const cb = calcChannel(d, i, ic, inv), ab = d[i + 3] / 255;
      let out = [...cb, ab];
      if (o && op > 0) out = composite(mode, cb, ab, calcChannel(o, i, oc, oinv), (o[i + 3] / 255) * op);
      d[i] = out[0] * 255; d[i + 1] = out[1] * 255; d[i + 2] = out[2] * 255;
      d[i + 3] = (keep ? ab : out[3]) * 255;
    }
    return write(cv, d);
  },
  channelCombiner: (cv, p, x) => {
    // Channel Combiner: a value taken from this layer (or a second one) put into one channel, or a whole colour-space
    // conversion (HLS, YUV, premultiply); «… only» leaves the other channels empty
    const d = read(cv).data, other = num(p.use2nd) ? layerInput(p.layer, cv, x, 'stretch') : null, s = other ? read(other).data : d;
    const from = String(p.from ?? 'rgbToHls'), to = String(p.to ?? 'lightness'), inv = !!num(p.invert), solid = !!num(p.solidAlpha);
    for (let i = 0; i < d.length; i += 4) {
      const r = s[i] / 255, g = s[i + 1] / 255, b = s[i + 2] / 255, a = s[i + 3] / 255;
      let rgb: number[] | null = null;
      if (from === 'rgbToHls') { const [h, l, sa] = hsl(s[i], s[i + 1], s[i + 2]); rgb = [h, l, sa]; }
      else if (from === 'hlsToRgb') rgb = hsl2rgb(r, b, g).map((v) => v / 255);
      else if (from === 'rgbToYuv') rgb = [lum(r, g, b), -0.14713 * r - 0.28886 * g + 0.436 * b + 0.5, 0.615 * r - 0.51499 * g - 0.10001 * b + 0.5];
      else if (from === 'yuvToRgb') { const u = g - 0.5, v = b - 0.5; rgb = [r + 1.13983 * v, r - 0.39465 * u - 0.5806 * v, r + 2.03211 * u]; }
      else if (from === 'premultiply') rgb = [r * a, g * a, b * a];
      if (rgb) {
        for (let c = 0; c < 3; c++) d[i + c] = clamp(inv ? 1 - rgb[c] : rgb[c]) * 255;
        if (solid) d[i + 3] = 255;
        continue;
      }
      const [h, l, sa] = hsl(s[i], s[i + 1], s[i + 2]), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let v = from === 'red' ? r : from === 'green' ? g : from === 'blue' ? b : from === 'alpha' ? a : from === 'hue' ? h : from === 'lightness' ? l : from === 'luma' ? lum(r, g, b) : from === 'saturation' ? sa : from === 'satMul' ? sa * a : from === 'minRGB' ? mn : mx;
      if (inv) v = 1 - v;
      const V = v * 255;
      const only = to.endsWith('Only'), base = to.replace('Only', '');
      if (only) { d[i] = d[i + 1] = d[i + 2] = 0; }
      if (base === 'red' || base === 'green' || base === 'blue' || base === 'alpha') {
        const c = ['red', 'green', 'blue', 'alpha'].indexOf(base);
        d[i + c] = V;
        if (only && base !== 'alpha') d[i + 3] = 255;
        if (only && base === 'alpha') d[i] = d[i + 1] = d[i + 2] = 0;
      } else {
        let [h1, l1, s1] = only ? [0, 0.5, 1] : hsl(d[i], d[i + 1], d[i + 2]);
        if (only && base === 'lightness') s1 = 0;
        if (only && base === 'saturation') { l1 = 0.5; h1 = 0; }
        if (base === 'hue') h1 = v; else if (base === 'lightness') l1 = v; else s1 = v;
        const o = hsl2rgb(h1, s1, l1);
        d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
        if (only) d[i + 3] = 255;
      }
      if (solid) d[i + 3] = 255;
    }
    return write(cv, d);
  },
} as Record<string, FxFn>);

// ───────────── round 2: more channel, keying, grain and CycoreFX blurs ─────────────
/** a point parameter (layer pixels) in canvas pixels; without a value, the given fraction of the canvas */
function ptc(v: unknown, x: FxCtx, cv: HTMLCanvasElement, fx = 0.5, fy = 0.5): [number, number] {
  if (Array.isArray(v) && v.length >= 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1])) return [(+v[0] - (x.pox ?? 0) - x.ox) * x.res, (+v[1] - (x.poy ?? 0) - x.oy) * x.res];
  return [cv.width * fx, cv.height * fy];
}
/** separable erosion (max false) / dilation (max true) of a one-channel map over a (2r + 1) square; outside = edge */
function morph1(a: Float32Array, w: number, h: number, r: number, max: boolean): Float32Array {
  let f = a;
  for (const horiz of [true, false]) {
    const out = new Float32Array(f.length), len = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 1 : w;
    for (let l = 0; l < lines; l++) {
      const base = horiz ? l * w : l;
      for (let i = 0; i < len; i++) {
        let v = f[base + i * step];
        for (let k = Math.max(0, i - r), e = Math.min(len - 1, i + r); k <= e; k++) { const q = f[base + k * step]; if (max ? q > v : q < v) v = q; }
        out[base + i * step] = v;
      }
    }
    f = out;
  }
  return f;
}
/** levels of one 0…1 value (in / out points 0–255, gamma) */
const levels = (v: number, ib: number, iw: number, g: number, ob = 0, ow = 255) => {
  const t = clamp((v * 255 - ib) / Math.max(1e-3, iw - ib));
  return (ob + Math.pow(t, 1 / Math.max(0.01, g)) * (ow - ob)) / 255;
};
/** bilinear straight RGBA sample (edges clamped, or transparent outside with clear) into o[0…3] */
function sample(d: Uint8ClampedArray, w: number, h: number, fx: number, fy: number, o: number[], clear = false) {
  if (clear && (fx < -0.5 || fy < -0.5 || fx > w - 0.5 || fy > h - 0.5)) { o[0] = o[1] = o[2] = o[3] = 0; return; }
  fx =Math.max(0, Math.min(w - 1, fx)); fy = Math.max(0, Math.min(h - 1, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), u = fx - x0, v = fy - y0;
  for (let c = 0; c < 4; c++) {
    const a = d[(y0 * w + x0) * 4 + c], b = d[(y0 * w + x1) * 4 + c], e = d[(y1 * w + x0) * 4 + c], f = d[(y1 * w + x1) * 4 + c];
    o[c] = (a * (1 - u) + b * u) * (1 - v) + (e * (1 - u) + f * u) * v;
  }
}
/** the preview box of Add / Remove Grain in canvas pixels: [x0, y0, x1, y1] */
function grainBox(p: Params, x: FxCtx, cv: HTMLCanvasElement): number[] {
  const [cx, cy] = ptc(p.boxCenter, x, cv), w = num(p.boxW, 200) * x.res, h = num(p.boxH, 200) * x.res;
  return [Math.round(cx - w / 2), Math.round(cy - h / 2), Math.round(cx + w / 2), Math.round(cy + h / 2)];
}
/** Preview mode: the processed pixels only inside the box (outlined when Show Box is on) */
function previewBox(cv: HTMLCanvasElement, done: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const [x0, y0, x1, y1] = grainBox(p, x, cv), out = mk(cv.width, cv.height), g = ctx2d(out);
  g.drawImage(cv, 0, 0);
  g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip(); g.clearRect(x0, y0, x1 - x0, y1 - y0); g.drawImage(done, 0, 0); g.restore();
  if (num(p.showBox, 1)) { g.strokeStyle = String(p.boxColor ?? '#ffffff'); g.lineWidth = Math.max(1, x.res); g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1); }
  return out;
}
/** sRGB 0…255 → CIE L*a*b* scaled to 0…255 (L × 2.55, a and b + 128), as Color Range compares them */
function lab255(r: number, g: number, b: number): number[] {
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [(116 * Y - 16) * 2.55, 500 * (X - Y) + 128, 200 * (Y - Z) + 128];
}
/** smooth value noise field of cell size s (≥ 1 px, aspect stretches it horizontally), −1…1, for a seed */
function noiseField(w: number, h: number, s: number, aspect: number, seed: number): Float32Array {
  const f = new Float32Array(w * h), sx = Math.max(1, s * aspect), sy = Math.max(1, s);
  const gw = Math.ceil(w / sx) + 2;
  const at = (i: number, j: number) => {
    // sum of 3 uniforms ≈ Gaussian grain
    const k = j * gw + i;
    return (rnd01(seed, k * 3) + rnd01(seed, k * 3 + 1) + rnd01(seed, k * 3 + 2) - 1.5) / 0.866;
  };
  for (let y = 0; y < h; y++) {
    const fy = y / sy, j = Math.floor(fy), v = fy - j;
    for (let x0 = 0; x0 < w; x0++) {
      const fx = x0 / sx, i = Math.floor(fx), u = fx - i;
      f[y * w + x0] = sx <= 1 && sy <= 1 ? at(i, j) : (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
    }
  }
  return f;
}
/** edge-preserving smoothing of straight RGBA bytes (one bilateral pass of radius r; range σ in levels) */
function bilateralPass(d: Uint8ClampedArray, w: number, h: number, r: number, sr: number, chans: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(d), k2 = 1 / (2 * sr * sr), ks = 1 / (2 * Math.max(0.5, r / 2) ** 2);
  for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0++) {
    const i = (y * w + x0) * 4;
    for (const c of chans) {
      const v0 = d[i + c];
      let s = 0, sw = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x0 + dx;
          if (xx < 0 || xx >= w) continue;
          const v = d[(yy * w + xx) * 4 + c], dv = v - v0, wt = Math.exp(-(dx * dx + dy * dy) * ks - dv * dv * k2);
          s += v * wt; sw += wt;
        }
      }
      out[i + c] = s / sw;
    }
  }
  return out;
}
Object.assign(IMPL_DESENFOQUE, {
  compoundArithmetic: (cv, p, x) => {
    // Compound Arithmetic: each pixel of the layer combined with the same pixel of the second source by the operator,
    // on RGB, ARGB or alpha only; overflow clips, wraps or scales the result
    const other = layerInput(p.layer, cv, x, num(p.stretch, 1) ? 'stretch' : 'center');
    if (!other) return cv;
    const d = read(cv).data, o = read(other).data, op = String(p.op ?? 'copy'), over = String(p.overflow ?? 'clip'), k = 1 - clamp(num(p.original) / 100);
    const chans = p.channels === 'argb' ? [0, 1, 2, 3] : p.channels === 'alpha' ? [3] : [0, 1, 2];
    const f = (a: number, b: number): number => {
      switch (op) {
        case 'add': return a + b;
        case 'subtract': return a - b;
        case 'multiply': return (a * b) / 255;
        case 'difference': return Math.abs(a - b);
        case 'and': return a & b;
        case 'or': return a | b;
        case 'xor': return a ^ b;
        case 'lighter': return lum(a, a, a) >= lum(b, b, b) ? a : b;
        case 'darker': return a <= b ? a : b;
        case 'min': return Math.min(a, b);
        case 'max': return Math.max(a, b);
        case 'screen': return 255 - ((255 - a) * (255 - b)) / 255;
        case 'overlay': return a < 128 ? (2 * a * b) / 255 : 255 - (2 * (255 - a) * (255 - b)) / 255;
        case 'hardLight': return b < 128 ? (2 * a * b) / 255 : 255 - (2 * (255 - a) * (255 - b)) / 255;
        default: return b; // copy
      }
    };
    const fix = (v: number) => (over === 'wrap' ? ((Math.round(v) % 256) + 256) % 256 : over === 'scale' ? (op === 'add' ? v / 2 : op === 'subtract' ? (v + 255) / 2 : clamp(v, 0, 255)) : clamp(v, 0, 255));
    for (let i = 0; i < d.length; i += 4) {
      // «Lighter» compares whole pixels by luminance
      const lighter = op === 'lighter' ? (lum(d[i], d[i + 1], d[i + 2]) >= lum(o[i], o[i + 1], o[i + 2]) ? 0 : 1) : -1;
      for (const c of chans) {
        const v = lighter >= 0 ? (lighter ? o[i + c] : d[i + c]) : fix(f(d[i + c], o[i + c]));
        d[i + c] = d[i + c] + (v - d[i + c]) * k;
      }
    }
    return write(cv, d);
  },
  alphaLevels: (cv, p) => {
    const ib = num(p.inBlack), iw = num(p.inWhite, 255), g = num(p.gamma, 1), ob = num(p.outBlack), ow = num(p.outWhite, 255);
    if (ib === 0 && iw === 255 && g === 1 && ob === 0 && ow === 255) return cv;
    const L = Uint8ClampedArray.from({ length: 256 }, (_, v) => levels(v / 255, ib, iw, g, ob, ow) * 255), d = read(cv).data;
    for (let i = 3; i < d.length; i += 4) d[i] = L[d[i]];
    return write(cv, d);
  },
  colorDifferenceKey: (cv, p) => {
    // Color Difference Key: partial matte A is transparent where the pixel is close to the key colour, partial B where
    // it is close to the key colour's opposite hue measure (the key channel's excess over the other two); each through
    // its own levels, then combined (the larger opacity wins) and through the matte levels. More Accurate compares
    // full colour distance instead of the faster chroma estimate.
    const k = rgb255(p.color ?? '#0000ff'), [kh, , ks] = hsl(k[0], k[1], k[2]), acc = p.accuracy === 'accurate', view = String(p.view ?? 'final');
    const kc = k.indexOf(Math.max(...k)), o1 = (kc + 1) % 3, o2 = (kc + 2) % 3, kEx = Math.max(1, k[kc] - Math.max(k[o1], k[o2]));
    const lv = (v: number, pre: string) => levels(v, num(p[pre + 'InBlack']), num(p[pre + 'InWhite'], 255), num(p[pre + 'Gamma'], 1), num(p[pre + 'OutBlack']), num(p[pre + 'OutWhite'], 255));
    const d = read(cv).data;
    for (let i = 0; i < d.length; i += 4) {
      let a: number;
      if (acc) a = Math.hypot(d[i] - k[0], d[i + 1] - k[1], d[i + 2] - k[2]) / 441.7;
      else { const [h, , s] = hsl(d[i], d[i + 1], d[i + 2]), dh = Math.min(Math.abs(h - kh), 1 - Math.abs(h - kh)) * 2; a = clamp(Math.max(dh, Math.abs(s - ks))); }
      const b = clamp(1 - Math.max(0, d[i + kc] - Math.max(d[i + o1], d[i + o2])) / kEx);
      const ac = lv(a, 'a'), bc = lv(b, 'b'), mu = Math.max(a, b), mc = levels(Math.max(ac, bc), num(p.mInBlack), num(p.mInWhite, 255), num(p.mGamma, 1));
      const show = view === 'aUncorrected' ? a : view === 'aCorrected' ? ac : view === 'bUncorrected' ? b : view === 'bCorrected' ? bc : view === 'matteUncorrected' ? mu : view === 'matteCorrected' ? mc : -1;
      if (view === 'source') continue;
      if (show >= 0) { d[i] = d[i + 1] = d[i + 2] = show * 255; d[i + 3] = 255; } else d[i + 3] *= mc;
    }
    return write(cv, d);
  },
  colorRange: (cv, p) => {
    // Color Range: keys out the colours inside the min–max box of each component of Lab, YUV or RGB (0–255),
    // softened by the fuzziness on every side
    const sp = String(p.space ?? 'lab'), fz = num(p.fuzziness, 20);
    const lo = [num(p.min1, 127), num(p.min2, 127), num(p.min3, 127)], hi = [num(p.max1, 127), num(p.max2, 127), num(p.max3, 127)];
    const d = read(cv).data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const c = sp === 'rgb' ? [r, g, b] : sp === 'yuv' ? [lum(r, g, b), -0.14713 * r - 0.28886 * g + 0.436 * b + 128, 0.615 * r - 0.51499 * g - 0.10001 * b + 128] : lab255(r, g, b);
      let inside = 1;
      for (let k = 0; k < 3; k++) {
        const out = c[k] < lo[k] ? lo[k] - c[k] : c[k] > hi[k] ? c[k] - hi[k] : 0;
        inside = Math.min(inside, out <= 0 ? 1 : fz > 0 ? clamp(1 - out / fz) : 0);
      }
      d[i + 3] *= 1 - inside;
    }
    return write(cv, d);
  },
  spillSuppression: (cv, p) => {
    // Spill Suppressor: the channel of the colour to suppress may not exceed the larger of the other two; suppression
    // 100 removes the excess, 200 twice as much
    const k = rgb255(p.color ?? '#0000ff'), kc = k.indexOf(Math.max(...k)), o1 = (kc + 1) % 3, o2 = (kc + 2) % 3, s = num(p.suppression, 100) / 100;
    if (s <= 0) return cv;
    const d = read(cv).data;
    for (let i = 0; i < d.length; i += 4) { const lim = Math.max(d[i + o1], d[i + o2]), ex = d[i + kc] - lim; if (ex > 0) d[i + kc] -= ex * s; }
    return write(cv, d);
  },
  addGrain: (cv, p, x) => {
    // Add Grain: per-channel Gaussian grain of «size» (× channel size, stretched by the aspect ratio), softened, at
    // «intensity» (× channel intensity), coloured by saturation / monochrome / tint, applied by the blending mode with a
    // tonal response (shadows, midtones, highlights around the midpoint). Preview shows it inside the box only; Blending
    // Matte shows the tonal response. A new grain pattern every frame (speed), cross-faded when smooth.
    const w = cv.width, h = cv.height, view = String(p.view ?? 'preview'), d = read(cv).data;
    const amp = num(p.intensity, 1) * 0.1, size = num(p.size, 1) * x.res, soft = num(p.softness, 1), aspect = Math.max(0.01, num(p.aspect, 1));
    const ci = [num(p.rInt, 1), num(p.gInt, 1), num(p.bInt, 1)], cs = [num(p.rSize, 1), num(p.gSize, 1), num(p.bSize, 1)];
    const ph = x.t * x.fps * num(p.speed, 1), f0 = Math.floor(ph), fr = num(p.smooth) ? ph - f0 : 0, seed0 = Math.round(num(p.seed));
    const mono = !!num(p.mono), sat = num(p.saturation, 1), tint = rgb255(p.tint ?? '#ffffff').map((v) => v / 255), ta = clamp(num(p.tintAmount, 100) / 100);
    const field = (c: number) => {
      const s = Math.max(1, size * cs[c]), sd = hash2(seed0 * 7919 + c, f0) | 0;
      let f = noiseField(w, h, s, aspect, sd);
      if (fr > 0) { const g2 = noiseField(w, h, s, aspect, hash2(seed0 * 7919 + c, f0 + 1) | 0); for (let i = 0; i < f.length; i++) f[i] = f[i] * (1 - fr) + g2[i] * fr; }
      const sig = (soft * s) / 3;
      if (sig >= 0.3) { f = gauss(f, w, h, 1, sig, 'both', true); const k = 1 + sig * 0.6; for (let i = 0; i < f.length; i++) f[i] *= k; }
      return f;
    };
    const F = mono ? [field(0)] : [field(0), field(1), field(2)];
    const sh = num(p.shadows, 1), md = num(p.midtones, 1), hl = num(p.highlights, 1), mp = clamp(num(p.midpoint, 0.5), 0.01, 0.99), mode = String(p.mode ?? 'film');
    const k = 1 - clamp(num(p.original) / 100);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const L = lum(d[i], d[i + 1], d[i + 2]) / 255;
      // tonal response: shadows → midtones at the midpoint → highlights
      const resp = L < mp ? sh + (md - sh) * (L / mp) : md + (hl - md) * ((L - mp) / (1 - mp));
      if (view === 'matte') { d[i] = d[i + 1] = d[i + 2] = clamp(resp / 2) * 255; continue; }
      let n = [0, 1, 2].map((c) => (mono ? F[0][j] : F[c][j]) * ci[c]);
      const m = (n[0] + n[1] + n[2]) / 3;
      n = n.map((v, c) => (m + (v - m) * sat) * (1 - ta + ta * tint[c]));
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] / 255, g = n[c] * amp * resp;
        let r: number;
        if (mode === 'multiply') r = v * (1 + g);
        else if (mode === 'add') r = v + Math.max(0, g);
        else if (mode === 'screen') r = 1 - (1 - v) * (1 - Math.max(0, g));
        else if (mode === 'overlay') r = v + g * 2 * Math.min(v, 1 - v);
        else r = v + g * Math.sqrt(Math.max(0, v * (1 - v))) * 2; // film: strongest in the midtones, like emulsion
        d[i + c] = (v + (clamp(r) - v) * k) * 255;
      }
    }
    const done = write(cv, d);
    return view === 'preview' ? previewBox(cv, done, p, x) : done;
  },
  removeGrain: (cv, p, x) => {
    // Remove Grain (own version with After Effects' parameters): passes of edge-preserving smoothing whose strength is
    // the noise reduction (range σ grows with it; the size bias widens / narrows the radius), chroma suppression
    // smooths the colour more than the luminance, texture keeps part of the fine detail, clean solid areas smooths flat
    // regions more, then an unsharp mask and the blend with the original. Preview shows it inside the box only.
    const w = cv.width, h = cv.height, view = String(p.view ?? 'preview'), src = read(cv).data;
    const nr = num(p.reduction, 1), passes = Math.round(clamp(num(p.passes, 3), 1, 6)), r = Math.max(1, Math.round((1 + num(p.sizeBias)) * 1.5 * x.res));
    let d: Uint8ClampedArray = new Uint8ClampedArray(src);
    if (nr > 0) {
      const single = p.mode === 'single', sr = 6 + nr * 10 + num(p.cleanSolid) * 20;
      for (let k = 0; k < passes; k++) {
        if (single) {
          // the luminance drives the weights for all channels: smooth it, shift the colour by the same amount
          const sm = bilateralPass(d, w, h, r, sr, [0, 1, 2]);
          for (let i = 0; i < d.length; i += 4) { const dl = lum(sm[i], sm[i + 1], sm[i + 2]) - lum(d[i], d[i + 1], d[i + 2]); for (let c = 0; c < 3; c++) d[i + c] += dl; }
        } else d = bilateralPass(d, w, h, r, sr, [0, 1, 2]);
      }
      // chroma suppression: the colour difference from the luminance smoothed further
      const cs = num(p.chroma, 1);
      if (cs > 0) {
        const cr = new Float32Array(w * h * 3);
        for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { const l = lum(d[i], d[i + 1], d[i + 2]); cr[j] = d[i] - l; cr[j + 1] = d[i + 1] - l; cr[j + 2] = d[i + 2] - l; }
        const bl = gauss(cr, w, h, 3, cs * x.res, 'both', true);
        for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { const l = lum(d[i], d[i + 1], d[i + 2]); for (let c = 0; c < 3; c++) d[i + c] = l + bl[j + c]; }
      }
      const tx = clamp(num(p.texture, 0.1));
      if (tx > 0) for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] += (src[i + c] - d[i + c]) * tx;
    }
    const ua = num(p.usmAmount), ur = num(p.usmRadius, 1) * x.res, ut = num(p.usmThreshold) * 255;
    if (ua > 0 && ur >= 0.2) {
      const tmp = write(cv, d), b = gaussBytes(tmp, ur);
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const df = d[i + c] - b[i + c]; if (Math.abs(df) > ut) d[i + c] += ua * df; }
    }
    const k = clamp(num(p.original) / 100);
    if (k > 0) for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] += (src[i + c] - d[i + c]) * k;
    if (view === 'samples' || view === 'matte') {
      // what was taken away (noise samples), amplified around mid grey; the blending matte is all white (no mask)
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = view === 'matte' ? 255 : 128 + (src[i + c] - d[i + c]) * 4;
    }
    const done = write(cv, d);
    return view === 'preview' ? previewBox(cv, done, p, x) : done;
  },
  ccCrossBlur: (cv, p, x) => {
    // CC Cross Blur: a horizontal blur of radius X and a vertical one of radius Y composited by the transfer mode
    const rx = num(p.radiusX) * x.res, ry = num(p.radiusY) * x.res;
    if (rx <= 0 && ry <= 0) return cv;
    const w = cv.width, h = cv.height, rep = num(p.repeat, 1) !== 0, f = premul(read(cv).data);
    const H = unpremul(gauss(f, w, h, 4, rx / 2, 'h', rep)), V = unpremul(gauss(f, w, h, 4, ry / 2, 'v', rep)), mode = String(p.mode ?? 'blend');
    const d = new Uint8ClampedArray(H.length);
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const a = H[i + c] / 255, b = V[i + c] / 255;
        const v = mode === 'add' ? a + b : mode === 'screen' ? a + b - a * b : mode === 'multiply' ? a * b : mode === 'lighten' ? Math.max(a, b) : mode === 'darken' ? Math.min(a, b) : (a + b) / 2;
        d[i + c] = v * 255;
      }
      d[i + 3] = mode === 'blend' ? (H[i + 3] + V[i + 3]) / 2 : mode === 'darken' || mode === 'multiply' ? Math.min(H[i + 3], V[i + 3]) : Math.max(H[i + 3], V[i + 3]);
    }
    return write(cv, d);
  },
  ccRadialBlur: (cv, p, x) => {
    // CC Radial Blur: zooms (straight towards the centre, fading with distance, or both ways) or rotations (both ways,
    // fading, or Scratch: only the brightest sample along the arc) of «amount»; quality sets the number of samples
    const amt = num(p.amount);
    if (amt === 0) return cv;
    const w = cv.width, h = cv.height, [cx, cy] = ptc(p.center, x, cv), type = String(p.type ?? 'scratch'), d = read(cv).data, out = new Uint8ClampedArray(d.length);
    const ns = Math.max(4, Math.round(num(p.quality, 50) / 2)), rot = type.startsWith('rotate') || type === 'scratch', fade = type === 'fadingZoom' || type === 'rotateFading';
    const s = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0++) {
      const dx = x0 - cx, dy = y - cy, o = (y * w + x0) * 4;
      let acc0 = 0, acc1 = 0, acc2 = 0, acc3 = 0, ws = 0, best = -1;
      for (let k = 0; k < ns; k++) {
        const t = ns > 1 ? k / (ns - 1) : 0, u = type === 'centeredZoom' || rot && type !== 'scratch' ? t - 0.5 : t;
        let sx: number, sy: number;
        if (rot) { const an = (u * amt * Math.PI) / 180, c = Math.cos(an), sn = Math.sin(an); sx = cx + dx * c - dy * sn; sy = cy + dx * sn + dy * c; }
        else { const z = 1 - u * (amt / 100); sx = cx + dx * z; sy = cy + dy * z; }
        sample(d, w, h, sx, sy, s, true);
        if (type === 'scratch') { const L = lum(s[0], s[1], s[2]) * s[3]; if (L > best) { best = L; acc0 = s[0]; acc1 = s[1]; acc2 = s[2]; acc3 = s[3]; ws = 1; } continue; }
        const wt = fade ? 1 - t * 0.9 : 1, a = s[3] * wt;
        acc0 += s[0] * a; acc1 += s[1] * a; acc2 += s[2] * a; acc3 += a; ws += wt;
      }
      if (type === 'scratch') { out[o] = acc0; out[o + 1] = acc1; out[o + 2] = acc2; out[o + 3] = acc3; continue; }
      out[o] = acc3 ? acc0 / acc3 : 0; out[o + 1] = acc3 ? acc1 / acc3 : 0; out[o + 2] = acc3 ? acc2 / acc3 : 0; out[o + 3] = acc3 / ws;
    }
    return write(cv, out);
  },
  ccRadialFastBlur: (cv, p, x) => {
    // CC Radial Fast Blur: a zoom streak towards the centre of «amount» (100 ≈ all the way); Brightest / Darkest keep the
    // lightest / darkest sample along the streak instead of the mean
    const amt = clamp(num(p.amount, 50) / 100);
    if (amt <= 0) return cv;
    const w = cv.width, h = cv.height, [cx, cy] = ptc(p.center, x, cv), zoom = String(p.zoom ?? 'standard'), d = read(cv).data, out = new Uint8ClampedArray(d.length);
    const ns = Math.max(8, Math.min(64, Math.round(amt * 48))), s = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0++) {
      const dx = x0 - cx, dy = y - cy, o = (y * w + x0) * 4;
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, best = zoom === 'darkest' ? Infinity : -1;
      for (let k = 0; k < ns; k++) {
        const z = 1 - (k / ns) * amt * 0.5;
        sample(d, w, h, cx + dx * z, cy + dy * z, s, true);
        if (zoom === 'standard') { a0 += s[0] * s[3]; a1 += s[1] * s[3]; a2 += s[2] * s[3]; a3 += s[3]; continue; }
        const L = lum(s[0], s[1], s[2]) * (s[3] / 255) + (zoom === 'darkest' ? (255 - s[3]) : 0);
        if (zoom === 'darkest' ? L < best : L > best) { best = L; a0 = s[0]; a1 = s[1]; a2 = s[2]; a3 = s[3]; }
      }
      if (zoom === 'standard') { out[o] = a3 ? a0 / a3 : 0; out[o + 1] = a3 ? a1 / a3 : 0; out[o + 2] = a3 ? a2 / a3 : 0; out[o + 3] = a3 / ns; }
      else { out[o] = a0; out[o + 1] = a1; out[o + 2] = a2; out[o + 3] = a3; }
    }
    return write(cv, out);
  },
  ccVectorBlur: (cv, p, x) => {
    // CC Vector Blur: a blur along a vector field made from a property of the map layer (or this one), softened by the
    // map softness: Natural follows the slope of the map (longer where it is steeper, smoothed by the ridge
    // smoothness), Constant Length the same with a fixed length, Perpendicular across the slope, Direction Center /
    // Fading take the property itself as an angle (Fading weighting the near samples more); the angle offset rotates it
    const amt = num(p.amount) * x.res;
    if (amt === 0) return cv;
    const w = cv.width, h = cv.height, mapCv = layerInput(p.map, cv, x, 'stretch') ?? cv, m = read(mapCv).data, prop = String(p.property ?? 'lightness'), type = String(p.type ?? 'natural');
    let f: Float32Array = new Float32Array(w * h);
    for (let i = 0; i < f.length; i++) f[i] = chanOf(m, i * 4, prop === 'luma' ? 'luma' : prop);
    const sm = num(p.softness, 15) * x.res;
    if (sm >= 0.3) f = gauss(f, w, h, 1, sm / 2, 'both', true);
    const off = (num(p.angle) * Math.PI) / 180, ridge = Math.max(0.001, num(p.ridge, 1)) / 100, d = read(cv).data, out = new Uint8ClampedArray(d.length), s = [0, 0, 0, 0];
    const ns = Math.max(4, Math.min(48, Math.ceil(Math.abs(amt) / 2)));
    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0++) {
      const i = y * w + x0, o = i * 4;
      let vx: number, vy: number, len: number;
      if (type === 'directionCenter' || type === 'directionFading') { const an = f[i] * Math.PI * 2; vx = Math.cos(an); vy = Math.sin(an); len = 1; }
      else {
        const gx = f[y * w + Math.min(w - 1, x0 + 1)] - f[y * w + Math.max(0, x0 - 1)], gy = f[Math.min(h - 1, y + 1) * w + x0] - f[Math.max(0, y - 1) * w + x0];
        const mag = Math.hypot(gx, gy);
        if (mag < 1e-6) { out.set(d.subarray(o, o + 4), o); continue; }
        vx = gx / mag; vy = gy / mag;
        if (type === 'perpendicular') [vx, vy] = [-vy, vx];
        len = type === 'constant' ? 1 : clamp(mag / (mag + ridge) * 4) ;
      }
      const c = Math.cos(off), sn = Math.sin(off), ux = vx * c - vy * sn, uy = vx * sn + vy * c, L = amt * len;
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, ws = 0;
      for (let k = 0; k < ns; k++) {
        const t = type === 'directionCenter' || type === 'directionFading' ? k / ns : k / ns - 0.5, wt = type === 'directionFading' ? 1 - k / ns : 1;
        sample(d, w, h, x0 + ux * L * t, y + uy * L * t, s, true);
        const a = s[3] * wt;
        a0 += s[0] * a; a1 += s[1] * a; a2 += s[2] * a; a3 += a; ws += wt;
      }
      out[o] = a3 ? a0 / a3 : 0; out[o + 1] = a3 ? a1 / a3 : 0; out[o + 2] = a3 ? a2 / a3 : 0; out[o + 3] = a3 / ws;
    }
    return write(cv, out);
  },
  ccSimpleWireRemoval: (cv, p, x) => {
    // CC Simple Wire Removal: along the line A–B, a band of «thickness» is rebuilt from the pixels beside it — Fade
    // interpolates across the band, Displace copies from both sides (mirror blend mixes in the mirrored side),
    // Displace Horizontal copies from the left / right; slope is the soft part of the band's edge. Frame Offset needs
    // other frames of the layer, which an effect here cannot read: it falls back to Displace.
    const th = num(p.thickness, 2) * x.res;
    if (th <= 0) return cv;
    const w = cv.width, h = cv.height, [ax, ay] = ptc(p.a, x, cv, 0.5, 0.75), [bx, by] = ptc(p.b, x, cv, 0.5, 0.25);
    const lx = bx - ax, ly0 = by - ay, L = Math.hypot(lx, ly0);
    if (L < 1e-3) return cv;
    const ux = lx / L, uy = ly0 / L, nx = -uy, ny = ux, style = String(p.style ?? 'displace'), slope = clamp(num(p.slope, 50) / 100), mir = clamp(num(p.mirror, 25) / 100);
    const d = read(cv).data, out = new Uint8ClampedArray(d), half = th / 2, edge = half * (1 + slope), s1 = [0, 0, 0, 0], s2 = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0++) {
      const rx = x0 - ax, ry = y - ay, along = rx * ux + ry * uy, dist = rx * nx + ry * ny, ad = Math.abs(dist);
      if (along < 0 || along > L || ad > edge) continue;
      const wgt = ad <= half ? 1 : 1 - (ad - half) / Math.max(1e-3, edge - half), o = (y * w + x0) * 4;
      let res: number[];
      if (style === 'fade') {
        // linear interpolation between the two sides of the band
        sample(d, w, h, x0 + nx * (edge + 1 - dist), y + ny * (edge + 1 - dist), s1, true);
        sample(d, w, h, x0 - nx * (edge + 1 + dist), y - ny * (edge + 1 + dist), s2, true);
        const t = clamp((dist + edge + 1) / (2 * edge + 2));
        res = s1.map((v, c) => s2[c] + (v - s2[c]) * t);
      } else {
        const hx = style === 'displaceH' ? (Math.abs(nx) > 1e-3 ? Math.sign(nx) : 1) : nx, hy = style === 'displaceH' ? 0 : ny, step = edge + 1;
        // the pixel just beyond the band on its own side, and the mirrored one from the far side
        const sg = dist >= 0 ? 1 : -1;
        sample(d, w, h, x0 + hx * sg * (step - ad), y + hy * sg * (step - ad), s1, true);
        sample(d, w, h, x0 - hx * sg * (step + ad), y - hy * sg * (step + ad), s2, true);
        res = s1.map((v, c) => v + (s2[c] - v) * mir);
      }
      for (let c = 0; c < 4; c++) out[o + c] = d[o + c] + (res[c] - d[o + c]) * wgt;
    }
    return write(cv, out);
  },
  innerOuterKey: (cv, p, x) => {
    // Inner/Outer Key: inside the foreground mask is kept, outside the background mask removed; in between each pixel
    // gets the opacity of how much closer its colour is to the foreground colours (sampled just inside the foreground
    // mask) than to the background ones (just outside the background mask). With one mask, a band of the highlight
    // radius around it is the in-between zone. Then edge thin, feather and threshold, invert, blend with original.
    const ms = x.masks ?? [], find = (nm: unknown) => { const s = String(nm ?? ''); return s ? ms.find((m) => m.name === s || m.id === s || m.name.toLowerCase() === s.toLowerCase()) : undefined; };
    const fgM = find(p.fg) ?? (!p.fg && !p.bg ? ms[0] : undefined), bgM = find(p.bg);
    if (!fgM && !bgM) return cv;
    const w = cv.width, h = cv.height;
    const cover = (m: (typeof ms)[number]) => {
      const c = mk(w, h), g = ctx2d(c, true), path = new Path2D();
      for (let i = 0; i + 1 < m.pts.length; i += 2) { const px0 = (m.pts[i] - x.ox) * x.res, py0 = (m.pts[i + 1] - x.oy) * x.res; if (i) path.lineTo(px0, py0); else path.moveTo(px0, py0); }
      path.closePath(); g.fillStyle = '#fff'; g.fill(path);
      const d = g.getImageData(0, 0, w, h).data, a = new Float32Array(w * h);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
      return m.inverted ? a.map((v) => 1 - v) : a;
    };
    const R = Math.max(1, Math.round(num(p.radius, 5) * x.res));
    let fg: Float32Array, bg: Float32Array; // 1 = surely foreground / surely background
    if (fgM && bgM) { fg = cover(fgM); bg = cover(bgM).map((v) => 1 - v); }
    else { const c = cover((fgM ?? bgM)!); fg = morph1(c, w, h, R, false); bg = morph1(c, w, h, R, true).map((v) => 1 - v); }
    const d = read(cv).data;
    // mean colours of the band just inside the foreground and just outside the background
    const mean = (sure: Float32Array) => {
      const core = morph1(sure, w, h, 3, false), s = [0, 0, 0];
      let n0 = 0;
      for (let i = 0; i < sure.length; i++) if (sure[i] > 0.5 && core[i] < 0.5 && d[i * 4 + 3] > 0) { for (let c = 0; c < 3; c++) s[c] += d[i * 4 + c]; n0++; }
      return n0 ? s.map((v) => v / n0) : null;
    };
    const fc = mean(fg) ?? [255, 255, 255], bc = mean(bg) ?? [0, 0, 0];
    let a: Float32Array = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) {
      if (fg[i] >= 0.999) { a[i] = 1; continue; }
      if (bg[i] >= 0.999) { a[i] = 0; continue; }
      const j = i * 4, df = Math.hypot(d[j] - fc[0], d[j + 1] - fc[1], d[j + 2] - fc[2]), db = Math.hypot(d[j] - bc[0], d[j + 1] - bc[1], d[j + 2] - bc[2]);
      const k = df + db > 0 ? db / (df + db) : 0.5;
      a[i] = Math.max(fg[i], Math.min(1 - bg[i], k));
    }
    const thin = Math.round(num(p.thin) * x.res);
    if (thin) a = morph1(a, w, h, Math.abs(thin), thin < 0);
    const fe = num(p.feather) * x.res;
    if (fe > 0.3) a = gauss(a, w, h, 1, fe / 2, 'both', true);
    const th = clamp(num(p.threshold) / 100), inv = !!num(p.invert), mix = clamp(num(p.original) / 100);
    for (let i = 0; i < a.length; i++) {
      let v = a[i] < th ? 0 : a[i];
      if (inv) v = 1 - v;
      d[i * 4 + 3] *= v + (1 - v) * mix;
    }
    return write(cv, d);
  },
} as Record<string, FxFn>);
export type { Params };

// ───────────────────────── Match Grain ─────────────────────────
/** The grain of an image measured in its flattest boxes: per channel the deviation (0…255) left after taking each
 *  box's plane out, the correlation of neighbouring pixels of that residual (how big the grain is) and how much the
 *  three channels' grain moves together (1 = monochromatic). */
export interface GrainStats { sd: number[]; rho: number[]; corr: number; boxes: number[][] }
export function measureGrain(d: Uint8ClampedArray, w: number, h: number, count: number, size: number): GrainStats | null {
  const S = Math.max(4, Math.min(Math.round(size), w, h)), step = Math.max(2, S >> 1), q = Math.max(1, S >> 2);
  // candidate boxes on a grid (opaque only), scored by their low-frequency structure: the variance of their 4 × 4 block
  // means once a plane is fitted (grain averages out in the blocks, edges and gradients don't)
  const cand: [number, number, number][] = [];
  for (let y0 = 0; y0 + S <= h; y0 += step) for (let x0 = 0; x0 + S <= w; x0 += step) {
    let opaque = true;
    const blk: number[] = [];
    for (let by = 0; by < 4 && opaque; by++) for (let bx = 0; bx < 4; bx++) {
      let s = 0, n = 0;
      for (let y = y0 + by * q; y < Math.min(y0 + S, y0 + (by + 1) * q); y++) for (let x = x0 + bx * q; x < Math.min(x0 + S, x0 + (bx + 1) * q); x++) { const i = (y * w + x) * 4; if (d[i + 3] < 250) opaque = false; s += lum(d[i], d[i + 1], d[i + 2]); n++; }
      blk.push(n ? s / n : 0);
    }
    if (!opaque) continue;
    cand.push([x0, y0, planeResidual(blk, 4, 4).v]);
  }
  if (!cand.length) return null;
  cand.sort((a, b) => a[2] - b[2]);
  const boxes = cand.slice(0, Math.max(1, Math.round(count))).map(([x0, y0]) => [x0, y0, S]);
  const sd = [0, 0, 0], rho = [0, 0, 0], cross = [0, 0, 0];
  for (const [x0, y0] of boxes) {
    const res = [0, 1, 2].map((c) => { const v: number[] = []; for (let y = y0; y < y0 + S; y++) for (let x = x0; x < x0 + S; x++) v.push(d[(y * w + x) * 4 + c]); return planeResidual(v, S, S); });
    for (let c = 0; c < 3; c++) {
      const r = res[c].r, vv = res[c].v;
      sd[c] += vv;
      let a = 0, n = 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = y * S + x; if (x + 1 < S) { a += r[i] * r[i + 1]; n++; } if (y + 1 < S) { a += r[i] * r[i + S]; n++; } }
      rho[c] += vv > 1e-6 ? a / n / vv : 0;
      // grain shared by channel c and the next one
      const o = res[(c + 1) % 3];
      let ab = 0;
      for (let i = 0; i < r.length; i++) ab += r[i] * o.r[i];
      cross[c] += vv > 1e-6 && o.v > 1e-6 ? ab / r.length / Math.sqrt(vv * o.v) : 1;
    }
  }
  const nb = boxes.length;
  return { sd: sd.map((v) => Math.sqrt(v / nb)), rho: rho.map((v) => clamp(v / nb, 0, 0.99)), corr: clamp((cross[0] + cross[1] + cross[2]) / (3 * nb)), boxes };
}
/** residual of a w × h block of values once its least-squares plane is taken out, and its variance */
function planeResidual(v: number[], w: number, h: number): { r: Float32Array; v: number } {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  let m = 0, sx = 0, sy = 0, xx = 0, yy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = v[y * w + x]; m += a; sx += a * (x - cx); sy += a * (y - cy); xx += (x - cx) ** 2; yy += (y - cy) ** 2; }
  m /= w * h; const gx = xx ? sx / xx : 0, gy = yy ? sy / yy : 0;
  const r = new Float32Array(w * h);
  let s = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const e = v[y * w + x] - m - gx * (x - cx) - gy * (y - cy); r[y * w + x] = e; s += e * e; }
  return { r, v: s / (w * h) };
}
/** Add Grain's field (value noise of cell `s`, softened like it) for a seed */
function grainField(w: number, h: number, s: number, aspect: number, soft: number, seed: number): Float32Array {
  let f = noiseField(w, h, Math.max(1, s), aspect, seed);
  const sig = (soft * Math.max(1, s)) / 3;
  if (sig >= 0.3) f = gauss(f, w, h, 1, sig, 'both', true);
  return f;
}
/** neighbour correlation of Add Grain's field by cell size (soft 1), measured once: the table that turns a measured
 *  grain correlation into a size [s, k]. Grain finer than its smallest field (k < 1) is that field mixed with
 *  per-pixel white noise: (1 − k)·white + k·field correlates k²·ρ / ((1 − k)² + k²). */
let rhoTable: [number, number][] | null = null;
function sizeForRho(r: number): [number, number] {
  if (!rhoTable) {
    rhoTable = [1, 1.5, 2, 3, 4, 6, 8, 12, 16].map((s) => {
      const f = grainField(96, 96, s, 1, 1, 12345);
      let m = 0, v = 0, a = 0, n = 0;
      for (const x of f) m += x;
      m /= f.length;
      for (const x of f) v += (x - m) ** 2;
      for (let y = 0; y < 96; y++) for (let x = 0; x + 1 < 96; x++) { a += (f[y * 96 + x] - m) * (f[y * 96 + x + 1] - m); n++; }
      return [s, a / n / (v / f.length)];
    });
  }
  const t = rhoTable;
  if (r < t[0][1]) {
    // k from k²·ρ₁ = r·((1 − k)² + k²), the root in 0…1
    const q = Math.max(0, r) / t[0][1], A = 1 - 2 * q, B = 2 * q, C = -q;
    const k = Math.abs(A) < 1e-9 ? -C / B : (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
    return [t[0][0], clamp(k)];
  }
  for (let i = 1; i < t.length; i++) if (r <= t[i][1]) { const [s0, r0] = t[i - 1], [s1, r1] = t[i]; return [s0 + ((s1 - s0) * (r - r0)) / Math.max(1e-6, r1 - r0), 1]; }
  return [t[t.length - 1][0], 1];
}
const sdOf = (f: Float32Array) => { let m = 0, v = 0; for (const x of f) m += x; m /= f.length; for (const x of f) v += (x - m) ** 2; return Math.sqrt(v / f.length) || 1; };

Object.assign(IMPL_DESENFOQUE, {
  matchGrain: (cv, p, x) => {
    // Match Grain: the grain of the noise source layer measured in its flattest boxes (its size from the correlation of
    // neighbouring pixels, its strength per channel, how much the channels share it), less what this layer already
    // has (Compensate for Existing Noise), then added like Add Grain with the tweaks as multipliers; Blend with
    // Original brings the original back where the colour matches (and the mask layer allows)
    const src = layerInput(p.source, cv, x, 'center');
    if (!src) return cv;
    const w = cv.width, h = cv.height, view = String(p.view ?? 'preview'), S = num(p.sampleSize, 24) * x.res, N = num(p.samples, 8);
    const sd0 = read(src).data, gs = measureGrain(sd0, w, h, N, S);
    const outline = (img: HTMLCanvasElement, boxes: number[][]) => { const o = mk(w, h), g = ctx2d(o); g.drawImage(img, 0, 0); g.strokeStyle = String(p.sampleColor ?? '#ffffff'); g.lineWidth = 1; for (const [bx, by, bs] of boxes) g.strokeRect(bx + 0.5, by + 0.5, bs - 1, bs - 1); return o; };
    if (view === 'noiseSamples') return outline(src, gs?.boxes ?? []);
    const d = read(cv).data, own = measureGrain(d, w, h, N, S);
    if (view === 'compSamples') return outline(cv, own?.boxes ?? []);
    if (!gs) return cv;
    const comp = clamp(num(p.compensate) / 100);
    // grain to add per channel (0…255 deviation) and its size
    const ci = [num(p.rInt, 1), num(p.gInt, 1), num(p.bInt, 1)], cs = [num(p.rSize, 1), num(p.gSize, 1), num(p.bSize, 1)];
    const add = [0, 1, 2].map((c) => Math.sqrt(Math.max(0, gs.sd[c] ** 2 - comp * (own?.sd[c] ?? 0) ** 2)) * num(p.intensity, 1) * ci[c]);
    const fit = [0, 1, 2].map((c) => sizeForRho(gs.rho[c])), base = fit.map(([sz], c) => sz * x.res * num(p.size, 1) * cs[c]);
    const aspect = Math.max(0.01, num(p.aspect, 1)), soft = num(p.softness, 1);
    const ph = x.t * x.fps * num(p.speed, 1), f0 = Math.floor(ph), fr = num(p.smooth) ? ph - f0 : 0, seed0 = Math.round(num(p.seed));
    /** one normalised grain field (σ 1): cell s, mixed with white noise by 1 − mix for grain finer than a pixel */
    const one = (k: number, s: number, mix: number, fi: number) => {
      const sd = hash2(seed0 * 7919 + k + 101, fi) | 0, f = grainField(w, h, s, aspect, soft, sd), a1 = mix / sdOf(f);
      if (mix < 1) { const wn = noiseField(w, h, 1, aspect, sd ^ 0x5bd1e995), a0 = (1 - mix) / sdOf(wn); for (let i = 0; i < f.length; i++) f[i] = f[i] * a1 + wn[i] * a0; }
      else for (let i = 0; i < f.length; i++) f[i] *= a1;
      return f;
    };
    const field = (k: number, s: number, mix: number) => {
      const f = one(k, s, mix, f0);
      if (fr > 0) { const g2 = one(k, s, mix, f0 + 1); for (let i = 0; i < f.length; i++) f[i] = f[i] * (1 - fr) + g2[i] * fr; }
      const k2 = 1 / sdOf(f);
      for (let i = 0; i < f.length; i++) f[i] *= k2;
      return f;
    };
    // the shared part and each channel's own part, mixed by the measured channel correlation (all shared: monochrome)
    const mono = !!num(p.mono), rc = mono ? 1 : gs.corr, M = rc > 0 ? field(3, (base[0] + base[1] + base[2]) / 3, (fit[0][1] + fit[1][1] + fit[2][1]) / 3) : null;
    const I = rc < 1 ? [0, 1, 2].map((c) => field(c, base[c], fit[c][1])) : null, a = Math.sqrt(rc), b = Math.sqrt(1 - rc);
    const sat = num(p.saturation, 1), tint = rgb255(p.tint ?? '#ffffff').map((v) => v / 255), ta = clamp(num(p.tintAmount, 100) / 100);
    const sh = num(p.shadows, 1), md = num(p.midtones, 1), hl = num(p.highlights, 1), mp = clamp(num(p.midpoint, 0.5), 0.01, 0.99), mode = String(p.mode ?? 'add');
    const bal = ['r', 'g', 'b'].map((k) => [num(p[`${k}Shadows`], 1), num(p[`${k}Midtones`], 1), num(p[`${k}Highlights`], 1)]);
    // where the original comes back: the colour match (and the mask layer), blurred
    const amt = clamp(num(p.original) / 100), using = String(p.matchUsing ?? 'rgb');
    let back: Float32Array | null = null;
    if (amt > 0 || view === 'matte') {
      const mc = rgb255(p.matchColor ?? '#808080'), tol = num(p.matchTolerance, 0.1), sf = num(p.matchSoftness, 0.1), inv = !!num(p.matchInvert);
      const [mh, , ms] = hsl(mc[0], mc[1], mc[2]);
      back = new Float32Array(w * h);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const r = d[i], g = d[i + 1], bb = d[i + 2];
        let dist: number;
        switch (using) {
          case 'off': dist = 0; break;
          case 'hue': { const [hh] = hsl(r, g, bb), dh = Math.abs(hh - mh); dist = Math.min(dh, 1 - dh) * 2; break; }
          case 'chroma': { const [hh, , ss] = hsl(r, g, bb), dh = Math.abs(hh - mh); dist = Math.hypot(Math.min(dh, 1 - dh) * 2 * Math.min(ss, ms), ss - ms) / Math.SQRT2; break; }
          case 'luma': dist = Math.abs(lum(r, g, bb) - lum(mc[0], mc[1], mc[2])) / 255; break;
          case 'red': dist = Math.abs(r - mc[0]) / 255; break;
          case 'green': dist = Math.abs(g - mc[1]) / 255; break;
          case 'blue': dist = Math.abs(bb - mc[2]) / 255; break;
          default: dist = Math.hypot(r - mc[0], g - mc[1], bb - mc[2]) / 441.7;
        }
        let m = using === 'off' ? 1 : dist <= tol ? 1 : sf > 0 ? clamp(1 - (dist - tol) / sf) : 0;
        if (inv && using !== 'off') m = 1 - m;
        back[j] = m;
      }
      const ml = layerInput(p.maskLayer, cv, x, p.maskFit === 'stretch' ? 'stretch' : 'center');
      if (ml) {
        const md2 = read(ml).data, mm = String(p.maskMode ?? 'intensity'), scr = p.combine === 'screen';
        for (let i = 0, j = 0; i < md2.length; i += 4, j++) {
          let v = mm === 'alpha' || mm === 'invAlpha' ? md2[i + 3] / 255 : (lum(md2[i], md2[i + 1], md2[i + 2]) / 255) * (md2[i + 3] / 255);
          if (mm === 'invIntensity' || mm === 'invAlpha') v = 1 - v;
          back[j] = scr ? 1 - (1 - back[j]) * (1 - v) : back[j] * v;
        }
      }
      const bm = num(p.blurMatte) * x.res;
      if (bm > 0.3) back = gauss(back, w, h, 1, bm / 2, 'both', true);
    }
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const L = lum(d[i], d[i + 1], d[i + 2]) / 255;
      const resp = (k: number[]) => (L < mp ? k[0] + (k[1] - k[0]) * (L / mp) : k[1] + (k[2] - k[1]) * ((L - mp) / (1 - mp)));
      const R = resp([sh, md, hl]);
      if (view === 'matte') { d[i] = d[i + 1] = d[i + 2] = clamp((R / 2) * (1 - amt * back![j])) * 255; d[i + 3] = 255; continue; }
      let n = [0, 1, 2].map((c) => (M ? a * M[j] : 0) + (I ? b * I[c][j] : 0));
      const m = (n[0] + n[1] + n[2]) / 3;
      n = n.map((v, c) => (m + (v - m) * sat) * (1 - ta + ta * tint[c]));
      const keep = back ? amt * back[j] : 0;
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] / 255, g = (n[c] * add[c] * R * resp(bal[c])) / 255;
        let r: number;
        if (mode === 'film') r = v + g * Math.sqrt(Math.max(0, v * (1 - v))) * 2;
        else if (mode === 'multiply') r = v * (1 + g * 2);
        else if (mode === 'screen') r = 1 - (1 - v) * (1 - g * 2);
        else if (mode === 'overlay') r = v + g * 2 * Math.min(v, 1 - v) * 2;
        else r = v + g;
        d[i + c] = (clamp(r) + (v - clamp(r)) * keep) * 255;
      }
    }
    const done = write(cv, d);
    return view === 'preview' ? previewBox(cv, done, p, x) : done;
  },
} as Record<string, FxFn>);
