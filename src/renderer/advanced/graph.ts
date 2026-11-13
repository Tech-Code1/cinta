// Graph editor of the advanced mode, like After Effects': value graph and speed graph (Elegir tipo y opciones de
// gráfico: automatic = speed graph for spatial properties), keyframe handles that set speed (vertical) and influence
// (horizontal) — Alt-drag breaks a continuous key —, reference graph, auto-zoom height, fit selection / fit all,
// snap, Separate Dimensions and the interpolation buttons at the bottom (hold, linear, auto-bezier, Easy Ease…).
import { isSpatial, keyedAt } from '../../core/motion/anim';
import type { Comp, Layer, Prop } from '../../core/motion/model';
import { easeKeysAE, isSeparated, keyVelocity, primaryDim, segDeltas, setKeyVelocity, speedIn, velKind, type EaseKind } from '../../core/motion/velocity';
import { contextMenu } from '../player';
import { h, toast } from '../store';
import { adv, mop, propAt } from './state';
import { velocityDialog } from './velodialog';

export const gopt = { type: 'auto' as 'auto' | 'value' | 'speed', ref: true, autoZoom: true, snap: true };
interface TimeMap { t2x: (t: number) => number; x2t: (x: number) => number; fit: (a: number, b: number) => void; redraw: () => void }
let tm: TimeMap;
const BAR = 30;
/** vertical range when auto-zoom height is off (per property and graph type) */
let vr: { key: string; lo: number; hi: number } | null = null;
let last: { lo: number; hi: number; key: string } | null = null;
/** vertical range kept while dragging (auto-zoom would chase the pointer) */
let frozen: { lo: number; hi: number } | null = null;

export const unitOf = (path: string) => /rotation|Rotation|angle|Angle/.test(path) ? '°' : /scale|opacity|Opacity|intensity|roundness|trim\.|amount|Feather|Darkness|ambient|diffuse|specular|metal|Margin/.test(path) ? '%' : /position|Position|anchor|poi|size|Radius|radius|width|feather|expansion|tracking|zoom|focus|Distance|center|start|end|blur/.test(path) ? 'px' : 'unidades';

interface Sel { c: Comp; l: Layer; p: Prop; path: string; spatial: boolean; dims: number; mode: 'value' | 'speed' }
function current(c: Comp): Sel | null {
  const g = adv.graphProp;
  const l = g && c.layers.find((x) => x.id === g.layer);
  const p = l && propAt(l, g!.path);
  if (!l || !p?.k || p.k.length < 2) return null;
  let kind;
  try { kind = velKind(p, isSpatial(g!.path)); } catch { kind = { spatial: false, dims: 0 }; }
  const spatial = kind.spatial;
  const mode = kind.dims === 0 ? 'value' : gopt.type === 'auto' ? (spatial ? 'speed' : 'value') : gopt.type;
  return { c, l, p, path: g!.path, spatial, dims: Array.isArray(p.k[0].v) ? (p.k[0].v as number[]).length : 1, mode };
}
const val = (v: unknown, d: number) => (Array.isArray(v) ? Number(v[d]) : Number(v));
/** dimension the handles are drawn on: the one that changes most over the whole animation */
function mainDim(s: Sel): number {
  if (s.spatial || s.dims === 1) return 0;
  const ks = s.p.k!;
  return primaryDim(Array.from({ length: s.dims }, (_, d) => Math.abs(val(ks[ks.length - 1].v, d) - val(ks[0].v, d)) + ks.reduce((m, k) => Math.max(m, Math.abs(val(k.v, d) - val(ks[0].v, d))), 0)));
}

/** samples of the graph: per curve, [t, y] (speed graph: one-sided at the keys, so jumps show) */
function samples(s: Sel, mode: 'value' | 'speed'): [number, number][][] {
  const ks = s.p.k!, out: [number, number][][] = Array.from({ length: mode === 'speed' && s.spatial ? 1 : s.dims }, () => []);
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i].t, b = ks[i + 1].t, n = 60;
    for (let j = 0; j <= n; j++) {
      const t = a + ((b - a) * j) / n;
      if (mode === 'value') { const v = keyedAt(s.p, Math.min(t, b - 1e-9), s.spatial); out.forEach((c, d) => c.push([t, j === n ? val(ks[i + 1].v, d) : val(v, d)])); }
      else { const v = speedIn(s.p, i, t, s.spatial); out.forEach((c, d) => c.push([t, v[d] ?? 0])); }
    }
  }
  return out;
}
interface Pt { kind: 'key' | 'in' | 'out'; i: number; d: number; x: number; y: number }
/** keys and handles where they are drawn */
function points(s: Sel, vy: (v: number) => number): Pt[] {
  const ks = s.p.k!, d0 = mainDim(s), out: Pt[] = [];
  ks.forEach((k, i) => {
    const prev = ks[i - 1], next = ks[i + 1];
    if (s.mode === 'value') {
      for (let d = 0; d < s.dims; d++) out.push({ kind: 'key', i, d, x: tm.t2x(k.t), y: vy(val(k.v, d)) });
      if (s.spatial) return;
      const kv = keyVelocity(s.p, i, false);
      if (next && kv.out && (k.i === 'bezier' || k.eo || next.ei)) { const f = kv.out.influence / 100; out.push({ kind: 'out', i, d: d0, x: tm.t2x(k.t + f * (next.t - k.t)), y: vy(val(k.v, d0) + kv.out.speed[d0] * f * (next.t - k.t)) }); }
      if (prev && kv.in && ((prev.i ?? 'linear') === 'bezier' || prev.eo || k.ei)) { const f = kv.in.influence / 100; out.push({ kind: 'in', i, d: d0, x: tm.t2x(k.t - f * (k.t - prev.t)), y: vy(val(k.v, d0) - kv.in.speed[d0] * f * (k.t - prev.t)) }); }
    } else {
      const kv = keyVelocity(s.p, i, s.spatial), d = s.spatial ? 0 : d0;
      if (kv.in) { out.push({ kind: 'key', i, d, x: tm.t2x(k.t), y: vy(kv.in.speed[d]) }); out.push({ kind: 'in', i, d, x: tm.t2x(k.t - (kv.in.influence / 100) * (k.t - prev.t)), y: vy(kv.in.speed[d]) }); }
      if (kv.out) { out.push({ kind: 'key', i, d, x: tm.t2x(k.t), y: vy(kv.out.speed[d]) }); out.push({ kind: 'out', i, d, x: tm.t2x(k.t + (kv.out.influence / 100) * (next.t - k.t)), y: vy(kv.out.speed[d]) }); }
      if (!kv.in && !kv.out) out.push({ kind: 'key', i, d, x: tm.t2x(k.t), y: vy(0) });
    }
  });
  return out;
}
function range(curves: [number, number][][], extra: number[] = []): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const c of curves) for (const [, y] of c) if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
  for (const y of extra) if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
  if (!Number.isFinite(lo)) return [-1, 1];
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}
const keyOf = (s: Sel) => `${s.l.id}|${s.path}|${s.mode}`;
let geo: { s: Sel; vy: (v: number) => number; yv: (y: number) => number; pts: Pt[]; H: number } | null = null;

const COLORS = ['#e8455a', '#36c48f', '#1d6cff'];
export function drawGraph(c: Comp, cv: HTMLCanvasElement, W: number, H0: number, map: TimeMap) {
  tm = map;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H0 * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H0 * dpr); }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#15171d';
  g.fillRect(0, 0, W, H0);
  const H = H0 - BAR;
  g.font = '11px Segoe UI';
  g.fillStyle = '#8b92a8';
  const s = current(c);
  updateBar(s);
  if (!s) {
    const gp = adv.graphProp, l = gp && c.layers.find((x) => x.id === gp.layer), p = l && propAt(l, gp!.path);
    g.font = '12px Segoe UI';
    g.fillText(p ? 'Esta propiedad necesita al menos dos fotogramas clave para mostrar su curva.' : 'Haga clic en el nombre de una propiedad animada para ver su gráfico.', 16, 24);
    geo = null; return;
  }
  const main = samples(s, s.mode);
  const key = keyOf(s);
  let lo: number, hi: number;
  if (frozen) ({ lo, hi } = frozen);
  else if (gopt.autoZoom || !vr || vr.key !== key) {
    const extra: number[] = s.mode === 'speed' ? [0] : [];
    // the speed graph keeps 0 in view (its baseline)
    [lo, hi] = range(main, extra);
    if (!gopt.autoZoom) vr = { key, lo, hi };
  } else ({ lo, hi } = vr);
  last = { lo, hi, key };
  const vy = (v: number) => H - 16 - ((v - lo) / (hi - lo)) * (H - 36);
  const yv = (y: number) => lo + ((H - 16 - y) / (H - 36)) * (hi - lo);
  const unit = unitOf(s.path), u = s.mode === 'speed' ? `${unit}/seg` : unit;
  // grid with units
  g.strokeStyle = '#23262f';
  g.lineWidth = 1;
  for (let i = 0; i <= 5; i++) { const y = 20 + ((H - 36) * i) / 5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(`${fmt(yv(y))} ${u}`, 4, y - 2); }
  if (s.mode === 'speed' && lo < 0 && hi > 0) { g.strokeStyle = '#3a3f4d'; g.beginPath(); g.moveTo(0, vy(0)); g.lineTo(W, vy(0)); g.stroke(); }
  // reference graph: the other graph, not editable, on its own scale
  if (gopt.ref) {
    const ref = samples(s, s.mode === 'speed' ? 'value' : 'speed');
    const [rlo, rhi] = range(ref);
    g.globalAlpha = 0.35;
    ref.forEach((cur, d) => { g.strokeStyle = ref.length === 1 ? '#c9ced9' : COLORS[d % 3]; g.setLineDash([4, 3]); g.beginPath(); cur.forEach(([t, y], i) => { const X = tm.t2x(t), Y = H - 16 - ((y - rlo) / (rhi - rlo)) * (H - 36); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }); g.stroke(); });
    g.setLineDash([]);
    g.globalAlpha = 1;
  }
  main.forEach((cur, d) => {
    g.strokeStyle = main.length === 1 ? '#ffd400' : COLORS[d % 3];
    g.lineWidth = 1.5;
    g.beginPath();
    cur.forEach(([t, y], i) => { const X = tm.t2x(t), Y = vy(y); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
    g.stroke();
  });
  // keys and handles
  const pts = points(s, vy);
  const selKey = (i: number) => adv.keys.some((q) => q.layer === s.l.id && q.path === s.path && Math.abs(q.t - s.p.k![i].t) < 1e-4);
  for (const p of pts.filter((q) => q.kind !== 'key')) {
    const k = pts.find((q) => q.kind === 'key' && q.i === p.i && q.d === p.d && (s.mode === 'value' || Math.abs(q.y - p.y) < 0.5));
    g.strokeStyle = '#ffd400'; g.fillStyle = '#ffd400'; g.lineWidth = 1;
    if (k) { g.beginPath(); g.moveTo(k.x, k.y); g.lineTo(p.x, p.y); g.stroke(); }
    g.beginPath(); g.arc(p.x, p.y, 3.5, 0, Math.PI * 2); g.fill();
  }
  for (const p of pts.filter((q) => q.kind === 'key')) {
    const k = s.p.k![p.i];
    g.fillStyle = selKey(p.i) ? '#ffd400' : '#ffffff';
    g.strokeStyle = '#111';
    g.beginPath();
    if (k.i === 'hold') g.rect(p.x - 4, p.y - 4, 8, 8);
    else if (k.ta) g.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    else g.rect(p.x - 3.5, p.y - 3.5, 7, 7);
    g.fill(); g.stroke();
  }
  // playhead
  const px = tm.t2x(adv.time);
  g.strokeStyle = '#e8455a';
  g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, H); g.stroke();
  g.fillStyle = '#c9ced9';
  g.fillText(`${s.l.name} › ${s.path} · ${s.mode === 'speed' ? 'Gráfico de velocidad' : 'Gráfico de valores'}${s.spatial && s.mode === 'speed' ? ' (a lo largo del trazado)' : ''}`, 160, 13);
  geo = { s, vy, yv, pts, H };
}
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// ───────────────────────── pointer ─────────────────────────
/** the working copy's property of the graph */
const workProp = (s: Sel) => { const w = adv.begin()!; const wl = w.layers.find((x) => x.id === s.l.id)!; return { w, wl, wp: propAt(wl, s.path)! }; };

export function graphEvents(cv: HTMLCanvasElement) {
  cv.addEventListener('pointerdown', (e) => {
    const c = adv.comp();
    if (!c || !geo || e.button !== 0) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { s, yv } = geo;
    const hit = [...geo.pts].reverse().filter((p) => p.kind !== 'key').find((p) => Math.hypot(p.x - x, p.y - y) < 7) ?? geo.pts.find((p) => Math.hypot(p.x - x, p.y - y) < 7);
    if (!hit) { if (!e.shiftKey) { adv.keys = []; adv.emit('keys'); } return; }
    const k0 = s.p.k![hit.i];
    // selection
    const isSel = adv.keys.some((q) => q.layer === s.l.id && q.path === s.path && Math.abs(q.t - k0.t) < 1e-4);
    if (hit.kind === 'key') {
      if (e.shiftKey) { if (isSel) adv.keys = adv.keys.filter((q) => !(q.layer === s.l.id && q.path === s.path && Math.abs(q.t - k0.t) < 1e-4)); else adv.keys.push({ layer: s.l.id, path: s.path, t: k0.t }); }
      else if (!isSel) adv.keys = [{ layer: s.l.id, path: s.path, t: k0.t }];
    } else if (!isSel) adv.keys = [{ layer: s.l.id, path: s.path, t: k0.t }];
    tm.redraw();
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const alt = e.altKey;
    frozen = last ? { lo: last.lo, hi: last.hi } : null;
    const t0 = k0.t, v0 = k0.v;
    let moved = false;
    const others = (s.p.k ?? []).map((k) => k.t);
    const mv = (ev: PointerEvent) => {
      const X = ev.clientX - r.left, Y = ev.clientY - r.top;
      if (!moved && Math.hypot(X - x, Y - y) < 3) return;
      moved = true;
      const { wp } = workProp(s);
      const ks = wp.k!;
      const k = ks[hit.i];
      if (hit.kind === 'key') {
        // time (on frames; Snap: to the playhead and the other keys) and, in the value graph, the value
        let t = Math.round(tm.x2t(X) * c.fps) / c.fps;
        if (gopt.snap) for (const st of [adv.time, ...others.filter((q) => Math.abs(q - t0) > 1e-6)]) if (Math.abs(tm.t2x(st) - X) < 8) t = st;
        const lo = ks[hit.i - 1]?.t ?? -Infinity, hi = ks[hit.i + 1]?.t ?? Infinity;
        k.t = Math.max(0, Math.min(hi - 1 / c.fps, Math.max(lo + 1 / c.fps, t)));
        if (s.mode === 'value' && !s.spatial) {
          let nv = yv(Y);
          if (gopt.snap) for (const q of ks) if (q !== k && Math.abs(geo!.vy(val(q.v, hit.d)) - Y) < 6) nv = val(q.v, hit.d);
          if (Array.isArray(v0)) { const a = [...v0]; a[hit.d] = nv; k.v = a; } else if (typeof v0 === 'number') k.v = nv;
        }
        adv.keys = adv.keys.map((q) => (q.layer === s.l.id && q.path === s.path && Math.abs(q.t - t0) < 1e-4 ? { ...q, t: k.t } : q));
      } else {
        if (alt) delete k.tc; // Alt-drag breaks a continuous key
        const sp = s.spatial && s.mode === 'speed';
        const i0 = hit.kind === 'out' ? hit.i : hit.i - 1, a = ks[i0], b = ks[i0 + 1];
        const tt = tm.x2t(X);
        const f = Math.max(0.1, Math.min(100, (hit.kind === 'out' ? (tt - a.t) / (b.t - a.t) : (b.t - tt) / (b.t - a.t)) * 100));
        const ds = segDeltas(ks, i0, sp, sp ? 1 : s.dims), d = hit.d;
        let speed: number;
        if (s.mode === 'speed') speed = yv(Y);
        else {
          // value graph: the handle's slope is the speed
          const dtH = (f / 100) * (b.t - a.t);
          speed = hit.kind === 'out' ? (yv(Y) - val(a.v, d)) / dtH : (val(b.v, d) - yv(Y)) / dtH;
        }
        if (Math.abs(ds[d] ?? 0) < 1e-9) return;
        const speeds = sp ? [speed] : ds.map((x) => (x * speed) / ds[d]);
        setKeyVelocity(wp, hit.i, sp, { [hit.kind]: { speed: speeds, influence: f } });
      }
      adv.emit('comp');
    };
    const up = () => {
      cv.removeEventListener('pointermove', mv);
      cv.removeEventListener('pointerup', up);
      frozen = null;
      if (!moved) { if (hit.kind === 'key') adv.seek(k0.t); return; }
      void adv.commit(hit.kind === 'key' ? 'Movimiento de fotograma clave' : 'Editar curva');
    };
    cv.addEventListener('pointermove', mv);
    cv.addEventListener('pointerup', up);
  });
  cv.addEventListener('dblclick', (e) => {
    if (!geo) return;
    const r = cv.getBoundingClientRect();
    if (geo.pts.some((p) => p.kind === 'key' && Math.hypot(p.x - (e.clientX - r.left), p.y - (e.clientY - r.top)) < 7)) velocityDialog();
  });
  // wheel: vertical zoom around the pointer (turns auto-zoom height off); Shift: scroll vertically
  cv.addEventListener('wheel', (e) => {
    if (!geo || !last || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const at = geo.yv(e.clientY - r.top);
    let { lo, hi } = last;
    if (e.shiftKey) { const d = (hi - lo) * 0.1 * Math.sign(e.deltaY); lo -= d; hi -= d; }
    else { const f = e.deltaY < 0 ? 1 / 1.2 : 1.2; lo = at + (lo - at) * f; hi = at + (hi - at) * f; }
    gopt.autoZoom = false;
    vr = { key: last.key, lo, hi };
    tm.redraw();
  }, { passive: false });
}

// ───────────────────────── fit ─────────────────────────
function fit(selection: boolean) {
  const c = adv.comp();
  const s = c && current(c);
  if (!s) return;
  const ks = s.p.k!;
  let idx = ks.map((_, i) => i);
  if (selection) {
    const sel = idx.filter((i) => adv.keys.some((q) => q.layer === s.l.id && q.path === s.path && Math.abs(q.t - ks[i].t) < 1e-4));
    if (sel.length === 1) idx = [Math.max(0, sel[0] - 1), sel[0], Math.min(ks.length - 1, sel[0] + 1)];
    else if (sel.length) idx = sel;
  }
  const a = ks[idx[0]].t, b = ks[idx[idx.length - 1]].t;
  tm.fit(a, b);
  const curves = samples(s, s.mode).map((cv) => cv.filter(([t]) => t >= a - 1e-9 && t <= b + 1e-9));
  const [lo, hi] = range(curves);
  if (selection) gopt.autoZoom = false;
  vr = { key: keyOf(s), lo, hi };
  tm.redraw();
}

// ───────────────────────── interpolation of the selected keys ─────────────────────────
/** Easy Ease / in / out / linear / hold / auto-bezier on the selected keys (one undo step). */
export async function interpSelected(kind: EaseKind) {
  const c = adv.comp();
  if (!c || !adv.keys.length) return false;
  const w = adv.begin()!;
  const groups = new Map<string, number[]>();
  for (const q of adv.keys) groups.set(`${q.layer}\n${q.path}`, [...(groups.get(`${q.layer}\n${q.path}`) ?? []), q.t]);
  for (const [k, ts] of groups) {
    const [lid, path] = k.split('\n');
    const p = propAt(w.layers.find((l) => l.id === lid)!, path);
    if (!p?.k) continue;
    const idxs = p.k.map((_, i) => i).filter((i) => ts.some((t) => Math.abs(p.k![i].t - t) < 1e-4));
    try { easeKeysAE(p, idxs, kind, isSpatial(path)); } catch (e) { if (kind !== 'hold' && kind !== 'linear') { toast(String((e as Error).message), true); } }
  }
  await adv.commit('Interpolación de fotogramas clave');
  return true;
}

// ───────────────────────── bottom bar ─────────────────────────
let bar: HTMLElement;
const btn = (test: string, title: string, label: string, fn: (e: MouseEvent) => void) => h('button', { class: 'gb', title, dataset: { test }, onclick: fn }, label);
export function graphBar(): HTMLElement {
  bar = h('div', { class: 'adv-graph-bar', dataset: { test: 'g-bar' } },
    btn('g-type', 'Elegir tipo y opciones de gráfico', '▦ ▾', (e) => contextMenu(e, [
      { label: `${gopt.type === 'auto' ? '✓ ' : ''}Seleccionar tipo de gráfico automáticamente`, fn: () => setType('auto') },
      { label: `${gopt.type === 'value' ? '✓ ' : ''}Editar gráfico de valores`, fn: () => setType('value') },
      { label: `${gopt.type === 'speed' ? '✓ ' : ''}Editar gráfico de velocidad`, fn: () => setType('speed') },
      { sep: true },
      { label: `${gopt.ref ? '✓ ' : ''}Mostrar gráfico de referencia`, fn: () => { gopt.ref = !gopt.ref; tm?.redraw(); } },
      { label: `${gopt.autoZoom ? '✓ ' : ''}Aplicar altura de zoom automático para adaptarla a la vista`, fn: () => toggleAuto() },
      { label: `${gopt.snap ? '✓ ' : ''}Ajustar`, fn: () => toggleSnap() },
    ])),
    btn('g-snap', 'Ajustar', '⊓', () => toggleSnap()),
    btn('g-autozoom', 'Aplicar zoom automático a la altura del gráfico', '↕', () => toggleAuto()),
    btn('g-fitsel', 'Adaptar la selección a la vista', '⬚', () => fit(true)),
    btn('g-fitall', 'Adaptar todos los gráficos a la vista', '⛶', () => fit(false)),
    btn('g-sep', 'Separar dimensiones', 'XY', () => void toggleSeparate()),
    btn('g-keymenu', 'Editar los fotogramas clave seleccionados', '◆ ▾', (e) => contextMenu(e, [
      { label: 'Velocidad de fotograma clave...', kbd: 'Ctrl+Mayús+K', fn: () => velocityDialog() },
      { label: 'Conmutar mantener fotograma clave', fn: () => void interpSelected('hold') },
      { sep: true },
      { label: 'Desacelerac./Acelerac. suave', kbd: 'F9', fn: () => void interpSelected('easy') },
      { label: 'Desaceleración suave', kbd: 'Mayús+F9', fn: () => void interpSelected('in') },
      { label: 'Aceleración suave', kbd: 'Ctrl+Mayús+F9', fn: () => void interpSelected('out') },
    ])),
    h('span', { class: 'gsep' }),
    btn('g-hold', 'Convertir los fotogramas clave seleccionados a mantenimiento', '▮', () => void interpSelected('hold')),
    btn('g-linear', 'Convertir los fotogramas clave seleccionados en lineales', '◇', () => void interpSelected('linear')),
    btn('g-auto', 'Convertir fotogramas clave seleccionados a curva automática', '○', () => void interpSelected('auto')),
    h('span', { class: 'gsep' }),
    btn('g-easy', 'Desacelerac./Acelerac. suave (F9)', '⧗', () => void interpSelected('easy')),
    btn('g-easyin', 'Desaceleración suave (Mayús+F9)', '⧗›', () => void interpSelected('in')),
    btn('g-easyout', 'Aceleración suave (Ctrl+Mayús+F9)', '‹⧗', () => void interpSelected('out')));
  return bar;
}
function setType(t: typeof gopt.type) { gopt.type = t; vr = null; tm?.redraw(); }
function toggleAuto() { gopt.autoZoom = !gopt.autoZoom; tm?.redraw(); }
function toggleSnap() { gopt.snap = !gopt.snap; tm?.redraw(); }
function updateBar(s: Sel | null) {
  if (!bar) return;
  bar.querySelector('[data-test=g-snap]')!.classList.toggle('on', gopt.snap);
  bar.querySelector('[data-test=g-autozoom]')!.classList.toggle('on', gopt.autoZoom);
  const c = adv.comp(), gp = adv.graphProp, l = gp && c?.layers.find((x) => x.id === gp.layer);
  const posLike = !!l && /^transform\.position[XYZ]?$/.test(gp!.path);
  const sep = bar.querySelector('[data-test=g-sep]') as HTMLButtonElement;
  sep.disabled = !posLike; sep.classList.toggle('on', !!l && posLike && isSeparated(l));
  void s;
}
async function toggleSeparate() {
  const c = adv.comp(), gp = adv.graphProp, l = gp && c?.layers.find((x) => x.id === gp.layer);
  if (!c || !l || !/^transform\.position[XYZ]?$/.test(gp!.path)) return;
  const on = !isSeparated(l);
  const r = await mop('separateDimensions', c.id, l.id, on);
  if (r === undefined) return;
  adv.keys = [];
  adv.graphProp = { layer: l.id, path: on ? 'transform.positionX' : 'transform.position' };
  adv.emit('comp');
}

/** self-test hook: the graph's keys and handles in client coordinates, and the graph type shown */
(window as unknown as { __graph: unknown }).__graph = {
  gopt,
  mode: () => geo?.s.mode ?? null,
  pts: (cv: HTMLCanvasElement) => { const r = cv.getBoundingClientRect(); return (geo?.pts ?? []).map((p) => ({ kind: p.kind, i: p.i, d: p.d, x: r.left + p.x, y: r.top + p.y })); },
};
