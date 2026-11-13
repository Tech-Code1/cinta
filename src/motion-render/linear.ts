// Float compositing of a composition's layers, for the project's colour settings (After Effects' Project Settings ›
// Color: depth 8/16/32 bpc and «Blend Colors Using 1.0 Gamma»). Each layer is drawn on its own canvas as usual and
// blended here in floating point: in linear light when blending with gamma 1.0 (a red over green edge or a glow
// added on top mix as light does, without the dark fringes of blending gamma-encoded values), and keeping values
// over 1 between layers at 32 bpc (two bright layers added and then multiplied darker keep their highlights).
// The blend formulas are the W3C compositing ones the canvas uses, so a layer looks the same as in the 8-bit path
// when the settings are off.
import { ctx2d } from './fx';

export interface ColorSettings { depth: 8 | 16 | 32; blendGamma1: boolean }

const toLin = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; toLin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
export const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
// linear → 8-bit sRGB through a table fine enough for the darks (4096 steps per unit)
const ENC_N = 4096, encLut = new Uint8ClampedArray(ENC_N + 1);
for (let i = 0; i <= ENC_N; i++) encLut[i] = Math.round(enc(i / ENC_N) * 255);

type Sep = (b: number, s: number) => number;
const clamp1 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hardLight: Sep = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
const SEP: Record<string, Sep> = {
  normal: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'hard-light': hardLight,
  'soft-light': (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};
// the modes whose formulas only make sense in 0…1 (the rest also work on over-range values)
const NEEDS_UNIT = new Set(['screen', 'overlay', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

// non-separable modes (W3C): luminosity and saturation of the backdrop and source combined
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c: number[]) {
  const l = lum(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - n || 1);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (1 - l)) / (x - l || 1);
  return c;
}
const setLum = (c: number[], l: number) => { const d = l - lum(c[0], c[1], c[2]); return clipColor([c[0] + d, c[1] + d, c[2] + d]); };
const sat = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: number[], s: number) {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]), [lo, mid, hi] = idx, out = [0, 0, 0];
  if (c[hi] > c[lo]) { out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]); out[hi] = s; }
  return out;
}
const NONSEP: Record<string, (b: number[], s: number[]) => number[]> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b[0], b[1], b[2])),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b[0], b[1], b[2])),
  color: (b, s) => setLum(s, lum(b[0], b[1], b[2])),
  luminosity: (b, s) => setLum(b, lum(s[0], s[1], s[2])),
};

/** The float comp an adjustment layer is working on right now (CC Overbrights reads the values over 1 from it). */
export let overFloat: FloatComp | null = null;

/** A composition being built in floating point: premultiplied RGBA, linear or gamma-encoded as the settings say. */
export class FloatComp {
  readonly px: Float32Array;
  constructor(readonly w: number, readonly h: number, readonly cs: ColorSettings) { this.px = new Float32Array(w * h * 4); }
  /** working-space value (linear or gamma-encoded as the settings say) ↔ the canvas' 8-bit sRGB */
  dec(v: number) { return this.cs.blendGamma1 ? toLin[v] : v / 255; }

  /** Fills with an opaque colour (the comp background). */
  fill(rgb255: [number, number, number]) {
    const r = this.dec(rgb255[0]), g = this.dec(rgb255[1]), b = this.dec(rgb255[2]), p = this.px;
    for (let i = 0; i < p.length; i += 4) { p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = 1; }
  }

  /** Blends a layer drawn on its own canvas (same size) with a blend mode. */
  blend(cv: HTMLCanvasElement, mode: string) {
    const d = ctx2d(cv).getImageData(0, 0, this.w, this.h).data, p = this.px, over = this.cs.depth === 32;
    const sepF = SEP[mode] ?? SEP.normal, non = NONSEP[mode], unit = NEEDS_UNIT.has(mode) || !over;
    const cb = [0, 0, 0], cs = [0, 0, 0];
    for (let i = 0; i < p.length; i += 4) {
      const as = d[i + 3] / 255;
      if (as <= 0) continue;
      const ab = p[i + 3];
      for (let k = 0; k < 3; k++) { cs[k] = this.dec(d[i + k]); cb[k] = ab > 0 ? p[i + k] / ab : 0; }
      if (mode === 'add') {
        // linear dodge: the premultiplied sum (the canvas' «lighter»)
        for (let k = 0; k < 3; k++) p[i + k] += cs[k] * as;
        p[i + 3] = Math.min(1, ab + as);
      } else {
        if (unit) for (let k = 0; k < 3; k++) { cb[k] = clamp1(cb[k]); cs[k] = clamp1(cs[k]); }
        const mix = non ? non(cb, cs) : null;
        for (let k = 0; k < 3; k++) p[i + k] = (1 - ab) * cs[k] * as + (1 - as) * p[i + k] + as * ab * (mix ? mix[k] : sepF(cb[k], cs[k]));
        p[i + 3] = as + ab * (1 - as);
      }
      // 8 and 16 bpc are integer depths: nothing over 1 survives a layer
      if (!over) for (let k = 0; k < 3; k++) p[i + k] = Math.min(p[i + k], p[i + 3]);
    }
  }

  /** Writes the result on a canvas (8-bit sRGB, straight alpha, as canvases keep it); `adjust`: for an adjustment
   *  layer's effects, which can then read the float values (overFloat) until readFrom. */
  writeTo(cv: HTMLCanvasElement, adjust = false) {
    overFloat = adjust ? this : null;
    const g = ctx2d(cv), img = g.createImageData(this.w, this.h), o = img.data, p = this.px;
    for (let i = 0; i < p.length; i += 4) {
      const a = Math.min(1, p[i + 3]);
      if (a <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const v = clamp1(p[i + k] / p[i + 3]);
        o[i + k] = this.cs.blendGamma1 ? encLut[Math.round(v * ENC_N)] : Math.round(v * 255);
      }
      o[i + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
  }

  /** Reads a canvas back (after an adjustment layer worked on the result so far). */
  readFrom(cv: HTMLCanvasElement) {
    overFloat = null;
    const d = ctx2d(cv).getImageData(0, 0, this.w, this.h).data, p = this.px;
    for (let i = 0; i < p.length; i += 4) { const a = d[i + 3] / 255; p[i + 3] = a; for (let k = 0; k < 3; k++) p[i + k] = this.dec(d[i + k]) * a; }
  }
}
