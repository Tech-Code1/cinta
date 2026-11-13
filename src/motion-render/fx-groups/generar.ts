// Drawing of the effects in src/core/motion/fx-groups/generar.ts. Helpers come from ../fx and ./estilizar: only use
// them inside the functions (fx.ts imports this file while it is still loading).
import type { FxFn, FxCtx, Params } from '../fx';
import { mk, ctx2d, curveTable } from '../fx';
import { genBlend, noise3, overflow } from './estilizar';
import { hash2, parseColor, rnd } from '../../core/motion/anim';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec2 = (v: unknown): [number, number] => (Array.isArray(v) ? [num(v[0]), num(v[1])] : [0, 0]);
/** an effect point (layer px) in canvas px */
const ptc = (v: unknown, x: FxCtx): [number, number] => { const [a, b] = vec2(v); return [(a - (x.pox ?? 0) - x.ox) * x.res, (b - (x.poy ?? 0) - x.oy) * x.res]; };
const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const data = (cv: HTMLCanvasElement) => ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height);
const put = (cv: HTMLCanvasElement, img: ImageData) => { ctx2d(cv).putImageData(img, 0, 0); return cv; };
/** a fixed per-pixel random number in [0, 1) */
const prand = (a: number, b: number, s: number) => rnd(hash2(a, b), s);
/** four octaves of the lattice noise (−1…1) on a seed plane */
const ragged = (x: number, y: number, z: number) => (noise3(x, y, z, 'soft') + noise3(x * 2.1, y * 2.1, z + 7, 'soft') * 0.5 + noise3(x * 4.3, y * 4.3, z + 13, 'soft') * 0.25 + noise3(x * 8.7, y * 8.7, z + 29, 'soft') * 0.125) / 1.875;
/** what a generator drew, kept inside the layer's alpha and put on it with its Blending Mode and Opacity */
function onLayer(cv: HTMLCanvasElement, gen: HTMLCanvasElement, mode: string, opacity: number): HTMLCanvasElement {
  const g = ctx2d(gen);
  g.globalCompositeOperation = 'destination-in'; g.drawImage(cv, 0, 0); g.globalCompositeOperation = 'source-over';
  return genBlend(cv, gen, mode, opacity);
}
/** «Blend With Original» (0…1): the result mixed back towards the untouched pixels */
function mixBack(d: Uint8ClampedArray, s: Uint8ClampedArray, k: number) {
  if (k <= 0) return;
  for (let i = 0; i < d.length; i++) d[i] = d[i] + (s[i] - d[i]) * Math.min(1, k);
}

// ───────────────────────── colour profiles (Color Profile Converter) ─────────────────────────
type Prof = { m: number[]; white: 'D65' | 'D50'; dec: (v: number) => number; enc: (v: number) => number };
const srgbDec = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgbEnc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
/** Rec. 709 / 2020 camera curve (scene-referred) and its inverse */
const oetfDec = (v: number) => (v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45));
const oetfEnc = (v: number) => (v < 0.018 ? v * 4.5 : 1.099 * v ** 0.45 - 0.099);
const gam = (g: number) => ({ dec: (v: number) => Math.sign(v) * Math.abs(v) ** g, enc: (v: number) => Math.sign(v) * Math.abs(v) ** (1 / g) });
const proDec = (v: number) => (v < 16 / 512 ? v / 16 : v ** 1.8), proEnc = (v: number) => (v < 1 / 512 ? v * 16 : v ** (1 / 1.8));
/** RGB → XYZ from the primaries' and white's xy */
function rgbToXyz(xy: number[], wx: number, wy: number): number[] {
  const P = [0, 1, 2].map((i) => { const x = xy[i * 2], y = xy[i * 2 + 1]; return [x / y, 1, (1 - x - y) / y]; });
  const Wt = [wx / wy, 1, (1 - wx - wy) / wy];
  const M = [P[0][0], P[1][0], P[2][0], P[0][1], P[1][1], P[2][1], P[0][2], P[1][2], P[2][2]], I = inv3(M);
  const S = [0, 1, 2].map((r) => I[r * 3] * Wt[0] + I[r * 3 + 1] * Wt[1] + I[r * 3 + 2] * Wt[2]);
  return M.map((v, i) => v * S[i % 3]);
}
function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
const mul3 = (a: number[], b: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
const D65: [number, number] = [0.3127, 0.329], D50: [number, number] = [0.3457, 0.3585];
const SRGB_XY = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06];
/** Bradford chromatic adaptation D50 ↔ D65 */
const BRAD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
function adapt(from: [number, number], to: [number, number]): number[] {
  const xyz = (w: [number, number]) => [w[0] / w[1], 1, (1 - w[0] - w[1]) / w[1]];
  const s = xyz(from), d = xyz(to), cs = [0, 1, 2].map((r) => BRAD[r * 3] * s[0] + BRAD[r * 3 + 1] * s[1] + BRAD[r * 3 + 2] * s[2]), cd = [0, 1, 2].map((r) => BRAD[r * 3] * d[0] + BRAD[r * 3 + 1] * d[1] + BRAD[r * 3 + 2] * d[2]);
  return mul3(inv3(BRAD), mul3([cd[0] / cs[0], 0, 0, 0, cd[1] / cs[1], 0, 0, 0, cd[2] / cs[2]], BRAD));
}
/** a profile by id; scene-referred ones (Rec. 709 / 2020) use the display's BT.1886 gamma 2.4 when compensated */
export function profile(id: string, sceneComp: boolean): Prof {
  const m709 = rgbToXyz(SRGB_XY, ...D65), b1886 = gam(2.4);
  switch (id) {
    case 'rec709': return { m: m709, white: 'D65', ...(sceneComp ? b1886 : { dec: oetfDec, enc: oetfEnc }) };
    case 'rec2020': return { m: rgbToXyz([0.708, 0.292, 0.17, 0.797, 0.131, 0.046], ...D65), white: 'D65', ...(sceneComp ? b1886 : { dec: oetfDec, enc: oetfEnc }) };
    case 'adobeRgb': return { m: rgbToXyz([0.64, 0.33, 0.21, 0.71, 0.15, 0.06], ...D65), white: 'D65', ...gam(563 / 256) };
    case 'prophoto': return { m: rgbToXyz([0.7347, 0.2653, 0.1596, 0.8404, 0.0366, 0.0001], ...D50), white: 'D50', dec: proDec, enc: proEnc };
    case 'linear': return { m: m709, white: 'D65', ...gam(1) };
    // the project's working space and the embedded profile: Cinta works in sRGB
    default: return { m: m709, white: 'D65', dec: srgbDec, enc: srgbEnc };
  }
}
/** Input → output RGB (linear light) matrix: through XYZ; white adapted (Bradford) except for Absolute Colorimetric */
export function profileMatrix(a: Prof, b: Prof, absolute: boolean): number[] {
  let m = a.m;
  if (!absolute && a.white !== b.white) m = mul3(adapt(a.white === 'D50' ? D50 : D65, b.white === 'D50' ? D50 : D65), m);
  return mul3(inv3(b.m), m);
}
/** Rec. 709 luminance of linear RGB */
const Y709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ───────────────────────── Turbulent Noise ─────────────────────────
/** Turbulent Noise: Fractal Noise's lattice noise and fractal types, with the GPU effect's differences: no sub rotation,
 * sub offset, centred subscale or cycling, and each octave evolves faster than the one before by the Turbulence
 * Factor (its square root per octave), so animating Evolution churns the fine detail more than the large shapes */
function turbulentNoise(cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const W = cv.width, H = cv.height, type = String(p.type ?? 'basic'), kind = String(p.noiseType ?? 'soft');
  const uni = !!num(p.uniform, 1), sc = num(p.scale, 100);
  const sw0 = Math.max(1, uni ? sc : num(p.scaleWidth, 100)), sh0 = Math.max(1, uni ? sc : num(p.scaleHeight, 100));
  const rot = (num(p.rotation) * Math.PI) / 180, [ox, oy] = vec2(p.offset), persp = !!num(p.perspective);
  const cplx = Math.max(1, Math.min(20, num(p.complexity, 6))), inf = num(p.subInfluence, 70) / 100, subS = Math.max(0.1, num(p.subScaling, 56) / 100);
  const seedZ = (num(p.seed) * 7.31) % 251, evo = num(p.evolution) / 360, tf = Math.max(1, Math.min(4, num(p.turbulence, 1.5)));
  const con = num(p.contrast, 100) / 100, bri = num(p.brightness) / 100, inv = !!num(p.invert), ov = String(p.overflow ?? 'hdr');
  const q = Math.max(1, Math.round(Math.min(W, H) / 300)), sw = Math.ceil(W / q), sh = Math.ceil(H / q);
  const cr = Math.cos(rot), sr = Math.sin(rot), n = Math.ceil(cplx);
  const oct = Array.from({ length: n }, (_, o) => ({ f: 1 / Math.pow(subS, o), amp: Math.pow(inf, o) * (o === n - 1 && cplx % 1 ? cplx % 1 : 1), dx: o * 13.7, dy: o * 7.3, par: persp ? Math.pow(0.7, o) : 1, z: evo * Math.pow(tf, o / 2) + seedZ + o * 31.7 }));
  const img = new ImageData(sw, sh), d = img.data;
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
    const gx = (i * q) / x.res + x.ox, gy = (j * q) / x.res + x.oy;
    let v = 0, norm = 0, mx = -1, wx = 0, wy = 0;
    for (let o = 0; o < n; o++) {
      const O = oct[o], lx = gx - ox * O.par, ly = gy - oy * O.par;
      const px = (lx * cr + ly * sr) / sw0, py = (-lx * sr + ly * cr) / sh0;
      let X = px * O.f + O.dx + wx, Y = py * O.f + O.dy + wy;
      if (type === 'swirly') { const a = Math.hypot(px, py) * 2, t = X; X = X * Math.cos(a) - Y * Math.sin(a); Y = t * Math.sin(a) + Y * Math.cos(a); }
      let nz = noise3(X, Y, O.z, kind);
      switch (type) {
        case 'turbulentSmooth': nz = nz * nz * 2 - 1; break;
        case 'turbulent': nz = Math.abs(nz) * 2 - 1; break;
        case 'turbulentSharp': nz = Math.sqrt(Math.abs(nz)) * 2 - 1; break;
        case 'rocky': nz = (1 - Math.abs(nz)) * 2 - 1; nz = nz * Math.abs(nz); break;
        case 'strings': nz = Math.pow(1 - Math.abs(nz), 6) * 2 - 1; break;
        case 'threads': nz = Math.pow(1 - Math.abs(nz), 3) * 2 - 1; break;
        case 'smallBumps': nz = o === 0 ? 0 : Math.abs(nz) * 2 - 1; break;
        case 'subscale': nz = o === 0 ? 0 : nz; break;
        case 'terrain': nz = o === 0 ? nz : nz * Math.max(0, v / Math.max(1e-6, norm) + 0.5); break;
        default:
      }
      if (type === 'dynamic' || type === 'dynamicProgressive' || type === 'smeary') { wx += nz * (type === 'smeary' ? 1.6 : 0.6) * (type === 'dynamicProgressive' ? 1 + o * 0.3 : 1); wy += nz * 0.3; }
      if (type === 'dynamicTwist') { const t = wx; wx = wx * 0.8 - nz * 0.6; wy = t * 0.6 + nz * 0.8; }
      if (type === 'max') mx = Math.max(mx, nz * O.amp);
      v += nz * O.amp; norm += O.amp;
    }
    let val = type === 'max' ? mx : v / (norm || 1);
    if (type === 'cloudy') val = Math.tanh(val * 1.6);
    val = overflow(val * 0.5 * con + 0.5 + bri, ov);
    if (inv) val = 1 - val;
    const k = (j * sw + i) * 4;
    d[k] = d[k + 1] = d[k + 2] = cl(val) * 255; d[k + 3] = 255;
  }
  const small = mk(sw, sh); ctx2d(small).putImageData(img, 0, 0);
  const gen = mk(W, H), g = ctx2d(gen);
  g.imageSmoothingQuality = 'high'; g.drawImage(small, 0, 0, W, H);
  return onLayer(cv, gen, String(p.blendMode ?? 'normal'), num(p.opacity, 100) / 100);
}

// ───────────────────────── Color Stabilizer ─────────────────────────
/** the average colour (0…1, premultiplied-safe) of a square of half-size r round (px, py) in a canvas */
function sampleAt(dd: Uint8ClampedArray, W: number, H: number, px: number, py: number, r: number): number[] {
  const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(W - 1, Math.ceil(px + r)), y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(H - 1, Math.ceil(py + r));
  const s = [0, 0, 0]; let a = 0;
  for (let y = y0; y <= y1; y++) for (let X = x0; X <= x1; X++) { const i = (y * W + X) * 4, w = dd[i + 3] / 255; s[0] += dd[i] * w; s[1] += dd[i + 1] * w; s[2] += dd[i + 2] * w; a += w; }
  return a > 0 ? s.map((v) => v / a / 255) : [0, 0, 0];
}
/** Color Stabilizer: the sample areas (Black / Mid / White Point, Sample Size) measured on this frame and on the frame
 * set with Set Frame (the renderer passes it in p._ref: the layer drawn up to this effect at that time); the frame is
 * then corrected so they match: Brightness shifts every channel by the Black Point's difference, Levels maps the
 * Black and White Points' values per channel, Curves bends a curve per channel through the three points */
export function colorStabilize(cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const ref = p._ref as { cv: HTMLCanvasElement; ox: number; oy: number; res: number } | undefined;
  if (!ref) return cv;
  const W = cv.width, H = cv.height, img = data(cv), d = img.data, rd = data(ref.cv).data, RW = ref.cv.width, RH = ref.cv.height;
  const r = Math.max(0.5, num(p.sampleSize, 3)) * x.res, mode = String(p.stabilize ?? 'levels');
  const pts = ['blackPoint', 'midPoint', 'whitePoint'].map((k) => {
    const [cx, cy] = ptc(p[k], x), lx = cx / x.res + x.ox, ly = cy / x.res + x.oy;
    return { cur: sampleAt(d, W, H, cx, cy, r), ref: sampleAt(rd, RW, RH, (lx - ref.ox) * ref.res, (ly - ref.oy) * ref.res, Math.max(0.5, num(p.sampleSize, 3)) * ref.res) };
  });
  const T: Float32Array[] = [0, 1, 2].map((c) => {
    const t = new Float32Array(256), [b, m, w] = pts;
    if (mode === 'brightness') { const lc = Y709(b.cur[0], b.cur[1], b.cur[2]), lr = Y709(b.ref[0], b.ref[1], b.ref[2]); for (let v = 0; v < 256; v++) t[v] = cl(v / 255 + lr - lc); }
    else if (mode === 'curves') {
      const k = [[0, 0], [b.cur[c], b.ref[c]], [m.cur[c], m.ref[c]], [w.cur[c], w.ref[c]], [1, 1]].sort((u, v) => u[0] - v[0]).filter((q, i, a) => !i || q[0] - a[i - 1][0] > 1e-3);
      t.set(curveTable(k.map((q) => `${q[0]},${q[1]}`).join(' ')));
    } else {
      const span = w.cur[c] - b.cur[c];
      // both points alike (a flat area): a gain from the Black Point alone
      const gain = b.cur[c] > 1e-3 ? b.ref[c] / b.cur[c] : 1;
      for (let v = 0; v < 256; v++) t[v] = Math.abs(span) < 1e-3 ? cl((v / 255) * gain) : cl(b.ref[c] + ((v / 255 - b.cur[c]) * (w.ref[c] - b.ref[c])) / span);
    }
    return t;
  });
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = T[c][d[i + c]] * 255;
  return put(cv, img);
}

export const IMPL_GENERAR: Record<string, FxFn> = {
  // 4-Color Gradient: the four colours mixed by inverse-distance weights whose power follows Blend (100 → squares;
  // lower is sharper, higher softer), Jitter adds per-pixel noise against banding; then Opacity and Blending Mode
  fourColorGradient: (cv, p, x) => {
    const W = cv.width, H = cv.height, P = [1, 2, 3, 4].map((k) => ptc(p[`point${k}`], x)), C = [1, 2, 3, 4].map((k) => parseColor(String(p[`color${k}`] ?? '#000')));
    const pw = (2 * 100) / Math.max(5, num(p.blend, 100)), jit = Math.max(0, num(p.jitter)) / 100, diag2 = W * W + H * H || 1;
    const img = new ImageData(W, H), d = img.data, wv = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      let sw = 0, hit = -1;
      for (let k = 0; k < 4; k++) {
        const d2 = ((X + 0.5 - P[k][0]) ** 2 + (y + 0.5 - P[k][1]) ** 2) / diag2;
        if (d2 < 1e-12) { hit = k; break; }
        wv[k] = Math.pow(d2, -pw / 2); sw += wv[k];
      }
      const i = (y * W + X) * 4, nz = jit ? (prand(X, y, 41) - 0.5) * jit * 0.12 : 0;
      for (let c = 0; c < 3; c++) d[i + c] = cl((hit >= 0 ? C[hit][c] : (wv[0] * C[0][c] + wv[1] * C[1][c] + wv[2] * C[2][c] + wv[3] * C[3][c]) / sw) + nz) * 255;
      d[i + 3] = 255;
    }
    const gen = put(mk(W, H), img);
    return onLayer(cv, gen, String(p.blendMode ?? 'none'), num(p.opacity, 100) / 100);
  },
  turbulentNoise,
  colorStabilizer: colorStabilize,
  // HDR Highlight Compression: in linear light, the brightest channel above a knee (lower with more Amount) rolls off
  // exponentially towards 1, the others scaled with it (hue kept): values far over 1 (HDR) end just under white, and
  // in Cinta's 8-bit layers white itself comes down
  hdrHighlightCompression: (cv, p) => {
    const a = cl(num(p.amount, 100) / 100);
    if (a <= 0) return cv;
    const k = 1 - 0.6 * a, img = data(cv), d = img.data;
    const f = (m: number) => (m <= k ? m : k + (1 - k) * (1 - Math.exp(-(m - k) / (1 - k))));
    const LIN = Float32Array.from({ length: 256 }, (_, i) => srgbDec(i / 255));
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const r = LIN[d[i]], g = LIN[d[i + 1]], b = LIN[d[i + 2]], m = Math.max(r, g, b);
      if (m <= k) continue;
      const s = f(m) / m;
      d[i] = srgbEnc(r * s) * 255; d[i + 1] = srgbEnc(g * s) * 255; d[i + 2] = srgbEnc(b * s) * 255;
    }
    return put(cv, img);
  },
  // Color Profile Converter: decode with the input profile's curve (none when Linearized), through XYZ to the output
  // primaries (white adapted with Bradford, except Absolute Colorimetric), encode with the output curve. Out of gamut:
  // Perceptual desaturates towards the luminance until it fits, the others clip per channel. Black Point
  // Compensation changes nothing (these profiles all have a black of 0)
  colorProfileConverter: (cv, p) => {
    const sc = p.sceneComp !== 'off';
    const A = profile(String(p.input ?? 'working'), sc), B = profile(String(p.output ?? 'working'), sc), intent = String(p.intent ?? 'relative');
    const M = profileMatrix(A, B, intent === 'absolute'), linIn = !!num(p.linearizeIn), linOut = !!num(p.linearizeOut);
    const DEC = Float32Array.from({ length: 256 }, (_, i) => (linIn ? i / 255 : A.dec(i / 255)));
    const img = data(cv), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const r = DEC[d[i]], g = DEC[d[i + 1]], b = DEC[d[i + 2]];
      let o = [M[0] * r + M[1] * g + M[2] * b, M[3] * r + M[4] * g + M[5] * b, M[6] * r + M[7] * g + M[8] * b];
      if (intent === 'perceptual') {
        const y = Math.max(0, Math.min(1, Y709(o[0], o[1], o[2]))), mn = Math.min(...o), mx = Math.max(...o);
        let t = 1;
        if (mn < 0) t = Math.min(t, y / (y - mn || 1));
        if (mx > 1) t = Math.min(t, (1 - y) / (mx - y || 1));
        if (t < 1) o = o.map((v) => y + (v - y) * Math.max(0, t));
      }
      for (let c = 0; c < 3; c++) d[i + c] = cl(linOut ? o[c] : B.enc(cl(o[c]))) * 255;
    }
    return put(cv, img);
  },
  // CC Threshold: white where the chosen measure (Rec. 601 luminance, each RGB channel, HSL saturation) is over the
  // threshold, black elsewhere (Invert swaps them); Alpha keeps the colours and makes alpha 0 or 1
  ccThreshold: (cv, p) => {
    const th = num(p.threshold, 127.5), ch = String(p.channel ?? 'luminance'), inv = !!num(p.invert), img = data(cv), d = img.data, s = d.slice();
    const bw = (v: number) => ((v > th) !== inv ? 255 : 0);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (ch === 'alpha') { d[i + 3] = bw(d[i + 3]); continue; }
      if (ch === 'rgb') { d[i] = bw(r); d[i + 1] = bw(g); d[i + 2] = bw(b); continue; }
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510;
      const v = ch === 'saturation' ? (mx === mn ? 0 : ((mx - mn) / 255 / (1 - Math.abs(2 * l - 1) || 1)) * 255) : 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = d[i + 1] = d[i + 2] = bw(v);
    }
    mixBack(d, s, num(p.blend) / 100);
    return put(cv, img);
  },
  // CC Threshold RGB: each channel full or empty by its own threshold, each one invertible
  ccThresholdRGB: (cv, p) => {
    const th = [num(p.red, 127.5), num(p.green, 127.5), num(p.blue, 127.5)], inv = [p.invertRed, p.invertGreen, p.invertBlue].map((v) => !!num(v));
    const img = data(cv), d = img.data, s = d.slice();
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] > th[c]) !== inv[c] ? 255 : 0;
    mixBack(d, s, num(p.blend) / 100);
    return put(cv, img);
  },
  // CC Burn Film: a burn grows from Center as Burn goes up, its front ragged by fractal noise (Random Seed): the
  // middle is burnt through (transparent), round it a glowing orange rim, then charred brown that browns and
  // darkens the picture ahead of the front
  ccBurnFilm: (cv, p, x) => {
    const b = cl(num(p.burn) / 100);
    if (b <= 0) return cv;
    const W = cv.width, H = cv.height, [cx, cy] = ptc(p.center, x), seed = Math.round(num(p.seed)) * 13 + 5, img = data(cv), d = img.data;
    const R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) || 1, front = b * 1.25, s = 1 / (x.res * 90);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const i = (y * W + X) * 4;
      if (!d[i + 3]) continue;
      const lx = X / x.res + x.ox, ly = y / x.res + x.oy;
      const e = Math.hypot(X - cx, y - cy) / R + ragged(lx * s * 1.5, ly * s * 1.5, seed) * 0.45 - front;
      if (e < 0) { d[i + 3] = 0; continue; }
      const t = e / 0.12;
      if (t < 1) {
        // glowing rim (hot yellow-orange) turning to char
        const glow = Math.pow(1 - t, 2), char = 1 - glow;
        d[i] = 255 * glow + d[i] * 0.08 * char; d[i + 1] = 150 * glow * glow + d[i + 1] * 0.05 * char; d[i + 2] = 20 * glow + d[i + 2] * 0.03 * char;
        continue;
      }
      const u = Math.min(1, (t - 1) / 3), k = 0.15 + 0.85 * u;
      // scorched: browned and darkened, less so further out
      d[i] = d[i] * k + 70 * (1 - k) * 0.6; d[i + 1] = d[i + 1] * k + 35 * (1 - k) * 0.6; d[i + 2] = d[i + 2] * k + 10 * (1 - k) * 0.6;
    }
    return put(cv, img);
  },
};
