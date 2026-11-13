// Property evaluation: keyframes with temporal bezier easing, curved motion paths (auto-bezier, arc-length
// parametrised) and After Effects-style expressions. Deterministic: every "random" thing is seeded.
import type { Comp, Key, Layer, Prop, PVal } from './model';
import { FX } from './effects';
import { footageApi } from './data';

// ───────────────────────── colours ─────────────────────────
export type RGBA = [number, number, number, number];
export function parseColor(c: string): RGBA {
  let s = (c || '#000000').trim();
  if (/^#[0-9a-f]{3}$/i.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (!m) {
    const r = /rgba?\(([^)]+)\)/i.exec(s);
    if (r) { const p = r[1].split(',').map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1]; }
    return [0, 0, 0, 1];
  }
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}
const hx = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
export function colorStr(c: RGBA | number[]): string {
  return `#${hx(c[0])}${hx(c[1])}${hx(c[2])}${(c[3] ?? 1) < 0.999 ? hx(c[3] ?? 1) : ''}`;
}
export const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);

// ───────────────────────── maths helpers ─────────────────────────
function lerpVal(a: PVal, b: PVal, p: number): PVal {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) { const x = a[i] ?? b[i] ?? 0, y = b[i] ?? a[i] ?? 0; out[i] = x + (y - x) * p; }
    return out;
  }
  if (isColor(a) && isColor(b)) {
    const x = parseColor(a), y = parseColor(b);
    return colorStr([x[0] + (y[0] - x[0]) * p, x[1] + (y[1] - x[1]) * p, x[2] + (y[2] - x[2]) * p, x[3] + (y[3] - x[3]) * p]);
  }
  return p < 1 ? a : b; // text: hold
}

/** Cubic bezier ease through (0,0) (x1,y1) (x2,y2) (1,1): returns y for x = u. */
export function bezierEase(u: number, x1: number, y1: number, x2: number, y2: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  let s = u;
  for (let i = 0; i < 8; i++) {
    const e = X(s) - u;
    if (Math.abs(e) < 1e-6) break;
    const d = dX(s);
    if (Math.abs(d) < 1e-6) break;
    s -= e / d;
  }
  if (s < 0 || s > 1 || Math.abs(X(s) - u) > 1e-4) { // bisection fallback
    let lo = 0, hi = 1;
    s = u;
    for (let i = 0; i < 40; i++) { const x = X(s); if (Math.abs(x - u) < 1e-6) break; if (x < u) lo = s; else hi = s; s = (lo + hi) / 2; }
  }
  return ((ay * s + by) * s + cy) * s;
}

export const LINEAR_OUT: [number, number] = [1 / 3, 1 / 3];
export const LINEAR_IN: [number, number] = [2 / 3, 2 / 3];
/** After Effects' Easy Ease (influence 33 %, speed 0). */
export const EASE_OUT: [number, number] = [0.333, 0];
export const EASE_IN: [number, number] = [0.667, 1];

export function segmentProgress(k0: Key, k1: Key, t: number): number {
  const u = (t - k0.t) / (k1.t - k0.t || 1);
  const i = k0.i ?? 'linear';
  if (i === 'hold') return 0;
  const o = k0.eo ?? (i === 'linear' ? LINEAR_OUT : EASE_OUT);
  const n = k1.ei ?? (i === 'linear' ? LINEAR_IN : EASE_IN);
  if (i === 'linear' && !k0.eo && !k1.ei) return u;
  return bezierEase(u, o[0], o[1], n[0], n[1]);
}

// ───────────────────────── spatial (motion paths) ─────────────────────────
function sub(a: number[], b: number[]) { return a.map((x, i) => x - (b[i] ?? 0)); }
function addS(a: number[], b: number[], s = 1) { return a.map((x, i) => x + (b[i] ?? 0) * s); }
function tangent(keys: Key[], i: number): number[] {
  const v = keys[i].v as number[];
  const prev = keys[i - 1]?.v as number[] | undefined, next = keys[i + 1]?.v as number[] | undefined;
  if (prev && next) return sub(next, prev).map((x) => x / 2);
  if (next) return sub(next, v);
  if (prev) return sub(v, prev);
  return v.map(() => 0);
}
function hermite(p0: number[], m0: number[], p1: number[], m1: number[], s: number): number[] {
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  return p0.map((_, d) => h00 * p0[d] + h10 * (m0[d] ?? 0) + h01 * (p1[d] ?? 0) + h11 * (m1[d] ?? 0));
}
/** Point at fraction p of the arc length of the curved segment k0→k1. */
function spatialPoint(keys: Key[], i: number, p: number): number[] {
  const k0 = keys[i], k1 = keys[i + 1];
  const p0 = k0.v as number[], p1 = k1.v as number[];
  if (k0.sl || k1.sl || keys.length < 3) return lerpVal(p0, p1, p) as number[];
  const m0 = tangent(keys, i), m1 = tangent(keys, i + 1);
  if (p <= 0 || p >= 1) return addS(p0, sub(p1, p0), p); // overshoot: extrapolate straight
  const N = 24;
  const pts: number[][] = [];
  const len: number[] = [0];
  for (let j = 0; j <= N; j++) pts.push(hermite(p0, m0, p1, m1, j / N));
  for (let j = 1; j <= N; j++) len.push(len[j - 1] + Math.hypot(...sub(pts[j], pts[j - 1])));
  const total = len[N];
  if (total < 1e-9) return p0.slice();
  const target = p * total;
  let j = 1;
  while (j < N && len[j] < target) j++;
  const f = (target - len[j - 1]) / (len[j] - len[j - 1] || 1);
  return hermite(p0, m0, p1, m1, (j - 1 + f) / N);
}

/** Length of the motion path of the segment i → i+1 (the same polyline spatialPoint walks). */
export function segmentLength(keys: Key[], i: number): number {
  const k0 = keys[i], k1 = keys[i + 1];
  const p0 = k0.v as number[], p1 = k1.v as number[];
  if (k0.sl || k1.sl || keys.length < 3) return Math.hypot(...sub(p1, p0));
  const m0 = tangent(keys, i), m1 = tangent(keys, i + 1);
  let len = 0, prev = p0;
  for (let j = 1; j <= 24; j++) { const q = hermite(p0, m0, p1, m1, j / 24); len += Math.hypot(...sub(q, prev)); prev = q; }
  return len;
}

/** Keyframed value (no expression). */
export function keyedAt(prop: Prop, t: number, spatial = false): PVal {
  const k = prop.k;
  if (!k || !k.length) return prop.v;
  if (k.length === 1 || t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < k.length - 2 && t >= k[i + 1].t) i++;
  const k0 = k[i], k1 = k[i + 1];
  const p = segmentProgress(k0, k1, t);
  if ((k0.i ?? 'linear') === 'hold') return k0.v;
  if (spatial && Array.isArray(k0.v) && Array.isArray(k1.v)) return spatialPoint(k, i, p);
  return lerpVal(k0.v, k1.v, p);
}

export const isSpatial = (path: string) => /(^|\.)(position|anchor|poi)$/.test(path);

// ───────────────────────── seeded noise / random ─────────────────────────
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
/** uniform [0,1) */
export const rnd = (seed: number, i: number) => hash2(seed, i) / 4294967296;
/** Smooth 1-D value noise in [-1, 1]. */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const a = rnd(seed, i) * 2 - 1, b = rnd(seed, i + 1) * 2 - 1;
  const s = f * f * f * (f * (f * 6 - 15) + 10);
  return a + (b - a) * s;
}
export function fbm(x: number, seed: number, octaves = 1, mult = 0.5): number {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let o = 0; o < Math.max(1, Math.floor(octaves)); o++) {
    sum += noise1(x * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= mult;
    freq *= 2;
  }
  return sum / (norm || 1);
}
/** Seeded PRNG. */
export function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

// ───────────────────────── expressions ─────────────────────────
export interface Env {
  comp: Comp;
  layer: Layer;
  /** property path inside the layer, e.g. "transform.position" or "effects.<id>.amount" */
  path: string;
  depth?: number;
}

const compiled = new Map<string, (c: object) => unknown>();
function compile(code: string): (c: object) => unknown {
  let f = compiled.get(code);
  if (f) return f;
  try {
    const g = new Function('__c', `with (__c) { return (${code}\n); }`) as (c: object) => unknown;
    f = g;
  } catch {
    const g = new Function('__c', '__code', 'with (__c) { return eval(__code); }') as (c: object, s: string) => unknown;
    f = (c: object) => g(c, code);
  }
  compiled.set(code, f);
  return f;
}

/** Last expression error per layer/property (shown in the UI and returned by the MCP). */
export const exprErrors = new Map<string, string>();

const arr = (v: PVal): number[] => (Array.isArray(v) ? v : typeof v === 'number' ? [v] : []);
function ar(op: (x: number, y: number) => number) {
  return (a: number | number[], b: number | number[]) => {
    if (typeof a === 'number' && typeof b === 'number') return op(a, b);
    const A = typeof a === 'number' ? null : a, B = typeof b === 'number' ? null : b;
    const n = Math.max(A?.length ?? 0, B?.length ?? 0);
    return Array.from({ length: n }, (_, i) => op(A ? (A[i] ?? 0) : (a as number), B ? (B[i] ?? 0) : (b as number)));
  };
}
const lerpAny = (a: PVal, b: PVal, p: number) => lerpVal(a, b, p);

function loopTime(k: Key[], t: number, type: string, n: number, out: boolean): { tt: number; cycles: number } | null {
  if (k.length < 2) return null;
  const first = k[0].t, last = k[k.length - 1].t;
  if (out) {
    if (t <= last) return null;
    const a = n > 0 ? k[Math.max(0, k.length - 1 - n)].t : first;
    const d = last - a;
    if (d <= 0) return null;
    const cycles = Math.floor((t - a) / d);
    let tt = a + ((t - a) % d);
    if (type === 'pingpong' && cycles % 2 === 1) tt = last - (tt - a);
    return { tt, cycles };
  }
  if (t >= first) return null;
  const b = n > 0 ? k[Math.min(k.length - 1, n)].t : last;
  const d = b - first;
  if (d <= 0) return null;
  const cycles = Math.floor((first - t) / d) + 1;
  let tt = b - ((first - t) % d);
  if (type === 'pingpong' && cycles % 2 === 1) tt = first + (b - tt);
  return { tt, cycles };
}

export interface LayerApi { [k: string]: unknown }

/** Value of a property at comp time t, with its expression. */
export function valueAt(prop: Prop | undefined, t: number, env: Env): PVal {
  if (!prop) return 0;
  // Separate Dimensions: Position is X / Y / Z, each with its own keys and expression
  const tr = env.layer.transform;
  if (tr?.positionX && prop === tr.position && env.path === 'transform.position') {
    const d = (p: Prop | undefined, n: string) => Number(valueAt(p, t, { ...env, path: `transform.position${n}` })) || 0;
    return [d(tr.positionX, 'X'), d(tr.positionY, 'Y'), d(tr.positionZ, 'Z')];
  }
  const spatial = isSpatial(env.path);
  const base = keyedAt(prop, t, spatial);
  if (!prop.x || prop.xOff) return base;
  if ((env.depth ?? 0) > 6) return base;
  const id = `${env.layer.id}|${env.path}`;
  try {
    const r = runExpr(prop, t, env, base);
    exprErrors.delete(id);
    return normalise(r, base);
  } catch (e) {
    exprErrors.set(id, String((e as Error).message ?? e));
    return base;
  }
}

function normalise(r: unknown, base: PVal): PVal {
  if (typeof base === 'number') {
    if (Array.isArray(r)) return Number(r[0]) || 0;
    const n = Number(r);
    return Number.isFinite(n) ? n : base;
  }
  if (Array.isArray(base)) {
    if (typeof r === 'number') return [r, ...base.slice(1)];
    if (Array.isArray(r)) return base.map((b, i) => (Number.isFinite(Number(r[i])) ? Number(r[i]) : b));
    return base;
  }
  if (isColor(base)) {
    if (Array.isArray(r)) return colorStr(r as number[]);
    return typeof r === 'string' ? r : base;
  }
  return r === undefined || r === null ? base : String(r);
}

function runExpr(prop: Prop, t0: number, env: Env, base: PVal): unknown {
  const { comp, layer, path } = env;
  const depth = (env.depth ?? 0) + 1;
  const spatial = isSpatial(path);
  let time = t0;
  const seedBase = hashStr(`${layer.id}|${path}`);
  let userSeed = 0, timeless = false, calls = 0;
  const frame = () => Math.round(time * comp.fps);
  const nextRand = () => rnd(hash2(seedBase + userSeed * 7919, timeless ? 0 : frame()), calls++);
  const keyed = (tt: number) => keyedAt(prop, tt, spatial);
  const velocityAt = (tt: number): number | number[] => {
    const h = 1 / (comp.fps * 4);
    const a = keyed(tt - h), b = keyed(tt + h);
    if (typeof a === 'number' && typeof b === 'number') return (b - a) / (2 * h);
    return arr(b).map((x, i) => (x - (arr(a)[i] ?? 0)) / (2 * h));
  };
  const loop = (out: boolean) => (type = 'cycle', n = 0): PVal => {
    const k = prop.k ?? [];
    const lt = loopTime(k, time, type, n, out);
    if (!lt) return keyed(time);
    if (type === 'continue') {
      const edge = out ? k[k.length - 1] : k[0];
      const v = velocityAt(edge.t);
      const dt = time - edge.t;
      return typeof edge.v === 'number' ? edge.v + (v as number) * dt : arr(edge.v).map((x, i) => x + (arr(v as number[])[i] ?? 0) * dt);
    }
    const v = keyed(lt.tt);
    if (type === 'offset') {
      const a = out ? (n > 0 ? k[Math.max(0, k.length - 1 - n)].v : k[0].v) : k[0].v;
      const b = out ? k[k.length - 1].v : (n > 0 ? k[Math.min(k.length - 1, n)].v : k[k.length - 1].v);
      const delta = typeof a === 'number' ? (b as number) - a : arr(b).map((x, i) => x - (arr(a)[i] ?? 0));
      const c = out ? lt.cycles : -lt.cycles;
      return typeof v === 'number' ? v + (delta as number) * c : arr(v).map((x, i) => x + (arr(delta as number[])[i] ?? 0) * c);
    }
    return v;
  };
  const layerApi = (l: Layer): LayerApi => {
    // vectors get .valueAtTime(t) like After Effects: thisComp.layer('X').transform.position.valueAtTime(time - 0.1)
    const sub = (p: Prop | undefined, pp: string) => {
      const v = valueAt(p, time, { comp, layer: l, path: pp, depth });
      if (!Array.isArray(v)) return v;
      const a = [...v];
      Object.defineProperty(a, 'valueAtTime', { value: (tt: number) => valueAt(p, Number(tt), { comp, layer: l, path: pp, depth: (depth ?? 0) + 1 }), enumerable: false });
      return a;
    };
    const tr = {
      get position() { return sub(l.transform.position, 'transform.position'); },
      get xPosition() { return sub(l.transform.positionX ?? l.transform.position, l.transform.positionX ? 'transform.positionX' : 'transform.position'); },
      get yPosition() { return sub(l.transform.positionY ?? l.transform.position, l.transform.positionY ? 'transform.positionY' : 'transform.position'); },
      get zPosition() { return sub(l.transform.positionZ ?? l.transform.position, l.transform.positionZ ? 'transform.positionZ' : 'transform.position'); },
      get anchorPoint() { return sub(l.transform.anchor, 'transform.anchor'); },
      get scale() { return sub(l.transform.scale, 'transform.scale'); },
      get rotation() { return sub(l.transform.rotation, 'transform.rotation'); },
      get opacity() { return sub(l.transform.opacity, 'transform.opacity'); },
      get xRotation() { return sub(l.transform.rotationX, 'transform.rotationX'); },
      get yRotation() { return sub(l.transform.rotationY, 'transform.rotationY'); },
    };
    const effect = (name: string | number) => {
      const fx = typeof name === 'number' ? l.effects[name - 1] : l.effects.find((f) => f.name === name || f.fx === name || f.id === name);
      if (!fx) throw new Error(`La capa «${l.name}» no tiene el efecto «${name}».`);
      return (param: string | number) => {
        const keys = Object.keys(fx.params);
        // by id, or by the parameter's visible name like After Effects: effect("Control de menú desplegable")("Menú")
        const byName = (q: string) => FX.find((d) => d.id === fx.fx)?.params.find((pd) => pd.name.toLowerCase() === q.toLowerCase() || pd.name.toLowerCase().split(':').pop()!.trim() === q.toLowerCase())?.id;
        const key = typeof param === 'number' ? keys[param - 1] : keys.find((k) => k === param) ?? keys.find((k) => k.toLowerCase() === String(param).toLowerCase()) ?? byName(String(param)) ?? keys[0];
        // Layer Control: the chosen layer itself (thisComp.layer of it); Dropdown Menu Control: the item number
        if (fx.fx === 'layerCtrl' && key === 'value') { const id = String(sub(fx.params.value, `effects.${fx.id}.value`) ?? ''); const ref = comp.layers.find((y) => y.id === id); if (!ref) throw new Error(`«${fx.name}» no tiene ninguna capa elegida.`); return layerApi(ref); }
        if (fx.fx === 'dropdownCtrl' && key === 'value') return Math.max(1, Math.round(Number(sub(fx.params.value, `effects.${fx.id}.value`)) || 1));
        return sub(fx.params[key], `effects.${fx.id}.${key}`);
      };
    };
    const out: LayerApi = {
      transform: tr, effect, name: l.name, index: comp.layers.indexOf(l) + 1,
      inPoint: l.in, outPoint: l.out, startTime: l.start,
      text: { get sourceText() { return sub(l.text?.text, 'text.text'); } },
      get sourceText() { return sub(l.text?.text, 'text.text'); },
    };
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(tr)); // lazy: no eager evaluation (no recursion)
    return out;
  };
  const ctx: Record<string, unknown> = {
    get time() { return time; },
    value: base,
    thisProperty: { get value() { return base; }, valueAtTime: keyed, velocityAtTime: velocityAt, get numKeys() { return prop.k?.length ?? 0; }, key: (i: number) => { const k = prop.k?.[i - 1]; if (!k) throw new Error(`No existe la clave ${i}`); return { time: k.t, value: k.v }; } },
    get numKeys() { return prop.k?.length ?? 0; },
    key: (i: number) => { const k = prop.k?.[i - 1]; if (!k) throw new Error(`No existe la clave ${i}`); return { time: k.t, value: k.v }; },
    nearestKey: (tt: number) => { const ks = prop.k ?? []; let best = 0; ks.forEach((k, i) => { if (Math.abs(k.t - tt) < Math.abs(ks[best].t - tt)) best = i; }); const k = ks[best]; return k ? { time: k.t, value: k.v, index: best + 1 } : { time: 0, value: base, index: 0 }; },
    valueAtTime: keyed,
    velocityAtTime: velocityAt,
    get velocity() { return velocityAt(time); },
    get speed() { const v = velocityAt(time); return typeof v === 'number' ? Math.abs(v) : Math.hypot(...v); },
    wiggle: (freq: number, amp: number, octaves = 1, ampMult = 0.5, tt?: number) => {
      const x = (tt ?? time) * freq;
      if (typeof base === 'number') return base + fbm(x, seedBase, octaves, ampMult) * amp;
      const b = arr(base);
      return b.map((v, d) => v + fbm(x, seedBase + d * 7919, octaves, ampMult) * amp);
    },
    temporalWiggle: (freq: number, amp: number, octaves = 1, ampMult = 0.5) => keyed(time + fbm(time * freq, seedBase, octaves, ampMult) * amp),
    smooth: (width = 0.2, samples = 5) => {
      let acc: number | number[] = 0;
      for (let i = 0; i < samples; i++) {
        const v = keyed(time + (i / (samples - 1 || 1) - 0.5) * width);
        acc = typeof v === 'number' ? (acc as number) + v / samples : arr(v).map((x, d) => (arr(acc as number[])[d] ?? 0) + x / samples);
      }
      return acc;
    },
    loopOut: loop(true),
    loopIn: loop(false),
    loopOutDuration: (type = 'cycle') => loop(true)(type, 0),
    /** inertial bounce after each keyframe (overshoot that settles) */
    inertia: (amp = 0.05, freq = 4, decay = 8) => {
      const ks = prop.k ?? [];
      let n = 0;
      for (let i = ks.length - 1; i >= 0; i--) if (ks[i].t <= time) { n = i + 1; break; }
      if (!n || ks[n - 1].t === time) return keyed(time);
      const kt = ks[n - 1].t;
      const v = velocityAt(kt - 1 / (comp.fps * 10));
      const dt = time - kt;
      const f = Math.sin(freq * dt * 2 * Math.PI) / Math.exp(decay * dt) / (freq * 2 * Math.PI);
      const cur = keyed(time);
      if (typeof cur === 'number') return cur + (v as number) * amp * f * 20;
      return arr(cur).map((x, i) => x + (arr(v as number[])[i] ?? 0) * amp * f * 20);
    },
    linear: (...a: number[] | [number, number, number, PVal, PVal]) => {
      if (a.length === 3) { const [x, v1, v2] = a as unknown as [number, PVal, PVal]; return lerpAny(v1, v2, Math.max(0, Math.min(1, x))); }
      const [x, a0, a1, v1, v2] = a as unknown as [number, number, number, PVal, PVal];
      return lerpAny(v1, v2, Math.max(0, Math.min(1, (x - a0) / (a1 - a0 || 1))));
    },
    ease: (...a: unknown[]) => easeFn(a, (p) => p * p * (3 - 2 * p)),
    easeIn: (...a: unknown[]) => easeFn(a, (p) => p * p * p),
    easeOut: (...a: unknown[]) => easeFn(a, (p) => 1 - (1 - p) ** 3),
    clamp: (v: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v)),
    random: (a?: number | number[], b?: number | number[]) => {
      if (a === undefined) return nextRand();
      if (b === undefined) return typeof a === 'number' ? nextRand() * a : a.map((x) => nextRand() * x);
      return typeof a === 'number' ? (a as number) + nextRand() * ((b as number) - a) : (a as number[]).map((x, i) => x + nextRand() * ((b as number[])[i] - x));
    },
    gaussRandom: (a = 1, b?: number) => { const g = Math.sqrt(-2 * Math.log(nextRand() || 1e-9)) * Math.cos(2 * Math.PI * nextRand()) / 3; return b === undefined ? g * a : a + (g + 0.5) * (b - a); },
    seedRandom: (s: number, tl = false) => { userSeed = s; timeless = tl; calls = 0; },
    noise: (x: number | number[]) => (typeof x === 'number' ? noise1(x, 7) : noise1(x[0] + (x[1] ?? 0) * 17.13 + (x[2] ?? 0) * 31.7, 7)),
    posterizeTime: (fps: number) => { if (fps > 0) time = Math.floor(time * fps + 1e-6) / fps; return time; },
    add: ar((x, y) => x + y), sub: ar((x, y) => x - y), mul: ar((x, y) => x * y), div: ar((x, y) => x / y),
    length: (a: number | number[], b?: number | number[]) => { const A = arr(a as PVal), B = b === undefined ? A.map(() => 0) : arr(b as PVal); return Math.hypot(...A.map((x, i) => x - (B[i] ?? 0))); },
    normalize: (a: number[]) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); },
    degreesToRadians: (d: number) => (d * Math.PI) / 180,
    radiansToDegrees: (r: number) => (r * 180) / Math.PI,
    timeToFrames: (tt = time, fps = comp.fps) => Math.round(tt * fps),
    framesToTime: (f: number, fps = comp.fps) => f / fps,
    hslToRgb: (h: number[]) => hsl2rgb(h),
    rgbToHsl: (c: number[]) => rgb2hsl(c),
    hexToRgb: (s: string) => parseColor(s),
    thisLayer: undefined as unknown,
    thisComp: {
      name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, frameDuration: 1 / comp.fps, numLayers: comp.layers.length,
      layer: (x: string | number) => {
        const l = typeof x === 'number' ? comp.layers[x - 1] : comp.layers.find((y) => y.name === x || y.id === x);
        if (!l) throw new Error(`No existe la capa «${x}».`);
        return layerApi(l);
      },
    },
    index: comp.layers.indexOf(layer) + 1,
    inPoint: layer.in,
    outPoint: layer.out,
    startTime: layer.start,
    name: layer.name,
    Math,
    // data-driven animation: footage("datos.csv").dataValue([1, 0]), footage("x.json").sourceData…
    footage: (n: string) => footageApi(String(n), time, comp.fps),
  };
  const api = layerApi(layer);
  ctx.thisLayer = api;
  for (const k of ['transform', 'effect', 'text', 'sourceText']) if (!(k in ctx)) Object.defineProperty(ctx, k, { get: () => api[k] });
  if (!path.startsWith('transform.')) for (const k of ['position', 'scale', 'rotation', 'opacity', 'anchorPoint']) Object.defineProperty(ctx, k, { get: () => (api as Record<string, unknown>)[k] });
  else for (const k of ['position', 'scale', 'rotation', 'opacity', 'anchorPoint']) {
    const own = { position: 'transform.position', scale: 'transform.scale', rotation: 'transform.rotation', opacity: 'transform.opacity', anchorPoint: 'transform.anchor' }[k];
    Object.defineProperty(ctx, k, { get: () => (own === path ? base : (api as Record<string, unknown>)[k]) });
  }
  const f = compile(prop.x!);
  return f(ctx);
}

function easeFn(a: unknown[], fn: (p: number) => number) {
  if (a.length === 3) { const [x, v1, v2] = a as [number, PVal, PVal]; return lerpVal(v1, v2, fn(Math.max(0, Math.min(1, x)))); }
  const [x, a0, a1, v1, v2] = a as [number, number, number, PVal, PVal];
  return lerpVal(v1, v2, fn(Math.max(0, Math.min(1, (x - a0) / (a1 - a0 || 1)))));
}

export function hsl2rgb([h, s, l, a = 1]: number[]): number[] {
  const f = (n: number) => { const k = (n + h * 12) % 12; const m = s * Math.min(l, 1 - l); return l - m * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4), a];
}
export function rgb2hsl([r, g, b, a = 1]: number[]): number[] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l, a];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l, a];
}

// ───────────────────────── keyframe editing helpers ─────────────────────────
const EPS = 1e-4;
/** Adds or replaces the key at t (keeps keys sorted). */
export function setKey(prop: Prop, t: number, v: PVal, ease?: { i?: Key['i']; eo?: [number, number]; ei?: [number, number] }): Key {
  prop.k ??= [];
  let k = prop.k.find((x) => Math.abs(x.t - t) < EPS);
  if (k) k.v = v;
  else { k = { t, v }; prop.k.push(k); prop.k.sort((a, b) => a.t - b.t); }
  if (ease) {
    if (ease.i) k.i = ease.i;
    if (ease.eo) k.eo = ease.eo;
    if (ease.ei) k.ei = ease.ei;
  }
  return k;
}
/** Easy ease (F9), ease in, ease out, linear, hold or a custom bezier on keys. */
export function easeKeys(keys: Key[], kind: 'easy' | 'in' | 'out' | 'linear' | 'hold' | 'bezier', handles?: { eo?: [number, number]; ei?: [number, number] }) {
  for (const k of keys) {
    if (kind === 'hold') { k.i = 'hold'; continue; }
    if (kind === 'linear') { k.i = 'linear'; delete k.eo; delete k.ei; continue; }
    k.i = 'bezier';
    if (kind === 'easy' || kind === 'in') k.ei = [...EASE_IN];
    if (kind === 'easy' || kind === 'out') k.eo = [...EASE_OUT];
    if (kind === 'in' && !k.eo) k.eo = [...LINEAR_OUT];
    if (kind === 'out' && !k.ei) k.ei = [...LINEAR_IN];
    if (kind === 'bezier' && handles) { if (handles.eo) k.eo = handles.eo; if (handles.ei) k.ei = handles.ei; }
  }
}
