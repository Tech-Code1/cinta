// «vectores» in the window: Capa > Crear formas / máscaras a partir del texto, the «Trazado automático» dialog
// (After Effects' Auto-trace, with its options and defaults) and the variable-font axes of the Character panel.
import type { Comp, Layer } from '../../core/motion/model';
import { TRACE_CHANNELS, TRACE_DEFAULTS, type TraceChannel } from '../../core/motion/autotrace';
import { AXIS_NAMES } from '../../core/motion/vectores';
import { modal } from '../dialogs';
import type { MenuItem } from '../player';
import { h, store, toast } from '../store';
import { adv, mop } from './state';
import { propEditor } from './widgets';
import { traceLayer, traceTimes } from '../../motion-render/vectortasks';
import { loadFont } from '../../motion-render/textpaths';

const visual = (l: Layer) => !['camera', 'light', 'audio', 'null'].includes(l.type);

/** Crear formas (or máscaras) a partir del texto, on a text layer at the current time. */
export async function textOutlines(kind: 'shapes' | 'masks', c: Comp, l: Layer) {
  try {
    const { renderer } = await import('./viewer');
    const r = await renderer.textOutlines(store.project, c, l, adv.time);
    if (!r) return;
    const nl = await mop<{ id: string }>(kind === 'shapes' ? 'textToShapes' : 'textToMasks', c.id, l.id, r);
    if (nl) adv.select([nl.id]);
  } catch (e) { toast(String((e as Error).message ?? e), true); }
}

/** Items of the layer menus: the two «Crear» commands for text layers and «Trazado automático…» for visual ones. */
export function vectorMenuItems(c: Comp, l: Layer): MenuItem[] {
  const out: MenuItem[] = [];
  if (l.type === 'text') out.push(
    { label: 'Crear formas a partir del texto', fn: () => void textOutlines('shapes', c, l) },
    { label: 'Crear máscaras a partir del texto', fn: () => void textOutlines('masks', c, l) });
  if (visual(l)) out.push({ label: 'Trazado automático...', fn: () => autoTraceDialog(c, l) });
  return out;
}

/** After Effects' Auto-trace dialog. */
export function autoTraceDialog(c: Comp, l: Layer) {
  const D = TRACE_DEFAULTS;
  const radio = (name: string, value: string, checked: boolean, test: string) => h('input', { type: 'radio', name, value, checked, dataset: { test } }) as HTMLInputElement;
  const cur = radio('at-span', 'current', true, 'at-current'), wa = radio('at-span', 'work', false, 'at-work');
  const num = (v: number, test: string, min = 0, max = 1000) => h('input', { type: 'number', value: String(v), min: String(min), max: String(max), step: 'any', style: { width: '70px' }, dataset: { test }, onkeydown: (e: KeyboardEvent) => e.stopPropagation() }) as HTMLInputElement;
  const chan = h('select', { dataset: { test: 'at-channel' } }, ...TRACE_CHANNELS.map((x) => h('option', { value: x.id, selected: x.id === D.channel }, x.name))) as HTMLSelectElement;
  const inv = h('input', { type: 'checkbox', dataset: { test: 'at-invert' } }) as HTMLInputElement;
  const blurOn = h('input', { type: 'checkbox', checked: D.blur > 0, dataset: { test: 'at-blur-on' } }) as HTMLInputElement;
  const blur = num(D.blur || 1, 'at-blur', 0, 100), tol = num(D.tolerance, 'at-tolerance', 0.1, 100), thr = num(D.threshold, 'at-threshold', 0, 100);
  const area = num(D.minArea, 'at-minarea', 0, 100000), round = num(D.cornerRoundness, 'at-round', 0, 100);
  const newL = h('input', { type: 'checkbox', dataset: { test: 'at-newlayer' } }) as HTMLInputElement;
  const row = (label: string, ...kids: (Node | string)[]) => h('div', { class: 'frow' }, h('label', {}, label), h('div', { class: 'fval' }, ...kids));
  const [a, b] = c.workArea;
  const m = modal('Trazado automático', [
    h('fieldset', {}, h('legend', {}, 'Espacio de tiempo'),
      h('label', {}, cur, ' Fotograma actual'), ' ', h('label', {}, wa, ' Entorno de trabajo'),
      h('div', { class: 'hint' }, `Inicio: ${a.toFixed(2)} s   Fin: ${b.toFixed(2)} s   Duración: ${(b - a).toFixed(2)} s`)),
    h('fieldset', {}, h('legend', {}, 'Opciones'),
      row('Canal:', chan, ' ', h('label', {}, inv, ' Invertir')),
      row('', h('label', {}, blurOn, ' Desenfoque '), blur, ' píxeles antes del trazado automático'),
      row('Tolerancia:', tol, ' px'), row('Umbral:', thr, ' %'), row('Área mínima:', area, ' px'), row('Redondez de esquinas:', round, ' %')),
    h('label', {}, newL, ' Aplicar a la nueva capa'),
    h('div', { class: 'hint' }, `Se trazará automáticamente 1 capa: «${l.name}».`),
  ], [
    h('button', { class: 'btn primary', dataset: { test: 'at-ok' }, onclick: async () => {
      const o = { channel: chan.value as TraceChannel, invert: inv.checked, blur: blurOn.checked ? Math.max(0, Number(blur.value) || 0) : 0, tolerance: Math.max(0.1, Number(tol.value) || 1), threshold: Math.max(0, Math.min(100, Number(thr.value))), minArea: Math.max(0, Number(area.value) || 0), cornerRoundness: Math.max(0, Math.min(100, Number(round.value))) };
      m.close();
      const times = traceTimes(c, adv.time, wa.checked);
      try {
        const { renderer } = await import('./viewer');
        const frames = [];
        for (let i = 0; i < times.length; i++) {
          if (times.length > 1 && i % 10 === 0) toast(`Trazando automáticamente… ${i + 1}/${times.length}`);
          frames.push({ t: times[i], paths: await traceLayer(renderer, store.project, c, l, times[i], o) });
        }
        const r = await mop<{ layer: string; masks: string[] }>('autoTraceApply', c.id, l.id, frames, { ...o, newLayer: newL.checked });
        if (r) { adv.select([r.layer]); toast(`Trazado automático: ${r.masks.length} máscara${r.masks.length === 1 ? '' : 's'}.`); }
      } catch (e) { toast(String((e as Error).message ?? e), true); }
    } }, 'Aceptar'),
    h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
  ], { width: 520 });
}

export const axisName = (tag: string, name?: string) => AXIS_NAMES[tag] ?? name ?? tag;

/** Character panel: the axes of a variable font (each can be set, then keyframed like any text property). */
export function axesRows(c: Comp, l: Layer): HTMLElement {
  const box = h('div', { class: 'axes', dataset: { test: 'char-axes' } });
  const t = l.text!;
  void loadFont(t).then((f) => {
    if (!f || !f.axes.length) { box.replaceChildren(); return; }
    const rows = f.axes.filter((a) => !a.hidden || t.axes?.[a.tag]).map((a) => {
      const set = !!t.axes?.[a.tag];
      const eff = a.tag === 'wght' ? Math.max(a.min, Math.min(a.max, t.weight)) : a.def;
      const ctl = set ? propEditor(l.id, `text.axes.${a.tag}`, { type: 'number', min: a.min, max: a.max }, axisName(a.tag, a.name))
        : h('input', { type: 'number', value: String(eff), min: String(a.min), max: String(a.max), step: 'any', style: { width: '70px' }, dataset: { test: `axis-${a.tag}` }, onkeydown: (e: KeyboardEvent) => e.stopPropagation(),
          onchange: (e: Event) => void mop('textAxesSet', c.id, l.id, { [a.tag]: Math.max(a.min, Math.min(a.max, Number((e.target as HTMLInputElement).value))) }) });
      return h('div', { class: 'crow' }, h('span', { class: 'nm', title: `${a.tag}: ${a.min}–${a.max}` }, axisName(a.tag, a.name)), ctl,
        set ? h('button', { class: 'mini', title: 'Volver al valor predeterminado de la fuente', onclick: () => void mop('textAxesSet', c.id, l.id, { [a.tag]: null }) }, '↺') : null);
    });
    box.replaceChildren(h('div', { class: 'hint' }, 'Ejes de fuente variable'), ...rows);
  });
  return box;
}
