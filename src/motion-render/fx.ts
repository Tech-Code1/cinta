// Effects of the advanced mode, drawn with Canvas 2D (filters, compositing) and per-pixel passes where the
// canvas has no equivalent. Each effect works in layer space: canvas pixels = (layer px − origin) × res.
import { fbm, hash2, parseColor, rnd } from '../core/motion/anim';
import { brightPassFilter, colorFilter, gooeyFilter } from './svgfx';
import { GLMesh, GLQuad, GLWarp, quadWeights } from './gl';
import type { Aux } from './render';
import { IMPL_DESENFOQUE } from './fx-groups/desenfoque';
import { IMPL_COLOR } from './fx-groups/color';
import { IMPL_DISTORSION } from './fx-groups/distorsion';
import { IMPL_ESTILIZAR } from './fx-groups/estilizar';
import { IMPL_LENTE, lenteGrowth } from './fx-groups/lente';
import { IMPL_PARTICULAS } from './fx-groups/particulas';
import { IMPL_CANAL3D, type Depth3D } from './fx-groups/canal3d';
import { IMPL_TIEMPO } from './fx-groups/tiempo';
let warp: GLWarp | null = null;
const W8 = () => (warp ??= new GLWarp());

export interface FxCtx {
  /** canvas pixels per layer pixel */
  res: number;
  /** layer coordinates of the canvas' top-left pixel */
  ox: number;
  oy: number;
  /** layer time (s) */
  t: number;
  fps: number;
  seed: number;
  /** effect points are given in composition-style coordinates on text/shape layers (origin at their centre) */
  pox?: number;
  poy?: number;
  /** value of one of this effect's parameters at another layer time (moving emitters, trails) */
  at?: (param: string, t: number) => unknown;
  /** sound of another layer (audio effects): its samples and its source time now */
  audio?: (id: string) => { pcm: { data: Float32Array; rate: number }; time: number } | null;
  /** another layer's source (masks and effects, no transform) for layer-type parameters */
  layer?: (id: string) => { cv: HTMLCanvasElement; ox: number; oy: number; res: number } | null;
  /** EXR footage: the channels of the frame (3D Channel effects) */
  aux?: Aux | null;
  /** the layer's masks now (any mode, also None): outline points in layer pixels */
  masks?: { id: string; name: string; mode: string; inverted: boolean; pts: number[] }[];
  /** the composition's camera and lights as seen from this layer (Comp Camera / First Comp Light / AE Lights) */
  scene?: () => FxScene | null;
  /** the composition's width and height (Detail-preserving Upscale's Fit to Comp) */
  compSize?: [number, number];
  /** Cinta's own 3D data under the canvas (3D Channel effects): the layer's plane, or the comp below an adjustment layer */
  depth3d?: (cv: HTMLCanvasElement) => Depth3D | null;
  /** the layer before its effects (masks applied), the size of the effects' canvas (CC Composite) */
  src?: HTMLCanvasElement;
}
/** project: a point in layer px (z = depth away from the viewer) seen through the comp camera → layer px of the
 * layer's own plane + camera depth; lights in layer px (type parallel / spot / point / ambient, colour × intensity) */
export interface FxScene { camera: boolean; project: (x: number, y: number, z: number) => [number, number, number]; lights: { type: string; pos: number[]; dir: number[]; color: number[] }[]; /** layer direction → camera direction (3×3, row-major) */ rot: number[]; /** focal length in layer px */ zoom: number }
export type Params = Record<string, unknown>;
export type FxFn = (cv: HTMLCanvasElement, p: Params, x: FxCtx) => HTMLCanvasElement;

export function mk(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}
export const ctx2d = (c: HTMLCanvasElement, read = false) => c.getContext('2d', read ? { willReadFrequently: true } : undefined)!;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec2 = (v: unknown): [number, number] => (Array.isArray(v) ? [num(v[0]), num(v[1])] : [0, 0]);
const pt = (v: unknown, x: FxCtx): [number, number] => { const [a, b] = vec2(v); return [(a - (x.pox ?? 0) - x.ox) * x.res, (b - (x.poy ?? 0) - x.oy) * x.res]; };
const rgba = (c: unknown, a = 1) => { const [r, g, b, al] = parseColor(String(c ?? '#000')); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${al * a})`; };
const rad = (d: number) => (d * Math.PI) / 180;
const clone = (cv: HTMLCanvasElement) => { const c = mk(cv.width, cv.height); ctx2d(c).drawImage(cv, 0, 0); return c; };

/** Runs fn over the pixels (RGBA, un-premultiplied by the canvas API). */
function pixels(cv: HTMLCanvasElement, fn: (d: Uint8ClampedArray, w: number, h: number) => void): HTMLCanvasElement {
  const g = ctx2d(cv, true);
  const img = g.getImageData(0, 0, cv.width, cv.height);
  fn(img.data, cv.width, cv.height);
  g.putImageData(img, 0, 0);
  return cv;
}
function lut(cv: HTMLCanvasElement, f: (v: number, ch: number) => number): HTMLCanvasElement {
  const L = [0, 1, 2].map((ch) => Uint8ClampedArray.from({ length: 256 }, (_, v) => f(v, ch)));
  return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = L[0][d[i]]; d[i + 1] = L[1][d[i + 1]]; d[i + 2] = L[2][d[i + 2]]; } });
}
/** Curve 'x,y x,y …' (0…1) → 256-entry table through a natural cubic spline, clamped (like Photoshop / AE Curves). */
export function curveTable(spec: unknown): Float32Array {
  const pts = String(spec ?? '0,0 1,1').trim().split(/\s+/).map((q) => q.split(',').map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
  const t = new Float32Array(256);
  if (pts.length < 2) { for (let i = 0; i < 256; i++) t[i] = i / 255; return t; }
  const n = pts.length, xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  // second derivatives of the natural spline (tridiagonal solve)
  const m = new Float64Array(n), u = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]), p = sig * m[i - 1] + 2;
    m[i] = (sig - 1) / p;
    u[i] = ((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]));
    u[i] = ((6 * u[i]) / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p;
  }
  for (let k = n - 2; k >= 0; k--) m[k] = m[k] * m[k + 1] + u[k];
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    if (x <= xs[0]) { t[i] = ys[0]; continue; }
    if (x >= xs[n - 1]) { t[i] = ys[n - 1]; continue; }
    let k = 0; while (xs[k + 1] < x) k++;
    const h = xs[k + 1] - xs[k] || 1e-6, a = (xs[k + 1] - x) / h, b = (x - xs[k]) / h;
    t[i] = Math.max(0, Math.min(1, a * ys[k] + b * ys[k + 1] + ((a * a * a - a) * m[k] + (b * b * b - b) * m[k + 1]) * (h * h) / 6));
  }
  return t;
}
/** Levels on one 0…255 value. */
/** Levels of one value (0…255); with clipping off (Clip To Output Black / White) the input range extends past
 *  the output black / white points instead of stopping there */
const level = (v: number, ib: number, iw: number, gm: number, ob: number, ow: number, cb = true, cw = true) => {
  const t = (v - ib) / Math.max(1, iw - ib), u = Math.max(cb ? 0 : -Infinity, Math.min(cw ? 1 : Infinity, t));
  return ob + (ow - ob) * Math.sign(u) * Math.pow(Math.abs(u), 1 / Math.max(0.01, gm));
};
/** Levels' clip popups: «Off for 32 bpc Color» clips in Cinta's 8-bit effects */
const levelClip = (p: Params): [boolean, boolean] => [p.clipBlack !== 'off', p.clipWhite !== 'off'];
/** .cube text → { n, data } (data: r, g, b in 0…1, red fastest), or null. */
export function parseCube(text: string): { n: number; data: Float32Array } | null {
  let n = 0;
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^LUT_3D_SIZE\s+(\d+)/i.exec(line);
    if (m) { n = +m[1]; continue; }
    if (/^[A-Z_]/i.test(line)) continue;
    const q = line.split(/\s+/).map(Number);
    if (q.length >= 3 && q.every(Number.isFinite)) vals.push(q[0], q[1], q[2]);
  }
  return n >= 2 && vals.length >= n * n * n * 3 ? { n, data: Float32Array.from(vals.slice(0, n * n * n * 3)) } : null;
}
const lutCache = new Map<string, { n: number; data: Float32Array } | null>();

function blendWithOriginal(orig: HTMLCanvasElement, out: HTMLCanvasElement, blend: number): HTMLCanvasElement {
  if (blend <= 0) return out;
  const g = ctx2d(out);
  g.save();
  g.globalAlpha = Math.min(1, blend / 100);
  g.globalCompositeOperation = 'source-atop';
  g.drawImage(orig, 0, 0);
  g.restore();
  return out;
}
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Gaussian blur (σ ≈ amount / 2 in layer px); dir: both | h | v. */
export function blurCanvas(cv: HTMLCanvasElement, sigma: number, dir = 'both'): HTMLCanvasElement {
  if (sigma <= 0.05) return cv;
  const out = mk(cv.width, cv.height);
  const g = ctx2d(out);
  if (dir === 'both') { g.filter = `blur(${sigma}px)`; g.drawImage(cv, 0, 0); return out; }
  // one direction: squash the other axis so the blur only acts along `dir`
  const k = 16;
  const tmp = dir === 'h' ? mk(cv.width, Math.ceil(cv.height / k)) : mk(Math.ceil(cv.width / k), cv.height);
  void tmp;
  const n = Math.max(2, Math.min(64, Math.ceil(sigma * 2)));
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const o = ((i / (n - 1)) - 0.5) * sigma * 3;
    const w = Math.exp(-(o * o) / (2 * sigma * sigma));
    g.globalAlpha = w / gaussNorm(n, sigma);
    g.drawImage(cv, dir === 'h' ? o : 0, dir === 'v' ? o : 0);
  }
  return out;
}
function gaussNorm(n: number, sigma: number) { let s = 0; for (let i = 0; i < n; i++) { const o = ((i / (n - 1)) - 0.5) * sigma * 3; s += Math.exp(-(o * o) / (2 * sigma * sigma)); } return s; }

/** Average of n placed copies (blurs). Summing n copies at 1/n opacity on an 8-bit canvas rounds every copy, so
 * dark channels collapse to 0 and colours shift (teal turned blue). Instead copies are averaged in pairs, like a
 * binary counter: only log2(n) roundings, and at most log2(n) canvases alive. n is rounded up to a power of two. */
function drawCopies(cv: HTMLCanvasElement, n0: number, place: (g: CanvasRenderingContext2D, f: number) => void): HTMLCanvasElement {
  const n = 2 ** Math.ceil(Math.log2(Math.max(2, n0)));
  const avg = (a: HTMLCanvasElement, b: HTMLCanvasElement) => {
    const o = mk(a.width, a.height);
    const g = ctx2d(o);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.5;
    g.drawImage(a, 0, 0);
    g.drawImage(b, 0, 0);
    return o;
  };
  const stack: { c: HTMLCanvasElement; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = mk(cv.width, cv.height);
    const g = ctx2d(c);
    place(g, i / (n - 1) - 0.5);
    g.drawImage(cv, 0, 0);
    let item = { c, w: 1 };
    while (stack.length && stack[stack.length - 1].w === item.w) item = { c: avg(stack.pop()!.c, item.c), w: item.w * 2 };
    stack.push(item);
  }
  return stack[0].c;
}

function maskByCompletion(cv: HTMLCanvasElement, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): HTMLCanvasElement {
  // draw() paints what must DISAPPEAR (white); the layer keeps the rest
  const m = mk(cv.width, cv.height);
  const g = ctx2d(m);
  g.fillStyle = '#fff';
  draw(g, cv.width, cv.height);
  const out = clone(cv);
  const o = ctx2d(out);
  o.globalCompositeOperation = 'destination-out';
  o.drawImage(m, 0, 0);
  return out;
}

// ───────────────────────── particles (analytic, no state) ─────────────────────────
function particles(cv: HTMLCanvasElement, p: Params, x: FxCtx, kind: 'particles' | 'rain' | 'snow'): HTMLCanvasElement {
  const out = clone(cv);
  const g = ctx2d(out);
  const seed = hash2(num(p.seed, 1), x.seed);
  const W = cv.width, H = cv.height, t = x.t + (kind === 'particles' ? num(p.warmup) : 0);
  if (kind === 'rain') {
    const n = Math.round(num(p.amount, 400)), speed = num(p.speed, 1400) * x.res, len = num(p.length, 40) * x.res, a = rad(num(p.angle, 12));
    g.strokeStyle = rgba(p.color ?? '#cfe6ff', num(p.opacity, 50) / 100);
    g.lineWidth = Math.max(1, 1.5 * x.res);
    g.beginPath();
    const dx = Math.sin(a), dy = Math.cos(a);
    const travel = H + len + Math.abs(dx) * H;
    for (let i = 0; i < n; i++) {
      const sp = speed * (0.75 + rnd(seed, i * 3) * 0.5);
      const ph = rnd(seed, i * 3 + 1) * travel;
      const d = (ph + t * sp) % travel;
      const x0 = rnd(seed, i * 3 + 2) * (W + H * Math.abs(dx)) - (dx > 0 ? H * dx : 0) + d * dx, y0 = d - len;
      g.moveTo(x0, y0);
      g.lineTo(x0 + dx * len, y0 + dy * len);
    }
    g.stroke();
    return out;
  }
  if (kind === 'snow') {
    const n = Math.round(num(p.amount, 300)), speed = num(p.speed, 120) * x.res, size = num(p.size, 4) * x.res, wind = num(p.wind, 30) * x.res;
    g.fillStyle = rgba('#ffffff', num(p.opacity, 85) / 100);
    for (let i = 0; i < n; i++) {
      const r = size * (0.4 + rnd(seed, i * 5) * 0.8);
      const sp = speed * (0.5 + r / size);
      const travel = H + r * 2;
      const y = ((rnd(seed, i * 5 + 1) * travel + t * sp) % travel) - r;
      const xx = (((rnd(seed, i * 5 + 2) * W + t * wind + Math.sin(t * (0.8 + rnd(seed, i * 5 + 3)) + i) * 20 * x.res) % W) + W) % W;
      g.beginPath();
      g.arc(xx, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return out;
  }
  const rate = num(p.rate, 60), life = Math.max(0.05, num(p.life, 2)), vel = num(p.velocity, 300), dir = rad(num(p.direction, 0)), spread = rad(num(p.spread, 60));
  const grav = num(p.gravity, 300), size = num(p.size, 10), sizeVar = num(p.sizeVar, 50) / 100;
  const [px0, py0] = vec2(p.position);
  const rx = num(p.radiusX, 10), ry = num(p.radiusY, 10), spin = num(p.spin);
  // the emitter where it was when each particle was born, so a moving emitter leaves a trail
  const moving = !!x.at && !num(p.followEmitter);
  const birthPos = (born: number): [number, number] => (moving ? vec2(x.at!('position', born)) : [px0, py0]);
  const c0 = parseColor(String(p.colorStart ?? '#ffd400')), c1 = parseColor(String(p.colorEnd ?? '#e8455a'));
  const shape = String(p.shape ?? 'circle');
  const burst = p.birth === 'burst', drag = Math.max(0, num(p.drag)), streak = Math.max(0, num(p.streak));
  const fadeIn = Math.max(0.001, num(p.fadeIn, 12) / 100);
  const fadeOut = Math.max(0.001, num(p.fadeOut, 100) / 100), shrink = num(p.shrink, 50) / 100;
  // burst: rate particles all born at burstAt (layer time); continuous: rate per second
  const first = burst ? 0 : Math.max(0, Math.floor((t - life) * rate)), last = burst ? Math.round(rate) - 1 : Math.floor(t * rate);
  // position along a straight launch with linear air drag: s(age) = v (1 − e^(−k·age)) / k ; gravity is not damped
  const travel = (v: number, age: number) => (drag > 0 ? (v * (1 - Math.exp(-drag * age))) / drag : v * age);
  // depth: each particle gets a distance z (0 far … 1 near) that scales its size and speed and fogs the far ones;
  // they are drawn far to near, and the nearest can be out of focus
  const depth = Math.max(0, Math.min(1, num(p.depth) / 100)), dBlur = num(p.depthBlur) * x.res;
  const zOf = (i: number) => rnd(seed, i * 7 + 8);
  const order: number[] = [];
  for (let i = first; i <= last; i++) order.push(i);
  if (depth > 0) order.sort((a, b) => zOf(a) - zOf(b));
  const edge = Math.max(0, Math.min(1, num(p.edge) / 100)), la = rad(num(p.lightAngle) - 90);
  const ec = parseColor(String(p.edgeColor ?? '#ff6a3d'));
  for (const i of order) {
    const born = burst ? num(p.burstAt) + rnd(seed, i * 7 + 5) * 0.03 : i / rate;
    const age = t - born;
    if (age < 0 || age > life) continue;
    const f = age / life;
    const z = zOf(i), zs = depth > 0 ? 1 - depth + depth * (0.3 + 1.6 * z * z) : 1;
    const a = dir - Math.PI / 2 + (rnd(seed, i * 7) - 0.5) * spread;
    const v = vel * (0.6 + rnd(seed, i * 7 + 1) * 0.8) * (depth > 0 ? 1 - depth + depth * (0.4 + 1.2 * z) : 1);
    const [px, py] = birthPos(born);
    const sx = px + (rnd(seed, i * 7 + 2) * 2 - 1) * rx, sy = py + (rnd(seed, i * 7 + 3) * 2 - 1) * ry;
    const at = (ag: number) => [sx + Math.cos(a) * travel(v, ag), sy + Math.sin(a) * travel(v, ag) + 0.5 * grav * ag * ag];
    const [lx, ly] = at(age);
    const r = Math.max(0.3, size * zs * (1 - sizeVar * rnd(seed, i * 7 + 4)) * (shape === 'glow' ? 1 : 1 - f * shrink)) * x.res / 2;
    const alpha = Math.min(1, f / fadeIn) * (f < 1 - fadeOut ? 1 : ((1 - f) / fadeOut) ** 1.2) * (1 - depth * 0.65 * (1 - z));
    const col = `rgba(${Math.round((c0[0] + (c1[0] - c0[0]) * f) * 255)},${Math.round((c0[1] + (c1[1] - c0[1]) * f) * 255)},${Math.round((c0[2] + (c1[2] - c0[2]) * f) * 255)},${alpha}`;
    const blurPx = depth > 0 && dBlur > 0 && z > 0.7 ? dBlur * ((z - 0.7) / 0.3) : 0;
    g.filter = blurPx > 0.3 ? `blur(${blurPx.toFixed(1)}px)` : 'none';
    const cx = (lx - x.ox) * x.res, cy = (ly - x.oy) * x.res;
    if (streak > 0) {
      // a tapered stroke from where the particle was `streak` seconds ago
      const [tx, ty] = at(Math.max(0, age - streak));
      g.strokeStyle = col;
      g.lineCap = 'round';
      g.lineWidth = r * 2;
      g.beginPath();
      g.moveTo((tx - x.ox) * x.res, (ty - x.oy) * x.res);
      g.lineTo(cx, cy);
      g.stroke();
      continue;
    }
    if (shape === 'glow') {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r * 2);
      gr.addColorStop(0, col);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(cx - r * 2, cy - r * 2, r * 4, r * 4);
      continue;
    }
    g.fillStyle = col;
    g.beginPath();
    if (shape === 'shard' || shape === 'drop') {
      if (shape === 'drop') {
        // teardrop pointing back along the motion
        const [qx, qy] = at(Math.max(0, age - 0.02));
        const ang = Math.atan2(ly - qy, lx - qx) || Math.PI / 2;
        g.save(); g.translate(cx, cy); g.rotate(ang);
        g.moveTo(-r * 3, 0); g.quadraticCurveTo(-r * 0.4, -r * 1.05, r, 0); g.quadraticCurveTo(-r * 0.4, r * 1.05, -r * 3, 0);
        g.restore();
      } else {
        // irregular 4–6 sided chip that tumbles
        const k = 4 + Math.floor(rnd(seed, i * 7 + 6) * 3), rot = (rnd(seed, i * 7 + 5) * 360 + age * spin * (rnd(seed, i * 11) > 0.5 ? 1 : -1)) * Math.PI / 180;
        for (let q = 0; q < k; q++) { const ang = rot + (q / k) * Math.PI * 2, rr = r * (0.55 + rnd(seed, i * 13 + q) * 0.6); g.lineTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr); }
        g.closePath();
      }
    } else if (shape === 'square') g.rect(cx - r, cy - r, r * 2, r * 2);
    else if (shape === 'star') { for (let k = 0; k < 10; k++) { const ang = (k / 10) * Math.PI * 2 - Math.PI / 2 + age * 2, rr = k % 2 ? r * 0.45 : r; g.lineTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr); } g.closePath(); }
    else g.arc(cx, cy, r, 0, Math.PI * 2);
    if (edge > 0) {
      // lit side: the fill turns into the edge colour towards the light
      const gr = g.createLinearGradient(cx - Math.cos(la) * r, cy - Math.sin(la) * r, cx + Math.cos(la) * r, cy + Math.sin(la) * r);
      gr.addColorStop(0, col);
      gr.addColorStop(Math.max(0, 1 - edge * 0.6), col);
      gr.addColorStop(1, `rgba(${Math.round(ec[0] * 255)},${Math.round(ec[1] * 255)},${Math.round(ec[2] * 255)},${alpha})`);
      g.fillStyle = gr;
    }
    g.fill();
  }
  g.filter = 'none';
  return out;
}

// ───────────────────────── layer inputs ─────────────────────────
/** The layer named by a layer parameter, drawn over this effect's canvas: stretched to it, centred at its real size,
 *  or tiled. null when the parameter is empty or the layer is missing. */
function inputCanvas(id: unknown, cv: HTMLCanvasElement, x: FxCtx, fit: unknown): HTMLCanvasElement | null {
  const src = typeof id === 'string' && id ? x.layer?.(id) : null;
  if (!src || !src.cv.width || !src.cv.height) return null;
  const out = mk(cv.width, cv.height);
  const g = ctx2d(out);
  if (fit === 'stretch' || !fit) { g.drawImage(src.cv, 0, 0, cv.width, cv.height); return out; }
  const k = x.res / src.res, w = src.cv.width * k, h = src.cv.height * k;
  if (fit === 'tile') {
    const t = mk(Math.max(1, w), Math.max(1, h));
    ctx2d(t).drawImage(src.cv, 0, 0, t.width, t.height);
    g.fillStyle = g.createPattern(t, 'repeat')!;
    g.fillRect(0, 0, cv.width, cv.height);
    return out;
  }
  g.drawImage(src.cv, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
  return out;
}
/** 0…1 value of one channel of a straight-alpha RGBA pixel */
function chan(d: Uint8ClampedArray, i: number, c: unknown): number {
  switch (c) {
    case 'red': return d[i] / 255;
    case 'green': return d[i + 1] / 255;
    case 'blue': return d[i + 2] / 255;
    case 'alpha': return d[i + 3] / 255;
    case 'off': case 'half': return 0.5;
    case 'full': return 1;
    case 'none': return 0;
    case 'hue': case 'lightness': case 'saturation': {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      if (c === 'lightness') return l;
      const dd = mx - mn;
      if (c === 'saturation') return dd === 0 ? 0 : dd / (1 - Math.abs(2 * l - 1));
      if (dd === 0) return 0;
      const hh = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      return hh / 6;
    }
    default: return (lum(d[i], d[i + 1], d[i + 2]) / 255) * (d[i + 3] / 255); // transparent reads as black
  }
}
const imgData = (cv: HTMLCanvasElement) => ctx2d(cv).getImageData(0, 0, cv.width, cv.height);

/**
 * Glow «A & B colors», as After Effects builds it: a 256-entry table from the first colour to the mean
 * of A and B at (1 − midpoint) × 256 and on to the second; triangles squeeze it into half and mirror it; then it
 * repeats `loops` times and turns by phase × 256 / 360. Each glow pixel takes the colour of its brightness, with
 * opacity brightness × intensity.
 */
function glowColorMap(glow: HTMLCanvasElement, p: Params, intensity: number): HTMLCanvasElement {
  const A = parseColor(String(p.color ?? '#fff')), B = parseColor(String(p.colorB ?? '#000'));
  const loop = String(p.looping ?? 'triangleAB'), first = loop === 'sawAB' || loop === 'triangleAB' ? A : B, second = first === A ? B : A;
  const m = Math.max(1, Math.min(255, Math.round((1 - num(p.midpoint, 50) / 100) * 256)));
  const mid = [0, 1, 2].map((c) => (first[c] + second[c]) / 2);
  let lut: number[][] = [];
  for (let i = 0; i < 256; i++) lut.push([0, 1, 2].map((c) => (i < m ? first[c] + ((mid[c] - first[c]) * i) / m : mid[c] + ((second[c] - mid[c]) * (i - m)) / (256 - m))));
  if (loop.startsWith('triangle')) { const t: number[][] = []; for (let i = 0; i < 256; i++) t.push(i < 128 ? lut[i * 2] : lut[(255 - i) * 2 + 1]); lut = t; }
  const loops = Math.max(1, Math.floor(num(p.loops, 1))), shift = Math.round((num(p.phase) * 256) / 360);
  return pixels(glow, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      // canvas data is not premultiplied: the glow amount is colour × alpha
      const v = Math.min(255, Math.round((Math.max(d[i], d[i + 1], d[i + 2]) * d[i + 3]) / 255));
      if (!d[i + 3] || !v) { d[i + 3] = 0; continue; }
      const c = lut[(((v * loops + shift) % 256) + 256) % 256];
      d[i] = c[0] * 255; d[i + 1] = c[1] * 255; d[i + 2] = c[2] * 255;
      d[i + 3] = Math.min(255, v * intensity);
    }
  });
}

// ───────────────────────── audio effects ─────────────────────────
/** Magnitudes of `bands` log-spaced frequency bands between f0 and f1 of the samples around time t (window ms): an FFT
 *  of the Hann-windowed samples, each band taking its strongest bin (a tone shows wherever it falls in a band). */
function spectrum(pcm: { data: Float32Array; rate: number }, t: number, ms: number, bands: number, f0: number, f1: number): Float32Array {
  const len = Math.max(64, Math.round((pcm.rate * ms) / 1000)), N = 2 ** Math.ceil(Math.log2(len)), a = Math.round(t * pcm.rate - len / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < len; i++) { const k = a + i; re[i] = (k >= 0 && k < pcm.data.length ? pcm.data[k] : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1))); }
  // iterative radix-2 FFT
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let size = 2; size <= N; size <<= 1) {
    const ang = (-2 * Math.PI) / size, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let s0 = 0; s0 < N; s0 += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a1 = s0 + k, b1 = a1 + size / 2, tr = re[b1] * cr - im[b1] * ci, ti = re[b1] * ci + im[b1] * cr;
        re[b1] = re[a1] - tr; im[b1] = im[a1] - ti; re[a1] += tr; im[a1] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  // amplitude of a sine: |X| / (len / 4) with a Hann window
  const mag = (k: number) => Math.hypot(re[k], im[k]) / (len / 4), hz = pcm.rate / N, out = new Float32Array(bands);
  const ratio = Math.pow(f1 / f0, 1 / Math.max(1, bands));
  for (let b = 0; b < bands; b++) {
    const lo = f0 * Math.pow(ratio, b), hi = lo * ratio;
    const k0 = Math.max(1, Math.floor(lo / hz)), k1 = Math.min(N / 2 - 1, Math.max(k0, Math.ceil(hi / hz)));
    let m = 0; for (let k = k0; k <= k1; k++) m = Math.max(m, mag(k));
    out[b] = m;
  }
  return out;
}
/** Draws bars / lines / dots along start → end, perpendicular heights h[i] (px), on side A, B or both. */
function drawProfile(g: CanvasRenderingContext2D, p: Params, x: FxCtx, h: Float32Array | number[]) {
  const [sx, sy] = pt(p.start, x), [ex, ey] = pt(p.end, x), len = Math.hypot(ex - sx, ey - sy) || 1;
  const nx = -(ey - sy) / len, ny = (ex - sx) / len, side = String(p.side ?? 'both'), n = h.length;
  const thick = Math.max(0.5, num(p.thickness, 3) * x.res), soft = num(p.softness, 50) / 100;
  const ic = String(p.insideColor ?? '#ffffff'), oc = String(p.outsideColor ?? '#4aa8ff'), mode = String(p.display ?? 'digital');
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (soft > 0) { g.shadowColor = rgba(oc, 1); g.shadowBlur = thick * 4 * soft; }
  const pt2 = (i: number, s: number) => { const f = n > 1 ? i / (n - 1) : 0.5, bx = sx + (ex - sx) * f, by = sy + (ey - sy) * f; return [bx + nx * h[i] * s, by + ny * h[i] * s]; };
  const sides = side === 'a' ? [-1] : side === 'b' ? [1] : [-1, 1];
  g.strokeStyle = rgba(ic, 1); g.fillStyle = rgba(ic, 1); g.lineWidth = thick;
  for (const s of sides) {
    if (mode === 'lines') { g.beginPath(); for (let i = 0; i < n; i++) { const [px, py] = pt2(i, s); if (i) g.lineTo(px, py); else g.moveTo(px, py); } g.stroke(); }
    else if (mode === 'dots') for (let i = 0; i < n; i++) { const [px, py] = pt2(i, s); g.beginPath(); g.arc(px, py, thick, 0, Math.PI * 2); g.fill(); }
    else for (let i = 0; i < n; i++) { const f = n > 1 ? i / (n - 1) : 0.5, bx = sx + (ex - sx) * f, by = sy + (ey - sy) * f, [px, py] = pt2(i, s); g.beginPath(); g.moveTo(bx, by); g.lineTo(px, py); g.stroke(); }
  }
  g.shadowBlur = 0;
}

// ───────────────────────── keying helpers ─────────────────────────
/** Alpha channel of a canvas as floats 0…1. */
function alphaOf(cv: HTMLCanvasElement): Float32Array { const d = imgData(cv).data, a = new Float32Array(cv.width * cv.height); for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255; return a; }
/** Grows (r > 0) or shrinks (r < 0) a 0…1 map by r px: separable max / min (square), then a light blur to round it. */
function morph(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const k = Math.round(Math.abs(r));
  if (!k) return a;
  const grow = r > 0, pick = grow ? Math.max : Math.min, tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = a[y * w + x]; for (let d = 1; d <= k; d++) { if (x - d >= 0) v = pick(v, a[y * w + x - d]); if (x + d < w) v = pick(v, a[y * w + x + d]); } tmp[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = tmp[y * w + x]; for (let d = 1; d <= k; d++) { if (y - d >= 0) v = pick(v, tmp[(y - d) * w + x]); if (y + d < h) v = pick(v, tmp[(y + d) * w + x]); } out[y * w + x] = v; }
  return out;
}
/** Gaussian blur of a 0…1 map (through a canvas). */
function blurMap(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return a;
  const c = mk(w, h), g = ctx2d(c), img = g.createImageData(w, h);
  for (let i = 0; i < a.length; i++) { img.data[i * 4 + 3] = Math.round(a[i] * 255); }
  g.putImageData(img, 0, 0);
  const b = blurCanvas(c, sigma);
  return alphaOf(b);
}
/** Writes a 0…1 map as the canvas alpha (view = show it as grey instead). */
function setAlpha(cv: HTMLCanvasElement, a: Float32Array, view = false): HTMLCanvasElement {
  return pixels(cv, (d) => { for (let i = 0; i < a.length; i++) { if (view) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = a[i] * 255; d[i * 4 + 3] = 255; } else d[i * 4 + 3] = a[i] * 255; } });
}
/** Color / Luma Key edges: a 0…1 matte is thinned (Edge Thin > 0) or grown by whole pixels, then feathered by a blur */
function keyEdges(cv: HTMLCanvasElement, a: Float32Array, thin: number, feather: number, res: number): Float32Array {
  const W = cv.width, H = cv.height;
  if (thin) a = morph(a, W, H, -Math.round(thin) * Math.max(1, res));
  return feather > 0 ? blurMap(a, W, H, (feather * res) / 2) : a;
}
/** The dominant channel of a screen colour (1 = green, 2 = blue, 0 = red) and the other two. */
const screenChannels = (c: number[]): [number, number, number] => { const k = c[1] >= c[2] && c[1] >= c[0] ? 1 : c[2] >= c[0] ? 2 : 0; const o = [0, 1, 2].filter((x) => x !== k); return [k, o[0], o[1]]; };

// ───────────────────────── the catalogue ─────────────────────────
// ───────────────────────── colour helpers ─────────────────────────
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn;
  if (!dd) return [0, 0, l];
  const s = dd / (1 - Math.abs(2 * l - 1) || 1);
  const h = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n0: number) => { const k = (n0 + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
/** Histogram (256 bins) of channel(s) over opaque pixels: 'r' 'g' 'b' or 'l' (luminance) or 'rgb' (all three). */
function histogram(d: Uint8ClampedArray, which: string): Float64Array {
  const hgm = new Float64Array(256);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    if (which === 'rgb') { hgm[d[i]]++; hgm[d[i + 1]]++; hgm[d[i + 2]]++; }
    else if (which === 'l') hgm[Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114)]++;
    else hgm[d[i + ({ r: 0, g: 1, b: 2 } as Record<string, number>)[which]]]++;
  }
  return hgm;
}
// ───────────────────────── simulations (block 4c) ─────────────────────────
/** Atomic Power's camera and lights (Shatter, Card Dance): the Camera System (Camera Position, Corner Pins or the comp
 * camera) and the Lighting / Material groups. Object space = canvas px with the layer on z = 0 and +z away from the
 * viewer. */
type V3 = [number, number, number];
const rotM = (ax: string, a: number): number[] => { const c = Math.cos(a), s = Math.sin(a); return ax === 'x' ? [1, 0, 0, 0, c, -s, 0, s, c] : ax === 'y' ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1]; };
const mul3 = (a: number[], b: number[]) => { const o = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]; return o; };
const mv3 = (m: number[], v: number[]): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const tr3 = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const nrm3 = (v: number[]): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
/** rotation (radians) applied in the given axis order, e.g. 'xyz' = X first */
function rotOrder(order: string, rx: number, ry: number, rz: number): number[] {
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const a of order) m = mul3(rotM(a, a === 'x' ? rx : a === 'y' ? ry : rz), m);
  return m;
}
interface APCam { proj: (P: number[]) => [number, number, number] | null; eye: V3 }
/** the camera of the Camera System: object space → canvas px (+ depth), and the eye in object space */
function apCamera(p: Params, x: FxCtx, W: number, H: number, focalId: string): APCam {
  const cx = W / 2, cy = H / 2, sys = String(p.cameraSystem ?? 'position');
  const f0 = (k: number) => (W * Math.max(1, k)) / 35;
  if (sys === 'comp') {
    const sc = x.scene?.();
    if (sc) return { proj: (P) => { const q = sc.project(P[0] / x.res + x.ox, P[1] / x.res + x.oy, P[2] / x.res); return q[2] <= 1e-3 ? null : [(q[0] - x.ox) * x.res, (q[1] - x.oy) * x.res, q[2]]; }, eye: [cx, cy, -sc.zoom * x.res] };
  }
  if (sys === 'cornerPins') {
    // the plane's homography from the layer's corners to the four pins, split into a pose for the focal length (Auto
    // Focal Length: the one that makes the plane's axes perpendicular)
    const pins = ['pinUL', 'pinUR', 'pinLL', 'pinLR'].map((k) => { const [a, b] = pt(p[k], x); return [a - cx, b - cy]; });
    const Hm = homography([[-cx, -cy], [W - cx, -cy], [-cx, H - cy], [W - cx, H - cy]], pins);
    let f = f0(num(p.pinFocal, 70));
    if (Hm && num(p.autoFocal)) {
      const [a, b, , d, e, , g, h] = Hm, f2a = -(a * b + d * e) / (g * h || 1e-30), f2b = (b * b + e * e - a * a - d * d) / (g * g - h * h || 1e-30);
      const f2 = Math.abs(g * h) > 1e-12 && f2a > 0 ? f2a : Math.abs(g * g - h * h) > 1e-12 && f2b > 0 ? f2b : 0;
      if (f2 > 0 && Number.isFinite(f2)) f = Math.sqrt(f2);
    }
    if (Hm) {
      const h1 = [Hm[0] / f, Hm[3] / f, Hm[6]], h2 = [Hm[1] / f, Hm[4] / f, Hm[7]], h3 = [Hm[2] / f, Hm[5] / f, Hm[8]];
      let lam = 2 / ((Math.hypot(...h1) + Math.hypot(...h2)) || 1);
      if (h3[2] * lam < 0) lam = -lam;
      const r1 = h1.map((v) => v * lam), r2 = h2.map((v) => v * lam), t = h3.map((v) => v * lam);
      const r3 = nrm3([r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]]);
      const R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
      const e = mv3(tr3(R), [-t[0], -t[1], -t[2]]);
      return { proj: (P) => { const c = mv3(R, [P[0] - cx, P[1] - cy, P[2]]), z = c[2] + t[2]; return z <= 1e-3 ? null : [cx + (f * (c[0] + t[0])) / z, cy + (f * (c[1] + t[1])) / z, z]; }, eye: [e[0] + cx, e[1] + cy, e[2]] };
    }
  }
  // Camera Position: the layer turned (X, Y, Z Rotation in the Transform Order) and moved (X,Y Position), seen from
  // Z Position layer widths away through Focal Length (70 = the layer exactly fills its own size at Z 2)
  const ord = String(p.camOrder ?? 'rotXYZ'), posFirst = ord.startsWith('pos'), R = rotOrder(ord.slice(-3).toLowerCase(), rad(num(p.camRotX)), rad(num(p.camRotY)), rad(num(p.camRotZ)));
  const [px, py] = pt(p.camPos ?? [x.ox + W / 2 / x.res, x.oy + H / 2 / x.res], x), T = [px - cx, py - cy, 0], D = num(p.camZ, 2) * W, f = f0(num(p[focalId], 70));
  const fwd = (P: number[]): V3 => { const q = [P[0] - cx, P[1] - cy, P[2]]; if (posFirst) { const r = mv3(R, [q[0] + T[0], q[1] + T[1], q[2]]); return [r[0], r[1], r[2]]; } const r = mv3(R, q); return [r[0] + T[0], r[1] + T[1], r[2]]; };
  const Rt = tr3(R), ec: V3 = [0, 0, -D], e = posFirst ? mv3(Rt, ec).map((v, i) => v - T[i]) : mv3(Rt, [ec[0] - T[0], ec[1] - T[1], ec[2]]);
  return { proj: (P) => { const c = fwd(P), z = c[2] + D; return z <= 1e-3 ? null : [cx + (f * c[0]) / z, cy + (f * c[1]) / z, z]; }, eye: [e[0] + cx, e[1] + cy, e[2]] };
}
/** 3×3 homography (row-major) taking four points to four others, or null */
function homography(src: number[][], dst: number[][]): number[] | null {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [X, Y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * X, -v * X, X]); A.push([0, 0, 0, u, v, 1, -u * Y, -v * Y, Y]);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let j = c; j < 9; j++) A[r][j] -= k * A[c][j]; }
  }
  return [...A.map((r, i) => r[8] / A[i][i]), 1];
}
/** the light of the Lighting group in object space: a direction towards it at a point, and its colour × intensity */
function apLight(p: Params, x: FxCtx, W: number, H: number): { dir: (P: number[]) => V3; col: V3 } {
  const type = String(p.lightType ?? 'distant'), k = num(p.lightIntensity, 1), lc = parseColor(String(p.lightColor ?? '#ffffff'));
  if (type === 'firstComp') {
    const L = x.scene?.()?.lights.find((q) => q.type !== 'ambient');
    if (L) {
      const col: V3 = [L.color[0], L.color[1], L.color[2]];
      if (L.type === 'parallel') { const d = nrm3([-L.dir[0], -L.dir[1], -L.dir[2]]); return { dir: () => d, col }; }
      const lp = [(L.pos[0] - x.ox) * x.res, (L.pos[1] - x.oy) * x.res, L.pos[2] * x.res];
      return { dir: (P) => nrm3([lp[0] - P[0], lp[1] - P[1], lp[2] - P[2]]), col };
    }
  }
  // Light Position on the layer, Light Depth layer widths towards the viewer; a distant source shines from there
  // towards the layer's centre everywhere
  const [lx, ly] = p.lightPosition === undefined ? [W / 2, H / 2] : pt(p.lightPosition, x), lz = -num(p.lightDepth, 1) * W, col: V3 = [lc[0] * k, lc[1] * k, lc[2] * k];
  if (type === 'point') return { dir: (P) => nrm3([lx - P[0], ly - P[1], lz - P[2]]), col };
  const d = nrm3([lx - W / 2, ly - H / 2, lz]);
  return { dir: () => d, col };
}
/** a face to draw: its source pixels (sp, in src's px) land on scr (canvas px) */
interface APFace { src: HTMLCanvasElement; sp: number[]; scr: number[]; depth: number; P: number[]; N: V3; /** px the clip grows outwards (no seams between neighbours) */ grow?: number }
/** Draws the faces far to near, each textured by the affine map that best fits its points; then shades them
 * (Material: Ambient + Diffuse × N·L in the light's colour, plus Specular with Highlight Sharpness), the shading
 * worked out per face and applied per pixel through a second buffer so overlapping faces keep their own. */
function apDraw(W: number, H: number, faces: APFace[], p: Params, x: FxCtx, cam: APCam, wire: boolean): HTMLCanvasElement {
  const out = mk(W, H), g = ctx2d(out);
  faces.sort((a, b) => b.depth - a.depth);
  if (wire) {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = '#ffffff'; g.lineWidth = 1;
    for (const f of faces) { g.beginPath(); for (let k = 0; k < f.scr.length; k += 2) g.lineTo(f.scr[k], f.scr[k + 1]); g.closePath(); g.stroke(); }
    return out;
  }
  const amb = num(p.ambient, 0.25), dif = num(p.diffuse, 0.75), spe = num(p.specular), sharp = Math.max(0, num(p.sharpness, 10)), L = apLight(p, x, W, H);
  const shade = mk(W, H), sg = ctx2d(shade), hi = spe > 0 ? mk(W, H) : null, hg = hi ? ctx2d(hi) : null;
  let lit = false;
  for (const f of faces) {
    const n = f.scr.length / 2, path = new Path2D();
    let mx = 0, my = 0; for (let k = 0; k < n; k++) { mx += f.scr[k * 2] / n; my += f.scr[k * 2 + 1] / n; }
    for (let k = 0; k < n; k++) { const X = f.scr[k * 2], Y = f.scr[k * 2 + 1], l = Math.hypot(X - mx, Y - my) || 1, gr = f.grow ?? 0.5; path.lineTo(X + ((X - mx) / l) * gr, Y + ((Y - my) / l) * gr); }
    path.closePath();
    // least-squares affine from the source points to the screen ones
    let a = 0, b = 0, c = 0, d = 0, e = 0, ff = 0, su = 0, sv = 0, suu = 0, suv = 0, svv = 0, sx = 0, sy = 0, sux = 0, svx = 0, suy = 0, svy = 0;
    for (let k = 0; k < n; k++) { const u = f.sp[k * 2], v = f.sp[k * 2 + 1], X = f.scr[k * 2], Y = f.scr[k * 2 + 1]; su += u; sv += v; suu += u * u; suv += u * v; svv += v * v; sx += X; sy += Y; sux += u * X; svx += v * X; suy += u * Y; svy += v * Y; }
    const M = [suu, suv, su, suv, svv, sv, su, sv, n], det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
    if (Math.abs(det) < 1e-9) continue;
    const solve = (r0: number, r1: number, r2: number) => {
      const dx = r0 * (M[4] * M[8] - M[5] * M[7]) - M[1] * (r1 * M[8] - M[5] * r2) + M[2] * (r1 * M[7] - M[4] * r2);
      const dy = M[0] * (r1 * M[8] - M[5] * r2) - r0 * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * r2 - r1 * M[6]);
      const dz = M[0] * (M[4] * r2 - r1 * M[7]) - M[1] * (M[3] * r2 - r1 * M[6]) + r0 * (M[3] * M[7] - M[4] * M[6]);
      return [dx / det, dy / det, dz / det];
    };
    [a, c, e] = solve(sux, svx, sx); [b, d, ff] = solve(suy, svy, sy);
    g.save(); g.clip(path); g.setTransform(a, b, c, d, e, ff); g.drawImage(f.src, 0, 0); g.restore();
    // two-sided: light the side that faces the eye
    let N = f.N; const V = nrm3([cam.eye[0] - f.P[0], cam.eye[1] - f.P[1], cam.eye[2] - f.P[2]]);
    if (N[0] * V[0] + N[1] * V[1] + N[2] * V[2] < 0) N = [-N[0], -N[1], -N[2]];
    const Ld = L.dir(f.P), nl = Math.max(0, N[0] * Ld[0] + N[1] * Ld[1] + N[2] * Ld[2]);
    const k = [0, 1, 2].map((i) => amb + dif * nl * L.col[i]);
    if (k.some((v) => Math.abs(v - 1) > 0.004)) lit = true;
    sg.fillStyle = `rgb(${k.map((v) => Math.round(Math.max(0, Math.min(2, v)) * 127.5)).join(',')})`; sg.fill(path);
    if (hg) {
      const R = [2 * nl * N[0] - Ld[0], 2 * nl * N[1] - Ld[1], 2 * nl * N[2] - Ld[2]], rv = nl > 0 ? Math.max(0, R[0] * V[0] + R[1] * V[1] + R[2] * V[2]) : 0, s = spe * Math.pow(rv, sharp);
      hg.fillStyle = `rgb(${L.col.map((v) => Math.round(Math.min(1, s * v) * 255)).join(',')})`; hg.fill(path);
    }
  }
  if (!lit && !hi) return out;
  const img = g.getImageData(0, 0, W, H), o = img.data, sd = sg.getImageData(0, 0, W, H).data, hd = hg ? hg.getImageData(0, 0, W, H).data : null;
  for (let i = 0; i < o.length; i += 4) {
    if (!o[i + 3]) continue;
    const al = o[i + 3] / 255;
    for (let c = 0; c < 3; c++) o[i + c] = Math.min(255, o[i + c] * (sd[i + c] / 127.5) + (hd ? hd[i + c] * al : 0));
  }
  g.putImageData(img, 0, 0);
  return out;
}

/** Shatter's pieces in layer canvas pixels: polygons of a pattern repeated `rep` times across the width. */
function shatterPieces(W: number, H: number, pattern: string, rep: number, dir: number, ox: number, oy: number, seed: number): number[][] {
  const s = Math.max(4, W / Math.max(1, rep)), out: number[][] = [];
  const ca = Math.cos(dir), sa = Math.sin(dir);
  const T = (x: number, y: number) => [ox + (x - ox) * ca - (y - oy) * sa, oy + (x - ox) * sa + (y - oy) * ca];
  const R = Math.hypot(W, H);
  const poly = (pts: number[][]) => out.push(pts.flatMap(([x, y]) => T(x, y)));
  if (pattern === 'glass') {
    // Voronoi-like shards: random sites, each pixel cell grown as a convex polygon by clipping
    const n = Math.max(4, Math.round(rep * rep * (H / W) * 0.8)), sites: number[][] = [];
    for (let i = 0; i < n; i++) sites.push([rnd(seed, i * 2) * W, rnd(seed, i * 2 + 1) * H]);
    for (const [px, py] of sites) {
      let cell = [[0, 0], [W, 0], [W, H], [0, H]];
      for (const [qx, qy] of sites) {
        if (qx === px && qy === py) continue;
        const mx = (px + qx) / 2, my = (py + qy) / 2, nx = qx - px, ny = qy - py, next: number[][] = [];
        for (let k = 0; k < cell.length; k++) {
          const a = cell[k], b = cell[(k + 1) % cell.length], da = (a[0] - mx) * nx + (a[1] - my) * ny, db = (b[0] - mx) * nx + (b[1] - my) * ny;
          if (da <= 0) next.push(a);
          if (da * db < 0) { const f = da / (da - db); next.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
        }
        cell = next;
        if (cell.length < 3) break;
      }
      if (cell.length >= 3) out.push(cell.flat());
    }
    return out;
  }
  for (let y = -R; y < R; y += pattern === 'hexagons' ? s * 0.866 : pattern === 'bricks' || pattern === 'planks' || pattern === 'rhombi' ? s / 2 : s) {
    const row = Math.round(y / s);
    for (let x = -R; x < R; x += s) {
      if (pattern === 'bricks') poly([[x + (row % 2) * s / 2, y], [x + s + (row % 2) * s / 2, y], [x + s + (row % 2) * s / 2, y + s / 2], [x + (row % 2) * s / 2, y + s / 2]]);
      else if (pattern === 'squares') poly([[x, y], [x + s, y], [x + s, y + s], [x, y + s]]);
      else if (pattern === 'triangles') { poly([[x, y], [x + s, y], [x, y + s]]); poly([[x + s, y], [x + s, y + s], [x, y + s]]); }
      // Triangles 2: each square cut along the other diagonal on every other row
      else if (pattern === 'triangles2') { if (row % 2) { poly([[x, y], [x + s, y], [x + s, y + s]]); poly([[x, y], [x + s, y + s], [x, y + s]]); } else { poly([[x, y], [x + s, y], [x, y + s]]); poly([[x + s, y], [x + s, y + s], [x, y + s]]); } }
      // Planks: long boards (4 : 1), each row shifted by a random amount
      else if (pattern === 'planks') { if (Math.round(x / s) % 4 === 0) { const o = (rnd(seed, row * 3 + 7) - 1) * s * 4; poly([[x + o, y], [x + o + s * 4, y], [x + o + s * 4, y + s / 2], [x + o, y + s / 2]]); } }
      // Rhombi: diamonds on a staggered grid
      else if (pattern === 'rhombi') { const cx = x + (row % 2) * s / 2; poly([[cx, y - s / 2], [cx + s / 2, y], [cx, y + s / 2], [cx - s / 2, y]]); }
      else { const cx = x + (Math.abs(Math.round(y / (s * 0.866))) % 2) * s / 2, r = s / 1.732; poly(Array.from({ length: 6 }, (_, k) => [cx + r * Math.cos((k * Math.PI) / 3 + Math.PI / 6), y + r * Math.sin((k * Math.PI) / 3 + Math.PI / 6)])); }
    }
  }
  return out;
}
const waveCache = new Map<string, { t: number; h: Float32Array; v: Float32Array }>();

// ───────────────────────── distortion (block 4b) ─────────────────────────
/** Each output pixel takes the source pixel that `src(x, y)` returns (bilinear; outside = transparent). */
function remap(cv: HTMLCanvasElement, src: (x: number, y: number) => [number, number] | null): HTMLCanvasElement {
  const W = cv.width, H = cv.height, s = ctx2d(cv).getImageData(0, 0, W, H).data, out = new ImageData(W, H), o = out.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = src(x + 0.5, y + 0.5);
    if (!q) continue;
    const fx = q[0] - 0.5, fy = q[1] - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, i = (y * W + x) * 4;
    for (let c = 0; c < 4; c++) {
      let v = 0;
      for (const [dx, dy, w] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]] as const) {
        const X = x0 + dx, Y = y0 + dy;
        if (X >= 0 && Y >= 0 && X < W && Y < H) v += s[(Y * W + X) * 4 + c] * w;
      }
      o[i + c] = v;
    }
  }
  const r = mk(W, H); ctx2d(r).putImageData(out, 0, 0); return r;
}
let meshGL: GLMesh | null = null;
/** Forward warp: a grid over the source (n × n cells) whose vertices go where `to(u, v)` says (canvas px). */
function warpGrid(cv: HTMLCanvasElement, n: number, to: (u: number, v: number) => [number, number] | null): HTMLCanvasElement {
  const N = n + 1, pos = new Float32Array(N * N * 2), uv = new Float32Array(N * N * 2), keep = new Uint8Array(N * N), tris: number[] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, u = i / n, v = j / n, p = to(u, v);
    uv[k * 2] = u; uv[k * 2 + 1] = v;
    if (p) { pos[k * 2] = p[0]; pos[k * 2 + 1] = p[1]; keep[k] = 1; }
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    if (keep[a] && keep[b] && keep[d]) tris.push(a, b, d);
    if (keep[a] && keep[d] && keep[c]) tris.push(a, d, c);
  }
  meshGL ??= new GLMesh();
  const out = mk(cv.width, cv.height);
  if (tris.length) ctx2d(out).drawImage(meshGL.draw(cv, cv.width, cv.height, pos, uv, new Uint32Array(tris)), 0, 0);
  return out;
}
const cubic = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
/** Catmull-Rom between grid values (smooth mesh warp). */
const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
let quadGL: GLQuad | null = null;

// ───────────────────────── mask generators (block 4a) ─────────────────────────
type MaskOutline = NonNullable<FxCtx['masks']>[number];
/** The masks an effect draws on: one by name / id (or the first), or all of them. */
function pickMasks(x: FxCtx, name: string, all: boolean): MaskOutline[] {
  const ms = x.masks ?? [];
  if (all) return ms;
  const m = name ? ms.find((y) => y.name === name || y.id === name || y.name.toLowerCase() === name.toLowerCase()) : ms[0];
  return m ? [m] : [];
}
/** A mask's outline in canvas pixels (closed: the first point repeated at the end). */
function canvasPts(m: MaskOutline, x: FxCtx, closed: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < m.pts.length; i += 2) out.push((m.pts[i] - x.ox) * x.res, (m.pts[i + 1] - x.oy) * x.res);
  if (closed && out.length >= 4) out.push(out[0], out[1]);
  return out;
}
const polyPath = (m: MaskOutline, x: FxCtx) => { const p = canvasPts(m, x, false), path = new Path2D(); for (let i = 0; i < p.length; i += 2) { if (i) path.lineTo(p[i], p[i + 1]); else path.moveTo(p[i], p[i + 1]); } path.closePath(); return path; };
const polyLength = (p: number[]) => { let L = 0; for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; };
function pointAt(p: number[], d: number): [number, number] {
  for (let i = 2; i < p.length; i += 2) { const l = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); if (d <= l) { const f = l ? d / l : 0; return [p[i - 2] + (p[i] - p[i - 2]) * f, p[i - 1] + (p[i + 1] - p[i - 1]) * f]; } d -= l; }
  return [p[p.length - 2], p[p.length - 1]];
}
function slicePoly(p: number[], a: number, b: number): number[] {
  const out: number[] = [...pointAt(p, a)];
  let acc = 0;
  for (let i = 2; i < p.length; i += 2) { acc += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); if (acc > a && acc < b) out.push(p[i], p[i + 1]); }
  out.push(...pointAt(p, b));
  return out;
}
/** A round brush dab: hardness is the part of the radius at full strength. */
function dab(g: CanvasRenderingContext2D, x0: number, y0: number, r: number, hard: number, color: string, alpha: number) {
  if (r <= 0) return;
  const gr = g.createRadialGradient(x0, y0, 0, x0, y0, r);
  gr.addColorStop(0, rgba(color, alpha)); gr.addColorStop(Math.max(0, Math.min(0.999, hard)), rgba(color, alpha)); gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr; g.beginPath(); g.arc(x0, y0, r, 0, Math.PI * 2); g.fill();
}
/** Paint style of Stroke / Write-on / Scribble: over the layer, alone, or revealing the layer where painted. */
function paintStyle(cv: HTMLCanvasElement, ink: HTMLCanvasElement, style: string, opacity: number): HTMLCanvasElement {
  const out = style === 'original' ? clone(cv) : mk(cv.width, cv.height), g = ctx2d(out);
  if (style === 'reveal') { g.globalAlpha = opacity; g.drawImage(ink, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-in'; g.drawImage(cv, 0, 0); return out; }
  g.globalAlpha = opacity; g.drawImage(ink, 0, 0); g.globalAlpha = 1;
  return out;
}
const mixHex = (a: string, b: string, u: number) => { const p = parseColor(a), q = parseColor(b); return `rgb(${[0, 1, 2].map((i) => Math.round((p[i] + (q[i] - p[i]) * u) * 255)).join(',')})`; };
/** Outlines of an image (marching squares on a channel over a threshold), as closed polylines in its pixels. */
function contours(cv: HTMLCanvasElement, channel: string, threshold: number, invert = false): number[][] {
  const W = cv.width, H = cv.height, step = Math.max(1, Math.round(Math.max(W, H) / 400));
  const d = ctx2d(cv).getImageData(0, 0, W, H).data;
  const gw = Math.ceil(W / step) + 2, gh = Math.ceil(H / step) + 2;
  const v = new Float32Array(gw * gh);
  for (let gy = 1; gy < gh - 1; gy++) for (let gx = 1; gx < gw - 1; gx++) {
    const px = Math.min(W - 1, (gx - 1) * step), py = Math.min(H - 1, (gy - 1) * step), i = (py * W + px) * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // Vegas / Radio Waves channels (After Effects): hue, lightness, saturation and value besides RGBA and intensity
    const hue = () => { if (mx === mn) return 0; const c = mx - mn, h = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4; return (h / 6) * 255; };
    let val = channel === 'alpha' ? d[i + 3] : channel === 'red' ? r : channel === 'green' ? g : channel === 'blue' ? b : channel === 'hue' ? hue() : channel === 'lightness' ? (mx + mn) / 2 : channel === 'saturation' ? (mx ? ((mx - mn) / mx) * 255 : 0) : channel === 'value' ? mx : (r * 0.299 + g * 0.587 + b * 0.114) * (d[i + 3] / 255);
    if (invert) val = 255 - val;
    v[gy * gw + gx] = val;
  }
  // segments per cell, then joined end to end
  const segs = new Map<string, [number, number, number, number][]>();
  const key = (x0: number, y0: number) => `${Math.round(x0 * 2)},${Math.round(y0 * 2)}`;
  const add = (a: [number, number], b: [number, number]) => { const s: [number, number, number, number] = [a[0], a[1], b[0], b[1]]; for (const k of [key(a[0], a[1]), key(b[0], b[1])]) (segs.get(k) ?? segs.set(k, []).get(k)!).push(s); };
  const lerpE = (a: number, b: number) => (threshold - a) / ((b - a) || 1e-6);
  for (let gy = 0; gy < gh - 1; gy++) for (let gx = 0; gx < gw - 1; gx++) {
    const a = v[gy * gw + gx], b = v[gy * gw + gx + 1], c = v[(gy + 1) * gw + gx + 1], e = v[(gy + 1) * gw + gx];
    const idx = (a > threshold ? 8 : 0) | (b > threshold ? 4 : 0) | (c > threshold ? 2 : 0) | (e > threshold ? 1 : 0);
    if (!idx || idx === 15) continue;
    const top: [number, number] = [gx + lerpE(a, b), gy], right: [number, number] = [gx + 1, gy + lerpE(b, c)], bottom: [number, number] = [gx + lerpE(e, c), gy + 1], left: [number, number] = [gx, gy + lerpE(a, e)];
    const table: Record<number, [number, number][][]> = { 1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bottom, right]], 6: [[top, bottom]], 7: [[left, top]], 8: [[left, top]], 9: [[top, bottom]], 10: [[left, bottom], [top, right]], 11: [[top, right]], 12: [[left, right]], 13: [[bottom, right]], 14: [[left, bottom]] };
    for (const [p1, p2] of table[idx] ?? []) add(p1, p2);
  }
  const used = new Set<[number, number, number, number]>(), out: number[][] = [];
  for (const list of segs.values()) for (const s0 of list) {
    if (used.has(s0)) continue;
    used.add(s0);
    const line = [s0[0], s0[1], s0[2], s0[3]];
    for (let guard = 0; guard < 100000; guard++) {
      const ex = line[line.length - 2], ey = line[line.length - 1];
      const next = (segs.get(key(ex, ey)) ?? []).find((s) => !used.has(s));
      if (!next) break;
      used.add(next);
      if (key(next[0], next[1]) === key(ex, ey)) line.push(next[2], next[3]); else line.push(next[0], next[1]);
    }
    if (line.length >= 8) out.push(line.map((q, i) => (i % 2 ? (q - 1) * step : (q - 1) * step)));
  }
  return out.sort((a, b) => b.length - a.length);
}

// ───────────────────────── 3D Channel (EXR) ─────────────────────────
/** For every canvas pixel, the EXR pixel under it (the layer's own coordinates), or −1 outside. */
function auxIndex(cv: HTMLCanvasElement, x: FxCtx, a: Aux): Int32Array {
  const W = cv.width, H = cv.height, idx = new Int32Array(W * H);
  for (let py = 0; py < H; py++) {
    const Y = Math.floor(x.oy + (py + 0.5) / x.res);
    for (let px = 0; px < W; px++) { const X = Math.floor(x.ox + (px + 0.5) / x.res); idx[py * W + px] = X >= 0 && Y >= 0 && X < a.w && Y < a.h ? Y * a.w + X : -1; }
  }
  return idx;
}
/** Preview colour of an ID: from its bits (as the Cryptomatte and IDentifier previews do), never too dark. */
const idColor = (bits: number): [number, number, number] => { const h = hash2(bits >>> 0, 0x5bd1e995); return [64 + (h & 191), 64 + ((h >>> 8) & 191), 64 + ((h >>> 16) & 191)]; };
/** Ranked (ID, coverage) channel pairs of a Cryptomatte layer: NN.R/G and NN.B/A for every NN. */
function cryptoRanks(a: Aux, names: string[]): { id: Uint32Array; cov: Float32Array }[] {
  const groups = new Map<string, string[]>();
  for (const n of names) { const i = n.lastIndexOf('.'); if (i > 0) (groups.get(n.slice(0, i)) ?? groups.set(n.slice(0, i), []).get(n.slice(0, i))!).push(n); }
  const out: { id: Uint32Array; cov: Float32Array }[] = [];
  for (const [g] of [...groups].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
    const c = (s: string, l: string) => a.get(`${g}.${s}`) ?? a.get(`${g}.${l}`);
    const r = c('R', 'red'), gg = c('G', 'green'), b = c('B', 'blue'), al = c('A', 'alpha');
    if (r && gg) out.push({ id: r.bits, cov: gg.f });
    if (b && al) out.push({ id: b.bits, cov: al.f });
  }
  return out;
}
const fromAux = (cv: HTMLCanvasElement, x: FxCtx, fn: (src: Uint8ClampedArray, out: Uint8ClampedArray, idx: Int32Array, a: Aux) => void) => {
  const a = x.aux;
  if (!a) return cv;
  const src = ctx2d(cv).getImageData(0, 0, cv.width, cv.height), out = new ImageData(cv.width, cv.height);
  fn(src.data, out.data, auxIndex(cv, x, a), a);
  const o = mk(cv.width, cv.height);
  ctx2d(o).putImageData(out, 0, 0);
  return o;
};

export const FX_IMPL: Record<string, FxFn> = {
  // time effects are done by the renderer before the other effects (they need the layer at other moments)
  timeDisplacement: (cv) => cv,
  wideTime: (cv) => cv,
  timeBlend: (cv) => cv,
  // EXtractoR: any four channels to RGBA, black / white points, optional unmultiply
  extractor: (cv, p, x) => fromAux(cv, x, (_s, out, idx, a) => {
    const ch = (k: string) => a.get(String(p[k] ?? ''))?.f ?? null;
    const R = ch('red'), G = ch('green'), B = ch('blue'), A = ch('alpha');
    const bp = num(p.blackPoint), wp = num(p.whitePoint, 1), span = wp - bp || 1e-6, um = !!num(p.unmult);
    const lv = (v: number) => (v - bp) / span;
    for (let i = 0; i < idx.length; i++) {
      const k = idx[i];
      if (k < 0) continue;
      const al = A ? Math.max(0, Math.min(1, A[k])) : 1;
      let r = R ? lv(R[k]) : 0, g = G ? lv(G[k]) : 0, b = B ? lv(B[k]) : 0;
      if (um && al > 0) { r /= al; g /= al; b /= al; }
      out[i * 4] = r * 255; out[i * 4 + 1] = g * 255; out[i * 4 + 2] = b * 255; out[i * 4 + 3] = al * 255;
    }
  }),
  // IDentifier: object IDs as colours, a luma or alpha matte of one ID, or the raw values
  identifier: (cv, p, x) => fromAux(cv, x, (src, out, idx, a) => {
    // the channel chosen, else the first one that looks like an object ID
    const c = a.get(String(p.channel ?? '')) ?? a.names.map((n) => (/(^|\.)(id|objectid|object_id|matid|material_id)$/i.test(n) ? a.get(n) : null)).find(Boolean) ?? null;
    if (!c) return;
    const val = (k: number) => (c.type === 0 ? c.bits[k] : Math.round(c.f[k]));
    const want = Math.round(num(p.id)), mode = String(p.display ?? 'colors');
    let max = 1;
    if (mode === 'raw') for (let i = 0; i < idx.length; i++) if (idx[i] >= 0) max = Math.max(max, val(idx[i]));
    for (let i = 0; i < idx.length; i++) {
      const k = idx[i], o = i * 4;
      if (k < 0) continue;
      const v = val(k), hit = v === want;
      if (mode === 'colors') { const col = idColor(v); out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255; }
      else if (mode === 'luma') { out[o] = out[o + 1] = out[o + 2] = hit ? 255 : 0; out[o + 3] = 255; }
      else if (mode === 'alpha') { out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; out[o + 3] = hit ? src[o + 3] : 0; }
      else { out[o] = out[o + 1] = out[o + 2] = (v / max) * 255; out[o + 3] = 255; }
    }
  }),
  // Cryptomatte: the matte of the objects chosen by name (sum of their coverage over every rank)
  cryptomatte: (cv, p, x) => fromAux(cv, x, (src, out, idx, a) => {
    const ranks = cryptoRanks(a, a.names.filter((n) => /\d\d\.(R|G|B|A|red|green|blue|alpha)$/.test(n)));
    const sel = a.ids ?? new Set<number>(), mode = String(p.output ?? 'colors');
    for (let i = 0; i < idx.length; i++) {
      const k = idx[i], o = i * 4;
      if (k < 0) continue;
      let m = 0, cr = 0, cg = 0, cb = 0;
      for (const r of ranks) {
        const cov = r.cov[k];
        if (!cov) continue;
        const id = r.id[k];
        if (sel.has(id)) m += cov;
        const col = idColor(id);
        cr += col[0] * cov; cg += col[1] * cov; cb += col[2] * cov;
      }
      m = Math.max(0, Math.min(1, m));
      if (mode === 'colors') { const hl = 1 + m * 0.6; out[o] = cr * hl; out[o + 1] = cg * hl; out[o + 2] = cb * hl; out[o + 3] = 255; }
      else if (mode === 'mattedColors') { out[o] = cr; out[o + 1] = cg; out[o + 2] = cb; out[o + 3] = m * 255; }
      else if (mode === 'mattedRGBA') { out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; out[o + 3] = src[o + 3] * m; }
      else { out[o] = out[o + 1] = out[o + 2] = m * 255; out[o + 3] = 255; }
    }
  }),
  gaussianBlur: (cv, p, x) => {
    const sigma = (num(p.amount) / 2) * x.res;
    if (!num(p.repeat)) return blurCanvas(cv, sigma, String(p.dir ?? 'both'));
    // repeat edge pixels: extend the borders before blurring, then crop
    const pad = Math.ceil(sigma * 3);
    const big = mk(cv.width + pad * 2, cv.height + pad * 2);
    const g = ctx2d(big);
    g.drawImage(cv, pad, pad);
    g.drawImage(cv, 0, 0, cv.width, 1, pad, 0, cv.width, pad);
    g.drawImage(cv, 0, cv.height - 1, cv.width, 1, pad, pad + cv.height, cv.width, pad);
    g.drawImage(big, pad, 0, 1, big.height, 0, 0, pad, big.height);
    g.drawImage(big, pad + cv.width - 1, 0, 1, big.height, pad + cv.width, 0, pad, big.height);
    const bl = blurCanvas(big, sigma, String(p.dir ?? 'both'));
    const out = mk(cv.width, cv.height);
    ctx2d(out).drawImage(bl, -pad, -pad);
    return out;
  },
  directionalBlur: (cv, p, x) => {
    const L = num(p.length) * x.res, a = rad(num(p.angle) - 90);
    if (L < 0.5) return cv;
    const n = Math.max(3, Math.min(48, Math.ceil(L / 2)));
    return drawCopies(cv, n, (g, f) => g.translate(Math.cos(a) * L * f, Math.sin(a) * L * f));
  },
  radialBlur: (cv, p, x) => {
    // After Effects' Radial Blur: Spin turns through «amount» degrees, Zoom streaks outwards (amount 100 ≈ ±50 %);
    // High antialiasing takes more samples
    const amt = num(p.amount) / 100;
    if (amt <= 0) return cv;
    const [cx, cy] = pt(p.center, x);
    const spin = (p.type ?? 'spin') === 'spin', hi = p.aa === 'high';
    const R = Math.hypot(cv.width, cv.height) / 2, span = spin ? rad(amt * 100) * R : amt * 0.5 * R;
    const n = Math.max(4, Math.min(hi ? 256 : 64, Math.ceil(span / (hi ? 1 : 2))));
    return drawCopies(cv, n, (g, f) => { g.translate(cx, cy); if (spin) g.rotate(f * rad(amt * 100)); else { const s = 1 + f * amt * 0.5; g.scale(s, s); } g.translate(-cx, -cy); });
  },
  sharpen: (cv, p) => {
    const a = num(p.amount) / 100;
    if (a <= 0) return cv;
    const src = ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height).data.slice();
    return pixels(cv, (d, w, h) => {
      for (let y = 1; y < h - 1; y++) for (let x0 = 1; x0 < w - 1; x0++) {
        const i = (y * w + x0) * 4;
        for (let c = 0; c < 3; c++) {
          const lap = 4 * src[i + c] - src[i + c - 4] - src[i + c + 4] - src[i + c - w * 4] - src[i + c + w * 4];
          d[i + c] = src[i + c] + lap * a;
        }
      }
    });
  },
  // brightnessContrast: fx-groups/color.ts
  // Hue/Saturation (Photoshop's model, as After Effects): in HSL, each colour range (full ±15° around its centre,
  // fading out by ±45°) adds its own hue / saturation / lightness to the master ones; lightness goes towards black
  // or white. Colorize paints the lightness with one hue and saturation.
  hueSat: (cv, p) => {
    const rng = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'].map((k, i) => [i * 60, num(p[`${k}Hue`]), num(p[`${k}Sat`]) / 100, num(p[`${k}Light`]) / 100]).filter((r) => r[1] || r[2] || r[3]);
    const mh = num(p.hue) / 360, ms = num(p.sat) / 100, ml = num(p.light) / 100;
    const sat = (s: number, k: number) => Math.max(0, Math.min(1, s * (1 + k)));
    const light = (v: number, k: number) => (k >= 0 ? v + (1 - v) * k : v * (1 + k));
    if (num(p.colorize)) {
      const ch = num(p.cHue) / 360, cs = num(p.cSat, 25) / 100, cl = num(p.cLight) / 100;
      return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { const L = light(lum(d[i], d[i + 1], d[i + 2]) / 255, cl); const o = hslRgb(((ch % 1) + 1) % 1, cs, Math.max(0, Math.min(1, L))); d[i] = o[0] * 255; d[i + 1] = o[1] * 255; d[i + 2] = o[2] * 255; } });
    }
    if (!rng.length && !mh && !ms && !ml) return cv;
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        let [h, s, l] = rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        let dh = mh, kl = 0;
        if (s > 0) for (const [c, rh, rs, rl] of rng) {
          let a = Math.abs(h * 360 - c) % 360; if (a > 180) a = 360 - a;
          const w = Math.max(0, Math.min(1, (45 - a) / 30));
          if (w) { dh += (w * rh) / 360; s = sat(s, w * rs); kl += w * rl; }
        }
        s = sat(s, ms);
        let o = hslToRgb((((h + dh) % 1) + 1) % 1, s, l);
        if (kl) o = o.map((v) => light(v, kl)) as [number, number, number];
        if (ml) o = o.map((v) => light(v, ml)) as [number, number, number];
        d[i] = o[0] * 255; d[i + 1] = o[1] * 255; d[i + 2] = o[2] * 255;
      }
    });
  },
  levels: (cv, p) => {
    const ib = num(p.inBlack), iw = Math.max(ib + 1, num(p.inWhite, 255)), [cb, cw] = levelClip(p);
    return lut(cv, (v) => level(v, ib, iw, num(p.gamma, 1), num(p.outBlack), num(p.outWhite, 255), cb, cw));
  },
  // lumetri: fx-groups/color.ts (look, HSL secondary, HDR)
  // Equalize: spreads the values evenly (histogram equalisation) per channel, on brightness, or Photoshop style
  // (one table from all three channels together); Amount blends it in
  equalize: (cv, p) => {
    const amt = num(p.amount, 100) / 100, mode = String(p.mode ?? 'rgb');
    const d0 = ctx2d(cv).getImageData(0, 0, cv.width, cv.height).data;
    const table = (h: Float64Array) => { const t = new Float32Array(256), total = h.reduce((a, b) => a + b, 0) || 1; let acc = 0; for (let i = 0; i < 256; i++) { acc += h[i]; t[i] = (acc / total) * 255; } return t; };
    const tR = table(histogram(d0, mode === 'rgb' ? 'r' : mode === 'photoshop' ? 'rgb' : 'l')), tG = mode === 'rgb' ? table(histogram(d0, 'g')) : tR, tB = mode === 'rgb' ? table(histogram(d0, 'b')) : tR;
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        if (mode === 'brightness') {
          const L = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114), k = L ? tR[L] / L : 1;
          for (let c = 0; c < 3; c++) d[i + c] += (d[i + c] * k - d[i + c]) * amt;
        } else { d[i] += (tR[d[i]] - d[i]) * amt; d[i + 1] += (tG[d[i + 1]] - d[i + 1]) * amt; d[i + 2] += (tB[d[i + 2]] - d[i + 2]) * amt; }
      }
    });
  },
  // autoLevels, autoContrast, autoColor: fx-groups/color.ts (temporal smoothing)
  // Leave Color: everything except the colour to leave (within tolerance, soft edge) loses its colour by Amount
  leaveColor: (cv, p) => {
    const tgt = parseColor(String(p.color ?? '#f00')), amt = num(p.amount) / 100, tol = num(p.tolerance, 15) / 100, soft = num(p.softness) / 100, byHue = String(p.match ?? 'rgb') === 'hue';
    const th = rgbToHsl(tgt[0], tgt[1], tgt[2])[0];
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        let dist: number;
        if (byHue) { const [h, s] = rgbToHsl(r, g, b); const dh = Math.min(Math.abs(h - th), 1 - Math.abs(h - th)) * 2; dist = s < 0.05 ? 1 : dh; }
        else dist = Math.hypot(r - tgt[0], g - tgt[1], b - tgt[2]) / Math.sqrt(3);
        const keep = dist <= tol ? 1 : soft > 0 ? Math.max(0, 1 - (dist - tol) / soft) : 0, k = amt * (1 - keep);
        const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] += (L - d[i]) * k; d[i + 1] += (L - d[i + 1]) * k; d[i + 2] += (L - d[i + 2]) * k;
      }
    });
  },
  // Remove Color Matting: undoes premultiplication against a background colour (c = (c − bg·(1 − a)) / a)
  removeMatting: (cv, p) => {
    const bg = parseColor(String(p.background ?? '#000000')).slice(0, 3).map((v) => v * 255), clip = !!num(p.clipHdr, 1);
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        if (a <= 0 || a >= 1) continue;
        for (let c = 0; c < 3; c++) { const v = (d[i + c] - bg[c] * (1 - a)) / a; d[i + c] = clip ? Math.max(0, Math.min(255, v)) : v; }
      }
    });
  },
  changeColor: (cv, p) => {
    const tgt = parseColor(String(p.color ?? '#f00')), match = String(p.match ?? 'rgb'); // AE default: using RGB
    const hsl = (r: number, g: number, b: number): [number, number, number] => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn; if (!dd) return [0, 0, l]; const s = dd / (1 - Math.abs(2 * l - 1)); const h = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; return [h / 6, s, l]; };
    const rgb = (h: number, s: number, l: number): [number, number, number] => { const f = (n0: number) => { const k = (n0 + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return [f(0), f(8), f(4)]; };
    const T = hsl(tgt[0], tgt[1], tgt[2]), tol = num(p.tolerance, 15) / 100, soft = num(p.softness) / 100;
    const dh = num(p.hue) / 360, dl = num(p.lightness) / 100, ds = num(p.saturation) / 100, inv = !!num(p.invert), view = p.view === 'mask';
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, c = hsl(r, g, b);
        // distance to the colour to change: hue only, full RGB, or chroma (colour without its lightness)
        let dist: number;
        if (match === 'rgb') dist = Math.hypot(r - tgt[0], g - tgt[1], b - tgt[2]) / Math.sqrt(3);
        else if (match === 'chroma') { const s1 = r + g + b || 1e-6, s2 = tgt[0] + tgt[1] + tgt[2] || 1e-6; dist = Math.hypot(r / s1 - tgt[0] / s2, g / s1 - tgt[1] / s2) * 1.2; }
        else { let hd = Math.abs(c[0] - T[0]); hd = Math.min(hd, 1 - hd) * 2; dist = hd * (c[1] > 0.02 ? 1 : 2); }
        let w = dist <= tol ? 1 : soft > 0 ? Math.max(0, 1 - (dist - tol) / soft) : 0;
        if (inv) w = 1 - w;
        if (view) { d[i] = d[i + 1] = d[i + 2] = w * 255; continue; }
        if (w <= 0) continue;
        const o = rgb((((c[0] + dh) % 1) + 1) % 1, Math.max(0, Math.min(1, c[1] * (1 + ds))), Math.max(0, Math.min(1, c[2] + dl * (dl > 0 ? 1 - c[2] : c[2]))));
        for (let k = 0; k < 3; k++) d[i + k] = d[i + k] * (1 - w) + o[k] * 255 * w;
      }
    });
  },
  channelMixer: (cv, p) => {
    const k = (s: string, dflt = 0) => num(p[s], dflt) / 100, mono = !!num(p.mono);
    const M = [[k('rr', 100), k('rg'), k('rb'), k('rc')], [k('gr'), k('gg', 100), k('gb'), k('gc')], [k('br'), k('bg'), k('bb', 100), k('bc')]];
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const o = M.map((m) => m[0] * r + m[1] * g + m[2] * b + m[3] * 255);
        // monochrome: the red row for all three channels
        if (mono) { d[i] = d[i + 1] = d[i + 2] = o[0]; } else { d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; }
      }
    });
  },
  shadowHighlight: (cv, p, x) => {
    // local tone mapping: the blurred luminance says how dark / bright the neighbourhood is; shadows are lifted and
    // highlights pulled down there, within the tonal widths; colour correction keeps saturation in the changed areas
    const W = cv.width, H = cv.height, orig = clone(cv);
    const autoA = num(p.auto, 1) !== 0;
    const src = imgData(cv).data;
    // auto amounts: from how much of the image is in the shadows / highlights
    let dark = 0, light = 0;
    for (let i = 0; i < src.length; i += 16) { const L = lum(src[i], src[i + 1], src[i + 2]) / 255; if (L < 0.3) dark++; else if (L > 0.75) light++; }
    const tot = Math.max(1, src.length / 16);
    const sa = (autoA ? Math.min(1, (dark / tot) * 2.5) : num(p.shadowAmount, 50) / 100), ha = (autoA ? Math.min(1, (light / tot) * 1.5) : num(p.highlightAmount) / 100);
    const sw = Math.max(0.05, num(p.shadowWidth, 50) / 100), hw = Math.max(0.05, num(p.highlightWidth, 50) / 100);
    const Ls = mk(W, H); { const g = ctx2d(Ls); g.filter = 'grayscale(1)'; g.drawImage(cv, 0, 0); }
    const bs = imgData(blurCanvas(Ls, (num(p.shadowRadius, 30) * x.res) / 2)).data, bh = imgData(blurCanvas(Ls, (num(p.highlightRadius, 30) * x.res) / 2)).data;
    const cc = num(p.colorCorrection, 20) / 100, mc = num(p.midContrast) / 100;
    pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const ls = bs[i] / 255, lh = bh[i] / 255;
        const ms = Math.max(0, 1 - ls / sw), mh = Math.max(0, (lh - (1 - hw)) / hw);
        const L0 = lum(d[i], d[i + 1], d[i + 2]) / 255;
        let L1 = L0 + sa * ms * ms * (1 - L0) * 0.8 - ha * mh * mh * L0 * 0.6;
        if (mc) L1 = 0.5 + (L1 - 0.5) * (1 + mc * (1 - Math.abs(L1 - 0.5) * 2));
        const f = L0 > 0.001 ? L1 / L0 : 1;
        for (let k = 0; k < 3; k++) { const v = d[i + k] * f, grey = L1 * 255; d[i + k] = grey + (v - grey) * (1 - (1 - cc) * Math.abs(f - 1) * 0.5); }
      }
    });
    return blendWithOriginal(orig, cv, num(p.blend));
  },
  colorama: (cv, p) => {
    const orig = clone(cv);
    const PAL: Record<string, string[]> = { ramp: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'], gray: ['#000000', '#ffffff'], fire: ['#000000', '#7a0000', '#ff3d00', '#ffb300', '#ffffff'], ice: ['#000010', '#0b3d91', '#5fb4ff', '#e8fbff'], golden: ['#2a1600', '#8a5a00', '#ffcc33', '#fff3c2'], sunset: ['#140026', '#6b1d6e', '#e8455a', '#ff9f43', '#ffe08a'], neon: ['#000000', '#ff00aa', '#00e5ff', '#d4ff00', '#000000'] };
    const stops = (PAL[String(p.palette ?? 'ramp')] ?? PAL.ramp).map((c) => parseColor(c));
    const lutC: number[][] = [];
    for (let i = 0; i < 256; i++) { const t = (i / 255) * (stops.length - 1), a = Math.min(stops.length - 2, Math.floor(t)), f = t - a; lutC.push([0, 1, 2].map((c) => (stops[a][c] + (stops[a + 1][c] - stops[a][c]) * f) * 255)); }
    const shift = num(p.phaseShift) / 360, cyc = Math.max(0.1, num(p.cycles, 1)), input = String(p.input ?? 'intensity');
    pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const ph = input === 'intensity' ? lum(d[i], d[i + 1], d[i + 2]) / 255 : chan(d, i, input === 'intensity' ? 'luma' : input);
        const t = (((ph * cyc + shift) % 1) + 1) % 1, c = lutC[Math.min(255, Math.round(t * 255))];
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
      }
    });
    return blendWithOriginal(orig, cv, num(p.blend));
  },
  threeWay: (cv, p) => {
    const bal = (k: string) => parseColor(String(p[k] ?? '#808080')).slice(0, 3).map((v) => (v - 0.5) * 0.6);
    const S = bal('shadowBalance'), M = bal('midBalance'), Hh = bal('highlightBalance');
    const ss = num(p.shadowSat, 100) / 100, ms = num(p.midSat, 100) / 100, hs = num(p.highlightSat, 100) / 100, gs = num(p.masterSat, 100) / 100;
    const ib = num(p.inBlack), iw = Math.max(ib + 1, num(p.inWhite, 255)), gm = Math.max(0.01, num(p.gamma, 1)), ob = num(p.outBlack), ow = num(p.outWhite, 255);
    // tonal ranges (After Effects' Tonal Range Definition, 0…255): shadows below the shadow threshold, highlights
    // above the highlight one, each edge as wide as its softness
    const st = num(p.shadowThreshold, 64) / 255, ss0 = Math.max(0.5, num(p.shadowSoftness, 10)) / 255, ht = num(p.highlightThreshold, 192) / 255, hs0 = Math.max(0.5, num(p.highlightSoftness, 10)) / 255;
    const step = (v: number, t: number, w: number) => { const u = Math.max(0, Math.min(1, (v - t + w) / (2 * w))); return u * u * (3 - 2 * u); };
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        let r = level(d[i], ib, iw, gm, 0, 255) / 255, g = level(d[i + 1], ib, iw, gm, 0, 255) / 255, b = level(d[i + 2], ib, iw, gm, 0, 255) / 255;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b, wS = 1 - step(L, st, ss0), wH = step(L, ht, hs0), wM = Math.max(0, 1 - wS - wH);
        r += S[0] * wS + M[0] * wM + Hh[0] * wH; g += S[1] * wS + M[1] * wM + Hh[1] * wH; b += S[2] * wS + M[2] * wM + Hh[2] * wH;
        const L2 = 0.2126 * r + 0.7152 * g + 0.0722 * b, k = gs * (ss * wS + ms * wM + hs * wH);
        const out = (v: number) => (ob + (ow - ob) * v);
        d[i] = out(L2 + (r - L2) * k); d[i + 1] = out(L2 + (g - L2) * k); d[i + 2] = out(L2 + (b - L2) * k);
      }
    });
  },
  curves: (cv, p) => {
    const T = [p.red, p.green, p.blue].map(curveTable), M = curveTable(p.rgb), A = curveTable(p.alpha);
    // each channel's curve, then the RGB curve on top (Photoshop / After Effects order)
    const L = T.map((t) => Uint8ClampedArray.from({ length: 256 }, (_, v) => M[Math.round(t[v] * 255)] * 255));
    const LA = Uint8ClampedArray.from({ length: 256 }, (_, v) => A[v] * 255);
    return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = L[0][d[i]]; d[i + 1] = L[1][d[i + 1]]; d[i + 2] = L[2][d[i + 2]]; d[i + 3] = LA[d[i + 3]]; } });
  },
  levelsRGB: (cv, p) => {
    const g = (k: string, d: number) => num(p[k], d);
    const [cb, cw] = levelClip(p);
    const ch = (pre: string) => (v: number) => level(v, g(`${pre}InBlack`, 0), g(`${pre}InWhite`, 255), g(`${pre}Gamma`, 1), g(`${pre}OutBlack`, 0), g(`${pre}OutWhite`, 255), cb, cw);
    const master = ch(''), per = ['r', 'g', 'b'].map(ch), alpha = ch('a');
    const L = per.map((f) => Uint8ClampedArray.from({ length: 256 }, (_, v) => master(f(v))));
    const LA = Uint8ClampedArray.from({ length: 256 }, (_, v) => alpha(v));
    return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = L[0][d[i]]; d[i + 1] = L[1][d[i + 1]]; d[i + 2] = L[2][d[i + 2]]; d[i + 3] = LA[d[i + 3]]; } });
  },
  colorBalance: (cv, p) => {
    // weights of shadows / midtones / highlights along the value (GIMP's transfer curves, after Photoshop's)
    const cl = (x: number) => Math.max(0, Math.min(1, x));
    const wS = (v: number) => cl((0.333 - v) / 0.25 + 0.5) * 0.7, wH = (v: number) => cl((v + 0.333 - 1) / 0.25 + 0.5) * 0.7;
    const wM = (v: number) => cl((v - 0.333) / 0.25 + 0.5) * cl((v + 0.333 - 1) / -0.25 + 0.5) * 0.7;
    const k = (s: string) => num(p[s]) / 100;
    const sh = [k('shR'), k('shG'), k('shB')], mi = [k('midR'), k('midG'), k('midB')], hi = [k('hiR'), k('hiG'), k('hiB')];
    const L = [0, 1, 2].map((c) => Uint8ClampedArray.from({ length: 256 }, (_, v) => { const x = v / 255; return 255 * cl(x + sh[c] * wS(x) + mi[c] * wM(x) + hi[c] * wH(x)); }));
    const keep = !!num(p.preserve);
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        let r = L[0][r0], g = L[1][g0], b = L[2][b0];
        if (keep) { const l0 = (Math.max(r0, g0, b0) + Math.min(r0, g0, b0)) / 2, l1 = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 || 1, f = l0 / l1; r *= f; g *= f; b *= f; }
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
    });
  },
  changeToColor: (cv, p) => {
    const hsl = (r: number, g: number, b: number): [number, number, number] => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn;
      if (!dd) return [0, 0, l];
      const s = dd / (1 - Math.abs(2 * l - 1));
      const h = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      return [h / 6, s, l];
    };
    const rgb = (h: number, s: number, l: number): [number, number, number] => {
      const f = (n0: number) => { const k = (n0 + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
      return [f(0), f(8), f(4)];
    };
    const [fr, fg, fb] = parseColor(String(p.from ?? '#f00')), [tr, tg, tb] = parseColor(String(p.to ?? '#00f'));
    const F = hsl(fr, fg, fb), T = hsl(tr, tg, tb), mode = String(p.change ?? 'hue'), setTo = p.changeBy === 'set'; // older projects (no changeBy) kept transforming
    const tol = [num(p.tolHue, 5) / 100 / 2, num(p.tolLight, 50) / 100, num(p.tolSat, 50) / 100], soft = Math.max(0.001, num(p.softness, 50) / 100), view = !!num(p.viewMask);
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const c = hsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        let dh = Math.abs(c[0] - F[0]); dh = Math.min(dh, 1 - dh);
        // how much the pixel is «the from colour»: inside the tolerances 1, fading over the softness
        const fit = (dist: number, t: number) => Math.max(0, Math.min(1, 1 - (dist - t) / (soft * Math.max(t, 0.02) + 1e-6)));
        const w = fit(dh, tol[0]) * fit(Math.abs(c[2] - F[2]), tol[1]) * fit(Math.abs(c[1] - F[1]), tol[2]);
        if (view) { d[i] = d[i + 1] = d[i + 2] = w * 255; continue; }
        if (w <= 0) continue;
        // Setting To Color: the matched pixels take the target's components; Transforming: they move by To − From
        const nh = setTo ? T[0] : c[0] + ((T[0] - F[0] + 1.5) % 1) - 0.5;
        const nl = mode.includes('Light') ? (setTo ? T[2] : c[2] + (T[2] - F[2])) : c[2];
        const ns = mode.includes('Sat') ? (setTo ? T[1] : c[1] + (T[1] - F[1])) : c[1];
        const o = rgb(((nh % 1) + 1) % 1, Math.max(0, Math.min(1, ns)), Math.max(0, Math.min(1, nl)));
        for (let k = 0; k < 3; k++) d[i + k] = d[i + k] * (1 - w) + o[k] * 255 * w;
      }
    });
  },
  applyLut: (cv, p) => {
    const key = String(p.lut ?? '');
    if (!key) return cv;
    if (!lutCache.has(key)) lutCache.set(key, parseCube(key));
    const L = lutCache.get(key);
    if (!L) return cv;
    const n = L.n, D = L.data, amt = num(p.amount, 100) / 100;
    const at = (r: number, g: number, b: number, c: number) => D[((b * n + g) * n + r) * 3 + c];
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        // trilinear in the 3D table
        const fr = (d[i] / 255) * (n - 1), fg = (d[i + 1] / 255) * (n - 1), fb = (d[i + 2] / 255) * (n - 1);
        const r0 = Math.min(n - 2, Math.floor(fr)), g0 = Math.min(n - 2, Math.floor(fg)), b0 = Math.min(n - 2, Math.floor(fb));
        const ur = fr - r0, ug = fg - g0, ub = fb - b0;
        for (let c = 0; c < 3; c++) {
          const c00 = at(r0, g0, b0, c) * (1 - ur) + at(r0 + 1, g0, b0, c) * ur, c10 = at(r0, g0 + 1, b0, c) * (1 - ur) + at(r0 + 1, g0 + 1, b0, c) * ur;
          const c01 = at(r0, g0, b0 + 1, c) * (1 - ur) + at(r0 + 1, g0, b0 + 1, c) * ur, c11 = at(r0, g0 + 1, b0 + 1, c) * (1 - ur) + at(r0 + 1, g0 + 1, b0 + 1, c) * ur;
          const v = (c00 * (1 - ug) + c10 * ug) * (1 - ub) + (c01 * (1 - ug) + c11 * ug) * ub;
          d[i + c] = d[i + c] * (1 - amt) + v * 255 * amt;
        }
      }
    });
  },
  // Exposure: v·2^exposure + offset, then gamma correction (1/γ), in linear light unless bypassed
  exposure: (cv, p) => {
    const ind = p.channels === 'individual', byp = !!num(p.bypass);
    const k = (c: number, s: string, d: number) => num(ind ? p[`${'rgb'[c]}${s[0].toUpperCase()}${s.slice(1)}`] : p[s], d);
    // linear light by a 2.2 power, as Exposure does; powers keep the sign of negative values
    const sp = (v: number, e: number) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e)), G = byp ? 1 : 2.2;
    return lut(cv, (v, c) => { const e = Math.pow(2, k(c, 'exposure', 0)), o = k(c, 'offset', 0), g = Math.max(0.01, k(c, 'gamma', 1)); return 255 * sp(sp(sp(v / 255, G) * e + o, 1 / g), 1 / G); });
  },
  tint: (cv, p) => {
    const b = parseColor(String(p.black)), w = parseColor(String(p.white)), a = num(p.amount, 100) / 100;
    return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { const L = lum(d[i], d[i + 1], d[i + 2]) / 255; for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * (1 - a) + (b[c] + (w[c] - b[c]) * L) * 255 * a; } });
  },
  tritone: (cv, p) => {
    const hi = parseColor(String(p.high)), mi = parseColor(String(p.mid)), lo = parseColor(String(p.low)), bl = num(p.blend) / 100;
    return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { const L = lum(d[i], d[i + 1], d[i + 2]) / 255; for (let c = 0; c < 3; c++) { const v = L < 0.5 ? lo[c] + (mi[c] - lo[c]) * L * 2 : mi[c] + (hi[c] - mi[c]) * (L - 0.5) * 2; d[i + c] = v * 255 * (1 - bl) + d[i + c] * bl; } } });
  },
  // photoFilter: fx-groups/color.ts
  fill: (cv, p, x) => {
    // the region: chosen masks (filled as outlines, any mode) or else the layer's own alpha; feathered, inverted
    const ms = pickMasks(x, String(p.mask ?? ''), !!num(p.allMasks));
    const region = mk(cv.width, cv.height), rg = ctx2d(region);
    if (ms.length) { rg.fillStyle = '#fff'; for (const m of ms) { rg.fill(polyPath(m, x)); } }
    else rg.drawImage(cv, 0, 0);
    const hf = num(p.hFeather) * x.res, vf = num(p.vFeather) * x.res;
    let reg = region;
    if (hf > 0.3 || vf > 0.3) { reg = blurCanvas(region, Math.max(hf, vf) / 2, hf > vf * 2 ? 'h' : vf > hf * 2 ? 'v' : 'both'); }
    const col = mk(cv.width, cv.height), cg = ctx2d(col);
    cg.fillStyle = rgba(p.color); cg.fillRect(0, 0, col.width, col.height);
    cg.globalCompositeOperation = num(p.invert) ? 'destination-out' : 'destination-in'; cg.drawImage(reg, 0, 0);
    const out = clone(cv), g = ctx2d(out);
    // with masks the colour covers the masked area; on the alpha it recolours the layer
    g.globalCompositeOperation = ms.length ? 'source-over' : 'source-atop';
    g.globalAlpha = num(p.opacity, 100) / 100; g.drawImage(col, 0, 0);
    return out;
  },
  // Shatter: the layer in pieces of a pattern; those inside the force sphere fly out (strength, gravity, viscosity,
  // mass variance, tumbling) and are seen in perspective; Render: all, the unbroken layer, or only the pieces
  shatter: (cv, p, x) => {
    const W = cv.width, H = cv.height, seed = num(p.seed, 1) * 9973 + 1, t = Math.max(0, x.t);
    const [ox0, oy0] = pt(p.origin, x);
    const pieces = shatterPieces(W, H, String(p.pattern ?? 'bricks'), num(p.repetitions, 10), rad(num(p.direction)), ox0, oy0, seed);
    // Force 1 and Force 2 (After Effects: a radius of 0 turns a force off); projects without «force2» have one force
    const forces = [{ c: pt(p.force, x), d: num(p.forceDepth, 0.1), R: num(p.radius, 0.4) * W, k: num(p.strength, 5) }];
    if (p.force2 !== undefined) forces.push({ c: pt(p.force2, x), d: num(p.force2Depth, 0.1), R: num(p.force2Radius) * W, k: num(p.force2Strength, 5) });
    const visc = num(p.viscosity, 0.1), grav = num(p.gravity, 3) * W * 0.05, incl = Math.cos(rad(num(p.gravityInclination)));
    const ga = rad(num(p.gravityDirection, 180) - 180), mode = String(p.render ?? 'all'), focal = W * 1.5, tumble = String(p.tumble ?? 'free');
    const view = String(p.view ?? 'rendered'), wire = view !== 'rendered', front = view.startsWith('wireFront');
    const out = mk(W, H), g = ctx2d(out);
    const flying: { pts: number[]; cx: number; cy: number; z: number; rx: number; ry: number; rz: number; tx: number; ty: number }[] = [];
    pieces.forEach((pts, i) => {
      let cx = 0, cy = 0; for (let k = 0; k < pts.length; k += 2) { cx += pts[k]; cy += pts[k + 1]; } cx /= pts.length / 2; cy /= pts.length / 2;
      if (cx < -W * 0.1 || cy < -H * 0.1 || cx > W * 1.1 || cy > H * 1.1) return;
      // every force that reaches the piece pushes it away from its centre (and towards the camera)
      let vx = 0, vy = 0, vz = 0, kk = 0;
      const mass = 1 + (num(p.massVariance, 30) / 100) * (rnd(seed, i * 7) * 2 - 1), rand = num(p.randomness, 0.1);
      for (const f of forces) {
        const d = Math.hypot(cx - f.c[0], cy - f.c[1]);
        if (!(d < f.R) || t <= 0) continue;
        const k = (1 - d / f.R) * f.k / mass, jx = (rnd(seed, i * 7 + 1) * 2 - 1) * rand, jy = (rnd(seed, i * 7 + 2) * 2 - 1) * rand;
        vx += ((cx - f.c[0]) / (d || 1) + jx) * k * W * 0.1; vy += ((cy - f.c[1]) / (d || 1) + jy) * k * W * 0.1; vz += -(f.d + 0.2) * k * W * 0.1; kk += k;
      }
      if (!kk) { if (mode !== 'pieces') flying.push({ pts, cx, cy, z: 0, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0 }); return; }
      if (mode === 'layer') return;
      // viscosity damps exponentially; gravity pulls along its direction, less as it leans towards the camera
      const damp = visc > 0 ? (1 - Math.exp(-visc * 4 * t)) / (visc * 4) : t;
      const tx = vx * damp + Math.sin(ga) * grav * incl * t * t * 0.5, ty = vy * damp + Math.cos(ga) * grav * incl * t * t * 0.5, z = vz * damp;
      const spin = num(p.rotationSpeed, 0.2) * 2 * Math.PI * t * kk * 0.3;
      const on = (a: string) => tumble === 'free' || tumble.includes(a);
      const ax = on('x') ? spin * (rnd(seed, i * 7 + 3) * 2 - 1) : 0, ay = on('y') ? spin * (rnd(seed, i * 7 + 4) * 2 - 1) : 0, az = on('z') ? spin * (rnd(seed, i * 7 + 5) * 2 - 1) : 0;
      flying.push({ pts, cx, cy, z, rx: ax, ry: ay, rz: az, tx, ty });
    });
    // After Effects' Camera System, Lighting and Material (projects from before them keep the simple perspective)
    if (p.cameraSystem !== undefined) {
      const cam: APCam = front ? { proj: (P) => [P[0], P[1], P[2] + 2 * W], eye: [W / 2, H / 2, -2 * W] } : apCamera(p, x, W, H, 'camFocal');
      const faces: APFace[] = [];
      for (const f of flying) {
        const R = rotOrder('xyz', f.rx, f.ry, f.rz), P0 = [f.cx + f.tx, f.cy + f.ty, f.z], c0 = cam.proj(P0), scr: number[] = [];
        if (!c0) continue;
        let ok = true;
        for (let k = 0; k < f.pts.length && ok; k += 2) { const w = mv3(R, [f.pts[k] - f.cx, f.pts[k + 1] - f.cy, 0]), s = cam.proj([w[0] + P0[0], w[1] + P0[1], w[2] + P0[2]]); if (s) scr.push(s[0], s[1]); else ok = false; }
        if (ok) faces.push({ src: cv, sp: f.pts, scr, depth: c0[2], P: P0, N: mv3(R, [0, 0, -1]) });
      }
      const res = apDraw(W, H, faces, p, x, cam, wire), rg = ctx2d(res);
      if (view.endsWith('Forces')) { rg.strokeStyle = '#ff4040'; rg.lineWidth = 1; for (const f of forces) if (f.R > 0) { rg.beginPath(); rg.arc(f.c[0], f.c[1], f.R, 0, Math.PI * 2); rg.stroke(); } }
      return res;
    }
    // far pieces first; perspective from the layer centre (the front views look straight on, without it)
    flying.sort((a, b) => b.z - a.z);
    if (wire) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = '#ffffff'; }
    for (const f of flying) {
      const sc = front ? 1 : focal / Math.max(1, focal + f.z), px = W / 2 + (f.cx + f.tx - W / 2) * sc, py = H / 2 + (f.cy + f.ty - H / 2) * sc;
      g.save();
      g.translate(px, py); g.rotate(f.rz); g.scale(sc * Math.cos(f.ry), sc * Math.cos(f.rx)); g.translate(-f.cx, -f.cy);
      const path = new Path2D(); for (let k = 0; k < f.pts.length; k += 2) { if (k) path.lineTo(f.pts[k], f.pts[k + 1]); else path.moveTo(f.pts[k], f.pts[k + 1]); } path.closePath();
      if (wire) { g.lineWidth = 1 / Math.max(0.05, sc); g.stroke(path); } else { g.clip(path); g.drawImage(cv, 0, 0); }
      g.restore();
    }
    // the forces as circles (After Effects draws them as spheres in the «+ Forces» views)
    if (view.endsWith('Forces')) { g.strokeStyle = '#ff4040'; g.lineWidth = 1; for (const f of forces) if (f.R > 0) { g.beginPath(); g.arc(f.c[0], f.c[1], f.R, 0, Math.PI * 2); g.stroke(); } }
    return out;
  },
  // Card Dance: the layer cut into cards; each card's position, rotation and scale = source × multiplier + offset,
  // the source being the brightness of a gradient layer under the card's centre
  cardDance: (cv, p, x) => {
    // projects from before After Effects' «Rows & Columns» popup: «columnsFollow» and rotations in half turns
    const legacy = p.rowsColumns === undefined, follow = legacy ? !!num(p.columnsFollow, 1) : String(p.rowsColumns) === 'follow';
    const W = cv.width, H = cv.height, rows = Math.max(1, Math.round(num(p.rows, 9))), cols = follow ? rows : Math.max(1, Math.round(num(p.columns, 12)));
    const out = mk(W, H), g = ctx2d(out), cw = W / cols, ch = H / rows;
    const grad = (k: string) => { const L = p[k] && x.layer ? x.layer(String(p[k])) : null; if (!L) return null; const d = ctx2d(L.cv).getImageData(0, 0, L.cv.width, L.cv.height); return { d, L }; };
    const g1 = grad('gradient1'), g2 = grad('gradient2');
    // a gradient layer's channel under a point (0…1); «slopes» are its change across one card, horizontal or vertical
    const chan = (gr: NonNullable<ReturnType<typeof grad>>, cx: number, cy: number, c: string) => {
      const X = Math.floor(((cx / x.res + x.ox) - gr.L.ox) * gr.L.res), Y = Math.floor(((cy / x.res + x.oy) - gr.L.oy) * gr.L.res);
      if (X < 0 || Y < 0 || X >= gr.d.width || Y >= gr.d.height) return 0;
      const d = gr.d.data, i = (Y * gr.d.width + X) * 4;
      return (c === 'red' ? d[i] : c === 'green' ? d[i + 1] : c === 'blue' ? d[i + 2] : c === 'alpha' ? d[i + 3] : d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    };
    const sample = (s: string, cx: number, cy: number) => {
      const m = /^(int|red|green|blue|alpha|intH|intV|redH|redV)([12])$/.exec(s), gr = m ? (m[2] === '1' ? g1 : g2) : null;
      if (!m || !gr) return 0;
      const kind = m[1], c = kind.startsWith('red') ? 'red' : kind.startsWith('int') ? 'int' : kind;
      if (kind.endsWith('H')) return chan(gr, cx + cw / 2, cy, c) - chan(gr, cx - cw / 2, cy, c);
      if (kind.endsWith('V')) return chan(gr, cx, cy + ch / 2, c) - chan(gr, cx, cy - ch / 2, c);
      return chan(gr, cx, cy, c);
    };
    const val = (k: string, cx: number, cy: number) => sample(String(p[`${k}Src`] ?? 'none'), cx, cy) * num(p[`${k}Mul`], legacy ? 0 : k.includes('Rot') ? 90 : 1) + num(p[`${k}Off`], k.endsWith('Scale') ? 1 : 0);
    const rotK = legacy ? 180 : 1;
    const back = p.back && x.layer ? x.layer(String(p.back)) : null;
    // After Effects' Rotation Order, Transformation Order, Camera System, Lighting and Material (projects from before
    // them keep the simple perspective below)
    if (p.cameraSystem !== undefined) {
      const cam = apCamera(p, x, W, H, 'focal'), rOrd = String(p.rotationOrder ?? 'xyz'), tOrd = String(p.transformOrder ?? 'srp');
      // the back layer, mirrored like the back of a real card; without one a turned card shows nothing
      const bk = back, bx = (X: number) => (bk ? (X / x.res + x.ox - bk.ox) * bk.res : 0), by = (Y: number) => (bk ? (Y / x.res + x.oy - bk.oy) * bk.res : 0);
      const sub = rows * cols > 48 ? 1 : rows * cols > 12 ? 2 : 4, faces: APFace[] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cw, cy = (r + 0.5) * ch, T = [val('xPos', cx, cy) * cw, val('yPos', cx, cy) * ch, val('zPos', cx, cy) * cw];
        const R = rotOrder(rOrd, rad(val('xRot', cx, cy)), rad(val('yRot', cx, cy)), rad(val('zRot', cx, cy))), sx = val('xScale', cx, cy), sy = val('yScale', cx, cy);
        const xf = (u: number, v: number): number[] => {
          let q = [u, v, 0];
          for (const op of tOrd) q = op === 's' ? [q[0] * sx, q[1] * sy, q[2]] : op === 'r' ? mv3(R, q) : [q[0] + T[0], q[1] + T[1], q[2] + T[2]];
          return [cx + q[0], cy + q[1], q[2]];
        };
        const P0 = xf(0, 0), c0 = cam.proj(P0);
        if (!c0 || !sx || !sy) continue;
        let N = mv3(R, [0, 0, -1]); if (sx * sy < 0) N = [-N[0], -N[1], -N[2]];
        const front = N[0] * (cam.eye[0] - P0[0]) + N[1] * (cam.eye[1] - P0[1]) + N[2] * (cam.eye[2] - P0[2]) >= 0;
        if (!front && !bk) continue;
        for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
          const us = [-cw / 2 + (cw * j) / sub, -cw / 2 + (cw * (j + 1)) / sub], vs = [-ch / 2 + (ch * i) / sub, -ch / 2 + (ch * (i + 1)) / sub];
          const corners = [[us[0], vs[0]], [us[1], vs[0]], [us[1], vs[1]], [us[0], vs[1]]], scr: number[] = [], spt: number[] = [];
          let ok = true;
          for (const [u, v] of corners) { const s = cam.proj(xf(u, v)); if (!s) { ok = false; break; } scr.push(s[0], s[1]); spt.push(...(front ? [cx + u, cy + v] : [bx(cx - u), by(cy + v)])); }
          if (ok) faces.push({ src: front || !bk ? cv : bk.cv, sp: spt, scr, depth: c0[2], P: P0, N });
        }
      }
      return apDraw(W, H, faces, p, x, cam, false);
    }
    const focal = num(p.focal, 70) / 50 * W;
    const list: { cx: number; cy: number; z: number; draw: () => void }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cw, cy = (r + 0.5) * ch;
      const px = cx + val('xPos', cx, cy) * cw, py = cy + val('yPos', cx, cy) * ch, z = val('zPos', cx, cy) * cw;
      const rx = rad(val('xRot', cx, cy) * rotK), ry = rad(val('yRot', cx, cy) * rotK), rz = rad(val('zRot', cx, cy) * rotK);
      const sx = val('xScale', cx, cy), sy = val('yScale', cx, cy), persp = focal / Math.max(1, focal + z);
      const fx = Math.cos(ry) * sx * persp, fy = Math.cos(rx) * sy * persp, facing = fx * fy >= 0;
      list.push({ cx, cy, z, draw: () => {
        g.save();
        g.translate(W / 2 + (px - W / 2) * persp, H / 2 + (py - H / 2) * persp); g.rotate(rz); g.scale(fx, fy);
        // the back of a turned card shows the back layer (mirrored like a real card), or nothing
        if (facing) g.drawImage(cv, cx - cw / 2, cy - ch / 2, cw, ch, -cw / 2, -ch / 2, cw, ch);
        else if (back) g.drawImage(back.cv, ((cx - cw / 2) / x.res + x.ox - back.ox) * back.res, ((cy - ch / 2) / x.res + x.oy - back.oy) * back.res, cw / x.res * back.res, ch / x.res * back.res, -cw / 2, -ch / 2, cw, ch);
        g.restore();
      } });
    }
    list.sort((a, b) => b.z - a.z).forEach((c) => c.draw());
    return out;
  },
  // Caustics: a water surface (heights = brightness of a layer, smoothed) refracts the bottom; light gathers
  // where the surface focuses it (caustics) and is lit by a light (ambient, diffuse, specular), tinted by its colour
  caustics: (cv, p, x) => {
    const W = cv.width, H = cv.height;
    const bot = p.bottom && x.layer ? x.layer(String(p.bottom)) : null, wat = p.water && x.layer ? x.layer(String(p.water)) : null;
    const bottomCv = mk(W, H), bg = ctx2d(bottomCv);
    if (bot) bg.drawImage(bot.cv, (bot.ox - x.ox) * x.res, (bot.oy - x.oy) * x.res, bot.cv.width / bot.res * x.res, bot.cv.height / bot.res * x.res); else bg.drawImage(cv, 0, 0);
    // After Effects' Blur (0–10); projects from before it used «bottomBlur» (0–100)
    const bsig = p.blur === undefined ? num(p.bottomBlur) * x.res / 4 : num(p.blur) * 20 * x.res;
    const blurred = bsig > 0 ? blurCanvas(bottomCv, bsig) : bottomCv;
    const bd = ctx2d(blurred).getImageData(0, 0, W, H).data;
    // heights: the water layer's brightness, smoothed
    const hc = mk(W, H), hg = ctx2d(hc);
    if (wat) hg.drawImage(wat.cv, (wat.ox - x.ox) * x.res, (wat.oy - x.oy) * x.res, wat.cv.width / wat.res * x.res, wat.cv.height / wat.res * x.res);
    // heights as floats, smoothed with a box blur (three passes ≈ gaussian): 8-bit steps would show as speckles
    const hd = ctx2d(hc).getImageData(0, 0, W, H).data, h = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) h[i] = ((hd[i * 4] * 0.299 + hd[i * 4 + 1] * 0.587 + hd[i * 4 + 2] * 0.114) / 255 - 0.5) * num(p.waveHeight, 0.2);
    const rad0 = Math.round(num(p.smoothing, 5) * x.res);
    if (rad0 > 0) {
      const tmp = new Float32Array(W * H);
      for (let pass = 0; pass < 3; pass++) {
        for (let y = 0; y < H; y++) { let acc = 0; for (let X = -rad0; X <= rad0; X++) acc += h[y * W + Math.max(0, Math.min(W - 1, X))]; for (let X = 0; X < W; X++) { tmp[y * W + X] = acc / (2 * rad0 + 1); acc += h[y * W + Math.min(W - 1, X + rad0 + 1)] - h[y * W + Math.max(0, X - rad0)]; } }
        for (let X = 0; X < W; X++) { let acc = 0; for (let y = -rad0; y <= rad0; y++) acc += tmp[Math.max(0, Math.min(H - 1, y)) * W + X]; for (let y = 0; y < H; y++) { h[y * W + X] = acc / (2 * rad0 + 1); acc += tmp[Math.min(H - 1, y + rad0 + 1) * W + X] - tmp[Math.max(0, y - rad0) * W + X]; } }
      }
    }
    const depth = num(p.waterDepth, 0.1) * W, ior = num(p.refraction, 1.2), shift = depth * (1 - 1 / ior);
    const [lx, ly] = pt(p.lightPosition, x), lc = parseColor(String(p.lightColor ?? '#ffffff')), sc = parseColor(String(p.surfaceColor ?? '#ffffff'));
    const so = num(p.surfaceOpacity, 0.3), cs = num(p.causticsStrength), li = num(p.lightIntensity, 1);
    const amb = num(p.ambient, 0.35), dif = num(p.diffuse, 0.6), spec = num(p.specular, 0.2), sharp = Math.max(1, p.highlightSharpness === undefined ? 1 / Math.max(0.01, num(p.sharpness, 0.09)) : num(p.highlightSharpness, 10));
    // a distant light shines from the position's direction (seen from the centre) everywhere; a point light from the point
    const distant = String(p.lightType ?? 'point') === 'distant', lz = W * 0.5 * num(p.lightHeight, 1);
    const out = new ImageData(W, H), o = out.data;
    const at = (X: number, Y: number) => h[Math.max(0, Math.min(H - 1, Y)) * W + Math.max(0, Math.min(W - 1, X))];
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const gx = (at(X + 1, y) - at(X - 1, y)) * W * 0.5, gy = (at(X, y + 1) - at(X, y - 1)) * W * 0.5;
      const sx = Math.round(X + gx * shift * 0.1), sy = Math.round(y + gy * shift * 0.1);
      const si = (Math.max(0, Math.min(H - 1, sy)) * W + Math.max(0, Math.min(W - 1, sx))) * 4, i = (y * W + X) * 4;
      // the surface normal lights it; the curvature (laplacian) focuses the light: bright caustic lines
      const nx = -gx, ny = -gy, nz = 1, nl = Math.hypot(nx, ny, nz);
      const ldx = distant ? lx - W / 2 : lx - X, ldy = distant ? ly - H / 2 : ly - y, ldz = lz, ll = Math.hypot(ldx, ldy, ldz);
      const ndl = Math.max(0, (nx * ldx + ny * ldy + nz * ldz) / (nl * ll)), hl = Math.pow(Math.max(0, (nz / nl + ldz / ll) / 2), sharp);
      const lap = (at(X + 1, y) + at(X - 1, y) + at(X, y + 1) + at(X, y - 1) - 4 * at(X, y)) * W;
      const focus = 1 + cs * Math.max(-0.8, -lap * 20);
      const light = li * (amb + dif * ndl) * focus;
      for (let c = 0; c < 3; c++) {
        const base = bd[si + c] * light * lc[c];
        o[i + c] = base * (1 - so) + sc[c] * 255 * so * (amb + dif * ndl) + spec * hl * 255 * lc[c];
      }
      o[i + 3] = Math.max(bd[si + 3], so * 255);
    }
    const r = mk(W, H); ctx2d(r).putImageData(out, 0, 0); return r;
  },
  // Wave World: the wave equation on a grid (wave speed, damping, edge reflection) driven by ring or line
  // producers; shown as a height map (grey = rest) for Caustics or Displacement Map, or as a wireframe
  waveWorld: (cv, p, x) => {
    // projects from before After Effects' wireframe controls (no «hRotation»): brightness around 0.5, flat wireframe
    const legacy = p.hRotation === undefined;
    const W = cv.width, H = cv.height, gw = Math.max(8, Math.round(num(p.gridResolution, 40))), gh = Math.max(4, Math.round((gw * H) / Math.max(1, W)));
    const dt = 1 / 60, c2 = Math.min(0.45, num(p.waveSpeed, 0.3) ** 2), damp = num(p.damping, 0.05);
    const t = Math.max(0, x.t + num(p.preroll)), steps = Math.round(t / dt);
    const key = JSON.stringify([gw, gh, p, x.ox, x.oy, x.res]).replace(/"t":[^,]*,/, '');
    let st = waveCache.get(key);
    if (!st || st.t > steps) st = { t: 0, h: new Float32Array(gw * gh), v: new Float32Array(gw * gh) };
    const prods = [1, 2].map((k) => ({ type: String(p[`p${k}Type`] ?? 'ring'), pos: pt(p[`p${k}Position`], x), hgt: num(p[`p${k}Height`], 0.1), wid: num(p[`p${k}Width`], 0.1), amp: num(p[`p${k}Amplitude`], k === 1 ? 0.5 : 0), freq: num(p[`p${k}Frequency`], 1), phase: rad(num(p[`p${k}Phase`])), ang: rad(num(p[`p${k}Angle`])) })).filter((q) => q.amp);
    // Reflect Edges: «all» or any mix of left / top / right / bottom (After Effects' 16 choices)
    const rf = String(p.reflect ?? 'none'), rAll = rf === 'all', rL = rAll || /left/i.test(rf), rT = rAll || /top/i.test(rf), rR = rAll || /right/i.test(rf), rB = rAll || /bottom/i.test(rf);
    for (let s = st.t; s < steps; s++) {
      const time = s * dt, h = st.h, v = st.v;
      for (const q of prods) {
        const px = (q.pos[0] / W) * gw, py = (q.pos[1] / H) * gh, r = Math.max(1, q.wid * gw), val = Math.sin(time * q.freq * 2 * Math.PI + q.phase) * q.amp;
        for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
          // a line producer turns with its angle: «across» is the distance to the line, «along» its length
          const ca = Math.cos(q.ang), sa = Math.sin(q.ang), along = (i - px) * ca + (j - py) * sa, across = -(i - px) * sa + (j - py) * ca;
          const d = q.type === 'line' ? Math.abs(across) : Math.hypot(i - px, j - py);
          if (d < r && (q.type !== 'line' || Math.abs(along) < q.hgt * gw)) h[j * gw + i] = val;
        }
      }
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const k = j * gw + i, at = (ii: number, jj: number) => (ii < 0 ? (rL ? h[k] : 0) : ii >= gw ? (rR ? h[k] : 0) : jj < 0 ? (rT ? h[k] : 0) : jj >= gh ? (rB ? h[k] : 0) : h[jj * gw + ii]);
        v[k] = (v[k] + c2 * (at(i + 1, j) + at(i - 1, j) + at(i, j + 1) + at(i, j - 1) - 4 * h[k])) * (1 - damp * 0.05);
      }
      // edges that do not reflect absorb the waves (a damping band a few cells wide)
      if (!rAll) for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const e = Math.min(rL ? 9 : i, rT ? 9 : j, rR ? 9 : gw - 1 - i, rB ? 9 : gh - 1 - j); if (e < 4) v[j * gw + i] *= 0.6 + e * 0.1; }
      for (let k = 0; k < h.length; k++) h[k] += v[k];
    }
    st.t = steps; waveCache.set(key, st);
    if (waveCache.size > 8) waveCache.delete(waveCache.keys().next().value!);
    const out = mk(W, H), g = ctx2d(out);
    const bright = num(p.brightness), con = num(p.contrast, 0.5), gam = num(p.gamma, 1);
    if (String(p.view ?? 'height') === 'wireframe' && !legacy) {
      // the grid in 3D: turned by Horizontal Rotation, tilted by Vertical Rotation, heights × Vertical Scale
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = '#7fd4ff'; g.lineWidth = 1;
      const hr = rad(num(p.hRotation, 12)), vr = rad(num(p.vRotation, 20)), vs = num(p.vScale, 0.5), sc = 0.75;
      const P3 = (i: number, j: number) => {
        const X = (i / (gw - 1) - 0.5) * W, Z = (j / (gh - 1) - 0.5) * H, Y = -st.h[j * gw + i] * vs * H * 0.5;
        const x1 = X * Math.cos(hr) - Z * Math.sin(hr), z1 = X * Math.sin(hr) + Z * Math.cos(hr);
        return [W / 2 + x1 * sc, H / 2 + (Y * Math.cos(vr) + z1 * Math.sin(vr)) * sc] as const;
      };
      const stp = Math.max(1, Math.round(gw / 40));
      for (let j = 0; j < gh; j += stp) { g.beginPath(); for (let i = 0; i < gw; i++) { const [X, Y] = P3(i, j); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); } g.stroke(); }
      for (let i = 0; i < gw; i += stp) { g.beginPath(); for (let j = 0; j < gh; j++) { const [X, Y] = P3(i, j); if (j) g.lineTo(X, Y); else g.moveTo(X, Y); } g.stroke(); }
      return out;
    }
    if (String(p.view ?? 'height') === 'wireframe') {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.strokeStyle = '#7fd4ff'; g.lineWidth = 1;
      for (let j = 0; j < gh; j += 2) { g.beginPath(); for (let i = 0; i < gw; i++) { const X = (i / (gw - 1)) * W, Y = (j / (gh - 1)) * H * 0.6 + H * 0.3 - st.h[j * gw + i] * H * 0.2; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); } g.stroke(); }
      return out;
    }
    const small = new ImageData(gw, gh);
    for (let k = 0; k < gw * gh; k++) { const vv = Math.pow(Math.max(0, Math.min(1, (legacy ? 0.5 : 0) + st.h[k] * con + bright)), 1 / gam) * 255; small.data[k * 4] = small.data[k * 4 + 1] = small.data[k * 4 + 2] = vv; small.data[k * 4 + 3] = 255; }
    const sc = mk(gw, gh); ctx2d(sc).putImageData(small, 0, 0);
    g.imageSmoothingQuality = 'high'; g.drawImage(sc, 0, 0, W, H);
    return out;
  },
  // Foam: bubbles born at the producer at a rate, carried by speed, wind and turbulence, wobbling and growing,
  // gone after their lifespan
  foam: (cv, p, x) => {
    const W = cv.width, H = cv.height, out = clone(cv), g = ctx2d(out), fps = x.fps || 25, frame = x.t * fps;
    const rate = num(p.rate, 1), life = num(p.lifespan, 300), seed = num(p.seed, 1) * 7919 + 3;
    if (rate <= 0) return out;
    const [px, py] = pt(p.producer, x), sxp = num(p.producerX, 0.025) * W, syp = num(p.producerY, 0.025) * H;
    const ws = num(p.windSpeed, 0.5) * W * 0.004, wd = rad(num(p.windDirection, 90) - 90), is = num(p.initialSpeed) * W * 0.004, id = rad(num(p.initialDirection) - 90);
    const turb = num(p.turbulence, 0.5), wob = num(p.wobble, 0.05), grow = num(p.growth, 0.1), base = num(p.size, 0.5) * W * 0.04, sv = num(p.sizeVariance, 0.5);
    // each of After Effects' bubble textures as a colour (the old four keep their look); Draft shows outlines
    const tex = String(p.texture ?? 'default'), TEX: Record<string, string> = { amber: '#e0a040', spit: '#f2f2e6', coffee: '#7a4a26', winter: '#d8ecff', orangeSoda: '#ff9a30', nuclear: '#9cff4a', redTide: '#d23a3a', sunset: '#ffa070', pepto: '#ffa8d0', algae: '#5f9f3f', blisters: '#f2d4bc', bubbleWrap: '#f4faff', grape: '#8a4ad2' };
    const tint = parseColor(String(p.tint ?? '#ffffff')).map((v, k) => v * (TEX[tex] ? parseColor(TEX[tex])[k] : 1)), draft = String(p.view ?? 'rendered').startsWith('draft');
    const pa = rad(num(p.producerAngle));
    const first = Math.max(0, Math.floor((frame - life) * rate)), last = Math.floor(frame * rate);
    for (let i = first; i <= last && i - first < 4000; i++) {
      const born = i / rate, age = frame - born;
      if (age < 0 || age > life) continue;
      const a = rnd(seed, i * 5) * Math.PI * 2, r = Math.sqrt(rnd(seed, i * 5 + 1));
      const ex = Math.cos(a) * r * sxp, ey = Math.sin(a) * r * syp;
      let bx = px + ex * Math.cos(pa) - ey * Math.sin(pa), by = py + ex * Math.sin(pa) + ey * Math.cos(pa);
      bx += (Math.cos(id) * is + Math.cos(wd) * ws) * age + fbm(born * 0.1 + age * 0.02, seed + i, 2) * turb * W * 0.05;
      by += (Math.sin(id) * is + Math.sin(wd) * ws) * age + fbm(born * 0.1 + age * 0.02 + 50, seed + i, 2) * turb * W * 0.05;
      const size = base * (1 + sv * (rnd(seed, i * 5 + 2) * 2 - 1)) * Math.min(1, grow > 0 ? age * grow * 0.5 : 1) * x.res;
      if (size < 0.5) continue;
      const wx = 1 + Math.sin(age * 0.3 + i) * wob, wy = 1 - Math.sin(age * 0.3 + i) * wob;
      const fade = Math.min(1, (life - age) / 10);
      g.save(); g.translate(bx, by); g.scale(wx, wy); g.globalAlpha = fade;
      if (draft) { g.strokeStyle = '#3c78ff'; g.lineWidth = 1 / Math.max(wx, wy); g.beginPath(); g.arc(0, 0, size, 0, Math.PI * 2); g.stroke(); g.restore(); continue; }
      // a bubble: thin rim, faint body and a highlight
      const col = (k: number, al: number) => `rgba(${Math.round(tint[0] * k)},${Math.round(tint[1] * k)},${Math.round(tint[2] * k)},${al})`;
      const gr = g.createRadialGradient(-size * 0.3, -size * 0.3, size * 0.05, 0, 0, size);
      const body = tex === 'magma' || tex === 'coffee' || tex === 'pepto' || tex === 'nuclear' ? 0.85 : tex === 'beads' || tex === 'amber' || tex === 'grape' || tex === 'orangeSoda' || tex === 'redTide' || tex === 'algae' ? 0.35 : 0.12;
      gr.addColorStop(0, col(255, 0.9)); gr.addColorStop(0.25, col(230, body)); gr.addColorStop(0.85, col(200, body)); gr.addColorStop(1, col(255, 0.8));
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, size, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    return out;
  },
  // CC Particle World: particles born in a volume around the producer, launched by the animation type, pulled by
  // gravity and slowed by resistance, coloured and sized from birth to death, seen through its own camera
  particleWorld: (cv, p, x) => {
    const W = cv.width, H = cv.height, out = clone(cv), g = ctx2d(out);
    const rate = num(p.birthRate, 1) * 60, life = Math.max(0.01, num(p.longevity, 1)), seed = num(p.seed, 1) * 104729 + 7, t = Math.max(0, x.t);
    if (rate <= 0) return out;
    const vel = num(p.velocity, 1), grav = num(p.gravity, 0.5), res = num(p.resistance) / 100, anim = String(p.animation ?? 'explosive'), extra = num(p.extra);
    // After Effects' camera: a field of view (projects from before it saw from a fixed focal length of 2)
    const ae = p.fov !== undefined, camR = rad(num(p.rotX)), camY = rad(num(p.rotY)), camZ = rad(num(p.rotZ)), dist = num(p.distance, ae ? 1 : 2), unit = W / 2;
    const focal = ae ? 1 / Math.tan(rad(Math.max(1, Math.min(159, num(p.fov, 45)))) / 2) : 2, sv = num(p.sizeVariation) / 100;
    const bc = parseColor(String(p.birthColor ?? '#ffff00')), dc = parseColor(String(p.deathColor ?? '#ff0000')), maxOp = num(p.maxOpacity, 75) / 100;
    const type = String(p.particleType ?? 'line');
    const first = Math.max(0, Math.floor((t - life) * rate)), last = Math.floor(t * rate);
    const parts: { sx: number; sy: number; ex: number; ey: number; z: number; f: number; size: number }[] = [];
    const project = (X: number, Y: number, Z: number) => {
      // camera: rotate the world, then perspective from `dist` in front
      const y1 = Y * Math.cos(camR) - Z * Math.sin(camR), z1 = Y * Math.sin(camR) + Z * Math.cos(camR);
      const x2 = X * Math.cos(camY) + z1 * Math.sin(camY), z2 = -X * Math.sin(camY) + z1 * Math.cos(camY);
      const k = focal / Math.max(0.05, dist + z2), x3 = x2 * Math.cos(camZ) - y1 * Math.sin(camZ), y3 = x2 * Math.sin(camZ) + y1 * Math.cos(camZ);
      return [W / 2 + x3 * k * unit, H / 2 + y3 * k * unit, z2, k] as const;
    };
    for (let i = first; i <= last && i - first < 6000; i++) {
      const born = i / rate, age = t - born, f = age / life;
      if (age < 0 || f > 1) continue;
      const r = (k: number) => rnd(seed, i * 11 + k) * 2 - 1;
      const p0 = [num(p.posX) + r(0) * num(p.radiusX, 0.025), num(p.posY) + r(1) * num(p.radiusY, 0.025), num(p.posZ) + r(2) * num(p.radiusZ, 0.025)];
      let v = [r(3), r(4), r(5)];
      const vl = Math.hypot(v[0], v[1], v[2]) || 1; v = v.map((q) => (q / vl) * vel * (0.5 + 0.5 * Math.abs(r(6))));
      if (anim === 'direction' || anim === 'jet' || anim === 'fractalUni') v = [anim === 'jet' ? vel : r(3) * 0.1 * vel, anim === 'jet' ? r(4) * 0.1 * vel : -vel, r(5) * 0.1 * vel];
      if (anim === 'cone') v = [r(3) * 0.3 * vel, -vel, r(5) * 0.3 * vel];
      if (anim === 'fire') v = [r(3) * 0.15 * vel, -Math.abs(vel) * (0.6 + 0.4 * Math.abs(r(4))), r(5) * 0.15 * vel];
      const pos = (a: number) => {
        // Viscous: thick air; Twirly and Vortex twirl tighter; the fractal ones wander with noise
        const rs = anim === 'viscous' ? res + 0.4 : res, dd = rs > 0 ? (1 - Math.exp(-rs * 5 * a)) / (rs * 5) : a;
        let X = p0[0] + v[0] * dd, Y = p0[1] + v[1] * dd + 0.5 * grav * a * a, Z = p0[2] + v[2] * dd;
        if (anim === 'twirl' || anim === 'twirly' || anim === 'vortex') { const ang = a * vel * (anim === 'twirl' ? 3 : 6), c = Math.cos(ang), s = Math.sin(ang); [X, Z] = [X * c - Z * s, X * s + Z * c]; if (anim === 'vortex') { const sh = 1 / (1 + a); X *= sh; Z *= sh; } }
        if (anim === 'fractalOmni' || anim === 'fractalUni') { X += fbm(a * 2, seed + i, 2) * 0.3 * a; Y += fbm(a * 2 + 40, seed + i, 2) * 0.3 * a; }
        return [X + extra * r(7) * a, Y, Z];
      };
      const [x1, y1, z1, k1] = project(...(pos(age) as [number, number, number]));
      const [x0, y0] = project(...(pos(Math.max(0, age - 1 / 30)) as [number, number, number]));
      const size = (num(p.birthSize, 0.1) + (num(p.deathSize, 0.25) - num(p.birthSize, 0.1)) * f) * k1 * unit * 0.1 * (1 - sv * rnd(seed, i * 11 + 9));
      parts.push({ sx: x0, sy: y0, ex: x1, ey: y1, z: z1, f, size });
    }
    parts.sort((a, b) => b.z - a.z);
    // Transfer Mode (projects from before it added the particles); Black Matte draws them on black
    const tm = String(p.transfer ?? 'add');
    if (tm === 'blackMatte') { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    g.globalCompositeOperation = tm === 'screen' ? 'screen' : tm === 'add' ? 'lighter' : 'source-over';
    for (const q of parts) {
      const c = [0, 1, 2].map((k) => Math.round((bc[k] + (dc[k] - bc[k]) * q.f) * 255)), al = maxOp * (1 - q.f * 0.5);
      const css = `rgba(${c[0]},${c[1]},${c[2]},${al})`;
      if (type === 'line') { g.strokeStyle = css; g.lineWidth = Math.max(0.5, q.size * 0.3); g.beginPath(); g.moveTo(q.sx, q.sy); g.lineTo(q.ex, q.ey); g.stroke(); }
      else if (type === 'triPolygon' || type === 'quadPolygon') {
        // a flat polygon turning as it flies
        const nv = type === 'triPolygon' ? 3 : 4, a0 = rnd(seed, Math.round(q.size * 1000) + nv) * 6.283 + q.f * 12;
        g.fillStyle = css; g.beginPath(); for (let k = 0; k < nv; k++) { const a = a0 + (k * 2 * Math.PI) / nv; g.lineTo(q.ex + Math.cos(a) * q.size, q.ey + Math.sin(a) * q.size * Math.abs(Math.cos(a0))); } g.fill();
      } else if (type === 'star') { g.fillStyle = css; g.beginPath(); for (let k = 0; k < 10; k++) { const a = (k * Math.PI) / 5, rr = k % 2 ? q.size * 0.4 : q.size; g.lineTo(q.ex + Math.cos(a) * rr, q.ey + Math.sin(a) * rr); } g.fill(); }
      else {
        const gr = g.createRadialGradient(q.ex - (type === 'shaded' ? q.size * 0.3 : 0), q.ey - (type === 'shaded' ? q.size * 0.3 : 0), 0, q.ex, q.ey, Math.max(0.5, q.size));
        if (type === 'darkFaded') { const dk = c.map((v) => Math.round(v * 0.45)); gr.addColorStop(0, `rgba(${dk[0]},${dk[1]},${dk[2]},${al})`); } else
        gr.addColorStop(0, type === 'shaded' ? `rgba(255,255,255,${al})` : css); gr.addColorStop(type === 'bubble' ? 0.8 : 0.4, css); gr.addColorStop(1, type === 'bubble' ? css : `rgba(${c[0]},${c[1]},${c[2]},0)`);
        g.fillStyle = gr; g.beginPath(); g.arc(q.ex, q.ey, Math.max(0.5, q.size), 0, Math.PI * 2); g.fill();
      }
    }
    g.globalCompositeOperation = 'source-over';
    return out;
  },
  // Polar Coordinates: wraps the layer around its centre (rectangular → polar) or unwraps it, blended by Interpolation
  polar: (cv, p) => {
    const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2, k = num(p.interpolation) / 100;
    if (k <= 0) return cv;
    const toPolar = String(p.conversion ?? 'rectToPolar') === 'rectToPolar';
    return remap(cv, (x, y) => {
      let sx: number, sy: number;
      if (toPolar) {
        // the source's x runs around the circle (from the top, clockwise) and its y outwards from the centre
        const a = Math.atan2(x - cx, -(y - cy)), r = Math.hypot(x - cx, y - cy);
        sx = ((a / (2 * Math.PI) + 1) % 1) * W; sy = (r / R) * H;
      } else {
        const a = (x / W) * 2 * Math.PI, r = (y / H) * R;
        sx = cx + Math.sin(a) * r; sy = cy - Math.cos(a) * r;
      }
      return [x + (sx - x) * k, y + (sy - y) * k];
    });
  },
  // Spherize: the area within Radius of the centre is stretched onto a half sphere (bigger in the middle)
  spherize: (cv, p, x) => {
    const R = num(p.radius) * x.res;
    if (R < 0.5) return cv;
    const [cx, cy] = pt(p.center, x);
    return remap(cv, (px, py) => {
      const dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy);
      if (d >= R || d === 0) return [px, py];
      const s = d / R, k = (Math.asin(s) / (Math.PI / 2)) / s;
      return [cx + dx * k, cy + dy * k];
    });
  },
  // Bezier Warp: a Coons patch of the four cubic edges (vertices and tangents) maps the layer's rectangle
  bezierWarp: (cv, p, x) => {
    const P = (k: string) => pt(p[k], x);
    const [tlv, tlt, trt, rtv, rtt, rbt, brv, brt, blt, lbv, lbt, ltt] = ['tlv', 'tlt', 'trt', 'rtv', 'rtt', 'rbt', 'brv', 'brt', 'blt', 'lbv', 'lbt', 'ltt'].map(P);
    const edge = (a: number[], b: number[], c: number[], d: number[], t: number): [number, number] => [cubic(a[0], b[0], c[0], d[0], t), cubic(a[1], b[1], c[1], d[1], t)];
    return warpGrid(cv, 8 * Math.round(num(p.quality, 8)), (u, v) => {
      const top = edge(tlv, tlt, trt, rtv, u), bottom = edge(lbv, blt, brt, brv, u), left = edge(tlv, ltt, lbt, lbv, v), right = edge(rtv, rtt, rbt, brv, v);
      const bil = (i: number) => (1 - u) * (1 - v) * tlv[i] + u * (1 - v) * rtv[i] + (1 - u) * v * lbv[i] + u * v * brv[i];
      return [(1 - v) * top[0] + v * bottom[0] + (1 - u) * left[0] + u * right[0] - bil(0), (1 - v) * top[1] + v * bottom[1] + (1 - u) * left[1] + u * right[1] - bil(1)];
    });
  },
  // Mesh Warp: rows × columns of vertices moved by the offsets of the distortion mesh, smooth between them
  meshWarp: (cv, p, x) => {
    const R = Math.max(1, Math.round(num(p.rows, 7))), C = Math.max(1, Math.round(num(p.columns, 7)));
    let off: number[][] = [];
    try { off = JSON.parse(String(p.mesh || '[]')); } catch { off = []; }
    if (!off.length) return cv;
    const at = (r: number, c: number, k: number) => { const rr = Math.max(0, Math.min(R, r)), cc = Math.max(0, Math.min(C, c)); return num(off[rr * (C + 1) + cc]?.[k]) * x.res; };
    const field = (u: number, v: number, k: number) => {
      const fr = v * R, fc = u * C, r = Math.min(R - 1, Math.floor(fr)), c = Math.min(C - 1, Math.floor(fc)), tr = fr - r, tc = fc - c;
      const row = (rr: number) => catmull(at(rr, c - 1, k), at(rr, c, k), at(rr, c + 1, k), at(rr, c + 2, k), tc);
      return catmull(row(r - 1), row(r), row(r + 1), row(r + 2), tr);
    };
    return warpGrid(cv, Math.max(R, C) * Math.round(num(p.quality, 8)), (u, v) => [u * cv.width + field(u, v, 0), v * cv.height + field(u, v, 1)]);
  },
  // Liquify: brushes (warp, turbulence-free twirl clockwise / counter-clockwise, pucker, bloat, shift pixels,
  // reflection) recorded as strokes; Distortion Percentage scales the whole field (animate it to undo / redo)
  liquify: (cv, p, x) => {
    let strokes: { tool: string; x: number; y: number; x2?: number; y2?: number; size?: number; pressure?: number }[] = [];
    try { strokes = JSON.parse(String(p.strokes || '[]')); } catch { strokes = []; }
    const k = num(p.distortion, 100) / 100;
    if (!strokes.length || !k) return cv;
    const S = strokes.map((s) => ({ ...s, cx: (num(s.x) - x.ox) * x.res, cy: (num(s.y) - x.oy) * x.res, ex: (num(s.x2 ?? s.x) - x.ox) * x.res, ey: (num(s.y2 ?? s.y) - x.oy) * x.res, r: num(s.size, 64) * x.res / 2, pr: num(s.pressure, 50) / 100 }));
    return remap(cv, (px, py) => {
      let sx = px, sy = py;
      for (const s of S) {
        const dx = sx - s.cx, dy = sy - s.cy, d = Math.hypot(dx, dy);
        if (d >= s.r) continue;
        const w = Math.pow(1 - (d / s.r) ** 2, 2) * s.pr * k;
        switch (s.tool) {
          case 'warp': case 'shift': sx -= (s.ex - s.cx) * w; sy -= (s.ey - s.cy) * w; break;
          case 'twirlCW': case 'twirlCCW': { const a = (s.tool === 'twirlCW' ? -1 : 1) * w * Math.PI; const c = Math.cos(a), si = Math.sin(a); sx = s.cx + dx * c - dy * si; sy = s.cy + dx * si + dy * c; break; }
          case 'pucker': sx = s.cx + dx * (1 + w); sy = s.cy + dy * (1 + w); break;
          case 'bloat': sx = s.cx + dx * (1 - w * 0.5); sy = s.cy + dy * (1 - w * 0.5); break;
          case 'reflect': sx = s.cx - dx * w + dx * (1 - w); sy = s.cy - dy * w + dy * (1 - w); break;
        }
      }
      return [sx, sy];
    });
  },
  // CC Bend It: the part of the layer between Start and End bends round an arc (the rest follows rigidly)
  bendIt: (cv, p, x) => {
    const th = rad(num(p.bend));
    const [sx, sy] = pt(p.start, x), [ex, ey] = pt(p.end, x);
    const L = Math.hypot(ex - sx, ey - sy);
    if (L < 1 || Math.abs(th) < 1e-4) return cv;
    const ax = (ex - sx) / L, ay = (ey - sy) / L, nx = -ay, ny = ax, mode = String(p.prestart ?? 'static');
    // a point at distance a along the axis and b across it, after bending (the axis becomes an arc of radius L/θ)
    const r = L / th;
    const bend = (a: number, b: number): [number, number] => {
      const aa = Math.min(a, L), phi = (aa / L) * th, rr = r - b;
      let px = sx + ax * (rr * Math.sin(phi)) + nx * (r - rr * Math.cos(phi)), py = sy + ay * (rr * Math.sin(phi)) + ny * (r - rr * Math.cos(phi));
      if (a > L) { const ux = ax * Math.cos(th) + nx * Math.sin(th), uy = ay * Math.cos(th) + ny * Math.sin(th); px += ux * (a - L); py += uy * (a - L); }
      return [px, py];
    };
    return warpGrid(cv, 64, (u, v) => {
      const X = u * cv.width, Y = v * cv.height, a = (X - sx) * ax + (Y - sy) * ay, b = (X - sx) * nx + (Y - sy) * ny;
      if (a >= 0) return bend(a, b);
      if (mode === 'none') return null;
      if (mode === 'bend') { const q = bend(-a, -b); return [2 * sx - q[0], 2 * sy - q[1]]; }
      if (mode === 'mirror') { const q = bend(-a, b); return q; }
      return [X, Y];
    });
  },
  // CC Power Pin: corner pin with a perspective amount and edge expansion (the source reaches past the pins)
  powerPin: (cv, p, x) => {
    const P = (k: string) => pt(p[k], x);
    let tl = P('tl'), tr = P('tr'), br = P('br'), bl = P('bl');
    const e = (k: string) => num(p[k]) / 100;
    // expansion: the pins move outwards along the quad's edges by that share of its size
    const mixP = (a: [number, number], b: [number, number], f: number): [number, number] => [a[0] + (a[0] - b[0]) * f, a[1] + (a[1] - b[1]) * f];
    const [et, el, er, eb] = [e('expTop'), e('expLeft'), e('expRight'), e('expBottom')];
    if (et || el || er || eb) { const ntl = mixP(mixP(tl, bl, et), tr, el), ntr = mixP(mixP(tr, br, et), tl, er), nbr = mixP(mixP(br, tr, eb), bl, er), nbl = mixP(mixP(bl, tl, eb), br, el); [tl, tr, br, bl] = [ntl, ntr, nbr, nbl]; }
    const pts: [number, number][] = [tl, tr, br, bl];
    const q = quadWeights(pts), pp = num(p.perspective, 100) / 100;
    quadGL ??= new GLQuad();
    const out = mk(cv.width, cv.height);
    ctx2d(out).drawImage(quadGL.draw(cv, cv.width, cv.height, pts, q.map((w) => 1 + (w - 1) * pp)), 0, 0);
    return out;
  },
  // Stroke: brush dabs along mask outlines (one after another with Stroke Sequentially), from Start to End
  stroke: (cv, p, x) => {
    const ms = pickMasks(x, String(p.path ?? ''), !!num(p.allMasks));
    const ink = mk(cv.width, cv.height), g = ctx2d(ink);
    const size = num(p.brushSize, 2) * x.res, hard = num(p.hardness, 75) / 100, step = Math.max(0.5, (size * num(p.spacing, 15)) / 100);
    const a = num(p.start) / 100, b = num(p.end, 100) / 100;
    const paths = ms.map((m) => canvasPts(m, x, true));
    const lens = paths.map(polyLength), total = lens.reduce((s, l) => s + l, 0);
    paths.forEach((pts, k) => {
      // sequential: Start / End over all the outlines one after another; else on each one
      let from = a * lens[k], to = b * lens[k];
      if (num(p.sequential, 1)) { const before = lens.slice(0, k).reduce((s, l) => s + l, 0); from = Math.max(0, a * total - before); to = Math.min(lens[k], b * total - before); }
      for (let d = from; d <= to; d += step) { const [px, py] = pointAt(pts, d); dab(g, px, py, size / 2, hard, String(p.color), 1); }
    });
    return paintStyle(cv, ink, String(p.paintStyle ?? 'original'), num(p.opacity, 100) / 100);
  },
  // Write-on: dabs where the brush position was, from the layer start (or Stroke Length ago) to now
  writeOn: (cv, p, x) => {
    const ink = mk(cv.width, cv.height), g = ctx2d(ink);
    const sp = Math.max(0.001, num(p.spacing, 0.01)), L = num(p.strokeLength);
    const t0 = L > 0 ? Math.max(0, x.t - L) : 0;
    const pt0 = String(p.paintTime ?? 'color'), bt = String(p.brushTime ?? 'none');
    for (let tt = t0; tt <= x.t + 1e-9; tt += sp) {
      const at = (k: string, now: unknown) => (x.at ? x.at(k, tt) : now);
      const [px, py] = pt(at('position', p.position), x);
      // time properties: the dab keeps the value it had when it was painted, or follows the current one
      const col = pt0 === 'color' ? at('color', p.color) : p.color, op = pt0 === 'opacity' ? num(at('opacity', p.opacity), 100) / 100 : 1;
      const size = num(bt === 'size' || bt === 'both' ? at('brushSize', p.brushSize) : p.brushSize, 2) * x.res;
      const hard = num(bt === 'hardness' || bt === 'both' ? at('hardness', p.hardness) : p.hardness, 75) / 100;
      dab(g, px, py, size / 2, hard, String(col), op);
    }
    return paintStyle(cv, ink, String(p.paintStyle ?? 'original'), pt0 === 'opacity' ? 1 : num(p.opacity, 100) / 100);
  },
  // Scribble: hatching across a mask at an angle, joined into one wiggling stroke, revealed from Start to End
  scribble: (cv, p, x) => {
    const mode = String(p.scribble ?? 'single');
    const ms = pickMasks(x, String(p.mask ?? ''), mode !== 'single');
    const ink = mk(cv.width, cv.height), g = ctx2d(ink);
    const lw = num(p.strokeWidth, 5) * x.res, sp = Math.max(0.5, num(p.spacing, 5) * x.res), ang = rad(num(p.angle, 45));
    const fillType = String(p.fillType ?? 'inside'), ew = num(p.edgeWidth, 10) * x.res;
    // wiggle: jumpy re-seeds every 1/wiggles s, smooth blends between those, static never changes
    const wps = num(p.wiggles, 5), wt = String(p.wiggleType ?? 'jumpy');
    const phase = wt === 'static' || wps <= 0 ? 0 : x.t * wps, k0 = Math.floor(phase), fr = wt === 'smooth' ? phase - k0 : 0;
    const seed = num(p.seed) * 7919 + 1;
    const jitter = (i: number, ch: number) => { const a = rnd(seed + ch, i * 977 + k0), b = rnd(seed + ch, i * 977 + k0 + 1); return (a + (b - a) * fr) * 2 - 1; };
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const sources = ms.length ? ms : [{ id: '', name: '', mode: 'add', inverted: false, pts: [x.ox, x.oy, x.ox + cv.width / x.res, x.oy, x.ox + cv.width / x.res, x.oy + cv.height / x.res, x.ox, x.oy + cv.height / x.res] }];
    const strokes: number[][] = [];
    for (const m of sources) {
      const pts = canvasPts(m, x, true);
      // the region to hatch (rotated frame: hatch lines are horizontal there)
      const rot = (X: number, Y: number) => [X * ca + Y * sa, -X * sa + Y * ca];
      const rp: number[] = []; for (let i = 0; i < pts.length; i += 2) { const [u, v] = rot(pts[i], pts[i + 1]); rp.push(u, v); }
      let v0 = Infinity, v1 = -Infinity; for (let i = 1; i < rp.length; i += 2) { v0 = Math.min(v0, rp[i]); v1 = Math.max(v1, rp[i]); }
      if (fillType !== 'inside') { v0 -= ew; v1 += ew; }
      const zig: number[] = [];
      let i = 0;
      for (let v = v0 + sp / 2; v < v1; v += sp * (1 + (num(p.spacingVariation, 50) / 100) * jitter(i, 3) * 0.5), i++) {
        // where the scan line crosses the outline (even-odd)
        const xs: number[] = [];
        for (let j = 0; j < rp.length; j += 2) { const ax = rp[j], ay = rp[j + 1], bx = rp[(j + 2) % rp.length], by = rp[(j + 3) % rp.length]; if ((ay <= v) !== (by <= v)) xs.push(ax + ((v - ay) / (by - ay)) * (bx - ax)); }
        if (xs.length < 2) continue;
        xs.sort((p1, p2) => p1 - p2);
        const ov = (num(p.overlap) / 100 + (num(p.overlapVariation) / 100) * jitter(i, 5)) * sp * 2;
        const lo = xs[0] - ov, hi = xs[xs.length - 1] + ov;
        if (i % 2 === 0) zig.push(lo, v, hi, v); else zig.push(hi, v, lo, v);
      }
      // back to canvas space, as a curvy polyline (curviness rounds the turns)
      const back = (u: number, v: number) => [u * ca - v * sa, u * sa + v * ca];
      const curv = num(p.curviness, 50) / 100, cvar = num(p.curvinessVariation, 50) / 100;
      const out: number[] = [];
      for (let q = 0; q + 3 < zig.length; q += 4) {
        const c = curv * (1 + cvar * jitter(q, 7));
        const [ax, ay] = back(zig[q], zig[q + 1]), [bx, by] = back(zig[q + 2], zig[q + 3]);
        const mx = (ax + bx) / 2, my = (ay + by) / 2, nx = -(by - ay), ny = bx - ax, nl = Math.hypot(nx, ny) || 1;
        const bend = (c * sp * 0.5) / nl;
        for (let s = 0; s <= 8; s++) { const f = s / 8, u = 1 - f; out.push(u * u * ax + 2 * u * f * (mx + nx * bend) + f * f * bx, u * u * ay + 2 * u * f * (my + ny * bend) + f * f * by); }
      }
      strokes.push(out);
    }
    const lens = strokes.map(polyLength), total = lens.reduce((s, l) => s + l, 0), a = num(p.start) / 100, b = num(p.end, 100) / 100;
    g.strokeStyle = rgba(p.color); g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
    strokes.forEach((pts, k) => {
      let from = a * lens[k], to = b * lens[k];
      if (num(p.sequential, 1)) { const before = lens.slice(0, k).reduce((s, l) => s + l, 0); from = Math.max(0, a * total - before); to = Math.min(lens[k], b * total - before); }
      if (to <= from) return;
      const part = slicePoly(pts, from, to);
      g.beginPath(); for (let i = 0; i < part.length; i += 2) { if (i) g.lineTo(part[i], part[i + 1]); else g.moveTo(part[i], part[i + 1]); } g.stroke();
    });
    // fill type: keep the hatching inside the mask, or on a band around its edge
    if (ms.length) {
      const clip = mk(cv.width, cv.height), cg = ctx2d(clip);
      const outline = (m: typeof ms[number]) => polyPath(m, x);
      if (fillType === 'inside') { cg.fillStyle = '#fff'; for (const m of ms) cg.fill(outline(m)); }
      else {
        cg.strokeStyle = '#fff'; cg.lineWidth = fillType === 'centered' ? ew : ew * 2; for (const m of ms) cg.stroke(outline(m));
        if (fillType === 'insideEdge' || fillType === 'outsideEdge') { cg.globalCompositeOperation = fillType === 'insideEdge' ? 'destination-in' : 'destination-out'; cg.fillStyle = '#fff'; for (const m of ms) cg.fill(outline(m)); }
      }
      g.globalCompositeOperation = 'destination-in'; g.drawImage(clip, 0, 0);
    }
    return paintStyle(cv, ink, String(p.composite ?? 'transparent'), num(p.opacity, 100) / 100);
  },
  // Radio Waves: shapes (polygon, star, a mask or the contours of a layer) that leave the producer point at a
  // frequency and grow, each with its own age: width, opacity and fades follow it
  radioWaves: (cv, p, x) => {
    const out = mk(cv.width, cv.height), g = ctx2d(out);
    const freq = num(p.frequency, 1), life = num(p.lifespan, 10), exp = num(p.expansion, 5) * x.res * x.fps;
    if (freq <= 0) return out;
    // the base outline, around the origin, at size 1 px of expansion
    const base: number[] = [];
    const wt = String(p.waveType ?? 'polygon');
    let src: number[] | null = null;
    if (wt === 'mask') { const m = pickMasks(x, String(p.mask ?? ''), false)[0]; if (m) src = canvasPts(m, x, true); }
    if (wt === 'contours' && x.layer && p.contourLayer) { const L = x.layer(String(p.contourLayer)); if (L) { const c = contours(L.cv, String(p.valueChannel ?? 'alpha'), num(p.valueThreshold, 127), !!num(p.invertInput))[0]; if (c) src = c.map((v, i) => (i % 2 ? (v / L.res + L.oy - x.oy) * x.res : (v / L.res + L.ox - x.ox) * x.res)); } }
    const [cx0, cy0] = pt(p.producer, x);
    if (src) {
      // a shape: around its own centre, normalised to radius 1
      let mx = 0, my = 0; for (let i = 0; i < src.length; i += 2) { mx += src[i]; my += src[i + 1]; } mx /= src.length / 2; my /= src.length / 2;
      let r = 1; for (let i = 0; i < src.length; i += 2) r = Math.max(r, Math.hypot(src[i] - mx, src[i + 1] - my));
      for (let i = 0; i < src.length; i += 2) base.push((src[i] - mx) / r, (src[i + 1] - my) / r);
    } else {
      const n = Math.max(3, Math.round(num(p.sides, 64))), star = !!num(p.star), sd = num(p.starDepth, -0.5);
      const cnt = star ? n * 2 : n;
      for (let i = 0; i < cnt; i++) { const a2 = (i / cnt) * Math.PI * 2 - Math.PI / 2; const r = star && i % 2 ? 1 + sd : 1; base.push(Math.cos(a2) * r, Math.sin(a2) * r); }
    }
    const profile = String(p.profile ?? 'square'), fadeIn = num(p.fadeIn), fadeOut = num(p.fadeOut);
    const dir = rad(num(p.direction, 90) - 90), vel = num(p.velocity) * x.res * x.fps, spin = num(p.spin), orient = rad(num(p.orientation));
    const first = Math.max(0, Math.floor((x.t - life) * freq)), last = Math.floor(x.t * freq + 1e-9);
    for (let w = first; w <= last; w++) {
      const born = w / freq, age = x.t - born;
      if (age < 0 || age > life) continue;
      const atBirth = String(p.setAt ?? 'birth') === 'birth' && x.at;
      const pv = (k: string, now: unknown) => (atBirth ? x.at!(k, born) : now);
      const [cx, cy] = atBirth ? pt(pv('producer', p.producer), x) : [cx0, cy0];
      const R = age * exp, f = life > 0 ? age / life : 0;
      const wdt = (num(pv('startWidth', p.startWidth), 5) + (num(pv('endWidth', p.endWidth), 5) - num(pv('startWidth', p.startWidth), 5)) * f) * x.res;
      let op = num(pv('opacity', p.opacity), 1);
      if (fadeIn > 0) op *= Math.min(1, age / fadeIn);
      if (fadeOut > 0) op *= Math.min(1, (life - age) / fadeOut);
      if (op <= 0 || R <= 0) continue;
      const ox = cx + Math.cos(dir) * vel * age, oy = cy + Math.sin(dir) * vel * age, rot = orient + rad(spin * age);
      const path = new Path2D();
      for (let i = 0; i < base.length; i += 2) { const bx = base[i] * Math.cos(rot) - base[i + 1] * Math.sin(rot), by = base[i] * Math.sin(rot) + base[i + 1] * Math.cos(rot); if (i) path.lineTo(ox + bx * R, oy + by * R); else path.moveTo(ox + bx * R, oy + by * R); }
      path.closePath();
      // profile across the ring: drawn as a few concentric strokes of decreasing width
      const prof = (u: number) => profile === 'triangle' ? 1 - Math.abs(u) : profile === 'sawOut' ? (u + 1) / 2 : profile === 'sawIn' ? (1 - u) / 2 : profile === 'gaussian' ? Math.exp(-u * u * 4) : profile === 'bell' ? (1 + Math.cos(u * Math.PI)) / 2 : profile === 'sine' ? Math.cos((u * Math.PI) / 2) : 1;
      g.strokeStyle = rgba(pv('color', p.color));
      if (profile === 'square') { g.globalAlpha = op; g.lineWidth = wdt; g.stroke(path); }
      else for (let s = 0; s < 6; s++) { const u = s / 6; g.globalAlpha = op * prof(u) / 3; g.lineWidth = wdt * (1 - u); g.stroke(path); }
    }
    g.globalAlpha = 1;
    // waves go over the layer
    const res = clone(cv); ctx2d(res).drawImage(out, 0, 0); return res;
  },
  // Beam: a tapered beam between two points, the part [time − length, time] of the way; core colour inside,
  // outside colour at its edges, softness spreads the edge; 3D perspective tapers it like a cone
  beam: (cv, p, x) => {
    const [ax, ay] = pt(p.start, x), [bx, by] = pt(p.end, x);
    const len = num(p.length, 25) / 100, tm = num(p.time, 50) / 100;
    const f1 = Math.max(0, Math.min(1, tm)), f0 = Math.max(0, Math.min(1, tm - len * (1 + 0) ));
    if (f1 <= f0) return num(p.composite) ? cv : mk(cv.width, cv.height);
    const t0 = num(p.startThickness, 8) * x.res, t1 = num(p.endThickness, 8) * x.res;
    const th = (f: number) => (num(p.perspective, 1) ? t0 * Math.pow(t1 / Math.max(1e-6, t0), f) : t0 + (t1 - t0) * f);
    const L = (f: number) => [ax + (bx - ax) * f, ay + (by - ay) * f];
    const dx = bx - ax, dy = by - ay, dl = Math.hypot(dx, dy) || 1, nx = -dy / dl, ny = dx / dl;
    const out = num(p.composite) ? clone(cv) : mk(cv.width, cv.height), g = ctx2d(out);
    const soft = num(p.softness, 50) / 100;
    // concentric layers from the outside colour to the core
    const layers = 12;
    for (let s = 0; s < layers; s++) {
      const u = s / (layers - 1), w = 1 - u * (1 - (1 - soft) * 0.5);
      const [p0x, p0y] = L(f0), [p1x, p1y] = L(f1), h0 = (th(f0) / 2) * w, h1 = (th(f1) / 2) * w;
      g.beginPath();
      g.moveTo(p0x + nx * h0, p0y + ny * h0); g.lineTo(p1x + nx * h1, p1y + ny * h1); g.arc(p1x, p1y, h1, Math.atan2(ny, nx), Math.atan2(ny, nx) + Math.PI, true);
      g.lineTo(p0x - nx * h0, p0y - ny * h0); g.arc(p0x, p0y, h0, Math.atan2(-ny, -nx), Math.atan2(-ny, -nx) + Math.PI, true);
      g.closePath();
      g.fillStyle = mixHex(String(p.outside), String(p.inside), u);
      g.globalAlpha = soft > 0 ? Math.min(1, 0.25 + u) : 1;
      g.fill();
    }
    g.globalAlpha = 1;
    return out;
  },
  // Vegas: running lights — dashes along the contours of a layer (or a mask), turning with Rotation
  vegas: (cv, p, x) => {
    let lines: number[][] = [];
    if (String(p.source ?? 'contours') === 'mask') lines = pickMasks(x, String(p.mask ?? ''), !p.mask).map((m) => canvasPts(m, x, true));
    else {
      const L = p.input && x.layer ? x.layer(String(p.input)) : null;
      const srcCv = L ? L.cv : cv, k = L ? x.res / L.res : 1, offx = L ? (L.ox - x.ox) * x.res : 0, offy = L ? (L.oy - x.oy) * x.res : 0;
      lines = contours(srcCv, String(p.channel ?? 'intensity'), num(p.threshold, 127), !!num(p.invert)).map((c) => c.map((v, i) => (i % 2 ? v * k + offy : v * k + offx)));
    }
    const ink = mk(cv.width, cv.height), g = ctx2d(ink);
    const segs = Math.max(1, Math.round(num(p.segments, 32))), segLen = Math.max(0, Math.min(1, num(p.length, 1)));
    const rotF = num(p.rotation) / 360, w = num(p.width, 2) * x.res, hard = num(p.hardness, 0);
    const so = num(p.startOpacity, 1), mp = num(p.midPosition, 0.5), eo = num(p.endOpacity, 0);
    // After Effects' Mid-point Opacity (−1…1) is added to the straight line from start to end opacity; projects from
    // before «invert» used it as the mid-point opacity itself
    const mo = p.invert === undefined ? num(p.midOpacity, 1) : so + (eo - so) * mp + num(p.midOpacity);
    const opAt = (u: number) => (u < mp ? so + (mo - so) * (u / Math.max(1e-6, mp)) : mo + (eo - mo) * ((u - mp) / Math.max(1e-6, 1 - mp)));
    g.lineCap = 'round'; g.lineWidth = w; g.shadowColor = rgba(p.color); g.shadowBlur = w * (1 - hard) * 2;
    lines.forEach((pts, li) => {
      const total = polyLength(pts);
      if (total <= 1) return;
      const ph = num(p.randomPhase) ? rnd(num(p.seed, 1) * 131, li) : 0;
      for (let s = 0; s < segs; s++) {
        // bunched: segments packed together; even: spread over the contour
        const slot = String(p.distribution ?? 'even') === 'even' ? 1 / segs : (1 / segs) * Math.min(1, segLen * 2);
        const st = ((s / segs + rotF + ph) % 1 + 1) % 1, dl = slot * segLen * total * (String(p.distribution ?? 'even') === 'even' ? 1 : 1 / Math.max(1e-6, Math.min(1, segLen * 2)));
        const steps = 6;
        for (let q = 0; q < steps; q++) {
          const u0 = q / steps, u1 = (q + 1) / steps;
          const a = st * total + u0 * dl, b = st * total + u1 * dl;
          const part = slicePoly(pts, a % total, Math.min(total, (a % total) + (b - a)));
          if (part.length < 4) continue;
          g.globalAlpha = Math.max(0, Math.min(1, opAt((u0 + u1) / 2)));
          g.strokeStyle = rgba(p.color);
          g.beginPath(); for (let i = 0; i < part.length; i += 2) { if (i) g.lineTo(part[i], part[i + 1]); else g.moveTo(part[i], part[i + 1]); } g.stroke();
        }
      }
    });
    g.globalAlpha = 1;
    const mode = String(p.blend ?? 'over');
    if (mode === 'transparent') return ink;
    const out = clone(cv), og = ctx2d(out);
    og.globalCompositeOperation = mode === 'under' ? 'destination-over' : mode === 'stencil' ? 'destination-in' : 'source-over';
    og.drawImage(ink, 0, 0);
    return out;
  },
  // invert: fx-groups/color.ts
  // blackWhite: fx-groups/color.ts
  posterize: (cv, p) => { const n = Math.max(2, Math.round(num(p.levels, 6))); return lut(cv, (v) => Math.round((Math.round((v / 255) * (n - 1)) / (n - 1)) * 255)); },
  threshold: (cv, p) => { const t = num(p.level, 128); return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { const v = lum(d[i], d[i + 1], d[i + 2]) >= t ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; } }); },
  vibrance: (cv, p) => {
    const vib = num(p.vibrance) / 100, sat = num(p.saturation) / 100;
    return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const s = mx ? (mx - mn) / mx : 0; const k = 1 + sat + vib * (1 - s); const L = lum(r, g, b); d[i] = L + (r - L) * k; d[i + 1] = L + (g - L) * k; d[i + 2] = L + (b - L) * k; } });
  },
  glow: (cv, p, x) => {
    // After Effects: the glow reaches 0.6 × radius + 2 px past the source (×1 in draft quality);
    // radius 10 and intensity 1 by default; Dimensions zeroes one axis
    const th = (num(p.threshold, 60) / 100) * 255, k = num(p.intensity, 1), dims = String(p.dimensions ?? 'both'), ab = p.mode === 'ab';
    const rad0 = ((0.6 * num(p.radius, 10) + 2) / 3) * 2 * x.res;
    // the bright pass is blurred anyway: work at reduced size for wide glows
    const ks = rad0 > 24 ? 0.25 : rad0 > 8 ? 0.5 : 1;
    const bright = mk(cv.width * ks, cv.height * ks);
    const bg = ctx2d(bright);
    // «based on alpha»: the glow comes from the layer's alpha (white), not from its colours
    const src = p.basedOn === 'alpha' ? (() => { const s = clone(cv), sg = ctx2d(s); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#fff'; sg.fillRect(0, 0, s.width, s.height); return s; })() : cv;
    bg.filter = brightPassFilter(th / 255, p.mode === 'color' ? String(p.color) : ab ? '#ffffff' : null); // GPU bright pass
    bg.drawImage(src, 0, 0, bright.width, bright.height);
    let glowCv = mk(cv.width, cv.height);
    const g = ctx2d(glowCv);
    g.globalCompositeOperation = 'lighter';
    for (const [s, w] of [[0.25, 0.5], [0.55, 0.6], [1, 0.8]] as const) {
      const small = blurCanvas(bright, (rad0 * s * ks) / 2, dims);
      const b = mk(cv.width, cv.height);
      ctx2d(b).drawImage(small, 0, 0, cv.width, cv.height);
      g.globalAlpha = Math.min(1, k * w * 0.6);
      for (let r = (ab ? 1 : k) * w * 0.6; r > 0; r -= 1) { g.globalAlpha = Math.min(1, r); g.drawImage(b, 0, 0); }
    }
    g.globalAlpha = 1;
    if (ab) glowCv = glowColorMap(glowCv, p, k);
    // After Effects' order: the ORIGINAL is blended onto the glow with the operation, then
    // composited again on top / behind (or not at all)
    const out = glowCv, og = ctx2d(out);
    const OPS: Record<string, GlobalCompositeOperation> = { add: 'lighter', normal: 'source-over' };
    const op = String(p.operation ?? 'add');
    if (op !== 'none') { og.globalCompositeOperation = OPS[op] ?? (op as GlobalCompositeOperation); og.drawImage(cv, 0, 0); }
    const comp = String(p.composite ?? 'behind');
    if (comp === 'onTop') { og.globalCompositeOperation = 'source-over'; og.drawImage(cv, 0, 0); }
    else if (comp === 'behind') { og.globalCompositeOperation = 'destination-over'; og.drawImage(cv, 0, 0); }
    og.globalCompositeOperation = 'source-over';
    return out;
  },
  dropShadow: (cv, p, x) => {
    const a = rad(num(p.direction, 135) - 90), dist = num(p.distance, 10) * x.res, soft = num(p.softness, 10) * x.res;
    const sh = clone(cv);
    const g = ctx2d(sh);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = rgba(p.color, num(p.opacity, 50) / 100);
    g.fillRect(0, 0, sh.width, sh.height);
    const bl = blurCanvas(sh, soft / 2);
    const out = mk(cv.width, cv.height);
    const o = ctx2d(out);
    o.drawImage(bl, Math.cos(a) * dist, Math.sin(a) * dist);
    if (!num(p.only)) o.drawImage(cv, 0, 0);
    return out;
  },
  displacementMap: (cv, p, x) => {
    // each pixel takes the colour found (value − 0.5) × 2 × max px away, read from a channel of the map layer
    const map = inputCanvas(p.map, cv, x, p.fit);
    if (!map) return cv;
    const W = cv.width, H = cv.height, wrap = !!num(p.wrap);
    const hm = num(p.hMax, 5) * x.res * 2, vm = num(p.vMax, 5) * x.res * 2;
    const src = imgData(cv).data, md = imgData(map).data;
    const out = mk(W, H);
    const g = ctx2d(out);
    const o = g.createImageData(W, H), d = o.data;
    // like After Effects (it samples through its sub-pixel sampling suite): bilinear between the 4 nearest pixels
    const at = (x: number, y: number) => (wrap ? ((((y % H) + H) % H) * W + (((x % W) + W) % W)) : Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 4;
    for (let y = 0; y < H; y++) for (let x0 = 0; x0 < W; x0++) {
      const i = (y * W + x0) * 4;
      const fx = x0 + (chan(md, i, p.hChannel ?? 'red') - 0.5) * hm, fy = y + (chan(md, i, p.vChannel ?? 'green') - 0.5) * vm;
      const xi = Math.floor(fx), yi = Math.floor(fy), u = fx - xi, v = fy - yi;
      const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), e = at(xi + 1, yi + 1);
      for (let k = 0; k < 4; k++) d[i + k] = (src[a + k] * (1 - u) + src[b + k] * u) * (1 - v) + (src[c + k] * (1 - u) + src[e + k] * u) * v;
    }
    g.putImageData(o, 0, 0);
    return out;
  },
  gradientWipe: (cv, p, x) => {
    // pixels disappear in the order of the gradient layer's luminance (dark first), with a soft edge
    const c = num(p.completion) / 100;
    if (c <= 0) return cv;
    // no gradient layer: like After Effects (its default is the layer itself), the layer's own luminance
    const map = inputCanvas(p.gradient, cv, x, p.fit) ?? clone(cv);
    // After Effects (GPU path): edge half-width = max(softness / 2, 1/255)
    const soft = Math.max(2 / 255, num(p.softness) / 100), inv = !!num(p.invert);
    const md = imgData(map).data;
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        let v = chan(md, i, 'luma'); if (inv) v = 1 - v;
        // edge moves from −soft to 1 so that 0 % shows all and 100 % hides all
        const e = c * (1 + soft) - soft, a = Math.max(0, Math.min(1, (v - e) / soft));
        d[i + 3] *= a;
      }
    });
  },
  setMatte: (cv, p, x) => {
    // the parameters and defaults of After Effects' Set Matte: no layer = the layer itself,
    // premultiply the matte layer, composite with the original alpha
    const map = inputCanvas(p.from, cv, x, p.fit) ?? clone(cv);
    const md = imgData(map).data, inv = !!num(p.invert), c = p.channel ?? 'alpha', comp = num(p.composite, 1) !== 0, pre = num(p.premultiply, 1) !== 0;
    if (pre && c !== 'alpha') for (let i = 0; i < md.length; i += 4) { const a = md[i + 3] / 255; md[i] *= a; md[i + 1] *= a; md[i + 2] *= a; }
    return pixels(cv, (d) => { for (let i = 0; i < d.length; i += 4) { let v = chan(md, i, c); if (c === 'luma') v = lum(md[i], md[i + 1], md[i + 2]) / 255; if (inv) v = 1 - v; d[i + 3] = comp ? d[i + 3] * v : v * 255; } });
  },
  compoundBlur: (cv, p, x) => {
    // After Effects' algorithm: a pyramid of half-size images; each pixel takes the level
    // radius ≤ 1 ? radius : log2(radius + 1), radius = map value × max blur, interpolated between two levels
    const map = inputCanvas(p.map, cv, x, p.fit) ?? clone(cv);
    const max = num(p.max, 20) * x.res;
    if (max <= 0) return cv;
    const inv = !!num(p.invert), W = cv.width, H = cv.height;
    const levels: Uint8ClampedArray[] = [imgData(cv).data];
    const top = Math.min(15, Math.ceil(Math.log2(max + 1)) + 1);
    let small = cv;
    for (let k = 1; k <= top; k++) {
      const w = Math.max(1, Math.round(small.width / 2)), h = Math.max(1, Math.round(small.height / 2));
      if (w <= 2 || h <= 2) break;
      const next = mk(w, h), ng = ctx2d(next);
      ng.imageSmoothingQuality = 'high';
      ng.drawImage(small, 0, 0, w, h);
      small = next;
      const up = mk(W, H), ug = ctx2d(up);
      ug.imageSmoothingQuality = 'high';
      ug.drawImage(next, 0, 0, W, H);
      levels.push(imgData(up).data);
    }
    const n = levels.length - 1, md = imgData(map).data;
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        let v = chan(md, i, 'luma'); if (inv) v = 1 - v;
        const r = v * max, lv = Math.min(n, r <= 1 ? r : Math.log2(r + 1));
        const a = Math.min(n, Math.floor(lv)), b = Math.min(n, a + 1), f = lv - a, A = levels[a], B = levels[b];
        for (let k = 0; k < 4; k++) d[i + k] = A[i + k] * (1 - f) + B[i + k] * f;
      }
    });
  },
  rimLight: (cv, p, x) => {
    // light that wraps the edge of a backlit silhouette: inside the alpha, where a step towards the light (or any
    // direction) leaves the shape; plus an optional halo outside it
    const w = num(p.width, 10) * x.res, soft = num(p.softness, 6) * x.res, k = num(p.intensity, 1.5);
    const tinted = (src: HTMLCanvasElement, col: unknown) => { const c = clone(src); const g = ctx2d(c); g.globalCompositeOperation = 'source-in'; g.fillStyle = rgba(col, 1); g.fillRect(0, 0, c.width, c.height); return c; };
    const out = clone(cv);
    const halo = num(p.halo) * x.res;
    if (halo > 0) {
      const h = blurCanvas(tinted(cv, p.haloColor ?? '#ff2a1a'), halo / 2);
      const g = ctx2d(out);
      g.globalCompositeOperation = 'destination-over';
      for (let r = (num(p.haloOpacity, 70) / 100) * 1.6; r > 0; r -= 1) { g.globalAlpha = Math.min(1, r); g.drawImage(h, 0, 0); }
      g.globalAlpha = 1;
    }
    if (w <= 0 || k <= 0) return out;
    const rim = tinted(cv, p.color ?? '#ff3b2f');
    const rg = ctx2d(rim);
    rg.globalCompositeOperation = 'destination-out';
    if (p.mode === 'directional') {
      // light comes from `direction` (0 = from above, clockwise): cut what is still inside one step towards it
      const a = rad(num(p.direction) - 90);
      for (let s = 0.34; s <= 1.001; s += 0.33) rg.drawImage(cv, -Math.cos(a) * w * s, -Math.sin(a) * w * s);
    } else {
      // erosion: the shape shifted in 12 directions, intersected, is cut out → only a band of width w stays
      const er = clone(cv);
      const eg = ctx2d(er);
      eg.globalCompositeOperation = 'destination-in';
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; eg.drawImage(cv, Math.cos(a) * w, Math.sin(a) * w); }
      rg.drawImage(er, 0, 0);
    }
    let band = soft > 0.5 ? blurCanvas(rim, soft / 2) : rim;
    if (soft > 0.5) { band = clone(band); const bg = ctx2d(band); bg.globalCompositeOperation = 'destination-in'; bg.drawImage(cv, 0, 0); }
    const g = ctx2d(out);
    g.globalCompositeOperation = 'lighter';
    for (let r = k; r > 0; r -= 1) { g.globalAlpha = Math.min(1, r); g.drawImage(band, 0, 0); }
    g.globalAlpha = 1;
    return out;
  },
  outline: (cv, p, x) => {
    const w = num(p.width, 6) * x.res;
    if (w <= 0) return cv;
    const sil = clone(cv);
    const g = ctx2d(sil);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = rgba(p.color, 1);
    g.fillRect(0, 0, sil.width, sil.height);
    const out = mk(cv.width, cv.height);
    const o = ctx2d(out);
    o.globalAlpha = num(p.opacity, 100) / 100;
    const steps = Math.max(8, Math.ceil(w * 2));
    for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; o.drawImage(sil, Math.cos(a) * w, Math.sin(a) * w); }
    for (let r = w / 2; r > 0.5; r /= 2) for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; o.drawImage(sil, Math.cos(a) * r, Math.sin(a) * r); }
    o.globalAlpha = 1;
    o.drawImage(cv, 0, 0);
    return out;
  },
  particles: (cv, p, x) => particles(cv, p, x, 'particles'),
  lightning: (cv, p, x) => lightning(cv, p, x),
  gooey: (cv, p, x) => {
    const out = mk(cv.width, cv.height);
    const g = ctx2d(out);
    g.filter = gooeyFilter(Math.max(0, num(p.radius, 12)) * x.res, num(p.threshold, 50) / 100, num(p.softness, 4) / 100);
    g.drawImage(cv, 0, 0);
    return out;
  },
  rain: (cv, p, x) => particles(cv, p, x, 'rain'),
  snow: (cv, p, x) => particles(cv, p, x, 'snow'),
  // Transform: anchor → scale → skew along its axis → rotation → position; with its own shutter angle (and Use
  // Composition's Shutter Angle off) the transform is sampled across the shutter for motion blur
  transformFx: (cv, p, x) => {
    const out = mk(cv.width, cv.height);
    const g = ctx2d(out);
    g.imageSmoothingQuality = p.sampling === 'bicubic' ? 'high' : 'low';
    const draw = (q: Params, alpha: number) => {
      const [ax, ay] = pt(q.anchor, x), [px, py] = pt(q.position, x);
      const sh = num(q.scale, 100) / 100, sw = num(q.uniform, 1) ? sh : num(q.scaleWidth, 100) / 100;
      const sk = Math.tan(rad(Math.max(-70, Math.min(70, num(q.skew))))), axis = rad(num(q.skewAxis)), r = rad(num(q.rotation));
      g.save();
      g.globalAlpha = alpha * Math.max(0, Math.min(1, num(q.opacity, 100) / 100));
      g.translate(px, py); g.rotate(r); g.rotate(axis); g.transform(1, 0, sk, 1, 0, 0); g.rotate(-axis); g.scale(sw, sh); g.translate(-ax, -ay);
      g.drawImage(cv, 0, 0);
      g.restore();
    };
    const sa = num(p.shutterAngle);
    if (num(p.compShutter, 1) || sa <= 0 || !x.at) { draw(p, 1); return out; }
    // motion blur: N instants over the shutter (centred on the frame), added with equal weights
    const N = 12, span = (Math.min(360, sa) / 360) / Math.max(1, x.fps);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < N; i++) {
      const t = x.t + ((i + 0.5) / N - 0.5) * span;
      const q: Params = { ...p };
      for (const k of ['anchor', 'position', 'scale', 'scaleWidth', 'skew', 'skewAxis', 'rotation', 'opacity']) q[k] = x.at(k, t) ?? p[k];
      draw(q, 1 / N);
    }
    return out;
  },
  mirror: (cv, p, x) => {
    const [cx, cy] = pt(p.center, x), a = rad(num(p.angle));
    const out = clone(cv);
    const g = ctx2d(out);
    // keep the side "before" the line, replace the other with its reflection
    g.save();
    g.translate(cx, cy); g.rotate(a);
    g.globalCompositeOperation = 'destination-out';
    g.fillRect(0, -1e5, 2e5, 2e5);
    g.restore();
    g.save();
    g.translate(cx, cy); g.rotate(a); g.scale(-1, 1); g.rotate(-a); g.translate(-cx, -cy);
    g.globalCompositeOperation = 'destination-over';
    g.drawImage(out, 0, 0);
    g.restore();
    return out;
  },
  offset: (cv, p, x) => {
    const orig = clone(cv);
    const [sx, sy] = pt(p.shift, x);
    const W = cv.width, H = cv.height;
    const dx = ((sx - W / 2) % W + W) % W, dy = ((sy - H / 2) % H + H) % H;
    const out = mk(W, H);
    const g = ctx2d(out);
    for (const ox of [dx - W, dx]) for (const oy of [dy - H, dy]) g.drawImage(cv, ox, oy);
    return blendWithOriginal(orig, out, num(p.blend));
  },
  // Wave Warp: a wave travelling along Direction pushes the pixels across it (nine wave shapes, pinned edges)
  waveWarp: (cv, p, x) => {
    const TYPES = ['sine', 'square', 'triangle', 'sawtooth', 'circle', 'semicircle', 'uncircle', 'noise', 'smoothNoise'];
    const PINS = ['none', 'all', 'center', 'left', 'top', 'right', 'bottom', 'horizontal', 'vertical'];
    const type = Math.max(0, TYPES.indexOf(String(p.type ?? 'sine'))), pin = Math.max(0, PINS.indexOf(String(p.pinning ?? 'none')));
    // phase in cycles: Wave Speed is cycles per second, Phase an angle of the wave
    const ph = x.t * num(p.speed, 1) + num(p.phase) / 360;
    return W8().run(cv, 4, [num(p.height, 10) * x.res, Math.max(1, num(p.width, 40) * x.res), rad(num(p.direction, 90)), ph], [0, 0], 0, [type, pin, 0, 0]);
  },
  linearWipe: (cv, p) => {
    const c = num(p.completion) / 100;
    if (c <= 0) return cv;
    const a = rad(num(p.angle, 90)), f = num(p.feather);
    return maskByCompletion(cv, (g, w, h) => {
      const dx = Math.sin(a), dy = -Math.cos(a);
      const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
      const span = half * 2 + f;
      const edge = -half - f / 2 + span * c;
      const gr = g.createLinearGradient(w / 2 + dx * (edge - f / 2), h / 2 + dy * (edge - f / 2), w / 2 + dx * (edge + f / 2 + 0.01), h / 2 + dy * (edge + f / 2 + 0.01));
      gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    });
  },
  radialWipe: (cv, p, x) => {
    const c = num(p.completion) / 100;
    if (c <= 0) return cv;
    const [cx, cy] = pt(p.center, x), s = rad(num(p.start) - 90), f = num(p.feather) * x.res;
    // Both: the wipe opens to both sides of the start angle, each half as far
    const arcs: [number, number][] = p.wipe === 'both' ? [[s - c * Math.PI, s + c * Math.PI]] : p.wipe === 'ccw' ? [[s - c * Math.PI * 2, s]] : [[s, s + c * Math.PI * 2]];
    return maskByCompletion(cv, (g, w, h) => {
      if (f > 0) g.filter = `blur(${f / 2}px)`;
      for (const [a, b] of arcs) { g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, Math.hypot(w, h) * 2, a, b); g.closePath(); g.fill(); }
    });
  },
  // Iris Wipe: only a star (or polygon) of Outer Radius round the centre stays; projects saved before keep the
  // completion and shape of the old version
  iris: (cv, p, x) => {
    if (p.outerRadius !== undefined || p.completion === undefined) {
      const [cx, cy] = pt(p.center, x), n = Math.max(3, Math.round(num(p.points, 6))), R = Math.max(0, num(p.outerRadius)) * x.res, f = num(p.feather) * x.res, rot = rad(num(p.rotation));
      // without Inner Radius the points are joined straight (a regular polygon)
      const ri = num(p.useInner) ? Math.max(0, num(p.innerRadius)) * x.res : R * Math.cos(Math.PI / n);
      return maskByCompletion(cv, (g, w, h) => {
        g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'destination-out';
        if (f > 0) g.filter = `blur(${f / 2}px)`;
        g.beginPath();
        for (let k = 0; k < n * 2; k++) { const a = rot - Math.PI / 2 + (k * Math.PI) / n, r = k % 2 ? ri : R; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
        g.closePath(); g.fill();
      });
    }
    const c = num(p.completion) / 100;
    if (c <= 0) return cv;
    const [cx, cy] = pt(p.center, x), f = num(p.feather) * x.res;
    return maskByCompletion(cv, (g, w, h) => {
      const R = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * (p.shape === 'square' ? 1 : p.shape === 'diamond' ? 1.42 : p.shape === 'star' ? 2.2 : 1) + f;
      const r = R * (1 - c);
      // everything outside the shape disappears: fill all, then cut the shape
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'destination-out';
      if (f > 0) g.filter = `blur(${f / 2}px)`;
      g.beginPath();
      if (p.shape === 'square') g.rect(cx - r, cy - r, r * 2, r * 2);
      else if (p.shape === 'diamond') { g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); }
      else if (p.shape === 'star') { for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? r * 0.45 : r; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); }
      else g.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
      g.fill();
    });
  },
  venetianBlinds: (cv, p, x) => {
    const c = num(p.completion) / 100;
    if (c <= 0) return cv;
    const a = rad(num(p.direction)), wd = Math.max(1, num(p.width, 20) * x.res), f = Math.min(num(p.feather) * x.res, wd);
    return maskByCompletion(cv, (g, w, h) => {
      g.translate(w / 2, h / 2); g.rotate(a);
      const R = Math.hypot(w, h);
      // each blind closes from its top edge; Feather softens the closing edge
      for (let y = -R; y < R; y += wd) {
        const e = wd * c;
        if (f > 0) { const gr = g.createLinearGradient(0, y + e - f / 2, 0, y + e + f / 2); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(-R, y, R * 2, Math.min(wd, e + f / 2)); }
        else g.fillRect(-R, y, R * 2, e);
      }
    });
  },
  blockDissolve: (cv, p, x) => {
    const c = num(p.completion) / 100;
    if (c <= 0) return cv;
    // blocks of Block Width × Height vanish in a random order (old projects: one square 'block' size and a seed)
    const bw = Math.max(1, num(p.blockWidth ?? p.block, 1) * x.res), bh = Math.max(1, num(p.blockHeight ?? p.block, 1) * x.res), seed = num(p.seed, 1), f = num(p.feather) * x.res;
    return maskByCompletion(cv, (g, w, h) => {
      if (f > 0) g.filter = `blur(${f / 2}px)`;
      const nx = Math.ceil(w / bw), ny = Math.ceil(h / bh);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (rnd(seed, j * nx + i) < c) g.fillRect(i * bw, j * bh, bw + 0.5, bh + 0.5);
    });
  },
  noise: (cv, p, x) => {
    // After Effects' Noise: color noise and clipping on by default; without clipping the values wrap around
    const a = (num(p.amount) / 100) * 255, col = num(p.color, 1) !== 0, clip = num(p.clip, 1) !== 0, size = Math.max(1, Math.round(num(p.size, 1) * x.res));
    if (a <= 0) return cv;
    const fr = Math.round(x.t * x.fps);
    const seed = hash2(x.seed, fr);
    const put = (d: Uint8ClampedArray, i: number, v: number) => { d[i] = clip ? v : ((Math.round(v) % 256) + 256) % 256; };
    return pixels(cv, (d, w) => { for (let i = 0; i < d.length; i += 4) { const px = (i / 4) % w, py = Math.floor(i / 4 / w); const cell = Math.floor(py / size) * 100003 + Math.floor(px / size); const n0 = (rnd(seed, cell) - 0.5) * a; if (col) { put(d, i, d[i] + n0); put(d, i + 1, d[i + 1] + (rnd(seed + 1, cell) - 0.5) * a); put(d, i + 2, d[i + 2] + (rnd(seed + 2, cell) - 0.5) * a); } else { put(d, i, d[i] + n0); put(d, i + 1, d[i + 1] + n0); put(d, i + 2, d[i + 2] + n0); } } });
  },
  chromaticAberration: (cv, p, x) => {
    const amt = num(p.amount, 8) * x.res, a = rad(num(p.angle));
    const dx = Math.cos(a) * amt, dy = Math.sin(a) * amt;
    const chan = (m: string) => { const c = clone(cv); const g = ctx2d(c); g.globalCompositeOperation = 'multiply'; g.fillStyle = m; g.fillRect(0, 0, c.width, c.height); g.globalCompositeOperation = 'destination-in'; g.drawImage(cv, 0, 0); return c; };
    const out = mk(cv.width, cv.height);
    const g = ctx2d(out);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(chan('#ff0000'), dx, dy);
    g.drawImage(chan('#00ff00'), 0, 0);
    g.drawImage(chan('#0000ff'), -dx, -dy);
    return out;
  },
  glitch: (cv, p, x) => {
    const amt = num(p.amount, 50) / 100;
    if (amt <= 0) return cv;
    const bh = Math.max(2, num(p.block, 30) * x.res), rgb = num(p.rgb, 12) * x.res, speed = Math.max(0.01, num(p.speed, 12));
    const step = Math.floor(x.t * speed);
    const seed = hash2(num(p.seed, 1) + x.seed, step);
    const out = mk(cv.width, cv.height);
    const g = ctx2d(out);
    for (let y = 0, i = 0; y < cv.height; y += bh, i++) {
      const hit = rnd(seed, i) < amt * 0.6;
      const sh = hit ? (rnd(seed, i + 999) - 0.5) * cv.width * 0.15 * amt : 0;
      g.drawImage(cv, 0, y, cv.width, bh, sh, y, cv.width, bh);
    }
    if (rgb > 0 && rnd(seed, 5555) < 0.5 + amt / 2) return FX_IMPL.chromaticAberration(out, { amount: (rgb * (0.5 + rnd(seed, 777))) / x.res, angle: 0 }, x);
    return out;
  },
  scanlines: (cv, p, x) => {
    const out = clone(cv);
    const g = ctx2d(out);
    const s = Math.max(2, num(p.spacing, 4) * x.res), off = (((x.t * num(p.speed)) * x.res) % s + s) % s;
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(0,0,0,${num(p.opacity, 30) / 100})`;
    for (let y = off - s; y < out.height; y += s) g.fillRect(0, y, out.width, s / 2);
    return out;
  },
  audioSpectrum: (cv, p, x) => {
    const src = typeof p.audio === 'string' && p.audio ? x.audio?.(p.audio) : null;
    if (!src) return cv;
    // «maximum height»: px for a full-scale tone (a −18 dB tone at 4000 reaches 500 px)
    const bands = Math.max(1, Math.round(num(p.bands, 64))), maxH = num(p.maxHeight, 480) * x.res;
    const mags = spectrum(src.pcm, src.time + num(p.offset) / 1000, num(p.duration, 90), bands, Math.max(1, num(p.startFreq, 20)), Math.max(2, num(p.endFreq, 2000)));
    const h = Array.from(mags, (m) => Math.min(maxH, m * maxH));
    const out = clone(cv), g = ctx2d(out);
    drawProfile(g, p, x, h);
    return out;
  },
  audioWaveform: (cv, p, x) => {
    const src = typeof p.audio === 'string' && p.audio ? x.audio?.(p.audio) : null;
    if (!src) return cv;
    const n = Math.max(2, Math.round(num(p.samples, 120))), maxH = (num(p.maxHeight, 120) * x.res), ms = num(p.duration, 125);
    const { data, rate } = src.pcm, a = Math.round((src.time + num(p.offset) / 1000) * rate - (rate * ms) / 2000), span = (rate * ms) / 1000;
    const h: number[] = [];
    for (let i = 0; i < n; i++) { const k = Math.round(a + (span * i) / (n - 1)); h.push((k >= 0 && k < data.length ? data[k] : 0) * maxH); }
    const out = clone(cv), g = ctx2d(out);
    drawProfile(g, { ...p, side: 'b' }, x, h);
    return out;
  },
  keylight: (cv, p, x) => {
    // screen-difference keyer (the idea behind Keylight): how much the screen channel exceeds a balance of the other
    // two, relative to the same measure on the screen colour; then the matte tools and despill
    const W = cv.width, H = cv.height, sc = parseColor(String(p.screen ?? '#00b140')).slice(0, 3), [k, o1, o2] = screenChannels(sc);
    const bal = num(p.balance, 50) / 100, gain = num(p.gain, 100) / 100;
    const ref = sc[k] - (sc[o1] * bal + sc[o2] * (1 - bal));
    // Keylight's default screen colour is black: a screen with no dominant channel keys nothing
    if (ref <= 1e-3) return cv;
    const pre = num(p.preBlur) * x.res;
    const src = imgData(pre > 0.3 ? blurCanvas(cv, pre / 2) : cv).data;
    // Tuning: the screen gain scaled by shadow / midtone / highlight gains around «mid tones at»
    const mp = Math.max(0.01, Math.min(0.99, num(p.midPoint, 0.5))), lg = num(p.lowGain, 1), mg = num(p.midGain, 1), hg = num(p.highGain, 1);
    let a: Float32Array = new Float32Array(W * H);
    for (let i = 0; i < a.length; i++) {
      const j = i * 4, diff = (src[j + k] - (src[j + o1] * bal + src[j + o2] * (1 - bal))) / 255;
      const L = (0.299 * src[j] + 0.587 * src[j + 1] + 0.114 * src[j + 2]) / 255, tg = L < mp ? lg + (mg - lg) * (L / mp) : mg + (hg - mg) * ((L - mp) / (1 - mp));
      a[i] = Math.max(0, Math.min(1, 1 - (diff / ref) * gain * tg)) * (src[j + 3] / 255);
    }
    // clip black / white with rollback, shrink / grow, softness, despot
    const cb = num(p.clipBlack) / 100, cw = Math.max(cb + 0.001, num(p.clipWhite, 100) / 100), rb = num(p.clipRollback) / 100;
    for (let i = 0; i < a.length; i++) { const v = (a[i] - cb) / (cw - cb); a[i] = Math.max(0, Math.min(1, rb ? v * (1 - rb) + a[i] * rb : v)); }
    if (num(p.despotBlack)) { const r = num(p.despotBlack) * x.res; a = morph(morph(a, W, H, r), W, H, -r); }
    if (num(p.despotWhite)) { const r = num(p.despotWhite) * x.res; a = morph(morph(a, W, H, -r), W, H, r); }
    if (num(p.shrinkGrow)) a = morph(a, W, H, num(p.shrinkGrow) * x.res);
    if (num(p.softness)) a = blurMap(a, W, H, (num(p.softness) * x.res) / 2);
    const view = String(p.view ?? 'final');
    if (view === 'matte') return setAlpha(cv, a, true);
    if (view === 'status') return pixels(cv, (d) => { for (let i = 0; i < a.length; i++) { const v = a[i] > 0.98 ? 255 : a[i] < 0.02 ? 0 : 128; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; } });
    // despill: the screen channel may not exceed the balance of the other two
    const ds = num(p.despill, 100) / 100;
    return pixels(cv, (d) => { for (let i = 0; i < a.length; i++) { const j = i * 4, lim = d[j + o1] * bal + d[j + o2] * (1 - bal); if (d[j + k] > lim) d[j + k] -= (d[j + k] - lim) * ds; d[j + 3] = a[i] * 255; } });
  },
  keyCleaner: (cv, p, x) => {
    // refines the soft edge of a key: inside a band of `edgeRadius` around the edge the alpha is rebuilt smooth and,
    // with contrast, pushed towards opaque / clear; strength mixes it with the original
    const W = cv.width, H = cv.height, a = alphaOf(cv), r = num(p.edgeRadius, 10) * x.res, s = num(p.strength, 100) / 100, c = num(p.alphaContrast) / 100;
    const band = morph(a, W, H, r), core = morph(a, W, H, -r);
    let sm = blurMap(a, W, H, Math.max(0.5, r / 3));
    if (num(p.reduceChatter)) sm = blurMap(sm, W, H, Math.max(0.5, r / 4));
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const edge = band[i] - core[i] > 0.01;
      let v = edge ? sm[i] : a[i];
      if (edge && c) v = Math.max(0, Math.min(1, (v - 0.5) * (1 + c * 4) + 0.5));
      out[i] = a[i] * (1 - s) + v * s;
    }
    return setAlpha(cv, out);
  },
  spillSuppressor: (cv, p) => {
    const sc = parseColor(String(p.keyColor ?? '#00ff00')).slice(0, 3), [k, o1, o2] = screenChannels(sc), sup = num(p.suppression, 100) / 100;
    const ultra = p.method === 'ultra', tol = num(p.tolerance, 50) / 100, des = num(p.desaturate, 50) / 100, range = num(p.spillRange, 50) / 100, lumaC = num(p.lumaCorrection, 50) / 100;
    return pixels(cv, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        // standard: the key channel is limited to the mean of the other two; ultra: also by how close the hue is
        const lim = (d[i + o1] + d[i + o2]) / 2 + (ultra ? range * 30 * (1 - tol) : 0), ex = d[i + k] - lim;
        if (ex <= 0) continue;
        const L0 = lum(d[i], d[i + 1], d[i + 2]);
        d[i + k] -= ex * sup;
        if (ultra && des) { const m = (d[i] + d[i + 1] + d[i + 2]) / 3; for (let c = 0; c < 3; c++) d[i + c] += (m - d[i + c]) * des * sup * Math.min(1, ex / 80); }
        if (ultra && lumaC) { const L1 = lum(d[i], d[i + 1], d[i + 2]) || 1, f = 1 + (L0 / L1 - 1) * lumaC; for (let c = 0; c < 3; c++) d[i + c] *= f; }
      }
    });
  },
  simpleChoker: (cv, p, x) => {
    // positive chokes (shrinks) the matte by that many px, negative spreads it
    const a = morph(alphaOf(cv), cv.width, cv.height, -num(p.choke) * x.res);
    return setAlpha(cv, a, p.view === 'matte');
  },
  matteChoker: (cv, p, x) => {
    // each pass: blur the matte (geometric softness), then a threshold set by the choke, softened by the grey level
    const W = cv.width, H = cv.height;
    let a = alphaOf(cv);
    const pass = (soft: number, choke: number, gray: number) => {
      const b = blurMap(a, W, H, (soft * x.res) / 2), t = 0.5 + choke / 254, w = Math.max(0.002, gray / 2);
      for (let i = 0; i < a.length; i++) a[i] = Math.max(0, Math.min(1, (b[i] - t) / w + 0.5));
    };
    for (let it = 0; it < Math.max(1, Math.round(num(p.iterations, 1))); it++) {
      pass(num(p.soft1, 4), num(p.choke1, 75), num(p.gray1, 10) / 100);
      if (num(p.soft2) || num(p.choke2) || num(p.gray2, 100) !== 100) pass(num(p.soft2), num(p.choke2), num(p.gray2, 100) / 100);
    }
    return setAlpha(cv, a);
  },
  colorKey: (cv, p, x) => {
    // After Effects' Color Key: pixels within the tolerance of the key colour (per channel) are keyed out, then the
    // matte edge is thinned and feathered. Old projects without edgeFeather keep their soft colour ramp («softness»)
    const k = parseColor(String(p.color ?? '#0000ff')).map((v) => v * 255), tol = num(p.tolerance), old = p.edgeFeather === undefined && p.softness !== undefined, soft = Math.max(0.001, num(p.softness));
    const d = imgData(cv).data, a = new Float32Array(cv.width * cv.height);
    for (let i = 0; i < a.length; i++) {
      const o = i * 4, dist = old ? Math.hypot(d[o] - k[0], d[o + 1] - k[1], d[o + 2] - k[2]) : Math.max(Math.abs(d[o] - k[0]), Math.abs(d[o + 1] - k[1]), Math.abs(d[o + 2] - k[2]));
      a[i] = (d[o + 3] / 255) * (old ? Math.max(0, Math.min(1, (dist - tol) / soft)) : dist <= tol ? 0 : 1);
    }
    return setAlpha(cv, keyEdges(cv, a, num(p.edgeThin), num(p.edgeFeather), x.res));
  },
  lumaKey: (cv, p, x) => {
    // After Effects' Luma Key: brighter / darker than the threshold, or (not) within the tolerance of it; old projects
    // (dark / light with «softness») keep their ramp
    const th = num(p.threshold), tol = num(p.tolerance), type = String(p.type ?? 'dark'), old = p.edgeFeather === undefined && p.softness !== undefined, soft = Math.max(0.001, num(p.softness));
    const d = imgData(cv).data, a = new Float32Array(cv.width * cv.height);
    for (let i = 0; i < a.length; i++) {
      const o = i * 4, L = lum(d[o], d[o + 1], d[o + 2]);
      let keep: number;
      if (old) keep = Math.max(0, Math.min(1, (type === 'light' ? th - L : L - th) / soft));
      else keep = type === 'light' ? +(L <= th) : type === 'similar' ? +(Math.abs(L - th) > tol) : type === 'dissimilar' ? +(Math.abs(L - th) <= tol) : +(L >= th);
      a[i] = (d[o + 3] / 255) * keep;
    }
    return setAlpha(cv, keyEdges(cv, a, num(p.edgeThin), num(p.edgeFeather), x.res));
  },
  // Twirl: the radius is a share of the layer's diagonal like After Effects (old projects: 'radius' in px)
  twirl: (cv, p, x) => W8().run(cv, 0, [rad(num(p.angle)), p.twirlRadius === undefined && p.radius !== undefined ? num(p.radius) * x.res : (num(p.twirlRadius, 30) / 100) * Math.hypot(cv.width, cv.height), 0, 0], pt(p.center, x), 0),
  // Bulge: an ellipse of both radii; Taper Radius softens the edge, Pin All Edges keeps the layer's border still
  bulge: (cv, p, x) => {
    const old = p.hRadius === undefined && p.radius !== undefined, hr = num(old ? p.radius : p.hRadius, 50) * x.res, vr = num(old ? p.radius : p.vRadius, 50) * x.res;
    return W8().run(cv, 1, [hr, vr, num(p.height, 1), num(p.taper) * x.res / Math.max(1, hr, vr)], pt(p.center, x), 0, [num(p.pin), 0, 0, 0]);
  },
  // Ripple: radius as a share of the diagonal and the wave height in quarters of a pixel, like After Effects
  // (projects saved before: 'radius' and the amplitude in px)
  ripple: (cv, p, x) => {
    const old = p.rippleRadius === undefined && p.radius !== undefined;
    const R = old ? num(p.radius) * x.res : (num(p.rippleRadius) / 100) * Math.hypot(cv.width, cv.height);
    return W8().run(cv, 2, [R, Math.max(1, num(p.wavelength, 20) * x.res), num(p.amplitude, 20) * (old ? 1 : 0.25) * x.res, 0], pt(p.center, x), x.t * num(p.speed, 1) * Math.PI * 2 - rad(num(p.phase)), [old || p.conversion === 'symmetric' ? 1 : 0, 0, 0, 0]);
  },
  // Turbulent Displace: fractal noise pushes the pixels (nine kinds, pinned edges, an evolution that can loop)
  turbulentDisplace: (cv, p, x) => {
    const KINDS = ['turbulent', 'bulge', 'twist', 'turbulentSmooth', 'bulgeSmooth', 'twistSmooth', 'vertical', 'horizontal', 'cross'];
    const PINS = ['none', 'all', 'horizontal', 'vertical', 'left', 'right', 'top', 'bottom'];
    const kind = Math.max(0, KINDS.indexOf(String(p.kind ?? 'turbulent'))), pin = Math.max(0, PINS.indexOf(String(p.pinning ?? 'none').replace('Locked', '')));
    // Offset (Turbulence) moves the noise; at the layer's centre (its default, and in old projects that lack it) it stays put
    let off: [number, number] = [0, 0];
    if (p.offset !== undefined) { const [ox, oy] = pt(p.offset, x); off = [ox - cv.width / 2, oy - cv.height / 2]; }
    return W8().run(cv, 3, [num(p.amount, 50) * x.res, Math.max(1, num(p.size, 100) * x.res), Math.max(1, Math.min(10, num(p.complexity, 1))), kind], off, num(p.evolution) / 90, [pin, num(p.cycle) ? Math.max(1, num(p.cycleRevs, 1)) : 0, num(p.seed), 0]);
  },
  // handled by the layer renderer (they need other times) or by expressions
  echo: (cv) => cv,
  posterizeTime: (cv) => cv,
  slider: (cv) => cv, angleCtrl: (cv) => cv, checkboxCtrl: (cv) => cv, colorCtrl: (cv) => cv, pointCtrl: (cv) => cv,
  cornerPin: (cv) => cv, // drawn with WebGL by the renderer
};
// effects added by category (fx-groups/*.ts)
Object.assign(FX_IMPL, IMPL_DESENFOQUE, IMPL_COLOR, IMPL_DISTORSION, IMPL_ESTILIZAR);
Object.assign(FX_IMPL, IMPL_LENTE);
Object.assign(FX_IMPL, IMPL_PARTICULAS);
Object.assign(FX_IMPL, IMPL_CANAL3D);
Object.assign(FX_IMPL, IMPL_TIEMPO);

/** Advanced lightning: a jagged bolt (midpoint displacement) with forks, drawn with a soft glow and a bright core. */
function lightning(cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const out = clone(cv);
  const g = ctx2d(out);
  const [ax, ay] = pt(p.origin, x), [bx, by] = pt(p.end, x);
  const depth = Math.max(1, Math.min(9, Math.round(num(p.segments, 6))));
  const jag = num(p.jag, 22) / 100, branching = num(p.branching, 35) / 100, branchLen = num(p.branchLength, 45) / 100;
  const flick = Math.max(0, num(p.flicker, 12));
  const step = Math.floor(flick > 0 ? x.t * flick : 0) + Math.floor(num(p.evolution) / 360 * 97);
  const rand = (() => { let s = hash2(hash2(num(p.seed, 1), x.seed), step) || 1; return () => { s = (s + 0x6d2b79f5) >>> 0; let q = s; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; }; })();
  type Bolt = { pts: number[]; w: number };
  const bolts: Bolt[] = [];
  const build = (x0: number, y0: number, x1: number, y1: number, lvl: number, w: number, gen: number) => {
    let pts = [x0, y0, x1, y1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    let dev = len * jag;
    for (let d = 0; d < lvl; d++) {
      const nx: number[] = [];
      for (let i = 0; i + 2 < pts.length; i += 2) {
        const sx = pts[i], sy = pts[i + 1], ex = pts[i + 2], ey = pts[i + 3];
        const dx = ex - sx, dy = ey - sy, L = Math.hypot(dx, dy) || 1;
        const o = (rand() * 2 - 1) * dev;
        nx.push(sx, sy, (sx + ex) / 2 + (-dy / L) * o, (sy + ey) / 2 + (dx / L) * o);
      }
      nx.push(pts[pts.length - 2], pts[pts.length - 1]);
      pts = nx;
      dev *= 0.55;
    }
    bolts.push({ pts, w });
    if (gen >= 2) return;
    // forks leave from random vertices, roughly in the bolt's direction
    const n = pts.length / 2;
    for (let i = 1; i < n - 1; i++) {
      if (rand() > branching / Math.max(1, n / 8)) continue;
      const px = pts[i * 2], py = pts[i * 2 + 1];
      const ang = Math.atan2(y1 - y0, x1 - x0) + (rand() * 2 - 1) * 0.9;
      const bl = len * branchLen * (0.4 + rand() * 0.6) * (1 - i / n);
      build(px, py, px + Math.cos(ang) * bl, py + Math.sin(ang) * bl, Math.max(1, lvl - 1), w * 0.55, gen + 1);
    }
  };
  const w0 = Math.max(0.2, num(p.width, 3)) * x.res;
  build(ax, ay, bx, by, depth, w0, 0);
  const taper = !!num(p.taper, 1), op = num(p.opacity, 100) / 100;
  const strokeBolt = (b: Bolt, wMul: number) => {
    const n = b.pts.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const k = taper ? 1 - (i / n) * 0.7 : 1;
      g.lineWidth = Math.max(0.3, b.w * wMul * k);
      g.beginPath();
      g.moveTo(b.pts[i * 2], b.pts[i * 2 + 1]);
      g.lineTo(b.pts[i * 2 + 2], b.pts[i * 2 + 3]);
      g.stroke();
    }
  };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.globalCompositeOperation = 'lighter';
  const gr = num(p.glowRadius, 18) * x.res, go = (num(p.glowOpacity, 80) / 100) * op;
  if (gr > 0 && go > 0) {
    // the glow is the bolt drawn wide on a small canvas and blurred
    const ks = 0.25;
    const sm = mk(out.width * ks, out.height * ks);
    const sg = ctx2d(sm);
    sg.scale(ks, ks);
    sg.strokeStyle = rgba(p.glowColor, 1);
    sg.lineCap = 'round';
    for (const b of bolts) { sg.lineWidth = b.w * 2.5 + gr * 0.3; sg.beginPath(); for (let i = 0; i < b.pts.length; i += 2) sg[i ? 'lineTo' : 'moveTo'](b.pts[i], b.pts[i + 1]); sg.stroke(); }
    const bl = blurCanvas(sm, gr * ks * 0.5);
    g.globalAlpha = go;
    g.drawImage(bl, 0, 0, out.width, out.height);
    g.globalAlpha = go * 0.6;
    g.drawImage(blurCanvas(sm, gr * ks * 0.15), 0, 0, out.width, out.height);
  }
  g.globalAlpha = op;
  g.strokeStyle = rgba(p.glowColor, 1);
  for (const b of bolts) strokeBolt(b, 2.2);
  g.strokeStyle = rgba(p.core, 1);
  for (const b of bolts) strokeBolt(b, 1);
  return out;
}

/** Cell pattern (Worley noise): bubbles = distance to the nearest point, cracks = thin borders (F2 − F1), plates = flat cells. */

function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
export { fbm };

/** Extra pixels an effect stack may draw outside the layer bounds (layer px). size = the content's larger side,
 *  for effects that grow with it (light rays scale the layer up from their centre). */
export function fxGrowth(effects: { fx: string; on?: boolean; p: Params }[], size = 0): number {
  let g = 0;
  for (const { fx, on, p } of effects) {
    if (on === false) continue;
    if (fx === 'gaussianBlur' && !num(p.repeat)) g += num(p.amount) * 1.6;
    else if (fx === 'directionalBlur') g += num(p.length) / 2;
    else if (fx === 'glow') g += num(p.radius, 10) * 0.6 + 4;
    else if (fx === 'dropShadow') g += num(p.distance, 10) + num(p.softness, 10) * 1.6;
    else if (fx === 'outline') g += num(p.width, 6) + 2;
    else if (fx === 'rimLight') g += num(p.halo) * 1.6;
    else if (fx === 'compoundBlur') g += num(p.max, 20) * 1.6;
    else if (fx === 'displacementMap' && num(p.expand, 1)) g += Math.max(Math.abs(num(p.hMax, 5)), Math.abs(num(p.vMax, 5)));
    else if (fx === 'lightRays') g += (num(p.length, 30) / 100) * (size + g * 2);
    else if (fx === 'radialBlur') g += num(p.amount) * 2;
    else if (fx === 'gooey') g += num(p.radius, 12) * 0.5;
    else if (fx === 'ccRepeTile') g += Math.max(num(p.right), num(p.left), num(p.down), num(p.up));
    else if (fx === 'radialShadow' && num(p.resize)) g += (num(p.distance, 10) / 100) * size + num(p.softness) * 1.6;
    else if (fx === 'growBounds') g += Math.max(0, num(p.pixels, 10));
    else g += lenteGrowth(fx, p);
  }
  return Math.ceil(g);
}

/** Runs an effect: the GPU (SVG filter) version when there is one, else the canvas/pixel implementation. */
export function runFx(fx: string, cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const f = colorFilter(fx, p);
  if (f) {
    const out = mk(cv.width, cv.height);
    const g = ctx2d(out);
    g.filter = f;
    g.drawImage(cv, 0, 0);
    return out;
  }
  const fn = FX_IMPL[fx];
  return fn ? fn(cv, p, x) : cv;
}
import { IMPL_GENERAR } from './fx-groups/generar'; Object.assign(FX_IMPL, IMPL_GENERAR);
