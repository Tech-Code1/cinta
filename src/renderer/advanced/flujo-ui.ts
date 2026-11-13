// Flowchart panel (After Effects: Composition Flowchart, Ctrl+Shift+F11; project flowchart Ctrl+F11): the comps,
// their layers, footage and nesting as a node graph over the Composition panel. Button bar as After Effects: show
// layers / footage / solids / effects, flow direction, curved or straight lines. Drag the background to pan, wheel
// to zoom; double-click a comp to open it in the Composition panel, a layer to open its comp with it selected.
import { FLOW_DIRS, flowGraph, type FlowDir, type FlowNode } from '../../core/motion/flujo';
import { h, store } from '../store';
import { bindCommands } from './atajos-ui';
import { css } from './paneles-css';
import { openComp } from './panels';
import { adv } from './state';

const CSS = `
#adv-center { position: relative; }
#adv-flow { position: absolute; left: 0; right: 0; top: 0; bottom: 34px; z-index: 6; background: #15171d; display: none; flex-direction: column; }
#adv-flow.on { display: flex; }
#adv-flow .fbar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; background: var(--bg2); border-bottom: 1px solid var(--line); flex: none; font-size: 12px; }
#adv-flow .fbar .ttl { color: var(--hi); font-weight: 600; margin-right: 8px; }
#adv-flow .fbar .tb.on { background: var(--accent); color: #fff; }
#adv-flow svg { flex: 1; min-height: 0; width: 100%; cursor: grab; user-select: none; }
#adv-flow .node rect { rx: 5; stroke-width: 1.5; }
#adv-flow .node text { font: 12px sans-serif; fill: #e8eaf0; pointer-events: none; }
#adv-flow .node .fx { font-size: 10.5px; fill: #c9b6ff; }
#adv-flow .node:hover rect { stroke: #ffd400; }
#adv-flow .node.cur rect { stroke: #ffd400; stroke-width: 2.5; }
`;
const FILL: Record<string, [string, string]> = { comp: ['#3b3418', '#ffd400'], layer: ['#24324a', '#4aa8ff'], footage: ['#1e3a2e', '#36c48f'], solid: ['#3a2a1e', '#ff8a3d'] };
const ICON: Record<string, string> = { comp: '▦', layer: '▭', footage: '▶', solid: '■' };

const opts = { layers: true, footage: true, solids: false, effects: false, dir: 'LR' as FlowDir, curved: true };
let panel: HTMLElement | null = null;
let svg: SVGSVGElement;
let title: HTMLElement;
let root: string | undefined;
let view = { x: 20, y: 20, k: 1 };
export const flowState = () => ({ open: !!panel?.classList.contains('on'), root, opts: { ...opts }, nodes: lastNodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name, x: n.x, y: n.y })) });
let lastNodes: FlowNode[] = [];

const NS = 'http://www.w3.org/2000/svg';
const s = <K extends keyof SVGElementTagNameMap>(tag: K, a: Record<string, string | number> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
};

function build() {
  if (panel) return panel;
  css('flujo', CSS);
  const center = document.getElementById('adv-center')!;
  title = h('span', { class: 'ttl' });
  const tog = (k: 'layers' | 'footage' | 'solids' | 'effects' | 'curved', label: string, tip: string) => {
    const b = h('button', { class: `tb${opts[k] ? ' on' : ''}`, title: tip, dataset: { test: `flow-${k}` }, onclick: () => { opts[k] = !opts[k]; b.classList.toggle('on', opts[k]); draw(); } }, label);
    return b;
  };
  const dir = h('select', { title: 'Dirección de flujo', dataset: { test: 'flow-dir' } }, ...FLOW_DIRS.map((d) => h('option', { value: d.id, selected: d.id === opts.dir }, d.name))) as HTMLSelectElement;
  dir.onchange = () => { opts.dir = dir.value as FlowDir; view = { x: 20, y: 20, k: view.k }; draw(); };
  svg = s('svg', { 'data-test': 'flow-svg' }) as SVGSVGElement;
  panel = h('section', { id: 'adv-flow', dataset: { test: 'adv-flow' } },
    h('div', { class: 'fbar' }, title,
      tog('layers', 'Capas', 'Mostrar capas'), tog('footage', 'Material de archivo', 'Mostrar material de archivo'), tog('solids', 'Sólidos', 'Mostrar sólidas'), tog('effects', 'Efectos', 'Mostrar efectos'),
      dir, tog('curved', 'Curvas', 'Conmutar entre líneas curvas y líneas rectas'),
      h('button', { class: 'tb', title: 'Zoom al 100 %', onclick: () => { view = { x: 20, y: 20, k: 1 }; place(); } }, '100 %'),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'tb', title: 'Cambiar a panel Composición', dataset: { test: 'flow-close' }, onclick: () => close() }, '✕')),
    svg);
  center.append(panel);
  // pan and zoom
  svg.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('.node')) return;
    const x0 = e.clientX, y0 = e.clientY, v0 = { ...view };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const mv = (ev: PointerEvent) => { view.x = v0.x + ev.clientX - x0; view.y = v0.y + ev.clientY - y0; place(); };
    const up = () => { svg.removeEventListener('pointermove', mv); svg.removeEventListener('pointerup', up); };
    svg.addEventListener('pointermove', mv); svg.addEventListener('pointerup', up);
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k1 = Math.max(0.2, Math.min(3, view.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    view.x = mx - ((mx - view.x) * k1) / view.k; view.y = my - ((my - view.y) * k1) / view.k; view.k = k1;
    place();
  }, { passive: false });
  store.on(() => { if (panel?.classList.contains('on')) draw(); });
  adv.on((why) => { if (why === 'comp' && panel?.classList.contains('on')) draw(); });
  return panel;
}
let layer: SVGGElement;
function place() { layer?.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`); }

function draw() {
  if (!panel) return;
  const comps = store.project.comps ?? [];
  if (root && !comps.some((c) => c.id === root)) root = undefined;
  title.textContent = `Diagrama de flujo: ${root ? comps.find((c) => c.id === root)!.name : comps.length ? 'proyecto' : '(ninguno)'}`;
  const g = flowGraph(store.project, { root, ...opts });
  lastNodes = g.nodes;
  const by = new Map(g.nodes.map((n) => [n.id, n]));
  const horiz = opts.dir === 'LR' || opts.dir === 'RL';
  const defs = s('defs', {}, s('marker', { id: 'flow-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#8a90a6' })));
  layer = s('g') as SVGGElement;
  for (const e of g.edges) {
    const a = by.get(e.from)!, b = by.get(e.to)!;
    // from the side of a facing b to the side of b facing a
    let x1: number, y1: number, x2: number, y2: number;
    if (horiz) { const fwd = b.x >= a.x; x1 = fwd ? a.x + a.w : a.x; y1 = a.y + a.h / 2; x2 = fwd ? b.x : b.x + b.w; y2 = b.y + b.h / 2; }
    else { const fwd = b.y >= a.y; x1 = a.x + a.w / 2; y1 = fwd ? a.y + a.h : a.y; x2 = b.x + b.w / 2; y2 = fwd ? b.y : b.y + b.h; }
    const d = opts.curved ? (horiz ? `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`) : `M${x1},${y1} L${x2},${y2}`;
    layer.append(s('path', { d, fill: 'none', stroke: '#8a90a6', 'stroke-width': 1.3, 'marker-end': 'url(#flow-arrow)' }));
  }
  for (const n of g.nodes) {
    const [fill, stroke] = FILL[n.kind];
    const name = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
    const node = s('g', { class: `node${n.compId && n.kind === 'comp' && n.compId === adv.compId ? ' cur' : ''}`, transform: `translate(${n.x},${n.y})`, 'data-test': `flow-node-${n.kind}`, 'data-id': n.id },
      s('rect', { width: n.w, height: n.h, fill, stroke }),
      s('text', { x: 8, y: 21 }, `${ICON[n.kind]}  ${name}`),
      ...(n.effects ?? []).map((f, i) => s('text', { x: 18, y: 36 + i * 14, class: 'fx' }, `fx ${f}`)));
    node.addEventListener('dblclick', () => openNode(n));
    node.append(s('title', {}, `${n.name}${n.kind === 'comp' ? '\nDoble clic: abrir en el panel Composición' : n.kind === 'layer' ? '\nDoble clic: abrir su composición con la capa seleccionada' : ''}`));
    layer.append(node);
  }
  svg.replaceChildren(defs, layer);
  place();
}
function openNode(n: FlowNode) {
  if (!n.compId) return;
  openComp(n.compId);
  if (n.kind === 'layer' && n.layerId) adv.select([n.layerId]);
  close();
}

/** Opens the Flowchart panel: a comp's flowchart (the active comp) or the whole project's. */
export function openFlowchart(compRoot: boolean) {
  build();
  root = compRoot ? adv.compId ?? undefined : undefined;
  view = { x: 20, y: 20, k: 1 };
  panel!.classList.add('on');
  draw();
}
export function closeFlowchart() { close(); }
function close() { panel?.classList.remove('on'); }

bindCommands({
  'flowchart-comp': () => openFlowchart(true),
  flowchart: () => openFlowchart(false),
});
/** Button for the Composition panel's bar (After Effects: «Diagrama de flujo de la composición»). */
export const flowButton = () => h('button', { class: 'tb', title: 'Diagrama de flujo de la composición (Ctrl+Mayús+F11)', dataset: { test: 'adv-flow-btn' }, onclick: () => openFlowchart(true) }, '⧉');
