// Composition viewer: draws the rendered frame (zoom/pan, transparency grid), the gizmos of the selected
// layers (bounds, handles, anchor point, motion path) and implements the tools: selection (move/scale),
// rotation, anchor point, rectangle/ellipse/star (shape or mask), pen, text, hand and zoom.
import { apply, invert, worldMatrix, layerTransform } from '../../core/motion/geom';
import { exprErrors, keyedAt } from '../../core/motion/anim';
import type { Comp, Layer } from '../../core/motion/model';
import { MotionRenderer } from '../../motion-render/render';
import { MediaSources } from '../../motion-render/sources';
import { api, h, store as appStore, toast } from '../store';
import { isPaintTool, paintDown, paintOverlay } from './paint-ui';
import { vpPaintDown } from './particulas-ui';
import { keepEditing, registerEditing, typeToolDown, unregisterEditing } from './texto-ui';
import { isRotoTool, rotoDown, rotoOverlay } from './roto-ui';
import { capasDown, capasOverlay } from './capas-ui';
import { adv, diskFrame, failingExpressions, mop, propAt, refreshDiskStatus, setProp, storeFrame, type Tool } from './state';

export const sources = new MediaSources();
export const renderer = new MotionRenderer(sources);

let screen: HTMLCanvasElement;
let stage: HTMLDivElement;
let frame: CanvasImageSource | null = null;
let frameKey = '';
let zoom = 0; // 0 = fit
let panX = 0, panY = 0;
let rendering = false, dirty = false;
let seqPath: string | undefined;
let lastRenderMs = 0;
export const viewInfo = { fps: 0, renderMs: 0 };
let penPts: [number, number][] = [];
/** out-tangent of each pen point (comp px), set by dragging while clicking */
let penTan: [number, number][] = [];
let guides = false;
export function toggleGuides() { guides = !guides; draw(); return guides; }
let hover: [number, number] | null = null;
/** 3D views (vistas-ui.ts): the comp to render instead (another 3D view), a drawing over the frame, and a pointer
 *  handler that may take the click first (camera tools, selection only in other views) */
export const viewHooks: { renderComp: ((c: Comp) => Comp) | null; overlay: ((g: CanvasRenderingContext2D, c: Comp, toScreen: (x: number, y: number) => [number, number]) => void) | null; down: ((e: PointerEvent, p: [number, number]) => boolean) | null } = { renderComp: null, overlay: null, down: null };
let editingText: HTMLTextAreaElement | null = null;

export function initViewer(root: HTMLElement) {
  stage = h('div', { class: 'adv-stage', dataset: { test: 'adv-stage' } });
  screen = h('canvas', { class: 'adv-screen', dataset: { test: 'adv-screen' } });
  stage.append(screen);
  root.append(stage);
  new ResizeObserver(() => draw()).observe(stage);
  stage.addEventListener('pointerdown', down);
  stage.addEventListener('pointermove', (e) => { hover = toComp(e); if ((adv.tool === 'pen' && penPts.length) || isPaintTool(adv.tool) || isRotoTool(adv.tool)) draw(); sketchMove(e); });
  stage.addEventListener('pointerup', () => sketchUp());
  stage.addEventListener('dblclick', dbl);
  stage.addEventListener('wheel', wheel, { passive: false });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const raw = e.dataTransfer?.getData('application/x-cinta-adv');
    if (raw) document.dispatchEvent(new CustomEvent('adv:drop', { detail: { raw, at: toComp(e as unknown as PointerEvent) } }));
  });
  adv.on((why) => {
    if (why === 'tool') { stage.dataset.tool = adv.tool; penPts = []; penTan = []; draw(); }
    else if (why === 'select' || why === 'view') draw();
    else requestRender();
  });
  void api.invoke('motion:sequence').then((p: string | undefined) => { seqPath = p; });
}

export function refreshSequence() { void api.invoke('motion:sequence').then((p: string | undefined) => { seqPath = p; requestRender(); }); }

// ───────────────────────── render scheduling ─────────────────────────
export function requestRender() {
  if (rendering) { dirty = true; return; }
  void doRender();
}
async function doRender() {
  const c = adv.comp();
  if (!c) { frame = null; draw(); return; }
  rendering = true;
  dirty = false;
  try {
    const key = `${c.id}|${adv.time}|${adv.res}`;
    const mbSamples = adv.playing ? 4 : Math.min(c.motionBlur.samples, adv.res < 1 ? 8 : c.motionBlur.samples);
    // disk cache: exact frames of the committed state (not while dragging or playing live)
    const fno = adv.time * c.fps, exact = Math.abs(fno - Math.round(fno)) < 1e-4;
    const rc = viewHooks.renderComp?.(c) ?? c;
    // region of interest: only that area is drawn (such frames are not cached)
    const roi = c.roi?.on ? c.roi.rect : undefined;
    const hit = !adv.playing && !adv.work && exact && !roi && rc === c ? await diskFrame(c.id, Math.round(fno), { res: adv.res, mbSamples }) : null;
    if (hit?.bmp) {
      frame = hit.bmp;
      frameSeq++;
      viewInfo.renderMs = 0;
    } else {
      const errs0 = [...exprErrors].join();
      const cv = await renderer.render(appStore.project, rc, adv.time, { scale: adv.res, sequencePath: seqPath, mbSamples, guides: true, roi });
      frame = cv;
      frameSeq++;
      lastRenderMs = renderer.lastMs;
      viewInfo.renderMs = lastRenderMs;
      // expression errors appear in the timeline as soon as a render finds them
      if ([...exprErrors].join() !== errs0) adv.emit('errors');
      // slow frames are worth keeping; never one with errors (a cached frame runs no expressions to report them)
      if (hit && lastRenderMs > 40 && !renderer.errors.length && !failingExpressions()) { storeFrame(cv, hit.key, hit.version); refreshDiskStatus(c.id, { res: adv.res, mbSamples }); }
    }
    frameKey = key;
  } catch (e) {
    console.error(e);
  } finally {
    rendering = false;
  }
  draw();
  if (dirty) requestRender();
}
/** Renders and waits (tests, snapshots). */
export async function renderNow(): Promise<CanvasImageSource | null> { await doRender(); return frame; }
/** Shows a pre-rendered frame (RAM preview playback). */
export function showFrame(f: CanvasImageSource) { frame = f; frameSeq++; draw(); }
export const currentFrame = () => frame;
/** bumps every time a new frame is shown (Lumetri Scopes follow it) */
let frameSeq = 0;
export const currentFrameSeq = () => frameSeq;

// ───────────────────────── view transform ─────────────────────────
function fit(c: Comp) {
  const r = stage.getBoundingClientRect();
  return Math.min((r.width - 40) / c.width, (r.height - 40) / c.height);
}
export function viewScale(c: Comp) { return zoom || fit(c); }
export function setZoom(z: number) { zoom = z; panX = panY = 0; draw(); adv.emit('view'); }
function origin(c: Comp): [number, number] {
  const r = stage.getBoundingClientRect();
  const s = viewScale(c);
  return [r.width / 2 - (c.width * s) / 2 + panX, r.height / 2 - (c.height * s) / 2 + panY];
}
function toComp(e: { clientX: number; clientY: number }): [number, number] {
  const c = adv.comp();
  if (!c) return [0, 0];
  const r = stage.getBoundingClientRect();
  const s = viewScale(c), [ox, oy] = origin(c);
  return [(e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s];
}
/** comp pixels → client (window) coordinates (tests, inline editors) */
export function compToClient(x: number, y: number): [number, number] {
  const c = adv.comp();
  if (!c) return [0, 0];
  const r = stage.getBoundingClientRect();
  const [sx, sy] = toScreen(c, x, y);
  return [r.left + sx, r.top + sy];
}
function toScreen(c: Comp, x: number, y: number): [number, number] {
  const s = viewScale(c), [ox, oy] = origin(c);
  return [ox + x * s, oy + y * s];
}

// ───────────────────────── drawing ─────────────────────────
export function draw() {
  if (!screen) return;
  const r = stage.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (screen.width !== W || screen.height !== H) { screen.width = W; screen.height = H; }
  const g = screen.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1b1d24';
  g.fillRect(0, 0, r.width, r.height);
  const c = adv.comp();
  if (!c) return;
  const s = viewScale(c), [ox, oy] = origin(c);
  // transparency grid / background
  if (c.transparent) {
    const k = 12;
    g.fillStyle = '#3a3d47'; g.fillRect(ox, oy, c.width * s, c.height * s);
    g.fillStyle = '#2b2e37';
    for (let y = 0; y < c.height * s; y += k) for (let x = (Math.floor(y / k) % 2) * k; x < c.width * s; x += k * 2) g.fillRect(ox + x, oy + y, Math.min(k, c.width * s - x), Math.min(k, c.height * s - y));
  }
  if (frame) { g.imageSmoothingQuality = 'high'; g.drawImage(frame, ox, oy, c.width * s, c.height * s); }
  g.strokeStyle = '#000';
  g.lineWidth = 1;
  g.strokeRect(ox - 0.5, oy - 0.5, c.width * s + 1, c.height * s + 1);
  if (guides) {
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.setLineDash([5, 4]);
    for (const k of [0.9, 0.8]) g.strokeRect(ox + (c.width * s * (1 - k)) / 2, oy + (c.height * s * (1 - k)) / 2, c.width * s * k, c.height * s * k);
    g.setLineDash([]);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.beginPath();
    for (const f of [1 / 3, 2 / 3]) { g.moveTo(ox + c.width * s * f, oy); g.lineTo(ox + c.width * s * f, oy + c.height * s); g.moveTo(ox, oy + c.height * s * f); g.lineTo(ox + c.width * s, oy + c.height * s * f); }
    g.moveTo(ox + (c.width * s) / 2 - 10, oy + (c.height * s) / 2); g.lineTo(ox + (c.width * s) / 2 + 10, oy + (c.height * s) / 2);
    g.moveTo(ox + (c.width * s) / 2, oy + (c.height * s) / 2 - 10); g.lineTo(ox + (c.width * s) / 2, oy + (c.height * s) / 2 + 10);
    g.stroke();
  }
  if (viewHooks.overlay) { viewHooks.overlay(g, c, (x, y) => toScreen(c, x, y)); if (viewHooks.renderComp) return; }
  capasOverlay(g, c, (x, y) => toScreen(c, x, y));
  if (adv.playing) return;
  // gizmos
  for (const l of adv.selected()) gizmo(g, c, l);
  if (adv.tool === 'pen' && penPts.length) {
    g.strokeStyle = '#4aa8ff'; g.lineWidth = 1.5;
    g.beginPath();
    penPts.forEach(([x, y], i) => {
      const [X, Y] = toScreen(c, x, y);
      if (!i) { g.moveTo(X, Y); return; }
      const [px, py] = penPts[i - 1], [tx, ty] = penTan[i - 1] ?? [0, 0], [ux, uy] = penTan[i] ?? [0, 0];
      const a = toScreen(c, px + tx, py + ty), b = toScreen(c, x - ux, y - uy);
      g.bezierCurveTo(a[0], a[1], b[0], b[1], X, Y);
    });
    if (hover) { const [X, Y] = toScreen(c, hover[0], hover[1]); g.lineTo(X, Y); }
    g.stroke();
    penPts.forEach(([x, y], i) => {
      const [X, Y] = toScreen(c, x, y);
      const [tx, ty] = penTan[i] ?? [0, 0];
      if (tx || ty) { const a = toScreen(c, x + tx, y + ty), b = toScreen(c, x - tx, y - ty); g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(a[0], a[1]); g.stroke(); g.fillStyle = '#4aa8ff'; g.fillRect(a[0] - 2.5, a[1] - 2.5, 5, 5); g.fillRect(b[0] - 2.5, b[1] - 2.5, 5, 5); }
      g.fillStyle = '#fff'; g.fillRect(X - 3, Y - 3, 6, 6);
    });
  }
  paintOverlay(g, c, (x, y) => toScreen(c, x, y), s, frame, hover);
  rotoOverlay(g, c, (x, y) => toScreen(c, x, y), s, hover);
  if (drag?.kind === 'box') {
    const [a, b] = [toScreen(c, drag.p0[0], drag.p0[1]), toScreen(c, drag.p1[0], drag.p1[1])];
    g.strokeStyle = '#4aa8ff'; g.setLineDash([4, 3]);
    if (adv.tool === 'ellipse') { g.beginPath(); g.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2); g.stroke(); }
    else g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    g.setLineDash([]);
  }
}

function layerQuad(c: Comp, l: Layer): [number, number][] | null {
  const q = renderer.boxes.get(l.id);
  if (q) return q;
  // never drawn (null layer…): a small box around the anchor
  const w = worldMatrix(c, l, adv.time);
  const a = l.transform.anchor.v;
  const p = apply(w, a[0] ?? 0, a[1] ?? 0);
  return [[p[0] - 30, p[1] - 30], [p[0] + 30, p[1] - 30], [p[0] + 30, p[1] + 30], [p[0] - 30, p[1] + 30]];
}

function gizmo(g: CanvasRenderingContext2D, c: Comp, l: Layer) {
  const q = layerQuad(c, l);
  if (!q) return;
  const S = q.map(([x, y]) => toScreen(c, x, y));
  g.strokeStyle = l.label || '#4aa8ff';
  g.lineWidth = 1;
  g.beginPath();
  S.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.stroke();
  if (adv.selection.size === 1) for (const [x, y] of handles(S)) { g.fillStyle = '#fff'; g.fillRect(x - 3.5, y - 3.5, 7, 7); g.strokeRect(x - 3.5, y - 3.5, 7, 7); }
  const w = worldMatrix(c, l, adv.time);
  // puppet pins (yellow; the one being dragged white)
  if (adv.selection.size === 1 && l.puppet?.pins.length) for (const pin of l.puppet.pins) {
    const v = keyedAt(pin.position, adv.time) as number[];
    const q = apply(w, v[0], v[1]);
    const [x, y] = toScreen(c, q[0], q[1]);
    g.fillStyle = drag?.kind === 'pin' && drag.pin === pin.id ? '#ffffff' : '#ffd400';
    g.strokeStyle = '#000';
    g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  // mask vertices (drag them with the Selection tool)
  if (adv.selection.size === 1) for (const m of l.masks) {
    const flat = keyedAt(m.path, adv.time) as number[];
    g.strokeStyle = '#ffd400';
    for (let i = 0; i + 1 < flat.length; i += 6) { const p = apply(w, flat[i], flat[i + 1]); const [x, y] = toScreen(c, p[0], p[1]); g.strokeRect(x - 3.5, y - 3.5, 7, 7); }
  }
  // anchor point
  const a = layerTransform(c, l, adv.time).anchor;
  const ap = apply(w, a[0], a[1]);
  const [ax, ay] = toScreen(c, ap[0], ap[1]);
  g.strokeStyle = '#fff';
  g.beginPath(); g.arc(ax, ay, 5, 0, Math.PI * 2); g.moveTo(ax - 9, ay); g.lineTo(ax + 9, ay); g.moveTo(ax, ay - 9); g.lineTo(ax, ay + 9); g.stroke();
  // motion path
  const pos = l.transform.position;
  if (pos.k && pos.k.length > 1) {
    const a0 = pos.k[0].t, a1 = pos.k[pos.k.length - 1].t;
    const parent = l.parent ? c.layers.find((x) => x.id === l.parent) : undefined;
    const toWorld = (v: number[]) => (parent ? apply(worldMatrix(c, parent, adv.time), v[0], v[1]) : v);
    g.fillStyle = l.label || '#4aa8ff';
    for (let t = a0; t <= a1 + 1e-6; t += 1 / c.fps) {
      const v = toWorld(keyedAt(pos, t, true) as number[]);
      const [x, y] = toScreen(c, v[0], v[1]);
      g.fillRect(x - 1, y - 1, 2, 2);
    }
    for (const k of pos.k) { const v = toWorld(k.v as number[]); const [x, y] = toScreen(c, v[0], v[1]); g.strokeStyle = '#fff'; g.strokeRect(x - 3.5, y - 3.5, 7, 7); }
  }
}
function handles(S: [number, number][]): [number, number][] {
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [S[0], mid(S[0], S[1]), S[1], mid(S[1], S[2]), S[2], mid(S[2], S[3]), S[3], mid(S[3], S[0])];
}

// ───────────────────────── Motion Sketch ─────────────────────────
/** the drag being recorded: comp time of the first point, real start time, [t, x, y, …] */
let sketch: { id: string; t0: number; at: number; pts: number[] } | null = null;
function sketchMove(e: PointerEvent) {
  if (!sketch) return;
  const p = toComp(e);
  sketch.pts.push(sketch.at + (performance.now() - sketch.t0) / 1000, p[0], p[1]);
}
function sketchUp() {
  if (!sketch) return;
  const s = sketch, c = adv.comp();
  sketch = null;
  if (c && s.pts.length >= 6) void mop('keyframeAssist', c.id, { kind: 'sketch', layers: [s.id], path: 'position', points: s.pts, smoothing: 2 });
}

// ───────────────────────── track tool ─────────────────────────
/** Click on a detail of a video layer: track it from the current time and create a null that follows it. */
async function trackDown(c: Comp, l: Layer | undefined, p: [number, number]) {
  if (!l || l.type !== 'video') { toast('Haga clic sobre una capa de vídeo: el rastreador sigue un detalle del vídeo.', true); return; }
  toast('Rastreando…');
  const r = await mop<{ frames: number; lost: number; minConfidence: number; layer?: string }>('track', c.id, l.id, { points: [p], at: adv.time, apply: 'null' });
  if (!r) return;
  if (r.layer) adv.select([r.layer]);
  toast(`Rastreados ${r.frames} fotogramas${r.lost ? ` (${r.lost} con poca coincidencia: revise el nulo)` : ''}: el nulo «Seguimiento» sigue el punto; emparente capas a él.`, r.lost > 0);
}

// ───────────────────────── puppet tool ─────────────────────────
/** Click on a pin: drag it (Alt: remove it); elsewhere on the layer: a new pin there. */
function puppetDown(c: Comp, l: Layer | undefined, p: [number, number], e: PointerEvent) {
  if (!l || l.type === 'camera' || l.type === 'light' || l.type === 'null' || l.type === 'audio' || l.type === 'adjustment') return;
  if (!adv.selection.has(l.id)) adv.select([l.id]);
  const w0 = worldMatrix(c, l, adv.time);
  const r = stage.getBoundingClientRect();
  for (const pin of l.puppet?.pins ?? []) {
    const v = keyedAt(pin.position, adv.time) as number[];
    const q = apply(w0, v[0], v[1]);
    const [x, y] = toScreen(c, q[0], q[1]);
    if (Math.hypot(x - (e.clientX - r.left), y - (e.clientY - r.top)) > 8) continue;
    if (e.altKey) { void mop('puppetSet', c.id, l.id, { remove: pin.id }); return; }
    adv.begin();
    drag = { kind: 'pin', p0: p, id: l.id, pin: pin.id };
    capture(e);
    return;
  }
  if (e.altKey) return;
  const q = apply(invert(w0), p[0], p[1]);
  void mop('puppetSet', c.id, l.id, { add: { at: [q[0], q[1]] } });
}

// ───────────────────────── interaction ─────────────────────────
type Drag =
  | { kind: 'move'; p0: [number, number]; start: Map<string, number[]> }
  | { kind: 'scale'; p0: [number, number]; id: string; anchor: [number, number]; s0: number[]; handle: number }
  | { kind: 'rotate'; p0: [number, number]; id: string; anchor: [number, number]; r0: number }
  | { kind: 'anchor'; p0: [number, number]; id: string; a0: number[]; pos0: number[] }
  | { kind: 'pan'; x0: number; y0: number; px: number; py: number }
  | { kind: 'box'; p0: [number, number]; p1: [number, number] }
  | { kind: 'maskpt'; p0: [number, number]; id: string; mask: string; idx: number; flat0: number[] }
  | { kind: 'pin'; p0: [number, number]; id: string; pin: string };
let drag: Drag | null = null;

function hit(c: Comp, p: [number, number]): Layer | undefined {
  for (const l of c.layers) {
    if (l.hidden || l.locked || l.type === 'camera' || l.type === 'light' || l.type === 'audio' || adv.time < l.in || adv.time >= l.out) continue;
    const q = renderer.boxes.get(l.id);
    if (q && inQuad(p, q)) return l;
  }
  return undefined;
}
function inQuad(p: [number, number], q: [number, number][]) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}
function anchorWorld(c: Comp, l: Layer): [number, number] {
  const a = layerTransform(c, l, adv.time).anchor;
  const p = apply(worldMatrix(c, l, adv.time), a[0], a[1]);
  return [p[0], p[1]];
}
/** comp-space delta → parent-space delta */
function toParent(c: Comp, l: Layer, dx: number, dy: number): [number, number] {
  if (!l.parent) return [dx, dy];
  const p = c.layers.find((x) => x.id === l.parent);
  if (!p) return [dx, dy];
  const inv = invert(worldMatrix(c, p, adv.time));
  const a = apply(inv, 0, 0), b = apply(inv, dx, dy);
  return [b[0] - a[0], b[1] - a[1]];
}

function down(e: PointerEvent) {
  if (e.button === 1 || (e.button === 0 && adv.tool === 'hand')) { drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, px: panX, py: panY }; capture(e); return; }
  if (e.button !== 0) return;
  const c = adv.comp();
  if (!c) return;
  const p = toComp(e);
  if (viewHooks.down?.(e, p)) return;
  const tool: Tool = adv.tool;
  if (capasDown(e, { c, stage, toComp, toScreen: (x, y) => toScreen(c, x, y), draw })) return;
  if (tool === 'zoom') { const s = viewScale(c); setZoom(Math.max(0.05, Math.min(16, s * (e.altKey ? 1 / 1.5 : 1.5)))); return; }
  if (tool === 'rect' || tool === 'ellipse' || tool === 'star') { drag = { kind: 'box', p0: p, p1: p }; capture(e); return; }
  if (tool === 'pen') { pen(c, p, e); return; }
  if (tool === 'text') { typeToolDown(e, { c, p, stage, toComp, hit, editText }); return; }
  // handles of the single selected layer
  const sel = adv.first();
  if (tool === 'puppet') { puppetDown(c, sel ?? hit(c, p), p, e); return; }
  if (isPaintTool(tool)) { const pv = { c, layer: sel ?? hit(c, p), stage, toComp, draw }; if (tool !== 'brush' || !vpPaintDown(e, pv)) paintDown(e, pv); return; }
  if (isRotoTool(tool)) { rotoDown(e, { c, layer: sel ?? hit(c, p), stage, toComp, draw, scale: viewScale(c) }); return; }
  if (tool === 'track') { void trackDown(c, sel?.type === 'video' ? sel : hit(c, p), p); return; }
  if (tool === 'sketch') { const l = sel ?? hit(c, p); if (l) { adv.select([l.id]); sketch = { id: l.id, t0: performance.now(), at: adv.time, pts: [adv.time, p[0], p[1]] }; capture(e); } return; }
  if (sel && adv.selection.size === 1 && tool === 'select' && sel.masks.length) {
    const r = stage.getBoundingClientRect();
    const w0 = worldMatrix(c, sel, adv.time);
    for (const m of sel.masks) {
      const flat = keyedAt(m.path, adv.time) as number[];
      for (let i = 0; i + 1 < flat.length; i += 6) {
        const q = apply(w0, flat[i], flat[i + 1]);
        const [x, y] = toScreen(c, q[0], q[1]);
        if (Math.abs(x - (e.clientX - r.left)) < 7 && Math.abs(y - (e.clientY - r.top)) < 7) { adv.begin(); drag = { kind: 'maskpt', p0: p, id: sel.id, mask: m.id, idx: i, flat0: [...flat] }; capture(e); return; }
      }
    }
  }
  if (sel && adv.selection.size === 1 && (tool === 'select')) {
    const q = layerQuad(c, sel);
    if (q) {
      const S = handles(q.map(([x, y]) => toScreen(c, x, y)));
      const r = stage.getBoundingClientRect();
      const i = S.findIndex(([x, y]) => Math.abs(x - (e.clientX - r.left)) < 7 && Math.abs(y - (e.clientY - r.top)) < 7);
      if (i >= 0) {
        const w = adv.begin();
        const l = w?.layers.find((x) => x.id === sel.id);
        if (l) { drag = { kind: 'scale', p0: p, id: l.id, anchor: anchorWorld(c, sel), s0: [...(cur(l, 'transform.scale') as number[])], handle: i }; capture(e); return; }
      }
    }
  }
  const l = hit(c, p) ?? (sel && (tool === 'rotate' || tool === 'anchor') ? sel : undefined);
  if (!l) { if (!e.shiftKey) adv.select([]); return; }
  if (!adv.selection.has(l.id)) adv.select([l.id], e.shiftKey);
  const w = adv.begin();
  if (!w) return;
  if (tool === 'rotate') { drag = { kind: 'rotate', p0: p, id: l.id, anchor: anchorWorld(c, l), r0: Number(cur(w.layers.find((x) => x.id === l.id)!, 'transform.rotation')) }; capture(e); return; }
  if (tool === 'anchor') { const wl = w.layers.find((x) => x.id === l.id)!; drag = { kind: 'anchor', p0: p, id: l.id, a0: [...(cur(wl, 'transform.anchor') as number[])], pos0: [...(cur(wl, 'transform.position') as number[])] }; capture(e); return; }
  const start = new Map<string, number[]>();
  for (const s of adv.selected()) { const wl = w.layers.find((x) => x.id === s.id); if (wl && !wl.locked) start.set(s.id, [...(cur(wl, 'transform.position') as number[])]); }
  drag = { kind: 'move', p0: p, start };
  capture(e);
}
const cur = (l: Layer, path: string) => { if (path === 'transform.position' && l.transform.positionX) return [l.transform.positionX, l.transform.positionY, l.transform.positionZ].map((p) => Number(p ? keyedAt(p, adv.time) : 0)); const p = propAt(l, path)!; return keyedAt(p, adv.time, path === 'transform.position' || path === 'transform.anchor'); };

function capture(e: PointerEvent) {
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  const mv = (ev: PointerEvent) => move(ev);
  const up = (ev: PointerEvent) => { stage.removeEventListener('pointermove', mv); stage.removeEventListener('pointerup', up); void end(ev); };
  stage.addEventListener('pointermove', mv);
  stage.addEventListener('pointerup', up);
}
function move(e: PointerEvent) {
  if (!drag) return;
  if (drag.kind === 'pan') { panX = drag.px + e.clientX - drag.x0; panY = drag.py + e.clientY - drag.y0; draw(); return; }
  const c = adv.comp();
  if (!c) return;
  const p = toComp(e);
  if (drag.kind === 'box') { drag.p1 = e.shiftKey ? square(drag.p0, p) : p; draw(); return; }
  const w = adv.work;
  if (!w) return;
  if (drag.kind === 'move') {
    let dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1];
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    for (const [id, s0] of drag.start) {
      const l = w.layers.find((x) => x.id === id)!;
      const [px, py] = toParent(c, l, dx, dy);
      setProp(l, 'transform.position', [s0[0] + px, s0[1] + py, s0[2] ?? 0]);
    }
  } else if (drag.kind === 'scale') {
    const l = w.layers.find((x) => x.id === (drag as { id: string }).id)!;
    const d0 = [drag.p0[0] - drag.anchor[0], drag.p0[1] - drag.anchor[1]], d1 = [p[0] - drag.anchor[0], p[1] - drag.anchor[1]];
    const corner = drag.handle % 2 === 0;
    let fx = Math.abs(d0[0]) > 2 ? d1[0] / d0[0] : 1, fy = Math.abs(d0[1]) > 2 ? d1[1] / d0[1] : 1;
    if (drag.handle === 1 || drag.handle === 5) fx = e.shiftKey ? fy : 1;
    if (drag.handle === 3 || drag.handle === 7) fy = e.shiftKey ? fx : 1;
    if (corner && e.shiftKey) { const f = Math.hypot(d1[0], d1[1]) / (Math.hypot(d0[0], d0[1]) || 1); fx = fy = f; }
    setProp(l, 'transform.scale', [drag.s0[0] * fx, drag.s0[1] * fy, drag.s0[2] ?? 100]);
  } else if (drag.kind === 'rotate') {
    const l = w.layers.find((x) => x.id === (drag as { id: string }).id)!;
    const a0 = Math.atan2(drag.p0[1] - drag.anchor[1], drag.p0[0] - drag.anchor[0]), a1 = Math.atan2(p[1] - drag.anchor[1], p[0] - drag.anchor[0]);
    let r = drag.r0 + ((a1 - a0) * 180) / Math.PI;
    if (e.shiftKey) r = Math.round(r / 45) * 45;
    setProp(l, 'transform.rotation', r);
  } else if (drag.kind === 'pin') {
    const d = drag;
    const l = w.layers.find((x) => x.id === d.id)!;
    const q = apply(invert(worldMatrix(c, l, adv.time)), p[0], p[1]);
    const pin = l.puppet?.pins.find((x) => x.id === d.pin);
    // like After Effects, pins are always animated: the first drag starts the keyframes
    if (pin && !pin.position.k?.length) pin.position.k = [{ t: adv.time, v: [...(pin.position.v as number[])] }];
    setProp(l, `puppet.${d.pin}.position`, [q[0], q[1]]);
  } else if (drag.kind === 'maskpt') {
    const d = drag;
    const l = w.layers.find((x) => x.id === d.id)!;
    const inv = invert(worldMatrix(c, l, adv.time));
    const q = apply(inv, p[0], p[1]);
    const flat = [...d.flat0];
    flat[d.idx] = q[0];
    flat[d.idx + 1] = q[1];
    setProp(l, 'masks.' + d.mask + '.path', flat);
  } else if (drag.kind === 'anchor') {
    const l = w.layers.find((x) => x.id === (drag as { id: string }).id)!;
    // move the anchor in layer space and compensate the position so the layer stays put
    const inv = invert(worldMatrix(c, l, adv.time));
    const a = apply(inv, drag.p0[0], drag.p0[1]), b = apply(inv, p[0], p[1]);
    const da = [b[0] - a[0], b[1] - a[1]];
    setProp(l, 'transform.anchor', [drag.a0[0] + da[0], drag.a0[1] + da[1], drag.a0[2] ?? 0]);
    const [px, py] = toParent(c, l, p[0] - drag.p0[0], p[1] - drag.p0[1]);
    setProp(l, 'transform.position', [drag.pos0[0] + px, drag.pos0[1] + py, drag.pos0[2] ?? 0]);
  }
  adv.emit('comp');
}
async function end(e: PointerEvent) {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.kind === 'pan') return;
  if (d.kind === 'box') {
    const c = adv.comp();
    const p1 = e.shiftKey ? square(d.p0, toComp(e)) : toComp(e);
    if (c && Math.abs(p1[0] - d.p0[0]) > 3 && Math.abs(p1[1] - d.p0[1]) > 3) await shapeOrMask(c, d.p0, p1);
    draw();
    return;
  }
  await adv.commit(d.kind === 'maskpt' ? 'Editar máscara' : d.kind === 'move' ? 'Mover capa' : d.kind === 'scale' ? 'Escalar capa' : d.kind === 'rotate' ? 'Girar capa' : 'Mover punto de anclaje');
}
const square = (a: [number, number], b: [number, number]): [number, number] => { const s = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); return [a[0] + Math.sign(b[0] - a[0] || 1) * s, a[1] + Math.sign(b[1] - a[1] || 1) * s]; };

/** Rectangle/ellipse/star drag: a mask on the selected footage/solid/text layer, a shape otherwise. */
async function shapeOrMask(c: Comp, a: [number, number], b: [number, number]) {
  const sel = adv.first();
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), hgt = Math.abs(b[1] - a[1]);
  const kind = adv.tool === 'ellipse' ? 'ellipse' : adv.tool === 'star' ? 'star' : 'rect';
  if (sel && sel.type !== 'shape' && sel.type !== 'null' && sel.type !== 'camera' && sel.type !== 'audio' && kind !== 'star') {
    const inv = invert(worldMatrix(c, sel, adv.time));
    const p = apply(inv, x0, y0), q = apply(inv, x0 + w, y0 + hgt);
    await mop('maskAdd', c.id, sel.id, { shape: kind, x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), width: Math.abs(q[0] - p[0]), height: Math.abs(q[1] - p[1]) });
    return;
  }
  const cx = x0 + w / 2, cy = y0 + hgt / 2;
  if (sel?.type === 'shape') {
    const inv = invert(worldMatrix(c, sel, adv.time));
    const p = apply(inv, cx, cy);
    await mop('shapeAdd', c.id, sel.id, { kind, width: w, height: hgt, position: [p[0], p[1]] });
    return;
  }
  const r = await mop<{ layer: Layer }>('shapeAdd', c.id, undefined, { kind, width: w, height: hgt, position: [cx - c.width / 2, cy - c.height / 2] });
  if (r) adv.select([r.layer.id]);
}

function pen(c: Comp, p: [number, number], e: PointerEvent) {
  if (penPts.length >= 2) {
    const [fx, fy] = toScreen(c, penPts[0][0], penPts[0][1]);
    const r = stage.getBoundingClientRect();
    if (Math.hypot(fx - (e.clientX - r.left), fy - (e.clientY - r.top)) < 8) { void finishPen(true); return; }
  }
  penPts.push(p);
  penTan.push([0, 0]);
  const i = penPts.length - 1;
  // dragging while clicking pulls out symmetric bezier handles (a smooth point)
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  const mv = (ev: PointerEvent) => { const q = toComp(ev); const tx = q[0] - p[0], ty = q[1] - p[1]; penTan[i] = Math.hypot(tx, ty) > 3 / viewScale(c) ? [tx, ty] : [0, 0]; draw(); };
  const up = () => { stage.removeEventListener('pointermove', mv); stage.removeEventListener('pointerup', up); };
  stage.addEventListener('pointermove', mv);
  stage.addEventListener('pointerup', up);
  draw();
}
export async function finishPen(closed: boolean) {
  const c = adv.comp();
  const pts = penPts;
  const tans = penTan;
  penPts = [];
  penTan = [];
  const curved = tans.some(([x, y]) => x || y);
  /** flat path for the pen points (pairs, or bezier vertices with tangents when curved), mapped by fn */
  const flatOf = (fn: (x: number, y: number) => [number, number]) => curved
    ? pts.flatMap(([x, y], i) => { const [tx, ty] = tans[i] ?? [0, 0]; const [X, Y] = fn(x, y), [ax, ay] = fn(x + tx, y + ty); return [X, Y, -(ax - X), -(ay - Y), ax - X, ay - Y]; })
    : pts.flatMap(([x, y]) => fn(x, y));
  if (!c || pts.length < 2) { draw(); return; }
  const sel = adv.first();
  if (closed && sel && sel.type !== 'shape' && sel.type !== 'null' && sel.type !== 'camera' && sel.type !== 'audio' && pts.length >= 3) {
    const inv = invert(worldMatrix(c, sel, adv.time));
    await mop('maskAdd', c.id, sel.id, { shape: 'path', bezier: curved, path: flatOf((x, y) => { const q = apply(inv, x, y); return [q[0], q[1]]; }) });
  } else {
    const cx = c.width / 2, cy = c.height / 2;
    const r = await mop<{ layer: Layer }>('shapeAdd', c.id, sel?.type === 'shape' ? sel.id : undefined, { kind: 'path', bezier: curved, path: flatOf((x, y) => [x - cx, y - cy]), closed, color: closed ? '#1d6cff' : null, stroke: closed ? undefined : '#ffffff', strokeWidth: 8 });
    if (r) adv.select([r.layer.id]);
  }
  draw();
}
export const penActive = () => penPts.length > 0;

function dbl(e: MouseEvent) {
  const c = adv.comp();
  if (!c) return;
  if (adv.tool === 'pen') { void finishPen(false); return; }
  const l = hit(c, toComp(e));
  if (l?.type === 'text') editText(l.id);
}
/** Inline text editing on the viewer (Ctrl+Enter or click outside to finish, Esc to cancel). */
export function editText(id: string) {
  const c = adv.comp();
  const l = c?.layers.find((x) => x.id === id);
  if (!c || !l?.text) return;
  editingText?.remove();
  const q = renderer.boxes.get(l.id);
  const r = stage.getBoundingClientRect();
  const [x, y] = q ? toScreen(c, Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1]))) : [r.width / 3, r.height / 3];
  const ta = h('textarea', { class: 'adv-text-edit', dataset: { test: 'adv-text-edit' }, style: { left: `${Math.max(4, x)}px`, top: `${Math.max(4, y)}px` } });
  ta.value = String(keyedAt(l.text.text, adv.time));
  stage.append(ta);
  editingText = ta;
  ta.focus();
  ta.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    ta.remove();
    editingText = null;
    unregisterEditing(ta);
    if (!save) return;
    const v = ta.value;
    // the current layer (a style may have been applied while editing): keep styled runs on their characters
    const cl = adv.comp()?.layers.find((x) => x.id === id) ?? l;
    if (v === String(keyedAt(cl.text!.text, adv.time))) return;
    await mop('textEdit', c.id, id, v, cl.text!.text.k?.length ? adv.time : undefined);
  };
  registerEditing(ta, id, (s) => void finish(s));
  ta.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') void finish(false); if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) void finish(true); });
  ta.addEventListener('blur', (ev) => { if (!keepEditing(ev)) void finish(true); });
}

function wheel(e: WheelEvent) {
  const c = adv.comp();
  if (!c) return;
  e.preventDefault();
  if (e.ctrlKey || e.altKey) {
    const r = stage.getBoundingClientRect();
    const s0 = viewScale(c);
    const s1 = Math.max(0.05, Math.min(16, s0 * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const [ox, oy] = origin(c);
    const cx = (mx - ox) / s0, cy = (my - oy) / s0;
    zoom = s1;
    const [nx, ny] = origin(c);
    panX += mx - (nx + cx * s1);
    panY += my - (ny + cy * s1);
    draw();
    adv.emit('view');
  } else { panX -= e.shiftKey ? e.deltaY : e.deltaX; panY -= e.shiftKey ? 0 : e.deltaY; draw(); }
}

export const lastFrameKey = () => frameKey;
