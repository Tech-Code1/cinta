// Layer styles, drawn on the layer canvas (layer space) after masks and effects. Photoshop's order: drop shadow
// and outer glow behind the layer; colour / gradient overlays, inner glow, inner shadow and bevel clipped to it;
// the stroke last.
import { parseColor } from '../core/motion/anim';
import { STYLE_ORDER } from '../core/motion/styles';
import { blurCanvas, ctx2d, mk, type FxCtx } from './fx';

type Params = Record<string, unknown>;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rgba = (c: unknown, a = 1) => { const [r, g, b, al] = parseColor(String(c ?? '#000')); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${al * a})`; };
const rad = (d: number) => (d * Math.PI) / 180;
const clone = (cv: HTMLCanvasElement) => { const c = mk(cv.width, cv.height); ctx2d(c).drawImage(cv, 0, 0); return c; };

/** The layer's alpha filled with a colour. */
function silhouette(cv: HTMLCanvasElement, color: unknown): HTMLCanvasElement {
  const s = clone(cv);
  const g = ctx2d(s);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = rgba(color, 1);
  g.fillRect(0, 0, s.width, s.height);
  return s;
}
/** Everything outside the layer's alpha, filled with a colour (for inner shadow / glow). */
function inverse(cv: HTMLCanvasElement, color: unknown): HTMLCanvasElement {
  const s = mk(cv.width, cv.height);
  const g = ctx2d(s);
  g.fillStyle = rgba(color, 1);
  g.fillRect(0, 0, s.width, s.height);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(cv, 0, 0);
  return s;
}
/** Grows (r > 0) the alpha by drawing it around a circle, like the stroke of a path. */
function dilate(sil: HTMLCanvasElement, r: number): HTMLCanvasElement {
  if (r < 0.5) return sil;
  const out = mk(sil.width, sil.height);
  const g = ctx2d(out);
  const steps = Math.max(8, Math.ceil(r * 2));
  for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; g.drawImage(sil, Math.cos(a) * r, Math.sin(a) * r); }
  for (let k = r / 2; k > 0.5; k /= 2) for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.drawImage(sil, Math.cos(a) * k, Math.sin(a) * k); }
  g.drawImage(sil, 0, 0);
  return out;
}
/** Blur with a spread / choke: the soft edge is pushed towards opaque by `spread` (0…1). */
function softEdge(src: HTMLCanvasElement, size: number, spread: number): HTMLCanvasElement {
  const grown = spread > 0 ? dilate(src, size * spread) : src;
  const b = size * (1 - spread) > 0.5 ? blurCanvas(grown, (size * (1 - spread)) / 2) : grown;
  return b;
}
function stamp(g: CanvasRenderingContext2D, src: HTMLCanvasElement, opacity: number, dx = 0, dy = 0) {
  for (let r = opacity; r > 0; r -= 1) { g.globalAlpha = Math.min(1, r); g.drawImage(src, dx, dy); }
  g.globalAlpha = 1;
}

/** Extra layer px the styles may draw outside the layer (shadow distance + size, glow, outside stroke). */
export function styleGrowth(styles: { fx: string; on: boolean; p: Params }[]): number {
  let g = 0;
  for (const { fx, on, p } of styles) {
    if (!on) continue;
    if (fx === 'dropShadow') g = Math.max(g, num(p.distance, 5) + num(p.size, 5) * 1.6 + 2);
    else if (fx === 'outerGlow') g = Math.max(g, num(p.size, 5) * 1.6 + 2);
    else if (fx === 'stroke' && p.position !== 'inside') g = Math.max(g, num(p.size, 3) + 2);
    else if (fx === 'bevel' && p.style !== 'inner') g = Math.max(g, num(p.size, 5) + 2);
  }
  return Math.ceil(g);
}

export function applyStyles(cv: HTMLCanvasElement, styles: { fx: string; on: boolean; p: Params }[], x: FxCtx): HTMLCanvasElement {
  const on = styles.filter((s) => s.on).sort((a, b) => STYLE_ORDER.indexOf(a.fx as never) - STYLE_ORDER.indexOf(b.fx as never));
  if (!on.length) return cv;
  const W = cv.width, H = cv.height, res = x.res;
  const behind = mk(W, H), bg = ctx2d(behind);
  let layer = clone(cv);
  const over = (fn: (g: CanvasRenderingContext2D) => void) => { const g = ctx2d(layer); g.save(); g.globalCompositeOperation = 'source-atop'; fn(g); g.restore(); };
  let stroke: HTMLCanvasElement | null = null;
  for (const { fx, p } of on) {
    const op = num(p.opacity, 75) / 100;
    if (fx === 'dropShadow') {
      const a = rad(num(p.angle, 120)), d = num(p.distance, 5) * res;
      const sh = softEdge(silhouette(cv, p.color), num(p.size, 5) * res, num(p.spread) / 100);
      // the light comes from `angle` (After Effects: 120° = upper left), the shadow falls the other way
      stamp(bg, sh, op, -Math.cos(a) * d, Math.sin(a) * d);
    } else if (fx === 'outerGlow') {
      stamp(bg, softEdge(silhouette(cv, p.color), num(p.size, 5) * res, num(p.spread) / 100), op * 1.4);
    } else if (fx === 'colorOverlay') {
      over((g) => { g.globalAlpha = num(p.opacity, 100) / 100; g.fillStyle = rgba(p.color, 1); g.fillRect(0, 0, W, H); });
    } else if (fx === 'gradientOverlay') {
      over((g) => {
        const k = num(p.scale, 100) / 100, a = rad(num(p.angle, 90)), rev = !!num(p.reverse);
        const cx = W / 2, cy = H / 2, len = (Math.abs(Math.cos(a)) * W + Math.abs(Math.sin(a)) * H) / 2 * k;
        const gr = p.type === 'radial' ? g.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(W, H) / 2 * k) : g.createLinearGradient(cx - Math.cos(a) * len, cy + Math.sin(a) * len, cx + Math.cos(a) * len, cy - Math.sin(a) * len);
        gr.addColorStop(0, rgba(rev ? p.endColor : p.startColor)); gr.addColorStop(1, rgba(rev ? p.startColor : p.endColor));
        g.globalAlpha = num(p.opacity, 100) / 100; g.fillStyle = gr; g.fillRect(0, 0, W, H);
      });
    } else if (fx === 'innerGlow') {
      const size = num(p.size, 5) * res, choke = num(p.choke) / 100;
      // edge: light coming in from outside the shape; centre: the shape itself, eroded by the blur
      const src = p.source === 'center' ? silhouette(cv, p.color) : inverse(cv, p.color);
      let glow = softEdge(src, size, choke);
      if (p.source === 'center') { const e = mk(W, H), eg = ctx2d(e); eg.fillStyle = rgba(p.color); eg.fillRect(0, 0, W, H); eg.globalCompositeOperation = 'destination-out'; eg.drawImage(glow, 0, 0); glow = e; }
      over((g) => { g.globalCompositeOperation = 'source-atop'; stamp(g, glow, op * 1.4); });
    } else if (fx === 'innerShadow') {
      const a = rad(num(p.angle, 120)), d = num(p.distance, 5) * res;
      const sh = softEdge(inverse(cv, p.color), num(p.size, 5) * res, num(p.choke) / 100);
      over((g) => stamp(g, sh, op, -Math.cos(a) * d, Math.sin(a) * d));
    } else if (fx === 'bevel') {
      layer = bevel(layer, cv, p, res, behind);
    } else if (fx === 'stroke') {
      const sz = num(p.size, 3) * res, sil = silhouette(cv, p.color);
      // the shape shrunk by r: itself minus everything within r of its outside
      const eroded = (r: number) => { const e = clone(sil), eg = ctx2d(e); eg.globalCompositeOperation = 'destination-out'; eg.drawImage(dilate(inverse(cv, '#000'), r), 0, 0); return e; };
      const band = mk(W, H), sg = ctx2d(band);
      if (p.position === 'inside') { sg.drawImage(sil, 0, 0); sg.globalCompositeOperation = 'destination-out'; sg.drawImage(eroded(sz), 0, 0); }
      else if (p.position === 'center') { sg.drawImage(dilate(sil, sz / 2), 0, 0); sg.globalCompositeOperation = 'destination-out'; sg.drawImage(eroded(sz / 2), 0, 0); }
      else { sg.drawImage(dilate(sil, sz), 0, 0); sg.globalCompositeOperation = 'destination-out'; sg.drawImage(cv, 0, 0); }
      stroke = mk(W, H);
      const tg = ctx2d(stroke);
      tg.globalAlpha = num(p.opacity, 100) / 100;
      tg.drawImage(band, 0, 0);
    }
  }
  const out = mk(W, H);
  const g = ctx2d(out);
  g.drawImage(behind, 0, 0);
  g.drawImage(layer, 0, 0);
  if (stroke) g.drawImage(stroke, 0, 0);
  return out;
}

/** Bevel & emboss: the blurred alpha is a height map lit from angle / altitude; highlight and shadow are screened /
 *  multiplied on the layer (inner, emboss, pillow) or on a rim around it (outer). */
function bevel(layer: HTMLCanvasElement, cv: HTMLCanvasElement, p: Params, res: number, behind: HTMLCanvasElement): HTMLCanvasElement {
  const W = cv.width, H = cv.height, size = Math.max(1, num(p.size, 5) * res);
  const style = String(p.style ?? 'inner');
  const height = blurCanvas(silhouette(cv, '#fff'), size / 2);
  const hd = ctx2d(height).getImageData(0, 0, W, H).data;
  const src = ctx2d(cv).getImageData(0, 0, W, H).data;
  const a = rad(num(p.angle, 120)), alt = rad(num(p.altitude, 30));
  const lx = Math.cos(a) * Math.cos(alt), ly = -Math.sin(a) * Math.cos(alt), lz = Math.sin(alt);
  // slope of the height map: about 1 / size per px at the edge, so the surface tilts by about depth %
  const k = (num(p.depth, 100) / 100) * size * (p.direction === 'down' ? -1 : 1);
  const hi = mk(W, H), sh = mk(W, H);
  const hiImg = ctx2d(hi).createImageData(W, H), shImg = ctx2d(sh).createImageData(W, H);
  const [hr, hg, hb] = parseColor(String(p.highlightColor ?? '#fff')), [sr, sg, sb] = parseColor(String(p.shadowColor ?? '#000'));
  const flat = lz; // light on a flat surface: no change there
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4;
    const inside = src[i + 3] / 255;
    // where the effect shows: inner = inside the edge, outer = outside, emboss / pillow = both
    const w = style === 'inner' ? inside : style === 'outer' ? 1 - inside : 1;
    if (w <= 0.003) continue;
    const dx = (hd[i + 4 + 3] - hd[i - 4 + 3]) / 510, dy = (hd[i + W * 4 + 3] - hd[i - W * 4 + 3]) / 510;
    let nx = -dx * k, ny = -dy * k;
    if (style === 'pillow' && inside < 0.5) { nx = -nx; ny = -ny; }
    const nl = Math.hypot(nx, ny, 1);
    const shade = (nx * lx + ny * ly + lz) / nl - flat;
    if (shade > 0) { hiImg.data[i] = hr * 255; hiImg.data[i + 1] = hg * 255; hiImg.data[i + 2] = hb * 255; hiImg.data[i + 3] = Math.min(255, shade * 2 * 255 * w * (num(p.highlightOpacity, 75) / 100)); }
    else { shImg.data[i] = sr * 255; shImg.data[i + 1] = sg * 255; shImg.data[i + 2] = sb * 255; shImg.data[i + 3] = Math.min(255, -shade * 2 * 255 * w * (num(p.shadowOpacity, 75) / 100)); }
  }
  ctx2d(hi).putImageData(hiImg, 0, 0);
  ctx2d(sh).putImageData(shImg, 0, 0);
  const soft = num(p.soften) * res;
  const H2 = soft > 0.3 ? blurCanvas(hi, soft / 2) : hi, S2 = soft > 0.3 ? blurCanvas(sh, soft / 2) : sh;
  if (style === 'outer' || style === 'emboss' || style === 'pillow') {
    // the part outside the layer goes behind it
    const bgc = ctx2d(behind);
    const outside = (c: HTMLCanvasElement) => { const o = clone(c); const og = ctx2d(o); og.globalCompositeOperation = 'destination-out'; og.drawImage(cv, 0, 0); return o; };
    bgc.drawImage(outside(S2), 0, 0);
    bgc.drawImage(outside(H2), 0, 0);
  }
  const out = clone(layer);
  const g = ctx2d(out);
  g.globalCompositeOperation = 'source-atop';
  g.drawImage(S2, 0, 0);
  g.drawImage(H2, 0, 0);
  return out;
}
