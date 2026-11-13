// Cinta UI entry: wires the store, player, timeline, workspace, toolbar, menus and keyboard.
import type { Clip } from '../core/model';
import { advKey, command as advCommand, isAdvanced, modeSwitch, setMode } from './advanced/layout';
import { aboutDialog, exportDialog, missingDialog, modal, preferencesDialog, projectSettingsDialog, shortcutsDialog } from './dialogs';
import { ICONS, type IconName } from './icons';
import { contextMenu, fullscreen, initPlayer, isPlaying, jumpClip, play, stepFrame, stop, type MenuItem } from './player';
import { api, clipEnd, fmtShort, h, op, store, toast, type AppState } from './store';
import { initTimeline, render as renderTimeline, zoomFit, zoomTo } from './timeline';
import { applyDrop, applyItem, catalog, closeTool, currentTool, importAndAdd, initWorkspace, openToolFor, showTab, slideshowDialog, toolTitle } from './workspace';
import { initInspector, toggleInspector } from './inspector';
import { autoShort, initTasks, openPalette, startTour, type Cmd } from './ux';
import { auto } from './store';
import { setGuides } from './player';

const $ = (id: string) => document.getElementById(id)!;

// errors of the window go to logs/errores.log (Ayuda → Abrir carpeta de registros de errores); a few per session
{
  let n = 0;
  const log = (msg: unknown, stack?: unknown) => { if (n++ < 50) void api.invoke('app:logError', String(msg), stack ? String(stack) : '').catch(() => {}); };
  window.addEventListener('error', (e) => log(e.message, (e.error as Error | undefined)?.stack ?? `${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason as Error | undefined; log(r?.message ?? r, r?.stack); });
}

// ───────────────────────── toolbar ─────────────────────────
const tb: Record<string, HTMLButtonElement> = {};
function toolbar() {
  const bar = $('toolbar');
  const b = (id: string, icon: IconName, tip: string, fn: () => void) => {
    const el = h('button', { class: 'ib', title: tip, html: ICONS[icon], onclick: fn, dataset: { test: `tb-${id}` } }) as HTMLButtonElement;
    tb[id] = el;
    return el;
  };
  const zoom = h('input', { type: 'range', min: '0', max: '100', value: '50', title: 'Escala de la línea de tiempo' }) as HTMLInputElement;
  const z2v = (z: number) => Math.round((Math.log(z / 4) / Math.log(600 / 4)) * 100);
  const v2z = (v: number) => 4 * Math.pow(600 / 4, v / 100);
  zoom.oninput = () => zoomTo(v2z(+zoom.value));
  store.on((why) => { if (why === 'zoom') { zoom.value = String(z2v(store.zoom)); zoom.style.setProperty('--p', `${zoom.value}%`); } });
  const exportBtn = h('div', { id: 'export-btn', class: 'split-btn' },
    h('button', { class: 'btn primary', dataset: { test: 'export' }, onclick: () => void exportDialog(catalog.exportPresets as never) }, 'Exportar'),
    h('button', { class: 'btn primary', html: ICONS.chevron, title: 'Más opciones de exportación', onclick: (e: MouseEvent) => contextMenu(e, [
      { label: 'Exportar vídeo…', fn: () => void exportDialog(catalog.exportPresets as never) },
      { label: 'Exportar audio…', fn: () => void exportDialog(catalog.exportPresets as never, 'audio') },
      { label: 'Exportar selección…', fn: () => void exportDialog(catalog.exportPresets as never, 'selection') },
      { label: 'Exportar subtítulos (.srt)…', fn: async () => { const r = await api.invoke('export:srt'); if (r) toast(`${r.captions} subtítulos exportados.`); } },
      { label: 'Exportar a Shotcut / Kdenlive (MLT)…', fn: () => void exportMlt() },
    ]) }));
  bar.append(
    h('div', { class: 'grp' }, b('undo', 'undo', 'Deshacer (Ctrl+Z)', () => void op('undo')), b('redo', 'redo', 'Rehacer (Ctrl+Y)', () => void op('redo')), b('delete', 'trash', 'Eliminar — quite el clip seleccionado del proyecto (Supr)', () => void del())),
    h('div', { class: 'sep' }),
    h('div', { class: 'grp' },
      b('split', 'split', 'Dividir — corte el clip seleccionado en la posición actual (Ctrl+B)', () => void split()),
      b('rotate', 'rotate', 'Rotar — rote 90° el clip seleccionado', () => void rotate()),
      b('crop', 'crop', 'Recortar — corte los bordes del clip seleccionado', () => openToolFor('crop')),
      b('color', 'color', 'Ajustes de color — mejore y ajuste los colores del clip', () => openToolFor('color')),
      b('props', 'props', 'Propiedades del clip — edite el clip seleccionado', () => openToolFor('props'))),
    h('div', { class: 'sep' }),
    h('div', { class: 'grp' }, b('wizard', 'wizard', 'Asistente para transiciones — agregue transiciones a todos los clips', () => wizard()), b('marker', 'flag', 'Agregar marcador (Ctrl+M)', () => void op('addMarker', store.time))),
    h('div', { class: 'sep' }),
    h('div', { class: 'grp' }, b('rec-video', 'webcam', 'Grabar vídeo con una cámara', () => openRecord('video')), b('rec-voice', 'mic', 'Grabar audio con el micrófono', () => openToolFor('voice'))),
    h('div', { class: 'zoom' }, h('button', { class: 'ib', html: ICONS.zoomOut, title: 'Alejar', onclick: () => zoomTo(store.zoom / 1.4) }), zoom, h('button', { class: 'ib', html: ICONS.zoomIn, title: 'Acercar', onclick: () => zoomTo(store.zoom * 1.4) })),
    h('div', { class: 'spacer' }),
    exportBtn,
  );
}
function openRecord(kind: 'video' | 'audio') {
  if (kind === 'audio') return openToolFor('voice');
  showTab('import');
  (document.querySelector('.quick button') as HTMLButtonElement | null)?.click();
}
function updateToolbar() {
  const sel = store.selected();
  tb.undo.disabled = !store.s.canUndo;
  tb.redo.disabled = !store.s.canRedo;
  tb.delete.disabled = !sel.length && !store.selectedTransition;
  const one = sel[0];
  const visual = one && one.type !== 'audio' && one.type !== 'title';
  tb.split.disabled = !store.project.clips.some((c) => store.time > c.start + 0.02 && store.time < clipEnd(c) - 0.02);
  tb.rotate.disabled = !visual;
  tb.crop.disabled = !visual;
  tb.color.disabled = !visual;
  tb.props.disabled = !one;
  tb.wizard.disabled = store.project.clips.filter((c) => store.trackOf(c)?.kind === 'main').length < 2;
  $('status-text').textContent = `Duración del proyecto: ${fmtShort(store.duration())}`;
}

// ───────────────────────── commands ─────────────────────────
async function del() {
  if (store.selectedTransition) { await op('setTransition', store.selectedTransition, null); return; }
  const ids = [...store.selection];
  if (ids.length) await op('remove', ids);
}
async function split() {
  stop();
  const sel = store.selected().filter((c) => store.time > c.start && store.time < clipEnd(c));
  await op('split', store.time, sel.length ? sel.map((c) => c.id) : undefined);
}
async function rotate() {
  for (const c of store.selected()) if (c.type !== 'audio' && c.type !== 'title') await op('set', c.id, { rotate: ((c.rotate + 90) % 360) as Clip['rotate'] });
}
function wizard() {
  const o = { type: 'random' as string | null, duration: 1, photo: 4 };
  const sel = h('select', {}, h('option', { value: 'random' }, 'Transiciones aleatorias'), h('option', { value: '' }, 'Sin transiciones'), ...catalog.transitions.map((t) => h('option', { value: t.id }, `${t.category} · ${t.name}`))) as HTMLSelectElement;
  const dur = h('input', { type: 'number', min: '0.1', max: '5', step: '0.1', value: '1' }) as HTMLInputElement;
  const photo = h('input', { type: 'number', min: '0.5', step: '0.5', value: '4' }) as HTMLInputElement;
  const onlySel = h('input', { type: 'checkbox', disabled: store.selection.size < 2 }) as HTMLInputElement;
  {
    const m = modal('Asistente para transiciones', [
      h('div', { class: 'row' }, h('label', {}, 'Estilo de transición:'), sel),
      h('div', { class: 'row' }, h('label', {}, 'Duración de la transición (s):'), dur),
      h('div', { class: 'row' }, h('label', {}, 'Duración de los clips de fotos (s):'), photo),
      h('div', { class: 'row' }, h('label', {}, 'Aplicar a la selección:'), onlySel),
    ], [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: async () => {
      m.close();
      o.type = sel.value || null;
      const n = await op<number>('transitionWizard', { type: o.type, duration: +dur.value, photoDuration: +photo.value, clipIds: onlySel.checked ? [...store.selection] : undefined });
      if (n !== undefined) toast(o.type ? `Transiciones: ${n}` : 'Transiciones quitadas.');
    } }, 'Aplicar a todos los clips')]);
  }
}
function copy(cut = false) {
  store.clipboard = store.selected().map((c) => structuredClone(c));
  if (cut && store.clipboard.length) void op('remove', store.clipboard.map((c) => c.id));
}
async function paste() {
  if (!store.clipboard.length) return;
  const base = Math.min(...store.clipboard.map((c) => c.start));
  for (const c of store.clipboard) {
    const t = store.track(c.trackId) ?? store.project.tracks.find((x) => x.kind === (c.type === 'audio' ? 'audio' : c.type === 'title' ? 'title' : 'main'));
    if (!t) continue;
    let made: Clip | undefined;
    if (c.mediaId) made = await op<Clip>('addClip', c.mediaId, { trackId: t.id, at: store.time + (c.start - base), in: c.in, out: c.out, duration: c.type === 'image' ? c.out - c.in : undefined });
    else if (c.type === 'title' && c.title) made = await op<Clip>('addTitle', c.title.text, { ...c.title, start: store.time + (c.start - base), duration: c.out - c.in, trackId: t.id });
    else if (c.type === 'color') made = await op<Clip>('addColorClip', c.fill ?? '#000000', c.out - c.in, { trackId: t.id, at: store.time + (c.start - base) });
    else if (c.type === 'sticker' || c.type === 'callout') made = await op<Clip>('addGraphic', c.type, c.type === 'sticker' ? c.sticker!.name : c.callout!.shape, { start: store.time + (c.start - base), duration: c.out - c.in, trackId: t.id, color: c.sticker?.color ?? c.callout?.color });
    if (made) {
      const { id: _i, trackId: _t, start: _s, in: _in, out: _o, type: _ty, mediaId: _m, ...props } = c;
      void _i; void _t; void _s; void _in; void _o; void _ty; void _m;
      await op('set', made.id, props);
    }
  }
}
async function exportMlt() {
  const r = await api.invoke('export:mlt');
  if (r) toast(r.skipped.length ? `MLT guardado. No se incluyó: ${r.skipped.join(', ')}` : 'MLT guardado.');
}

function clipMenu(c: Clip): MenuItem[] {
  const m = store.media(c);
  const main = store.trackOf(c)?.kind === 'main';
  return [
    { label: 'Cortar', kbd: 'Ctrl+X', fn: () => copy(true) },
    { label: 'Copiar', kbd: 'Ctrl+C', fn: () => copy() },
    { label: 'Pegar', kbd: 'Ctrl+V', fn: () => void paste(), disabled: !store.clipboard.length },
    { label: 'Eliminar', kbd: 'Supr', fn: () => void del() },
    { sep: true },
    { label: 'Dividir', kbd: 'Ctrl+B', fn: () => void split(), disabled: !(store.time > c.start && store.time < clipEnd(c)) },
    { label: 'Clonar', kbd: 'Ctrl+D', fn: () => void op('duplicate', c.id) },
    { label: 'Separar audio', fn: () => void op('detachAudio', c.id), disabled: !(c.type === 'video' && m?.hasAudio && !c.audioDetached) },
    { label: c.muted ? 'Reactivar audio de clip' : 'Silenciar clip', fn: () => void op('set', c.id, { muted: !c.muted }), disabled: !(c.type === 'video' || c.type === 'audio') },
    { label: c.hidden ? 'Mostrar clip' : 'Ocultar clip', fn: () => void op('set', c.id, { hidden: !c.hidden }), disabled: c.type === 'audio' },
    { label: 'Insertar fotograma fijo', fn: () => void op('freezeFrame', store.time, 3), disabled: !(main && c.type === 'video') },
    { label: 'Panorámica y zoom', fn: () => openToolFor('panzoom', c), disabled: !main || c.type === 'audio' },
    { label: 'Animación', fn: () => openToolFor('animation', c), disabled: main || c.type === 'audio' || c.type === 'title' },
    { sep: true },
    { label: 'Detectar escenas', fn: () => openToolFor('scenes', c), disabled: c.type !== 'video' },
    { label: 'Detectar compases de audio', fn: () => openToolFor('beats', c), disabled: !m?.hasAudio },
    { label: 'Quitar silencios', fn: () => openToolFor('silences', c), disabled: !m?.hasAudio },
    { sep: true },
    { label: c.type === 'title' ? 'Editar título…' : 'Propiedades del clip', fn: () => openToolFor(c.type === 'title' ? 'title' : 'props', c) },
    { label: 'Información del archivo', fn: () => m && toast(`${m.path} · ${m.width ? `${m.width}×${m.height} · ` : ''}${m.duration ? `${m.duration.toFixed(2)} s` : 'foto'}${m.fps ? ` · ${m.fps} fps` : ''}${m.hasAudio ? ' · con sonido' : ''}`), disabled: !m },
    { label: 'Mostrar en carpeta', fn: () => m && void api.invoke('shell:show', m.path), disabled: !m },
  ];
}

// ───────────────────────── menus and keyboard ─────────────────────────
/** Everything the command palette can do: menus, tools, catalogue items, aspects, AI helpers, exports. */
function paletteCommands(): Cmd[] {
  const c = (group: string, label: string, run: () => void, keys?: string): Cmd => ({ group, label, run, keys });
  const exp = catalog.exportPresets as unknown as { id: string; name: string; category: string }[];
  return [
    c('Edición', 'Dividir clip', () => commands.split(), 'Ctrl+B'),
    c('Edición', 'Eliminar', () => commands.delete(), 'Supr'),
    c('Edición', 'Clonar clip', () => commands.duplicate(), 'Ctrl+D'),
    c('Edición', 'Separar audio', () => commands['detach-audio']()),
    c('Edición', 'Insertar fotograma fijo', () => commands.freeze()),
    c('Edición', 'Agregar marcador', () => commands.marker(), 'Ctrl+M'),
    c('Edición', 'Deshacer', () => commands.undo(), 'Ctrl+Z'),
    c('Edición', 'Rehacer', () => commands.redo(), 'Ctrl+Y'),
    c('Edición', 'Seleccionar todo', () => commands['select-all'](), 'Ctrl+A'),
    c('Edición', 'Asistente para transiciones', () => wizard()),
    c('Archivo', 'Agregar archivos multimedia', () => commands.import(), 'Ctrl+I'),
    c('Archivo', 'Guardar proyecto portátil', () => commands['save-portable']()),
    c('Archivo', 'Exportar vídeo', () => commands.export(), 'Ctrl+E'),
    c('Archivo', 'Exportar audio', () => commands.export('audio')),
    c('Archivo', 'Exportar selección', () => commands.export('selection')),
    c('Archivo', 'Exportar subtítulos (.srt)', () => commands['export-srt']()),
    c('Archivo', 'Exportar a Shotcut / Kdenlive', () => commands['export-mlt']()),
    c('Ver', 'Mostrar u ocultar el inspector', () => commands['toggle-inspector'](), 'F4'),
    c('Ver', 'Guías: regla de los tercios', () => setGuides('thirds')),
    c('Ver', 'Guías: zona segura', () => setGuides('safe')),
    c('Ver', 'Guías: ninguna', () => setGuides('none')),
    c('Ver', 'Pantalla completa', () => commands.fullscreen(), 'Alt+Intro'),
    c('Ayuda', 'Guía de primer uso', () => startTour(true)),
    c('Ayuda', 'Métodos abreviados de teclado', () => commands.shortcuts()),
    c('Configuración', 'Configuración del proyecto', () => commands['project-settings']()),
    c('Configuración', 'Preferencias y asistentes de IA', () => commands.preferences()),
    ...(catalog.aspects as unknown as { id: string; name: string }[]).map((a) => c('Proyecto', `Proyecto en ${a.id} (${a.name})`, () => void op('setSettings', { aspect: a.id }))),
    c('IA', 'Short automático desde un vídeo', () => void autoShort({ importAndAdd: (p) => importAndAdd(p), slideshow: () => void slideshowDialog() })),
    c('IA', 'Quitar silencios', () => openToolFor('silences')),
    c('IA', 'Subtítulos automáticos', () => openToolFor('subs')),
    c('IA', 'Reencuadrar a 9:16 siguiendo la cara', () => void auto('reframe', { aspect: '9:16', mode: 'face' })),
    c('IA', 'Música de fondo con atenuación', () => openToolFor('music')),
    ...['color', 'crop', 'stabilize', 'speed', 'chroma', 'pip', 'logo', 'panzoom', 'mask', 'animation', 'scenes', 'freeze', 'eq', 'compressor', 'gate', 'reverb', 'denoise', 'enhance', 'audiofx', 'sync', 'beats', 'voice', 'props', 'transcript', 'translate', 'chapters', 'tts', 'shortsai', 'assistant']
      .map((id) => c('Herramienta', toolTitle(id), () => openToolFor(id))),
    ...catalog.filters.map((f) => c('Filtro', f.name, () => void applyItem('filter', f))),
    ...catalog.transitions.map((t) => c('Transición', `${t.category} · ${t.name}`, () => void applyItem('transition', t))),
    ...catalog.titles.map((t) => c('Título', t.name, () => void applyItem('title', t))),
    ...catalog.stickers.map((t) => c('Adhesivo', t.name, () => void applyItem('sticker', t))),
    ...catalog.callouts.map((t) => c('Llamada', t.name, () => void applyItem('callout', t))),
    ...exp.map((p) => c('Exportar como', `${p.name} (${p.category})`, () => void exportDialog(catalog.exportPresets as never, undefined, p.id))),
  ];
}

const commands: Record<string, (...a: unknown[]) => void> = {
  palette: () => openPalette(paletteCommands()),
  tour: () => startTour(true),
  'toggle-inspector': () => toggleInspector(),
  'export-selection': () => void exportDialog(catalog.exportPresets as never, 'selection'),
  import: async () => importAndAdd(await api.invoke('dialog:media', false)),
  'import-folder': async () => importAndAdd(await api.invoke('dialog:media', true)),
  'import-file': () => void import('./advanced/importacion-ui').then((x) => x.importFileCommand(async (r) => { if (isAdvanced()) { if (r.rest.length) await import('./advanced/panels').then((pn) => pn.importFiles(r.rest)); } else { await importAndAdd(r.rest); for (const m of r.media) await op('addClip', m.id); } })),
  'import-premiere': () => void import('./advanced/importacion-ui').then((x) => x.premiereDialog()),
  'import-maya': () => void import('./advanced/importacion-ui').then((x) => x.mayaImportUI()),
  'interpret-footage': () => void import('./advanced/importacion-ui').then((x) => x.interpretSelected()),
  export: (mode) => void exportDialog(catalog.exportPresets as never, mode as 'audio'),
  'export-mlt': () => void exportMlt(),
  'export-srt': async () => { const r = await api.invoke('export:srt'); if (r) toast(`${r.captions} subtítulos exportados.`); },
  'save-portable': async () => { const p = await api.invoke('project:portable'); if (p) toast(`Proyecto portátil guardado: ${p}`); },
  'append-project': () => void api.invoke('project:append'),
  undo: () => void op('undo'), redo: () => void op('redo'),
  cut: () => copy(true), copy: () => copy(), paste: () => void paste(), delete: () => void del(),
  'select-all': () => store.select(store.project.clips.map((c) => c.id)),
  split: () => void split(), duplicate: () => { const c = store.first(); if (c) void op('duplicate', c.id); },
  'detach-audio': () => { const c = store.first(); if (c) void op('detachAudio', c.id); },
  freeze: () => void op('freezeFrame', store.time, 3),
  marker: () => void op('addMarker', store.time),
  play: () => void play(), 'prev-frame': () => stepFrame(-1), 'next-frame': () => stepFrame(1), 'prev-clip': () => jumpClip(-1), 'next-clip': () => jumpClip(1),
  'back-half': () => { stop(); store.seek(store.time - 0.5); }, 'fwd-half': () => { stop(); store.seek(store.time + 0.5); },
  fullscreen: () => fullscreen(), snapshot: () => (document.querySelector('#player-right .ib[title^="Guarde"]') as HTMLButtonElement)?.click(),
  'project-settings': () => projectSettingsDialog(), preferences: () => void preferencesDialog(), shortcuts: () => shortcutsDialog(), about: () => void aboutDialog(),
};
// in the advanced mode the menus drive the composition; editing commands of the simple timeline are ignored
const SIMPLE_ONLY = new Set(['split', 'duplicate', 'marker', 'freeze', 'detach-audio', 'prev-clip', 'next-clip', 'back-half', 'fwd-half', 'fullscreen', 'snapshot', 'cut', 'copy', 'paste', 'palette']);
api.on('menu', (cmd: string, ...args: unknown[]) => {
  if (cmd === 'toggle-mode') { void setMode(!isAdvanced()); return; }
  if (cmd === 'run-script') { void import('./advanced/scripts-ui').then((m) => m.runScriptUI()); return; }
  if (cmd === 'content-aware-fill') { void setMode(true).then(() => (document.querySelector('[data-test=tab-caf]') as HTMLElement | null)?.click()); return; }
  if (cmd === 'lumetri-scopes') { void setMode(true).then(() => import('./advanced/scopes-ui')).then((m) => m.showScopes()); return; }
  if (cmd === 'mode-simple' || cmd === 'mode-adv') { void setMode(cmd === 'mode-adv'); return; }
  // commands of the advanced mode's shortcut table (View / Window / Edit items of the «paneles» line)
  if (cmd.startsWith('adv:')) { void setMode(true).then(() => advCommand(cmd.slice(4))); return; }
  if (isAdvanced() && (advCommand(cmd) || SIMPLE_ONLY.has(cmd))) return;
  commands[cmd]?.(...args);
});
document.addEventListener('cinta:command', (e) => commands[(e as CustomEvent<string>).detail]?.());

document.addEventListener('keydown', (e) => {
  if (isAdvanced()) { advKey(e); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a' && !(e.target instanceof Element && e.target.matches('input, textarea, select'))) { e.preventDefault(); void setMode(true); return; }
  const tgt = e.target;
  if (tgt instanceof Element && tgt.matches('input, textarea, select') && e.key !== 'Escape') return;
  if (document.querySelector('.backdrop')) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  const run = (cmd: string) => { e.preventDefault(); commands[cmd](); };
  if (k === ' ') return run('play');
  if (ctrl && k.toLowerCase() === 'z') return run(e.shiftKey ? 'redo' : 'undo');
  if (ctrl && k.toLowerCase() === 'y') return run('redo');
  if (ctrl && k.toLowerCase() === 'x') return run('cut');
  if (ctrl && k.toLowerCase() === 'c') return run('copy');
  if (ctrl && k.toLowerCase() === 'v') return run('paste');
  if (ctrl && k.toLowerCase() === 'a') return run('select-all');
  if (ctrl && k.toLowerCase() === 'b') return run('split');
  if (ctrl && k.toLowerCase() === 'd') return run('duplicate');
  if (ctrl && k.toLowerCase() === 'm') return run('marker');
  if (ctrl && k.toLowerCase() === 'k') return run('palette');
  if (k === 'F4') return run('toggle-inspector');
  if (ctrl && (k === '+' || k === '=')) { e.preventDefault(); return zoomTo(store.zoom * 1.4); }
  if (ctrl && k === '-') { e.preventDefault(); return zoomTo(store.zoom / 1.4); }
  if (ctrl && k === '0') { e.preventDefault(); return zoomFit(); }
  if (k === 'Delete' || k === 'Backspace') return run('delete');
  if (k === 'ArrowLeft') return run(ctrl ? 'prev-clip' : e.shiftKey ? 'back-half' : 'prev-frame');
  if (k === 'ArrowRight') return run(ctrl ? 'next-clip' : e.shiftKey ? 'fwd-half' : 'next-frame');
  if (k === 'Home') { e.preventDefault(); stop(); return store.seek(0); }
  if (k === 'End') { e.preventDefault(); stop(); return store.seek(store.duration()); }
  if (k === 'Escape') { if (currentTool()) closeTool(); store.select([]); }
});

// ───────────────────────── splitters ─────────────────────────
function splitters() {
  const app = $('app');
  $('split-h').addEventListener('pointerdown', (e) => {
    const y0 = e.clientY, top0 = $('top').getBoundingClientRect().height;
    const mv = (ev: PointerEvent) => app.style.setProperty('--top-h', `${Math.max(334, Math.min(innerHeight - 300, top0 + ev.clientY - y0))}px`);
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  });
  $('split-v').addEventListener('pointerdown', (e) => {
    const x0 = e.clientX, w0 = $('workspace').getBoundingClientRect().width;
    const mv = (ev: PointerEvent) => app.style.setProperty('--ws-w', `${Math.max(380, Math.min(innerWidth - 700, w0 + ev.clientX - x0))}px`);
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  });
}

// ───────────────────────── boot ─────────────────────────
async function boot() {
  store.set((await api.invoke('state')) as AppState, 'init');
  toolbar();
  splitters();
  initPlayer((aspect) => {
    if (aspect) void op('setSettings', { aspect });
    else projectSettingsDialog();
  });
  initTimeline({
    openClip: (c, dbl) => {
      if (dbl) openToolFor(c.type === 'title' ? 'title' : 'props', c);
      else if (currentTool()) openToolFor(currentTool()!, c);
    },
    openTransition: () => openToolFor('transition'),
    applyDrop: (p, at) => void applyDrop(p, at),
    importFiles: (paths, at) => void importAndAdd(paths, true, at),
    clipMenu,
  });
  await initWorkspace();
  initInspector((cmd) => commands[cmd]?.());
  initTasks();
  $('player-right').prepend(h('button', { class: 'ib on', title: 'Mostrar u ocultar el inspector (F4)', html: ICONS.inspector, dataset: { test: 'inspector-toggle' }, onclick: () => toggleInspector() }));
  setTimeout(() => startTour(), 1500);
  store.on((why) => { if (why !== 'time-play' && why !== 'zoom') updateToolbar(); });
  api.on('state', (st: AppState) => {
    const wasEmpty = !store.project.clips.length;
    store.set(st, 'state');
    if (wasEmpty && st.project.clips.length) zoomFit();
  });
  api.on('missing', (list: { id: string; path: string }[]) => missingDialog(list));
  api.on('task', (t: { name: string; progress: number } | null) => {
    const el = $('task');
    el.innerHTML = '';
    if (t) el.append(h('span', {}, t.name), h('span', { class: 'bar' }, h('i', { style: { width: `${Math.round(t.progress * 100)}%` } })));
  });
  // drop files anywhere outside the timeline → import
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    if ((e.target as HTMLElement).closest('#tl-content, .drop-zone')) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathOf(f));
    if (files.length) void importAndAdd(files);
  });
  updateToolbar();
  renderTimeline();
  $('status').insertBefore(modeSwitch(), $('status').lastElementChild);
  document.addEventListener('cinta:stop-simple', () => stop());
  try { if (localStorage.getItem('cinta.mode') === 'adv') await setMode(true); } catch { /* private */ }
  (window as unknown as { cintaReady: boolean }).cintaReady = true;
  void isPlaying;
}
void boot();
