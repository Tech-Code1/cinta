// Left workspace: icon rail, categories and collections (import, filters, transitions, titles, stickers,
// more tools) plus the per-clip tool panels that replace the collection when a tool is open.
import { routeImport } from './advanced/importacion-ui';
import type { Clip, ColorAdjust, TitleStyle } from '../core/model';
import { ICONS, type IconName } from './icons';
import { contextMenu, previewSize, previewTry, refreshFrame, stop } from './player';
import { clipEnd as endOf, packMain } from '../core/model';
import { api, auto, clipDur, clipEnd, fmtShort, h, op, store, toast } from './store';
import { DRAG_MIME, type DropPayload } from './timeline';
import { templateCards } from './ux';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Item = { id: string; name: string; category: string; [k: string]: any };
export interface Catalog {
  filters: Item[]; transitions: Item[]; titles: Item[]; titleAnims: Item[]; stickers: Item[]; callouts: Item[];
  masks: Item[]; pip: Item[]; panZoom: Item[]; animations: Item[]; eqPresets: (Item & { gains: number[] })[]; audioEffects: Item[]; audioEnhance: Item[];
  exportPresets: Item[]; aspects: Item[]; generated: { music: string[]; sfx: string[] };
}
export let catalog: Catalog;

const $ = (id: string) => document.getElementById(id)!;
const cats = $('cats');
const title = $('ws-title');
const tools = $('ws-tools');
const body = $('ws-body');

type Tab = 'import' | 'filters' | 'transitions' | 'titles' | 'stickers' | 'tools';
const TABS: { id: Tab; icon: IconName; label: string; tip: string }[] = [
  { id: 'import', icon: 'import', label: 'Importar', tip: 'Importar — Agregue vídeo, audio y fotos.' },
  { id: 'filters', icon: 'filters', label: 'Filtros', tip: 'Filtros — Aplique efectos visuales a vídeos y fotos.' },
  { id: 'transitions', icon: 'transitions', label: 'Transiciones', tip: 'Transiciones — Arrastre una transición entre dos clips para unirlos con una animación.' },
  { id: 'titles', icon: 'titles', label: 'Títulos', tip: 'Títulos — Arrastre un estilo de texto a la línea de tiempo. Doble clic en el clip para personalizarlo.' },
  { id: 'stickers', icon: 'stickers', label: 'Adhesivos', tip: 'Adhesivos y llamadas — Gráficos, flechas y formas para su vídeo.' },
  { id: 'tools', icon: 'tools', label: 'Más herramientas', tip: 'Más herramientas — Mejoras y efectos especiales para el clip seleccionado.' },
];
let tab: Tab = 'import';
let category = 'Importar';
let search = '';
let openTool: string | null = null;
const favs: Record<string, Set<string>> = JSON.parse(localStorage.getItem('cinta.favs') ?? '{}', (_k, v) => (Array.isArray(v) ? new Set(v) : v));
const saveFavs = () => { try { localStorage.setItem('cinta.favs', JSON.stringify(favs, (_k, v) => (v instanceof Set ? [...v] : v))); } catch { /* storage off */ } };

export async function initWorkspace() {
  catalog = await api.invoke('catalog');
  const rail = $('rail');
  for (const t of TABS) {
    const b = h('button', { title: t.tip, html: ICONS[t.icon], dataset: { tab: t.id, test: `tab-${t.id}` }, onclick: () => showTab(t.id) });
    rail.append(b);
  }
  showTab('import');
  store.on((why) => {
    if (why === 'time' || why === 'time-play' || why === 'zoom') return;
    if (openTool) renderTool();
    else if (tab === 'import' && (category === 'Contenedor de medios' || why === 'state')) renderBody();
  });
}

export function showTab(t: Tab, cat?: string) {
  tab = t;
  openTool = null;
  search = '';
  document.querySelectorAll('#rail button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === t));
  const list = categories();
  category = cat ?? list[0];
  renderCats();
  renderBody();
}

function categories(): string[] {
  const uniq = (items: Item[]) => [...new Set(items.map((i) => i.category))];
  switch (tab) {
    case 'import': return ['Importar', 'Contenedor de medios', 'Fondos', 'Música', 'Sonidos'];
    case 'filters': return ['Todos', 'Favoritos', ...uniq(catalog.filters)];
    case 'transitions': return ['Todos', 'Favoritos', ...uniq(catalog.transitions)];
    case 'titles': return ['Todos', 'Favoritos', ...uniq(catalog.titles)];
    case 'stickers': return ['Todos', 'Favoritos', ...uniq(catalog.stickers), 'Llamadas', ...uniq(catalog.callouts).map((c) => `Llamadas · ${c}`)];
    case 'tools': return ['Todas las herramientas', 'Edición de vídeo', 'Edición de audio', 'Inteligencia artificial'];
  }
}

function renderCats() {
  cats.innerHTML = '';
  for (const c of categories()) {
    cats.append(h('button', { class: `cat${c === category ? ' on' : ''}`, title: c, onclick: () => { category = c; openTool = null; renderCats(); renderBody(); } }, c));
  }
}

function header(text: string, withSearch: boolean) {
  title.textContent = text;
  tools.innerHTML = '';
  if (withSearch) {
    const inp = h('input', { placeholder: 'Buscar', value: search }) as HTMLInputElement;
    inp.oninput = () => { search = inp.value; renderBody(true); };
    tools.append(h('label', { class: 'search', html: ICONS.search }, inp));
  }
}

function renderBody(keepHeader = false) {
  if (openTool) return renderTool();
  if (!keepHeader) header(TABS.find((t) => t.id === tab)!.label, tab !== 'import' && tab !== 'tools');
  body.innerHTML = '';
  switch (tab) {
    case 'import': return renderImport();
    case 'filters': return renderCollection('filter', catalog.filters);
    case 'transitions': return renderCollection('transition', catalog.transitions);
    case 'titles': return renderCollection('title', catalog.titles);
    case 'stickers': return renderCollection(category.startsWith('Llamadas') ? 'callout' : 'sticker', category.startsWith('Llamadas') ? catalog.callouts : catalog.stickers);
    case 'tools': return renderToolsGrid();
  }
}

// ───────────────────────── import ─────────────────────────
export async function importAndAdd(paths: string[], add = true, at?: { trackId?: string; time: number }) {
  if (!paths.length) return;
  // folders → image sequences, Premiere projects, Maya scenes (importacion-ui.ts)
  const routed = await routeImport(paths, false);
  const items = [...routed.media, ...((routed.rest.length ? await op<{ id: string; kind: string; width: number; height: number }[]>('importMedia', routed.rest) : []) ?? [])];
  if (!items.length) return;
  // Movavi: offer to match the project to the first file's aspect ratio
  const p = store.project;
  const first = items.find((m) => m.kind === 'video' && m.width);
  if (first && p.clips.length === 0 && Math.abs(first.width / first.height - p.settings.width / p.settings.height) > 0.01) {
    const r = await api.invoke('dialog:message', { type: 'question', title: 'Abriendo archivos', message: 'La relación de aspecto de sus archivos no coincide con el proyecto', detail: '¿Cambiar la configuración del proyecto para que coincida con los archivos?', buttons: ['Cambiar', 'No cambiar'], defaultId: 0 });
    if (r === 0) await op('setSettings', { width: first.width, height: first.height });
  }
  if (!add) return;
  let t = at?.time;
  for (const m of items) {
    const c = await op<Clip>('addClip', m.id, at ? { trackId: at.trackId && compatible(at.trackId, m.kind) ? at.trackId : undefined, at: t } : {});
    if (c && t !== undefined) t = clipEnd(c);
  }
}
function compatible(trackId: string, kind: string) {
  const t = store.track(trackId);
  if (!t) return false;
  if (t.kind === 'audio') return kind === 'audio' || kind === 'video';
  if (kind === 'audio') return false;
  return t.kind === 'main' || t.kind === 'overlay';
}

function renderImport() {
  if (category === 'Importar') {
    const add = h('div', { class: 'split-btn' },
      h('button', { class: 'btn outline-accent', dataset: { test: 'add-files' }, onclick: async () => importAndAdd(await api.invoke('dialog:media', false)) }, 'Añadir archivos'),
      h('button', { class: 'btn outline-accent', title: 'Más opciones', html: ICONS.chevron, onclick: (e: MouseEvent) => contextMenu(e, [
        { label: 'Añadir archivos', fn: async () => importAndAdd(await api.invoke('dialog:media', false)) },
        { label: 'Agregar carpeta', fn: async () => importAndAdd(await api.invoke('dialog:media', true)) },
      ]) }));
    const zone = h('div', { class: 'drop-zone' }, h('div', {}, add, h('div', { style: { marginTop: '16px' } }, 'Arrastre archivos o carpetas aquí')));
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      void importAndAdd([...(e.dataTransfer?.files ?? [])].map((f) => api.pathOf(f)));
    };
    const quick = h('div', { class: 'quick' },
      h('button', { html: `${ICONS.webcam}<span>Grabar<br>vídeo</span>`, onclick: () => recordDialog('video') }),
      h('button', { html: `${ICONS.screen}<span>Grabar<br>pantalla</span>`, onclick: async () => { if (!(await api.invoke('shot:record'))) toast('Para grabar la pantalla instale Shot (el grabador hermano de Cinta) o importe el vídeo grabado.', true); } }),
      h('button', { html: `${ICONS.mic}<span>Grabar<br>audio</span>`, onclick: () => recordDialog('audio') }),
      h('button', { html: `${ICONS.slideshow}<span>Asistente de<br>presentación</span>`, onclick: () => slideshowDialog() }));
    if (!store.project.clips.length) body.append(templateCards({ importAndAdd: (p) => importAndAdd(p), slideshow: () => void slideshowDialog() }));
    body.append(zone, quick);
  } else if (category === 'Contenedor de medios') {
    const grid = h('div', { class: 'grid bin' });
    for (const m of store.project.media) {
      const used = store.project.clips.filter((c) => c.mediaId === m.id).length;
      const th = h('div', { class: 'th' });
      if (m.kind === 'audio') th.innerHTML = ICONS.trackAudio.replace(/width="16" height="16"/, 'width="36" height="36"');
      else void api.invoke('media:thumbs', m.id, 1, 90).then((l: string[]) => { if (l[0]) th.style.backgroundImage = `url(${l[0]})`; });
      const it = h('div', { class: 'item', draggable: 'true', title: `${m.path}\n${m.width ? `${m.width}×${m.height} · ` : ''}${m.duration ? fmtShort(m.duration) : 'foto'} · usado ${used}×` },
        th, h('div', { class: 'meta' }, m.kind === 'image' ? 'foto' : fmtShort(m.duration)), h('div', { class: 'label' }, m.path.split(/[\\/]/).pop()!),
        h('button', { class: 'add', title: 'Añadir a la línea de tiempo', html: ICONS.plus, onclick: (e: MouseEvent) => { e.stopPropagation(); void op('addClip', m.id); } }));
      it.ondragstart = (e) => e.dataTransfer!.setData(DRAG_MIME, JSON.stringify({ kind: 'media', id: m.id }));
      it.ondblclick = () => void op('addClip', m.id);
      it.oncontextmenu = (e) => contextMenu(e, [
        { label: 'Añadir a la línea de tiempo', fn: () => void op('addClip', m.id) },
        { label: 'Mostrar en carpeta', fn: () => void api.invoke('shell:show', m.path) },
        { label: 'Quitar del contenedor', fn: () => void op('removeMedia', m.id) },
      ]);
      grid.append(it);
    }
    if (!store.project.media.length) body.append(h('div', { class: 'hint', style: { padding: '20px 0' } }, 'Aquí aparecerán todos los archivos que importe.'));
    body.append(grid);
  } else if (category === 'Fondos') {
    const grid = h('div', { class: 'grid' });
    const fills = ['#000000', '#ffffff', '#808080', '#1d2a4a', '#e8455a', '#ff8a3d', '#ffd400', '#36c48f', '#1d6cff', '#6c5ce7', 'gradient:#1d6cff,#6c5ce7', 'gradient:#ff8a3d,#e8455a', 'gradient:#36c48f,#1d6cff', 'gradient:#000000,#3f4558', 'gradient:#ffd400,#ff5a1f', 'gradient:#ffffff,#bfe6ff'];
    for (const f of fills) {
      const bg = f.startsWith('gradient:') ? `linear-gradient(135deg, ${f.slice(9)})` : f;
      const it = h('div', { class: 'item', draggable: 'true' }, h('div', { class: 'th', style: { background: bg } }), h('div', { class: 'label' }, f.startsWith('gradient:') ? 'Degradado' : f.toUpperCase()),
        h('button', { class: 'add', html: ICONS.plus, title: 'Añadir', onclick: (e: MouseEvent) => { e.stopPropagation(); void op('addColorClip', f, 4); } }));
      it.ondragstart = (e) => e.dataTransfer!.setData(DRAG_MIME, JSON.stringify({ kind: 'color', id: f }));
      it.ondblclick = () => void op('addColorClip', f, 4);
      grid.append(it);
    }
    body.append(grid);
  } else {
    const kind = category === 'Música' ? 'music' : 'sfx';
    const names: Record<string, string> = { calm: 'Tranquila', upbeat: 'Alegre', dramatic: 'Dramática', corporate: 'Empresa', whoosh: 'Silbido', beep: 'Pitido', pop: 'Pop', impact: 'Impacto', click: 'Clic', ding: 'Campanilla', applause: 'Aplauso', trap: 'Trap', riser: 'Subida', rumble: 'Retumbo', boom: 'Explosión grave', zap: 'Chispazo eléctrico' };
    body.append(h('div', { class: 'hint', style: { marginBottom: '12px' } }, kind === 'music' ? 'Música libre de derechos generada por Cinta. Se añade a la pista de música y baja de volumen sola cuando hay voz.' : 'Efectos de sonido generados por Cinta. Se añaden en la posición del cursor.'));
    const grid = h('div', { class: 'grid' });
    for (const n of catalog.generated[kind]) {
      grid.append(h('div', { class: 'item', onclick: async () => {
        const path = await api.invoke('generate', kind, n, kind === 'music' ? Math.max(30, store.duration() + 2) : undefined);
        if (kind === 'music') await auto('addMusic', path, { duck: true, volume: 0.45 });
        else {
          const t = store.project.tracks.find((x) => x.kind === 'audio' && x.name === 'Efectos') ?? await op<{ id: string }>('addTrack', 'audio', 'Efectos');
          const [m] = (await op<{ id: string }[]>('importMedia', [path])) ?? [];
          if (m && t) await op('addClip', m.id, { trackId: t.id, at: store.time });
        }
      } }, h('div', { class: 'th', html: ICONS.tGen.replace(/width="20" height="20"/, 'width="40" height="40"') }), h('div', { class: 'label' }, names[n] ?? n)));
    }
    body.append(grid);
  }
}

// ───────────────────────── collections ─────────────────────────
function renderCollection(kind: 'filter' | 'transition' | 'title' | 'sticker' | 'callout', items: Item[]) {
  const favKey = kind;
  favs[favKey] ??= new Set();
  let list = items;
  const cat = category.replace(/^Llamadas( · )?/, '');
  if (category === 'Favoritos') list = items.filter((i) => favs[favKey].has(i.id));
  else if (category !== 'Todos' && category !== 'Llamadas') list = items.filter((i) => i.category === cat);
  if (search) { const q = search.toLowerCase(); list = list.filter((i) => `${i.name} ${i.id}`.toLowerCase().includes(q)); }
  if (category === 'Favoritos' && !list.length) {
    body.append(h('div', { class: 'hint', style: { padding: '16px 0' } }, 'Aquí puede encontrar sus favoritos. Haga clic en el icono de corazón de un elemento para agregarlo.'));
    return;
  }
  const grid = h('div', { class: 'grid' });
  for (const it of list) {
    const th = h('div', { class: 'th' });
    if (kind === 'title') {
      th.classList.add('title-th');
      const st = it.style as Partial<TitleStyle>;
      const span = h('span', {}, String(it.sample).split('\\N')[0]);
      Object.assign(span.style, { color: st.color ?? '#fff', background: st.background ? st.backgroundColor : 'transparent', fontStyle: st.italic ? 'italic' : 'normal', fontFamily: st.font ?? 'Segoe UI', WebkitTextStroke: st.outline ? `1px ${st.outlineColor}` : '' });
      th.append(span);
    } else {
      void api.invoke('thumb', kind, it.id).then((u: string | null) => {
        if (!u) return;
        if (kind === 'sticker' || kind === 'callout') th.append(h('img', { class: 'glyph', src: u }));
        else th.style.backgroundImage = `url(${u})`;
      });
    }
    const fav = h('button', { class: `fav${favs[favKey].has(it.id) ? ' on' : ''}`, html: favs[favKey].has(it.id) ? ICONS.heartOn : ICONS.heart, title: 'Favorito' });
    fav.onclick = (e) => {
      e.stopPropagation();
      if (favs[favKey].has(it.id)) favs[favKey].delete(it.id); else favs[favKey].add(it.id);
      saveFavs();
      renderBody(true);
    };
    const el = h('div', { class: 'item', draggable: 'true', title: `${it.name}\nDoble clic o «+» para aplicar; también puede arrastrarlo a la línea de tiempo.`, dataset: { item: it.id, test: `${kind}-${it.id}` } },
      th, fav, h('div', { class: 'label' }, it.name), h('button', { class: 'add', html: ICONS.plus, title: 'Aplicar', onclick: (e: MouseEvent) => { e.stopPropagation(); void applyItem(kind, it); } }));
    el.ondragstart = (e) => e.dataTransfer!.setData(DRAG_MIME, JSON.stringify({ kind, id: it.id }));
    if (kind === 'filter' || kind === 'transition') {
      // hover = try it on the real clip (nothing changes until it is applied)
      el.onmouseenter = () => { clearTimeout(hoverTimer); hoverTimer = window.setTimeout(() => void hoverPreview(kind, it), 350); };
      el.onmouseleave = () => { clearTimeout(hoverTimer); if (hovering) { hovering = false; void previewTry(null); } };
    }
    el.ondblclick = () => { hovering = false; void applyItem(kind, it); };
    el.onclick = () => { document.querySelectorAll('.item.on').forEach((x) => x.classList.remove('on')); el.classList.add('on'); };
    grid.append(el);
  }
  body.append(grid);
}

let hoverTimer = 0;
let hovering = false;
/** Renders the current frame as it would look with this filter / transition (a throw-away copy of the project). */
export async function hoverPreview(kind: 'filter' | 'transition', it: { id: string; name: string }) {
  const p = structuredClone(store.project);
  const main = p.tracks.find((t) => t.kind === 'main')!;
  const mains = p.clips.filter((c) => c.trackId === main.id).sort((a, b) => a.start - b.start);
  const under = (list: Clip[]) => list.find((c) => store.time >= c.start && store.time < endOf(c));
  let time = store.time;
  if (kind === 'filter') {
    const sel = store.first();
    const target = (sel && sel.type !== 'audio' && sel.type !== 'title' ? p.clips.find((c) => c.id === sel.id) : undefined) ?? under(mains);
    if (!target) return;
    target.filters = [...target.filters, { id: 'try', type: it.id, amount: 1, enabled: true }];
    if (time < target.start || time >= endOf(target)) time = target.start + (target.out - target.in) / target.speed / 2;
  } else {
    if (mains.length < 2) return;
    const sel = store.first();
    let i = mains.findIndex((c) => c.id === sel?.id);
    if (i < 0) i = Math.max(0, mains.indexOf(under(mains) ?? mains[0]));
    if (i === mains.length - 1) i--;
    mains[i].transition = { type: it.id, duration: Math.min(1, mains[i].transition?.duration ?? 1) };
    packMain(p);
    time = (mains[i + 1].start + endOf(mains[i])) / 2;
  }
  hovering = true;
  const { w, h: hh } = previewSize();
  await previewTry(() => api.invoke('preview:frameOf', p, time, w, hh), it.name);
}

/** Apply a collection item to the selection / playhead (double click, "+" or keyboard). */
export async function applyItem(kind: string, it: { id: string; sample?: string }, at?: { trackId?: string; time: number; clip?: Clip }) {
  const sel = at?.clip ? [at.clip] : store.selected();
  const time = at?.time ?? store.time;
  switch (kind) {
    case 'filter': {
      const targets = sel.filter((c) => c.type !== 'audio' && c.type !== 'title');
      if (!targets.length) return toast('Seleccione un clip de vídeo o foto en la línea de tiempo para aplicar el filtro.', true);
      for (const c of targets) await op('addFilter', c.id, it.id, 1);
      return toast('Filtro aplicado');
    }
    case 'transition': {
      const main = store.project.tracks.find((t) => t.kind === 'main')!;
      const list = store.project.clips.filter((c) => c.trackId === main.id).sort((a, b) => a.start - b.start);
      let target = sel.find((c) => c.trackId === main.id);
      if (at) {
        // nearest boundary to the drop point
        let best: Clip | undefined, d = Infinity;
        list.slice(0, -1).forEach((c) => { const dd = Math.abs(clipEnd(c) - time); if (dd < d) { d = dd; best = c; } });
        target = best;
      }
      if (!target) return toast('Seleccione un clip de la pista de vídeo (la transición se pone entre ese clip y el siguiente).', true);
      if (list.indexOf(target) === list.length - 1 && list.length > 1) target = list[list.length - 2];
      return void op('setTransition', target.id, it.id, target.transition?.duration ?? 1);
    }
    case 'title': {
      const t = at?.trackId && ['title', 'overlay'].includes(store.track(at.trackId)?.kind ?? '') ? at.trackId : undefined;
      const c = await op<Clip>('addTitle', String(it.sample ?? 'Su texto aquí').replace(/\\N/g, '\n'), { style: it.id, start: time, trackId: t });
      if (c) { store.select([c.id]); openToolFor('title', c); }
      return;
    }
    case 'sticker':
    case 'callout': {
      const t = at?.trackId && ['title', 'overlay'].includes(store.track(at.trackId)?.kind ?? '') ? at.trackId : undefined;
      const c = await op<Clip>('addGraphic', kind, it.id, { start: time, trackId: t });
      if (c) store.select([c.id]);
      return;
    }
  }
}

export async function applyDrop(p: DropPayload, at: { trackId?: string; time: number; clip?: Clip }) {
  if (p.kind === 'media') {
    const m = store.project.media.find((x) => x.id === p.id);
    await op('addClip', p.id, { trackId: at.trackId && m && compatible(at.trackId, m.kind) ? at.trackId : undefined, at: at.time });
  } else if (p.kind === 'color') {
    await op('addColorClip', p.id, 4, { at: at.time, trackId: at.trackId && ['main', 'overlay'].includes(store.track(at.trackId)?.kind ?? '') ? at.trackId : undefined });
  } else {
    const list = p.kind === 'filter' ? catalog.filters : p.kind === 'transition' ? catalog.transitions : p.kind === 'title' ? catalog.titles : p.kind === 'sticker' ? catalog.stickers : catalog.callouts;
    const it = list.find((x) => x.id === p.id);
    if (it) await applyItem(p.kind, it, at);
  }
}

// ───────────────────────── more tools ─────────────────────────
interface ToolDef { id: string; name: string; icon: IconName; group: 'video' | 'audio' | 'ai'; hint: string; isNew?: boolean }
const TOOLS: ToolDef[] = [
  { id: 'color', name: 'Ajustes de color', icon: 'tColor', group: 'video', hint: 'Para cambiar el color, elija un ajuste predefinido o ajústelo a mano. También puede cargar un LUT .cube.' },
  { id: 'crop', name: 'Recortar y girar', icon: 'tCrop', group: 'video', hint: 'Para quitar las bandas negras o acercarse a un objeto, recorte los bordes del vídeo. También puede girarlo y enderezarlo.' },
  { id: 'stabilize', name: 'Estabilización', icon: 'tStab', group: 'video', hint: 'Elimina el movimiento de la cámara del clip seleccionado. Puede llevar algún tiempo en vídeos largos.' },
  { id: 'speed', name: 'Cámara lenta', icon: 'tSpeed', group: 'video', hint: 'Cambie la velocidad del clip (de 0,1× a 10×). «Tono original» mantiene la voz natural.' },
  { id: 'chroma', name: 'Clave de croma', icon: 'tChroma', group: 'video', hint: 'Coloque el clip en la pista superpuesta. Use el cuentagotas para elegir un color de la imagen: ese color se volverá transparente.' },
  { id: 'pip', name: 'Imagen en imagen', icon: 'tPip', group: 'video', hint: 'Arrastre uno de los clips a la pista de vídeo adicional y haga clic en una plantilla para colocar su marco.' },
  { id: 'logo', name: 'Añadir logotipo', icon: 'tLogo', group: 'video', hint: 'Elija una imagen para su logotipo y aplíquela a todo el vídeo.' },
  { id: 'panzoom', name: 'Panorámica y zoom', icon: 'tPan', group: 'video', hint: 'Para mover la cámara dentro del fotograma, seleccione un clip y elija una plantilla, o ajústelo a mano.' },
  { id: 'mask', name: 'Resaltar y esconder', icon: 'tMask', group: 'video', hint: 'Coloque la máscara sobre el objeto que desea resaltar u ocultar. Añada puntos de seguimiento para seguir un objeto que se mueve.' },
  { id: 'animation', name: 'Animación', icon: 'tAnim', group: 'video', hint: 'Haga que los objetos se muevan con plantillas de entrada/salida o con fotogramas clave.' },
  { id: 'scenes', name: 'Detección de escenas', icon: 'tScenes', group: 'video', hint: 'Detecta los cambios de escena y corta el vídeo en clips separados.' },
  { id: 'freeze', name: 'Fotograma fijo', icon: 'tFreeze', group: 'video', hint: 'Inserta una imagen fija del fotograma actual en la pista principal.' },
  { id: 'eq', name: 'Ecualizador', icon: 'tEq', group: 'audio', hint: 'Cambie los niveles de frecuencia del audio con una plantilla o con los controles deslizantes.' },
  { id: 'compressor', name: 'Compresor', icon: 'tComp', group: 'audio', hint: 'Reduce el volumen de los sonidos fuertes o amplifica los bajos.' },
  { id: 'gate', name: 'Puerta de ruido', icon: 'tGate', group: 'audio', hint: 'Atenúa las señales por debajo del umbral (bloquea ruidos no deseados).' },
  { id: 'reverb', name: 'Reverberación', icon: 'tReverb', group: 'audio', hint: 'Añada un efecto de sonido reflejado para que suene más voluminoso.' },
  { id: 'denoise', name: 'Eliminación de ruido', icon: 'tNoise', group: 'audio', hint: 'Mueva el control hacia la derecha para eliminar más ruido. Los niveles altos pueden causar distorsiones.' },
  { id: 'enhance', name: 'Autocorrección de sonido', icon: 'tEnhance', group: 'audio', hint: 'Elija el ajuste para mejorar el sonido.' },
  { id: 'audiofx', name: 'Efectos de audio', icon: 'tAudioFx', group: 'audio', hint: 'Seleccione un efecto para el clip con sonido.' },
  { id: 'sync', name: 'Sincronizar audio', icon: 'tSync', group: 'audio', hint: 'Seleccione dos clips con sonido en distintas pistas (Ctrl+clic). El segundo se moverá para coincidir con el primero.' },
  { id: 'beats', name: 'Detección de ritmo', icon: 'tBeat', group: 'audio', hint: 'Seleccione un clip de música para mostrar marcadores de ritmo en la escala de tiempo.' },
  { id: 'voice', name: 'Grabar voz', icon: 'tVoice', group: 'audio', hint: 'Grabe su voz con el micrófono desde la posición actual.' },
  { id: 'silences', name: 'Quitar silencios', icon: 'tSilence', group: 'ai', hint: 'Corta las pausas de los clips de la pista principal (o de los seleccionados).', isNew: true },
  { id: 'subs', name: 'Subtítulos automáticos', icon: 'tSubs', group: 'ai', hint: 'Transcribe la voz en local (Whisper, sin internet) y crea una pista de subtítulos. También importa y exporta .srt.', isNew: true },
  { id: 'reframe', name: 'Reencuadrar', icon: 'tReframe', group: 'ai', hint: 'Convierte el proyecto a 9:16 (Shorts, Reels, TikTok), 1:1 o 4:5 sin bandas negras.', isNew: true },
  { id: 'music', name: 'Música con atenuación', icon: 'tMusic', group: 'ai', hint: 'Añade música de fondo a todo el proyecto que baja sola cuando hay voz.', isNew: true },
  { id: 'transcript', name: 'Editar con el texto', icon: 'tSubs', group: 'ai', hint: 'Transcriba el vídeo (Whisper, sin internet) y edítelo como un documento: seleccione palabras y quítelas, o quite todas las muletillas.', isNew: true },
  { id: 'translate', name: 'Traducir subtítulos', icon: 'tSubs', group: 'ai', hint: 'Crea una pista de subtítulos en otro idioma con los mismos tiempos.', isNew: true },
  { id: 'chapters', name: 'Capítulos', icon: 'flag', group: 'ai', hint: 'Divide el vídeo en capítulos y copia el texto para la descripción de YouTube.', isNew: true },
  { id: 'tts', name: 'Voz en off desde texto', icon: 'tVoice', group: 'ai', hint: 'Escriba un texto y Cinta lo lee con una voz de Windows (gratis, sin internet).', isNew: true },
  { id: 'shortsai', name: 'Shorts de los mejores momentos', icon: 'tReframe', group: 'ai', hint: 'Convierte los mejores momentos en shorts verticales con la cara centrada, subtítulos palabra a palabra y un título-gancho.', isNew: true },
  { id: 'assistant', name: 'Asistente de IA', icon: 'sparkle', group: 'ai', hint: 'Cómo usar Claude (por MCP) o una IA local con Cinta.', isNew: true },
];

function renderToolsGrid() {
  const groups: [string, ToolDef['group']][] = [['Edición de vídeo', 'video'], ['Edición de audio', 'audio'], ['Inteligencia artificial', 'ai']];
  for (const [label, g] of groups) {
    if (category !== 'Todas las herramientas' && category !== label) continue;
    body.append(h('div', { class: 'tool-group' }, label));
    const grid = h('div', { class: 'tool-grid' });
    for (const t of TOOLS.filter((x) => x.group === g)) {
      grid.append(h('button', { title: t.hint, dataset: { tool: t.id, test: `tool-${t.id}` }, onclick: () => openToolFor(t.id) }, h('span', { html: ICONS[t.icon] }), h('span', {}, t.name), t.isNew ? h('span', { class: 'new' }, 'Cinta') : null));
    }
    body.append(grid);
  }
}

/** Opens a tool / property panel in the workspace. */
export function openToolFor(id: string, c?: Clip) {
  if (c && !store.selection.has(c.id)) store.select([c.id]);
  if (tab !== 'tools' && !['props', 'title', 'transition'].includes(id)) { tab = 'tools'; document.querySelectorAll('#rail button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === 'tools')); }
  openTool = id;
  renderTool();
}
export function closeTool() { openTool = null; renderBody(); }
export function currentTool() { return openTool; }

// ───── panel helpers ─────
function slider(label: string, value: number, min: number, max: number, step: number, apply: (v: number) => void, show: (v: number) => string = (v) => String(+v.toFixed(2)), test?: string) {
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), dataset: test ? { test } : undefined }) as HTMLInputElement;
  const val = h('span', { class: 'val' }, show(value));
  const paint = () => inp.style.setProperty('--p', `${((+inp.value - min) / (max - min)) * 100}%`);
  paint();
  inp.oninput = () => { val.textContent = show(+inp.value); paint(); };
  inp.onchange = () => apply(+inp.value);
  return h('div', { class: 'row' }, h('label', {}, label), inp, val);
}
const pct = (v: number) => `${Math.round(v * 100)} %`;
const sgn = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
function check(label: string, on: boolean, apply: (v: boolean) => void) {
  const inp = h('input', { type: 'checkbox' }) as HTMLInputElement;
  inp.checked = on;
  inp.onchange = () => apply(inp.checked);
  return h('div', { class: 'row two' }, h('label', {}, label), h('div', {}, inp));
}
function select(label: string, value: string, opts: [string, string][], apply: (v: string) => void) {
  const s = h('select', {}, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l))) as HTMLSelectElement;
  s.onchange = () => apply(s.value);
  return h('div', { class: 'row two' }, h('label', {}, label), s);
}
function chips(items: { id: string; name: string }[], current: string | undefined, apply: (id: string) => void) {
  return h('div', { class: 'chips' }, ...items.map((i) => h('button', { class: `chip${i.id === current ? ' on' : ''}`, onclick: () => apply(i.id), dataset: { test: `chip-${i.id}` } }, i.name)));
}
const btn = (label: string, fn: () => void, primary = false, test?: string) => h('button', { class: `btn${primary ? ' primary' : ''}`, onclick: fn, dataset: test ? { test } : undefined }, label);
const need = (text: string) => h('div', { class: 'hint', style: { padding: '12px 0' } }, text);

export const toolTitle = (id: string) => TOOLS.find((t) => t.id === id)?.name ?? (id === 'props' ? 'Propiedades del clip' : id === 'title' ? 'Editar título' : id === 'transition' ? 'Propiedades de la transición' : '');

function renderTool() {
  const id = openTool!;
  header(toolTitle(id), false);
  body.innerHTML = '';
  body.append(h('a', { class: 'back-link', html: `${ICONS.back} Volver`, onclick: () => { openTool = null; renderBody(); } }), buildPanel(id, store.first()));
}

/** The controls of a tool for a clip — used by the workspace and by the inspector. */
export function buildPanel(id: string, c: Clip | undefined, o: { compact?: boolean } = {}): HTMLElement {
  const def = TOOLS.find((t) => t.id === id);
  const panel = h('div', { class: `panel${o.compact ? ' compact' : ''}` });
  if (def && !o.compact) panel.append(h('div', { class: 'hint' }, def.hint));
  const set = (patch: Partial<Clip> | Record<string, unknown>) => c && op('set', c.id, patch);
  const video = c && (c.type === 'video' || c.type === 'image' || c.type === 'color' || c.type === 'sticker' || c.type === 'callout');
  const sound = c && (c.type === 'audio' || (c.type === 'video' && store.media(c)?.hasAudio && !c.audioDetached));
  switch (id) {
    case 'props': {
      if (!c) { panel.append(need('Seleccione un clip en la línea de tiempo para ajustarlo.')); break; }
      if (!o.compact) panel.append(h('div', { class: 'row two' }, h('label', {}, 'Duración:'), h('span', { style: { color: '#fff' } }, `${clipDur(c).toFixed(2)} s`)));
      if (c.type === 'image' || c.type === 'color' || c.type === 'title' || c.type === 'sticker' || c.type === 'callout') {
        const inp = h('input', { type: 'number', min: '0.1', step: '0.1', value: clipDur(c).toFixed(2) }) as HTMLInputElement;
        inp.onchange = () => void op('trim', c.id, { duration: +inp.value });
        panel.append(h('div', { class: 'row two' }, h('label', {}, 'Nueva duración (s):'), inp));
      }
      if (c.type === 'video' || c.type === 'audio') {
        panel.append(slider('Velocidad:', c.speed, 0.1, 10, 0.05, (v) => void set({ speed: v }), (v) => `${v.toFixed(2)}×`, 'speed'));
        panel.append(check('Invertir:', c.reverse, (v) => void set({ reverse: v })));
        panel.append(check('Tono original:', c.keepPitch, (v) => void set({ keepPitch: v })));
      }
      if (sound) {
        panel.append(slider('Volumen:', c.volume, 0, 4, 0.05, (v) => void set({ volume: v }), pct));
        panel.append(check('Normalizar:', c.normalize, (v) => void set({ normalize: v })));
        panel.append(check('Silenciar clip:', c.muted, (v) => void set({ muted: v })));
        // volume envelope ("Agregar punto de volumen" in Movavi's timeline menu)
        const keys = c.volumeKeys ?? [];
        const level = { v: 1 };
        panel.append(h('h3', {}, `Puntos de volumen (${keys.length})`));
        panel.append(slider('Nivel del punto:', 1, 0, 2, 0.05, (v) => (level.v = v), pct));
        panel.append(h('div', { class: 'actions' },
          btn('Agregar punto de volumen aquí', () => {
            const t = +(store.time - c.start).toFixed(3);
            if (t < 0 || t > clipDur(c)) return toast('Coloque el cursor dentro del clip.', true);
            void set({ volumeKeys: [...keys.filter((k) => Math.abs(k.t - t) > 0.02), { t, v: level.v }].sort((a, b) => a.t - b.t) });
          }),
          keys.length ? btn('Restablecer todos los puntos de volumen', () => void set({ volumeKeys: null })) : null));
        if (keys.length) panel.append(h('div', { class: 'hint' }, keys.map((k) => `${k.t.toFixed(2)} s → ${Math.round(k.v * 100)} %`).join(' · ')));
      }
      panel.append(slider('F. entrada:', c.fadeIn, 0, Math.min(10, clipDur(c)), 0.1, (v) => void set({ fadeIn: v }), (v) => `${v.toFixed(1)} s`));
      panel.append(slider('F. salida:', c.fadeOut, 0, Math.min(10, clipDur(c)), 0.1, (v) => void set({ fadeOut: v }), (v) => `${v.toFixed(1)} s`));
      if (c.type !== 'audio') panel.append(slider('Opacidad:', c.opacity, 0, 1, 0.01, (v) => void set({ opacity: v }), pct));
      if (c.filters.length) {
        panel.append(h('h3', {}, 'Efectos aplicados'));
        const list = h('div', { class: 'applied' });
        for (const f of c.filters) {
          const name = catalog.filters.find((x) => x.id === f.type)?.name ?? f.type;
          const r = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(f.amount), title: `Intensidad del efecto: ${pct(f.amount)}` }) as HTMLInputElement;
          r.onchange = () => void op('setFilter', c.id, f.id, { amount: +r.value });
          list.append(h('div', { class: 'fx' }, h('span', {}, name), r,
            h('button', { class: 'ib', title: f.enabled ? 'Deshabilitar el efecto' : 'Habilitar el efecto', html: f.enabled ? ICONS.eye : ICONS.eyeOff, onclick: () => void op('setFilter', c.id, f.id, { enabled: !f.enabled }) }),
            h('button', { class: 'ib', title: 'Quitar', html: ICONS.close, onclick: () => void op('removeFilter', c.id, f.id) })));
        }
        panel.append(list);
      }
      break;
    }
    case 'title': {
      if (!c?.title) { panel.append(need('Haga doble clic en un clip de título para personalizarlo.')); break; }
      const t = c.title;
      const st = (patch: Partial<TitleStyle>) => void set({ title: { ...t, ...patch } });
      const ta = h('textarea', { rows: '3', style: { width: '100%', resize: 'vertical' }, dataset: { test: 'title-text' } }) as HTMLTextAreaElement;
      ta.value = t.text.replace(/\\N/g, '\n');
      ta.onchange = () => st({ text: ta.value });
      panel.append(ta);
      panel.append(select('Estilo:', t.style, catalog.titles.map((x) => [x.id, x.name]), (v) => { const s = catalog.titles.find((x) => x.id === v)!; void set({ title: { ...t, ...s.style, style: v, text: t.text } }); }));
      panel.append(select('Fuente:', t.font, ['Segoe UI', 'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Consolas', 'Georgia', 'Impact', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Comic Sans MS'].map((f) => [f, f]), (v) => st({ font: v })));
      panel.append(slider('Tamaño:', t.size, 12, 300, 1, (v) => st({ size: v }), (v) => `${v}`));
      const color = (label: string, value: string, fn: (v: string) => void) => { const i = h('input', { type: 'color', value }) as HTMLInputElement; i.onchange = () => fn(i.value); return h('div', { class: 'row two' }, h('label', {}, label), i); };
      panel.append(color('Color:', t.color, (v) => st({ color: v })));
      if (t.anim === 'karaoke') panel.append(color('Color de la palabra activa:', t.highlight ?? '#ffd400', (v) => st({ highlight: v })));
      panel.append(check('Mayúsculas:', !!t.uppercase, (v) => st({ uppercase: v })));
      panel.append(h('div', { class: 'row two' }, h('label', {}, 'Formato:'), h('div', { class: 'chips' },
        h('button', { class: `chip${t.bold ? ' on' : ''}`, onclick: () => st({ bold: !t.bold }) }, 'N'),
        h('button', { class: `chip${t.italic ? ' on' : ''}`, onclick: () => st({ italic: !t.italic }) }, 'K'),
        ...(['left', 'center', 'right'] as const).map((a) => h('button', { class: `chip${t.align === a ? ' on' : ''}`, onclick: () => st({ align: a }) }, a === 'left' ? 'Izq.' : a === 'center' ? 'Centro' : 'Der.')))));
      panel.append(slider('Contorno:', t.outline, 0, 20, 1, (v) => st({ outline: v }), (v) => `${v}`));
      panel.append(color('Color del contorno:', t.outlineColor, (v) => st({ outlineColor: v })));
      panel.append(slider('Sombra:', t.shadow, 0, 20, 1, (v) => st({ shadow: v }), (v) => `${v}`));
      panel.append(check('Fondo:', t.background, (v) => st({ background: v })));
      panel.append(color('Color del fondo:', t.backgroundColor, (v) => st({ backgroundColor: v })));
      panel.append(slider('Posición X:', t.x, 0, 1, 0.01, (v) => st({ x: v }), pct));
      panel.append(slider('Posición Y:', t.y, 0, 1, 0.01, (v) => st({ y: v }), pct));
      panel.append(select('Animación:', t.anim, catalog.titleAnims.map((a) => [a.id, a.name]), (v) => st({ anim: v })));
      panel.append(slider('Velocidad de animación:', t.animSpeed, 0.25, 4, 0.25, (v) => st({ animSpeed: v }), (v) => `${v}×`));
      if (t.timerFrom !== undefined) panel.append(slider('Cuenta atrás desde:', t.timerFrom, 1, 120, 1, (v) => st({ timerFrom: v }), (v) => `${v}`));
      panel.append(h('div', { class: 'hint' }, 'También puede mover el texto arrastrándolo en el reproductor.'));
      break;
    }
    case 'transition': {
      const owner = store.selectedTransition ? store.clip(store.selectedTransition) : undefined;
      if (!owner?.transition) { panel.append(need('Seleccione una transición para ajustarla.')); break; }
      const tr = owner.transition;
      panel.append(select('Transición:', tr.type, catalog.transitions.map((x) => [x.id, `${x.category} · ${x.name}`]), (v) => void op('setTransition', owner.id, v, tr.duration)));
      panel.append(slider('Duración:', tr.duration, 0.1, 5, 0.1, (v) => void op('setTransition', owner.id, tr.type, v), (v) => `${v.toFixed(1)} s`));
      panel.append(h('div', { class: 'hint' }, 'La duración no puede ser mayor que la mitad del clip más corto que conecta.'));
      panel.append(h('div', { class: 'actions' }, btn('Aplicar a todos los clips', () => void op('transitionWizard', { type: tr.type, duration: tr.duration })), btn('Quitar transición', () => void op('setTransition', owner.id, null))));
      break;
    }
    case 'color': {
      if (!video) { panel.append(need('Seleccione un clip de vídeo o foto.')); break; }
      const k: ColorAdjust = c.color ?? {};
      const sc = (patch: Partial<ColorAdjust>) => { const next = { ...k, ...patch }; for (const key of Object.keys(next) as (keyof ColorAdjust)[]) if (next[key] === undefined || next[key] === 0) delete next[key]; return set({ color: Object.keys(next).length ? next : null }); };
      panel.append(h('h3', {}, 'Ajustes automáticos'));
      panel.append(chips([{ id: 'auto-contrast', name: 'Contraste automático' }, { id: 'auto-saturation', name: 'Saturación automática' }, { id: 'white-balance', name: 'Balance de blancos' }, { id: 'magic', name: 'Mejora mágica' }], k.preset, (v) => void sc({ preset: k.preset === v ? undefined : (v as ColorAdjust['preset']) })));
      panel.append(h('h3', {}, 'Modo manual'));
      const rows: [keyof ColorAdjust, string, number, number][] = [['brightness', 'Brillo', -1, 1], ['contrast', 'Contraste', -1, 1], ['saturation', 'Saturación', -1, 1], ['hue', 'Tono', -180, 180], ['temperature', 'Temperatura', -1, 1], ['tint', 'Matiz', -1, 1], ['exposure', 'Exposición', -1, 1], ['shadows', 'Sombras', -1, 1], ['highlights', 'Iluminación', -1, 1], ['sharpen', 'Nitidez', 0, 1], ['vignette', 'Viñeta', 0, 1]];
      for (const [key, label, min, max] of rows) panel.append(slider(`${label}:`, Number(k[key] ?? 0), min, max, key === 'hue' ? 1 : 0.01, (v) => void sc({ [key]: v } as Partial<ColorAdjust>), key === 'hue' ? (v) => `${v}°` : sgn, `color-${key}`));
      panel.append(h('h3', {}, 'LUT'));
      panel.append(h('div', { class: 'actions' },
        btn(k.lut ? `LUT: ${k.lut.split(/[\\/]/).pop()}` : 'Cargar LUT en formato .cube', async () => { const f = await api.invoke('dialog:file', { title: 'Cargar LUT', filters: [{ name: 'LUT', extensions: ['cube'] }] }); if (f) void sc({ lut: f }); }),
        k.lut ? btn('Quitar LUT', () => void sc({ lut: undefined })) : null,
        btn('Restablecer', () => void set({ color: null }))));
      break;
    }
    case 'crop': {
      if (!video) { panel.append(need('Seleccione un clip de vídeo o foto.')); break; }
      const cr = c.crop ?? { x: 0, y: 0, w: 1, h: 1 };
      const sc = (p: Partial<typeof cr>) => { const n = { ...cr, ...p }; n.w = Math.min(n.w, 1 - n.x); n.h = Math.min(n.h, 1 - n.y); return set({ crop: n.x === 0 && n.y === 0 && n.w === 1 && n.h === 1 ? null : n }); };
      panel.append(slider('Izquierda:', cr.x, 0, 0.9, 0.01, (v) => void sc({ x: v, w: Math.min(cr.w, 1 - v) }), pct));
      panel.append(slider('Arriba:', cr.y, 0, 0.9, 0.01, (v) => void sc({ y: v, h: Math.min(cr.h, 1 - v) }), pct));
      panel.append(slider('Ancho:', cr.w, 0.1, 1, 0.01, (v) => void sc({ w: v }), pct));
      panel.append(slider('Alto:', cr.h, 0.1, 1, 0.01, (v) => void sc({ h: v }), pct));
      panel.append(slider('Enderezar:', c.straighten, -45, 45, 0.5, (v) => void set({ straighten: v }), (v) => `${v}°`));
      panel.append(h('div', { class: 'actions' },
        btn('Rotar 90°', () => void set({ rotate: ((c.rotate + 90) % 360) as Clip['rotate'] })),
        btn('Voltear ↔', () => void set({ flipH: !c.flipH })), btn('Voltear ↕', () => void set({ flipV: !c.flipV })),
        btn('Restablecer', () => void set({ crop: null, straighten: 0, rotate: 0, flipH: false, flipV: false }))));
      break;
    }
    case 'stabilize': {
      if (c?.type !== 'video') { panel.append(need('Seleccione un clip de vídeo.')); break; }
      const s = { accuracy: c.stabilize?.accuracy ?? 9, shakiness: c.stabilize?.shakiness ?? 5, smoothing: c.stabilize?.smoothing ?? 15, crop: c.stabilize?.crop ?? 'keep', zoom: c.stabilize?.zoom ?? 0 };
      panel.append(slider('Precisión:', s.accuracy, 1, 15, 1, (v) => (s.accuracy = v), (v) => `${v}`));
      panel.append(slider('Sacudida:', s.shakiness, 1, 10, 1, (v) => (s.shakiness = v), (v) => `${v}`));
      panel.append(slider('Suave (radio):', s.smoothing, 1, 60, 1, (v) => (s.smoothing = v), (v) => `${v}`));
      panel.append(select('Recorte de bordes:', s.crop, [['keep', 'Adaptativo'], ['black', 'Fijo (bordes negros)']], (v) => (s.crop = v as 'keep')));
      panel.append(h('div', { class: 'actions' },
        btn(c.stabilize ? 'Estabilizar de nuevo' : 'Estabilizar', async () => { const r = await auto('stabilize', c.id, s); if (r) toast('La estabilización se ha completado correctamente.'); }, true, 'stabilize'),
        c.stabilize ? btn('Quitar', () => void set({ stabilize: null })) : null));
      break;
    }
    case 'speed': {
      if (!(c?.type === 'video' || c?.type === 'audio')) { panel.append(need('Seleccione un clip de vídeo o audio.')); break; }
      panel.append(chips([0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((v) => ({ id: String(v), name: `${v}×` })), String(c.speed), (v) => void set({ speed: +v })));
      panel.append(slider('Cámara lenta:', c.speed, 0.1, 10, 0.05, (v) => void set({ speed: v }), (v) => `${v.toFixed(2)}×`));
      panel.append(check('Tono original:', c.keepPitch, (v) => void set({ keepPitch: v })));
      break;
    }
    case 'chroma': {
      if (!video) { panel.append(need('Seleccione un clip de vídeo o foto en la pista superpuesta.')); break; }
      if (store.trackOf(c)?.kind === 'main') panel.append(h('div', { class: 'actions' }, btn('Mover a una pista de vídeo superpuesto', async () => { const t = store.project.tracks.find((x) => x.kind === 'overlay') ?? await op<{ id: string }>('addTrack', 'overlay'); if (t) void op('move', c.id, { trackId: t.id, start: c.start }); }, true)));
      const k = c.chroma ?? { color: '#00ff00', tolerance: 0.15, blend: 0.05, noise: 0, edges: 0, opacity: 1 };
      const sc = (p: Partial<typeof k>) => set({ chroma: { ...k, ...p } });
      const col = h('input', { type: 'color', value: k.color }) as HTMLInputElement;
      col.onchange = () => void sc({ color: col.value });
      panel.append(h('div', { class: 'row two' }, h('label', {}, 'Color:'), h('div', { style: { display: 'flex', gap: '8px' } }, col, btn('Cuentagotas', () => eyedropper((hex) => void sc({ color: hex }))))));
      panel.append(slider('Tolerancia:', k.tolerance, 0.01, 1, 0.01, (v) => void sc({ tolerance: v }), pct));
      panel.append(slider('Bordes (suavizado):', k.blend, 0, 1, 0.01, (v) => void sc({ blend: v }), pct));
      panel.append(slider('Ruido:', k.edges, 0, 1, 0.1, (v) => void sc({ edges: v }), pct));
      panel.append(h('div', { class: 'actions' }, btn('Aplicar', () => void sc({}), true), c.chroma ? btn('Quitar', () => void set({ chroma: null })) : null));
      break;
    }
    case 'pip': {
      if (!video) { panel.append(need('Seleccione un clip de la pista de vídeo superpuesto.')); break; }
      if (store.trackOf(c)?.kind === 'main') { panel.append(need('Arrastre el clip a la pista de vídeo adicional (encima de la principal) para colocarlo como imagen en imagen.')); break; }
      panel.append(h('h3', {}, 'Posición'));
      panel.append(chips(catalog.pip, c.pip, (v) => void set({ pip: v, transform: null })));
      panel.append(slider('Opacidad:', c.opacity, 0, 1, 0.01, (v) => void set({ opacity: v }), pct));
      panel.append(h('div', { class: 'hint' }, 'También puede mover y cambiar el tamaño del marco en el reproductor.'));
      break;
    }
    case 'logo': {
      const o = { corner: 'tr', scale: 0.14, opacity: 0.9 };
      panel.append(select('Esquina:', o.corner, [['tl', 'Arriba a la izquierda'], ['tr', 'Arriba a la derecha'], ['bl', 'Abajo a la izquierda'], ['br', 'Abajo a la derecha'], ['center', 'Centro']], (v) => (o.corner = v)));
      panel.append(slider('Tamaño:', o.scale, 0.04, 0.5, 0.01, (v) => (o.scale = v), pct));
      panel.append(slider('Opacidad:', o.opacity, 0.1, 1, 0.05, (v) => (o.opacity = v), pct));
      panel.append(h('div', { class: 'actions' }, btn('Añadir logotipo', async () => { const f = await api.invoke('dialog:file', { title: 'Elegir logotipo', filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] }); if (f) void op('addLogo', f, o); }, true)));
      break;
    }
    case 'panzoom': {
      if (!video || store.trackOf(c)?.kind !== 'main') { panel.append(need('Seleccione un clip de la pista principal.')); break; }
      panel.append(chips(catalog.panZoom, c.panZoom?.preset, (v) => { const pz = catalog.panZoom.find((x) => x.id === v)!; void set({ panZoom: { preset: v, from: { ...pz.from }, to: { ...pz.to } } }); }));
      if (c.panZoom) {
        const pz = c.panZoom;
        const up = (which: 'from' | 'to', k: 'x' | 'y' | 'zoom', v: number) => void set({ panZoom: { ...pz, preset: undefined, [which]: { ...pz[which], [k]: v } } });
        panel.append(h('h3', {}, 'Inicio'), slider('Zoom:', pz.from.zoom, 1, 3, 0.05, (v) => up('from', 'zoom', v), (v) => `${v.toFixed(2)}×`), slider('Centro X:', pz.from.x, 0, 1, 0.01, (v) => up('from', 'x', v), pct), slider('Centro Y:', pz.from.y, 0, 1, 0.01, (v) => up('from', 'y', v), pct));
        panel.append(h('h3', {}, 'Final'), slider('Zoom:', pz.to.zoom, 1, 3, 0.05, (v) => up('to', 'zoom', v), (v) => `${v.toFixed(2)}×`), slider('Centro X:', pz.to.x, 0, 1, 0.01, (v) => up('to', 'x', v), pct), slider('Centro Y:', pz.to.y, 0, 1, 0.01, (v) => up('to', 'y', v), pct));
        panel.append(h('div', { class: 'actions' }, btn('Quitar', () => void set({ panZoom: null }))));
      }
      break;
    }
    case 'mask': {
      if (!video || store.trackOf(c)?.kind !== 'main') { panel.append(need('Seleccione un clip de la pista principal.')); break; }
      panel.append(chips(catalog.masks, c.mask ? catalog.masks.find((m) => m.mode === c.mask!.mode && m.shape === c.mask!.shape)?.id : undefined, (v) => void op('setMask', c.id, v)));
      if (c.mask) {
        const m = c.mask;
        const sm = (p: Partial<typeof m>) => void op('setMask', c.id, catalog.masks.find((x) => x.mode === m.mode && x.shape === m.shape)!.id, { ...m, ...p });
        panel.append(slider('Centro X:', m.x, 0, 1, 0.01, (v) => sm({ x: v }), pct), slider('Centro Y:', m.y, 0, 1, 0.01, (v) => sm({ y: v }), pct), slider('Ancho:', m.w, 0.02, 1, 0.01, (v) => sm({ w: v }), pct), slider('Alto:', m.h, 0.02, 1, 0.01, (v) => sm({ h: v }), pct), slider('Difuminado:', m.feather, 0, 1, 0.05, (v) => sm({ feather: v }), pct), slider('Opacidad:', m.opacity, 0, 1, 0.05, (v) => sm({ opacity: v }), pct));
        panel.append(check('Invertir (fuera del área):', m.invert, (v) => sm({ invert: v })));
        panel.append(h('h3', {}, `Seguimiento (${m.track?.length ?? 0} puntos)`));
        panel.append(h('div', { class: 'hint' }, 'Mueva el cursor de reproducción, coloque la máscara sobre el objeto y añada un punto. La máscara seguirá los puntos.'));
        panel.append(h('div', { class: 'actions' },
          btn('Añadir punto aquí', () => sm({ track: [...(m.track ?? []).filter((k) => Math.abs(k.t - (store.time - c.start)) > 0.02), { t: +(store.time - c.start).toFixed(3), x: m.x, y: m.y }].sort((a, b) => a.t - b.t) })),
          btn('Restablecer', () => sm({ track: undefined })), btn('Quitar máscara', () => void op('setMask', c.id, null))));
      }
      break;
    }
    case 'animation': {
      if (!c || store.trackOf(c)?.kind === 'main' || c.type === 'audio' || c.type === 'title') { panel.append(need('Seleccione un adhesivo, una llamada o un clip superpuesto (los títulos se animan en su editor).')); break; }
      const opts: [string, string][] = [['', 'Sin animación'], ...catalog.animations.map((a): [string, string] => [a.id, a.name])];
      panel.append(select('Entrada:', c.animIn?.type ?? '', opts, (v) => void set({ animIn: v ? { type: v, duration: c.animIn?.duration ?? 0.6 } : null })));
      panel.append(select('Salida:', c.animOut?.type ?? '', opts, (v) => void set({ animOut: v ? { type: v, duration: c.animOut?.duration ?? 0.6 } : null })));
      panel.append(h('h3', {}, `Fotogramas clave (${c.keyframes?.length ?? 0})`));
      const tf = c.transform ?? { x: 0.5, y: 0.5, scale: c.type === 'sticker' || c.type === 'callout' ? 0.3 : 1, rotation: 0 };
      panel.append(h('div', { class: 'hint' }, 'Coloque el objeto en el reproductor (arrastrándolo) y pulse «Agregar cuadro clave» en cada momento. Entre fotogramas clave el objeto se mueve solo.'));
      panel.append(slider('Rotación:', tf.rotation, -180, 180, 1, (v) => void set({ transform: { ...tf, rotation: v } }), (v) => `${v}°`));
      panel.append(h('div', { class: 'actions' },
        btn('Agregar cuadro clave', () => { const t = +(store.time - c.start).toFixed(3); void set({ keyframes: [...(c.keyframes ?? []).filter((k) => Math.abs(k.t - t) > 0.02), { t, x: tf.x, y: tf.y, scale: tf.scale, rotation: tf.rotation, opacity: c.opacity }].sort((a, b) => a.t - b.t) }); }, true),
        btn('Eliminar todos', () => void set({ keyframes: null }))));
      break;
    }
    case 'scenes': {
      if (c?.type !== 'video') { panel.append(need('Seleccione un clip de vídeo.')); break; }
      const o = { minScene: 1, threshold: 0.3 };
      panel.append(slider('Duración mín. de escena:', o.minScene, 0.2, 10, 0.1, (v) => (o.minScene = v), (v) => `${v.toFixed(1)} s`));
      panel.append(slider('Sensibilidad:', 1 - o.threshold, 0.1, 0.95, 0.05, (v) => (o.threshold = 1 - v), pct));
      panel.append(h('div', { class: 'actions' }, btn('Detectar escenas', async () => { const r = await auto<{ scenes: number }>('detectScenes', c.id, o); if (r) toast(r.scenes > 1 ? `${r.scenes} escenas detectadas.` : 'Solo se detectó una escena en este clip. No se aplicó ninguna división.'); }, true)));
      break;
    }
    case 'freeze': {
      const o = { duration: 3 };
      panel.append(slider('Duración:', o.duration, 0.5, 15, 0.5, (v) => (o.duration = v), (v) => `${v} s`));
      panel.append(h('div', { class: 'actions' }, btn('Insertar fotograma fijo', () => void op('freezeFrame', store.time, o.duration), true)));
      break;
    }
    case 'eq': {
      if (!sound) { panel.append(need('Seleccione un clip con sonido.')); break; }
      const a = c.audio ?? {};
      const gains = a.eq ?? (a.eqPreset ? catalog.eqPresets.find((p) => p.id === a.eqPreset)!.gains : Array(10).fill(0));
      panel.append(chips(catalog.eqPresets, a.eqPreset, (v) => void set({ audio: { ...a, eqPreset: v, eq: undefined } })));
      ['31 Hz', '62 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz'].forEach((label, i) => {
        panel.append(slider(label, gains[i], -20, 20, 0.5, (v) => { const g = [...gains]; g[i] = v; void set({ audio: { ...a, eq: g, eqPreset: undefined } }); }, (v) => `${v > 0 ? '+' : ''}${v} dB`));
      });
      panel.append(h('div', { class: 'actions' }, btn('Uniforme', () => { const { eq: _e, eqPreset: _p, ...rest } = a; void _e; void _p; void set({ audio: Object.keys(rest).length ? rest : null }); })));
      break;
    }
    case 'compressor':
    case 'gate':
    case 'reverb':
    case 'denoise': {
      if (!sound) { panel.append(need('Seleccione un clip con sonido.')); break; }
      const a = c.audio ?? {};
      const put = (k: string, v: unknown) => { const n: Record<string, unknown> = { ...a, [k]: v }; if (v === undefined) delete n[k]; return set({ audio: Object.keys(n).length ? n : null }); };
      if (id === 'compressor') {
        const k = a.compressor ?? { threshold: -18, ratio: 3, attack: 20, release: 250, makeup: 2, mix: 1 };
        const s = { ...k };
        panel.append(slider('Umbral:', s.threshold, -60, 0, 1, (v) => (s.threshold = v), (v) => `${v} dB`), slider('Proporción:', s.ratio, 1, 20, 0.5, (v) => (s.ratio = v), (v) => `${v}:1`), slider('Ataque:', s.attack, 1, 500, 1, (v) => (s.attack = v), (v) => `${v} ms`), slider('Liberación:', s.release, 10, 3000, 10, (v) => (s.release = v), (v) => `${v} ms`), slider('Ganancia de salida:', s.makeup, 0, 24, 0.5, (v) => (s.makeup = v), (v) => `${v} dB`), slider('Mezcla:', s.mix, 0, 1, 0.05, (v) => (s.mix = v), pct));
        panel.append(h('div', { class: 'actions' }, btn('Aplicar', () => void put('compressor', s), true), a.compressor ? btn('Quitar', () => void put('compressor', undefined)) : null));
      } else if (id === 'gate') {
        const s = { ...(a.gate ?? { threshold: -40, range: 30, attack: 10, release: 200 }) };
        panel.append(slider('Umbral:', s.threshold, -80, 0, 1, (v) => (s.threshold = v), (v) => `${v} dB`), slider('Rango:', s.range, 0, 80, 1, (v) => (s.range = v), (v) => `${v} dB`), slider('Ataque:', s.attack, 1, 500, 1, (v) => (s.attack = v), (v) => `${v} ms`), slider('Liberación:', s.release, 10, 3000, 10, (v) => (s.release = v), (v) => `${v} ms`));
        panel.append(h('div', { class: 'actions' }, btn('Aplicar', () => void put('gate', s), true), a.gate ? btn('Quitar', () => void put('gate', undefined)) : null));
      } else if (id === 'reverb') {
        const s = { ...(a.reverb ?? { delay: 60, decay: 0.4, wet: 0.4 }) };
        panel.append(slider('Retraso:', s.delay, 5, 1000, 5, (v) => (s.delay = v), (v) => `${v} ms`), slider('Duración:', s.decay, 0.05, 0.95, 0.05, (v) => (s.decay = v), pct), slider('Equilibrio seco/húmedo:', s.wet, 0, 1, 0.05, (v) => (s.wet = v), pct));
        panel.append(h('div', { class: 'actions' }, btn('Aplicar', () => void put('reverb', s), true), a.reverb ? btn('Quitar', () => void put('reverb', undefined)) : null));
      } else {
        panel.append(slider('Supresión de ruido:', a.denoise ?? 0, 0, 1, 0.05, (v) => void put('denoise', v || undefined), pct));
      }
      break;
    }
    case 'enhance': {
      if (!sound) { panel.append(need('Seleccione un clip con sonido.')); break; }
      const a = c.audio ?? {};
      panel.append(chips(catalog.audioEnhance, a.enhance, (v) => void set({ audio: { ...a, enhance: a.enhance === v ? undefined : v } })));
      break;
    }
    case 'audiofx': {
      if (!sound) { panel.append(need('Seleccione un clip con sonido.')); break; }
      const a = c.audio ?? {};
      panel.append(chips(catalog.audioEffects, a.effect, (v) => void set({ audio: { ...a, effect: a.effect === v ? undefined : v } })));
      break;
    }
    case 'sync': {
      const sel = store.selected();
      panel.append(h('div', { class: 'hint' }, `Seleccionados: ${sel.length}.`));
      panel.append(h('div', { class: 'actions' }, btn('Sincronizar', async () => {
        if (sel.length !== 2) return toast('Seleccione dos clips con sonido.', true);
        const r = await auto<{ offset: number }>('syncAudio', sel[0].id, sel[1].id);
        if (r) toast(`Sincronizados (desfase ${r.offset.toFixed(2)} s).`);
      }, true)));
      break;
    }
    case 'beats': {
      if (!sound) { panel.append(need('Seleccione un clip de audio.')); break; }
      const o = { minInterval: 0.4 };
      panel.append(slider('Tiempo mín. entre marcadores:', o.minInterval, 0.1, 3, 0.05, (v) => (o.minInterval = v), (v) => `${v.toFixed(2)} s`));
      panel.append(h('div', { class: 'actions' }, btn('Detectar compases de audio', async () => { const r = await auto<{ beats: number }>('detectBeats', c.id, o); if (r) toast(r.beats ? `${r.beats} marcadores de ritmo.` : 'No se pudieron detectar compases.'); }, true)));
      break;
    }
    case 'voice': {
      panel.append(h('div', { class: 'actions' }, btn('Iniciar grabación', () => recordDialog('audio'), true)));
      break;
    }
    case 'silences': {
      const o = { threshold: -35, minSilence: 0.6, padding: 0.12 };
      panel.append(slider('Umbral de silencio:', o.threshold, -60, -15, 1, (v) => (o.threshold = v), (v) => `${v} dB`));
      panel.append(slider('Pausa mínima:', o.minSilence, 0.2, 3, 0.05, (v) => (o.minSilence = v), (v) => `${v.toFixed(2)} s`));
      panel.append(slider('Margen alrededor de la voz:', o.padding, 0, 0.5, 0.01, (v) => (o.padding = v), (v) => `${v.toFixed(2)} s`));
      panel.append(h('div', { class: 'actions' }, btn('Quitar silencios', async () => {
        const ids = store.selected().map((x) => x.id);
        const r = await auto<{ removedSeconds: number; pieces: number }>('removeSilences', { clipIds: ids.length ? ids : undefined, ...o });
        if (r) toast(r.removedSeconds > 0 ? `Se quitaron ${r.removedSeconds.toFixed(1)} s de silencio (${r.pieces} fragmentos).` : 'No se encontraron silencios.');
      }, true, 'remove-silences')));
      break;
    }
    case 'subs': {
      const o = { language: 'es', style: 'subtitle', words: 0 };
      panel.append(select('Idioma:', o.language, [['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'], ['it', 'Italiano'], ['de', 'Alemán'], ['', 'Detectar']], (v) => (o.language = v)));
      panel.append(select('Estilo:', o.style, [['subtitle', 'Clásico (con fondo)'], ['subtitle-shorts', 'Shorts (grande, pocas palabras)'], ['subtitle-karaoke', 'Palabra a palabra (resaltado dorado)']], (v) => (o.style = v)));
      panel.append(slider('Palabras por subtítulo:', 0, 0, 8, 1, (v) => (o.words = v), (v) => (v ? `${v}` : 'auto')));
      panel.append(h('div', { class: 'actions' },
        btn('Crear subtítulos', async () => {
          const ids = store.selected().filter((x) => x.type === 'video' || x.type === 'audio').map((x) => x.id);
          const r = await auto<{ captions: number }>('autoSubtitles', { language: o.language || undefined, style: o.style, words: o.words || undefined, clipIds: ids.length ? ids : undefined });
          if (r) toast(`${r.captions} subtítulos creados en la pista «Subtítulos».`);
        }, true),
        btn('Importar .srt', async () => { const f = await api.invoke('dialog:file', { title: 'Importar subtítulos', filters: [{ name: 'SubRip', extensions: ['srt'] }] }); if (f) void auto('importSubtitles', f, { style: o.style }); }),
        btn('Exportar .srt', async () => { const r = await api.invoke('export:srt'); if (r) toast(`${r.captions} subtítulos exportados.`); })));
      void api.invoke('prefs:get').then((p: { whisper: string | null }) => { if (!p.whisper) panel.append(h('div', { class: 'hint', style: { color: '#f8c91c' } }, 'No hay ningún modelo Whisper instalado. Copie un modelo sherpa-onnx-whisper y silero_vad.onnx en la carpeta «models» de Cinta (Preferencias muestra la ruta).')); });
      break;
    }
    case 'reframe': {
      const o = { aspect: '9:16', mode: 'face' as 'face' | 'blur' | 'crop' | 'fit' };
      panel.append(chips(catalog.aspects.map((a) => ({ id: a.id, name: `${a.id} · ${a.name}` })), o.aspect, (v) => { o.aspect = v; renderToolChipsActive(panel, v); }));
      panel.append(select('Modo:', o.mode, [['face', 'Seguir la cara (recorte inteligente)'], ['blur', 'Imagen completa sobre fondo desenfocado'], ['crop', 'Recortar al centro'], ['fit', 'Bandas negras']], (v) => (o.mode = v as 'face')));
      panel.append(h('div', { class: 'actions' }, btn('Reencuadrar', async () => { const r = await auto<{ width: number; height: number }>('reframe', o); if (r) toast(`Proyecto en ${r.width}×${r.height}.`); }, true)));
      break;
    }
    case 'transcript': {
      const box = h('div', { class: 'tx' });
      panel.append(box);
      void renderTranscript(box);
      break;
    }
    case 'translate': {
      const o = { lang: 'pt' };
      panel.append(select('Idioma:', o.lang, [['pt', 'Portugués'], ['en', 'Inglés'], ['es', 'Español'], ['fr', 'Francés'], ['it', 'Italiano'], ['de', 'Alemán']], (v) => (o.lang = v)));
      void localAi().then((ok) => {
        if (ok) panel.append(h('div', { class: 'actions' }, btn('Traducir con la IA local', async () => { const r = await auto<{ captions: number }>('llmTranslate', o.lang); if (r) toast(`${r.captions} subtítulos traducidos.`); }, true, 'llm-translate')));
        panel.append(claudeBox(() => `Traduce los subtítulos del proyecto abierto en Cinta al idioma «${o.lang}» (usa el prompt traducir-subtitulos o subtitles_get + subtitles_add_language).`));
      });
      break;
    }
    case 'chapters': {
      const list = h('div', { class: 'hint' });
      const refresh = async () => { const t: string = await api.invoke('chapters:text'); list.textContent = t || 'Todavía no hay capítulos.'; list.style.whiteSpace = 'pre-wrap'; };
      void refresh();
      const title = h('input', { placeholder: 'Título del capítulo', style: { width: '100%' } }) as HTMLInputElement;
      panel.append(list, h('div', { class: 'row two' }, h('label', {}, 'Nuevo en el cursor:'), title), h('div', { class: 'actions' },
        btn('Añadir capítulo aquí', async () => {
          if (!title.value.trim()) return toast('Escriba un título.', true);
          const cur = store.project.markers.filter((m) => m.name.startsWith('Capítulo: ')).map((m) => ({ time: m.time, title: m.name.slice(10) }));
          await auto('setChapters', [...cur, { time: store.time, title: title.value.trim() }]);
          title.value = '';
          void refresh();
        }),
        btn('Copiar para YouTube', async () => { const t: string = await api.invoke('chapters:text'); if (!t) return toast('No hay capítulos.', true); void api.invoke('clipboard:write', t); toast('Capítulos copiados.'); }, false, 'copy-chapters')));
      void localAi().then((ok) => {
        if (ok) panel.append(h('div', { class: 'actions' }, btn('Generar con la IA local', async () => { const r = await auto<{ chapters: number }>('llmChapters'); if (r) { toast(`${r.chapters} capítulos.`); void refresh(); } }, true, 'llm-chapters')));
        panel.append(claudeBox(() => 'Divide en capítulos para YouTube el vídeo abierto en Cinta (prompt capitulos-youtube).'));
      });
      break;
    }
    case 'tts': {
      const ta = h('textarea', { rows: '5', placeholder: 'Escriba lo que debe decir la voz…', style: { width: '100%' }, dataset: { test: 'tts-text' } }) as HTMLTextAreaElement;
      const voice = h('select', {}) as HTMLSelectElement;
      void api.invoke('tts:voices').then((vs: { name: string; culture: string }[]) => { for (const v of vs) voice.append(h('option', { value: v.name, selected: v.culture.startsWith('es') }, `${v.name} (${v.culture})`)); });
      const o = { rate: 0 };
      panel.append(ta, h('div', { class: 'row two' }, h('label', {}, 'Voz:'), voice), slider('Velocidad:', 0, -5, 5, 1, (v) => (o.rate = v), (v) => `${v > 0 ? '+' : ''}${v}`));
      panel.append(h('div', { class: 'actions' }, btn('Crear voz en off en el cursor', async () => {
        if (!ta.value.trim()) return toast('Escriba un texto.', true);
        const c = await auto<{ id: string }>('voiceover', ta.value.trim(), { voice: voice.value, rate: o.rate, at: store.time });
        if (c) toast('Voz en off añadida a la pista «Voz».');
      }, true, 'tts-create')));
      break;
    }
    case 'shortsai': {
      const o = { count: 5, from: 0, to: 30, title: '' };
      const dirOf = async () => { const d: string = await api.invoke('export:dir'); return `${d}\\Shorts`; };
      panel.append(h('h3', {}, 'A mano'));
      const from = h('input', { type: 'number', step: '0.1', min: '0', value: '0' }) as HTMLInputElement, to = h('input', { type: 'number', step: '0.1', min: '0', value: '30' }) as HTMLInputElement;
      const ttl = h('input', { placeholder: 'Título-gancho (opcional)' }) as HTMLInputElement;
      panel.append(h('div', { class: 'row two' }, h('label', {}, 'Desde (s):'), h('div', { style: { display: 'flex', gap: '6px' } }, from, h('button', { class: 'btn', onclick: () => (from.value = store.time.toFixed(1)) }, 'Cursor'))),
        h('div', { class: 'row two' }, h('label', {}, 'Hasta (s):'), h('div', { style: { display: 'flex', gap: '6px' } }, to, h('button', { class: 'btn', onclick: () => (to.value = store.time.toFixed(1)) }, 'Cursor'))),
        h('div', { class: 'row two' }, h('label', {}, 'Título:'), ttl),
        h('div', { class: 'actions' }, btn('Crear este short', async () => {
          const r = await auto<{ project: string }[]>('shortsManual', [{ start: +from.value, end: +to.value, title: ttl.value.trim() || undefined }], await dirOf());
          if (r) toast(`Short creado: ${r[0].project}`);
        }, true, 'short-manual')));
      panel.append(h('h3', {}, 'Los mejores momentos'));
      panel.append(slider('Cuántos:', o.count, 1, 15, 1, (v) => (o.count = v), (v) => String(v)));
      void localAi().then((ok) => {
        if (ok) panel.append(h('div', { class: 'actions' }, btn('Elegirlos con la IA local', async () => { const r = await auto<{ shorts: unknown[] }>('llmShorts', o.count, await dirOf()); if (r) toast(`${r.shorts.length} shorts creados.`); }, true, 'llm-shorts')));
        panel.append(claudeBox(() => `Saca los ${o.count} mejores momentos del vídeo abierto en Cinta como shorts verticales listos para publicar (prompt shorts-de-una-clase).`));
      });
      break;
    }
    case 'assistant': {
      void Promise.all([api.invoke('prefs:get'), localAi()]).then(([p, ok]: [{ mcp: { desktop: string; code: string } }, boolean]) => {
        const st = (s: string) => (s === 'connected' ? 'Conectado' : s === 'missing' ? 'No instalado' : 'No conectado');
        panel.append(
          h('h3', {}, 'Claude (por MCP)'),
          h('div', { class: 'hint' }, `Claude Desktop: ${st(p.mcp.desktop)} · Claude Code: ${st(p.mcp.code)}`),
          h('div', { class: 'hint' }, 'Claude hace la parte inteligente (decidir qué cortar, traducir, elegir momentos) y Cinta la edición. Pídale cosas como:'),
          ...[
            'Quita las muletillas y las frases repetidas del vídeo abierto en Cinta.',
            'Traduce los subtítulos al portugués y al inglés.',
            'Haz los capítulos para YouTube.',
            'Saca 5 shorts de esta clase y expórtalos.',
            'Quita la parte donde hablo de los anuncios (edita por el texto).',
          ].map((t) => claudeBox(() => t, false)),
          h('div', { class: 'hint' }, 'En Claude también aparecen como comandos: quitar-muletillas, editar-por-texto, traducir-subtitulos, capitulos-youtube y shorts-de-una-clase.'),
          h('h3', {}, 'IA local (opcional)'),
          h('div', { class: 'hint' }, ok ? 'Configurada: los botones «con la IA local» de estos paneles funcionan sin Claude.' : 'No configurada. No es necesaria; si quiere usar estas funciones sin Claude, instale Ollama o LM Studio (gratis) y configúrela en Preferencias.'),
          h('div', { class: 'actions' }, btn('Abrir Preferencias', () => document.dispatchEvent(new CustomEvent('cinta:command', { detail: 'preferences' })))));
      });
      break;
    }
    case 'music': {
      const o = { volume: 0.45, duck: true, name: 'calm' };
      panel.append(select('Música:', o.name, [...catalog.generated.music.map((m): [string, string] => [m, `Generada: ${m}`]), ['file', 'Elegir un archivo…']], (v) => (o.name = v)));
      panel.append(slider('Volumen:', o.volume, 0, 1.5, 0.05, (v) => (o.volume = v), pct));
      panel.append(check('Bajar bajo la voz:', o.duck, (v) => (o.duck = v)));
      panel.append(h('div', { class: 'actions' }, btn('Añadir música', async () => {
        let path: string | null = null;
        if (o.name === 'file') path = await api.invoke('dialog:file', { title: 'Elegir música', filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'] }] });
        else path = await api.invoke('generate', 'music', o.name, Math.max(30, store.duration() + 2));
        if (path) { const r = await auto('addMusic', path, { volume: o.volume, duck: o.duck }); if (r) toast('Música añadida.'); }
      }, true)));
      break;
    }
  }
  if (c && !o.compact && ['color', 'crop', 'stabilize', 'speed', 'chroma', 'pip', 'panzoom', 'mask', 'animation', 'eq', 'compressor', 'gate', 'reverb', 'denoise', 'enhance', 'audiofx', 'props', 'title'].includes(id)) {
    panel.prepend(h('div', { class: 'hint' }, `Clip: ${c.name ?? c.type} · ${fmtShort(c.start)}–${fmtShort(clipEnd(c))}`));
  }
  return panel;
}

/** Tools that make sense for a clip, for the inspector's quick buttons. */
export function toolsFor(c: Clip): { id: string; name: string; icon: IconName }[] {
  const t = store.trackOf(c)?.kind;
  const m = store.media(c);
  const visual = c.type !== 'audio' && c.type !== 'title';
  const sound = c.type === 'audio' || (c.type === 'video' && !!m?.hasAudio && !c.audioDetached);
  const ids = [
    ...(visual ? ['color', 'crop'] : []),
    ...(c.type === 'video' ? ['speed', 'stabilize'] : c.type === 'audio' ? ['speed'] : []),
    ...(t === 'main' && visual ? ['panzoom', 'mask'] : []),
    ...(t !== 'main' && visual ? ['chroma', 'pip', 'animation'] : []),
    ...(sound ? ['transcript', 'eq', 'denoise', 'enhance', 'audiofx', 'silences'] : []),
    ...(c.type === 'video' ? ['scenes'] : []),
  ];
  return ids.map((id) => TOOLS.find((x) => x.id === id)!).filter(Boolean).map((x) => ({ id: x.id, name: x.name, icon: x.icon }));
}
/** "Ask Claude" box: the request to copy into Claude (Cinta connected by MCP). */
function claudeBox(text: () => string, withTitle = true): HTMLElement {
  const pre = h('div', { class: 'claude-text' }, text());
  return h('div', { class: 'claude-box' }, withTitle ? h('div', { class: 'cb-title', html: `${ICONS.sparkle}<span>Pídaselo a Claude (Cinta conectada por MCP)</span>` }) : null, pre,
    h('button', { class: 'btn', onclick: () => { void api.invoke('clipboard:write', text()); toast('Copiado: péguelo en Claude.'); } }, 'Copiar'));
}
let llmCache: boolean | null = null;
/** Is a local AI configured? (asked again when Preferences change) */
async function localAi(): Promise<boolean> {
  if (llmCache === null) { const p = await api.invoke('prefs:get'); llmCache = !!p.settings.llm?.enabled; setTimeout(() => (llmCache = null), 3000); }
  return llmCache;
}

/** Text-based editing: the transcript as clickable words; select (click, Shift+click) and cut. */
async function renderTranscript(box: HTMLElement) {
  box.innerHTML = '';
  const v: { words: { id: string; w: string; start: number; end: number; seg: number; clipId: string }[]; fillers: string[][] } = await api.invoke('transcript:view');
  if (!v.words.length) {
    const o = { lang: 'es' };
    box.append(h('div', { class: 'hint' }, 'El vídeo todavía no está transcrito.'),
      select('Idioma:', o.lang, [['es', 'Español'], ['pt', 'Portugués'], ['en', 'Inglés'], ['', 'Detectar']], (x) => (o.lang = x)),
      h('div', { class: 'actions' }, btn('Transcribir', async () => { const r = await auto('buildTranscript', { language: o.lang || undefined }); if (r) void renderTranscript(box); }, true, 'transcribe')));
    return;
  }
  const fill = new Set(v.fillers.flat());
  let a = -1, b = -1;
  const words = v.words;
  const text = h('div', { class: 'tx-text', dataset: { test: 'tx-text' } });
  const paint = () => text.querySelectorAll('span[data-i]').forEach((el) => { const i = +(el as HTMLElement).dataset.i!; el.classList.toggle('sel', a >= 0 && i >= Math.min(a, b) && i <= Math.max(a, b)); });
  let seg = -1, clip = '';
  words.forEach((w, i) => {
    if (w.seg !== seg || w.clipId !== clip) { if (i) text.append(h('br')); text.append(h('span', { class: 'tx-time' }, fmtShort(w.start))); seg = w.seg; clip = w.clipId; }
    const el = h('span', { class: `tx-w${fill.has(w.id) ? ' filler' : ''}`, dataset: { i: String(i) }, title: `${w.start.toFixed(2)} s` }, w.w);
    el.onclick = (e) => { if (e.shiftKey && a >= 0) b = i; else { a = b = i; } paint(); stop(); store.seek(w.start); };
    text.append(el, ' ');
  });
  const phrase = h('input', { placeholder: 'Frase exacta a quitar (todas las veces)', style: { width: '100%' } }) as HTMLInputElement;
  box.append(
    h('div', { class: 'hint' }, 'Clic en una palabra para ir a ella; Mayús+clic para seleccionar hasta ella. En amarillo, las muletillas.'),
    h('div', { class: 'actions' },
      btn('Quitar selección', async () => { if (a < 0) return toast('Seleccione palabras.', true); const r = await auto('cutRanges', [{ start: words[Math.min(a, b)].start, end: words[Math.max(a, b)].end }]); if (r) void renderTranscript(box); }, true, 'tx-cut'),
      btn(`Quitar muletillas (${v.fillers.length})`, async () => { if (!v.fillers.length) return toast('No hay muletillas.'); const r = await auto('removeFillers'); if (r) void renderTranscript(box); }, false, 'tx-fillers'),
      btn('Crear subtítulos', async () => { const r = await auto<number>('subtitlesFromTranscript', 'subtitle'); if (r) toast(`${r} subtítulos.`); }, false, 'tx-subs')),
    h('div', { style: { display: 'flex', gap: '6px' } }, phrase, btn('Quitar', async () => { if (!phrase.value.trim()) return; const r = await auto('cutPhrase', phrase.value.trim()); if (r) void renderTranscript(box); })),
    text);
}

function renderToolChipsActive(panel: HTMLElement, id: string) {
  panel.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.test === `chip-${id}`));
}

/** Pick a colour from the current preview frame. */
function eyedropper(done: (hex: string) => void) {
  stop();
  const img = document.getElementById('frame') as HTMLImageElement;
  toast('Haga clic en el reproductor para elegir el color.');
  const stage = document.getElementById('stage')!;
  stage.style.cursor = 'crosshair';
  const pick = (e: MouseEvent) => {
    stage.style.cursor = '';
    stage.removeEventListener('click', pick, true);
    e.stopPropagation();
    const r = img.getBoundingClientRect();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const x = Math.floor(((e.clientX - r.left) / r.width) * cv.width), y = Math.floor(((e.clientY - r.top) / r.height) * cv.height);
    const [R, G, B] = ctx.getImageData(x, y, 1, 1).data;
    done(`#${[R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  };
  stage.addEventListener('click', pick, true);
}

// ───────────────────────── recording and slideshow ─────────────────────────
import { modal } from './dialogs';
async function recordDialog(kind: 'audio' | 'video') {
  stop();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true, audio: true } : { audio: true });
  } catch {
    return toast(kind === 'video' ? 'No se encontró ninguna cámara.' : 'No se encontró ningún micrófono.', true);
  }
  const startAt = store.time;
  let rec: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  const prev = kind === 'video' ? h('video', { autoplay: true, muted: true, style: { width: '100%', borderRadius: '6px', background: '#000' } }) as HTMLVideoElement : null;
  if (prev) prev.srcObject = stream;
  const timer = h('div', { style: { fontSize: '22px', color: '#fff', textAlign: 'center' } }, '00:00');
  const status = h('div', { class: 'hint' }, `Se insertará en ${fmtShort(startAt)}.`);
  let t0 = 0, iv = 0;
  const startBtn = h('button', { class: 'btn primary' }, 'Iniciar grabación');
  const m = modal(kind === 'video' ? 'Grabar vídeo' : 'Grabar audio', [prev, timer, status], [h('button', { class: 'btn', onclick: () => close(false) }, 'Cancelar'), startBtn]);
  const close = async (keep: boolean) => {
    clearInterval(iv);
    if (rec && rec.state !== 'inactive') { await new Promise<void>((r) => { rec!.onstop = () => r(); rec!.stop(); }); }
    stream.getTracks().forEach((t) => t.stop());
    m.close();
    if (!keep || !chunks.length) return;
    const blob = new Blob(chunks, { type: rec!.mimeType });
    const path = await api.invoke('record:save', await blob.arrayBuffer(), 'webm');
    const [item] = (await op<{ id: string }[]>('importMedia', [path])) ?? [];
    if (!item) return;
    if (kind === 'audio') {
      const t = store.project.tracks.find((x) => x.kind === 'audio' && x.name === 'Voz') ?? await op<{ id: string }>('addTrack', 'audio', 'Voz');
      if (t) await op('addClip', item.id, { trackId: t.id, at: startAt });
    } else await op('addClip', item.id, { at: startAt });
    toast('Grabación añadida.');
  };
  startBtn.onclick = () => {
    if (rec) { void close(true); return; }
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(250);
    t0 = Date.now();
    iv = window.setInterval(() => (timer.textContent = fmtShort((Date.now() - t0) / 1000)), 250);
    startBtn.textContent = 'Detener grabación';
  };
}

export async function slideshowDialog() {
  const files: string[] = await api.invoke('dialog:media', false);
  if (!files.length) return;
  const o = { photoDuration: 4, transition: 'random', transitionDuration: 1, panZoom: true };
  const dur = h('input', { type: 'number', min: '0.5', step: '0.5', value: '4' }) as HTMLInputElement;
  const tr = h('select', {}, h('option', { value: 'random' }, 'Transiciones aleatorias'), h('option', { value: '' }, 'Sin transiciones'), ...catalog.transitions.map((t) => h('option', { value: t.id }, t.name))) as HTMLSelectElement;
  const pz = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const m = modal('Asistente de presentación', [
    h('div', { class: 'hint' }, `${files.length} archivos.`),
    h('div', { class: 'row' }, h('label', {}, 'Duración de las fotos (s):'), dur),
    h('div', { class: 'row' }, h('label', {}, 'Estilo de transición:'), tr),
    h('div', { class: 'row' }, h('label', {}, 'Panorámica y zoom:'), pz),
  ], [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: async () => {
    m.close();
    o.photoDuration = +dur.value || 4;
    const r = await auto<{ clips: number }>('slideshow', files, { ...o, transition: tr.value || undefined, panZoom: pz.checked });
    if (r && !tr.value) await op('transitionWizard', { type: null });
    if (r) toast(`Presentación creada con ${r.clips} clips.`);
  } }, 'Crear')]);
}

export { refreshFrame };
