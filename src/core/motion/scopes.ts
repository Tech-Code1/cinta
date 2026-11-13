// Lumetri Scopes («Ámbitos de Lumetri», AE's Window ▸ Lumetri Scopes): waveform (RGB, Luma, YC, YC without
// chroma), YUV vectorscope (75 % / 100 % targets, skin-tone line) and HLS vectorscope, histogram and parade of a
// frame. Pure TypeScript over RGBA pixels (a downsampled copy of the frame), so the panel computes it in a worker
// while playing and the MCP server with the same code. Names and options as in After Effects'
// Lumetri Scopes panel.

export type ScopeKind = 'vectorYUV' | 'vectorHLS' | 'histogram' | 'parade' | 'waveform';
export type WaveformType = 'rgb' | 'luma' | 'yc' | 'ycNoChroma';
export type ParadeType = 'rgb' | 'rgbWhite' | 'yuv' | 'yuvWhite';
export type ScopeColorSpace = 'auto' | '601' | '709' | '2020' | '2100hlg' | '2100pq';
export type ScopePrecision = '8bit' | 'float' | 'hdr';
export type ScopeBrightness = 'bright' | 'normal' | 'dimmed';
export interface ScopeSettings {
  scopes: ScopeKind[];
  waveform: WaveformType;
  parade: ParadeType;
  colorSpace: ScopeColorSpace;
  precision: ScopePrecision;
  clamp: boolean;
  brightness: ScopeBrightness;
}

export const SCOPE_NAMES: Record<ScopeKind, string> = { vectorYUV: 'Vectorescopio YUV', vectorHLS: 'Vectorescopio HLS', histogram: 'Histograma', parade: 'Exposición', waveform: 'Forma de onda' };
export const WAVEFORM_TYPES: [WaveformType, string][] = [['rgb', 'RGB'], ['luma', 'Luminancia'], ['yc', 'YC'], ['ycNoChroma', 'YC sin cromacidad']];
export const PARADE_TYPES: [ParadeType, string][] = [['rgb', 'RGB'], ['rgbWhite', 'RGB blanco'], ['yuv', 'YUV'], ['yuvWhite', 'YUV blanco']];
export const COLOR_SPACES: [ScopeColorSpace, string][] = [['auto', 'Automático'], ['601', 'Rec. 601'], ['709', 'Rec 709'], ['2020', 'Rec. 2020'], ['2100hlg', 'Rec. 2100 HLG'], ['2100pq', 'Rec. 2100 PQ']];
export const PRECISIONS: [ScopePrecision, string][] = [['8bit', '8 bits'], ['float', 'Flotante'], ['hdr', 'HDR']];
export const BRIGHTNESS: [ScopeBrightness, string][] = [['bright', 'Brillante'], ['normal', 'Normal'], ['dimmed', 'Atenuado']];

/** Presets of the panel's menu (Ajustes preestablecidos): the scopes each one shows and how. */
export const SCOPE_PRESETS: { id: string; name: string; s: Partial<ScopeSettings> }[] = [
  { id: 'premiere4', name: 'Ámbito YUV (flotante, sin fijación) de Premiere 4', s: { scopes: ['vectorYUV', 'histogram', 'parade', 'waveform'], waveform: 'yc', parade: 'yuv', precision: 'float', clamp: false } },
  { id: 'speedgrade4', name: 'Ámbito de luminancia/RGB (601 SD) de Speedgrade 4', s: { scopes: ['vectorYUV', 'histogram', 'parade', 'waveform'], waveform: 'luma', parade: 'rgb', colorSpace: '601', precision: '8bit' } },
  { id: 'allRGB', name: 'Todos los ámbitos RGB', s: { scopes: ['vectorHLS', 'histogram', 'parade', 'waveform'], waveform: 'rgb', parade: 'rgb' } },
  { id: 'allYUV', name: 'Todos los ámbitos YUV/YC', s: { scopes: ['vectorYUV', 'histogram', 'parade', 'waveform'], waveform: 'yc', parade: 'yuv' } },
  { id: 'histogram', name: 'Histograma', s: { scopes: ['histogram'] } },
  { id: 'paradeRGB', name: 'RGB Parade', s: { scopes: ['parade'], parade: 'rgb' } },
  { id: 'paradeRGBWaveformYC', name: 'RGB Parade/Forma de onda YC', s: { scopes: ['parade', 'waveform'], parade: 'rgb', waveform: 'yc' } },
  { id: 'paradeWaveformRGB', name: 'Parade/Forma de onda RGB', s: { scopes: ['parade', 'waveform'], parade: 'rgb', waveform: 'rgb' } },
  { id: 'vectorscopeYUV', name: 'Vectorescopio YUV', s: { scopes: ['vectorYUV'] } },
  { id: 'vectorParadeRGBWaveformYC', name: 'Vectorescopio YUV/RGB Parade/Forma de onda YC', s: { scopes: ['vectorYUV', 'parade', 'waveform'], parade: 'rgb', waveform: 'yc' } },
  { id: 'vectorParadeYUVWaveformYC', name: 'Vectorescopio YUV/YUV Parade/Forma de onda YC', s: { scopes: ['vectorYUV', 'parade', 'waveform'], parade: 'yuv', waveform: 'yc' } },
  { id: 'waveformRGB', name: 'Forma de onda RGB', s: { scopes: ['waveform'], waveform: 'rgb' } },
];
export const SCOPE_DEFAULTS: ScopeSettings = { scopes: ['vectorYUV', 'parade', 'waveform'], waveform: 'yc', parade: 'rgb', colorSpace: 'auto', precision: '8bit', clamp: true, brightness: 'normal' };
export function applyPreset(s: ScopeSettings, id: string): ScopeSettings {
  const p = SCOPE_PRESETS.find((x) => x.id === id);
  return p ? { ...SCOPE_DEFAULTS, ...s, ...p.s, scopes: [...(p.s.scopes ?? s.scopes)] } : s;
}

/** Luma weights (Kr, Kb) of a colour space; Automatic is Rec. 709 (the comp's working space). */
export function lumaWeights(cs: ScopeColorSpace): [number, number] {
  if (cs === '601') return [0.299, 0.114];
  if (cs === '2020' || cs === '2100hlg' || cs === '2100pq') return [0.2627, 0.0593];
  return [0.2126, 0.0722];
}
/** Y, Cb, Cr (Cb, Cr in −0.5…0.5) of an RGB colour (0…1). */
export function ycbcr(r: number, g: number, b: number, cs: ScopeColorSpace): [number, number, number] {
  const [kr, kb] = lumaWeights(cs), y = kr * r + (1 - kr - kb) * g + kb * b;
  return [y, (b - y) / (2 * (1 - kb)), (r - y) / (2 * (1 - kr))];
}
/** HLS of an RGB colour: hue 0…360, lightness and saturation 0…1. */
export function hls(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-9) return [0, l, 0];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, l, s];
}
/** Angle (degrees, counter-clockwise from +Cb) and radius of a colour on the YUV vectorscope. */
export function vectorPos(r: number, g: number, b: number, cs: ScopeColorSpace): [number, number] {
  const [, cb, cr] = ycbcr(r, g, b, cs);
  return [((Math.atan2(cr, cb) * 180) / Math.PI + 360) % 360, Math.hypot(cb, cr)];
}
/** The skin-tone line of the vectorscope (the «I» line, 123° from +Cb). */
export const SKIN_TONE_DEG = 123;
/** chroma that reaches the edge of the vectorscope's circle */
const VS_FULL = 0.62;

// ───────────────────────── numbers (MCP, tests) ─────────────────────────
export interface ScopeData {
  width: number; height: number;
  /** 256 bins each */
  histogram: { r: number[]; g: number[]; b: number[]; luma: number[] };
  /** per column (≤ 256): min / max of luma (0…1) and of each channel */
  waveform: { columns: number; lumaMin: number[]; lumaMax: number[]; rMin: number[]; rMax: number[]; gMin: number[]; gMax: number[]; bMin: number[]; bMax: number[] };
  vectorscope: { meanCb: number; meanCr: number; meanChroma: number; maxChroma: number; hueDeg: number; over75: number; over100: number; skinToneDeviationDeg: number | null };
  hls: { meanHue: number; meanLightness: number; meanSaturation: number };
  luma: { min: number; max: number; mean: number };
}

export function scopeData(px: Uint8ClampedArray | Uint8Array, w: number, h: number, cs: ScopeColorSpace = 'auto', columns = 256): ScopeData {
  const H = { r: new Array<number>(256).fill(0), g: new Array<number>(256).fill(0), b: new Array<number>(256).fill(0), luma: new Array<number>(256).fill(0) };
  const cols = Math.max(1, Math.min(columns, w));
  const mk = (v: number) => new Array<number>(cols).fill(v);
  const wf = { columns: cols, lumaMin: mk(1), lumaMax: mk(0), rMin: mk(1), rMax: mk(0), gMin: mk(1), gMax: mk(0), bMin: mk(1), bMax: mk(0) };
  let scb = 0, scr = 0, sch = 0, mxc = 0, o75 = 0, o100 = 0, n = 0, ly = 0, lmin = 1, lmax = 0, hx = 0, hy = 0, sl = 0, ss = 0;
  // the 75 % / 100 % targets: chroma of the fully saturated colour of each pixel's hue (per degree)
  const full = Array.from({ length: 360 }, (_, d) => { const k = (n0: number) => { const t = (n0 + d / 30) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(t - 3, 9 - t, 1)); }; return vectorPos(k(0), k(8), k(4), cs)[1]; });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (px[i + 3] === 0) continue;
    const R = px[i], G = px[i + 1], B = px[i + 2], r = R / 255, g = G / 255, b = B / 255;
    const [Y, cb, cr] = ycbcr(r, g, b, cs), c = Math.hypot(cb, cr);
    H.r[R]++; H.g[G]++; H.b[B]++; H.luma[Math.max(0, Math.min(255, Math.round(Y * 255)))]++;
    const col = Math.min(cols - 1, Math.floor((x * cols) / w));
    if (Y < wf.lumaMin[col]) wf.lumaMin[col] = Y; if (Y > wf.lumaMax[col]) wf.lumaMax[col] = Y;
    if (r < wf.rMin[col]) wf.rMin[col] = r; if (r > wf.rMax[col]) wf.rMax[col] = r;
    if (g < wf.gMin[col]) wf.gMin[col] = g; if (g > wf.gMax[col]) wf.gMax[col] = g;
    if (b < wf.bMin[col]) wf.bMin[col] = b; if (b > wf.bMax[col]) wf.bMax[col] = b;
    scb += cb; scr += cr; sch += c; if (c > mxc) mxc = c;
    const [hh, l, s] = hls(r, g, b), fc = full[Math.floor(hh) % 360];
    if (c > fc * 0.75 + 1e-6) o75++; if (c > fc * 1.0001) o100++;
    ly += Y; if (Y < lmin) lmin = Y; if (Y > lmax) lmax = Y;
    hx += Math.cos((hh * Math.PI) / 180) * s; hy += Math.sin((hh * Math.PI) / 180) * s; sl += l; ss += s;
    n++;
  }
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const N = n || 1, hue = ((Math.atan2(scr, scb) * 180) / Math.PI + 360) % 360;
  const dev = sch / N > 0.02 ? ((hue - SKIN_TONE_DEG + 540) % 360) - 180 : null;
  return {
    width: w, height: h, histogram: H,
    waveform: Object.fromEntries(Object.entries(wf).map(([k, v]) => [k, Array.isArray(v) ? v.map(r4) : v])) as ScopeData['waveform'],
    vectorscope: { meanCb: r4(scb / N), meanCr: r4(scr / N), meanChroma: r4(sch / N), maxChroma: r4(mxc), hueDeg: r4(hue), over75: r4(o75 / N), over100: r4(o100 / N), skinToneDeviationDeg: dev === null ? null : r4(dev) },
    hls: { meanHue: r4(((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360), meanLightness: r4(sl / N), meanSaturation: r4(ss / N) },
    luma: { min: r4(n ? lmin : 0), max: r4(lmax), mean: r4(ly / N) },
  };
}

// ───────────────────────── pictures ─────────────────────────
type RGB = [number, number, number];
const GAIN: Record<ScopeBrightness, number> = { bright: 1.8, normal: 1, dimmed: 0.55 };
class Raster {
  d: Uint8ClampedArray;
  constructor(public w: number, public h: number) { this.d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { this.d[i * 4] = 18; this.d[i * 4 + 1] = 19; this.d[i * 4 + 2] = 22; this.d[i * 4 + 3] = 255; } }
  /** adds light (additive, like a CRT trace) */
  add(x: number, y: number, c: RGB, a: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4;
    this.d[i] += c[0] * a; this.d[i + 1] += c[1] * a; this.d[i + 2] += c[2] * a;
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 0.35) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let k = 0; k <= n; k++) this.add(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), c, a);
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 0.6) { this.line(x, y, x + w, y, c, a); this.line(x + w, y, x + w, y + h, c, a); this.line(x + w, y + h, x, y + h, c, a); this.line(x, y + h, x, y, c, a); }
  circle(cx: number, cy: number, r: number, c: RGB, a = 0.3) { const n = Math.max(16, Math.ceil(r * 6)); let px = cx + r, py = cy; for (let k = 1; k <= n; k++) { const t = (k / n) * Math.PI * 2, x = cx + r * Math.cos(t), y = cy + r * Math.sin(t); this.line(px, py, x, y, c, a); px = x; py = y; } }
}
const GRID: RGB = [110, 110, 110];
/** where a value (0…1 of the signal) sits on the vertical axis of the precision's scale (0 = bottom, 1 = top) */
export function axisPos(v: number, precision: ScopePrecision): number {
  if (precision !== 'hdr') return v;
  // HDR: a PQ scale of 0…10000 nits, the SDR signal reaching 100 nits
  const L = Math.max(0, v) * 100 / 10000, m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const p = Math.pow(L, m1);
  return Math.pow((c1 + c2 * p) / (1 + c3 * p), m2);
}
/** graticule of a vertical scale: values (signal 0…1) and labels */
export function axisTicks(precision: ScopePrecision, luma = false): [number, string][] {
  if (precision === '8bit') return luma ? [[0, '0'], [0.2, '20'], [0.4, '40'], [0.6, '60'], [0.8, '80'], [1, '100']] : [[0, '0'], [64 / 255, '64'], [128 / 255, '128'], [192 / 255, '192'], [1, '255']];
  if (precision === 'float') return [[0, '0.0'], [0.25, '0.25'], [0.5, '0.5'], [0.75, '0.75'], [1, '1.0']];
  return [[0, '0'], [0.01, '1'], [0.1, '10'], [1, '100'], [10, '1000'], [100, '10000']];
}

function waveformInto(R: Raster, x0: number, wd: number, px: Uint8ClampedArray | Uint8Array, w: number, h: number, chans: { f: (r: number, g: number, b: number) => number; c: RGB }[], s: ScopeSettings) {
  const H = R.h, g = GAIN[s.brightness], per = (h * w) / wd, norm = Math.max(1, per / 30);
  const cnt = new Float32Array(wd * H);
  for (const ch of chans) {
    cnt.fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 0) continue;
      let v = ch.f(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
      if (s.clamp) v = Math.max(0, Math.min(1, v));
      const Y = Math.round((1 - axisPos(v, s.precision) * 0.9 - 0.05) * (H - 1));
      if (Y < 0 || Y >= H) continue;
      cnt[Y * wd + Math.min(wd - 1, Math.floor((x * wd) / w))]++;
    }
    for (let k = 0; k < cnt.length; k++) if (cnt[k]) R.add(x0 + (k % wd), Math.floor(k / wd), ch.c, 1 - Math.exp((-g * cnt[k] * 1.6) / norm));
  }
  for (const [v] of axisTicks(s.precision, s.waveform === 'luma')) { const Y = Math.round((1 - axisPos(v, s.precision) * 0.9 - 0.05) * (H - 1)); R.line(x0, Y, x0 + wd - 1, Y, GRID, 0.35); }
}

/** One scope drawn into W × H RGBA pixels (graticule included, labels are the panel's). */
export function rasterScope(kind: ScopeKind, px: Uint8ClampedArray | Uint8Array, w: number, h: number, s: ScopeSettings, W: number, H: number): Uint8ClampedArray {
  const R = new Raster(Math.max(8, W), Math.max(8, H)), cs = s.colorSpace, gain = GAIN[s.brightness];
  const Yf = (r: number, g: number, b: number) => ycbcr(r, g, b, cs)[0];
  if (kind === 'waveform') {
    const wt = s.waveform;
    const chans = wt === 'rgb' ? [{ f: (r: number) => r, c: [255, 60, 60] as RGB }, { f: (_r: number, g: number) => g, c: [60, 255, 60] as RGB }, { f: (_r: number, _g: number, b: number) => b, c: [70, 110, 255] as RGB }]
      : wt === 'yc' ? [{ f: (r: number, g: number, b: number) => { const [y, cb, cr] = ycbcr(r, g, b, cs); return y + Math.hypot(cb, cr); }, c: [60, 110, 255] as RGB }, { f: (r: number, g: number, b: number) => { const [y, cb, cr] = ycbcr(r, g, b, cs); return y - Math.hypot(cb, cr); }, c: [60, 110, 255] as RGB }, { f: Yf, c: [120, 255, 140] as RGB }]
        : [{ f: Yf, c: wt === 'luma' ? [235, 235, 235] as RGB : [120, 255, 140] as RGB }];
    waveformInto(R, 0, R.w, px, w, h, chans, s);
  } else if (kind === 'parade') {
    const third = Math.floor(R.w / 3), pt = s.parade;
    const yuv = pt === 'yuv' || pt === 'yuvWhite', white = pt === 'rgbWhite' || pt === 'yuvWhite';
    const fs = yuv ? [Yf, (r: number, g: number, b: number) => ycbcr(r, g, b, cs)[1] + 0.5, (r: number, g: number, b: number) => ycbcr(r, g, b, cs)[2] + 0.5] : [(r: number) => r, (_r: number, g: number) => g, (_r: number, _g: number, b: number) => b];
    const cols: RGB[] = white ? [[235, 235, 235], [235, 235, 235], [235, 235, 235]] : yuv ? [[235, 235, 235], [70, 110, 255], [255, 60, 60]] : [[255, 60, 60], [60, 255, 60], [70, 110, 255]];
    const sub = new Raster(third, R.h);
    fs.forEach((f, k) => {
      sub.d.set(new Raster(third, R.h).d);
      waveformInto(sub, 0, third, px, w, h, [{ f, c: cols[k] }], s);
      for (let y = 0; y < R.h; y++) R.d.set(sub.d.subarray(y * third * 4, (y + 1) * third * 4), (y * R.w + k * third) * 4);
    });
    for (let k = 1; k < 3; k++) R.line(k * third, 0, k * third, R.h - 1, GRID, 0.6);
  } else if (kind === 'histogram') {
    const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let i = 0; i < w * h; i++) { if (px[i * 4 + 3] === 0) continue; for (let c = 0; c < 3; c++) bins[c][px[i * 4 + c]]++; }
    // AE's histogram lies on its side: levels bottom (0) to top (255), counts to the right
    const mx = Math.max(1, ...bins.flatMap((b) => [...b].sort((a, z) => z - a).slice(2, 3)));
    const cols: RGB[] = [[255, 60, 60], [60, 255, 60], [70, 110, 255]];
    for (let lv = 0; lv < 256; lv++) {
      const Y = Math.round((1 - axisPos(lv / 255, s.precision) * 0.9 - 0.05) * (R.h - 1));
      for (let c = 0; c < 3; c++) {
        const len = Math.min(R.w - 1, Math.round((Math.min(1.2, bins[c][lv] / mx) / 1.2) * (R.w - 2) * Math.min(1, gain)));
        for (let x = 0; x <= len; x++) R.add(x, Y, cols[c], 0.55);
      }
    }
    for (const [v] of axisTicks(s.precision)) { const Y = Math.round((1 - axisPos(v, s.precision) * 0.9 - 0.05) * (R.h - 1)); R.line(0, Y, R.w - 1, Y, GRID, 0.3); }
  } else {
    // vectorscopes: a square in the middle of the tile
    const side = Math.min(R.w, R.h), cx = R.w / 2, cy = R.h / 2, rad = side * 0.46;
    const cnt = new Float32Array(R.w * R.h);
    const hlsMode = kind === 'vectorHLS', redDeg = vectorPos(1, 0, 0, cs)[0];
    for (let i = 0; i < w * h; i++) {
      if (px[i * 4 + 3] === 0) continue;
      const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
      let X: number, Y: number;
      if (hlsMode) { const [hh, , sat] = hls(r, g, b); const a = ((redDeg + hh) * Math.PI) / 180; X = cx + Math.cos(a) * sat * rad; Y = cy - Math.sin(a) * sat * rad; }
      else { const [, cb, cr] = ycbcr(r, g, b, cs); X = cx + (cb / VS_FULL) * rad; Y = cy - (cr / VS_FULL) * rad; }
      const xi = Math.round(X), yi = Math.round(Y);
      if (xi >= 0 && yi >= 0 && xi < R.w && yi < R.h) cnt[yi * R.w + xi]++;
    }
    const norm = Math.max(1, (w * h) / 3000);
    for (let k = 0; k < cnt.length; k++) if (cnt[k]) R.add(k % R.w, Math.floor(k / R.w), [190, 255, 200], 1 - Math.exp((-gain * cnt[k] * 2) / norm));
    R.circle(cx, cy, rad, GRID, 0.5);
    R.line(cx - rad, cy, cx + rad, cy, GRID, 0.25); R.line(cx, cy - rad, cx, cy + rad, GRID, 0.25);
    if (hlsMode) {
      for (const f of [0.25, 0.5, 0.75]) R.circle(cx, cy, rad * f, GRID, 0.2);
      // the hues of the six colours on the rim
      [0, 60, 120, 180, 240, 300].forEach((hh, k) => { const a = ((redDeg + hh) * Math.PI) / 180; const c = [[255, 60, 60], [255, 230, 60], [60, 255, 60], [60, 230, 255], [70, 110, 255], [255, 60, 255]][k] as RGB; R.rect(Math.round(cx + Math.cos(a) * rad) - 3, Math.round(cy - Math.sin(a) * rad) - 3, 6, 6, c, 0.9); });
    } else {
      // 75 % (small boxes) and 100 % targets of the six colours, and the skin-tone line
      const tg: [RGB, RGB][] = [[[1, 0, 0], [255, 60, 60]], [[1, 0, 1], [255, 60, 255]], [[0, 0, 1], [70, 110, 255]], [[0, 1, 1], [60, 230, 255]], [[0, 1, 0], [60, 255, 60]], [[1, 1, 0], [255, 230, 60]]];
      for (const [rgb, c] of tg) for (const lv of [0.75, 1]) {
        const [, cb, cr] = ycbcr(rgb[0] * lv, rgb[1] * lv, rgb[2] * lv, cs);
        const X = Math.round(cx + (cb / VS_FULL) * rad), Y = Math.round(cy - (cr / VS_FULL) * rad), bs = lv === 1 ? 7 : 4;
        R.rect(X - bs / 2, Y - bs / 2, bs, bs, c, 0.85);
      }
      const a = (SKIN_TONE_DEG * Math.PI) / 180;
      R.line(cx, cy, cx + Math.cos(a) * rad, cy - Math.sin(a) * rad, [230, 180, 140], 0.45);
    }
  }
  return R.d;
}

/** Tiles of the panel for n scopes in W × H (vectorscopes square on the left when shown with others). */
export function scopeLayout(kinds: ScopeKind[], W: number, H: number): { kind: ScopeKind; x: number; y: number; w: number; h: number }[] {
  const n = kinds.length;
  if (!n) return [];
  if (n === 1) return [{ kind: kinds[0], x: 0, y: 0, w: W, h: H }];
  const vec: ScopeKind[] = kinds.filter((k) => k === 'vectorYUV' || k === 'vectorHLS'), rest = kinds.filter((k) => !vec.includes(k));
  if (n === 2) return W >= H ? kinds.map((k, i) => ({ kind: k, x: Math.round((i * W) / 2), y: 0, w: Math.round(W / 2), h: H })) : kinds.map((k, i) => ({ kind: k, x: 0, y: Math.round((i * H) / 2), w: W, h: Math.round(H / 2) }));
  // a grid of 2 columns (3 → vectorscope on the left, the others stacked on the right)
  if (n === 3 && vec.length === 1) {
    const vw = Math.round(Math.min(W / 2, H));
    return [{ kind: vec[0], x: 0, y: 0, w: vw, h: H }, ...rest.map((k, i) => ({ kind: k, x: vw, y: Math.round((i * H) / rest.length), w: W - vw, h: Math.round(H / rest.length) }))];
  }
  const cols = 2, rows = Math.ceil(n / cols), ordered = [...vec, ...rest];
  return ordered.map((k, i) => ({ kind: k, x: Math.round(((i % cols) * W) / cols), y: Math.round((Math.floor(i / cols) * H) / rows), w: Math.round(W / cols), h: Math.round(H / rows) }));
}

/** The whole panel picture (MCP image): every scope of the settings in its tile. */
export function rasterScopes(px: Uint8ClampedArray | Uint8Array, w: number, h: number, s: ScopeSettings, W: number, H: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = 10; out[i * 4 + 1] = 10; out[i * 4 + 2] = 12; out[i * 4 + 3] = 255; }
  for (const t of scopeLayout(s.scopes, W, H)) {
    const tw = Math.max(8, t.w - 2), th = Math.max(8, t.h - 2), d = rasterScope(t.kind, px, w, h, s, tw, th);
    for (let y = 0; y < th && t.y + 1 + y < H; y++) out.set(d.subarray(y * tw * 4, (y * tw + Math.min(tw, W - t.x - 1)) * 4), ((t.y + 1 + y) * W + t.x + 1) * 4);
  }
  return out;
}
