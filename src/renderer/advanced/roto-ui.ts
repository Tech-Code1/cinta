// «ia» in the window: the Roto Brush and Refine Edge tools (Alt+W, Alt+W again switches between them), the strokes
// and the propagated outline drawn over the viewer, the extra controls of «Pincel rotoscopia y Perf. borde» in
// Effect Controls (propagation progress, Freeze, span, strokes) and the Content-Aware Fill panel.
// Like the paint tools, Cinta paints in the COMPOSITION viewer over the selected layer (After Effects uses the Layer
// panel): the pointer is mapped to the layer's own pixels, so the strokes are stored in layer space as in AE.
// Drag paints foreground (green), Alt+drag background (red); with Refine Edge, Alt+drag erases refinement;
// Ctrl+drag left / right changes the brush size, as in After Effects.
import { apply, invert, worldMatrix } from '../../core/motion/geom';
import type { Comp, FxInstance, Layer } from '../../core/motion/model';
import { rleDecode, rotoFrame, rotoKey, rotoSpan, rotoStatus, ROTO_KIND_NAMES, type RotoKind } from '../../core/motion/roto';
import { rotoBusy } from '../../motion-render/roto';
import { api, cleanErr, h, store, toast } from '../store';
import { adv, mop, type Tool } from './state';

export const ROTO_TOOLS: Tool[] = ['roto', 'refine'];
export const isRotoTool = (t: Tool) => t === 'roto' || t === 'refine';
let lastRoto: Tool = 'roto';
/** Alt+W: Roto Brush ↔ Refine Edge (from any other tool: the last one used) */
export function nextRotoTool(t: Tool): Tool { const n = isRotoTool(t) ? (t === 'roto' ? 'refine' : 'roto') : lastRoto; lastRoto = n; return n; }

const KEY = 'cinta.adv.roto';
const size = (() => { try { const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { roto?: number; refine?: number } | null; return { roto: s?.roto ?? 30, refine: s?.refine ?? 12 }; } catch { return { roto: 30, refine: 12 }; } })();
const saveSize = () => { try { localStorage.setItem(KEY, JSON.stringify(size)); } catch { /* private */ } };
const diameter = () => (adv.tool === 'refine' ? size.refine : size.roto);

// ───────────────────────── propagation ─────────────────────────
const started = new Set<string>();
export function expectedKey(c: Comp, l: Layer, f: FxInstance): string | null {
  const m = store.project.media.find((x) => x.id === l.mediaId);
  if (!m?.path || (l.type !== 'video' && l.type !== 'image')) return null;
  return rotoKey(f, m.path, rotoSpan(l, m, c.fps, f.roto));
}
export async function propagate(c: Comp, l: Layer, force = false) {
  rotoBusy.set(l.id, { done: 0, total: 1 });
  adv.emit('comp');
  try { await api.invoke('roto:propagate', c.id, l.id, force); } catch (e) { const m = cleanErr(e); if (!/cancelada/.test(m)) toast(`Error de pincel tipo rotoscopia ${m}.`, true); }
  finally { rotoBusy.delete(l.id); adv.emit('comp'); }
}
/** Effects of the open comp whose propagation is stale (new strokes, Propagation parameters): propagate them. */
function autoPropagate() {
  const c = adv.comp();
  if (!c || adv.work) return;
  for (const l of c.layers) {
    const f = l.effects.find((x) => x.fx === 'rotoBrush');
    if (!f?.on || rotoBusy.has(l.id) || !f.roto?.strokes.length || f.roto.frozen) continue;
    const key = expectedKey(c, l, f);
    if (!key || f.roto.seg?.key === key || started.has(`${f.id}|${key}`)) continue;
    started.add(`${f.id}|${key}`);
    void propagate(c, l);
  }
}
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  (window as unknown as { __roto: unknown }).__roto = { busy: rotoBusy, size };
  api.on('roto:progress', (id, done, total) => {
    const lid = String(id), d = Number(done), n = Number(total);
    if (d < 0) return;
    rotoBusy.set(lid, { done: d, total: n });
    document.querySelectorAll<HTMLElement>(`[data-roto-status="${lid}"]`).forEach((el) => { el.textContent = `Propagación de Pincel tipo rotoscopia ${d} de ${n}`; });
  });
  api.on('caf:progress', (msg, frac) => {
    const el = document.querySelector<HTMLElement>('[data-test=caf-status]');
    if (el) el.textContent = Number(frac) < 0 ? '' : String(msg);
  });
  adv.on((why) => { if (why === 'comp') setTimeout(autoPropagate, 0); });
}
wire();

// ───────────────────────── viewer gesture ─────────────────────────
export interface RotoView { c: Comp; layer: Layer | undefined; stage: HTMLElement; toComp: (e: { clientX: number; clientY: number }) => [number, number]; draw: () => void; scale: number }
let live: { pts: [number, number][]; kind: RotoKind } | null = null;

export function rotoDown(e: PointerEvent, v: RotoView) {
  lastRoto = adv.tool;
  const l = v.layer;
  if (!l || (l.type !== 'video' && l.type !== 'image')) { toast('Utilice las herramientas Pintura, Pincel tipo rotoscopia y Perfeccionar borde sobre una capa de metraje (vídeo o imagen): selecciónela primero.', true); return; }
  if (!adv.selection.has(l.id)) adv.select([l.id]);
  const f = l.effects.find((x) => x.fx === 'rotoBrush');
  if (f?.roto?.frozen) { toast('La propagación de Pincel tipo rotoscopia y Perfeccionar borde está congelada. Descongelar para actualizarla.', true); return; }
  if (adv.tool === 'refine' && !f?.roto?.strokes.some((s) => s.kind === 'fg')) { toast('Para utilizar Perfeccionar borde, pinte en los bordes de alfa creados, por ejemplo, con el Pincel tipo rotoscopia o las máscaras.', true); return; }
  try { v.stage.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  // Ctrl+drag: brush size
  if (e.ctrlKey) {
    const x0 = e.clientX, d0 = diameter(), tool = adv.tool;
    const mv = (ev: PointerEvent) => { const d = Math.max(1, Math.min(500, Math.round(d0 + (ev.clientX - x0) / Math.max(0.05, v.scale)))); if (tool === 'refine') size.refine = d; else size.roto = d; v.draw(); };
    const up = () => { v.stage.removeEventListener('pointermove', mv); v.stage.removeEventListener('pointerup', up); saveSize(); };
    v.stage.addEventListener('pointermove', mv); v.stage.addEventListener('pointerup', up);
    return;
  }
  const kind: RotoKind = adv.tool === 'refine' ? (e.altKey ? 'unrefine' : 'refine') : e.altKey ? 'bg' : 'fg';
  const inv = invert(worldMatrix(v.c, l, adv.time));
  const toLayer = (p: [number, number]): [number, number] => { const q = apply(inv, p[0], p[1]); return [q[0], q[1]]; };
  const p0 = v.toComp(e), pts: [number, number][] = [toLayer(p0)];
  live = { pts: [p0], kind };
  const mv = (ev: PointerEvent) => {
    const p = v.toComp(ev), last = live!.pts[live!.pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.75) return;
    live!.pts.push(p); pts.push(toLayer(p)); v.draw();
  };
  const up = async () => {
    v.stage.removeEventListener('pointermove', mv); v.stage.removeEventListener('pointerup', up);
    live = null; v.draw();
    // brush size is in comp px on screen: in layer px through the layer's scale
    const a = toLayer([0, 0]), b = toLayer([diameter(), 0]), d = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
    const r = await mop('rotoStroke', v.c.id, l.id, { kind, t: adv.time, points: pts.map((q) => [Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100]), diameter: Math.round(d * 10) / 10 });
    if (r) { const c = adv.comp(); const L = c?.layers.find((x) => x.id === l.id); if (c && L) void propagate(c, L); }
  };
  v.stage.addEventListener('pointermove', mv); v.stage.addEventListener('pointerup', up);
}

const COLORS: Record<RotoKind, string> = { fg: 'rgba(40,220,70,0.75)', bg: 'rgba(235,50,50,0.75)', refine: 'rgba(170,90,255,0.75)', unrefine: 'rgba(120,120,140,0.75)' };
const outlines = new Map<string, HTMLCanvasElement>();
/** The matte's outline at working resolution (magenta, like AE's segmentation boundary). */
function outline(s: string, w: number, h: number): HTMLCanvasElement {
  let cv = outlines.get(s);
  if (cv) return cv;
  const m = rleDecode(s, w * h), img = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!m[i]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !m[i - 1] || !m[i + 1] || !m[i - w] || !m[i + w]) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 40; img.data[i * 4 + 2] = 220; img.data[i * 4 + 3] = 255; }
  }
  cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  outlines.set(s, cv);
  if (outlines.size > 16) outlines.delete(outlines.keys().next().value!);
  return cv;
}
/** Strokes of this frame, the propagated outline and the brush under the pointer (Roto Brush / Refine Edge tools). */
export function rotoOverlay(g: CanvasRenderingContext2D, c: Comp, toScreen: (x: number, y: number) => [number, number], scale: number, hover: [number, number] | null) {
  if (!isRotoTool(adv.tool)) return;
  const l = adv.first(), f = l?.effects.find((x) => x.fx === 'rotoBrush');
  if (l && f?.roto) {
    const M = worldMatrix(c, l, adv.time), S = (x: number, y: number) => { const q = apply(M, x, y); return toScreen(q[0], q[1]); };
    const seg = f.roto.seg, st = (adv.time - l.start) / (l.stretch || 1);
    if (seg) {
      const i = rotoFrame(seg, st);
      if (i >= 0 && seg.m[i]) {
        const o = S(0, 0), ax = S(seg.W, 0), ay = S(0, seg.H);
        g.save();
        g.setTransform((ax[0] - o[0]) / seg.w, (ax[1] - o[1]) / seg.w, (ay[0] - o[0]) / seg.h, (ay[1] - o[1]) / seg.h, o[0], o[1]);
        g.imageSmoothingEnabled = false;
        g.drawImage(outline(seg.m[i]!, seg.w, seg.h), 0, 0);
        g.restore();
      }
    }
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of f.roto.strokes) {
      if (Math.abs(s.s - st) > 1e-3) continue;
      const a = S(0, 0), b = S(s.d, 0);
      g.strokeStyle = COLORS[s.kind]; g.lineWidth = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
      g.beginPath();
      for (let k = 0; k < s.pts.length; k += 2) { const [x, y] = S(s.pts[k], s.pts[k + 1]); if (k) g.lineTo(x, y); else g.moveTo(x, y); }
      if (s.pts.length === 2) { const [x, y] = S(s.pts[0], s.pts[1]); g.lineTo(x + 0.01, y); }
      g.stroke();
    }
    g.restore();
  }
  const dpx = Math.max(1, diameter() * scale);
  if (live?.pts.length) {
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = COLORS[live.kind]; g.lineWidth = dpx;
    g.beginPath();
    live.pts.forEach((p, i) => { const [x, y] = toScreen(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    if (live.pts.length === 1) { const [x, y] = toScreen(live.pts[0][0], live.pts[0][1]); g.lineTo(x + 0.01, y); }
    g.stroke(); g.restore();
  } else if (hover) {
    const [x, y] = toScreen(hover[0], hover[1]);
    g.save(); g.strokeStyle = adv.tool === 'refine' ? 'rgba(190,120,255,0.95)' : 'rgba(60,230,90,0.95)';
    g.beginPath(); g.arc(x, y, dpx / 2, 0, Math.PI * 2); g.stroke();
    if (adv.tool === 'refine') { g.beginPath(); g.arc(x, y, Math.max(2, dpx / 2 - 3), 0, Math.PI * 2); g.stroke(); }
    else { g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x + 4, y); g.moveTo(x, y - 4); g.lineTo(x, y + 4); g.stroke(); }
    g.restore();
  }
}

// ───────────────────────── Effect Controls ─────────────────────────
/** Extra rows of «Pincel rotoscopia y Perf. borde»: status, Freeze, span and strokes of this frame. */
export function rotoControls(c: Comp, l: Layer, f: FxInstance): HTMLElement {
  wire();
  const busy = rotoBusy.get(l.id), d = f.roto, key = expectedKey(c, l, f), st = rotoStatus(f, key);
  const text = busy ? `Propagación de Pincel tipo rotoscopia ${busy.done} de ${busy.total}` : st === 'none' ? 'Arrastre por el primer plano; presione Alt y arrastre por el fondo.' : st === 'frozen' ? `Propagación de Pincel tipo rotoscopia y Perfeccionar en caché creada el ${new Date(d!.frozen!).toLocaleString()}` : st === 'stale' ? 'La propagación necesita actualizarse.' : `Propagación lista (${d?.seg?.m.filter(Boolean).length ?? 0} fotogramas)`;
  const srcNow = (adv.time - l.start) / (l.stretch || 1);
  const here = (d?.strokes ?? []).filter((s) => Math.abs(s.s - srcNow) < 1e-3);
  const m = store.project.media.find((x) => x.id === l.mediaId), sp = m ? rotoSpan(l, m, c.fps, d) : null;
  const toComp = (s: number) => l.start + s * (l.stretch || 1);
  return h('div', { class: 'fxrow', dataset: { test: 'roto-panel' }, style: { flexWrap: 'wrap', gap: '4px' } },
    h('span', { class: 'hint', dataset: { rotoStatus: l.id, test: 'roto-status' }, style: { flexBasis: '100%' } }, text),
    busy ? h('button', { class: 'btn small', dataset: { test: 'roto-cancel' }, onclick: () => void api.invoke('roto:cancel', l.id) }, 'Detener')
      : h('button', { class: 'btn small', title: 'Volver a propagar la segmentación por el espacio', disabled: !d?.strokes.length || !!d?.frozen, dataset: { test: 'roto-propagate' }, onclick: () => void propagate(c, l, true) }, 'Propagar'),
    h('button', { class: `btn small${d?.frozen ? ' on' : ''}`, title: 'Guardar en caché y bloquear la propagación de Pincel tipo rotoscopia y Perfeccionar borde', disabled: !d?.seg || !!busy, dataset: { test: 'roto-freeze' }, onclick: () => void mop('rotoEdit', c.id, l.id, { freeze: !d?.frozen }) }, d?.frozen ? 'Descongelar' : 'Congelar'),
    sp && !sp.still ? h('span', { class: 'hint', title: 'Espacio de Pincel tipo rotoscopia y Perfeccionar borde: rango y dirección de propagación automática', dataset: { test: 'roto-span' } }, `Espacio: ${toComp(sp.srcIn).toFixed(2)}–${toComp(sp.srcOut).toFixed(2)} s`) : null,
    sp && !sp.still ? h('button', { class: 'mini', title: 'El espacio empieza en el instante actual', disabled: !!d?.frozen, onclick: () => void mop('rotoEdit', c.id, l.id, { span: [adv.time, toComp(sp.srcOut)] }) }, '[') : null,
    sp && !sp.still ? h('button', { class: 'mini', title: 'El espacio termina en el instante actual', disabled: !!d?.frozen, onclick: () => void mop('rotoEdit', c.id, l.id, { span: [toComp(sp.srcIn), adv.time + 1 / c.fps] }) }, ']') : null,
    d?.span ? h('button', { class: 'mini', title: 'Eliminar espacio', disabled: !!d?.frozen, onclick: () => void mop('rotoEdit', c.id, l.id, { span: null }) }, '↔') : null,
    ...here.map((s) => h('span', { class: 'chip', dataset: { test: `roto-stroke-${s.kind}` } }, s.name, h('button', { class: 'mini', title: 'Eliminar trazo', disabled: !!d?.frozen, onclick: () => void mop('rotoEdit', c.id, l.id, { deleteStroke: s.id }) }, '✕'))),
    here.length ? h('button', { class: 'mini', title: 'Borrar los trazos de este fotograma', disabled: !!d?.frozen, onclick: () => void mop('rotoEdit', c.id, l.id, { clearFrame: adv.time }) }, 'Borrar trazos del fotograma') : null);
}
export { ROTO_KIND_NAMES };

// ───────────────────────── Content-Aware Fill panel ─────────────────────────
const CAF_KEY = 'cinta.adv.caf';
const caf = (() => { const d = { expansion: 5, method: 'object', lightOn: false, lighting: 'subtle', range: 'workArea' }; try { return { ...d, ...(JSON.parse(localStorage.getItem(CAF_KEY) ?? 'null') ?? {}) } as typeof d; } catch { return d; } })();
let cafBusy = false;
/** «Relleno según el contenido» (Window > Content-Aware Fill): fill target, alpha expansion, method, lighting
 *  correction, range, Create Reference Frame and Generate Fill Layer. */
export function cafPanel(el: HTMLElement) {
  wire();
  const save = () => { try { localStorage.setItem(CAF_KEY, JSON.stringify(caf)); } catch { /* private */ } };
  const build = () => {
    const c = adv.comp(), l = adv.first();
    const target = l && (l.type === 'video' || l.type === 'image') ? l : null;
    const sel = (items: [string, string][], get: () => string, set: (v: string) => void, test: string, tip = '') => { const s = h('select', { title: tip, dataset: { test } }, ...items.map(([v, n]) => h('option', { value: v, selected: v === get() }, n))) as HTMLSelectElement; s.onchange = () => { set(s.value); save(); }; return s; };
    const exp = h('input', { type: 'number', value: String(caf.expansion), min: -100, max: 200, step: 1, title: 'Aumente o disminuya el área que se rellenará.', dataset: { test: 'caf-expansion' }, style: { width: '64px' } }) as HTMLInputElement;
    exp.addEventListener('keydown', (e) => e.stopPropagation());
    exp.onchange = () => { caf.expansion = Number(exp.value) || 0; save(); };
    const light = h('input', { type: 'checkbox', checked: caf.lightOn, dataset: { test: 'caf-light-on' } }) as HTMLInputElement;
    light.onchange = () => { caf.lightOn = light.checked; save(); };
    const opts = () => ({ method: caf.method, lighting: caf.lightOn ? caf.lighting : null, expansion: caf.expansion, range: caf.range });
    const run = async (what: 'generate' | 'reference') => {
      if (!c || !target) { toast('Seleccione la capa que quiere rellenar: sus áreas transparentes (por ejemplo, una máscara en modo Restar) se rellenarán según el Método de relleno.', true); return; }
      cafBusy = true; build();
      try {
        const r = what === 'generate' ? await api.invoke('caf:generate', c.id, target.id, opts()) as { layer: { id: string; name: string }; frames: number }
          : await api.invoke('caf:reference', c.id, target.id, adv.time, opts()) as { layer: { id: string; name: string } };
        toast(what === 'generate' ? `Capa de relleno «${r.layer.name}» generada.` : `«${r.layer.name}» creado: edítelo y genere la capa de relleno.`);
      } catch (e) { toast(cleanErr(e), true); }
      finally { cafBusy = false; build(); }
    };
    el.replaceChildren(h('div', { class: 'pad caf-panel', dataset: { test: 'caf-panel' } },
      h('label', { class: 'prow' }, h('span', { class: 'nm', title: 'Las áreas transparentes de las imágenes se rellenarán según el Método de relleno seleccionado.' }, 'Rellenar objetivo'), h('span', { dataset: { test: 'caf-target' } }, target ? target.name : '-')),
      h('label', { class: 'prow' }, h('span', { class: 'nm' }, 'Expansión de alfa'), exp),
      h('label', { class: 'prow' }, h('span', { class: 'nm' }, 'Método de relleno'), sel([['object', 'Objeto'], ['surface', 'Superficie'], ['edge', 'Fusión de borde']], () => caf.method, (v) => { caf.method = v; }, 'caf-method', 'Objeto: elimina un objeto de las imágenes · Superficie: sustituye la superficie de un objeto · Fusión de borde: fusiona los píxeles del borde circundante.')),
      h('label', { class: 'prow' }, h('span', { class: 'nm' }, 'Corrección de la luz'), light, sel([['subtle', 'Sutil'], ['moderate', 'Moderar'], ['strong', 'Fuerte']], () => caf.lighting, (v) => { caf.lighting = v; }, 'caf-lighting')),
      h('label', { class: 'prow' }, h('span', { class: 'nm' }, 'Rango'), sel([['workArea', 'Entorno de trabajo'], ['all', 'Toda la duración']], () => caf.range, (v) => { caf.range = v; }, 'caf-range', 'Especifique si desea generar la capa de relleno solo para el entorno de trabajo o para toda la composición.')),
      h('div', { class: 'brow', style: { marginTop: '8px', gap: '6px' } },
        h('button', { class: 'btn small', title: 'Abra una imagen estática editable a la que el Relleno automático pueda hacer referencia al crear contenido.', disabled: cafBusy || !target, dataset: { test: 'caf-reference' }, onclick: () => void run('reference') }, 'Crear fotograma de referencia'),
        cafBusy ? h('button', { class: 'btn small', dataset: { test: 'caf-cancel' }, onclick: () => void api.invoke('caf:cancel') }, 'Detener')
          : h('button', { class: 'btn primary small', title: 'Genere una secuencia de imagen para reemplazar el target de relleno.', disabled: !target, dataset: { test: 'caf-generate' }, onclick: () => void run('generate') }, 'Generar capa de relleno')),
      h('div', { class: 'hint', dataset: { test: 'caf-status' }, style: { marginTop: '6px' } }, '')));
  };
  adv.on((why) => { if ((why === 'select' || why === 'comp') && el.isConnected && !cafBusy) build(); });
  build();
}
