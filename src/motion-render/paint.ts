// Drawing of the «Pintura» effect (paint tools, src/core/motion/paint.ts): the strokes of a layer, in order, on
// its source in layer space. Each stroke is a row of dabs (spacing, hardness, roundness, angle) accumulated with
// its flow and capped by its opacity; brush strokes lay their colour with their blend mode, clone strokes copy a
// source layer (time shift, offset), erasers take away the layer and paint, only paint, or only the last stroke.
import { parseColor } from '../core/motion/anim';
import { dabAlpha, dabCenters, dabStep, strokePoints, type PaintStroke } from '../core/motion/paint';
import type { FxInstance, Prop, PVal } from '../core/motion/model';
import { ctx2d, mk } from './fx';

export interface PaintSrc { cv: HTMLCanvasElement; ox: number; oy: number; res: number }
export interface PaintEnv {
  /** layer time (s from the layer's start) */
  tl: number;
  /** a stroke property now (keys, expressions) */
  ev: (p: Prop, path: string) => PVal;
  /** source of a clone stroke (layer px placement); null = nothing */
  source: (s: PaintStroke, i: number) => PaintSrc | null;
}
const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', add: 'lighter', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light', difference: 'difference',
  exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: number[]) => (Array.isArray(v) ? v.map((x, i) => num(x, d[i] ?? 0)) : d);

/** A round dab of diameter dpx (canvas px) with the hardness falloff, white. */
const tips = new Map<string, HTMLCanvasElement>();
function dabSprite(dpx: number, hardness: number): HTMLCanvasElement {
  const n = Math.max(1, Math.ceil(dpx) + 2), key = `${n}|${Math.round(dpx * 4)}|${Math.round(hardness)}`;
  let c = tips.get(key);
  if (c) return c;
  c = mk(n, n);
  const g = ctx2d(c, true), img = g.createImageData(n, n), r = dpx / 2, m = n / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    // 4 samples per pixel: small tips stay round
    let a = 0;
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) a += dabAlpha(Math.hypot(x + sx - m, y + sy - m), Math.max(0.5, r), hardness);
    const i = (y * n + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round((a / 4) * 255);
  }
  g.putImageData(img, 0, 0);
  if (tips.size > 200) tips.clear();
  tips.set(key, c);
  return c;
}

/** Coverage of a stroke (white, alpha = paint amount, opacity not applied) on a W × H canvas. */
function coverage(s: PaintStroke, base: string, W: number, H: number, ox: number, oy: number, res: number, env: PaintEnv): HTMLCanvasElement | null {
  const ev = (p: Prop, k: string) => env.ev(p, `${base}.${k}`);
  const pts0 = vec(ev(s.path, 'path'), []);
  if (pts0.length < 2) return null;
  const tr = { anchor: vec(ev(s.transform.anchor, 'transform.anchor'), [0, 0]), position: vec(ev(s.transform.position, 'transform.position'), [0, 0]), scale: vec(ev(s.transform.scale, 'transform.scale'), [100, 100]), rotation: num(ev(s.transform.rotation, 'transform.rotation')) };
  const pts = strokePoints(pts0, tr);
  const sc = Math.sqrt(Math.abs((tr.scale[0] / 100) * ((tr.scale[1] ?? tr.scale[0]) / 100)));
  const D = Math.max(0.1, num(ev(s.diameter, 'diameter'), 21)) * sc, hard = num(ev(s.hardness, 'hardness'), 0), round = Math.max(1, Math.min(100, num(ev(s.roundness, 'roundness'), 100))) / 100;
  const ang = num(ev(s.angle, 'angle')) + tr.rotation, flow = Math.max(0, Math.min(100, num(ev(s.flow, 'flow'), 100))) / 100;
  const centres = dabCenters(pts, dabStep(D, num(ev(s.spacing, 'spacing'), 25)), num(ev(s.start, 'start'), 0), num(ev(s.end, 'end'), 100));
  if (!centres.length || flow <= 0) return null;
  const C = mk(W, H), g = ctx2d(C), dpx = D * res, sp = dabSprite(dpx, hard), half = sp.width / 2;
  g.globalAlpha = flow;
  for (let i = 0; i + 1 < centres.length; i += 2) {
    const X = (centres[i] - ox) * res, Y = (centres[i + 1] - oy) * res;
    if (X < -dpx || Y < -dpx || X > W + dpx || Y > H + dpx) continue;
    if (round >= 0.999) { g.drawImage(sp, X - half, Y - half); continue; }
    g.setTransform(1, 0, 0, 1, X, Y);
    g.rotate((-ang * Math.PI) / 180);
    g.scale(1, round);
    g.drawImage(sp, -half, -half);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  return C;
}

/** Puts `paint` (colour, alpha = amount) on R through a channel set: RGBA blends, RGB keeps R's alpha, Alpha
 *  changes only the alpha (towards the paint's luminance). */
function lay(R: HTMLCanvasElement, paint: HTMLCanvasElement, mode: string, channels: string) {
  const g = ctx2d(R);
  if (channels !== 'rgb' && channels !== 'alpha') {
    g.globalCompositeOperation = BLEND[mode] ?? 'source-over';
    g.drawImage(paint, 0, 0);
    g.globalCompositeOperation = 'source-over';
    return;
  }
  const W = R.width, H = R.height, gr = ctx2d(R, true), base = gr.getImageData(0, 0, W, H), b = base.data;
  if (channels === 'rgb') {
    const T = mk(W, H), tg = ctx2d(T, true);
    tg.drawImage(R, 0, 0);
    tg.globalCompositeOperation = BLEND[mode] ?? 'source-over';
    tg.drawImage(paint, 0, 0);
    const t = tg.getImageData(0, 0, W, H).data;
    for (let i = 0; i < b.length; i += 4) if (b[i + 3]) { b[i] = t[i]; b[i + 1] = t[i + 1]; b[i + 2] = t[i + 2]; }
  } else {
    const p = ctx2d(paint, true).getImageData(0, 0, W, H).data;
    for (let i = 0; i < b.length; i += 4) {
      const k = p[i + 3] / 255;
      if (!k) continue;
      const lum = 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
      b[i + 3] = Math.round(b[i + 3] + (lum - b[i + 3]) * k);
    }
  }
  gr.putImageData(base, 0, 0);
}

/** Draws the paint effect over the layer's canvas (layer px → canvas px: (v − o) × res). */
export function drawPaint(cv: HTMLCanvasElement, fx: FxInstance, onTransparent: boolean, x: { res: number; ox: number; oy: number }, env: PaintEnv): HTMLCanvasElement {
  const strokes = fx.strokes ?? [];
  if (!strokes.length) return onTransparent ? mk(cv.width, cv.height) : cv;
  const W = cv.width, H = cv.height, { res, ox, oy } = x;
  // R: the result; S: what «Sólo pintar» erasers bring back (the source, less what erased the layer)
  const R = mk(W, H), S = mk(W, H);
  if (!onTransparent) { ctx2d(R).drawImage(cv, 0, 0); ctx2d(S).drawImage(cv, 0, 0); }
  const live = (s: PaintStroke) => env.tl >= s.in - 1e-6 && env.tl < s.out - 1e-6;
  const base = (s: PaintStroke) => `effects.${fx.id}.strokes.${s.id}`;
  const opac = (s: PaintStroke) => Math.max(0, Math.min(100, num(env.ev(s.opacity, `${base(s)}.opacity`), 100))) / 100;
  strokes.forEach((s, i) => {
    if (!live(s) || (s.kind === 'eraser' && s.erase === 'last')) return;
    const C = coverage(s, base(s), W, H, ox, oy, res, env);
    if (!C) return;
    const op = opac(s);
    if (op <= 0) return;
    if (s.kind === 'eraser') {
      const mask = (dst: HTMLCanvasElement, how: GlobalCompositeOperation) => { const g = ctx2d(dst); g.globalAlpha = op; g.globalCompositeOperation = how; g.drawImage(C, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; };
      if (s.erase === 'paint') {
        // the paint goes, the source shows again where it was
        const back = mk(W, H), bg = ctx2d(back);
        bg.drawImage(S, 0, 0); bg.globalAlpha = op; bg.globalCompositeOperation = 'destination-in'; bg.drawImage(C, 0, 0);
        mask(R, 'destination-out');
        const g = ctx2d(R); g.globalCompositeOperation = 'lighter'; g.drawImage(back, 0, 0); g.globalCompositeOperation = 'source-over';
      } else { mask(R, 'destination-out'); mask(S, 'destination-out'); }
      return;
    }
    // erasers of only this stroke cut its coverage
    for (const e of strokes) {
      if (e.kind !== 'eraser' || e.erase !== 'last' || e.target !== s.id || !live(e)) continue;
      const E = coverage(e, base(e), W, H, ox, oy, res, env);
      if (!E) continue;
      const g = ctx2d(C); g.globalAlpha = opac(e); g.globalCompositeOperation = 'destination-out'; g.drawImage(E, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    // the paint: a colour or the clone source, cut by the coverage and the opacity
    const paint = mk(W, H), pg = ctx2d(paint);
    if (s.kind === 'clone') {
      const src = env.source(s, i);
      if (!src) return;
      const first = vec(env.ev(s.transform.position, `${base(s)}.transform.position`), [0, 0]);
      const pos = vec(env.ev(s.clone!.position, `${base(s)}.clone.position`), first);
      const dx = pos[0] - first[0], dy = pos[1] - first[1];
      pg.drawImage(src.cv, (src.ox - dx - ox) * res, (src.oy - dy - oy) * res, (src.cv.width / src.res) * res, (src.cv.height / src.res) * res);
    } else {
      const [r, g, b] = parseColor(String(env.ev(s.color, `${base(s)}.color`) ?? '#000000'));
      pg.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      pg.fillRect(0, 0, W, H);
    }
    pg.globalAlpha = op;
    pg.globalCompositeOperation = 'destination-in';
    pg.drawImage(C, 0, 0);
    lay(R, paint, s.mode, String(env.ev(s.channels, `${base(s)}.channels`) ?? 'rgba'));
  });
  return R;
}
