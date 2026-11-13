// Media Browser panel (After Effects: Navegador de medios): browse the folders on disk (places and drives on the
// left, back / forward / up, recent folders, file types shown), preview the selected file (image, video or audio)
// and import it (double-click, the Importar button or the context menu). The selected file's metadata goes to the
// Metadata panel.
import { contextMenu } from '../player';
import { mediaUrl } from '../../motion-render/sources';
import { api, h, toast } from '../store';
import { bindCommands } from './atajos-ui';
import { css } from './paneles-css';
import { importFiles } from './panels';

interface Entry { name: string; path: string; kind: 'dir' | 'video' | 'audio' | 'image' | 'model' | 'project' | 'other'; size: number; mtime: number }
const CSS = `
.mb { display: flex; flex-direction: column; height: 100%; min-height: 0; }
#adv .tabpane.mb.on { display: flex; }
.mb-bar { display: flex; gap: 3px; padding: 5px 6px; align-items: center; flex: none; flex-wrap: wrap; }
.mb-bar input { flex: 1; min-width: 80px; height: 24px; font-size: 11px; }
.mb-bar select { height: 24px; font-size: 11px; max-width: 120px; }
.mb-main { display: grid; grid-template-columns: 110px 1fr; flex: 1; min-height: 0; border-top: 1px solid var(--line); }
.mb-places { overflow: auto; border-right: 1px solid var(--line); font-size: 11px; }
.mb-places div { padding: 3px 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mb-places div:hover { background: var(--hover); }
.mb-list { overflow: auto; }
.mb-list .e { display: grid; grid-template-columns: 18px 1fr auto; gap: 4px; padding: 2px 6px; cursor: default; white-space: nowrap; font-size: 12px; }
.mb-list .e span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; }
.mb-list .e .m { color: var(--muted); font-size: 10.5px; }
.mb-list .e:hover { background: var(--hover); }
.mb-list .e.sel { background: #2c3a55; }
.mb-prev { flex: none; height: 120px; border-top: 1px solid var(--line); background: #111318; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.mb-prev img, .mb-prev video { max-width: 100%; max-height: 100%; }
`;
const ICON: Record<string, string> = { dir: '📁', video: '▶', audio: '♪', image: '🖼', model: '⬢', project: '📄', other: '·' };
const TYPES: [string, string, Entry['kind'][] | null][] = [
  ['all', 'Todos los archivos compatibles', null], ['video', 'Vídeo', ['video']], ['audio', 'Audio', ['audio']], ['image', 'Imágenes', ['image']], ['model', 'Modelos 3D', ['model']],
];
const RKEY = 'cinta.adv.mediaBrowser';

let state = { dir: '', recent: [] as string[], type: 'all' };
try { state = { ...state, ...JSON.parse(localStorage.getItem(RKEY) ?? '{}') }; } catch { /* private */ }
const back: string[] = [], fwd: string[] = [];
let entries: Entry[] = [];
let selected: string | null = null;
export const mediaBrowserState = () => ({ dir: state.dir, selected, entries: entries.map((e) => ({ name: e.name, kind: e.kind })) });
let go: (dir: string, hist?: boolean) => Promise<void> = async () => {};
/** Opens a folder in the browser (tests, menus). */
export const browseTo = (dir: string) => go(dir);
export const selectEntry = (path: string) => { const el = document.querySelector<HTMLElement>(`.mb-list .e[data-path="${CSS_ESC(path)}"]`); el?.click(); };
const CSS_ESC = (s: string) => s.replace(/["\\]/g, '\\$&');

export function mediaBrowserPanel(el: HTMLElement) {
  css('mb', CSS);
  el.classList.add('mb');
  const path = h('input', { title: 'Ruta de la carpeta (Intro para ir)', dataset: { test: 'mb-path' } }) as HTMLInputElement;
  path.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') void go(path.value.trim()); });
  const type = h('select', { title: 'Tipos de archivo mostrados', dataset: { test: 'mb-type' } }, ...TYPES.map(([id, n]) => h('option', { value: id, selected: id === state.type }, n))) as HTMLSelectElement;
  type.onchange = () => { state.type = type.value; save(); draw(); };
  const recent = h('select', { title: 'Directorios recientes', style: { maxWidth: '26px' } }) as HTMLSelectElement;
  recent.onchange = () => { if (recent.value) void go(recent.value); recent.value = ''; };
  const places = h('div', { class: 'mb-places', dataset: { test: 'mb-places' } });
  const list = h('div', { class: 'mb-list', dataset: { test: 'mb-list' } });
  const prev = h('div', { class: 'mb-prev', dataset: { test: 'mb-preview' } }, h('span', { class: 'muted' }, 'Vista previa'));
  const btn = (t: string, tip: string, test: string, fn: () => void) => h('button', { class: 'tb', title: tip, dataset: { test }, onclick: fn }, t);
  el.append(
    h('div', { class: 'mb-bar' },
      btn('◀', 'Atrás', 'mb-back', () => { const d = back.pop(); if (d) { fwd.push(state.dir); void go(d, false); } }),
      btn('▶', 'Hacia adelante', 'mb-fwd', () => { const d = fwd.pop(); if (d) { back.push(state.dir); void go(d, false); } }),
      btn('▲', 'Carpeta superior', 'mb-up', () => { if (parent) void go(parent); }),
      path, recent),
    h('div', { class: 'mb-bar' }, type, h('span', { style: { flex: '1' } }), btn('Importar', 'Importar el archivo seleccionado en el proyecto', 'mb-import', () => { if (selected) void importOne(selected); })),
    h('div', { class: 'mb-main' }, places, list), prev);
  let parent: string | null = null;
  const save = () => { try { localStorage.setItem(RKEY, JSON.stringify(state)); } catch { /* private */ } };
  const fillRecent = () => recent.replaceChildren(h('option', { value: '' }, '⌄'), ...state.recent.map((d) => h('option', { value: d }, d)), ...(state.recent.length ? [h('option', { value: '__clear' }, 'Borrar directorios recientes')] : []));
  recent.addEventListener('change', () => { if (recent.value === '__clear') { state.recent = []; save(); fillRecent(); } });
  go = async (dir, hist = true) => {
    if (!dir || dir === '__clear') return;
    try {
      const r = await api.invoke('medios:list', dir) as { dir: string; parent: string | null; entries: Entry[] };
      if (hist && state.dir && state.dir !== r.dir) { back.push(state.dir); fwd.length = 0; }
      state.dir = r.dir; parent = r.parent; entries = r.entries; selected = null;
      state.recent = [r.dir, ...state.recent.filter((d) => d !== r.dir)].slice(0, 10);
      save(); fillRecent();
      path.value = r.dir;
      draw();
    } catch (e) { toast(`No se puede abrir la carpeta: ${String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true); }
  };
  const draw = () => {
    const kinds = TYPES.find((t) => t[0] === state.type)?.[2];
    const shown = entries.filter((e) => e.kind === 'dir' || !kinds || kinds.includes(e.kind));
    list.replaceChildren(...shown.map((e) => {
      const row = h('div', { class: `e${e.path === selected ? ' sel' : ''}`, title: e.path, draggable: e.kind !== 'dir' ? 'true' : undefined, dataset: { test: 'mb-entry', path: e.path, kind: e.kind } },
        h('span', {}, ICON[e.kind]), h('span', {}, e.name), h('span', { class: 'm' }, e.kind === 'dir' ? '' : size(e.size)));
      row.onclick = () => { selected = e.path; list.querySelectorAll('.e.sel').forEach((x) => x.classList.remove('sel')); row.classList.add('sel'); preview(e); document.dispatchEvent(new CustomEvent('adv:meta-target', { detail: e.path })); };
      row.ondblclick = () => { if (e.kind === 'dir') void go(e.path); else void importOne(e.path); };
      row.oncontextmenu = (ev) => contextMenu(ev, [
        ...(e.kind === 'dir' ? [{ label: 'Abrir', fn: () => void go(e.path) }] : [{ label: 'Importar', fn: () => void importOne(e.path) }]),
        // «importacion»: a numbered file (or a folder) as one sequence footage item
        ...(e.kind === 'image' || e.kind === 'dir' ? [{ label: e.kind === 'dir' ? 'Importar como secuencia' : 'Importar secuencia', fn: () => void api.invoke('import:footage', [e.path], { sequence: true }).then((r: { media: { name: string }[]; notes: string[] }) => toast(`Importado: ${r.media.map((m) => m.name).join(', ')}${r.notes.length ? ` · ${r.notes.join(' ')}` : ''}`), (err: unknown) => toast(String((err as Error)?.message ?? err), true)) }] : []),
        { label: 'Mostrar en el explorador', fn: () => void api.invoke('shell:show', e.path) },
      ]);
      return row;
    }));
    if (!shown.length) list.append(h('div', { class: 'hint pad' }, entries.length ? 'Ningún archivo de este tipo.' : 'Carpeta vacía.'));
  };
  const preview = (e: Entry) => {
    const url = mediaUrl(e.path);
    if (e.kind === 'image' && !/\.(exr|psd|ai|tga|dpx|tif|tiff|heic)$/i.test(e.path)) prev.replaceChildren(h('img', { src: url, dataset: { test: 'mb-prev-img' } }));
    else if (e.kind === 'video') prev.replaceChildren(h('video', { src: url, controls: true, muted: true, preload: 'metadata', dataset: { test: 'mb-prev-video' } }));
    else if (e.kind === 'audio') prev.replaceChildren(h('audio', { src: url, controls: true, preload: 'metadata', style: { width: '95%' } }));
    else prev.replaceChildren(h('span', { class: 'muted' }, e.kind === 'dir' ? `📁 ${e.name}` : e.name));
  };
  const size = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  void (async () => {
    const roots = await api.invoke('medios:roots').catch(() => []) as { name: string; path: string }[];
    places.replaceChildren(...roots.map((r) => h('div', { title: r.path, dataset: { test: 'mb-place' }, onclick: () => void go(r.path) }, r.name)));
    fillRecent();
    // starts where it was left (or at home), the first time the panel is shown
    const start = () => { if (!entries.length && !state.dir.startsWith('__')) void go(state.dir || roots[0]?.path || ''); };
    if (el.classList.contains('on')) start();
    else new MutationObserver((_, o) => { if (el.classList.contains('on')) { o.disconnect(); start(); } }).observe(el, { attributes: true, attributeFilter: ['class'] });
  })();
}
async function importOne(p: string) {
  await importFiles([p]);
  toast(`Importado: ${p.split(/[\\/]/).pop()}`);
}

bindCommands({ 'panel-media': () => { (document.querySelector('[data-test=tab-mediabrowser]') as HTMLElement | null)?.click(); } });
