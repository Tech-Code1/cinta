// Advanced mode shell: the Simple/Advanced switch (changes the whole window), the After Effects-style layout
// (tools bar, Project/Effects panels, composition viewer, Effect Controls/Character/Align/Preview panels,
// layer timeline), playback (live and RAM preview with sound) and the keyboard shortcuts.
import { forEachProp } from '../../core/motion/ops';
import { paragraphPanel, toggleVerticalType } from './texto-ui';
import { vectorMenuItems } from './vectores-ui';
import type { Comp, LayerType } from '../../core/motion/model';
import { contextMenu } from '../player';
import { api, h, op, store, toast } from '../store';
import { adv, diskFrame, diskWriteInfo, failingExpressions, mop, refreshDiskStatus, storeFrame, type Tool } from './state';
import { addSource, alignPanel, applyPreset, characterPanel, compSettingsDialog, controlsPanel, effectsPanel, exportCompDialog, openComp, precomposeDialog, projectPanel, TEMPLATES } from './panels';
import { collapseAll, deleteSelectedKeys, easeSelected, initTimeline, jumpAnyKey, render as renderTimeline, revealAnimated, revealProps, zoomFitTime, zoomTime } from './timeline';
import { compToClient, draw as drawViewer, editText, finishPen, initViewer, toggleGuides, penActive, refreshSequence, renderer, requestRender, setZoom, showFrame, sources, viewInfo, viewScale } from './viewer';
import { mediaUrl } from '../../motion-render/sources';
import { velocityDialog } from './velodialog';
import { brushesPanel, nextPaintTool, paintPanel } from './paint-ui';
import { scopesPanel } from './scopes-ui';
import { bindCommands, dispatchKey, runCommand, shortcutsDialog } from './atajos-ui';
import { initViews } from './vistas-ui';
import { flowButton } from './flujo-ui';
import { propertiesPanel } from './propiedades-ui';
import { mediaBrowserPanel } from './medios-ui';
import { metadataPanel } from './metadatos-ui';
import { cafPanel, nextRotoTool } from './roto-ui';
import { capasKey, capasLayerItems, compMenu, roiButton } from './capas-ui';

let built = false;
const $ = (id: string) => document.getElementById(id)!;
export const isAdvanced = () => document.body.classList.contains('mode-adv');

/** Switches the whole window between the simple editor and the advanced (motion graphics) mode. */
export async function setMode(advanced: boolean) {
  if (advanced === isAdvanced()) return;
  if (advanced) {
    document.dispatchEvent(new CustomEvent('cinta:stop-simple'));
    build();
    document.body.classList.add('mode-adv');
    if (!adv.comp()) {
      let last: string | null = null;
      try { last = localStorage.getItem('cinta.adv.comp'); } catch { /* private */ }
      const comps = store.project.comps ?? [];
      const id = comps.find((c) => c.id === last)?.id ?? comps[0]?.id ?? null;
      if (id) openComp(id); else adv.emit('comp');
    }
    refreshSequence();
    requestRender();
  } else {
    stopPlayback();
    document.body.classList.remove('mode-adv');
    // compositions used as clips in the simple timeline are refreshed when we come back
    if (store.project.media.some((m) => m.compId)) void api.invoke('motion:sync');
  }
  try { localStorage.setItem('cinta.mode', advanced ? 'adv' : 'simple'); } catch { /* private */ }
  document.querySelectorAll<HTMLButtonElement>('.mode-switch button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'adv') === advanced));
  dispatchEvent(new Event('resize'));
}

/** The pill shown in both layouts. */
export function modeSwitch(): HTMLElement {
  return h('div', { class: 'mode-switch', title: 'Cambia toda la ventana entre el editor simple y el modo avanzado (Ctrl+Mayús+A)' },
    h('button', { class: isAdvanced() ? '' : 'on', dataset: { mode: 'simple', test: 'mode-simple' }, onclick: () => void setMode(false) }, 'Simple'),
    h('button', { class: isAdvanced() ? 'on' : '', dataset: { mode: 'adv', test: 'mode-adv' }, onclick: () => void setMode(true) }, 'Avanzado'));
}

// ───────────────────────── layout ─────────────────────────
const TOOLS: [Tool, string, string, string][] = [
  ['select', '➤', 'Herramienta Selección', 'V'], ['hand', '✋', 'Herramienta Mano', 'H'], ['zoom', '🔍', 'Herramienta Zoom', 'Z'],
  ['rotate', '⟳', 'Herramienta Rotación', 'W'], ['anchor', '⊕', 'Herramienta Punto de anclaje', 'Y'],
  ['rect', '▭', 'Rectángulo (forma o máscara)', 'Q'], ['ellipse', '◯', 'Elipse (forma o máscara)', 'Q'], ['star', '☆', 'Estrella', 'Q'],
  ['pen', '✒', 'Pluma (trazado o máscara)', 'G'], ['feather', '✎', 'Herramienta Calado de máscara: clic en el borde de una máscara añade un punto de calado y arrastrar cambia su radio; Alt+arrastrar, su tensión; Alt+clic lo quita', 'G'], ['text', 'T', 'Texto', 'Ctrl+T'],
  ['track', '⌖', 'Rastrear movimiento: clic sobre una esquina o marca del vídeo y un nulo la seguirá desde aquí hasta el final de la capa', 'Ctrl+Alt+T'],
  ['sketch', '✍', 'Motion Sketch: arrastre la capa seleccionada y su recorrido se graba en tiempo real como fotogramas clave de posición desde el instante actual', 'sin atajo'],
  ['puppet', '📌', 'Herramienta Marioneta: clic pone un pin, arrastrar lo mueve (clave en el instante actual), Alt+clic lo quita', 'Ctrl+P'],
  ['brush', '🖌', 'Herramienta Pincel: pinta en la capa seleccionada', 'Ctrl+B'], ['clone', '⎘', 'Herramienta tampón de clonar: Alt+clic define el origen, arrastrar copia', 'Ctrl+B'], ['eraser', '⌫', 'Herramienta borrador', 'Ctrl+B'],
  ['orbit', '◎', 'Cámara orbital: girar alrededor del punto de interés de la cámara (en la vista de la cámara activa mueve la cámara; en las vistas personalizadas, la vista)', '1 · C'],
  ['pan3d', '✥', 'Cámara panorámica', '2 · C'], ['dolly', '⇕', 'Cámara de travelling: acercarse al punto de interés de la cámara y alejarse de este', '3 · C'],
  ['roto', '✎', 'Herramienta Pincel tipo rotoscopia: arrastre por el primer plano; presione Alt y arrastre por el fondo', 'Alt+W'], ['refine', '≋', 'Herramienta Perfeccionar borde: arrastre sobre el borde de alfa; presione Alt y arrastre para borrar el perfeccionamiento de borde', 'Alt+W'],
];
function build() {
  if (built) return;
  built = true;
  const toolBtns = TOOLS.map(([id, icon, title, key]) => h('button', { class: `tool${adv.tool === id ? ' on' : ''}`, title: `${title} (${key})`, dataset: { tool: id, test: `tool-${id}` }, onclick: () => setTool(id) }, icon));
  const compSel = h('select', { class: 'comp-sel', dataset: { test: 'adv-comp-sel' } }) as HTMLSelectElement;
  compSel.onchange = () => openComp(compSel.value);
  const resSel = h('select', { title: 'Resolución de la vista previa', dataset: { test: 'adv-res' } }, ...[['1', 'Completa'], ['0.5', 'Mitad'], ['0.333', 'Tercio'], ['0.25', 'Cuarto']].map(([v, n]) => h('option', { value: v, selected: Number(v) === adv.res }, n))) as HTMLSelectElement;
  resSel.onchange = () => { adv.res = Number(resSel.value); requestRender(); };
  const zoomSel = h('select', { title: 'Zoom del visor', dataset: { test: 'adv-zoom' } }, ...[['0', 'Ajustar'], ['0.25', '25 %'], ['0.5', '50 %'], ['1', '100 %'], ['2', '200 %']].map(([v, n]) => h('option', { value: v }, n))) as HTMLSelectElement;
  zoomSel.onchange = () => setZoom(Number(zoomSel.value));
  const info = h('span', { class: 'vinfo', dataset: { test: 'adv-info' } });
  const head = h('header', { id: 'adv-head' },
    h('div', { class: 'tools' }, ...toolBtns),
    h('span', { class: 'sep' }),
    h('button', { class: 'tb', dataset: { test: 'adv-add-layer' }, onclick: (e: MouseEvent) => newLayerMenu(e) }, 'Capa ▸'),
    h('button', { class: 'tb', dataset: { test: 'adv-comp-menu' }, onclick: (e: MouseEvent) => compMenu(e, () => { const c = adv.comp(); if (c) compSettingsDialog(c); else compSettingsDialog(null); }) }, 'Composición ▸'),
    compSel,
    h('span', { class: 'grow' }),
    info,
    h('button', { class: 'btn primary small', dataset: { test: 'adv-export' }, onclick: () => { const c = adv.comp(); if (c) void exportCompDialog(c); else toast('No hay composición.', true); } }, 'Exportar'),
    modeSwitch());
  const tabs = (id: string, items: [string, string, (el: HTMLElement) => void][]) => {
    const bar = h('div', { class: 'tabs' });
    const body = h('div', { class: 'tabbody' });
    const els = items.map(([key, , init]) => { const el = h('div', { class: 'tabpane', dataset: { pane: key } }); init(el); return el; });
    const show = (k: string) => { els.forEach((e) => e.classList.toggle('on', e.dataset.pane === k)); bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); };
    items.forEach(([key, label]) => bar.append(h('button', { dataset: { k: key, test: `tab-${key}` }, onclick: () => show(key) }, label)));
    body.append(...els);
    show(items[0][0]);
    return h('section', { class: 'panelset', id }, bar, body);
  };
  const leftTop = tabs('adv-proj', [['project', 'Proyecto', projectPanel], ['mediabrowser', 'Navegador de medios', mediaBrowserPanel]]);
  const leftBot = tabs('adv-fx', [['effects', 'Efectos y ajustes preestablecidos', effectsPanel]]);
  const viewer = h('section', { id: 'adv-viewer' });
  const vbar = h('div', { class: 'vbar' }, zoomSel, resSel,
    h('button', { class: 'tb', title: 'Reproducir / pausar (Espacio)', dataset: { test: 'adv-play' }, onclick: () => togglePlay() }, '▶'),
    h('button', { class: 'tb', title: 'Previsualización RAM: prepara el área de trabajo y la reproduce fluida con sonido (0 del teclado numérico)', dataset: { test: 'adv-ram' }, onclick: () => void ramPreview() }, 'RAM ▶'),
    h('button', { class: 'tb', title: 'Guías: zonas seguras, tercios y centro', dataset: { test: 'adv-guides' }, onclick: (e: MouseEvent) => (e.currentTarget as HTMLElement).classList.toggle('on', toggleGuides()) }, 'Guías'),
    roiButton(),
    h('label', { class: 'tb', title: 'Repetir' }, h('input', { type: 'checkbox', checked: true, dataset: { test: 'adv-loop' }, onchange: (e: Event) => { loop = (e.target as HTMLInputElement).checked; } }), ' Bucle'));
  const right = tabs('adv-right', [['controls', 'Controles de efectos', controlsPanel], ['character', 'Carácter', characterPanel], ['paragraph', 'Párrafo', paragraphPanel], ['align', 'Alinear', alignPanel], ['paint', 'Pintar', paintPanel], ['brushes', 'Pinceles', brushesPanel], ['scopes', 'Ámbitos de Lumetri', scopesPanel], ['properties', 'Propiedades', propertiesPanel], ['metadata', 'Metadatos', metadataPanel], ['caf', 'Relleno según el contenido', cafPanel]]);
  const tl = h('section', { id: 'adv-tl' });
  const root = h('div', { id: 'adv' }, head,
    h('div', { id: 'adv-main' },
      h('div', { id: 'adv-left' }, leftTop, h('div', { class: 'splitter hz', dataset: { split: 'adv-left' } }), leftBot),
      h('div', { class: 'splitter v', dataset: { split: 'left' } }),
      h('div', { id: 'adv-center' }, viewer, vbar),
      h('div', { class: 'splitter v', dataset: { split: 'right' } }),
      h('div', { id: 'adv-rightcol' }, right)),
    h('div', { class: 'splitter h', dataset: { split: 'tl' } }),
    tl);
  document.body.append(root);
  initViewer(viewer);
  initViews(viewer, vbar);
  vbar.append(flowButton());
  initTimeline(tl);
  // hook for the self-test (state + coordinates); harmless in normal use
  (window as unknown as { __adv: unknown }).__adv = { adv, compToClient, renderer, viewInfo, diskWriteInfo };
  splitters(root);
  const refreshHead = () => {
    const comps = store.project.comps ?? [];
    compSel.replaceChildren(...(comps.length ? comps.map((c) => h('option', { value: c.id, selected: c.id === adv.compId }, c.name)) : [h('option', { value: '' }, '(sin composiciones)')]));
    const c = adv.comp();
    info.textContent = c ? `${c.width}×${c.height} · ${c.fps} fps · ${viewInfo.renderMs ? `${Math.round(viewInfo.renderMs)} ms/fotograma` : ''}` : '';
    viewer.classList.toggle('empty', !c);
  };
  adv.on((why) => { if (why === 'comp' || why === 'view') refreshHead(); if (why === 'tool') document.querySelectorAll<HTMLElement>('#adv-head .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === adv.tool)); });
  store.on((why) => {
    if (!isAdvanced()) return;
    if (why === 'state' || why === 'undo' || why === 'redo' || why === 'init') {
      // a change from the main process (our commit, undo, the MCP…): drop stale selections and redraw
      const c = adv.comp();
      if (adv.compId && !c) adv.compId = store.project.comps?.[0]?.id ?? null;
      if (c) for (const id of [...adv.selection]) if (!c.layers.some((l) => l.id === id)) adv.selection.delete(id);
      adv.work = null;
      invalidateRam();
      adv.emit('comp');
    }
  });
  adv.on((why) => {
    if (why === 'comp') invalidateRam();
    // the blue line of disk-cached frames follows the comp, its state and the preview resolution
    const c = adv.comp();
    if ((why === 'comp' || why === 'view') && c && !adv.work) refreshDiskStatus(c.id, { res: adv.res, mbSamples: Math.min(c.motionBlur.samples, adv.res < 1 ? 8 : c.motionBlur.samples) });
  });
  emptyState(viewer);
  document.addEventListener('adv:drop', (e) => {
    const d = (e as CustomEvent<{ raw: string; at?: [number, number]; layer?: string }>).detail;
    const src = JSON.parse(d.raw) as { kind: string; id: string };
    if (d.layer && (src.kind === 'fx' || src.kind === 'preset')) adv.select([d.layer]);
    void addSource(src, d.at);
  });
  document.addEventListener('adv:cmd', (e) => command((e as CustomEvent<string>).detail));
  document.addEventListener('adv:tool', (e) => setTool((e as CustomEvent<Tool>).detail));
  setInterval(refreshHead, 1000);
  refreshHead();
}

function emptyState(viewer: HTMLElement) {
  const box = h('div', { class: 'adv-empty', dataset: { test: 'adv-empty' } },
    h('h2', {}, 'Modo avanzado'),
    h('p', {}, 'Composiciones con capas, fotogramas clave, expresiones, texto animado, formas, máscaras, efectos, 3D con cámara y desenfoque de movimiento.'),
    h('div', { class: 'brow' },
      h('button', { class: 'btn primary', onclick: () => compSettingsDialog(null) }, 'Nueva composición'),
      ...TEMPLATES.map((t) => h('button', { class: 'btn', dataset: { test: `tpl-${t.id}` }, onclick: () => void t.build() }, t.name))),
    store.project.clips.length ? h('p', { class: 'hint' }, 'Consejo: arrastre «Secuencia (modo simple)» desde el panel Proyecto para animar encima de su montaje.') : null);
  viewer.append(box);
}

function splitters(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.splitter').forEach((sp) => {
    sp.addEventListener('pointerdown', (e) => {
      const k = sp.dataset.split!;
      const x0 = e.clientX, y0 = e.clientY;
      const cs = getComputedStyle(root);
      const v0 = parseFloat(cs.getPropertyValue(k === 'left' ? '--adv-left' : k === 'right' ? '--adv-right' : k === 'tl' ? '--adv-tl' : '--adv-proj')) || 0;
      try { sp.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      const mv = (ev: PointerEvent) => {
        if (k === 'left') root.style.setProperty('--adv-left', `${Math.max(180, Math.min(520, v0 + ev.clientX - x0))}px`);
        if (k === 'right') root.style.setProperty('--adv-right', `${Math.max(220, Math.min(560, v0 - (ev.clientX - x0)))}px`);
        if (k === 'tl') root.style.setProperty('--adv-tl', `${Math.max(160, Math.min(innerHeight - 260, v0 - (ev.clientY - y0)))}px`);
        if (k === 'adv-left') root.style.setProperty('--adv-proj', `${Math.max(100, Math.min(innerHeight - 300, v0 + ev.clientY - y0))}px`);
      };
      const up = () => { sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); dispatchEvent(new Event('resize')); };
      sp.addEventListener('pointermove', mv);
      sp.addEventListener('pointerup', up);
    });
  });
}

export function setTool(t: Tool) {
  if (adv.tool === t) return;
  if (penActive()) void finishPen(false);
  adv.tool = t;
  adv.emit('tool');
}

function newLayerMenu(e: MouseEvent) {
  const add = (type: LayerType, o: object = {}) => async () => {
    const c = adv.comp();
    if (!c) return toast('Cree primero una composición.', true);
    const l = await mop<{ id: string }>('layerAdd', c.id, type, { start: type === 'text' ? adv.time : undefined, ...o });
    if (l) { adv.select([l.id]); if (type === 'text') setTimeout(() => editText(l.id), 80); }
  };
  contextMenu(e, [
    { label: 'Texto', kbd: 'Ctrl+Alt+Mayús+T', fn: add('text', { text: 'Texto' }) },
    { label: 'Sólido…', kbd: 'Ctrl+Y', fn: add('solid', { color: '#1d6cff' }) },
    { label: 'Capa de forma', fn: () => setTool('rect') },
    { label: 'Objeto nulo', kbd: 'Ctrl+Alt+Mayús+Y', fn: add('null') },
    { label: 'Capa de ajuste', kbd: 'Ctrl+Alt+Y', fn: add('adjustment') },
    { label: 'Cámara', kbd: 'Ctrl+Alt+Mayús+C', fn: add('camera') },
    { label: 'Luz', kbd: 'Ctrl+Alt+Mayús+L', fn: add('light') },
    { sep: true },
    { label: 'Secuencia del modo simple', fn: () => void addSource({ kind: 'sequence', id: 'seq' }) },
    ...(adv.comp() && adv.first() ? [{ sep: true }, ...vectorMenuItems(adv.comp()!, adv.first()!)] : []),
    ...(adv.comp() && adv.first() ? [{ sep: true }, ...capasLayerItems(adv.comp()!, adv.first()!, e)] : []),
  ]);
}

// ───────────────────────── playback ─────────────────────────
let loop = true;
let raf = 0;
let audio: HTMLAudioElement | null = null;
let ram: { key: string; frames: ImageBitmap[]; from: number } | null = null;
let ramVersion = 0;
function invalidateRam() { ramVersion++; if (ram) { ram.frames.forEach((b) => b.close()); ram = null; } }

export function togglePlay() { if (adv.playing) stopPlayback(); else void startPlayback(false); }
export function stopPlayback() {
  if (!adv.playing) return;
  adv.playing = false;
  cancelAnimationFrame(raf);
  audio?.pause();
  sources.mode = 'exact';
  sources.pauseAll();
  adv.emit('play');
  requestRender();
}
async function playAudio(c: Comp, from: number) {
  audio?.pause();
  const path: string | null = await api.invoke('motion:audio', c.id).catch(() => null);
  if (!path || !adv.playing) return;
  audio = new Audio(mediaUrl(path));
  audio.currentTime = from;
  void audio.play().catch(() => {});
}
async function startPlayback(useRam: boolean) {
  const c = adv.comp();
  if (!c) return;
  adv.playing = true;
  adv.emit('play');
  const [a, b] = c.workArea;
  let t = adv.time >= b - 1 / c.fps || adv.time < a ? a : adv.time;
  if (useRam) t = a;
  sources.mode = useRam ? 'exact' : 'live';
  void playAudio(c, t);
  const wall0 = performance.now(), t0 = t;
  const tick = () => {
    if (!adv.playing) return;
    let now = t0 + (performance.now() - wall0) / 1000;
    if (now >= b) {
      if (!loop) { adv.time = b - 1 / c.fps; stopPlayback(); return; }
      stopPlayback();
      adv.time = a;
      void startPlayback(useRam);
      return;
    }
    now = Math.floor(now * c.fps) / c.fps;
    if (now !== adv.time) {
      adv.time = now;
      if (useRam && ram) { const f = ram.frames[Math.round((now - ram.from) * c.fps)]; if (f) showFrame(f); }
      else requestRender();
      adv.emit('play');
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
/** RAM preview: renders the work area once at preview resolution, then plays it in real time with sound. */
export async function ramPreview() {
  const c = adv.comp();
  if (!c) return;
  stopPlayback();
  const key = `${ramVersion}|${c.id}|${adv.res}|${c.workArea.join()}`;
  if (!ram || ram.key !== key) {
    invalidateRam();
    const v = ramVersion;
    const [a, b] = c.workArea;
    const n = Math.max(1, Math.round((b - a) * c.fps));
    const frames: ImageBitmap[] = [];
    const bar = $('adv-ram-bar') ?? document.body.appendChild(h('div', { id: 'adv-ram-bar' }));
    bar.style.display = 'block';
    sources.mode = 'exact';
    // same motion-blur samples as a still preview frame: both share the disk cache
    const mbSamples = Math.min(c.motionBlur.samples, adv.res < 1 ? 8 : c.motionBlur.samples), f0 = Math.round(a * c.fps);
    for (let i = 0; i < n; i++) {
      if (v !== ramVersion || !isAdvanced()) { bar.style.display = 'none'; return; }
      // disk cache first (frames from an earlier session or before an undo); what is rendered is filed there
      const roi = c.roi?.on ? c.roi.rect : undefined;
      const hit = roi ? null : await diskFrame(c.id, f0 + i, { res: adv.res, mbSamples });
      if (hit?.bmp) frames.push(hit.bmp);
      else {
        const cv = await renderer.render(store.project, c, (f0 + i) / c.fps, { scale: adv.res, mbSamples, guides: true, roi });
        if (hit && !renderer.errors.length && !failingExpressions()) storeFrame(cv, hit.key, hit.version);
        frames.push(await createImageBitmap(cv));
      }
      bar.style.width = `${((i + 1) / n) * 100}%`;
      if (i % 4 === 0) { adv.time = a + i / c.fps; showFrame(frames[i]); adv.emit('play'); await new Promise((r) => setTimeout(r, 0)); }
    }
    bar.style.display = 'none';
    ram = { key, frames, from: a };
    refreshDiskStatus(c.id, { res: adv.res, mbSamples });
  }
  await startPlayback(true);
}

// ───────────────────────── commands & keys ─────────────────────────
export function command(cmd: string): boolean {
  const c = adv.comp();
  switch (cmd) {
    case 'play': togglePlay(); return true;
    case 'ram': void ramPreview(); return true;
    case 'export': if (c) void exportCompDialog(c); return true;
    case 'delete': void deleteSel(); return true;
    case 'duplicate': if (c) for (const l of adv.selected()) void mop('layerDuplicate', c.id, l.id); return true;
    case 'split': if (c) for (const l of adv.selected()) void mop('layerSplit', c.id, l.id, adv.time); return true;
    case 'precompose': precomposeDialog(); return true;
    case 'effects': (document.querySelector('[data-test=adv-fx-search]') as HTMLInputElement | null)?.focus(); return true;
    case 'select-all': if (c) adv.select(c.layers.map((l) => l.id)); return true;
    case 'undo': void op('undo'); return true;
    case 'redo': void op('redo'); return true;
    case 'new-comp': compSettingsDialog(null); return true;
    case 'comp-settings': compSettingsDialog(c ?? null); return true;
    case 'prev-frame': adv.seek(adv.time - adv.frame()); return true;
    case 'next-frame': adv.seek(adv.time + adv.frame()); return true;
    case 'easy-ease': void (adv.keys.length ? easeSelected('easy') : c && mop('keyframeAssist', c.id, { kind: 'easyAll', layers: [...adv.selection] })); return true;
  }
  // commands of the shortcut table (menus of the «paneles» line send their ids)
  return runCommand(cmd);
}
async function deleteSel() {
  const c = adv.comp();
  if (!c) return;
  if (adv.keys.length) { await deleteSelectedKeys(); return; }
  if (adv.selection.size) await mop('layerDelete', c.id, [...adv.selection]);
}
const QTOOLS: Tool[] = ['rect', 'ellipse', 'star'];
/** Keys of the advanced mode: everything goes through the shortcut table (Edit ▸ Keyboard Shortcuts, atajos-ui.ts). */
export function advKey(e: KeyboardEvent): boolean {
  const tgt = e.target;
  if (tgt instanceof Element && tgt.matches('input, textarea, select')) return false;
  if (document.querySelector('.backdrop')) return false;
  // layer tools of the «capas» line (their own keys) first, then the shortcut table
  if (capasKey(e, setTool)) return true;
  return dispatchKey(e);
}
// what each command of the table does (false: not now, the next command on the same key may act)
{
  const C = () => adv.comp();
  const newLayer = (type: LayerType, o: object = {}, edit = false) => () => {
    const c = C();
    if (!c) return false;
    void mop<{ id: string }>('layerAdd', c.id, type, o).then((l) => { if (l) { adv.select([l.id]); if (edit) setTimeout(() => editText(l.id), 80); } });
  };
  const reveal = (path: string[], add: boolean) => () => revealProps(path, add);
  const P = { position: ['transform.position'], scale: ['transform.scale'], rotation: ['transform.rotation', 'transform.rotationX', 'transform.rotationY'], opacity: ['transform.opacity'], anchor: ['transform.anchor'] };
  const work = (start: boolean) => () => {
    const c = C();
    if (!c) return false;
    const w = adv.begin()!;
    w.workArea = start ? [adv.time, Math.max(adv.time + 1 / c.fps, w.workArea[1])] : [Math.min(w.workArea[0], adv.time - 1 / c.fps), adv.time];
    void adv.commit('Área de trabajo');
  };
  const trim = (which: 'in' | 'out', t: boolean) => () => { const c = C(); if (!c || !adv.selection.size) return false; trimOrMove(c, which, t); };
  bindCommands({
    'mode-toggle': () => void setMode(false),
    undo: () => void op('undo'),
    redo: () => void op('redo'),
    duplicate: () => command('duplicate'),
    split: () => command('split'),
    'select-all': () => command('select-all'),
    delete: () => void deleteSel(),
    shortcuts: () => void shortcutsDialog(),
    'new-comp': () => compSettingsDialog(null),
    'comp-settings': () => command('comp-settings'),
    export: () => command('export'),
    'new-text': newLayer('text', { text: 'Texto' }, true),
    'new-solid': newLayer('solid', { color: '#1d6cff' }),
    'new-light': newLayer('light'),
    'new-camera': newLayer('camera'),
    'new-null': newLayer('null'),
    'new-adjustment': newLayer('adjustment'),
    precompose: () => command('precompose'),
    'layer-in': trim('in', false), 'layer-out': trim('out', false), 'trim-in': trim('in', true), 'trim-out': trim('out', true),
    'easy-ease': () => command('easy-ease'),
    'ease-in': () => void easeSelected('in'),
    'ease-out': () => void easeSelected('out'),
    'keyframe-velocity': () => velocityDialog(),
    'prev-key': () => jumpAnyKey(-1),
    'next-key': () => jumpAnyKey(1),
    'zoom-in': () => { const c = C(); if (c) setZoom(Math.min(16, viewScale(c) * 1.25)); },
    'zoom-out': () => { const c = C(); if (c) setZoom(Math.max(0.05, viewScale(c) / 1.25)); },
    'zoom-fit': () => setZoom(0),
    'tool-select': () => setTool('select'), 'tool-hand': () => setTool('hand'), 'tool-zoom': () => setTool('zoom'),
    'tool-rotate': () => setTool('rotate'), 'tool-anchor': () => setTool('anchor'), 'tool-pen': () => setTool('pen'),
    'tool-shape': () => setTool(QTOOLS[(QTOOLS.indexOf(adv.tool) + 1) % QTOOLS.length]),
    // Ctrl+T: the type tool; again: Horizontal ↔ Vertical Type tool
    'tool-text': () => { if (adv.tool === 'text') toggleVerticalType(); else setTool('text'); },
    'tool-paint': () => setTool(nextPaintTool(adv.tool)),
    'tool-puppet': () => setTool('puppet'),
    'tool-track': () => setTool('track'),
    'tool-roto': () => setTool(nextRotoTool(adv.tool)),
    'pen-finish': () => { if (!penActive()) return false; void finishPen(false); },
    deselect: () => { if (penActive()) void finishPen(false); else { adv.select([]); adv.keys = []; adv.emit('keys'); } },
    play: () => togglePlay(),
    ram: () => void ramPreview(),
    'next-frame': () => command('next-frame'),
    'prev-frame': () => command('prev-frame'),
    'go-start': () => adv.seek(0),
    'go-end': () => { const c = C(); if (c) adv.seek(c.duration); },
    'work-start': work(true), 'work-end': work(false),
    'reveal-position': reveal(P.position, false), 'reveal-scale': reveal(P.scale, false), 'reveal-rotation': reveal(P.rotation, false), 'reveal-opacity': reveal(P.opacity, false), 'reveal-anchor': reveal(P.anchor, false),
    'add-position': reveal(P.position, true), 'add-scale': reveal(P.scale, true), 'add-rotation': reveal(P.rotation, true), 'add-opacity': reveal(P.opacity, true), 'add-anchor': reveal(P.anchor, true),
    'reveal-animated': () => revealAnimated(),
    'collapse-all': () => collapseAll(),
    'time-zoom-in': () => zoomTime(1.4),
    'time-zoom-out': () => zoomTime(1 / 1.4),
    'time-zoom-fit': () => zoomFitTime(),
  });
}
/** [ / ]: move the layer so it starts/ends at the playhead; Alt+[ / Alt+]: trim in/out to the playhead. */
function trimOrMove(c: Comp, which: 'in' | 'out', trim: boolean) {
  const w = adv.begin()!;
  for (const id of adv.selection) {
    const l = w.layers.find((x) => x.id === id)!;
    if (trim) { if (which === 'in') l.in = Math.min(adv.time, l.out - 1 / c.fps); else l.out = Math.max(adv.time + 1 / c.fps, l.in + 1 / c.fps); continue; }
    const dt = which === 'in' ? adv.time - l.in : adv.time - l.out;
    l.in += dt; l.out += dt; l.start += dt;
    forEachProp(l, (p) => p.k?.forEach((k) => { k.t += dt; }));
  }
  void adv.commit(trim ? 'Recortar capa' : 'Mover capa');
}

export { applyPreset, renderTimeline, drawViewer };
