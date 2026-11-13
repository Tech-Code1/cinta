// Multiple views of the Composition panel (After Effects: Select View Layout — 1, 2 or 4 views) and the 3D view of
// each (Active Camera, Front, Left, Top, Back, Right, Bottom, Custom View 1-3), with the camera tools (Orbit 1,
// Pan 2, Dolly 3, C cycles): in the active camera view they move the camera layer (one undo step per drag), in the
// other views they move the view itself. F10 / F11 / F12 switch the active view to Front / Custom View 1 / Active
// Camera, Esc back to the last 3D view. Views other than the active camera draw wireframes of cameras and lights.
// The view with the editing tools is the composition viewer (viewer.ts); the others render with their own engine.
import { keyedAt } from '../../core/motion/anim';
import { cameraAt, layerTransform } from '../../core/motion/geom';
import type { Comp, Layer } from '../../core/motion/model';
import { LAYOUT_VIEWS, VIEWS_3D, VIEW_LAYOUTS, defaultViewState, has3D, isOrtho, moveCamera, moveView, viewComp, wireframes, type View3D, type ViewState } from '../../core/motion/vistas';
import { MotionRenderer } from '../../motion-render/render';
import { api, h, store, toast } from '../store';
import { adv, setProp, type Tool } from './state';
import { compToClient, draw as drawViewer, renderer, requestRender, sources, viewHooks } from './viewer';
import { bindCommands, keysOf, shortcutsState } from './atajos-ui';
import { flowState } from './flujo-ui';
import { browseTo, mediaBrowserState } from './medios-ui';
import { metadataState } from './metadatos-ui';
import { css } from './paneles-css';

const CSS = `
#adv-views { position: relative; display: grid; gap: 3px; min-height: 0; min-width: 0; background: #0f1015; }
#adv-views[data-n="2"] { grid-template-columns: 1fr 1fr; }
#adv-views[data-n="4"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
#adv-views > section { outline: 2px solid transparent; outline-offset: -2px; }
#adv-views > section.vactive { outline-color: #ffd400; }
#adv-views[data-n="1"] > section.vactive { outline-color: transparent; }
.adv-pane { position: relative; overflow: hidden; background: #1b1d24; min-height: 0; }
.adv-pane canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.adv-pane[data-tool=orbit], #adv-viewer[data-tool=orbit] .adv-stage { cursor: move; }
.adv-pane[data-tool=pan3d], #adv-viewer[data-tool=pan3d] .adv-stage { cursor: all-scroll; }
.adv-pane[data-tool=dolly], #adv-viewer[data-tool=dolly] .adv-stage { cursor: ns-resize; }
.adv-vsel { position: absolute; left: 6px; top: 6px; z-index: 4; height: 22px; font-size: 11px; background: rgba(20,22,28,.85); color: #e8eaf0; border: 1px solid #3a3f4f; border-radius: 4px; }
`;

interface Pane { view: View3D; last: View3D | null; el: HTMLElement; cv?: HTMLCanvasElement; sel: HTMLSelectElement }
const panes: Pane[] = [];
let layout: 1 | 2 | 4 = 1;
let active = 0;
let host: HTMLElement;
const states = new Map<string, ViewState>();
const r2 = new MotionRenderer(sources);
let seqPath: string | undefined;

const main = () => panes[panes.length - 1];
export const viewsState = () => ({ layout, active, views: panes.map((p) => p.view), last: panes.map((p) => p.last), states: Object.fromEntries(states) });
export function stateOf(c: Comp, v: View3D): ViewState {
  const k = `${c.id}|${v}`;
  let s = states.get(k);
  if (!s) { s = defaultViewState(c, v, adv.time); states.set(k, s); }
  return s;
}
function save() { try { localStorage.setItem('cinta.adv.views', JSON.stringify({ layout, views: panes.map((p) => p.view) })); } catch { /* private */ } }

/** Builds the views around the composition viewer (called once when the advanced layout is built). */
export function initViews(viewer: HTMLElement, vbar: HTMLElement) {
  css('vistas', CSS);
  host = h('div', { id: 'adv-views', dataset: { n: '1', test: 'adv-views' } });
  viewer.replaceWith(host);
  host.append(viewer);
  const mainSel = viewSelect(() => main());
  viewer.append(mainSel);
  panes.push({ view: 'active', last: null, el: viewer, sel: mainSel });
  viewer.addEventListener('pointerdown', () => setActive(panes.length - 1), true);
  // the button bar: Select View Layout and the 3D view of the active view
  const lay = h('select', { title: 'Seleccionar disposición de vistas', dataset: { test: 'adv-layout' } }, ...VIEW_LAYOUTS.map((l) => h('option', { value: String(l.n) }, l.name))) as HTMLSelectElement;
  lay.onchange = () => setLayout(Number(lay.value) as 1 | 2 | 4);
  const v3 = h('select', { title: 'Vista 3D', dataset: { test: 'adv-view3d' } }, ...VIEWS_3D.map((v) => h('option', { value: v.id }, v.label))) as HTMLSelectElement;
  v3.onchange = () => setView(active, v3.value as View3D);
  vbar.append(v3, lay);
  const sync = () => { lay.value = String(layout); v3.value = panes[active]?.view ?? 'active'; panes.forEach((p, i) => { p.sel.value = p.view; p.el.classList.toggle('vactive', i === active); }); };
  syncUi = sync;
  hooks();
  adv.on((why) => {
    if (why === 'tool') panes.forEach((p) => { p.el.dataset.tool = adv.tool; });
    if (why === 'comp' || why === 'time' || why === 'select' || why === 'view') schedule();
    if (why === 'play' && !adv.playing) schedule();
  });
  store.on(() => schedule());
  new ResizeObserver(() => schedule()).observe(host);
  void api.invoke('motion:sequence').then((p: string | undefined) => { seqPath = p; });
  // the last layout comes back
  try {
    const o = JSON.parse(localStorage.getItem('cinta.adv.views') ?? 'null') as { layout: 1 | 2 | 4; views: View3D[] } | null;
    if (o && [1, 2, 4].includes(o.layout)) { setLayout(o.layout); o.views.forEach((v, i) => { if (panes[i] && VIEWS_3D.some((x) => x.id === v)) panes[i].view = v; }); }
  } catch { /* none */ }
  applyMain();
  sync();
  // hook for the self-test of the «paneles» line
  (window as unknown as { __paneles: unknown }).__paneles = { views: viewsState, shortcuts: shortcutsState, flow: flowState, media: mediaBrowserState, meta: metadataState, browseTo };
}
let syncUi = () => {};

function viewSelect(pane: () => Pane): HTMLSelectElement {
  const s = h('select', { class: 'adv-vsel', title: 'Vista 3D', dataset: { test: 'adv-vsel' } }, ...VIEWS_3D.map((v) => h('option', { value: v.id }, v.label))) as HTMLSelectElement;
  s.addEventListener('pointerdown', (e) => e.stopPropagation());
  s.onchange = () => setView(panes.indexOf(pane()), s.value as View3D);
  return s;
}

/** Select View Layout: 1, 2 or 4 views (the views get After Effects' default 3D views). */
export function setLayout(n: 1 | 2 | 4) {
  if (!host) return;
  const want = LAYOUT_VIEWS[n];
  const m = main();
  // secondary panes: as many as needed, before the composition viewer
  while (panes.length > n) { const p = panes.shift()!; p.el.remove(); }
  while (panes.length < n) {
    const p: Pane = { view: 'active', last: null, el: h('section', { class: 'adv-pane', dataset: { test: 'adv-pane', tool: adv.tool } }), sel: null as unknown as HTMLSelectElement };
    p.cv = h('canvas', {}) as HTMLCanvasElement;
    p.sel = viewSelect(() => p);
    p.el.append(p.cv, p.sel);
    p.el.addEventListener('pointerdown', (e) => paneDown(p, e));
    p.el.addEventListener('wheel', (e) => { e.preventDefault(); const c = adv.comp(); if (!c || p.view === 'active') return; const s = stateOf(c, p.view); states.set(`${c.id}|${p.view}`, moveView(c, p.view, s, 'dolly', 0, e.deltaY * 0.5, adv.time)); schedule(); }, { passive: false });
    panes.unshift(p);
    host.insertBefore(p.el, m.el);
  }
  // After Effects' defaults for the layout (the composition viewer keeps its own view when going back to one)
  if (n > 1) panes.forEach((p, i) => { p.view = want[i]; p.last = null; });
  layout = n;
  host.dataset.n = String(n);
  active = Math.min(active, panes.length - 1);
  if (n === 1) active = 0;
  applyMain();
  save();
  syncUi();
  schedule();
  dispatchEvent(new Event('resize'));
}
function setActive(i: number) { if (active === i) return; active = i; syncUi(); }

/** Switch 3D View of a view (the active one by default). */
export function setView(i: number, v: View3D) {
  const p = panes[i];
  if (!p || p.view === v) return;
  p.last = p.view;
  p.view = v;
  active = i;
  if (p === main()) applyMain();
  save();
  syncUi();
  schedule();
}
/** View ▸ Switch to Last 3D View (Esc): false when there is nothing to go back to. */
function lastView(): boolean {
  const p = panes[active], c = adv.comp();
  if (!p?.last || !c || !has3D(c)) return false;
  setView(active, p.last);
  return true;
}

/** The composition viewer through its 3D view: the comp it renders, and wireframes over it. */
function applyMain() {
  const p = main();
  if (!p) return;
  if (p.view === 'active') { viewHooks.renderComp = null; viewHooks.overlay = null; }
  else {
    const v = p.view;
    viewHooks.renderComp = (c) => viewComp(c, v, stateOf(c, v), adv.time);
    viewHooks.overlay = (g, c, toScreen) => drawWire(g, c, v, toScreen);
  }
  requestRender();
  drawViewer();
}
function drawWire(g: CanvasRenderingContext2D, c: Comp, v: View3D, toScreen: (x: number, y: number) => [number, number]) {
  const w = wireframes(c, v, stateOf(c, v), adv.time);
  g.save();
  g.lineWidth = 1;
  for (const l of w.lines) {
    const a = toScreen(l.a[0], l.a[1]), b = toScreen(l.b[0], l.b[1]);
    g.strokeStyle = l.layer && adv.selection.has(l.layer) ? '#ffffff' : l.color;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  }
  g.font = '11px sans-serif';
  for (const t of w.labels) { const a = toScreen(t.at[0], t.at[1]); g.fillStyle = t.color; g.fillText(t.text, a[0], a[1]); }
  g.restore();
}

// ───────────────────────── rendering of the other views ─────────────────────────
let timer = 0, busy = false, again = false;
function schedule() { clearTimeout(timer); timer = window.setTimeout(() => void renderPanes(), 60); }
async function renderPanes() {
  if (busy) { again = true; return; }
  if (adv.playing || panes.length < 2) return;
  busy = true;
  try {
    for (const p of panes.slice(0, -1)) await renderPane(p);
  } catch (e) { console.error(e); } finally { busy = false; }
  if (again) { again = false; schedule(); }
}
/** what each secondary view shows: frame placement (for pointer → comp) */
const placed = new WeakMap<Pane, { ox: number; oy: number; s: number }>();
async function renderPane(p: Pane) {
  const cv = p.cv!, r = p.el.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  const c = adv.comp();
  let frame: HTMLCanvasElement | null = null;
  if (c) {
    const rc = p.view === 'active' ? c : viewComp(c, p.view, stateOf(c, p.view), adv.time);
    // the light memo is keyed by comp and time: another view of the same frame must not reuse it
    (r2 as unknown as { litMemo?: Map<string, unknown> }).litMemo?.clear();
    frame = await r2.render(store.project, rc, adv.time, { scale: Math.min(adv.res, 0.5), sequencePath: seqPath, mbSamples: 1 });
  }
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1b1d24'; g.fillRect(0, 0, r.width, r.height);
  if (!c || !frame) return;
  const s = Math.min((r.width - 16) / c.width, (r.height - 16) / c.height), ox = (r.width - c.width * s) / 2, oy = (r.height - c.height * s) / 2;
  placed.set(p, { ox, oy, s });
  g.drawImage(frame, ox, oy, c.width * s, c.height * s);
  g.strokeStyle = '#000'; g.strokeRect(ox - 0.5, oy - 0.5, c.width * s + 1, c.height * s + 1);
  if (p.view !== 'active') drawWire(g, c, p.view, (x, y) => [ox + x * s, oy + y * s]);
}

// ───────────────────────── camera tools ─────────────────────────
const CAM_TOOLS: Tool[] = ['orbit', 'pan3d', 'dolly'];
const isCamTool = (t: Tool) => CAM_TOOLS.includes(t);
const toolKind = (t: Tool) => (t === 'orbit' ? 'orbit' : t === 'pan3d' ? 'pan' : 'dolly') as 'orbit' | 'pan' | 'dolly';
/** A camera-tool drag in a view: the view's own state, or the active camera layer in the active camera view. */
function camDrag(view: View3D, e: PointerEvent, el: HTMLElement) {
  const c = adv.comp();
  if (!c) return;
  const kind = toolKind(adv.tool), x0 = e.clientX, y0 = e.clientY;
  let move: (dx: number, dy: number) => void, end: () => void;
  if (view === 'active') {
    const cam = cameraAt(c, adv.time);
    if (!cam.layer) { toast('La composición no tiene cámara: cree una (Capa ▸ Nuevo ▸ Cámara) o use otra vista 3D.', true); return; }
    const cl: Layer = cam.layer;
    const pos0 = layerTransform(c, cl, adv.time).position, poi0 = keyedAt(cl.camera!.poi, adv.time, true) as number[];
    move = (dx, dy) => {
      const w = adv.begin(), wl = w?.layers.find((l) => l.id === cl.id);
      if (!wl) return;
      const r = moveCamera(pos0, poi0, cam.view, cam.zoom, kind, dx, dy);
      setProp(wl, 'transform.position', r.pos);
      setProp(wl, 'camera.poi', r.poi);
      adv.emit('comp');
    };
    end = () => void adv.commit(kind === 'orbit' ? 'Cámara orbital' : kind === 'pan' ? 'Cámara panorámica' : 'Cámara de travelling');
  } else {
    if (kind === 'orbit' && isOrtho(view)) { toast('Las vistas ortogonales no se pueden orbitar: use una vista personalizada o la cámara activa.', true); return; }
    const k = `${c.id}|${view}`, s0 = stateOf(c, view);
    move = (dx, dy) => { states.set(k, moveView(c, view, s0, kind, dx, dy, adv.time)); if (main().view === view) { requestRender(); drawViewer(); } schedule(); };
    end = () => {};
  }
  try { el.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  const mv = (ev: PointerEvent) => move(ev.clientX - x0, ev.clientY - y0);
  const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); end(); };
  el.addEventListener('pointermove', mv);
  el.addEventListener('pointerup', up);
}
function paneDown(p: Pane, e: PointerEvent) {
  setActive(panes.indexOf(p));
  if (e.button !== 0 || !isCamTool(adv.tool)) return;
  e.preventDefault();
  camDrag(p.view, e, p.el);
}
function hooks() {
  viewHooks.down = (e) => {
    if (isCamTool(adv.tool)) { camDrag(main().view, e, e.currentTarget as HTMLElement ?? main().el); return true; }
    // in another 3D view the viewer only selects (the 2D handles would move layers on the wrong axes)
    if (main().view !== 'active' && adv.tool === 'select') {
      const c = adv.comp();
      if (!c) return true;
      const p = toCompOf(e);
      const l = c.layers.find((x) => !x.hidden && !x.locked && x.type !== 'camera' && x.type !== 'light' && adv.time >= x.in && adv.time < x.out && inQuad(p, renderer.boxes.get(x.id)));
      adv.select(l ? [l.id] : [], e.shiftKey);
      return true;
    }
    return false;
  };
}
/** pointer → comp pixels of the composition viewer (inverse of its comp → client mapping) */
function toCompOf(e: PointerEvent): [number, number] {
  const [x0, y0] = compToClient(0, 0), [x1, y1] = compToClient(100, 100);
  return [((e.clientX - x0) / (x1 - x0 || 1)) * 100, ((e.clientY - y0) / (y1 - y0 || 1)) * 100];
}
function inQuad(p: [number, number], q?: [number, number][]) {
  if (!q) return false;
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

// ───────────────────────── commands ─────────────────────────
const toolSet = (t: Tool) => () => { document.dispatchEvent(new CustomEvent('adv:tool', { detail: t })); };
const view = (v: View3D) => () => setView(active, v);
bindCommands({
  'view-active': view('active'), 'view-front': view('front'), 'view-left': view('left'), 'view-top': view('top'), 'view-back': view('back'),
  'view-right': view('right'), 'view-bottom': view('bottom'), 'view-custom1': view('custom1'), 'view-custom2': view('custom2'), 'view-custom3': view('custom3'),
  'last-3d-view': () => lastView(),
  'reset-3d-view': () => {
    const c = adv.comp(), p = panes[active];
    if (!c || !p) return;
    if (p.view === 'active') { toast('La vista de la cámara activa sigue a la cámara: mueva la cámara con sus herramientas.'); return; }
    states.delete(`${c.id}|${p.view}`);
    if (p === main()) applyMain();
    schedule();
  },
  'layout-1': () => setLayout(1), 'layout-2': () => setLayout(2), 'layout-4': () => setLayout(4),
  'tool-orbit': toolSet('orbit'), 'tool-pan3d': toolSet('pan3d'), 'tool-dolly': toolSet('dolly'),
  'tool-camera': () => { const i = CAM_TOOLS.indexOf(adv.tool); toolSet(CAM_TOOLS[(i + 1) % CAM_TOOLS.length])(); },
});
/** Tooltips of the camera tools (with their current keys). */
export const cameraToolTips = () => ({ orbit: `Cámara orbital: girar alrededor del punto de interés de la cámara (${keysOf('tool-orbit')})`, pan3d: `Cámara panorámica (${keysOf('tool-pan3d')})`, dolly: `Cámara de travelling: acercarse al punto de interés de la cámara y alejarse de este (${keysOf('tool-dolly')})` });
