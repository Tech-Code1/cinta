// «capas» in the window: the Composición ▸ menu (Separar comp. del entorno de trabajo, Recortar comp. según región de
// interés, Diseño interactivo: tiempo), Capa de guía and Máscara y trazado de forma ▸ RotoBézier in the layer menus,
// the Región de interés button of the Composition panel (draw, switch, Alt+clic resets), the Herramienta Calado de
// máscara (feather points on the mask edge), composition markers on the time ruler (protected regions) and keys.
import { apply, invert, worldMatrix } from '../../core/motion/geom';
import { keyedAt } from '../../core/motion/anim';
import { featherContour, featherRadii, maskPointAt, nearestOnMask, rotoFlat, sampleMask } from '../../core/motion/capas';
import type { Comp, CompMarker, Layer } from '../../core/motion/model';
import { modal } from '../dialogs';
import { contextMenu } from '../player';
import { h, toast } from '../store';
import { adv, mop } from './state';

type Item = { label?: string; kbd?: string; fn?: () => void; sep?: boolean; disabled?: boolean };
const check = (on: boolean | undefined, label: string) => `${on ? '✓ ' : ''}${label}`;

// ───────────────────────── menus ─────────────────────────
/** Composición ▸ (the header button): settings, crops and Responsive Design – Time. */
export function compMenu(e: MouseEvent, settings: () => void) {
  const c = adv.comp();
  if (!c) { settings(); return; }
  contextMenu(e, [
    { label: 'Configuración de composición…', kbd: 'Ctrl+K', fn: settings },
    { sep: true },
    { label: 'Recortar comp. según región de interés', disabled: !c.roi, fn: () => void cropRoi(c) },
    { label: 'Separar comp. del entorno de trabajo', kbd: 'Ctrl+Mayús+X', fn: () => void cropWorkArea(c) },
    { sep: true },
    { label: 'Diseño interactivo: tiempo ▸', fn: () => contextMenu(e, rdtItems(c)) },
  ]);
}
function rdtItems(c: Comp): Item[] {
  return [
    { label: 'Crear Intro', fn: () => void mop('responsiveTime', c.id, 'intro', adv.time) },
    { label: 'Crear Outro', fn: () => void mop('responsiveTime', c.id, 'outro', adv.time) },
    { label: 'Crear zona protegida desde el área de trabajo', fn: () => void mop('responsiveTime', c.id, 'workArea') },
    { label: 'Habilitar zona protegida en todos los marcadores', disabled: !c.markers.length, fn: () => void mop('responsiveTime', c.id, 'markers') },
  ];
}
async function cropWorkArea(c: Comp) { if (await mop('compCropWorkArea', c.id)) { adv.seek(0); } }
async function cropRoi(c: Comp) { if (await mop('compCropRoi', c.id)) toast('Composición recortada a la región de interés.'); }

/** Layer menu items (timeline right-click and the header's Capa ▸): Capa de guía and RotoBézier. */
export function capasLayerItems(c: Comp, l: Layer, e: MouseEvent): Item[] {
  const ids = adv.selection.has(l.id) ? [...adv.selection] : [l.id];
  const items: Item[] = [{ label: check(l.guide, 'Capa de guía'), fn: () => void mop('layerGuide', c.id, ids) }];
  if (l.masks.length) {
    const roto = l.masks.every((m) => m.rotoBezier);
    items.push({ label: 'Máscara y trazado de forma ▸', fn: () => contextMenu(e, [{ label: check(roto, 'RotoBézier'), fn: () => void mop('maskRoto', c.id, l.id, 'all', !roto) }]) });
  }
  return items;
}
/** RotoBézier switch on a mask row of the timeline. */
export function maskRotoBox(c: Comp, l: Layer, mid: string): HTMLElement {
  const m = l.masks.find((x) => x.id === mid);
  const box = h('input', { type: 'checkbox', checked: !!m?.rotoBezier, dataset: { test: 'mask-roto' } }) as HTMLInputElement;
  box.onchange = () => void mop('maskRoto', c.id, l.id, [mid], box.checked);
  return h('label', { title: 'RotoBézier: la curva pasa suave por los vértices (tangentes automáticas)' }, box, ' RotoBézier');
}
/** The guide icon next to a guide layer's name in the timeline. */
export function guideIcon(l: Layer): HTMLElement | null {
  return l.guide ? h('span', { class: 'guide-ic', title: 'Capa de guía: se ve en el panel Composición, no se procesa ni se exporta', dataset: { test: 'layer-guide-ic' }, style: { color: '#7fb2ff', marginRight: '3px' } }, '⊟') : null;
}

// ───────────────────────── keys ─────────────────────────
/** Ctrl+Mayús+X (Separar comp. del entorno de trabajo), * of the numeric keypad (comp marker), G (Pluma ↔ Calado de
 *  máscara, like After Effects' preference "the Pen tool shortcut toggles Pen and Mask Feather"), Esc (ROI drawing). */
export function capasKey(e: KeyboardEvent, setTool: (t: 'pen' | 'feather') => void): boolean {
  const c = adv.comp(), k = e.key, ctrl = e.ctrlKey || e.metaKey;
  const run = (fn: () => void) => { e.preventDefault(); fn(); return true; };
  if (ctrl && e.shiftKey && !e.altKey && k.toLowerCase() === 'x' && c) return run(() => void cropWorkArea(c));
  if (!ctrl && !e.altKey && (e.code === 'NumpadMultiply' || (k === '*' && !e.shiftKey)) && c) return run(() => void mop('markerAdd', c.id, { t: adv.time }));
  if (!ctrl && !e.altKey && !e.shiftKey && k.toLowerCase() === 'g' && (adv.tool === 'pen' || adv.tool === 'feather')) return run(() => setTool(adv.tool === 'pen' ? 'feather' : 'pen'));
  if (k === 'Escape' && roiArmed) return run(() => { roiArmed = false; adv.emit('view'); });
  return false;
}

// ───────────────────────── region of interest ─────────────────────────
let roiArmed = false;
let roiDrag: { p0: [number, number]; p1: [number, number] } | null = null;
/** The Región de interés button of the Composition panel: clic draws one (or switches it), Alt+clic resets it. */
export function roiButton(): HTMLElement {
  const b = h('button', { class: 'tb', title: 'Región de interés\nPulse Alt y haga clic para restablecer', dataset: { test: 'adv-roi' } }, '⬚ RDI') as HTMLButtonElement;
  b.onclick = (e: MouseEvent) => {
    const c = adv.comp();
    if (!c) return;
    if (e.altKey) { roiArmed = false; if (c.roi) void mop('compRoi', c.id, { rect: null }); else adv.emit('view'); return; }
    if (!c.roi) { roiArmed = !roiArmed; adv.emit('view'); if (roiArmed) toast('Dibuje la región de interés en el panel Composición.'); return; }
    void mop('compRoi', c.id, { on: !c.roi.on });
  };
  const sync = () => { const c = adv.comp(); b.classList.toggle('on', roiArmed || !!c?.roi?.on); };
  adv.on((why) => { if (why === 'comp' || why === 'view') sync(); });
  return b;
}

// ───────────────────────── viewer: pointer and overlay ─────────────────────────
export interface CapasView { c: Comp; stage: HTMLElement; toComp: (e: { clientX: number; clientY: number }) => [number, number]; toScreen: (x: number, y: number) => [number, number]; draw: () => void }

/** Viewer pointer-down: the ROI being drawn, or the Mask Feather tool. true when handled. */
export function capasDown(e: PointerEvent, v: CapasView): boolean {
  if (e.button !== 0) return false;
  if (roiArmed) { const p = v.toComp(e); roiDrag = { p0: p, p1: p }; follow(e, v, (ev) => { roiDrag!.p1 = v.toComp(ev); v.draw(); }, () => void endRoi(v)); return true; }
  if (adv.tool === 'feather') { featherDown(e, v); return true; }
  return false;
}
async function endRoi(v: CapasView) {
  const d = roiDrag;
  roiDrag = null; roiArmed = false;
  if (!d) return;
  const x = Math.min(d.p0[0], d.p1[0]), y = Math.min(d.p0[1], d.p1[1]), w = Math.abs(d.p1[0] - d.p0[0]), hh = Math.abs(d.p1[1] - d.p0[1]);
  if (w < 4 || hh < 4) { adv.emit('view'); v.draw(); return; }
  await mop('compRoi', v.c.id, { rect: [x, y, w, hh], on: true });
}
function follow(e: PointerEvent, v: CapasView, mv: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void) {
  try { v.stage.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  const m = (ev: PointerEvent) => mv(ev);
  const u = (ev: PointerEvent) => { v.stage.removeEventListener('pointermove', m); v.stage.removeEventListener('pointerup', u); up(ev); };
  v.stage.addEventListener('pointermove', m);
  v.stage.addEventListener('pointerup', u);
}

/** mask path (RotoBézier applied) of a layer at the current time, in layer px */
const flatOf = (m: Layer['masks'][number]) => rotoFlat(m, keyedAt(m.path, adv.time) as number[]);
/** where a feather point's handle is: on the edge, moved out (or in) by its radius */
function handleOf(flat: number[], f: { seg: number; u: number; r: number }) { const p = maskPointAt(flat, f.seg, f.u); return { ...p, hx: p.x + p.nx * f.r, hy: p.y + p.ny * f.r }; }

/** Mask Feather tool: clic on a mask edge adds a feather point and dragging sets its radius (out / in); dragging a
 *  point changes its radius; Alt+drag its tension; Alt+clic removes it. */
function featherDown(e: PointerEvent, v: CapasView) {
  const c = v.c, l = adv.first() ?? c.layers.find((x) => x.masks.length && !x.locked && !x.hidden);
  if (!l || !l.masks.length) { toast('Seleccione una capa con máscara: la herramienta Calado de máscara añade puntos de calado en su borde.', true); return; }
  if (!adv.selection.has(l.id)) adv.select([l.id]);
  const W = worldMatrix(c, l, adv.time), inv = invert(W);
  const r = v.stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const scr = (x: number, y: number) => { const q = apply(W, x, y); return v.toScreen(q[0], q[1]); };
  // an existing point?
  for (const m of l.masks) {
    const flat = flatOf(m);
    const i = (m.featherPts ?? []).findIndex((f) => { const hp = handleOf(flat, f); const [sx, sy] = scr(hp.hx, hp.hy); return Math.hypot(sx - mx, sy - my) < 8; });
    if (i >= 0) { dragPoint(e, v, l, m.id, i, e.altKey); return; }
  }
  if (e.altKey) return;
  // the nearest mask edge (within 10 screen px)
  const pc = v.toComp(e), q = apply(inv, pc[0], pc[1]);
  let best: { mask: string; seg: number; u: number; d: number } | null = null;
  for (const m of l.masks) {
    const n = nearestOnMask(flatOf(m), q[0], q[1]);
    if (!n) continue;
    const [sx, sy] = scr(n.x, n.y);
    const d = Math.hypot(sx - mx, sy - my);
    if (d < 10 && (!best || d < best.d)) best = { mask: m.id, seg: n.seg, u: n.u, d };
  }
  if (!best) { toast('Haga clic sobre el borde de una máscara para añadir un punto de calado.'); return; }
  const w = adv.begin();
  const wm = w?.layers.find((x) => x.id === l.id)?.masks.find((x) => x.id === best!.mask);
  if (!wm) return;
  (wm.featherPts ??= []).push({ seg: best.seg, u: best.u, r: 0, tension: 0 });
  wm.featherPts.sort((a, b) => a.seg - b.seg || a.u - b.u);
  const idx = wm.featherPts.findIndex((f) => f.seg === best!.seg && f.u === best!.u);
  dragPoint(e, v, l, wm.id, idx, false, true);
}
function dragPoint(e: PointerEvent, v: CapasView, l: Layer, maskId: string, idx: number, alt: boolean, fresh = false) {
  const c = v.c, x0 = e.clientX;
  let moved = false;
  const w = adv.begin();
  const wm = () => w?.layers.find((x) => x.id === l.id)?.masks.find((x) => x.id === maskId);
  const t0 = wm()?.featherPts?.[idx]?.tension ?? 0;
  follow(e, v, (ev) => {
    const m = wm(), f = m?.featherPts?.[idx];
    if (!m || !f) return;
    if (Math.abs(ev.clientX - x0) > 2) moved = true;
    if (alt) { f.tension = Math.max(0, Math.min(100, Math.round(t0 + (ev.clientX - x0) / 2))); }
    else {
      const p = v.toComp(ev), q = apply(invert(worldMatrix(c, l, adv.time)), p[0], p[1]);
      const pt = maskPointAt(flatOf(m), f.seg, f.u);
      f.r = Math.round(((q[0] - pt.x) * pt.nx + (q[1] - pt.y) * pt.ny) * 10) / 10;
      moved = true;
    }
    adv.emit('comp');
  }, () => {
    if (alt && !moved) { const m = wm(); m?.featherPts?.splice(idx, 1); if (m?.featherPts && !m.featherPts.length) delete m.featherPts; }
    void adv.commit(fresh ? 'Añadir punto de calado' : alt && !moved ? 'Eliminar punto de calado' : 'Calado de máscara');
  });
}

/** Viewer overlay: the region of interest (or the one being drawn) and the feather points of the selected layer. */
export function capasOverlay(g: CanvasRenderingContext2D, c: Comp, toScreen: (x: number, y: number) => [number, number]) {
  g.save();
  const box = (x: number, y: number, w: number, hh: number) => { const a = toScreen(x, y), b = toScreen(x + w, y + hh); g.strokeRect(a[0] + 0.5, a[1] + 0.5, b[0] - a[0], b[1] - a[1]); };
  if (roiDrag) { g.strokeStyle = '#ffffff'; g.setLineDash([4, 3]); const [a, b] = [roiDrag.p0, roiDrag.p1]; box(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); }
  else if (c.roi?.on) { g.strokeStyle = 'rgba(255,255,255,0.8)'; g.setLineDash([]); box(...c.roi.rect); }
  g.setLineDash([]);
  const l = adv.first();
  if (l && (adv.tool === 'feather' || l.masks.some((m) => m.featherPts?.length)) && adv.selection.size === 1) {
    const W = worldMatrix(c, l, adv.time), scr = (x: number, y: number) => { const q = apply(W, x, y); return toScreen(q[0], q[1]); };
    for (const m of l.masks) {
      const flat = flatOf(m);
      if (!m.featherPts?.length || flat.length < 18) continue;
      // the feathered boundary (dashed) and each point: on the edge, a line to its handle
      const { pts, length, area } = sampleMask(flat, 16);
      const rad = featherRadii(pts, length, m.featherPts);
      const outer = featherContour(pts, rad, area, 0);
      g.strokeStyle = 'rgba(255,212,0,0.8)'; g.setLineDash([3, 3]);
      g.beginPath();
      for (let i = 0; i < outer.length; i += 2) { const [x, y] = scr(outer[i], outer[i + 1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath(); g.stroke(); g.setLineDash([]);
      for (const f of m.featherPts) {
        const hp = handleOf(flat, f), [ex, ey] = scr(hp.x, hp.y), [hx, hy] = scr(hp.hx, hp.hy);
        g.strokeStyle = '#ffd400'; g.beginPath(); g.moveTo(ex, ey); g.lineTo(hx, hy); g.stroke();
        g.fillStyle = '#ffd400'; g.beginPath(); g.arc(hx, hy, 4, 0, Math.PI * 2); g.fill();
      }
    }
  }
  g.restore();
}

// ───────────────────────── composition markers on the ruler ─────────────────────────
const MK_Y0 = 11, MK_Y1 = 22;
/** Comp markers (green tabs with their comment) and protected regions (a band) on the time ruler. */
export function drawCompMarkers(g: CanvasRenderingContext2D, c: Comp, t2x: (t: number) => number, W: number) {
  for (const m of c.markers) {
    const x = t2x(m.t), x1 = t2x(m.t + (m.dur ?? 0));
    if (x1 < -20 || x > W + 20) continue;
    if (m.dur) {
      g.fillStyle = m.protected ? 'rgba(120,180,255,0.45)' : 'rgba(140,200,120,0.35)';
      g.fillRect(x, MK_Y1 - 4, x1 - x, 4);
      if (m.protected) { g.strokeStyle = 'rgba(160,205,255,0.9)'; g.beginPath(); for (let k = x; k < x1; k += 5) { g.moveTo(k, MK_Y1); g.lineTo(Math.min(x1, k + 3), MK_Y1 - 4); } g.stroke(); }
    }
    g.fillStyle = m.protected ? '#78b4ff' : '#8cc878';
    g.beginPath(); g.moveTo(x - 4, MK_Y0); g.lineTo(x + 4, MK_Y0); g.lineTo(x + 4, MK_Y1 - 6); g.lineTo(x, MK_Y1 - 2); g.lineTo(x - 4, MK_Y1 - 6); g.closePath(); g.fill();
    if (m.name) { g.fillStyle = '#d6dae6'; g.font = '10px Segoe UI'; g.fillText(m.name, x + 6, MK_Y1 - 5); }
  }
}
/** Ruler pointer handling for markers (capture phase, before seeking): drag a marker in time, double-clic opens its
 *  settings, right-clic its menu. */
export function rulerMarkerEvents(ruler: HTMLCanvasElement, t2x: (c: Comp, t: number) => number, x2t: (c: Comp, x: number) => number, redraw: () => void) {
  const at = (e: MouseEvent): { c: Comp; i: number } | null => {
    const c = adv.comp();
    if (!c) return null;
    const r = ruler.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < MK_Y0 || y > MK_Y1) return null;
    const i = c.markers.findIndex((m) => Math.abs(t2x(c, m.t) - x) <= 5);
    return i >= 0 ? { c, i } : null;
  };
  ruler.addEventListener('pointerdown', (e) => {
    const hit = at(e);
    if (!hit || e.button !== 0) return;
    e.stopImmediatePropagation();
    const { c, i } = hit, r = ruler.getBoundingClientRect();
    try { ruler.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    let moved = false;
    const mv = (ev: PointerEvent) => {
      const t = Math.max(0, Math.min(c.duration, Math.round(x2t(c, ev.clientX - r.left) * c.fps) / c.fps));
      const w = adv.begin();
      const m = w?.markers[i];
      if (!m || Math.abs(m.t - t) < 1e-9) return;
      m.t = t; moved = true;
      redraw();
    };
    const up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); if (moved) { adv.work?.markers.sort((a, b) => a.t - b.t); void adv.commit('Mover marcador'); } };
    ruler.addEventListener('pointermove', mv);
    ruler.addEventListener('pointerup', up);
  }, true);
  ruler.addEventListener('dblclick', (e) => { const hit = at(e); if (hit) markerDialog(hit.c, hit.i); });
  ruler.addEventListener('contextmenu', (e) => {
    const hit = at(e);
    const c = adv.comp();
    if (!c) return;
    if (!hit) { contextMenu(e, [{ label: 'Añadir marcador', kbd: '*', fn: () => void mop('markerAdd', c.id, { t: adv.time }) }, { sep: true }, ...rdtItems(c)]); return; }
    const m = c.markers[hit.i];
    contextMenu(e, [
      { label: 'Configuración del marcador…', fn: () => markerDialog(c, hit.i) },
      { label: check(m.protected, 'Habilitar zona protegida'), fn: () => void mop('markerSet', c.id, hit.i, { protected: !m.protected }) },
      { sep: true },
      { label: 'Eliminar este marcador', fn: () => void mop('markerSet', c.id, hit.i, { remove: true }) },
    ]);
  });
}
/** The marker dialog (After Effects: Comentario, Duración, Diseño interactivo: tiempo ▸ Zona protegida). */
export function markerDialog(c: Comp, i: number) {
  const m: CompMarker = c.markers[i];
  if (!m) return;
  const row = (label: string, ...kids: (Node | string)[]) => h('div', { class: 'frow' }, h('label', {}, label), h('div', { class: 'fval' }, ...kids));
  const name = h('input', { value: m.name, dataset: { test: 'marker-name' } }) as HTMLInputElement;
  const time = h('input', { type: 'number', step: String(1 / c.fps), value: String(m.t), style: { width: '90px' }, dataset: { test: 'marker-time' } }) as HTMLInputElement;
  const dur = h('input', { type: 'number', step: String(1 / c.fps), min: '0', value: String(m.dur ?? 0), style: { width: '90px' }, dataset: { test: 'marker-dur' } }) as HTMLInputElement;
  const prot = h('input', { type: 'checkbox', checked: !!m.protected, dataset: { test: 'marker-protected' } }) as HTMLInputElement;
  const dlg = modal('Marcador de composición', [
    row('Hora (s)', time), row('Duración (s)', dur), row('Comentario', name),
    row('Diseño interactivo: tiempo', h('label', { title: 'Al ajustar los puntos de entrada y salida de la composición, se mantendrá la duración de las zonas protegidas y se adaptará la de las no protegidas.' }, prot, ' Zona protegida')),
  ], [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancelar'),
    h('button', { class: 'btn primary', dataset: { test: 'marker-ok' }, onclick: () => {
      dlg.close();
      void mop('markerSet', c.id, i, { t: Number(time.value) || 0, dur: Math.max(0, Number(dur.value) || 0), name: name.value, protected: prot.checked });
    } }, 'Aceptar'),
  ], { width: 460 });
}
