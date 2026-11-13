// Drawing of the effects in src/core/motion/fx-groups/particulas.ts (Particle Playground, CC PS Classic / LE, Basic
// Text, Path Text, Vector Paint). Helpers come from ../fx: only use them inside the functions (fx.ts imports this file
// while it is still loading).
import type { FxFn, FxCtx, Params } from '../fx';
import { mk, ctx2d, blurCanvas } from '../fx';
import { IMPL_ESTILIZAR } from './estilizar';
import { fbm, parseColor } from '../../core/motion/anim';
import { psClassicToII, ppSimulate, ppDisplay, ppAffects, ppNew, ptPath, vpParse, vpVisible, PP_PARAMS, type PPEnv, type PPState } from '../../core/motion/fx-groups/particulas';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec2 = (v: unknown): [number, number] => (Array.isArray(v) ? [num(v[0]), num(v[1])] : [0, 0]);
/** an effect point (comp-style on text / shape layers) → layer px */
const lpt = (v: unknown, x: FxCtx): [number, number] => { const [a, b] = vec2(v); return [a - (x.pox ?? 0), b - (x.poy ?? 0)]; };
const css = (c: unknown, a = 1) => { const [r, g, b, al] = parseColor(String(c ?? '#000')); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${al * a})`; };
const clone = (cv: HTMLCanvasElement) => { const c = mk(cv.width, cv.height); ctx2d(c).drawImage(cv, 0, 0); return c; };
const h32 = (a: number, b: number) => { let q = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35); q ^= q >>> 16; q = Math.imul(q, 0x7feb352d); q ^= q >>> 15; return (q >>> 0) / 4294967296; };
const findMask = (x: FxCtx, name: string) => { const ms = x.masks ?? [], s = name.trim(); return s ? ms.find((m) => m.name === s || m.id === s || m.name.toLowerCase() === s.toLowerCase()) : undefined; };
const fontOf = (p: Params, size: number) => { const st = String(p.fontStyle ?? 'regular'); return `${st.includes('talic') ? 'italic ' : ''}${st.startsWith('bold') ? 'bold ' : ''}${Math.max(0.5, size)}px "${String(p.font ?? 'Arial').replace(/"/g, '')}", Arial, sans-serif`; };

/** Particle Playground's simulations, per layer and parameter set: the state at its last frame (later frames go on
 * from it; an earlier frame starts again from 0) */
const ppCache = new Map<string, PPState>();
const PP_POINTS = new Set(PP_PARAMS.filter((d) => d.type === 'point').map((d) => d.id));
const PP_TIMES = [0, 0.25, 0.5, 1, 2, 4, 8, 16, 32];

/** another layer as rgba bytes stretched over this layer (w × h layer px, one sample per layer px at most 1024) */
function layerBytes(x: FxCtx, id: string, w: number, h: number, memo: Map<string, { data: Uint8ClampedArray; w: number; h: number } | null>) {
  if (memo.has(id)) return memo.get(id)!;
  const L = x.layer?.(id), sw = Math.max(1, Math.min(1024, Math.round(w))), sh = Math.max(1, Math.min(1024, Math.round(h)));
  let r: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  if (L) { const c = mk(sw, sh), g = ctx2d(c, true); g.drawImage(L.cv, 0, 0, sw, sh); r = { data: g.getImageData(0, 0, sw, sh).data, w: sw, h: sh }; }
  memo.set(id, r);
  return r;
}

export const IMPL_PARTICULAS: Record<string, FxFn> = {
  // CC PS Classic: CC Particle Systems II's emitter and drawing with the classic animation's preset; the particles are
  // born all over the layer's alpha (each one at a random opaque pixel), the layer is replaced by them
  ccPsClassic: (cv, p, x) => {
    const W = cv.width, H = cv.height, d = ctx2d(cv, true).getImageData(0, 0, W, H).data, spots: number[] = [];
    const st = Math.max(1, Math.round(Math.sqrt((W * H) / 40000)));
    for (let y = 0; y < H; y += st) for (let X = 0; X < W; X += st) if (d[(y * W + X) * 4 + 3] > 127) spots.push(X, y);
    if (!spots.length) return mk(W, H);
    const n = spots.length / 2, at = (k: string, tt: number) => {
      if (k !== 'position') return x.at?.(k, tt);
      const i = Math.floor(h32(Math.round(tt * 1e5), 77) * n) * 2;
      return [spots[i] / x.res + x.ox + (x.pox ?? 0), spots[i + 1] / x.res + x.oy + (x.poy ?? 0)];
    };
    return IMPL_ESTILIZAR.ccParticleSystems2(cv, psClassicToII(p, false), { ...x, at });
  },
  // CC PS LE Classic: the same from the producer's ellipse (Producer, X / Y Radius)
  ccPsLe: (cv, p, x) => IMPL_ESTILIZAR.ccParticleSystems2(cv, psClassicToII(p, true), { ...x, at: (k, tt) => x.at?.(k === 'position' ? 'producer' : k, tt) }),

  // Particle Playground: the simulation (core) run frame by frame from the layer's start, cached; the layer is
  // replaced by the particles: dots of their radius, characters of the cannon / grid text, or the Layer Map's layer
  // (the whole layer for cannon particles, each particle's own piece for grid and exploded ones)
  particlePlayground: (cv, p, x) => {
    const W = cv.width, H = cv.height, lw = W / x.res, lh = H / x.res, ox = x.ox, oy = x.oy;
    const memo = new Map<string, { data: Uint8ClampedArray; w: number; h: number } | null>();
    const keys = Object.keys(p).filter((k) => !k.startsWith('_'));
    const at = (tt: number) => {
      const o: Record<string, unknown> = {};
      for (const k of keys) { const v = x.at ? x.at(k, tt) ?? p[k] : p[k]; o[k] = PP_POINTS.has(k) ? lpt(v, x) : v; }
      return o;
    };
    const env: PPEnv = {
      w: lw, h: lh, // no Random Seed in Particle Playground: the same settings give the same particles on any layer
      fps: Math.max(1, x.fps || 30), seed: 0, at,
      sample: (id, X, Y) => { const b = layerBytes(x, id, lw, lh, memo); if (!b) return null; const u = Math.floor((X / lw) * b.w), v = Math.floor((Y / lh) * b.h); if (u < 0 || v < 0 || u >= b.w || v >= b.h) return null; const i = (v * b.w + u) * 4; return [b.data[i] / 255, b.data[i + 1] / 255, b.data[i + 2] / 255, b.data[i + 3] / 255]; },
      pixels: (id) => layerBytes(x, id, lw, lh, memo),
      mask: (name) => findMask(x, name)?.pts ?? null,
    };
    const key = `${x.seed}|${x.ox},${x.oy},${x.res}|${Math.round(lw)}x${Math.round(lh)}|${env.fps}|${JSON.stringify(PP_TIMES.map((tt) => at(tt)))}`;
    const t = Math.max(0, x.t), prev = ppCache.get(key);
    const S = ppSimulate(env, t, prev ? prev : ppNew());
    ppCache.delete(key); ppCache.set(key, S);
    if (ppCache.size > 6) ppCache.delete(ppCache.keys().next().value!);
    const parts = ppDisplay(S, env, t), P = at(t), out = mk(W, H), g = ctx2d(out);
    const lm = String(P.lmLayer ?? ''), lmCv = lm ? x.layer?.(lm)?.cv ?? null : null, orient = !!num(P.autoOrient);
    const font = String(P.font ?? 'Arial').replace(/"/g, '');
    for (const q of parts) {
      if (q.op <= 0) continue;
      const X = (q.x - ox) * x.res, Y = (q.y - oy) * x.res, s = q.scale;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, q.op));
      g.translate(X, Y);
      g.rotate(((q.ang + (orient ? (Math.atan2(q.vy, q.vx) * 180) / Math.PI + 90 : 0)) * Math.PI) / 180);
      g.scale(s * q.sx, s * q.sy);
      const col = `rgb(${Math.round(q.col[0] * 255)},${Math.round(q.col[1] * 255)},${Math.round(q.col[2] * 255)})`;
      if (lmCv && ppAffects(q, P, 'lm', t, env) > 0) {
        if (q.cell) { const [u, v, cw, chh] = q.cell, pw = cw * lw * x.res, ph = chh * lh * x.res; g.drawImage(lmCv, u * lmCv.width, v * lmCv.height, cw * lmCv.width, chh * lmCv.height, -pw / 2, -ph / 2, pw, ph); }
        else { const mw = lmCv.width, mh = lmCv.height, k = x.res * (lw / Math.max(1, mw)); g.drawImage(lmCv, (-mw * k) / 2, (-mh * k) / 2, mw * k, mh * k); }
      } else if (q.ch) {
        g.fillStyle = col; g.font = `${Math.max(0.5, q.fs * x.res)}px "${font}", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(q.ch, 0, 0);
      } else {
        const r = Math.max(0.35, q.r * x.res);
        g.fillStyle = col; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
    return out;
  },

  // Basic Text: the text of the Edit Text dialog at Position (horizontal, vertical or rotated; left / centre / right
  // aligned), Size, Tracking (px between characters) and Line Spacing (% of the size), filled and / or stroked
  basicText: (cv, p, x) => {
    const out = num(p.composite) ? clone(cv) : mk(cv.width, cv.height), g = ctx2d(out), size = num(p.size, 36) * x.res;
    const txt = String(p.text ?? 'Texto'), lines = txt.split(/\r\n|\r|\n/), dir = String(p.direction ?? 'horizontal'), al = String(p.alignment ?? 'center');
    const [px, py] = lpt(p.position, x), X0 = (px - x.ox) * x.res, Y0 = (py - x.oy) * x.res, lead = (num(p.lineSpacing, 100) / 100) * size, tr = num(p.tracking) * x.res;
    g.font = fontOf(p, size); g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.lineWidth = num(p.strokeWidth, 2) * x.res; g.strokeStyle = css(p.strokeColor ?? '#ffffff'); g.fillStyle = css(p.fillColor ?? '#ff0000');
    const disp = String(p.display ?? 'fill');
    const put = (c: string, X: number, Y: number) => {
      const f = () => g.fillText(c, X, Y), s = () => { if (g.lineWidth > 0) g.strokeText(c, X, Y); };
      if (disp === 'fill') f(); else if (disp === 'stroke') s(); else if (disp === 'fillOverStroke') { s(); f(); } else { f(); s(); }
    };
    g.save(); g.translate(X0, Y0); if (dir === 'rotate') g.rotate(Math.PI / 2);
    if (dir === 'vertical') {
      // columns right to left, characters stacked top to bottom
      g.textAlign = 'center';
      lines.forEach((ln, li) => {
        const chs = [...ln], tot = chs.length * (size + tr) - tr, y0 = al === 'left' ? 0 : al === 'right' ? -tot : -tot / 2;
        chs.forEach((c, i) => put(c, -(li - (lines.length - 1) / 2) * lead, y0 + i * (size + tr) + size / 2));
      });
    } else {
      g.textAlign = 'left';
      lines.forEach((ln, li) => {
        const chs = [...ln], ws = chs.map((c) => g.measureText(c).width), tot = ws.reduce((a, b) => a + b, 0) + tr * Math.max(0, chs.length - 1);
        let X = al === 'left' ? 0 : al === 'right' ? -tot : -tot / 2;
        const Y = (li - (lines.length - 1) / 2) * lead;
        chs.forEach((c, i) => { put(c, X, Y); X += ws[i] + tr; });
      });
    }
    g.restore();
    return out;
  },

  // Path Text: the characters along a Bézier, circle, loop, line or a mask (Custom Path), placed by Alignment between
  // the margins, spaced by Tracking and the kerning of the listed pairs (1/1000 em), turned perpendicular to the path
  // (or upright, Vertical Writing), sheared and scaled; Visible Characters with Fade Time types them on; the jitter
  // maxima shake every character each frame; Difference mode inverts what is under it
  pathText: (cv, p, x) => {
    const W = cv.width, H = cv.height, out = num(p.composite) ? clone(cv) : mk(W, H), g = ctx2d(out), res = x.res;
    const cm = findMask(x, String(p.customPath ?? ''));
    const lp = (k: string) => lpt(p[k], x);
    const path = ptPath(String(p.shapeType ?? 'bezier'), lp('vertex1'), lp('tangent1'), lp('tangent2'), lp('vertex2'), cm ? cm.pts : null, !!num(p.reversePath));
    const P = path.pts.map((v, i) => (v - (i % 2 ? x.oy : x.ox)) * res);
    if (P.length < 4) return out;
    const seg: number[] = [0];
    for (let i = 2; i < P.length; i += 2) seg.push(seg[seg.length - 1] + Math.hypot(P[i] - P[i - 2], P[i + 1] - P[i - 1]));
    const L = seg[seg.length - 1];
    const at = (d: number): [number, number, number] => {
      if (path.closed) d = ((d % L) + L) % L;
      let k = 1; while (k < seg.length - 1 && seg[k] < d) k++;
      const a = seg[k - 1], b = seg[k], f = b > a ? (d - a) / (b - a) : 0, i = (k - 1) * 2, dx = P[i + 2] - P[i], dy = P[i + 3] - P[i + 1];
      return [P[i] + dx * f, P[i + 1] + dy * f, Math.atan2(dy, dx)];
    };
    const size = num(p.size, 36) * res, hs = num(p.hScale, 100) / 100, vs = num(p.vScale, 100) / 100, tr = num(p.tracking) * res, vert = !!num(p.verticalWriting);
    g.font = fontOf(p, size); g.textBaseline = 'alphabetic'; g.textAlign = 'center'; g.lineJoin = 'round';
    const pairs = String(p.kerningPairs ?? '').split(/[,;\s]+/).filter((s) => s.length === 2), kv = (num(p.kerningValue) / 1000) * size;
    const lines = String(p.text ?? 'Texto').split(/\r\n|\r|\n/), all = lines.reduce((a, l) => a + [...l].length, 0);
    const vis = num(p.visibleChars, 1024), fade = (num(p.fadeTime) / 100) * Math.max(1, all), frame = Math.floor(x.t * (x.fps || 30) + 1e-6);
    const disp = String(p.display ?? 'fill'), lead = (num(p.lineSpacing, 100) / 100) * size, lm = num(p.leftMargin) * res, rm = num(p.rightMargin) * res, al = String(p.alignment ?? 'left');
    const jB = num(p.baselineJitter) * res, jK = num(p.kerningJitter) * res, jR = num(p.rotationJitter), jS = num(p.scaleJitter) / 100;
    g.globalCompositeOperation = String(p.mode ?? 'normal') === 'difference' ? 'difference' : 'source-over';
    g.lineWidth = num(p.strokeWidth, 2) * res; g.strokeStyle = css(p.strokeColor ?? '#ffffff'); g.fillStyle = css(p.fillColor ?? '#ff0000');
    let idx = 0;
    lines.forEach((ln, li) => {
      const chs = [...ln], adv = chs.map((c, i) => (vert ? size * vs : g.measureText(c).width * hs) + (i < chs.length - 1 ? tr + (pairs.includes(c + chs[i + 1]) ? kv : 0) : 0));
      const tot = adv.reduce((a, b) => a + b, 0), avail = L - lm - rm;
      let d = al === 'right' ? L - rm - tot : al === 'center' ? lm + (avail - tot) / 2 : lm;
      const extra = al === 'force' && chs.length > 1 ? (avail - tot) / (chs.length - 1) : 0;
      chs.forEach((c, i) => {
        const k = idx++, r = (j: number) => h32(k * 7 + frame * 7919, j) * 2 - 1;
        const op = vis >= 0 ? (fade > 0 ? Math.max(0, Math.min(1, (vis - k) / fade)) : k < Math.floor(vis) ? 1 : 0) : (fade > 0 ? Math.max(0, Math.min(1, (k - (all + vis)) / fade + 1)) : k >= all + vis ? 1 : 0);
        const w = adv[i] - (i < chs.length - 1 ? tr : 0), mid = d + w / 2 + (jK ? r(1) * jK : 0);
        d += adv[i] + extra;
        if (op <= 0 || c === ' ') return;
        const [X, Y, ang] = at(mid);
        g.save(); g.globalAlpha = op; g.translate(X, Y);
        if (num(p.perpendicular, 1)) g.rotate(ang);
        // baseline shift and further lines move away from the path (up = negative y)
        g.translate(0, -(num(p.baselineShift) * res) + li * lead + (jB ? r(2) * jB : 0));
        g.rotate(((num(p.charRotation) + (jR ? r(3) * jR : 0)) * Math.PI) / 180);
        if (vert && !num(p.rotateRoman, 1) && /[\x20-\x7e]/.test(c)) g.rotate(-Math.PI / 2);
        const sk = Math.tan((num(p.hShear) * Math.PI) / 180), js = 1 + (jS ? r(4) * jS : 0);
        g.transform(1, 0, -sk, 1, 0, 0); g.scale(hs * js, vs * js);
        const f = () => g.fillText(c, 0, 0), s = () => { if (g.lineWidth > 0) g.strokeText(c, 0, 0); };
        if (disp === 'fill') f(); else if (disp === 'stroke') s(); else if (disp === 'fillOverStroke') { s(); f(); } else { f(); s(); }
        g.restore();
      });
    });
    g.globalCompositeOperation = 'source-over';
    return out;
  },

  // Vector Paint: the strokes stored in the effect, shown by Playback Mode (all, past, hold, animated at Playback
  // Speed, current frame, onion skin), each a round brush of its radius / feather / opacity / colour (erase strokes cut
  // the paint), wiggled when Enable Wiggling is on, then composited with the layer by Composite Paint
  vectorPaint: (cv, p, x) => {
    const W = cv.width, H = cv.height, res = x.res;
    const brush = { c: String(p.brushColor ?? '#ffffff'), r: num(p.brushRadius, 8), f: num(p.brushFeather, 50), o: num(p.brushOpacity, 100) };
    const vis = vpVisible(vpParse(p.strokes, brush), String(p.playback ?? 'current'), x.t, x.fps || 30, num(p.playbackSpeed, 1));
    const paint = mk(W, H), pg = ctx2d(paint), wig = !!num(p.wiggle);
    vis.forEach((v, si) => {
      const s = v.s, any = s.pts.some((q) => q[2] > 0);
      let pts = s.pts.filter((q) => !any || q[2] <= v.upto);
      if (!pts.length) return;
      // the stroke drawn so far ends between two recorded points
      if (any && pts.length < s.pts.length && Number.isFinite(v.upto)) { const a = s.pts[pts.length - 1], b = s.pts[pts.length], f = (v.upto - a[2]) / Math.max(1e-6, b[2] - a[2]); pts = [...pts, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, v.upto]]; }
      const seed = num(p.individualSeeds, 1) ? si * 17 + 3 : 3, ph = x.t * num(p.wigglesPerSec, 30) * 0.2, amp = (num(p.dispVariation, 5) / 100) * s.r * 2, det = num(p.dispDetail, 100) / 100 / 20;
      const pv = num(p.pressVariation, 70) / 100, pdet = num(p.pressDetail, 50) / 100 / 20;
      const layer = mk(W, H), lg = ctx2d(layer), col = v.tint === 'back' ? '#ff3030' : v.tint === 'fwd' ? '#30ff30' : s.c;
      lg.strokeStyle = css(col); lg.fillStyle = css(col); lg.lineCap = 'round'; lg.lineJoin = 'round';
      let len = 0;
      const P = pts.map((q, i) => {
        if (i) len += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]);
        let X = q[0], Y = q[1], w = 1;
        if (wig) { X += fbm(len * det + ph, seed, 2) * amp; Y += fbm(len * det + ph + 31.7, seed + 1, 2) * amp; w = Math.max(0.05, 1 + fbm(len * pdet + ph * 0.5, seed + 2, 2) * pv); }
        return [(X - x.ox) * res, (Y - x.oy) * res, w];
      });
      const R = Math.max(0.3, s.r * res);
      if (P.length === 1) { lg.beginPath(); lg.arc(P[0][0], P[0][1], R * P[0][2], 0, Math.PI * 2); lg.fill(); }
      for (let i = 1; i < P.length; i++) { lg.lineWidth = 2 * R * (P[i - 1][2] + P[i][2]) / 2; lg.beginPath(); lg.moveTo(P[i - 1][0], P[i - 1][1]); lg.lineTo(P[i][0], P[i][1]); lg.stroke(); }
      const soft = s.f > 0 ? blurCanvas(layer, R * (s.f / 100) * 0.5) : layer;
      pg.save(); pg.globalAlpha = (s.o / 100) * v.k; pg.globalCompositeOperation = s.e ? 'destination-out' : 'source-over'; pg.drawImage(soft, 0, 0); pg.restore();
    });
    const mode = String(p.composite ?? 'inOriginal'), out = mk(W, H), g = ctx2d(out);
    const draw = (c: HTMLCanvasElement, op: GlobalCompositeOperation = 'source-over') => { g.globalCompositeOperation = op; g.drawImage(c, 0, 0); };
    switch (mode) {
      case 'only': draw(paint); break;
      case 'underOriginal': case 'underAlpha': draw(cv); draw(paint, 'destination-over'); break;
      case 'trackMatte': draw(cv); draw(paint, 'source-in'); break;
      case 'trackMatteVisible': case 'inAlpha': draw(cv); draw(paint, 'source-atop'); break;
      case 'asMatte': draw(cv); draw(paint, 'destination-in'); break;
      case 'asInverseMatte': draw(cv); draw(paint, 'destination-out'); break;
      default: draw(cv); draw(paint);
    }
    g.globalCompositeOperation = 'source-over';
    return out;
  },
};
