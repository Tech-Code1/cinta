// Drawing of the effects in src/core/motion/fx-groups/color.ts (and of a few reworked colour effects of effects.ts
// whose tables live in the catalogue). Helpers come from ../fx: only use them inside the functions (fx.ts imports
// this file while it is still loading).
import type { FxFn } from '../fx';
import { ctx2d, mk, curveTable, parseCube, FX_IMPL } from '../fx';
import { parseColor } from '../../core/motion/anim';
import { PHOTO_FILTERS } from '../../core/motion/effects';
import { overFloat, enc } from '../linear';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Runs fn over the pixels as 0…1 floats (r, g, b, a; un-premultiplied); fn writes the result back into o.
 *  Transparent pixels are skipped unless `all`. */
function each(cv: HTMLCanvasElement, fn: (o: number[], x: number, y: number) => void, all = false): HTMLCanvasElement {
  const g = ctx2d(cv, true), img = g.getImageData(0, 0, cv.width, cv.height), d = img.data, w = cv.width, o = [0, 0, 0, 0];
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    if (!d[i + 3] && !all) continue;
    o[0] = d[i] / 255; o[1] = d[i + 1] / 255; o[2] = d[i + 2] / 255; o[3] = d[i + 3] / 255;
    fn(o, k % w, (k / w) | 0);
    d[i] = o[0] * 255; d[i + 1] = o[1] * 255; d[i + 2] = o[2] * 255; d[i + 3] = o[3] * 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}
/** Rec. 709 luminance (After Effects' colour effects work with it) */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function hsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1) || 1), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, Math.min(1, s), l];
}
function rgb(h: number, s: number, l: number): [number, number, number] {
  const f = (k0: number) => { const k = (k0 + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
export { each, luma, num, cl, hsl, rgb };

export const IMPL_COLOR: Record<string, FxFn> = {
  // Photo Filter (Photoshop's): the pixel mixed towards itself multiplied by the filter colour by Density; with
  // Preserve Luminosity the original luminance is put back. Older projects without «filter» use their Color.
  photoFilter: (cv, p) => {
    const f = String(p.filter ?? 'custom'), pre = PHOTO_FILTERS.find((q) => q[0] === f);
    const c = parseColor(pre && pre[2] ? pre[2] : String(p.color ?? '#ec8a00')), k = num(p.density, 25) / 100, keep = num(p.preserve, 1) !== 0;
    return each(cv, (o) => {
      const L0 = luma(o[0], o[1], o[2]);
      for (let i = 0; i < 3; i++) o[i] = o[i] * (1 - k + c[i] * k);
      if (keep) { const d = L0 - luma(o[0], o[1], o[2]); for (let i = 0; i < 3; i++) o[i] = cl(o[i] + d); }
    });
  },
  // HDR Compander: compress (v / gain)^(1/γ), expand v^γ · gain (signs kept)
  hdrCompander: (cv, p) => {
    const g = Math.max(1e-4, num(p.gain, 1)), y = Math.max(0.01, num(p.gamma, 1)), ex = p.mode === 'expand';
    const sp = (v: number, e: number) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));
    return each(cv, (o) => { for (let i = 0; i < 3; i++) o[i] = cl(ex ? sp(o[i], y) * g : sp(o[i] / g, 1 / y)); });
  },
  // Invert: one channel, or the components of HLS / YIQ (NTSC), mixed with the original by Blend
  invert: (cv, p) => {
    const c = String(p.channel ?? 'rgb'), bl = num(p.blend) / 100;
    return each(cv, (o) => {
      const r0 = o[0], g0 = o[1], b0 = o[2], a0 = o[3];
      if (c === 'rgb') { o[0] = 1 - r0; o[1] = 1 - g0; o[2] = 1 - b0; }
      else if (c === 'red' || c === 'green' || c === 'blue') { const i = c === 'red' ? 0 : c === 'green' ? 1 : 2; o[i] = 1 - o[i]; }
      else if (c === 'alpha') o[3] = 1 - a0;
      else if (c === 'hls' || c === 'hue' || c === 'lightness' || c === 'saturation') {
        let [h, s, l] = hsl(r0, g0, b0);
        if (c === 'hls' || c === 'hue') h = (h + 0.5) % 1;
        if (c === 'hls' || c === 'lightness') l = 1 - l;
        if (c === 'hls' || c === 'saturation') s = 1 - s;
        [o[0], o[1], o[2]] = rgb(h, s, l);
      } else {
        let y = 0.299 * r0 + 0.587 * g0 + 0.114 * b0, i = 0.596 * r0 - 0.274 * g0 - 0.322 * b0, q = 0.211 * r0 - 0.523 * g0 + 0.312 * b0;
        if (c === 'yiq' || c === 'luminance') y = 1 - y;
        if (c === 'yiq' || c === 'inPhase') i = -i;
        if (c === 'yiq' || c === 'quadrature') q = -q;
        o[0] = cl(y + 0.956 * i + 0.621 * q); o[1] = cl(y - 0.272 * i - 0.647 * q); o[2] = cl(y - 1.106 * i + 1.703 * q);
      }
      if (bl) { o[0] += (r0 - o[0]) * bl; o[1] += (g0 - o[1]) * bl; o[2] += (b0 - o[2]) * bl; o[3] += (a0 - o[3]) * bl; }
    }, c === 'alpha');
  },
  // Brightness & Contrast: legacy is a straight line (as the GPU version in svgfx.ts); the new one bends a curve
  // that keeps black and white (brightness moves the midtones, contrast is an S around 50 %)
  brightnessContrast: (cv, p) => {
    const b = num(p.brightness), c = num(p.contrast) / 100;
    if (num(p.legacy, 1) !== 0) return each(cv, (o) => { for (let i = 0; i < 3; i++) o[i] = cl((o[i] + b / 100 - 0.5) * (1 + c) + 0.5); });
    const gm = b >= 0 ? 1 / (1 + b / 150) : 1 - b / 150;
    const T = Float32Array.from({ length: 256 }, (_, i) => {
      let v = Math.pow(i / 255, gm);
      if (c > 0) { const sv = v * v * (3 - 2 * v); v += (sv - v) * c; } else if (c < 0) v = 0.5 + (v - 0.5) * (1 + c / 2);
      return cl(v);
    });
    return each(cv, (o) => { for (let i = 0; i < 3; i++) o[i] = T[Math.round(o[i] * 255)]; });
  },
  // Black & White (Photoshop's): grey = min + (mid − min)·secondary weight + (max − mid)·primary weight, where the
  // primary is the largest channel's colour and the secondary the mix of the two largest; Tint colours the grey
  blackWhite: (cv, p) => {
    const W: Record<string, number> = { r: num(p.reds, 40), y: num(p.yellows, 60), g: num(p.greens, 40), c: num(p.cyans, 60), b: num(p.blues, 20), m: num(p.magentas, 80) };
    const amt = num(p.amount, 100) / 100, tint = !!num(p.tint), tc = parseColor(String(p.tintColor ?? '#e1d3b3')), tl = luma(tc[0], tc[1], tc[2]);
    return each(cv, (o) => {
      const [r, g, b] = o, mx = Math.max(r, g, b), mn = Math.min(r, g, b), mid = r + g + b - mx - mn;
      const pri = mx === r ? 'r' : mx === g ? 'g' : 'b', lo = mn === b ? 'b' : mn === r ? 'r' : 'g';
      const sec = lo === 'b' ? 'y' : lo === 'r' ? 'c' : 'm';
      const L = cl(mn + ((mid - mn) * W[sec]) / 100 + ((mx - mid) * W[pri]) / 100);
      let t = [L, L, L];
      if (tint) t = L >= tl ? tc.slice(0, 3).map((v) => v + (1 - v) * ((L - tl) / (1 - tl || 1))) : tc.slice(0, 3).map((v) => v * (L / (tl || 1)));
      for (let i = 0; i < 3; i++) o[i] += (cl(t[i]) - o[i]) * amt;
    });
  },
  // Color Balance (HLS): hue turned, lightness towards black / white, saturation scaled (as Hue/Saturation's master)
  colorBalanceHLS: (cv, p) => {
    const dh = num(p.hue) / 360, kl = num(p.lightness) / 100, ks = num(p.saturation) / 100;
    return each(cv, (o) => {
      const [h, s0, l] = hsl(o[0], o[1], o[2]);
      const c = rgb((((h + dh) % 1) + 1) % 1, cl(s0 * (1 + ks)), l);
      for (let i = 0; i < 3; i++) o[i] = cl(kl >= 0 ? c[i] + (1 - c[i]) * kl : c[i] * (1 + kl));
    });
  },
  // Gamma/Pedestal/Gain: black stretch lifts the darkest values; per channel pedestal + (gain − pedestal)·v^(1/γ)
  gammaPedestalGain: (cv, p) => {
    const st = Math.max(1, num(p.blackStretch, 1)), ch = ['r', 'g', 'b'].map((k) => [Math.max(0.01, num(p[`${k}Gamma`], 1)), num(p[`${k}Pedestal`]), num(p[`${k}Gain`], 1)]);
    return each(cv, (o) => {
      for (let i = 0; i < 3; i++) {
        let v = o[i];
        if (st > 1) v += (1 - Math.pow(1 - v, st) - v) * (1 - v);
        const [gm, pd, gn] = ch[i];
        o[i] = cl(pd + (gn - pd) * Math.pow(v, 1 / gm));
      }
    });
  },
  // Broadcast Colors: the composite signal (luma + chroma amplitude, NTSC with its 7.5 IRE setup) kept under the
  // maximum by lowering luminance or saturation, or the unsafe / safe pixels keyed out
  broadcastColors: (cv, p) => {
    const ntsc = p.locale !== 'pal', m = String(p.method ?? 'luma'), lim = num(p.ire, 110);
    const ire = (r: number, g: number, b: number) => { const y = 0.299 * r + 0.587 * g + 0.114 * b, c = Math.hypot(0.492 * (b - y), 0.877 * (r - y)); return ntsc ? 7.5 + 92.5 * (y + c) : 100 * (y + c); };
    return each(cv, (o) => {
      const safe = ire(o[0], o[1], o[2]) <= lim + 1e-6;
      if (m === 'keyUnsafe') { if (!safe) o[3] = 0; return; }
      if (m === 'keySafe') { if (safe) o[3] = 0; return; }
      if (safe) return;
      const y = 0.299 * o[0] + 0.587 * o[1] + 0.114 * o[2], at = (f: number, i: number) => (m === 'sat' ? y + (o[i] - y) * f : o[i] * f);
      // the factor that brings the signal down to the limit (bisection)
      let lo = 0, hi = 1;
      for (let k = 0; k < 20; k++) { const f = (lo + hi) / 2; if (ire(at(f, 0), at(f, 1), at(f, 2)) > lim) hi = f; else lo = f; }
      const q = [at(lo, 0), at(lo, 1), at(lo, 2)];
      o[0] = q[0]; o[1] = q[1]; o[2] = q[2];
    });
  },
  // Selective Color: how much a pixel belongs to each of the nine colours (the gap between its channels), and in
  // that measure its cyan / magenta / yellow inks (1 − R, G, B) changed, plus black on all three; Relative scales
  // the change by the ink already there
  selectiveColor: (cv, p) => {
    const rel = p.method !== 'absolute', K = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'].map((k) => ['C', 'M', 'Y', 'K'].map((c) => num(p[`${k}${c}`]) / 100));
    const used = K.map((a) => a.some((v) => v !== 0));
    if (!used.some(Boolean)) return cv;
    return each(cv, (o) => {
      const r = o[0], g = o[1], b = o[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), mid = r + g + b - mx - mn;
      const top = mx === r ? 0 : mx === g ? 1 : 2, bot = mn === b ? 2 : mn === r ? 0 : 1;
      const w = [top === 0 ? mx - mid : 0, bot === 2 ? mid - mn : 0, top === 1 ? mx - mid : 0, bot === 0 ? mid - mn : 0, top === 2 ? mx - mid : 0, bot === 1 ? mid - mn : 0, mn > 0.5 ? (mn - 0.5) * 2 : 0, Math.max(0, 1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5))), mx < 0.5 ? (0.5 - mx) * 2 : 0];
      const src = [r, g, b];
      for (let k = 0; k < 9; k++) {
        if (!used[k] || !w[k]) continue;
        for (let i = 0; i < 3; i++) { const ink = 1 - src[i], d = (K[k][i] + K[k][3]) * (rel ? ink : 1); o[i] -= Math.max(-ink, Math.min(1 - ink, d)) * w[k]; }
      }
      for (let i = 0; i < 3; i++) o[i] = cl(o[i]);
    });
  },
  // Color Link: one colour sampled from a layer (or this one) after leaving out Clip % at each end, laid over the
  // layer with a blending mode and opacity; with Stencil Original Alpha only where the layer is
  colorLink: (cv, p, x) => {
    const src = (typeof p.source === 'string' && p.source ? x.layer?.(p.source)?.cv : null) || cv;
    const d = ctx2d(src, true).getImageData(0, 0, src.width, src.height).data, sm = String(p.sample ?? 'average'), clip = num(p.clip, 5) / 100, alpha = sm.endsWith('Alpha');
    const px: number[][] = [];
    const step = Math.max(1, Math.floor(d.length / 4 / 40000));
    for (let i = 0; i < d.length; i += 4 * step) if (d[i + 3] || alpha) px.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255]);
    const c = [0, 0, 0];
    if (px.length) {
      const key = (q: number[]) => (alpha ? q[3] : sm === 'maxRGB' ? Math.max(q[0], q[1], q[2]) : sm === 'minRGB' ? Math.min(q[0], q[1], q[2]) : luma(q[0], q[1], q[2]));
      px.sort((a, b) => key(a) - key(b));
      const lo = Math.floor(px.length * clip), keep = px.slice(lo, Math.max(lo + 1, Math.ceil(px.length * (1 - clip))));
      const pick = sm === 'brightest' || sm === 'maxRGB' || sm === 'maxAlpha' ? [keep[keep.length - 1]] : sm === 'darkest' || sm === 'minRGB' || sm === 'minAlpha' ? [keep[0]] : sm === 'median' || sm === 'medAlpha' ? [keep[keep.length >> 1]] : keep;
      for (const q of pick) for (let i = 0; i < 3; i++) c[i] += (alpha ? q[3] : q[i]) / pick.length;
    }
    const stencil = !!num(p.stencil), fill = mk(cv.width, cv.height), f = ctx2d(fill);
    f.fillStyle = `rgb(${c.map((v) => Math.round(cl(v) * 255)).join(',')})`;
    f.fillRect(0, 0, cv.width, cv.height);
    const out = mk(cv.width, cv.height), g = ctx2d(out), mode = String(p.mode ?? 'normal');
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = (mode === 'normal' ? 'source-over' : mode === 'add' ? 'lighter' : mode) as GlobalCompositeOperation;
    g.globalAlpha = cl(num(p.opacity, 100) / 100);
    g.drawImage(fill, 0, 0);
    if (stencil) { g.globalAlpha = 1; g.globalCompositeOperation = 'destination-in'; g.drawImage(cv, 0, 0); }
    return out;
  },
  // Cineon Converter: 10-bit printing density codes (0.002 each) to light with the display gamma, between the black
  // and white points; Linear to Log is the inverse; Log to Log only moves the points. Highlight Rolloff softens the
  // top of the range instead of clipping it.
  cineonConverter: (cv, p) => {
    const t = String(p.type ?? 'logToLin'), B = num(p.black10, 95), Wp = Math.max(B + 1, num(p.white10, 685)), bI = num(p.blackInt), wI = num(p.whiteInt, 1), gm = Math.max(0.01, num(p.gamma, 1.7)), ro = num(p.rolloff, 20);
    const off = Math.pow(10, ((B - Wp) * 0.002) / gm), knee = 1 - Math.min(0.9, ro / (Wp - B));
    const soft = (v: number) => (v <= knee ? v : knee + (1 - knee) * Math.tanh((v - knee) / (1 - knee)));
    const T = Float32Array.from({ length: 256 }, (_, i) => {
      const v = i / 255, code = v * 1023;
      if (t === 'linToLog') { const lin = (v - bI) / (wI - bI || 1); return cl((Wp + (gm / 0.002) * Math.log10(Math.max(1e-6, lin * (1 - off) + off))) / 1023); }
      if (t === 'logToLog') return cl(bI + ((code - B) / (Wp - B)) * (wI - bI));
      return cl(bI + (wI - bI) * soft((Math.pow(10, ((code - Wp) * 0.002) / gm) - off) / (1 - off)));
    });
    return each(cv, (o) => { for (let i = 0; i < 3; i++) o[i] = T[Math.round(o[i] * 255)]; });
  },
  // CC Toner: the luminance mapped through 2, 3 or 5 colours (shadows → highlights), or one solid midtone colour
  ccToner: (cv, p) => {
    const C = (k: string, d: string) => parseColor(String(p[k] ?? d)).slice(0, 3);
    const t = String(p.tones ?? 'tritone'), hi = C('highlights', '#fff'), br = C('brights', '#c0aa78'), mi = C('midtones', '#806446'), dk = C('darktones', '#40320a'), sh = C('shadows', '#000');
    const stops = t === 'duotone' ? [sh, hi] : t === 'pentone' ? [sh, dk, mi, br, hi] : t === 'solid' ? [mi, mi] : [sh, mi, hi];
    const bl = num(p.blend) / 100;
    return each(cv, (o) => {
      const L = cl(luma(o[0], o[1], o[2])) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(L)), f = L - k;
      for (let i = 0; i < 3; i++) { const v = stops[k][i] + (stops[k + 1][i] - stops[k][i]) * f; o[i] = v + (o[i] - v) * bl; }
    });
  },
  // CC Color Offset: each channel shifted by its phase (a full turn = the whole range); past the end it wraps round,
  // folds back (solarize) or follows a smooth cycle (polarize)
  ccColorOffset: (cv, p) => {
    const ph = [num(p.red), num(p.green), num(p.blue)].map((a) => a / 360), ov = String(p.overflow ?? 'wrap');
    const fr = (v: number) => ((v % 1) + 1) % 1;
    return each(cv, (o) => {
      for (let i = 0; i < 3; i++) {
        if (!ph[i]) continue;
        const v = o[i] + ph[i];
        o[i] = ov === 'solarize' ? 1 - Math.abs(1 - fr(v / 2) * 2) : ov === 'polarize' ? 0.5 - 0.5 * Math.cos(Math.PI * v) : fr(v);
      }
    });
  },
  // CC Kernel: 3×3 convolution of the colour divided by Divider, optionally absolute, mixed with the original
  ccKernel: (cv, p) => {
    const k = [1, 2, 3].flatMap((l) => [1, 2, 3].map((c) => num(p[`k${l}${c}`], l === 2 && c === 2 ? 1 : 0))), dv = Math.max(0.01, num(p.divider, 1)), ab = !!num(p.absolute), bl = num(p.blend) / 100;
    const W = cv.width, H = cv.height, g = ctx2d(cv, true), img = g.getImageData(0, 0, W, H), d = img.data, s = d.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let j = 0; j < 9; j++) { if (!k[j]) continue; const xx = Math.min(W - 1, Math.max(0, x + (j % 3) - 1)), yy = Math.min(H - 1, Math.max(0, y + ((j / 3) | 0) - 1)); acc += s[(yy * W + xx) * 4 + c] * k[j]; }
        acc /= dv;
        if (ab) acc = Math.abs(acc);
        d[i + c] = acc + (s[i + c] - acc) * bl;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  },
  // CC Color Neutralizer: each sampled «unbalanced» colour is moved onto the grey of its own luminance, and that
  // correction (plus the red / green / blue trims) applied over shadows, midtones and highlights; Pinning holds pure
  // black and white in place
  ccColorNeutralizer: (cv, p) => {
    // each sample: its luminance and the correction there; in between the corrections are interpolated
    const corr = (k: string, d: string, pre: string): [number, number[]] => { const u = parseColor(String(p[k] ?? d)), L = luma(u[0], u[1], u[2]); return [L, [0, 1, 2].map((i) => L - u[i] + num(p[`${pre}${'RGB'[i]}`]) / 100)]; };
    const P = [corr('shadowsUnbalance', '#000000', 'sh'), corr('midtonesUnbalance', '#7f7f7f', 'mid'), corr('highlightsUnbalance', '#ffffff', 'hi')].sort((a, b) => a[0] - b[0]);
    const pin = num(p.pinning) / 100, bl = num(p.blend) / 100;
    return each(cv, (o) => {
      const L = cl(luma(o[0], o[1], o[2])), k = 1 - pin * Math.pow(Math.abs(2 * L - 1), 4);
      const j = L <= P[1][0] ? 0 : 1, a = P[j], b = P[j + 1], f = cl((L - a[0]) / (b[0] - a[0] || 1));
      for (let i = 0; i < 3; i++) { const v = cl(o[i] + (a[1][i] + (b[1][i] - a[1][i]) * f) * k); o[i] = v + (o[i] - v) * bl; }
    });
  },
  // Video Limiter: the composite signal Y ± C (C: the NTSC chroma amplitude) kept within the clip level (and as far
  // below 0); chroma goes first, then luma; compression starts that much below; gamut warning paints what changes
  videoLimiter: (cv, p) => {
    const L = (Number(p.clip) || 103) / 100, comp = (Number(p.compression) || 0) / 100, warn = !!num(p.gamutWarning), wc = parseColor(String(p.warningColor ?? '#f00adc'));
    const knee = L * (1 - comp), lo = 1 - L;
    const soft = (v: number) => (v <= knee || comp <= 0 ? Math.min(v, L) : knee + (L - knee) * (1 - Math.exp(-(v - knee) / (L - knee))));
    return each(cv, (o) => {
      const [r, g, b] = o, y = 0.299 * r + 0.587 * g + 0.114 * b, u = 0.492 * (b - y), v = 0.877 * (r - y), c = Math.hypot(u, v);
      let y2 = soft(y), k = 1;
      if (y2 - c < -lo) y2 = Math.min(y2, c - lo);
      const top = soft(y2 + c);
      if (y2 + c > top + 1e-6) k = Math.max(0, (top - y2) / c);
      if (y2 - c * k < -lo) k = Math.max(0, (y2 + lo) / (c || 1));
      if (Math.abs(y2 - y) < 1e-4 && k > 1 - 1e-4) return;
      if (warn) { o[0] = wc[0]; o[1] = wc[1]; o[2] = wc[2]; return; }
      for (let i = 0; i < 3; i++) o[i] = cl(y2 + (o[i] - y) * k);
    });
  },
  // CC Overbrights: on an adjustment layer of a 32 bpc comp it reads the values over 1 that the 8-bit canvas lost
  ccOverbrights: (cv, p) => {
    const mode = String(p.channel ?? 'rgbClip'), cc = parseColor(String(p.clipColor ?? '#ff0000'));
    const fc = overFloat && overFloat.w === cv.width && overFloat.h === cv.height && overFloat.cs.depth === 32 ? overFloat : null;
    const g = ctx2d(cv, true), img = g.getImageData(0, 0, cv.width, cv.height), d = img.data, n = d.length / 4;
    const v = new Float32Array(n * 3);
    // working-space values: the float comp's where the canvas is saturated, the canvas' elsewhere
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      const a = fc ? fc.px[i * 4 + 3] : 0;
      v[i * 3 + k] = fc && d[i * 4 + k] >= 255 && a > 0 ? fc.px[i * 4 + k] / a : fc ? fc.dec(d[i * 4 + k]) : d[i * 4 + k] / 255;
    }
    const lin = !!fc?.cs.blendGamma1, out = (x: number) => Math.round(cl(lin ? enc(x) : x) * 255);
    const L = (i: number) => mode.startsWith('light') ? (v[i] + v[i + 1] + v[i + 2]) / 3 : 0.299 * v[i] + 0.587 * v[i + 1] + 0.114 * v[i + 2];
    if (mode.endsWith('Solid')) {
      // scaled so the brightest value fits in 0…1
      const mx = [0, 0, 0];
      for (let i = 0; i < n; i++) { if (!d[i * 4 + 3]) continue; if (mode === 'rgbSolid') for (let k = 0; k < 3; k++) mx[k] = Math.max(mx[k], v[i * 3 + k]); else mx[0] = Math.max(mx[0], L(i * 3)); }
      const sc = mode === 'rgbSolid' ? mx.map((m) => (m > 1 ? 1 / m : 1)) : [0, 0, 0].map(() => (mx[0] > 1 ? 1 / mx[0] : 1));
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) d[i * 4 + k] = out(v[i * 3 + k] * sc[k]);
    } else {
      for (let i = 0; i < n; i++) {
        const over = mode === 'rgbClip' ? v[i * 3] > 1 || v[i * 3 + 1] > 1 || v[i * 3 + 2] > 1 : L(i * 3) > 1;
        if (over) for (let k = 0; k < 3; k++) d[i * 4 + k] = Math.round(cc[k] * 255);
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  },
  // PS Arbitrary Map: out = master[channel map[phase(in)]] per channel (Photoshop's .amp tables, identity by default)
  psArbMap: (cv, p) => {
    const T = arbTables(String(p.map ?? '')), sh = Math.floor((num(p.phase) / 360) * 256), alpha = !!num(p.alphaPhase);
    const ph = (i: number) => (((i + sh) % 256) + 256) % 256;
    const g = ctx2d(cv, true), img = g.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) d[i + k] = T[T[(k + 1) * 256 + ph(d[i + k])]];
      d[i + 3] = T[T[1024 + (alpha ? ph(d[i + 3]) : d[i + 3])]];
    }
    g.putImageData(img, 0, 0);
    return cv;
  },
  // old Color Balance: each channel plus its balance (±100 → ±255)
  colorBalanceLegacy: (cv, p) => { const o3 = [num(p.red), num(p.green), num(p.blue)].map((v) => v / 100); return each(cv, (o) => { for (let k = 0; k < 3; k++) o[k] = cl(o[k] + o3[k]); }); },
};

// ───────────────────────── Auto Levels / Auto Contrast / Auto Color ─────────────────────────
/** What the auto corrections need of one frame: its red, green and blue histograms over opaque pixels (3 × 256) and
 *  its pixels (all of them for the frame being drawn; a sample of at most 128 × 128 for the others). */
export interface AutoFrame { h: Float64Array; n: number; d: Uint8ClampedArray }
export function autoFrame(cv: HTMLCanvasElement, full = true): AutoFrame {
  const W = cv.width, H = cv.height, d = ctx2d(cv, true).getImageData(0, 0, W, H).data, h = new Float64Array(768);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 8) continue; h[d[i]]++; h[256 + d[i + 1]]++; h[512 + d[i + 2]]++; n++; }
  if (full || W * H <= 128 * 128) return { h, n, d };
  const k = Math.ceil(Math.max(W, H) / 128), sw = Math.ceil(W / k), sh = Math.ceil(H / k), s = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0, j = 0; y < sh; y++) for (let x = 0; x < sw; x++, j += 4) { const i = ((y * k) * W + x * k) * 4; s[j] = d[i]; s[j + 1] = d[i + 1]; s[j + 2] = d[i + 2]; s[j + 3] = d[i + 3]; }
  return { h, n, d: s };
}
/** Black and white points of a 256-bin histogram (at offset o) leaving out lo / hi % of the values at each end. */
function clipAt(h: Float64Array, o: number, lo: number, hi: number): [number, number] {
  let total = 0;
  for (let i = 0; i < 256; i++) total += h[o + i];
  total ||= 1;
  let acc = 0, b = 0, w = 255;
  for (let i = 0; i < 256; i++) { acc += h[o + i]; if (acc > (total * lo) / 100) { b = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += h[o + i]; if (acc > (total * hi) / 100) { w = i; break; } }
  return w > b ? [b, w] : [0, 255];
}
/** One frame's correction: per channel [black, white, gamma] (0…255 points) for Auto Levels (each channel on its own),
 *  Auto Contrast (the three together) or Auto Color (each channel, plus with Snap Neutral Midtones a gamma per channel
 *  that makes the average midtone grey). */
function autoOf(kind: string, f: AutoFrame, lo: number, hi: number, snap: boolean): number[][] {
  let pts: [number, number][];
  if (kind === 'autoContrast') {
    const all = new Float64Array(256);
    for (let i = 0; i < 256; i++) all[i] = f.h[i] + f.h[256 + i] + f.h[512 + i];
    const bw = clipAt(all, 0, lo, hi);
    pts = [bw, bw, bw];
  } else pts = [0, 1, 2].map((c) => clipAt(f.h, c * 256, lo, hi));
  const gam = [1, 1, 1];
  if (kind === 'autoColor' && snap) {
    // mean of each stretched channel over the midtones (luminance 25…75 %)
    const d = f.d, sum = [0, 0, 0];
    let n0 = 0;
    for (let i = 0; i < d.length; i += 4) { const L = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255; if (d[i + 3] < 8 || L < 0.25 || L > 0.75) continue; for (let c = 0; c < 3; c++) sum[c] += Math.max(1e-3, Math.min(1, (d[i + c] - pts[c][0]) / (pts[c][1] - pts[c][0]))); n0++; }
    if (n0) { const m = sum.map((s) => s / n0), target = (m[0] + m[1] + m[2]) / 3; for (let c = 0; c < 3; c++) gam[c] = Math.log(target) / Math.log(m[c]); }
  }
  return pts.map(([b, w], c) => [b, w, gam[c]]);
}
/** Scene Detect: two frames belong to different shots when, in any channel, the histograms differ by half the
 *  pixels or more (sum of |difference| over the bins / pixel count ≥ 0.5) */
export function sceneCut(a: AutoFrame, b: AutoFrame): boolean {
  for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = c * 256; i < c * 256 + 256; i++) s += Math.abs(a.h[i] / (a.n || 1) - b.h[i] / (b.n || 1));
    if (s >= 0.5) return true;
  }
  return false;
}
/** The correction of the frame `at` of a window of frames (Temporal Smoothing): the corrections of the frames around
 *  it averaged, stopping at a scene cut on either side when Scene Detect is on. */
export function autoCorrection(kind: string, frames: AutoFrame[], at: number, lo: number, hi: number, snap: boolean, scene: boolean): number[][] {
  let a = at, b = at;
  while (a > 0 && !(scene && sceneCut(frames[a - 1], frames[a]))) a--;
  while (b < frames.length - 1 && !(scene && sceneCut(frames[b], frames[b + 1]))) b++;
  const acc = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = a; k <= b; k++) autoOf(kind, frames[k], lo, hi, snap).forEach((q, c) => q.forEach((v, j) => (acc[c][j] += v)));
  return acc.map((q) => q.map((v) => v / (b - a + 1)));
}
/** Auto Levels / Contrast / Color: the frame stretched by its correction (or, with Temporal Smoothing, by the window's
 *  the renderer passes in p._frames: the other frames, null where the effect's own input goes), blended with the
 *  original. */
const autoFx = (kind: string): FxFn => (cv, p) => {
  const lo = num(p.blackClip, 0.1), hi = num(p.whiteClip, 0.1), bl = num(p.blend) / 100, snap = !!num(p.snapNeutral);
  const own = autoFrame(cv), win = p._frames as { frames: (AutoFrame | null)[]; at: number } | undefined;
  const frames = win ? win.frames.map((f, i) => (i === win.at ? own : f)).filter((f): f is AutoFrame => !!f) : [own];
  const at = win ? win.frames.slice(0, win.at).filter((f) => f).length : 0;
  const corr = autoCorrection(kind, frames, at, lo, hi, snap, !!num(p.sceneDetect));
  const g = ctx2d(cv, true), img = g.getImageData(0, 0, cv.width, cv.height), d = img.data;
  const tab = corr.map(([b, w, gm]) => { const t = new Float32Array(256); for (let v = 0; v < 256; v++) t[v] = Math.pow(Math.max(0, Math.min(1, (v - b) / (w - b))), gm) * 255; return t; });
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * bl + tab[c][d[i + c]] * (1 - bl);
  g.putImageData(img, 0, 0);
  return cv;
};
Object.assign(IMPL_COLOR, { autoLevels: autoFx('autoLevels'), autoContrast: autoFx('autoContrast'), autoColor: autoFx('autoColor') });

// ───────────────────────── Lumetri Color ─────────────────────────
/** 3D LUTs of Lumetri's Creative Look (the .cube text), parsed once */
const lookCache = new Map<string, { n: number; data: Float32Array } | null>();
/** Colours of a key text ('#rrggbb' separated by spaces or commas) as HSL (h in degrees, s and l in %) */
const keyColors = (v: unknown): number[][] => String(v ?? '').split(/[\s,;]+/).filter((c) => /^#?[0-9a-f]{6}$/i.test(c)).map((c) => { const [r, g, b] = parseColor(c.startsWith('#') ? c : `#${c}`); const [h, s, l] = hsl(r, g, b); return [h * 360, s * 100, l * 100]; });
/** The HSL Secondary key: per channel [min, max, feather] (hue in degrees, wrapping when min > max; S and L in %).
 *  Without key colours, the sliders; «Set color» centres a range on its colour (hue ±20°, S and L ±25 %, feathered
 *  20° / 15 %), «Add color» widens the ranges to take its colour in, «Remove color» moves the nearest hue edge past it. */
export function hslKey(p: Record<string, unknown>): number[][] {
  const set = keyColors(p.hslSet);
  if (!set.length) return [[num(p.hslHMin), num(p.hslHMax, 360), num(p.hslHFeather)], [num(p.hslSMin), num(p.hslSMax, 100), num(p.hslSFeather)], [num(p.hslLMin), num(p.hslLMax, 100), num(p.hslLFeather)]];
  const [h0, s0, l0] = set[0];
  const k = [[h0 - 20, h0 + 20, 20], [s0 - 25, s0 + 25, 15], [l0 - 25, l0 + 25, 15]];
  for (const [h, s, l] of [...set.slice(1), ...keyColors(p.hslAdd)]) {
    // hue: grow the side of the arc nearest to the new colour
    const c = (k[0][0] + k[0][1]) / 2, d = ((h - c + 540) % 360) - 180, half = (k[0][1] - k[0][0]) / 2;
    if (d > half - 5) k[0][1] = c + d + 5; else if (d < -half + 5) k[0][0] = c + d - 5;
    k[1][0] = Math.min(k[1][0], s - 10); k[1][1] = Math.max(k[1][1], s + 10); k[2][0] = Math.min(k[2][0], l - 10); k[2][1] = Math.max(k[2][1], l + 10);
  }
  for (const [h] of keyColors(p.hslRemove)) {
    const c = (k[0][0] + k[0][1]) / 2, d = ((h - c + 540) % 360) - 180, half = (k[0][1] - k[0][0]) / 2;
    if (Math.abs(d) <= half + k[0][2]) { if (d >= 0) k[0][1] = c + Math.max(0, d - 5 - k[0][2]); else k[0][0] = c + Math.min(0, d + 5 + k[0][2]); }
  }
  return k.map((q, i) => (i ? [Math.max(0, q[0]), Math.min(100, q[1]), q[2]] : [((q[0] % 360) + 360) % 360, ((q[1] % 360) + 360) % 360 || (q[1] - q[0] >= 360 ? 360 : 0), q[2]]));
}
/** how much a pixel's H, S, L (degrees, %, %) is in the key (0…1) */
export function hslKeyed(k: number[][], h: number, s: number, l: number): number {
  const lin = (v: number, [a, b, f]: number[]) => (v >= a && v <= b ? 1 : f > 0 ? cl(1 - (v < a ? a - v : v - b) / f) : 0);
  const [a, b, f] = k[0];
  let mh: number;
  if (b - a >= 360 || (a === 0 && b === 360)) mh = 1;
  else {
    const inside = a <= b ? h >= a && h <= b : h >= a || h <= b;
    const da = Math.min(Math.abs(h - a), 360 - Math.abs(h - a)), db = Math.min(Math.abs(h - b), 360 - Math.abs(h - b));
    mh = inside ? 1 : f > 0 ? cl(1 - Math.min(da, db) / f) : 0;
  }
  return mh * lin(s, k[1]) * lin(l, k[2]);
}

IMPL_COLOR.lumetri = (cv, p, x) => {
  // in the order of After Effects' panel: basic (white balance, tone, saturation), creative (look, adjustments),
  // curves, colour wheels, HSL secondary, vignette
  const g = (k: string, d = 0) => num(p[k], d);
  const W = cv.width, H = cv.height;
  const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
  const temp = g('temperature') / 100, tint = g('tint') / 100, ev = Math.pow(2, g('exposure')), con = g('contrast') / 100;
  const hi = g('highlights') / 100, sh = g('shadows') / 100, wh = g('whites') / 100, bl = g('blacks') / 100;
  const sat = g('saturation', 100) / 100, vib = g('vibrance') / 100, csat = g('creativeSat', 100) / 100, fade = g('faded') / 100;
  const sT = parseColor(String(p.shadowTint ?? '#808080')), hT = parseColor(String(p.highlightTint ?? '#808080')), tb = g('tintBalance') / 100;
  const cR = curveTable(p.curveR), cG = curveTable(p.curveG), cB = curveTable(p.curveB), cM = curveTable(p.curveRGB);
  // HDR (High Dynamic Range on): the tone controls work up to the HDR white, the curves over the HDR range, the
  // wheels' highlights up to their HDR white; HDR Specular lifts or lowers what is above the diffuse white
  const hdr = !!g('hdr'), tw = hdr ? g('hdrWhite', 100) / 100 : 1, spec = hdr ? g('hdrSpecular') / 100 : 0, cr = hdr ? g('hdrRange', 100) / 100 : 1, ww = hdr ? g('wheelsHdrWhite', 100) / 100 : 1;
  // hue / saturation curves: only when changed from their neutral line
  const flat = (v: unknown) => !v || /^\s*0,0\.5\s+1,0\.5\s*$/.test(String(v)), diag = (v: unknown) => !v || /^\s*0,0\s+1,1\s*$/.test(String(v));
  const hueCurves = !flat(p.hueSat) || !flat(p.hueHue) || !flat(p.hueLuma) || !flat(p.lumaSat) || !diag(p.satSat);
  const tHS = curveTable(p.hueSat ?? '0,0.5 1,0.5'), tHH = curveTable(p.hueHue ?? '0,0.5 1,0.5'), tHL = curveTable(p.hueLuma ?? '0,0.5 1,0.5'), tLS = curveTable(p.lumaSat ?? '0,0.5 1,0.5'), tSS = curveTable(p.satSat ?? '0,0 1,1');
  const wS = parseColor(String(p.wheelShadow ?? '#808080')), wM = parseColor(String(p.wheelMid ?? '#808080')), wH = parseColor(String(p.wheelHigh ?? '#808080'));
  const lS = g('wheelShadowL') / 100, lM = g('wheelMidL') / 100, lH = g('wheelHighL') / 100;
  const va = g('vigAmount'), vm = g('vigMidpoint', 50) / 100, vr = g('vigRoundness') / 100, vf = Math.max(0.01, g('vigFeather', 50) / 100);
  // Creative Look: a .cube 3D LUT at an intensity (100 % = the look, 0 = none, above 100 % pushed further)
  const lk = String(p.lut ?? '');
  if (lk && !lookCache.has(lk)) lookCache.set(lk, parseCube(lk));
  const look = lk ? lookCache.get(lk) ?? null : null, li = g('lookIntensity', 100) / 100;
  const lut = (r: number, gg: number, b: number): [number, number, number] => {
    const n = look!.n, D = look!.data, at = (i: number, j: number, k: number, c: number) => D[((k * n + j) * n + i) * 3 + c];
    const fr = cl(r) * (n - 1), fg = cl(gg) * (n - 1), fb = cl(b) * (n - 1), r0 = Math.min(n - 2, Math.floor(fr)), g0 = Math.min(n - 2, Math.floor(fg)), b0 = Math.min(n - 2, Math.floor(fb)), ur = fr - r0, ug = fg - g0, ub = fb - b0;
    const o: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c00 = at(r0, g0, b0, c) * (1 - ur) + at(r0 + 1, g0, b0, c) * ur, c10 = at(r0, g0 + 1, b0, c) * (1 - ur) + at(r0 + 1, g0 + 1, b0, c) * ur;
      const c01 = at(r0, g0, b0 + 1, c) * (1 - ur) + at(r0 + 1, g0, b0 + 1, c) * ur, c11 = at(r0, g0 + 1, b0 + 1, c) * (1 - ur) + at(r0 + 1, g0 + 1, b0 + 1, c) * ur;
      o[c] = (c00 * (1 - ug) + c10 * ug) * (1 - ub) + (c01 * (1 - ug) + c11 * ug) * ub;
    }
    return o;
  };
  const curve = (t: Float32Array, v: number) => { const xx = cl(v) * 255, i = Math.min(254, Math.floor(xx)), f = xx - i; return t[i] * (1 - f) + t[i + 1] * f; };
  // the HSL Secondary key and its correction
  const key = hslKey(p);
  const hT2 = g('hslTemperature') / 100, hTi = g('hslTint') / 100, hC = g('hslContrast') / 100, hSh = g('hslSharpen'), hSat = g('hslSaturation', 100) / 100, hWc = parseColor(String(p.hslWheel ?? '#808080'));
  const showMask = !!g('hslShowMask'), hslOn = showMask || hT2 !== 0 || hTi !== 0 || hC !== 0 || hSh !== 0 || hSat !== 1 || hWc.slice(0, 3).some((v) => Math.abs(v - 0.5) > 0.002);
  const img = ctx2d(cv, true).getImageData(0, 0, W, H), d = img.data, n = W * H;
  const F = new Float32Array(n * 3);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    // white balance and exposure in linear light
    let r = toLin(d[i] / 255) * (1 + temp * 0.3) * ev, gg = toLin(d[i + 1] / 255) * (1 - tint * 0.3) * ev, b = toLin(d[i + 2] / 255) * (1 - temp * 0.3) * ev;
    r = toSrgb(r); gg = toSrgb(gg); b = toSrgb(b);
    // tone: contrast around mid grey; highlights / shadows / whites / blacks weighted by luminance (up to the HDR white)
    let L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    const l2 = cl(L / tw);
    const tone = (v: number) => {
      let o = (v - 0.5) * (1 + con) + 0.5;
      o += hi * 0.35 * l2 * l2 * (1 - l2) * 4 * 0.5 + wh * 0.25 * Math.pow(l2, 4);
      o += sh * 0.35 * (1 - l2) * (1 - l2) * l2 * 4 * 0.5 + bl * 0.25 * Math.pow(1 - l2, 4);
      return spec && v > 0.75 ? o + (v - 0.75) * spec : o;
    };
    r = tone(r); gg = tone(gg); b = tone(b);
    // basic saturation
    L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    r = L + (r - L) * sat; gg = L + (gg - L) * sat; b = L + (b - L) * sat;
    // creative: the look, then vibrance (pushes the least saturated most) and creative saturation
    if (look && li > 0) { const o = lut(r, gg, b); r += (o[0] - r) * li; gg += (o[1] - gg) * li; b += (o[2] - b) * li; }
    L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), s0 = mx > 0 ? (mx - mn) / mx : 0, k = csat * (1 + vib * (1 - s0));
    r = L + (r - L) * k; gg = L + (gg - L) * k; b = L + (b - L) * k;
    // faded film: blacks lifted towards grey
    if (fade) { r = r * (1 - fade * 0.25) + fade * 0.125; gg = gg * (1 - fade * 0.25) + fade * 0.125; b = b * (1 - fade * 0.25) + fade * 0.125; }
    // shadow / highlight tints, split by luminance and the balance
    const lc = cl(L), split = cl(lc + tb * 0.5), ws = (1 - split) * 0.5, wh2 = split * 0.5;
    r += (sT[0] - 0.5) * ws + (hT[0] - 0.5) * wh2; gg += (sT[1] - 0.5) * ws + (hT[1] - 0.5) * wh2; b += (sT[2] - 0.5) * ws + (hT[2] - 0.5) * wh2;
    // curves: each channel then RGB (over the HDR range)
    r = curve(cM, curve(cR, r / cr)) * cr; gg = curve(cM, curve(cG, gg / cr)) * cr; b = curve(cM, curve(cB, b / cr)) * cr;
    if (hueCurves) {
      // Hue vs Sat / Hue / Luma, Luma vs Sat, Sat vs Sat on the pixel's HSL (a curve at 0.5 changes nothing)
      let [hh, ss, ll] = hsl(cl(r), cl(gg), cl(b));
      const h0 = hh, l0 = ll;
      hh = ((hh + (curve(tHH, h0) - 0.5)) % 1 + 1) % 1;
      ss = curve(tSS, ss) * curve(tHS, h0) * 2 * curve(tLS, l0) * 2;
      ll = ll * (1 + (curve(tHL, h0) - 0.5) * 2 * Math.min(1, ss * 2));
      [r, gg, b] = rgb(hh, cl(ss), cl(ll));
    }
    // colour wheels: an offset per tonal range (grey = none) plus its lightness
    const lw = cl(lc / ww), wsh = (1 - lw) * (1 - lw), whi = lw * lw, wmi = Math.max(0, 1 - wsh - whi);
    r += ((wS[0] - 0.5) * 0.5 + lS * 0.3) * wsh + ((wM[0] - 0.5) * 0.5 + lM * 0.3) * wmi + ((wH[0] - 0.5) * 0.5 + lH * 0.3) * whi;
    gg += ((wS[1] - 0.5) * 0.5 + lS * 0.3) * wsh + ((wM[1] - 0.5) * 0.5 + lM * 0.3) * wmi + ((wH[1] - 0.5) * 0.5 + lH * 0.3) * whi;
    b += ((wS[2] - 0.5) * 0.5 + lS * 0.3) * wsh + ((wM[2] - 0.5) * 0.5 + lM * 0.3) * wmi + ((wH[2] - 0.5) * 0.5 + lH * 0.3) * whi;
    F[j * 3] = r; F[j * 3 + 1] = gg; F[j * 3 + 2] = b;
  }
  if (hslOn) {
    // the key on the image as it is now, refined (denoise: a light blur that is then re-stretched; blur), inverted
    let M: Float32Array = new Float32Array(n);
    for (let j = 0; j < n; j++) { const [hh, ss, ll] = hsl(cl(F[j * 3]), cl(F[j * 3 + 1]), cl(F[j * 3 + 2])); M[j] = d[j * 4 + 3] ? hslKeyed(key, hh * 360, ss * 100, ll * 100) : 0; }
    const dn = g('hslDenoise') / 100;
    if (dn > 0) { M = blurArr(M, W, H, dn * 2 * x.res); for (let j = 0; j < n; j++) { const t = cl((M[j] - 0.5) * (1 + dn * 2) + 0.5); M[j] = t * t * (3 - 2 * t); } }
    const bz = g('hslBlur') * x.res;
    if (bz > 0.2) M = blurArr(M, W, H, bz / 2);
    if (g('hslInvert')) for (let j = 0; j < n; j++) M[j] = 1 - M[j];
    if (showMask) {
      // Color/Gray, Color/Black or White/Black
      const mode = String(p.hslMaskMode ?? 'colorGray');
      for (let j = 0; j < n; j++) for (let c = 0; c < 3; c++) { const v = F[j * 3 + c]; F[j * 3 + c] = mode === 'whiteBlack' ? M[j] : v * M[j] + (mode === 'colorBlack' ? 0 : 0.5) * (1 - M[j]); }
    } else {
      // the correction on the keyed pixels: temperature / tint, contrast round mid grey, saturation, the wheel's offset;
      // sharpen as an unsharp amount on them
      const src = hSh ? F.slice() : null;
      for (let j = 0; j < n; j++) {
        const m = M[j];
        if (m <= 0) continue;
        let r = F[j * 3] * (1 + hT2 * 0.15), gg = F[j * 3 + 1] * (1 - hTi * 0.15), b = F[j * 3 + 2] * (1 - hT2 * 0.15);
        r = (r - 0.5) * (1 + hC) + 0.5; gg = (gg - 0.5) * (1 + hC) + 0.5; b = (b - 0.5) * (1 + hC) + 0.5;
        const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        r = L + (r - L) * hSat + (hWc[0] - 0.5) * 0.5; gg = L + (gg - L) * hSat + (hWc[1] - 0.5) * 0.5; b = L + (b - L) * hSat + (hWc[2] - 0.5) * 0.5;
        F[j * 3] += (r - F[j * 3]) * m; F[j * 3 + 1] += (gg - F[j * 3 + 1]) * m; F[j * 3 + 2] += (b - F[j * 3 + 2]) * m;
      }
      if (src) {
        const a = hSh / 100;
        for (let y = 1; y < H - 1; y++) for (let x0 = 1; x0 < W - 1; x0++) {
          const j = y * W + x0;
          if (M[j] <= 0) continue;
          for (let c = 0; c < 3; c++) { const lap = 4 * src[j * 3 + c] - src[(j - 1) * 3 + c] - src[(j + 1) * 3 + c] - src[(j - W) * 3 + c] - src[(j + W) * 3 + c]; F[j * 3 + c] += lap * a * 0.5 * M[j]; }
        }
      }
    }
  }
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    let r = F[j * 3], gg = F[j * 3 + 1], b = F[j * 3 + 2];
    // vignette: −5 darkens, +5 lightens the edges; roundness blends ellipse ↔ rectangle
    if (va) {
      const xx = j % W, y = (j / W) | 0, nx = (xx / W) * 2 - 1, ny = ((y / H) * 2 - 1) * (1 + Math.max(0, vr) * (H / W - 1)), pw = 2 + Math.max(0, -vr) * 8;
      const dist = Math.pow(Math.pow(Math.abs(nx), pw) + Math.pow(Math.abs(ny), pw), 1 / pw), t = cl((dist - vm) / vf), f = t * t * (3 - 2 * t), m = va < 0 ? 1 + (va / 5) * f : 1;
      r = r * m + (va > 0 ? (va / 5) * f * (1 - r) : 0); gg = gg * m + (va > 0 ? (va / 5) * f * (1 - gg) : 0); b = b * m + (va > 0 ? (va / 5) * f * (1 - b) : 0);
    }
    d[i] = cl(r) * 255; d[i + 1] = cl(gg) * 255; d[i + 2] = cl(b) * 255;
  }
  const out = mk(W, H);
  ctx2d(out).putImageData(img, 0, 0);
  // creative Sharpen: + sharpens the edges, − softens them
  const shp = g('sharpen');
  if (shp > 0) return FX_IMPL.sharpen(out, { amount: shp * 0.5 }, x);
  if (shp < 0) { const o2 = mk(W, H), g2 = ctx2d(o2); g2.filter = `blur(${(-shp / 100) * 1.5}px)`; g2.drawImage(out, 0, 0); return o2; }
  return out;
};
/** Gaussian-ish blur (three box passes) of a one-channel float image */
function blurArr(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return a;
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let s: Float32Array = a, t: Float32Array = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) for (const horiz of [true, false]) {
    const len = horiz ? w : h, lines = horiz ? h : w;
    for (let l = 0; l < lines; l++) {
      const at = (i: number) => s[horiz ? l * w + Math.max(0, Math.min(w - 1, i)) : Math.max(0, Math.min(h - 1, i)) * w + l];
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += at(i);
      for (let i = 0; i < len; i++) { t[horiz ? l * w + i : i * w + l] = acc / (2 * r + 1); acc += at(i + r + 1) - at(i - r); }
    }
    [s, t] = [t, s];
  }
  return s;
}

/** The five 256-entry tables of PS Arbitrary Map (master, red, green, blue, alpha) from an .amp file in hex: 768
 *  bytes fill red, green and blue; other sizes fill from the master on; the rest stays identity. */
const arbCache = new Map<string, Uint8Array>();
export function arbTables(hex: string): Uint8Array {
  const key = hex.replace(/[^0-9a-f]/gi, '');
  let t = arbCache.get(key);
  if (t) return t;
  t = new Uint8Array(1280);
  for (let i = 0; i < 1280; i++) t[i] = i & 255;
  const bytes = new Uint8Array(Math.min(1280, key.length >> 1));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(key.substr(i * 2, 2), 16);
  t.set(bytes, bytes.length === 768 ? 256 : 0);
  arbCache.set(key, t);
  return t;
}
