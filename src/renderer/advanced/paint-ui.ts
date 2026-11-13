// Paint tools in the window (After Effects' Brush, Clone Stamp and Eraser, Ctrl+B cycles them): the Paint and
// Brushes panels, the gesture in the composition viewer and the stroke rows of the timeline.
// Cinta paints in the COMPOSITION viewer over the selected layer (After Effects paints in the Layer panel): every
// pointer position is mapped to the layer's own pixels through the inverse of its transform at the current time,
// so the strokes are stored in layer space exactly as After Effects stores them.
import { apply, invert, worldMatrix } from '../../core/motion/geom';
import { BRUSH_TIPS, defaultPaintOptions, ERASE_MODES, PAINT_CHANNELS, PAINT_DURATIONS, PAINT_MODES, STROKE_PROP_NAMES, type PaintOptions, type PaintStroke, type PaintTool } from '../../core/motion/paint';
import type { BlendMode, Comp, FxInstance, Layer } from '../../core/motion/model';
import { h, toast } from '../store';
import { adv, mop, type Tool } from './state';
import type { EditorSpec } from './widgets';

export const PAINT_TOOLS: PaintTool[] = ['brush', 'clone', 'eraser'];
export const isPaintTool = (t: Tool): t is PaintTool => (PAINT_TOOLS as string[]).includes(t);
/** Ctrl+B: Brush → Clone Stamp → Eraser → Brush (from any other tool: the last paint tool used) */
let lastPaint: PaintTool = 'brush';
export function nextPaintTool(t: Tool): PaintTool {
  const n = isPaintTool(t) ? PAINT_TOOLS[(PAINT_TOOLS.indexOf(t) + 1) % 3] : lastPaint;
  lastPaint = n;
  return n;
}

// ───────────────────────── panel settings ─────────────────────────
const KEY = 'cinta.adv.paint';
function load(): PaintOptions {
  const d = defaultPaintOptions();
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PaintOptions> | null; if (s) return { ...d, ...s, brush: { ...d.brush, ...s.brush }, clone: { ...d.clone, ...s.clone } }; } catch { /* private */ }
  return d;
}
export const paintOpts: PaintOptions = load();
const listeners = new Set<() => void>();
export function paintChanged() {
  try { localStorage.setItem(KEY, JSON.stringify(paintOpts)); } catch { /* private */ }
  for (const f of listeners) f();
}
/** clone source point (Alt+click): layer px of the source layer, and the offset kept while «Alineado» */
let cloneSrc: { layer: string; pt: [number, number] } | null = null;
let cloneOffset: [number, number] | null = null;

// ───────────────────────── viewer gesture ─────────────────────────
export interface ViewCtx { c: Comp; layer: Layer | undefined; stage: HTMLElement; toComp: (e: { clientX: number; clientY: number }) => [number, number]; draw: () => void }
let live: { pts: [number, number][]; tool: PaintTool } | null = null;

export function paintDown(e: PointerEvent, v: ViewCtx) {
  const tool = adv.tool as PaintTool;
  lastPaint = tool;
  const l = v.layer;
  if (!l || l.type === 'camera' || l.type === 'light' || l.type === 'null' || l.type === 'audio' || l.type === 'adjustment') { toast('Seleccione la capa en la que quiere pintar (sólido, imagen, vídeo, texto, forma o composición).', true); return; }
  if (!adv.selection.has(l.id)) adv.select([l.id]);
  const inv = invert(worldMatrix(v.c, l, adv.time));
  const toLayer = (p: [number, number]): [number, number] => { const q = apply(inv, p[0], p[1]); return [q[0], q[1]]; };
  const p0 = v.toComp(e);
  if (tool === 'clone' && e.altKey) {
    // Alt+click: the clone source point, on the source layer (the chosen one, or this layer)
    const src = paintOpts.clone.source ? v.c.layers.find((x) => x.id === paintOpts.clone.source) : l;
    if (!src) return;
    const q = apply(invert(worldMatrix(v.c, src, adv.time)), p0[0], p0[1]);
    cloneSrc = { layer: src.id, pt: [q[0], q[1]] };
    cloneOffset = null;
    toast('Origen de clonación definido: arrastre donde quiera copiarlo.');
    return;
  }
  if (tool === 'clone' && !cloneSrc && !paintOpts.clone.offset[0] && !paintOpts.clone.offset[1]) {
    toast('No se puede utilizar la herramienta Tampón de clonar porque aún no se ha definido el área. (Pulse Alt y haga clic para definir un punto de origen).', true);
    return;
  }
  const t0 = performance.now();
  const pts: [number, number][] = [toLayer(p0)];
  live = { pts: [p0], tool };
  try { v.stage.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  const mv = (ev: PointerEvent) => {
    const p = v.toComp(ev), last = live!.pts[live!.pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.5) return;
    live!.pts.push(p);
    pts.push(toLayer(p));
    v.draw();
  };
  const up = async () => {
    v.stage.removeEventListener('pointermove', mv);
    v.stage.removeEventListener('pointerup', up);
    live = null;
    v.draw();
    const o = paintOpts, drawTime = (performance.now() - t0) / 1000;
    let clone: Record<string, unknown> | undefined;
    if (tool === 'clone') {
      const start = pts[0];
      let pos: [number, number];
      if (cloneSrc && (!o.clone.aligned || !cloneOffset)) pos = cloneSrc.pt;
      else if (cloneOffset) pos = [start[0] + cloneOffset[0], start[1] + cloneOffset[1]];
      else pos = [start[0] + o.clone.offset[0], start[1] + o.clone.offset[1]];
      if (o.clone.aligned) cloneOffset = [pos[0] - start[0], pos[1] - start[1]];
      o.clone.offset = [Math.round(pos[0] - start[0]), Math.round(pos[1] - start[1])];
      paintChanged();
      clone = { source: cloneSrc?.layer && cloneSrc.layer !== l.id ? cloneSrc.layer : o.clone.source || undefined, position: pos, timeShift: o.clone.timeShift, lock: o.clone.lockTime, time: o.clone.lockTime ? o.clone.time : undefined };
    }
    await mop('paintStroke', v.c.id, l.id, {
      kind: tool, points: pts.map((q) => [q[0], q[1]]), at: adv.time, drawTime, color: o.fg, ...o.brush, opacity: o.opacity, flow: o.flow,
      mode: o.mode, channels: o.channels, duration: o.duration, frames: o.frames, erase: o.erase, clone,
    });
  };
  v.stage.addEventListener('pointermove', mv);
  v.stage.addEventListener('pointerup', up);
}

/** The stroke being drawn (before it is committed) and, for the clone stamp, the source overlay. */
export function paintOverlay(g: CanvasRenderingContext2D, c: Comp, toScreen: (x: number, y: number) => [number, number], scale: number, frame: CanvasImageSource | null, hover: [number, number] | null) {
  if (!isPaintTool(adv.tool)) return;
  const o = paintOpts, dpx = Math.max(1, o.brush.diameter * scale);
  if (adv.tool === 'clone' && o.clone.overlay && frame && hover) {
    // Clone Source Overlay: the comp shifted by the offset, translucent (difference mode helps lining it up)
    const off = cloneOffset ?? o.clone.offset;
    const [x0, y0] = toScreen(-off[0], -off[1]);
    g.save();
    g.globalAlpha = o.clone.overlayOpacity / 100;
    if (o.clone.difference) g.globalCompositeOperation = 'difference';
    g.drawImage(frame, x0, y0, c.width * scale, c.height * scale);
    g.restore();
  }
  if (live && live.pts.length) {
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = live.tool === 'brush' ? o.fg : live.tool === 'eraser' ? 'rgba(255,255,255,0.6)' : 'rgba(120,200,255,0.6)';
    g.globalAlpha = Math.max(0.3, o.opacity / 100);
    g.lineWidth = dpx;
    g.beginPath();
    live.pts.forEach((p, i) => { const [x, y] = toScreen(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    if (live.pts.length === 1) { const [x, y] = toScreen(live.pts[0][0], live.pts[0][1]); g.lineTo(x + 0.01, y); }
    g.stroke();
    g.restore();
  } else if (hover) {
    // the brush tip outline under the pointer
    const [x, y] = toScreen(hover[0], hover[1]);
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.ellipse(x, y, dpx / 2, Math.max(0.5, (dpx / 2) * (o.brush.roundness / 100)), (-o.brush.angle * Math.PI) / 180, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }
}

// ───────────────────────── panels ─────────────────────────
const field = (label: string, el: HTMLElement) => h('label', { class: 'prow' }, h('span', { class: 'nm' }, label), el);
function numIn(get: () => number, set: (v: number) => void, o: { min?: number; max?: number; step?: number; test: string; unit?: string }) {
  const el = h('input', { type: 'number', value: String(get()), min: o.min, max: o.max, step: o.step ?? 1, dataset: { test: o.test }, style: { width: '64px' } }) as HTMLInputElement;
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.onchange = () => { let v = Number(el.value); if (!Number.isFinite(v)) return; if (o.min !== undefined) v = Math.max(o.min, v); if (o.max !== undefined) v = Math.min(o.max, v); set(v); paintChanged(); };
  return h('span', {}, el, o.unit ? ` ${o.unit}` : '');
}
function sel<T extends string>(items: { id: T; name: string }[], get: () => T, set: (v: T) => void, test: string) {
  const el = h('select', { dataset: { test } }, ...items.map((x) => h('option', { value: x.id, selected: x.id === get() }, x.name))) as HTMLSelectElement;
  el.onchange = () => { set(el.value as T); paintChanged(); };
  return el;
}
function check(get: () => boolean, set: (v: boolean) => void, test: string) {
  const el = h('input', { type: 'checkbox', checked: get(), dataset: { test } }) as HTMLInputElement;
  el.onchange = () => { set(el.checked); paintChanged(); };
  return el;
}

/** Paint panel (Pintar): colours, opacity, flow, mode, channels, duration, eraser and clone options. */
export function paintPanel(el: HTMLElement) {
  const build = () => {
    const o = paintOpts;
    const fg = h('input', { type: 'color', value: o.fg, title: 'Configurar color de primer plano', dataset: { test: 'paint-fg' } }) as HTMLInputElement;
    const bg = h('input', { type: 'color', value: o.bg, title: 'Configurar color de fondo', dataset: { test: 'paint-bg' } }) as HTMLInputElement;
    fg.onchange = () => { o.fg = fg.value; paintChanged(); };
    bg.onchange = () => { o.bg = bg.value; paintChanged(); };
    const c = adv.comp();
    const layers = [{ id: '', name: 'Capa actual' }, ...(c?.layers ?? []).filter((l) => l.type !== 'camera' && l.type !== 'light' && l.type !== 'null' && l.type !== 'audio').map((l) => ({ id: l.id, name: l.name }))];
    const fps = c?.fps ?? 30;
    el.replaceChildren(h('div', { class: 'pad paint-panel', dataset: { test: 'paint-panel' } },
      h('div', { class: 'brow' }, fg, bg,
        h('button', { class: 'tb', title: 'Cambiar los colores de primer plano y de fondo', dataset: { test: 'paint-swap' }, onclick: () => { [o.fg, o.bg] = [o.bg, o.fg]; paintChanged(); } }, '⇄'),
        h('button', { class: 'tb', title: 'Restablecer los colores de primer plano y de fondo', dataset: { test: 'paint-reset' }, onclick: () => { o.fg = '#000000'; o.bg = '#ffffff'; paintChanged(); } }, '◩')),
      field('Opacidad:', numIn(() => o.opacity, (v) => { o.opacity = v; }, { min: 0, max: 100, test: 'paint-opacity', unit: '%' })),
      field('Flujo:', numIn(() => o.flow, (v) => { o.flow = v; }, { min: 0, max: 100, test: 'paint-flow', unit: '%' })),
      field('Modo:', sel(PAINT_MODES, () => o.mode, (v) => { o.mode = v as BlendMode; }, 'paint-mode')),
      field('Canales:', sel(PAINT_CHANNELS, () => o.channels, (v) => { o.channels = v; }, 'paint-channels')),
      field('Duración:', h('span', {}, sel(PAINT_DURATIONS, () => o.duration, (v) => { o.duration = v; }, 'paint-duration'), o.duration === 'custom' ? numIn(() => o.frames, (v) => { o.frames = Math.round(v); }, { min: 1, test: 'paint-frames', unit: 'f' }) : null)),
      field('Borrar:', sel(ERASE_MODES, () => o.erase, (v) => { o.erase = v; }, 'paint-erase')),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Opciones de clonación'),
      field('Ajus. preest.:', h('span', { class: 'brow' }, ...[1, 2, 3, 4, 5].map((n) => h('button', { class: `tb${o.clone.preset === n ? ' on' : ''}`, title: `Clonar ajuste preestablecido ${n}`, onclick: () => { presets[o.clone.preset - 1] = { ...o.clone }; Object.assign(o.clone, presets[n - 1] ?? { ...defaultPaintOptions().clone }, { preset: n }); paintChanged(); } }, String(n))))),
      field('Origen:', sel(layers, () => o.clone.source, (v) => { o.clone.source = v; cloneSrc = null; cloneOffset = null; }, 'paint-clone-source')),
      field('Alineado', check(() => o.clone.aligned, (v) => { o.clone.aligned = v; cloneOffset = null; }, 'paint-aligned')),
      field('Bloquear tiempo de origen', check(() => o.clone.lockTime, (v) => { o.clone.lockTime = v; if (v) o.clone.time = adv.time; }, 'paint-lock')),
      o.clone.lockTime ? field('Tiempo de origen:', numIn(() => Math.round(o.clone.time * fps), (v) => { o.clone.time = v / fps; }, { min: 0, test: 'paint-clone-time', unit: 'f' }))
        : field('Camb. tiem. orig.:', numIn(() => Math.round(o.clone.timeShift * fps), (v) => { o.clone.timeShift = v / fps; }, { test: 'paint-time-shift', unit: 'f' })),
      field('Desplazamiento:', h('span', {}, numIn(() => o.clone.offset[0], (v) => { o.clone.offset[0] = v; cloneOffset = null; }, { test: 'paint-offset-x' }), numIn(() => o.clone.offset[1], (v) => { o.clone.offset[1] = v; cloneOffset = null; }, { test: 'paint-offset-y' }),
        h('button', { class: 'mini', title: 'Restablecer el desplazamiento de origen de clonación a cero', onclick: () => { o.clone.offset = [0, 0]; cloneOffset = null; paintChanged(); } }, '0'))),
      field('Superpos. orig. clon.:', h('span', {}, check(() => o.clone.overlay, (v) => { o.clone.overlay = v; }, 'paint-overlay'), numIn(() => o.clone.overlayOpacity, (v) => { o.clone.overlayOpacity = v; }, { min: 0, max: 100, test: 'paint-overlay-op', unit: '%' }),
        h('label', { title: 'Utilizar modo diferencia en la superposición de origen de clonación' }, check(() => o.clone.difference, (v) => { o.clone.difference = v; }, 'paint-difference'), ' Diferencia'))),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Pincel / Tampón de clonar / Borrador: Ctrl+B. Se pinta en el visor sobre la capa seleccionada (en su espacio de capa). Tampón: Alt+clic define el origen.')));
  };
  listeners.add(build);
  adv.on((why) => { if (why === 'comp' && el.isConnected) build(); });
  build();
}
const presets: (PaintOptions['clone'] | undefined)[] = [];

/** Brushes panel (Pinceles): brush tips and Diameter, Angle, Roundness, Hardness, Spacing. */
export function brushesPanel(el: HTMLElement) {
  const build = () => {
    const b = paintOpts.brush;
    const isTip = (t: (typeof BRUSH_TIPS)[number]) => t.diameter === b.diameter && t.hardness === b.hardness && t.roundness === b.roundness && t.angle === b.angle && t.spacing === b.spacing;
    el.replaceChildren(h('div', { class: 'pad brushes-panel', dataset: { test: 'brushes-panel' } },
      h('div', { class: 'brow', style: { flexWrap: 'wrap' } }, ...BRUSH_TIPS.map((t, i) => h('button', { class: `tb${isTip(t) ? ' on' : ''}`, title: t.name, dataset: { test: `brush-tip-${i + 1}` }, onclick: () => { Object.assign(b, { diameter: t.diameter, angle: t.angle, roundness: t.roundness, hardness: t.hardness, spacing: t.spacing }); paintChanged(); } }, `${t.hardness ? '●' : '◌'}${t.diameter}`))),
      field('Diámetro:', numIn(() => b.diameter, (v) => { b.diameter = v; }, { min: 1, max: 2500, test: 'brush-diameter', unit: 'px' })),
      field('Ángulo:', numIn(() => b.angle, (v) => { b.angle = v; }, { min: -180, max: 180, test: 'brush-angle', unit: '°' })),
      field('Redondez:', numIn(() => b.roundness, (v) => { b.roundness = v; }, { min: 0, max: 100, test: 'brush-roundness', unit: '%' })),
      field('Dureza:', numIn(() => b.hardness, (v) => { b.hardness = v; }, { min: 0, max: 100, test: 'brush-hardness', unit: '%' })),
      field('Espaciado:', numIn(() => b.spacing, (v) => { b.spacing = v; }, { min: 1, max: 1000, test: 'brush-spacing', unit: '%' }))));
  };
  listeners.add(build);
  build();
}

// ───────────────────────── timeline ─────────────────────────
export interface PaintRow { key?: string; path?: string; label: string; depth: number; spec?: EditorSpec; tools?: HTMLElement[] }
const pct = (min = 0, max = 100): EditorSpec => ({ type: 'number', unit: '%', min, max, step: 1 });
const SPECS: Record<string, EditorSpec> = {
  start: pct(), end: pct(), opacity: pct(), flow: pct(), hardness: pct(), roundness: pct(), spacing: pct(1, 1000),
  diameter: { type: 'number', unit: 'px', min: 0, step: 1 }, angle: { type: 'number', unit: '°', step: 1 }, color: { type: 'color' },
  channels: { type: 'choice', choices: PAINT_CHANNELS }, path: { type: 'path' },
};
/** Rows of the strokes of a paint effect: newest first like After Effects, each with its Stroke Options and
 *  Transform; tools: blend mode, order and delete. */
export function paintRows(c: Comp, l: Layer, f: FxInstance, open: Set<string>): PaintRow[] {
  const out: PaintRow[] = [];
  const list = f.strokes ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s: PaintStroke = list[i];
    const g = `${l.id}|ps|${s.id}`, b = `effects.${f.id}.strokes.${s.id}`;
    const tools: HTMLElement[] = [];
    if (s.kind !== 'eraser') {
      const m = h('select', { class: 'mini', title: 'Modo de fusión', dataset: { test: `stroke-mode-${s.name}` } }, ...PAINT_MODES.map((x) => h('option', { value: x.id, selected: x.id === s.mode }, x.name))) as HTMLSelectElement;
      m.onchange = () => void mop('paintEdit', c.id, l.id, s.id, { mode: m.value });
      tools.push(m);
    }
    tools.push(
      h('button', { class: 'mini', title: 'Subir (dibujar después)', disabled: i === list.length - 1, onclick: () => void mop('paintEdit', c.id, l.id, s.id, { index: i + 2 }) }, '▲'),
      h('button', { class: 'mini', title: 'Bajar (dibujar antes)', disabled: i === 0, onclick: () => void mop('paintEdit', c.id, l.id, s.id, { index: i }) }, '▼'),
      h('button', { class: 'mini', title: 'Eliminar trazo', dataset: { test: `stroke-del-${s.name}` }, onclick: () => void mop('paintEdit', c.id, l.id, s.id, { delete: true }) }, '✕'));
    out.push({ key: g, label: s.name, depth: 3, tools: [h('span', { class: 'seltools' }, ...tools)] });
    if (!open.has(g)) continue;
    out.push({ path: `${b}.path`, label: 'Trazado', depth: 4, spec: SPECS.path });
    const og = `${g}|o`;
    out.push({ key: og, label: 'Opciones de trazo', depth: 4 });
    if (open.has(og)) {
      for (const k of ['start', 'end', 'color', 'diameter', 'angle', 'hardness', 'roundness', 'spacing', 'channels', 'opacity', 'flow'] as const) {
        if (k === 'color' && s.kind !== 'brush') continue;
        out.push({ path: `${b}.${k}`, label: STROKE_PROP_NAMES[k], depth: 5, spec: SPECS[k] });
      }
      if (s.clone) {
        out.push({ path: `${b}.clone.position`, label: STROKE_PROP_NAMES['clone.position'], depth: 5 });
        out.push(s.clone.lock ? { path: `${b}.clone.time`, label: STROKE_PROP_NAMES['clone.time'], depth: 5, spec: { type: 'number', unit: 's', step: 0.01 } } : { path: `${b}.clone.timeShift`, label: STROKE_PROP_NAMES['clone.timeShift'], depth: 5, spec: { type: 'number', unit: 's', step: 0.01 } });
      }
    }
    const tg = `${g}|t`;
    out.push({ key: tg, label: `Transformar: ${s.name}`, depth: 4 });
    if (open.has(tg)) for (const k of ['anchor', 'position', 'scale', 'rotation'] as const) out.push({ path: `${b}.transform.${k}`, label: STROKE_PROP_NAMES[k], depth: 5 });
  }
  return out;
}

/** Comp-time span of the stroke a timeline group row stands for (its duration bar), or null. */
export function strokeSpan(l: Layer, key: string): [number, number] | null {
  const m = /\|ps\|([^|]+)$/.exec(key);
  if (!m) return null;
  const s = l.effects.find((f) => f.strokes)?.strokes?.find((x) => x.id === m[1]);
  return s ? [s.in + l.start, s.out + l.start] : null;
}
