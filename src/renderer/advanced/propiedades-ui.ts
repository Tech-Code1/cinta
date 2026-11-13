// Properties panel (After Effects 2024: Window ▸ Properties): the controls that matter for the selected layer,
// without opening the timeline — Layer Transform (with 3D rotations for 3D layers), Text (font, style, size, fill,
// stroke, tracking, leading, alignment) for text layers, Shape properties (fill and stroke on/off, colours, stroke
// width, size and roundness of rectangles…) for shape layers, Camera / Light options for those. Edits are the same
// keyed edits as the timeline (a key at the current time when the stopwatch is on), one undo step each.
import type { Layer, ShapeItem } from '../../core/motion/model';
import { h } from '../store';
import { bindCommands } from './atajos-ui';
import { css } from './paneles-css';
import { adv, mop } from './state';
import { propEditor, type EditorSpec } from './widgets';

const CSS = `
.props-pane .ph { padding: 6px 10px; color: var(--hi); font-weight: 600; background: var(--panel2); border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
.props-pane .ph:first-child { border-top: 0; }
.props-pane .pr { display: grid; grid-template-columns: 110px 1fr; gap: 6px; align-items: center; padding: 3px 10px; min-height: 24px; }
.props-pane .pr > span:first-child { color: var(--muted); }
.props-pane .ttl { padding: 8px 10px; color: var(--hi); font-size: 13px; display: flex; gap: 6px; align-items: center; }
.props-pane .ttl i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.props-pane select { max-width: 150px; }
`;
const FONTS = ['Segoe UI', 'Segoe UI Black', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const TYPE_NAME: Record<string, string> = { text: 'Capa de texto', shape: 'Capa de forma', solid: 'Sólido', null: 'Objeto nulo', adjustment: 'Capa de ajuste', camera: 'Cámara', light: 'Luz', video: 'Material de archivo', image: 'Material de archivo', audio: 'Audio', comp: 'Composición', sequence: 'Secuencia', model: 'Modelo 3D' };

/** The panel body (a tab of the right column). Built only while visible: its editors must not shadow the timeline's. */
export function propertiesPanel(el: HTMLElement) {
  css('props', CSS);
  el.classList.add('props-pane');
  el.dataset.test = 'adv-props';
  const visible = () => el.classList.contains('on');
  const draw = () => {
    if (!visible()) { if (el.childElementCount) el.replaceChildren(); return; }
    if (adv.work) return;
    const c = adv.comp(), l = adv.first();
    if (!c) { el.replaceChildren(h('div', { class: 'hint pad' }, 'No hay composición.')); return; }
    if (!l) { el.replaceChildren(h('div', { class: 'hint pad' }, 'Seleccione una capa: aquí aparecen sus controles de transformación, texto o forma.')); return; }
    const kids: (Node | null)[] = [h('div', { class: 'ttl' }, h('i', { style: { background: l.label } }), h('span', {}, l.name), h('span', { class: 'muted' }, `· ${TYPE_NAME[l.type] ?? l.type}`))];
    kids.push(...transform(l));
    if (l.text) kids.push(...text(c.id, l));
    if (l.shapes?.length) for (const s of l.shapes) kids.push(...shape(c.id, l, s));
    if (l.camera) kids.push(section('Opciones de cámara', 'cam'), row('Zoom', ed(l, 'camera.zoom', { type: 'number', unit: ' px', min: 1 }, 'zoom')), row('Punto de interés', ed(l, 'camera.poi', { type: 'vec', dims: 3 }, 'punto de interés')));
    if (l.light) kids.push(section('Opciones de luz', 'light'), row('Intensidad', ed(l, 'light.intensity', { type: 'number', unit: ' %' }, 'intensidad')), row('Color', ed(l, 'light.color', { type: 'color' }, 'color')),
      ...(l.light.type === 'spot' ? [row('Ángulo del cono', ed(l, 'light.coneAngle', { type: 'number', unit: '°', min: 0, max: 180 }, 'ángulo del cono'))] : []));
    el.replaceChildren(...kids.filter(Boolean) as Node[]);
  };
  const ed = (l: Layer, path: string, spec: EditorSpec, label: string) => {
    const e = propEditor(l.id, path, spec, label);
    // own test ids: the timeline's editors keep theirs
    e.querySelectorAll<HTMLElement>('[data-test^="pv-"]').forEach((x) => { x.dataset.test = `props-${x.dataset.test}`; });
    return e;
  };
  const row = (label: string, ...kids: Node[]) => h('div', { class: 'pr' }, h('span', {}, label), h('span', {}, ...kids));
  const section = (t: string, id: string, ...extra: Node[]) => h('div', { class: 'ph', dataset: { test: `props-sec-${id}` } }, h('span', {}, t), ...extra);
  function transform(l: Layer): Node[] {
    const out: Node[] = [section('Transformación de capa', 'transform')];
    if (l.type === 'camera' || l.type === 'light') out.push(row('Posición', ed(l, 'transform.position', { type: 'vec', dims: 3 }, 'posición')));
    else {
      out.push(row('Punto de anclaje', ed(l, 'transform.anchor', { type: 'vec', dims: l.threeD ? 3 : 2 }, 'punto de anclaje')));
      if (!l.transform.positionX) out.push(row('Posición', ed(l, 'transform.position', { type: 'vec', dims: l.threeD ? 3 : 2 }, 'posición')));
      else out.push(row('Posición X', ed(l, 'transform.positionX', { type: 'number' }, 'posición X')), row('Posición Y', ed(l, 'transform.positionY', { type: 'number' }, 'posición Y')));
      out.push(row('Escala', ed(l, 'transform.scale', { type: 'vec', dims: l.threeD ? 3 : 2, unit: '%' }, 'escala')));
      if (l.threeD) out.push(row('Rotación X', ed(l, 'transform.rotationX', { type: 'number', unit: '°' }, 'rotación X')), row('Rotación Y', ed(l, 'transform.rotationY', { type: 'number', unit: '°' }, 'rotación Y')), row('Rotación Z', ed(l, 'transform.rotation', { type: 'number', unit: '°' }, 'rotación Z')));
      else out.push(row('Rotación', ed(l, 'transform.rotation', { type: 'number', unit: '°' }, 'rotación')));
      out.push(row('Opacidad', ed(l, 'transform.opacity', { type: 'number', unit: '%', min: 0, max: 100 }, 'opacidad')));
    }
    return out;
  }
  function text(cid: string, l: Layer): Node[] {
    const t = l.text!;
    const set = (patch: object) => void mop('layerSet', cid, l.id, { text: patch });
    const font = h('select', { dataset: { test: 'props-font' } }, ...[...new Set([t.font, ...FONTS])].map((f) => h('option', { value: f, selected: f === t.font, style: { fontFamily: f } }, f))) as HTMLSelectElement;
    font.onchange = () => set({ font: font.value });
    const weight = h('select', { dataset: { test: 'props-weight' } }, ...[[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']].map(([v, n]) => h('option', { value: String(v), selected: t.weight === v }, String(n)))) as HTMLSelectElement;
    weight.onchange = () => set({ weight: Number(weight.value) });
    const leading = h('input', { type: 'number', value: String(t.leading || ''), placeholder: 'Auto', style: { width: '70px' }, dataset: { test: 'props-leading' } }) as HTMLInputElement;
    leading.onchange = () => set({ leading: Number(leading.value) || 0 });
    leading.onkeydown = (e) => e.stopPropagation();
    const al = (a: 'left' | 'center' | 'right', icon: string, tip: string) => h('button', { class: `tb${t.align === a ? ' on' : ''}`, title: tip, dataset: { test: `props-align-${a}` }, onclick: () => set({ align: a }) }, icon);
    return [section('Texto', 'text'),
      row('Fuente', font), row('Estilo', weight),
      row('Tamaño', ed(l, 'text.size', { type: 'number', unit: ' px', min: 1 }, 'tamaño')),
      row('Relleno', ed(l, 'text.fill', { type: 'color' }, 'relleno')),
      row('Trazo', ed(l, 'text.stroke', { type: 'color' }, 'trazo'), ed(l, 'text.strokeWidth', { type: 'number', unit: ' px', min: 0 }, 'anchura de trazo')),
      row('Interletraje', ed(l, 'text.tracking', { type: 'number' }, 'interletraje')),
      row('Interlineado', leading),
      section('Párrafo', 'para'),
      row('Alineación', al('left', '⯇', 'Alinear texto a la izquierda'), al('center', '≡', 'Centrar texto'), al('right', '⯈', 'Alinear texto a la derecha'))];
  }
  function shape(cid: string, l: Layer, s: ShapeItem): Node[] {
    const p = `shapes.${s.id}`;
    const toggle = (what: 'fill' | 'stroke') => { const cb = h('input', { type: 'checkbox', checked: s[what].on, title: what === 'fill' ? 'Relleno' : 'Trazo', dataset: { test: `props-${what}-on` } }) as HTMLInputElement; cb.onchange = () => void mop('shapeSet', cid, l.id, s.id, { [what]: cb.checked }); return cb; };
    const out: Node[] = [section(`Propiedades de forma · ${s.name}`, `shape-${s.id}`)];
    out.push(row('Relleno', toggle('fill'), ed(l, `${p}.fill.color`, { type: 'color' }, 'color de relleno'), ed(l, `${p}.fill.opacity`, { type: 'number', unit: '%', min: 0, max: 100 }, 'opacidad de relleno')));
    out.push(row('Trazo', toggle('stroke'), ed(l, `${p}.stroke.color`, { type: 'color' }, 'color de trazo')));
    out.push(row('Anchura del trazo', ed(l, `${p}.stroke.width`, { type: 'number', unit: ' px', min: 0 }, 'anchura del trazo')));
    if (s.kind === 'rect' || s.kind === 'ellipse') out.push(row('Tamaño', ed(l, `${p}.size`, { type: 'vec', dims: 2 }, 'tamaño')));
    if (s.kind === 'rect') out.push(row('Redondez', ed(l, `${p}.roundness`, { type: 'number', min: 0 }, 'redondez')));
    if (s.kind === 'star' || s.kind === 'polygon') out.push(row('Puntos', ed(l, `${p}.points`, { type: 'number', min: 3 }, 'puntos')), row('Radio externo', ed(l, `${p}.outerRadius`, { type: 'number', min: 0 }, 'radio externo')));
    if (s.kind === 'star') out.push(row('Radio interno', ed(l, `${p}.innerRadius`, { type: 'number', min: 0 }, 'radio interno')));
    return out;
  }
  adv.on((why) => { if (why === 'comp' || why === 'select' || why === 'time') draw(); });
  // the tab becoming visible (the tab bar toggles .on)
  new MutationObserver(() => draw()).observe(el, { attributes: true, attributeFilter: ['class'] });
  draw();
}
bindCommands({ 'panel-properties': () => { (document.querySelector('[data-test=tab-properties]') as HTMLElement | null)?.click(); } });
