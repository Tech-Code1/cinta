// Layer timeline of the advanced mode (After Effects style): layer rows with switches, blend mode, track matte
// and parent; expandable property tree with stopwatch, keyframe navigation and expressions; layer bars and
// keyframes drawn on a canvas (drag to move, right-click for interpolation); ruler with work area; graph editor.
import { exprErrors, keyedAt, valueAt } from '../../core/motion/anim';
import { textoMenuItems } from './texto-ui';
import { FX, fxDef } from '../../core/motion/effects';
import { STYLES, styleDef } from '../../core/motion/styles';
import { BLEND_MODES, MATTE_MODES, type Comp, type Key, type Layer, type Prop } from '../../core/motion/model';
import { essentialDefault, forEachProp } from '../../core/motion/ops';
import { contextMenu } from '../player';
import { h, store, toast } from '../store';
import { adv, diskCache, mop, propAt } from './state';
import { propEditor, specFor, type EditorSpec } from './widgets';
import { smartMaskDialog } from './panels';
import { drawGraph as drawGraphEditor, graphBar, graphEvents as graphEditorEvents, interpSelected } from './graph';
import { velocityDialog } from './velodialog';
import { paintRows, strokeSpan } from './paint-ui';
import { axisName, vectorMenuItems } from './vectores-ui';
import { lightMenuItems, modelMenuItems, modelRows } from './modelos3d-ui';
import { extrudable, geometryRows, surfaceRows } from './extrusion-ui';
import { capasLayerItems, drawCompMarkers, guideIcon, maskRotoBox, rulerMarkerEvents } from './capas-ui';

const ROW = 22;
type Row =
  | { kind: 'layer'; l: Layer }
  | { kind: 'group'; l: Layer; key: string; label: string; depth: number; tools?: HTMLElement[] }
  | { kind: 'prop'; l: Layer; path: string; label: string; depth: number; spec: EditorSpec }
  | { kind: 'expr'; l: Layer; path: string; depth: number }
  | { kind: 'action'; l: Layer; depth: number; el: HTMLElement };

const open = new Set<string>();
const exprOpen = new Set<string>();
/** P/S/R/T/A/U: show only these properties of a layer */
const reveal = new Map<string, string[]>();
let rows: Row[] = [];
let left: HTMLDivElement, right: HTMLCanvasElement, ruler: HTMLCanvasElement, body: HTMLDivElement, graphCv: HTMLCanvasElement, tcEl: HTMLElement, gBar: HTMLElement;
let pxPerSec = 0; // 0 = fit
let t0 = 0; // first visible second
export let graphOn = false;

export function initTimeline(root: HTMLElement) {
  tcEl = h('div', { class: 'adv-tc', dataset: { test: 'adv-tc' } }, '0:00:00:00');
  const head = h('div', { class: 'adv-tl-head' },
    h('div', { class: 'adv-tl-headl' }, tcEl,
      h('button', { class: 'tb', title: 'Editor de gráficos', dataset: { test: 'adv-graph' }, onclick: () => { graphOn = !graphOn; (document.querySelector('[data-test=adv-graph]') as HTMLElement).classList.toggle('on', graphOn); draw(); } }, 'Gráficos'),
      h('button', { class: 'tb', title: 'Mostrar solo las propiedades animadas (U)', onclick: () => revealAnimated() }, 'U'),
      h('span', { class: 'cols' }, h('span', { style: { width: '76px' } }, 'Modo'), h('span', { style: { width: '120px' } }, 'Mate'), h('span', { style: { width: '96px' } }, 'Primario'))),
    ruler = h('canvas', { class: 'adv-ruler', dataset: { test: 'adv-ruler' } }));
  left = h('div', { class: 'adv-tl-left', dataset: { test: 'adv-layers' } });
  right = h('canvas', { class: 'adv-tl-right', dataset: { test: 'adv-keys' } });
  graphCv = h('canvas', { class: 'adv-graph', dataset: { test: 'adv-graph-cv' } });
  gBar = graphBar();
  const rwrap = h('div', { class: 'adv-tl-rwrap' }, right, graphCv, gBar);
  body = h('div', { class: 'adv-tl-body' }, left, rwrap);
  root.append(head, body);
  new ResizeObserver(() => draw()).observe(body);
  body.addEventListener('scroll', () => draw());
  rulerMarkerEvents(ruler, t2x, x2t, () => draw());
  rulerEvents();
  keyEvents();
  graphEvents();
  adv.on((why) => {
    if (why === 'time' || why === 'play') { updateTc(); draw(); if (why === 'time' && !adv.playing && !adv.work) refreshValues(); }
    else if (why === 'comp' || why === 'select' || why === 'keys' || why === 'errors') render();
    else if (why === 'cache') draw();
  });
}

// ───────────────────────── rows ─────────────────────────
const fxOk = (l: Layer) => l.type !== 'camera' && l.type !== 'light' && l.type !== 'null' && l.type !== 'audio';
function buildRows(c: Comp): Row[] {
  const out: Row[] = [];
  for (const l of c.layers) {
    out.push({ kind: 'layer', l });
    const only = reveal.get(l.id);
    if (only) { for (const p of only) addProp(out, l, p, 1); continue; }
    if (!open.has(l.id)) continue;
    if (l.text) {
      const g = `${l.id}|text`;
      out.push({ kind: 'group', l, key: g, label: 'Texto', depth: 1, tools: [addAnimatorMenu(l)] });
      if (open.has(g)) {
        for (const [p, n] of [['text.text', 'Texto de origen'], ['text.size', 'Tamaño'], ['text.fill', 'Color de relleno'], ['text.stroke', 'Color de trazo'], ['text.strokeWidth', 'Anchura de trazo'], ['text.tracking', 'Interletraje']] as const) addProp(out, l, p, 2, n);
        for (const tag of Object.keys(l.text.axes ?? {})) addProp(out, l, `text.axes.${tag}`, 2, axisName(tag));
        for (const an of l.text.animators) {
          const ag = `${l.id}|an|${an.id}`;
          out.push({ kind: 'group', l, key: ag, label: an.name, depth: 2, tools: [h('button', { class: 'mini', title: 'Quitar animador', onclick: () => void mop('textAnimatorRemove', c.id, l.id, an.id) }, '✕')] });
          if (!open.has(ag)) continue;
          for (const k of Object.keys(an.props)) addProp(out, l, `text.animators.${an.id}.props.${k}`, 3, ANIM_NAMES[k] ?? k);
          an.selectors.forEach((s, i) => {
            const base = `text.animators.${an.id}.selectors.${i}`;
            out.push({ kind: 'action', l, depth: 3, el: selectorTools(c, l, an.id, i) });
            const list = s.type === 'range' ? [['start', 'Inicio'], ['end', 'Fin'], ['offset', 'Desplazamiento'], ['amount', 'Cantidad']] : [['maxAmount', 'Cantidad máxima'], ['minAmount', 'Cantidad mínima'], ['speed', 'Ondulaciones/segundo'], ['correlation', 'Correlación']];
            for (const [k, n] of list) addProp(out, l, `${base}.${k}`, 4, n);
          });
        }
      }
    }
    if (l.shapes) {
      const g = `${l.id}|shapes`;
      out.push({ kind: 'group', l, key: g, label: 'Contenido', depth: 1 });
      if (open.has(g)) for (const s of l.shapes) {
        const sg = `${l.id}|s|${s.id}`;
        out.push({ kind: 'group', l, key: sg, label: s.name, depth: 2, tools: [shapeTools(c, l, s.id)] });
        if (!open.has(sg)) continue;
        const b = `shapes.${s.id}`;
        if (s.kind === 'rect') { addProp(out, l, `${b}.size`, 3, 'Tamaño'); addProp(out, l, `${b}.roundness`, 3, 'Redondez'); }
        else if (s.kind === 'ellipse') addProp(out, l, `${b}.size`, 3, 'Tamaño');
        else if (s.kind === 'star' || s.kind === 'polygon') { addProp(out, l, `${b}.points`, 3, 'Puntos'); addProp(out, l, `${b}.outerRadius`, 3, 'Radio exterior'); if (s.kind === 'star') addProp(out, l, `${b}.innerRadius`, 3, 'Radio interior'); }
        else if (s.kind === 'path') addProp(out, l, `${b}.path`, 3, 'Trazado');
        if (s.fill.on) { addProp(out, l, `${b}.fill.color`, 3, 'Relleno'); addProp(out, l, `${b}.fill.opacity`, 3, 'Opacidad de relleno'); }
        if (s.stroke.on) { addProp(out, l, `${b}.stroke.color`, 3, 'Trazo'); addProp(out, l, `${b}.stroke.width`, 3, 'Anchura de trazo'); addProp(out, l, `${b}.stroke.opacity`, 3, 'Opacidad de trazo'); }
        if (s.trim) for (const [k, n] of [['start', 'Recortar: inicio'], ['end', 'Recortar: fin'], ['offset', 'Recortar: desplazamiento']]) addProp(out, l, `${b}.trim.${k}`, 3, n);
        if (s.repeater) for (const [k, n] of [['copies', 'Repetidor: copias'], ['position', 'Repetidor: posición'], ['scale', 'Repetidor: escala'], ['rotation', 'Repetidor: rotación'], ['startOpacity', 'Repetidor: opacidad inicial'], ['endOpacity', 'Repetidor: opacidad final']]) addProp(out, l, `${b}.repeater.${k}`, 3, n);
        if (s.zigzag) for (const [k, n] of [['size', 'Zigzag: tamaño'], ['ridges', 'Zigzag: crestas']]) addProp(out, l, `${b}.zigzag.${k}`, 3, n);
        if (s.pucker) addProp(out, l, `${b}.pucker.amount`, 3, 'Contraer y engordar');
        if (s.roundCorners) addProp(out, l, `${b}.roundCorners.radius`, 3, 'Redondear esquinas: radio');
        if (s.offset) addProp(out, l, `${b}.offset.amount`, 3, 'Desplazar trazados: cantidad');
        if (s.twist) { addProp(out, l, `${b}.twist.angle`, 3, 'Torcer: ángulo'); addProp(out, l, `${b}.twist.center`, 3, 'Torcer: centro'); }
        if (s.wiggle) for (const [k, n] of [['size', 'Ondular: tamaño'], ['detail', 'Ondular: detalle'], ['speed', 'Ondular: ondulaciones/s'], ['phase', 'Ondular: fase']]) addProp(out, l, `${b}.wiggle.${k}`, 3, n);
        if (s.wiggleTransform) for (const [k, n] of [['speed', 'Ondulación: ondulaciones/segundo'], ['correlation', 'Ondulación: correlación'], ['temporalPhase', 'Ondulación: fase temporal'], ['spatialPhase', 'Ondulación: fase espacial'], ['anchor', 'Ondulación: punto de anclaje'], ['position', 'Ondulación: posición'], ['scale', 'Ondulación: escala'], ['rotation', 'Ondulación: rotación']]) addProp(out, l, `${b}.wiggleTransform.${k}`, 3, n);
        for (const [k, n] of [['position', 'Posición'], ['scale', 'Escala'], ['rotation', 'Rotación'], ['opacity', 'Opacidad']]) addProp(out, l, `${b}.transform.${k}`, 3, n);
      }
    }
    if (l.masks.length) {
      const g = `${l.id}|masks`;
      out.push({ kind: 'group', l, key: g, label: 'Máscaras', depth: 1 });
      if (open.has(g)) for (const m of l.masks) {
        const mg = `${l.id}|m|${m.id}`;
        out.push({ kind: 'group', l, key: mg, label: m.name, depth: 2, tools: [maskTools(c, l, m.id)] });
        if (!open.has(mg)) continue;
        for (const [k, n] of [['path', 'Trazado de máscara'], ['feather', 'Calado'], ['opacity', 'Opacidad'], ['expansion', 'Expansión']]) addProp(out, l, `masks.${m.id}.${k}`, 3, n);
      }
    }
    if (l.puppet?.pins.length) {
      const g = `${l.id}|pp`;
      const onBox = h('input', { type: 'checkbox', checked: l.puppet.on, title: 'Activar' }) as HTMLInputElement;
      onBox.onchange = () => void mop('puppetSet', c.id, l.id, { on: onBox.checked });
      out.push({ kind: 'group', l, key: g, label: 'Marioneta', depth: 1, tools: [h('span', { class: 'seltools' }, onBox)] });
      if (open.has(g)) for (const pin of l.puppet.pins) addProp(out, l, `puppet.${pin.id}.position`, 2, pin.name);
    }
    if (l.styles?.length) {
      const g = `${l.id}|st`;
      out.push({ kind: 'group', l, key: g, label: 'Estilos de capa', depth: 1 });
      if (open.has(g)) for (const st of l.styles) {
        const sg = `${l.id}|y|${st.id}`;
        const onBox = h('input', { type: 'checkbox', checked: st.on, title: 'Activar' }) as HTMLInputElement;
        onBox.onchange = () => void mop('styleSet', c.id, l.id, st.fx, { on: onBox.checked });
        out.push({ kind: 'group', l, key: sg, label: st.name, depth: 2, tools: [h('span', { class: 'seltools' }, onBox, h('button', { class: 'mini', title: 'Quitar estilo', onclick: () => void mop('styleSet', c.id, l.id, st.fx, { remove: true }) }, '✕'))] });
        if (!open.has(sg)) continue;
        let def; try { def = styleDef(st.fx); } catch { def = undefined; }
        for (const pd of def?.params ?? []) addProp(out, l, `styles.${st.id}.${pd.id}`, 3, pd.name, specFor(pd.def, pd));
      }
    }
    const sub = l.type === 'comp' ? adv.comps().find((x) => x.id === l.compId) : undefined;
    if (sub?.essential?.length) {
      // Essential Graphics of the nested comp: changed ones animate like any property, the rest show its value
      const g = `${l.id}|eg`;
      const reset = h('button', { class: 'mini', title: 'Restablecer todas (valores de la composición anidada)', disabled: !l.overrides?.length, onclick: () => void mop('essentialReset', c.id, l.id) }, '↺');
      out.push({ kind: 'group', l, key: g, label: 'Propiedades esenciales', depth: 1, tools: [h('span', { class: 'seltools' }, reset)] });
      if (open.has(g)) for (const ep of sub.essential) {
        const path = `essential.${ep.id}`, ov = l.overrides?.find((x) => x.id === ep.id);
        if (ep.path === 'source') {
          // Media Replacement: any image or video of the project
          const cur = String(ov?.prop.v ?? essentialDefault(sub, ep));
          const sel = h('select', { title: 'Sustituir medios', dataset: { test: `eg-${ep.name}` } }, ...store.project.media.filter((m) => m.kind === 'image' || m.hasVideo).map((m) => h('option', { value: m.id, selected: m.id === cur }, m.path.split(/[\\/]/).pop()!))) as HTMLSelectElement;
          sel.onchange = () => void mop('propSet', c.id, l.id, path, { value: sel.value });
          out.push({ kind: 'action', l, depth: 2, el: h('span', { class: 'seltools' }, h('span', { class: 'nm' }, ep.name), sel) });
        } else if (ov) addProp(out, l, path, 2, ep.name);
        else {
          let v: unknown; try { v = essentialDefault(sub, ep); } catch { v = '?'; }
          out.push({ kind: 'action', l, depth: 2, el: h('span', { class: 'seltools' }, h('span', { class: 'nm', title: `${ep.path} (de la composición «${sub.name}»)` }, ep.name), h('span', { class: 'hint' }, Array.isArray(v) ? v.map((x) => Math.round(Number(x) * 10) / 10).join(', ') : String(v).slice(0, 40)),
            h('button', { class: 'mini', title: 'Cambiar en esta capa (propiedad maestra)', dataset: { test: `eg-${ep.name}` }, onclick: () => void mop('propSet', c.id, l.id, path, { value: v as never }) }, 'Cambiar')) });
        }
      }
    }
    if (l.effects.length) {
      const g = `${l.id}|fx`;
      out.push({ kind: 'group', l, key: g, label: 'Efectos', depth: 1 });
      if (open.has(g)) for (const f of l.effects) {
        const fg = `${l.id}|f|${f.id}`;
        out.push({ kind: 'group', l, key: fg, label: f.name, depth: 2, tools: [fxTools(c, l, f.id)] });
        if (!open.has(fg)) continue;
        let def; try { def = fxDef(f.fx); } catch { def = undefined; }
        for (const pd of def?.params ?? []) addProp(out, l, `effects.${f.id}.${pd.id}`, 3, pd.name, specFor(pd.def, pd));
        if (f.strokes) for (const r of paintRows(c, l, f, open)) if (r.path) addProp(out, l, r.path, r.depth, r.label, r.spec); else out.push({ kind: 'group', l, key: r.key!, label: r.label, depth: r.depth, tools: r.tools });
      }
    }
    if (l.type !== 'audio') {
      const g = `${l.id}|tr`;
      out.push({ kind: 'group', l, key: g, label: 'Transformar', depth: 1, tools: [h('button', { class: 'mini', title: 'Restablecer', onclick: () => void resetTransform(c, l) }, 'Restablecer')] });
      if (open.has(g)) {
        if (l.type !== 'camera' && l.type !== 'light') addProp(out, l, 'transform.anchor', 2, 'Punto de anclaje');
        if (l.transform.positionX) { addProp(out, l, 'transform.positionX', 2, 'Posición X'); addProp(out, l, 'transform.positionY', 2, 'Posición Y'); if (l.threeD) addProp(out, l, 'transform.positionZ', 2, 'Posición Z'); }
        else addProp(out, l, 'transform.position', 2, 'Posición');
        if (l.type !== 'camera' && l.type !== 'light') addProp(out, l, 'transform.scale', 2, 'Escala');
        if (l.threeD) { addProp(out, l, 'transform.rotationX', 2, 'Rotación X'); addProp(out, l, 'transform.rotationY', 2, 'Rotación Y'); }
        addProp(out, l, 'transform.rotation', 2, l.threeD ? 'Rotación Z' : 'Rotación');
        if (l.type !== 'camera' && l.type !== 'light') addProp(out, l, 'transform.opacity', 2, 'Opacidad');
      }
    }
    if (l.camera) {
      addProp(out, l, 'camera.zoom', 1, 'Zoom'); addProp(out, l, 'camera.poi', 1, 'Punto de interés');
      if (l.camera.dof?.on) for (const [k, n] of [['focus', 'Distancia de enfoque'], ['aperture', 'Apertura'], ['blur', 'Nivel de desenfoque']]) addProp(out, l, `camera.dof.${k}`, 1, n);
    }
    if (l.light) {
      const o = l.light;
      addProp(out, l, 'light.intensity', 1, 'Intensidad'); addProp(out, l, 'light.color', 1, 'Color');
      if (o.type === 'spot') { addProp(out, l, 'light.coneAngle', 1, 'Ángulo de cono'); addProp(out, l, 'light.coneFeather', 1, 'Calado de cono'); }
      if (o.type === 'spot' || o.type === 'parallel') addProp(out, l, 'light.poi', 1, 'Punto de interés');
      if (o.falloff !== 'none') { addProp(out, l, 'light.radius', 1, 'Radio'); addProp(out, l, 'light.falloffDistance', 1, 'Distancia de atenuación'); }
      if (o.castsShadows) { addProp(out, l, 'light.shadowDarkness', 1, 'Oscuridad de sombra'); addProp(out, l, 'light.shadowDiffusion', 1, 'Difusión de sombra'); }
    }
    if (l.model) {
      const g = `${l.id}|model`;
      out.push({ kind: 'group', l, key: g, label: 'Opciones de modelo', depth: 1 });
      if (open.has(g)) modelRows(c, l, (path, depth, label) => addProp(out, l, path, depth, label), (el, depth) => out.push({ kind: 'action', l, depth, el }));
    }
    if (extrudable(l)) {
      // extruded text and shapes (extrusion-ui.ts)
      const add = (path: string, depth: number, label: string, spec?: EditorSpec) => addProp(out, l, path, depth, label, spec), act = (el: HTMLElement, depth: number) => out.push({ kind: 'action', l, depth, el });
      const gg = `${l.id}|geo`, gm = `${l.id}|geomat`;
      out.push({ kind: 'group', l, key: gg, label: 'Opciones de geometría', depth: 1 });
      if (open.has(gg)) geometryRows(c, l, add, act);
      out.push({ kind: 'group', l, key: gm, label: 'Opciones de material', depth: 1 });
      if (open.has(gm)) surfaceRows(c, l, add, act);
    }
    if (l.threeD && l.material) for (const [k, n] of [['ambient', 'Material: ambiente'], ['diffuse', 'Material: difusa'], ['specular', 'Material: intensidad especular'], ['shininess', 'Material: brillo especular'], ['metal', 'Material: metal']]) addProp(out, l, `material.${k}`, 1, n);
    if (l.type === 'audio' || l.type === 'video' || l.type === 'sequence' || l.type === 'comp') addProp(out, l, 'audio.level', 1, 'Niveles de audio (dB)');
    if (l.timeRemap) addProp(out, l, 'timeRemap', 1, 'Reasignación de tiempo');
  }
  return out;
}
const ANIM_NAMES: Record<string, string> = { position: 'Posición', scale: 'Escala', rotation: 'Rotación', rotationY: 'Rotación Y', rotationX: 'Rotación X', opacity: 'Opacidad', fill: 'Color de relleno', stroke: 'Color de trazo', tracking: 'Interletraje', blur: 'Desenfocar', skew: 'Sesgar', charOffset: 'Desplazamiento de caracteres', frontColor: 'Color frontal', bevelColor: 'Color de bisel', sideColor: 'Color lateral', backColor: 'Color de fondo' };
const PROP_NAMES: Record<string, string> = { 'transform.anchor': 'Punto de anclaje', 'transform.position': 'Posición', 'transform.scale': 'Escala', 'transform.rotation': 'Rotación', 'transform.rotationX': 'Rotación X', 'transform.rotationY': 'Rotación Y', 'transform.opacity': 'Opacidad', 'transform.positionX': 'Posición X', 'transform.positionY': 'Posición Y', 'transform.positionZ': 'Posición Z' };
function addProp(out: Row[], l: Layer, path: string, depth: number, label?: string, spec?: EditorSpec) {
  const p = propAt(l, path);
  if (!p) return;
  out.push({ kind: 'prop', l, path, label: label ?? PROP_NAMES[path] ?? path.split('.').pop()!, depth, spec: spec ?? specFor(p.v, undefined, path) });
  if (exprOpen.has(`${l.id}|${path}`) || p.x) out.push({ kind: 'expr', l, path, depth });
}

// ───────────────────────── left side (DOM) ─────────────────────────
export function render() {
  const c = adv.comp();
  updateTc();
  if (!c) { left.innerHTML = '<div class="hint" style="padding:16px">Cree o abra una composición.</div>'; rows = []; draw(); return; }
  rows = buildRows(c);
  // during a gesture only the values change: keep the DOM (the dragged control lives there)
  if (adv.work) { refreshValues(); draw(); return; }
  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.append(rowEl(c, r)));
  left.replaceChildren(frag);
  draw();
}
function refreshValues() {
  // cheap update of the value editors without rebuilding (time changed / gesture)
  if (adv.work) return;
  const c = adv.comp();
  if (!c) return;
  left.querySelectorAll<HTMLElement>('.row.prop').forEach((el) => {
    const r = rows[Number(el.dataset.i)];
    if (r?.kind !== 'prop') return;
    const ed = el.querySelector('.pv');
    if (ed) ed.replaceWith(propEditor(r.l.id, r.path, r.spec, r.label));
    const p = propAt(c.layers.find((x) => x.id === r.l.id) ?? r.l, r.path);
    el.querySelector('.kd')?.classList.toggle('on', !!p?.k?.some((k) => Math.abs(k.t - adv.time) < 1e-4));
  });
}

function rowEl(c: Comp, r: Row): HTMLElement {
  const i = rows.indexOf(r);
  if (r.kind === 'layer') return layerRow(c, r.l, i);
  if (r.kind === 'group') {
    const isOpen = open.has(r.key);
    return h('div', { class: 'row group', style: { '--d': String(r.depth) } as Record<string, string>, dataset: { i: String(i) } },
      h('button', { class: `tw${isOpen ? ' open' : ''}`, onclick: () => { toggle(r.key); } }, '▸'),
      h('span', { class: 'nm', onclick: () => toggle(r.key) }, r.label), ...(r.tools ?? []));
  }
  if (r.kind === 'action') return h('div', { class: 'row action', style: { '--d': String(r.depth) } as Record<string, string>, dataset: { i: String(i) } }, r.el);
  if (r.kind === 'expr') {
    const p = propAt(r.l, r.path);
    const ta = h('textarea', { class: 'expr', spellcheck: 'false', placeholder: 'Expresión: wiggle(2, 30), time * 90, loopOut()…', dataset: { test: `expr-${r.path}` } }) as HTMLTextAreaElement;
    ta.value = p?.x ?? '';
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
    ta.addEventListener('change', () => void mop('propSet', c.id, r.l.id, r.path, { expression: ta.value.trim() || null }));
    const err = exprErrors.get(`${r.l.id}|${stable(r.l, r.path)}`);
    return h('div', { class: 'row expr-row', style: { '--d': String(r.depth) } as Record<string, string>, dataset: { i: String(i) } }, ta, err ? h('span', { class: 'err', title: err }, '⚠ ' + err) : null);
  }
  const p = propAt(r.l, r.path)!;
  const keyed = !!p.k?.length;
  const atKey = !!p.k?.some((k) => Math.abs(k.t - adv.time) < 1e-4);
  const sel = adv.graphProp?.layer === r.l.id && adv.graphProp.path === r.path;
  const row = h('div', { class: `row prop${sel ? ' gsel' : ''}`, style: { '--d': String(r.depth) } as Record<string, string>, dataset: { i: String(i), path: r.path, test: `prop-${r.path}` } },
    h('button', { class: `sw${keyed ? ' on' : ''}`, title: 'Cronómetro: animar esta propiedad (Alt+clic: expresión)', dataset: { test: `sw-${r.path}` }, onclick: (e: MouseEvent) => { if (e.altKey) toggleExpr(r.l, r.path); else void stopwatch(c, r.l, r.path); } }, '⏱'),
    h('span', { class: 'nm', title: r.path, onclick: () => { adv.graphProp = { layer: r.l.id, path: r.path }; render(); } }, r.label),
    propEditor(r.l.id, r.path, r.spec, r.label),
    r.spec.type !== 'text' || r.path === 'text.text' ? h('span', { class: 'kn' },
      h('button', { title: 'Fotograma clave anterior (J)', onclick: () => jumpKey(p, -1) }, '‹'),
      h('button', { class: `kd${atKey ? ' on' : ''}`, title: 'Añadir o quitar fotograma clave en el instante actual', dataset: { test: `kd-${r.path}` }, onclick: () => void toggleKey(c, r.l, r.path) }, '◆'),
      h('button', { title: 'Fotograma clave siguiente (K)', onclick: () => jumpKey(p, 1) }, '›')) : null,
    h('button', { class: `ex${p.x ? ' on' : ''}`, title: 'Expresión', onclick: () => toggleExpr(r.l, r.path) }, '='));
  row.oncontextmenu = (e) => { e.preventDefault(); propMenu(e, c, r.l, r.path); };
  return row;
}
/** Right-click on a property: Essential Graphics (expose it to the comps that nest this one) or reset an override. */
function propMenu(e: MouseEvent, c: Comp, l: Layer, path: string) {
  if (path.startsWith('essential.')) { contextMenu(e, [{ label: 'Restablecer (valor de la composición anidada)', fn: () => void mop('essentialReset', c.id, l.id, path.slice(10)) }]); return; }
  const ep = c.essential?.find((x) => x.layer === l.id && x.path === path);
  contextMenu(e, [ep
    ? { label: `Quitar de gráficos esenciales («${ep.name}»)`, fn: () => void mop('essentialRemove', c.id, ep.id) }
    : { label: 'Añadir a gráficos esenciales', fn: () => void mop('essentialAdd', c.id, l.id, path, {}) }]);
}
const stable = (_l: Layer, path: string) => path;

function layerRow(c: Comp, l: Layer, i: number): HTMLElement {
  const sel = adv.selection.has(l.id);
  const idx = c.layers.indexOf(l) + 1;
  const isOpen = open.has(l.id);
  const sw = (on: boolean, icon: string, title: string, fn: () => void, test?: string) => h('button', { class: `s${on ? ' on' : ''}`, title, dataset: test ? { test } : {}, onclick: (e: MouseEvent) => { e.stopPropagation(); fn(); } }, icon);
  const set = (patch: Record<string, unknown>) => void mop('layerSet', c.id, l.id, patch);
  const others = c.layers.filter((x) => x.id !== l.id);
  const mode = h('select', { class: 'mode', title: 'Modo de fusión', dataset: { test: 'layer-mode' } }, ...BLEND_MODES.map((b) => h('option', { value: b.id, selected: b.id === l.blend }, b.name))) as HTMLSelectElement;
  mode.onchange = () => set({ blend: mode.value });
  const matte = h('select', { class: 'matte', title: 'Mate de seguimiento', dataset: { test: 'layer-matte' } }, h('option', { value: '' }, 'Ninguno'),
    ...others.flatMap((o) => MATTE_MODES.map((m) => h('option', { value: `${o.id}|${m.id}`, selected: l.matte?.layer === o.id && l.matte.mode === m.id }, `${o.name}: ${m.name.replace('Mate ', '')}`)))) as HTMLSelectElement;
  matte.onchange = () => { const [lid, mm] = matte.value.split('|'); set({ matte: matte.value ? { layer: lid, mode: mm } : null }); };
  const parent = h('select', { class: 'parent', title: 'Primario (vincular)', dataset: { test: 'layer-parent' } }, h('option', { value: '' }, 'Ninguno'), ...others.map((o) => h('option', { value: o.id, selected: l.parent === o.id }, `${c.layers.indexOf(o) + 1}. ${o.name}`))) as HTMLSelectElement;
  parent.onchange = () => set({ parent: parent.value || null });
  const name = h('span', { class: 'nm', title: 'Doble clic para cambiar el nombre' }, l.name);
  name.ondblclick = (e) => {
    e.stopPropagation();
    const inp = h('input', { value: l.name, class: 'rename' }) as HTMLInputElement;
    name.replaceWith(inp);
    inp.focus(); inp.select();
    const done = (ok: boolean) => { if (ok && inp.value.trim() && inp.value !== l.name) set({ name: inp.value.trim() }); else render(); };
    inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  };
  const el = h('div', { class: `row layer${sel ? ' sel' : ''}${l.hidden ? ' off' : ''}`, draggable: 'true', dataset: { i: String(i), layer: l.id, test: 'layer-row' } },
    sw(!l.hidden, '👁', 'Vídeo (visible)', () => set({ hidden: !l.hidden }), 'layer-eye'),
    sw(l.solo, '●', 'Solo', () => set({ solo: !l.solo })),
    sw(l.locked, '🔒', 'Bloquear', () => set({ locked: !l.locked })),
    h('i', { class: 'lbl', style: { background: l.label } }),
    h('span', { class: 'ix' }, String(idx)),
    h('button', { class: `tw${isOpen ? ' open' : ''}`, dataset: { test: 'layer-twisty' }, onclick: (e: MouseEvent) => { e.stopPropagation(); reveal.delete(l.id); toggle(l.id); } }, '▸'),
    h('span', { class: 'ty' }, TYPE_ICON[l.type] ?? '▭'),
    guideIcon(l),
    name,
    h('span', { class: 'sws' },
      fxOk(l) ? sw(l.motionBlur, '◎', 'Desenfoque de movimiento', () => set({ motionBlur: !l.motionBlur }), 'layer-mb') : null,
      l.type !== 'audio' && l.type !== 'camera' && l.type !== 'light' && l.type !== 'model' ? sw(l.threeD, '⬚', 'Capa 3D', () => set({ threeD: !l.threeD }), 'layer-3d') : null),
    mode, matte, parent);
  el.onpointerdown = (e) => { if ((e.target as HTMLElement).closest('button, select, input')) return; adv.select([l.id], e.shiftKey || e.ctrlKey); };
  el.oncontextmenu = (e) => layerMenu(e, c, l);
  el.ondragstart = (e) => e.dataTransfer!.setData('application/x-cinta-layer', l.id);
  el.ondragover = (e) => { if (e.dataTransfer?.types.includes('application/x-cinta-layer') || e.dataTransfer?.types.includes('application/x-cinta-adv')) { e.preventDefault(); el.classList.add('drop'); } };
  el.ondragleave = () => el.classList.remove('drop');
  el.ondrop = (e) => {
    el.classList.remove('drop');
    const id = e.dataTransfer?.getData('application/x-cinta-layer');
    if (id && id !== l.id) { e.preventDefault(); void mop('layerReorder', c.id, id, idx); return; }
    const raw = e.dataTransfer?.getData('application/x-cinta-adv');
    if (raw) { e.preventDefault(); document.dispatchEvent(new CustomEvent('adv:drop', { detail: { raw, layer: l.id } })); }
  };
  return el;
}
const TYPE_ICON: Record<string, string> = { text: 'T', shape: '★', solid: '■', null: '□', adjustment: '◐', camera: '🎥', light: '💡', video: '▶', image: '🖼', audio: '♪', comp: '▦', sequence: '🎞', model: '🧊' };

function toggle(key: string) { if (open.has(key)) open.delete(key); else open.add(key); render(); }
function toggleExpr(l: Layer, path: string) { const k = `${l.id}|${path}`; if (exprOpen.has(k)) exprOpen.delete(k); else exprOpen.add(k); open.add(l.id); render(); }

export function revealProps(keys: string[], add = false) {
  for (const l of adv.selected().length ? adv.selected() : adv.comp()?.layers ?? []) {
    const list = keys.flatMap((k) => (k === 'transform.position' && l.transform.positionX ? ['transform.positionX', 'transform.positionY', ...(l.threeD ? ['transform.positionZ'] : [])] : [k])).filter((p) => propAt(l, p));
    const cur = add ? reveal.get(l.id) ?? [] : [];
    const next = [...new Set([...cur, ...list])];
    if (!add && reveal.get(l.id)?.join() === next.join()) reveal.delete(l.id); else reveal.set(l.id, next);
  }
  render();
}
export function revealAnimated() {
  for (const l of adv.selected().length ? adv.selected() : adv.comp()?.layers ?? []) {
    const list: string[] = [];
    forEachProp(l, (p, path) => { if (p.k?.length || p.x) list.push(path); });
    if (reveal.has(l.id) && reveal.get(l.id)!.join() === list.join()) reveal.delete(l.id); else reveal.set(l.id, list);
  }
  render();
}
export function collapseAll() { open.clear(); reveal.clear(); render(); }

async function stopwatch(c: Comp, l: Layer, path: string) {
  const p = propAt(l, path)!;
  if (p.k?.length) await mop('keyframeRemove', c.id, l.id, path, 'all');
  else await mop('propSet', c.id, l.id, path, { value: keyedAt(p, adv.time, /position$|anchor$|poi$/.test(path)), t: adv.time });
}
async function toggleKey(c: Comp, l: Layer, path: string) {
  const p = propAt(l, path)!;
  const k = p.k?.find((x) => Math.abs(x.t - adv.time) < 1e-4);
  if (k) await mop('keyframeRemove', c.id, l.id, path, [k.t]);
  else await mop('propSet', c.id, l.id, path, { value: valueAt(p, adv.time, { comp: c, layer: l, path }), t: adv.time });
}
function jumpKey(p: Prop, dir: number) {
  const ks = (p.k ?? []).map((k) => k.t);
  const t = dir < 0 ? [...ks].reverse().find((x) => x < adv.time - 1e-4) : ks.find((x) => x > adv.time + 1e-4);
  if (t !== undefined) adv.seek(t);
}
/** J / K: previous / next keyframe of the visible properties. */
export function jumpAnyKey(dir: number) {
  const c = adv.comp();
  if (!c) return;
  const ts: number[] = [];
  for (const l of adv.selected().length ? adv.selected() : c.layers) forEachProp(l, (p) => p.k?.forEach((k) => ts.push(k.t)));
  ts.sort((a, b) => a - b);
  const t = dir < 0 ? [...ts].reverse().find((x) => x < adv.time - 1e-4) : ts.find((x) => x > adv.time + 1e-4);
  if (t !== undefined) adv.seek(t);
}
async function resetTransform(c: Comp, l: Layer) {
  const w = adv.begin();
  const wl = w?.layers.find((x) => x.id === l.id);
  if (!wl) return;
  const z = wl.transform;
  const center = l.type === 'text' || l.type === 'shape' || l.type === 'null';
  const sw = wl.solid?.width ?? c.width, sh = wl.solid?.height ?? c.height;
  z.anchor = { v: center ? [0, 0, 0] : [sw / 2, sh / 2, 0] };
  z.position = { v: [c.width / 2, c.height / 2, 0] };
  z.scale = { v: [100, 100, 100] };
  delete z.positionX; delete z.positionY; delete z.positionZ;
  z.rotation = { v: 0 }; z.rotationX = { v: 0 }; z.rotationY = { v: 0 }; z.opacity = { v: 100 };
  await adv.commit('Restablecer transformación');
}

function addAnimatorMenu(l: Layer) {
  // After Effects' Animate menu: Enable Per-character 3D, then the animator properties (X rotation needs 3D)
  const per3D = !!l.text?.perChar3D;
  return h('button', { class: 'mini', title: 'Añadir un animador de texto', dataset: { test: 'add-animator' }, onclick: (e: MouseEvent) => contextMenu(e, [
    { label: per3D ? '✓ 3D por carácter' : 'Activar 3D por carácter', fn: () => void mop('layerSet', adv.compId, l.id, { text: { perChar3D: !per3D } }) },
    { sep: true },
    ...Object.entries(ANIM_NAMES).filter(([k]) => (k !== 'rotationX' || per3D) && (!/^(front|bevel|side|back)Color$/.test(k) || l.threeD)).map(([k, n]) => ({ label: /^(front|bevel|side|back)Color$/.test(k) ? `${({ frontColor: 'Frontal', bevelColor: 'Bisel', sideColor: 'Lateral', backColor: 'Posterior' } as Record<string, string>)[k]} ▸ Color` : n, fn: () => void mop('textAnimatorAdd', adv.compId, l.id, { props: { [k]: /Color$/.test(k) ? '#ff0000' : k === 'opacity' ? 0 : k === 'scale' ? [200, 200] : k === 'fill' ? '#ffd400' : k === 'position' ? (per3D ? [0, 0, -200] : [0, -50]) : k === 'rotation' ? 45 : k === 'blur' ? 20 : k === 'charOffset' ? 10 : k === 'tracking' ? 100 : k === 'rotationX' ? 90 : 15 } }).then(() => open.add(`${l.id}|text`)) })),
  ]) }, 'Animar ▸');
}
function selectorTools(c: Comp, l: Layer, anId: string, i: number): HTMLElement {
  const an = l.text!.animators.find((a) => a.id === anId)!;
  const s = an.selectors[i];
  const edit = async (fn: (s: typeof an.selectors[number]) => void) => { const w = adv.begin(); const wl = w?.layers.find((x) => x.id === l.id); const ws = wl?.text?.animators.find((a) => a.id === anId)?.selectors[i]; if (ws) { fn(ws); await adv.commit('Selector'); } };
  const based = h('select', {}, ...[['chars', 'Caracteres'], ['charsNoSpace', 'Caracteres sin espacios'], ['words', 'Palabras'], ['lines', 'Líneas']].map(([v, n]) => h('option', { value: v, selected: s.basedOn === v }, n))) as HTMLSelectElement;
  based.onchange = () => void edit((x) => { x.basedOn = based.value as never; });
  const out = h('span', { class: 'seltools' }, h('b', {}, s.type === 'range' ? 'Selector de rango' : 'Selector de ondulación'), ' basado en ', based);
  if (s.type === 'range') {
    const shape = h('select', { dataset: { test: 'selector-shape' } }, ...[['square', 'Cuadrado'], ['rampUp', 'Rampa hacia arriba'], ['rampDown', 'Rampa hacia abajo'], ['triangle', 'Triángulo'], ['round', 'Redondo'], ['smooth', 'Suave']].map(([v, n]) => h('option', { value: v, selected: s.shape === v }, n))) as HTMLSelectElement;
    shape.onchange = () => void edit((x) => { if (x.type === 'range') x.shape = shape.value as never; });
    const rand = h('input', { type: 'checkbox', checked: s.randomize, title: 'Orden aleatorio' }) as HTMLInputElement;
    rand.onchange = () => void edit((x) => { if (x.type === 'range') x.randomize = rand.checked; });
    out.append(' forma ', shape, h('label', {}, rand, ' aleatorio'));
  }
  void c;
  return out;
}
function shapeTools(c: Comp, l: Layer, sid: string): HTMLElement {
  const s = l.shapes!.find((x) => x.id === sid)!;
  const edit = async (fn: (x: typeof s) => void, label: string) => { const w = adv.begin(); const ws = w?.layers.find((x) => x.id === l.id)?.shapes?.find((x) => x.id === sid); if (ws) { fn(ws); await adv.commit(label); } };
  return h('button', { class: 'mini', title: 'Añadir a la forma', dataset: { test: 'shape-add' }, onclick: (e: MouseEvent) => contextMenu(e, [
    { label: s.fill.on ? 'Quitar relleno' : 'Añadir relleno', fn: () => void edit((x) => { x.fill.on = !x.fill.on; }, 'Relleno') },
    { label: s.stroke.on ? 'Quitar trazo' : 'Añadir trazo', fn: () => void edit((x) => { x.stroke.on = !x.stroke.on; }, 'Trazo') },
    { label: s.trim ? 'Quitar recortar trazados' : 'Recortar trazados', fn: () => void edit((x) => { if (x.trim) delete x.trim; else x.trim = { start: { v: 0 }, end: { v: 100 }, offset: { v: 0 } }; }, 'Recortar trazados') },
    { label: s.repeater ? 'Quitar repetidor' : 'Repetidor', fn: () => void edit((x) => { if (x.repeater) delete x.repeater; else x.repeater = { copies: { v: 3 }, offset: 0, position: { v: [120, 0] }, scale: { v: [100, 100] }, rotation: { v: 0 }, startOpacity: { v: 100 }, endOpacity: { v: 100 } }; }, 'Repetidor') },
    { label: s.wiggle ? 'Quitar ondular trazados' : 'Ondular trazados', fn: () => void edit((x) => { if (x.wiggle) delete x.wiggle; else x.wiggle = { size: { v: 20 }, detail: { v: 8 }, speed: { v: 2 }, phase: { v: 0 }, seed: 1, smooth: true }; }, 'Ondular trazados') },
    ...(s.wiggle ? [{ label: s.wiggle.smooth ? 'Ondular: esquinas (vértices duros)' : 'Ondular: suave', fn: () => void edit((x) => { if (x.wiggle) x.wiggle.smooth = !x.wiggle.smooth; }, 'Ondular trazados') }] : []),
    { label: s.zigzag ? 'Quitar zigzag' : 'Zigzag', fn: () => void edit((x) => { if (x.zigzag) delete x.zigzag; else x.zigzag = { size: { v: 10 }, ridges: { v: 12 }, smooth: false }; }, 'Zigzag') },
    { label: s.pucker ? 'Quitar contraer y engordar' : 'Contraer y engordar', fn: () => void edit((x) => { if (x.pucker) delete x.pucker; else x.pucker = { amount: { v: 50 } }; }, 'Contraer y engordar') },
    { label: s.roundCorners ? 'Quitar redondear esquinas' : 'Redondear esquinas', fn: () => void edit((x) => { if (x.roundCorners) delete x.roundCorners; else x.roundCorners = { radius: { v: 20 } }; }, 'Redondear esquinas') },
    { label: s.offset ? 'Quitar desplazar trazados' : 'Desplazar trazados', fn: () => void edit((x) => { if (x.offset) delete x.offset; else x.offset = { amount: { v: 10 }, join: 'miter', miterLimit: 4 }; }, 'Desplazar trazados') },
    { label: s.wiggleTransform ? 'Quitar transformación de ondulación' : 'Transformación de ondulación', fn: () => void mop('shapeWiggleTransform', c.id, l.id, sid, s.wiggleTransform ? { remove: true } : {}).then(() => { open.add(`${l.id}|s|${sid}`); render(); }) },
    { label: s.twist ? 'Quitar torcer' : 'Torcer', fn: () => void edit((x) => { if (x.twist) delete x.twist; else x.twist = { angle: { v: 90 }, center: { v: [0, 0] } }; }, 'Torcer') },
    { label: s.stroke.gradient ? 'Trazo sólido' : 'Trazo degradado', fn: () => void edit((x) => { if (x.stroke.gradient) delete x.stroke.gradient; else { const w = (x.size.v[0] ?? 200) / 2; x.stroke.gradient = { type: 'linear', start: { v: [-w, 0] }, end: { v: [w, 0] }, colors: [String(x.stroke.color.v), '#6c5ce7'] }; x.stroke.on = true; } }, 'Trazo degradado') },
    { label: s.gradient ? 'Relleno sólido' : 'Relleno degradado', fn: () => void edit((x) => { if (x.gradient) delete x.gradient; else { const w = (x.size.v[0] ?? 200) / 2; x.gradient = { type: 'linear', start: { v: [-w, 0] }, end: { v: [w, 0] }, colors: [String(x.fill.color.v), '#6c5ce7'] }; x.fill.on = true; } }, 'Degradado') },
    ...(s.kind !== 'path' ? [{ label: 'Convertir en trazado', fn: () => void mop('shapeSet', c.id, l.id, sid, { toPath: true }) }] : []),
    { sep: true },
    { label: 'Eliminar forma', fn: () => void mop('shapeRemove', c.id, l.id, sid) },
  ]) }, '+ ▸');
}
function maskTools(c: Comp, l: Layer, mid: string): HTMLElement {
  const m = l.masks.find((x) => x.id === mid)!;
  const mode = h('select', { dataset: { test: 'mask-mode' } }, ...[['add', 'Añadir'], ['subtract', 'Restar'], ['intersect', 'Intersecar'], ['none', 'Ninguno']].map(([v, n]) => h('option', { value: v, selected: m.mode === v }, n))) as HTMLSelectElement;
  mode.onchange = () => void mop('maskSet', c.id, l.id, mid, { mode: mode.value });
  const inv = h('input', { type: 'checkbox', checked: m.inverted }) as HTMLInputElement;
  inv.onchange = () => void mop('maskSet', c.id, l.id, mid, { inverted: inv.checked });
  // mask tracker (video layers): from the current time to the end of the layer; Shift = position, scale and rotation
  const track = l.type === 'video' ? h('button', { class: 'mini', title: 'Seguir lo que hay dentro de la máscara desde aquí: posición, escala y rotación, o perspectiva (plano, como Mocha)', dataset: { test: 'mask-track' }, onclick: (e: MouseEvent) => contextMenu(e, [
    { label: 'Posición', fn: () => void mop('trackMask', c.id, l.id, mid, { at: adv.time, method: 'position' }) },
    { label: 'Posición, escala y rotación', fn: () => void mop('trackMask', c.id, l.id, mid, { at: adv.time, method: 'similarity' }) },
    { label: 'Perspectiva (plano)', fn: () => void mop('trackMask', c.id, l.id, mid, { at: adv.time, method: 'perspective' }) },
    ...c.layers.filter((y) => y.id !== l.id && y.type !== 'camera' && y.type !== 'light' && y.type !== 'audio').map((y) => ({ label: `Perspectiva → esquina fija de «${y.name}»`, fn: () => void mop('trackMask', c.id, l.id, mid, { at: adv.time, method: 'perspective', target: y.id }) })),
  ]) }, 'Seguir ▸') : null;
  return h('span', { class: 'seltools' }, mode, h('label', {}, inv, ' Invertida'), maskRotoBox(c, l, mid), track, h('button', { class: 'mini', title: 'Eliminar máscara', onclick: () => void mop('maskSet', c.id, l.id, mid, { remove: true }) }, '✕'));
}
function fxTools(c: Comp, l: Layer, fid: string): HTMLElement {
  const f = l.effects.find((x) => x.id === fid)!;
  const on = h('input', { type: 'checkbox', checked: f.on, title: 'Activar/desactivar' }) as HTMLInputElement;
  on.onchange = () => void mop('effectSet', c.id, l.id, fid, { on: on.checked });
  return h('span', { class: 'seltools' }, h('label', {}, on, ' fx'), h('button', { class: 'mini', title: 'Quitar efecto', onclick: () => void mop('effectRemove', c.id, l.id, fid) }, '✕'));
}
function layerMenu(e: MouseEvent, c: Comp, l: Layer) {
  if (!adv.selection.has(l.id)) adv.select([l.id]);
  contextMenu(e, [
    { label: 'Duplicar', kbd: 'Ctrl+D', fn: () => void mop('layerDuplicate', c.id, l.id) },
    { label: 'Dividir capa', kbd: 'Ctrl+Mayús+D', fn: () => void mop('layerSplit', c.id, l.id, adv.time) },
    { label: 'Precomponer…', kbd: 'Ctrl+Mayús+C', fn: () => document.dispatchEvent(new CustomEvent('adv:cmd', { detail: 'precompose' })) },
    { sep: true },
    { label: l.threeD ? 'Capa 2D' : 'Capa 3D', fn: () => void mop('layerSet', c.id, l.id, { threeD: !l.threeD }) },
    { label: l.motionBlur ? 'Sin desenfoque de movimiento' : 'Desenfoque de movimiento', fn: () => void mop('layerSet', c.id, l.id, { motionBlur: !l.motionBlur }) },
    ...(l.type === 'video' ? [
      { label: `${l.frameBlend && l.frameBlend !== 'pixel' ? '✓ ' : ''}Mezcla de fotogramas: fusión`, fn: () => void mop('layerSet', c.id, l.id, { frameBlend: l.frameBlend && l.frameBlend !== 'pixel' ? false : 'mix' }) },
      { label: `${l.frameBlend === 'pixel' ? '✓ ' : ''}Mezcla de fotogramas: movimiento de píxeles`, fn: () => void mop('layerSet', c.id, l.id, { frameBlend: l.frameBlend === 'pixel' ? false : 'pixel' }) },
    ] : []),
    ...vectorMenuItems(c, l),
    ...textoMenuItems(c, l, contextMenu, e),
    ...capasLayerItems(c, l, e),
    ...modelMenuItems(c, l, contextMenu, e),
    ...lightMenuItems(c, l, contextMenu, e),
    { label: 'Añadir efecto…', fn: () => document.dispatchEvent(new CustomEvent('adv:cmd', { detail: 'effects' })) },
    ...(fxOk(l) ? [{ label: 'Estilos de capa ▸', fn: () => contextMenu(e, STYLES.map((d) => { const has = l.styles?.some((x) => x.fx === d.id); return { label: has ? `✓ ${d.name}` : d.name, fn: () => void mop('styleSet', c.id, l.id, d.id, has ? { remove: true } : {}).then(() => { open.add(l.id); open.add(`${l.id}|st`); render(); }) }; })) }] : []),
    ...(l.type === 'video' || l.type === 'comp' || l.type === 'sequence' ? [
      { label: l.timeRemap ? 'Reasignación de tiempo (activa)' : 'Activar reasignación de tiempo', disabled: !!l.timeRemap, fn: () => void mop('propSet', c.id, l.id, 'timeRemap', {}).then(() => { open.add(l.id); render(); }) },
      { label: (l.stretch || 1) < 0 ? 'Reproducir hacia delante' : 'Invertir en el tiempo', fn: () => void mop('layerSet', c.id, l.id, { stretch: -(l.stretch || 1) }) },
    ] : []),
    ...(l.type === 'image' || l.type === 'video' ? [c.essential?.some((x) => x.layer === l.id && x.path === 'source')
      ? { label: 'Quitar sustitución de medios de gráficos esenciales', fn: () => void mop('essentialRemove', c.id, c.essential!.find((x) => x.layer === l.id && x.path === 'source')!.id) }
      : { label: 'Añadir a gráficos esenciales (sustitución de medios)', fn: () => void mop('essentialAdd', c.id, l.id, 'source', {}) }] : []),
    ...(l.overrides?.length ? [{ label: 'Restablecer propiedades esenciales', fn: () => void mop('essentialReset', c.id, l.id) }] : []),
    ...(l.type === 'video' && !l.threeD ? [{ label: 'Rastrear cámara 3D', fn: () => void mop<{ frames: number; error: number; zoom: number }>('cameraTrack', c.id, l.id, {}).then((r) => { if (r) toast(`Cámara 3D resuelta: ${r.frames} fotogramas, error medio ${r.error} px. Añada capas 3D: quedan en la escena.`); }) }] : []),
    ...(l.type === 'audio' || l.type === 'video' ? [{ label: 'Convertir audio en fotogramas clave', fn: () => void mop('audioToKeys', c.id, { layers: [l.id] }) }] : []),
    ...((l.transform.scale.k?.length ?? 0) >= 2 ? [{ label: 'Escala exponencial (entre sus claves de escala)', fn: () => void mop('keyframeAssist', c.id, { kind: 'exponentialScale', layers: [l.id], path: 'scale' }) }] : []),
    { label: 'Suavizar todos sus fotogramas clave', kbd: 'F9', fn: () => void mop('keyframeAssist', c.id, { kind: 'easyAll', layers: [l.id] }) },
    { sep: true },
    { label: 'Eliminar', kbd: 'Supr', fn: () => void mop('layerDelete', c.id, [...adv.selection]) },
  ]);
}

// ───────────────────────── canvas: bars and keyframes ─────────────────────────
function scale(c: Comp) {
  const w = right.clientWidth || 600;
  return pxPerSec || (w - 16) / c.duration;
}
const x2t = (c: Comp, x: number) => t0 + x / scale(c);
const t2x = (c: Comp, t: number) => (t - t0) * scale(c);
export function zoomTime(f: number) { const c = adv.comp(); if (!c) return; pxPerSec = Math.max(5, Math.min(4000, scale(c) * f)); draw(); }
export function zoomFitTime() { pxPerSec = 0; t0 = 0; draw(); }

export function draw() {
  const c = adv.comp();
  if (!right) return;
  const dpr = devicePixelRatio || 1;
  const rw = right.parentElement!.clientWidth;
  const totalH = Math.max(rows.length * ROW, body.clientHeight);
  right.style.height = `${rows.length * ROW}px`;
  for (const [cv, w, hh] of [[right, rw, rows.length * ROW], [ruler, ruler.clientWidth, 34]] as const) {
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(hh * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  }
  void totalH;
  drawRuler(c);
  const g = right.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, rw, rows.length * ROW);
  if (!c) return;
  const s = scale(c);
  // work area shading
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(t2x(c, c.workArea[1]), 0, rw, rows.length * ROW);
  g.fillRect(0, 0, t2x(c, c.workArea[0]), rows.length * ROW);
  rows.forEach((r, i) => {
    const y = i * ROW;
    if (r.kind === 'layer') {
      const l = r.l;
      g.fillStyle = adv.selection.has(l.id) ? 'rgba(255,255,255,0.06)' : 'transparent';
      g.fillRect(0, y, rw, ROW);
      const x0 = t2x(c, l.in), x1 = t2x(c, l.out);
      g.globalAlpha = l.hidden ? 0.35 : 1;
      g.fillStyle = shade(l.label, adv.selection.has(l.id) ? 0.55 : 0.38);
      round(g, x0, y + 3, Math.max(2, x1 - x0), ROW - 6, 3);
      g.fill();
      g.strokeStyle = shade(l.label, 0.9);
      g.stroke();
      g.globalAlpha = 1;
      // summary ticks of all keyframes on collapsed layers
      if (!open.has(l.id) && !reveal.has(l.id)) { g.fillStyle = 'rgba(255,255,255,0.7)'; forEachProp(l, (p) => p.k?.forEach((k) => g.fillRect(t2x(c, k.t) - 0.5, y + ROW - 7, 1, 4))); }
    } else if (r.kind === 'group' && strokeSpan(r.l, r.key)) {
      // a paint stroke's duration bar
      const [a, b] = strokeSpan(r.l, r.key)!;
      g.fillStyle = shade(r.l.label, 0.25);
      round(g, t2x(c, a), y + 6, Math.max(2, t2x(c, b) - t2x(c, a)), ROW - 12, 2);
      g.fill();
    } else if (r.kind === 'prop') {
      const p = propAt(r.l, r.path);
      if (!p?.k) return;
      const cy = y + ROW / 2;
      for (const k of p.k) {
        const x = t2x(c, k.t);
        if (x < -10 || x > rw + 10) continue;
        const sel = adv.keys.some((q) => q.layer === r.l.id && q.path === r.path && Math.abs(q.t - k.t) < 1e-4);
        keyShape(g, x, cy, k, sel);
      }
      if (p.x) { g.fillStyle = 'rgba(80,200,120,0.35)'; g.fillRect(0, y + ROW - 3, rw, 2); }
    }
    g.strokeStyle = 'rgba(255,255,255,0.04)';
    g.beginPath(); g.moveTo(0, y + ROW - 0.5); g.lineTo(rw, y + ROW - 0.5); g.stroke();
  });
  // playhead
  const px = t2x(c, adv.time);
  g.strokeStyle = '#e8455a';
  g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, rows.length * ROW); g.stroke();
  void s;
  graphCv.style.display = graphOn ? 'block' : 'none';
  gBar.style.display = graphOn ? 'flex' : 'none';
  if (graphOn) drawGraph(c);
}
function keyShape(g: CanvasRenderingContext2D, x: number, y: number, k: Key, sel: boolean) {
  const r = 5;
  g.fillStyle = sel ? '#ffd400' : '#c9ced9';
  g.strokeStyle = '#111';
  g.beginPath();
  if (k.i === 'hold') { g.rect(x - r + 1, y - r + 1, r * 2 - 2, r * 2 - 2); }
  else if (k.i === 'bezier' || k.eo || k.ei) { g.moveTo(x - r, y - r); g.lineTo(x + r, y - r); g.lineTo(x - r, y + r); g.lineTo(x + r, y + r); g.closePath(); }
  else { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); }
  g.fill();
  g.stroke();
}
function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) { g.beginPath(); g.roundRect(x, y, w, hh, r); }
function shade(c: string, a: number) { const n = parseInt((c || '#888888').slice(1, 7), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

function drawRuler(c: Comp | null) {
  const dpr = devicePixelRatio || 1;
  const g = ruler.getContext('2d')!;
  const W = ruler.clientWidth;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1b1d25';
  g.fillRect(0, 0, W, 34);
  if (!c) return;
  const s = scale(c);
  // work area
  g.fillStyle = '#3d4458';
  g.fillRect(t2x(c, c.workArea[0]), 2, t2x(c, c.workArea[1]) - t2x(c, c.workArea[0]), 7);
  g.fillStyle = '#9aa3bd';
  g.fillRect(t2x(c, c.workArea[0]), 2, 3, 7);
  g.fillRect(t2x(c, c.workArea[1]) - 3, 2, 3, 7);
  // frames on the disk cache: a blue line under the work area (After Effects' disk cache indicator)
  if (diskCache.compId === c.id && diskCache.bits) {
    g.fillStyle = '#3b8cff';
    const bits = diskCache.bits, fw = 1 / c.fps;
    for (let i = 0; i < bits.length; i++) {
      if (!bits[i]) continue;
      let j = i; while (j + 1 < bits.length && bits[j + 1]) j++;
      g.fillRect(t2x(c, i * fw), 10, Math.max(1, t2x(c, (j + 1) * fw) - t2x(c, i * fw)), 2);
      i = j;
    }
  }
  // composition markers and protected regions
  drawCompMarkers(g, c, (t) => t2x(c, t), W);
  // ticks
  const steps = [1 / c.fps, 2 / c.fps, 5 / c.fps, 10 / c.fps, 0.5, 1, 2, 5, 10, 30, 60];
  const step = steps.find((x) => x * s >= 70) ?? 60;
  g.fillStyle = '#8b92a8';
  g.strokeStyle = '#4a5063';
  g.font = '10px Segoe UI';
  for (let t = Math.floor(t0 / step) * step; t <= c.duration + 1e-6; t += step) {
    const x = t2x(c, t);
    if (x < -40) continue;
    if (x > W) break;
    g.beginPath(); g.moveTo(x + 0.5, 22); g.lineTo(x + 0.5, 34); g.stroke();
    g.fillText(tcShort(t, c.fps), x + 3, 20);
  }
  const px = t2x(c, adv.time);
  g.fillStyle = '#e8455a';
  g.beginPath(); g.moveTo(px - 6, 22); g.lineTo(px + 6, 22); g.lineTo(px, 32); g.closePath(); g.fill();
}
export function tcShort(t: number, fps: number) { const f = Math.round(t * fps); const sec = Math.floor(f / fps); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}${step0(f % fps, fps)}`; }
const step0 = (f: number, fps: number) => (fps ? `:${String(f).padStart(2, '0')}` : '');
export function timecode(t: number, fps: number) { const f = Math.round(t * fps); const sec = Math.floor(f / fps); return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}:${String(f % Math.round(fps)).padStart(2, '0')}`; }
function updateTc() { const c = adv.comp(); if (tcEl) tcEl.textContent = c ? timecode(adv.time, c.fps) : '0:00:00:00'; }

function rulerEvents() {
  ruler.addEventListener('pointerdown', (e) => {
    const c = adv.comp();
    if (!c) return;
    const r = ruler.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    try { ruler.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    let mode: 'seek' | 'wa0' | 'wa1' | 'wa' = 'seek';
    if (y < 11) { const a = t2x(c, c.workArea[0]), b = t2x(c, c.workArea[1]); mode = Math.abs(x - a) < 6 ? 'wa0' : Math.abs(x - b) < 6 ? 'wa1' : x > a && x < b ? 'wa' : 'seek'; }
    const wa0 = [...c.workArea] as [number, number];
    const tStart = x2t(c, x);
    const snap = (t: number) => Math.max(0, Math.min(c.duration, Math.round(t * c.fps) / c.fps));
    const mv = (ev: PointerEvent) => {
      const t = x2t(c, ev.clientX - r.left);
      if (mode === 'seek') adv.seek(t);
      else {
        const w = adv.begin()!;
        if (mode === 'wa0') w.workArea = [snap(Math.min(t, wa0[1] - 1 / c.fps)), wa0[1]];
        else if (mode === 'wa1') w.workArea = [wa0[0], snap(Math.max(t, wa0[0] + 1 / c.fps))];
        else { const d = Math.max(-wa0[0], Math.min(c.duration - wa0[1], snap(t - tStart))); w.workArea = [wa0[0] + d, wa0[1] + d]; }
        draw();
      }
    };
    const up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); if (mode !== 'seek') void adv.commit('Área de trabajo'); };
    ruler.addEventListener('pointermove', mv);
    ruler.addEventListener('pointerup', up);
    mv(e);
  });
  ruler.addEventListener('wheel', (e) => { e.preventDefault(); zoomTime(e.deltaY < 0 ? 1.2 : 1 / 1.2); }, { passive: false });
}

function keyEvents() {
  right.addEventListener('pointerdown', (e) => {
    const c = adv.comp();
    if (!c || e.button !== 0) return;
    const r = right.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const row = rows[Math.floor(y / ROW)];
    if (!row) { adv.keys = []; adv.select([]); return; }
    const snap = (t: number) => Math.round(t * c.fps) / c.fps;
    if (row.kind === 'prop') {
      const p = propAt(row.l, row.path);
      const k = p?.k?.find((q) => Math.abs(t2x(c, q.t) - x) < 6);
      if (!k) { if (!e.shiftKey) { adv.keys = []; adv.emit('keys'); } return; }
      const isSel = adv.keys.some((q) => q.layer === row.l.id && q.path === row.path && Math.abs(q.t - k.t) < 1e-4);
      if (e.shiftKey) { if (isSel) adv.keys = adv.keys.filter((q) => !(q.layer === row.l.id && q.path === row.path && Math.abs(q.t - k.t) < 1e-4)); else adv.keys.push({ layer: row.l.id, path: row.path, t: k.t }); }
      else if (!isSel) adv.keys = [{ layer: row.l.id, path: row.path, t: k.t }];
      adv.graphProp = { layer: row.l.id, path: row.path };
      draw();
      // drag the selected keys in time
      const start = adv.keys.map((q) => ({ ...q }));
      const tA = x2t(c, x);
      let moved = false;
      try { right.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      const mv = (ev: PointerEvent) => {
        let dt = snap(x2t(c, ev.clientX - r.left) - tA);
        if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return;
        moved = true;
        if (ev.shiftKey) { const lead = start[0]; dt = Math.abs(lead.t + dt - adv.time) < 8 / scale(c) ? adv.time - lead.t : dt; }
        const w = adv.begin()!;
        for (const q of start) {
          const wl = w.layers.find((l) => l.id === q.layer);
          const wp = wl && propAt(wl, q.path);
          const orig = c.layers.find((l) => l.id === q.layer) && propAt(c.layers.find((l) => l.id === q.layer)!, q.path);
          if (!wp?.k || !orig?.k) continue;
          const idx = orig.k.findIndex((kk) => Math.abs(kk.t - q.t) < 1e-4);
          if (idx >= 0 && wp.k[idx]) wp.k[idx].t = Math.max(0, q.t + dt);
        }
        adv.keys = start.map((q) => ({ ...q, t: Math.max(0, q.t + dt) }));
        adv.emit('comp');
      };
      const up = () => {
        right.removeEventListener('pointermove', mv);
        right.removeEventListener('pointerup', up);
        if (!moved) { adv.seek(k.t); return; }
        const w = adv.work;
        if (w) for (const l of w.layers) forEachProp(l, (p) => { if (p.k) { p.k.sort((a, b) => a.t - b.t); for (let i = p.k.length - 1; i > 0; i--) if (Math.abs(p.k[i].t - p.k[i - 1].t) < 1e-4) p.k.splice(i - 1, 1); } });
        void adv.commit('Mover fotogramas clave');
      };
      right.addEventListener('pointermove', mv);
      right.addEventListener('pointerup', up);
      return;
    }
    if (row.kind !== 'layer') return;
    const l = row.l;
    if (!adv.selection.has(l.id) || e.shiftKey) adv.select([l.id], e.shiftKey);
    const x0 = t2x(c, l.in), x1 = t2x(c, l.out);
    const mode = Math.abs(x - x0) < 6 ? 'in' : Math.abs(x - x1) < 6 ? 'out' : x > x0 && x < x1 ? 'move' : null;
    if (!mode) { adv.seek(x2t(c, x)); return; }
    const tA = x2t(c, x);
    const o = { in: l.in, out: l.out, start: l.start };
    try { right.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return;
      moved = true;
      let dt = snap(x2t(c, ev.clientX - r.left) - tA);
      const w = adv.begin()!;
      const wl = w.layers.find((q) => q.id === l.id)!;
      const orig = c.layers.find((q) => q.id === l.id)!;
      if (mode === 'in') wl.in = Math.max(0, Math.min(o.out - 1 / c.fps, o.in + dt));
      else if (mode === 'out') wl.out = Math.min(c.duration, Math.max(o.in + 1 / c.fps, o.out + dt));
      else {
        dt = Math.max(-o.in, Math.min(c.duration - o.out, dt));
        wl.in = o.in + dt; wl.out = o.out + dt; wl.start = o.start + dt;
        // keyframes travel with the layer
        const src: Prop[] = [];
        forEachProp(orig, (p) => src.push(p));
        let i = 0;
        forEachProp(wl, (p) => { const s = src[i++]; if (p.k && s?.k) p.k.forEach((k, j) => { k.t = s.k![j].t + dt; }); });
      }
      adv.emit('comp');
    };
    const up = () => { right.removeEventListener('pointermove', mv); right.removeEventListener('pointerup', up); if (moved) void adv.commit(mode === 'move' ? 'Mover capa en el tiempo' : 'Recortar capa'); };
    right.addEventListener('pointermove', mv);
    right.addEventListener('pointerup', up);
  });
  right.addEventListener('contextmenu', (e) => {
    const c = adv.comp();
    if (!c) return;
    const r = right.getBoundingClientRect();
    const row = rows[Math.floor((e.clientY - r.top) / ROW)];
    if (row?.kind !== 'prop') return;
    const p = propAt(row.l, row.path);
    const k = p?.k?.find((q) => Math.abs(t2x(c, q.t) - (e.clientX - r.left)) < 6);
    if (!k) return;
    if (!adv.keys.some((q) => q.layer === row.l.id && q.path === row.path && Math.abs(q.t - k.t) < 1e-4)) adv.keys = [{ layer: row.l.id, path: row.path, t: k.t }];
    // Smart Mask Interpolation between the selected mask-path keys (or this key and the next one)
    const mp = /^masks\.([^.]+)\.path$/.exec(row.path);
    const sel = adv.keys.filter((q) => q.layer === row.l.id && q.path === row.path).map((q) => q.t).sort((a, b) => a - b);
    const next = p!.k!.find((q) => q.t > k.t + 1e-6);
    const span: [number, number] | null = sel.length >= 2 ? [sel[0], sel[sel.length - 1]] : next ? [k.t, next.t] : null;
    contextMenu(e, [
      ...(mp && span ? [{ label: 'Interpolación inteligente de máscaras…', fn: () => smartMaskDialog(c, row.l, mp[1], span[0], span[1]) }, { sep: true }] : []),
      { label: 'Velocidad de fotograma clave...', kbd: 'Ctrl+Mayús+K', fn: () => velocityDialog() },
      { label: 'Conmutar mantener fotograma clave', fn: () => void easeSelected('hold') },
      { sep: true },
      { label: 'Desacelerac./Acelerac. suave', kbd: 'F9', fn: () => void easeSelected('easy') },
      { label: 'Desaceleración suave', kbd: 'Mayús+F9', fn: () => void easeSelected('in') },
      { label: 'Aceleración suave', kbd: 'Ctrl+Mayús+F9', fn: () => void easeSelected('out') },
      { label: 'Lineal', fn: () => void easeSelected('linear') },
      { label: 'Curva automática', fn: () => void easeSelected('auto') },
      { sep: true },
      { label: 'Eliminar', kbd: 'Supr', fn: () => void deleteSelectedKeys() },
    ]);
  });
  right.addEventListener('dblclick', (e) => {
    const c = adv.comp();
    const r = right.getBoundingClientRect();
    const row = rows[Math.floor((e.clientY - r.top) / ROW)];
    if (!c || row?.kind !== 'prop') return;
    if (propAt(row.l, row.path)?.k?.some((q) => Math.abs(t2x(c, q.t) - (e.clientX - r.left)) < 6)) velocityDialog();
  });
  right.addEventListener('wheel', (e) => { if (e.ctrlKey || e.altKey) { e.preventDefault(); zoomTime(e.deltaY < 0 ? 1.2 : 1 / 1.2); } else if (e.shiftKey) { e.preventDefault(); const c = adv.comp(); if (c) { t0 = Math.max(0, t0 + (e.deltaY / scale(c)) * 0.5); draw(); } } }, { passive: false });
}

/** Interpolation of the selected keys (After Effects' semantics: Easy Ease In only touches the incoming side…). */
export async function easeSelected(kind: 'easy' | 'in' | 'out' | 'linear' | 'hold' | 'auto') {
  await interpSelected(kind);
}
export async function deleteSelectedKeys() {
  const c = adv.comp();
  if (!c || !adv.keys.length) return false;
  const w = adv.begin()!;
  for (const q of adv.keys) {
    const p = propAt(w.layers.find((l) => l.id === q.layer)!, q.path);
    if (!p?.k) continue;
    p.k = p.k.filter((k) => Math.abs(k.t - q.t) >= 1e-4);
    if (!p.k.length) { delete p.k; }
  }
  adv.keys = [];
  await adv.commit('Eliminar fotogramas clave');
  return true;
}

// ───────────────────────── graph editor (graph.ts) ─────────────────────────
function drawGraph(c: Comp) {
  const W = graphCv.parentElement!.clientWidth, H = body.clientHeight;
  graphCv.style.top = `${body.scrollTop}px`;
  graphCv.style.height = `${H}px`;
  gBar.style.top = `${body.scrollTop + H - 30}px`;
  drawGraphEditor(c, graphCv, W, H, { t2x: (t) => t2x(c, t), x2t: (x) => x2t(c, x), fit: (a, b) => fitTime(c, a, b), redraw: () => draw() });
}
/** time view of the timeline and graph: [a, b] across the width (graph editor's fit buttons) */
function fitTime(c: Comp, a: number, b: number) {
  const w = right.clientWidth || 600;
  const span = Math.max(b - a, 2 / c.fps);
  pxPerSec = Math.max(5, Math.min(4000, (w - 40) / (span * 1.1)));
  t0 = Math.max(0, a - span * 0.05);
}
function graphEvents() { graphEditorEvents(graphCv); }

export function availableEffects() { return FX; }
