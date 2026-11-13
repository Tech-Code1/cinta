// Metadata panel (After Effects: Ventana ▸ Metadatos): the metadata of the file selected in the Media Browser, or of
// the selected layer's footage, as ffprobe reports it (file, container, streams, tags, chapters), with a search box.
import { api, h, store } from '../store';
import { bindCommands } from './atajos-ui';
import { css } from './paneles-css';
import { adv } from './state';

interface Group { name: string; rows: [string, string][] }
const CSS = `
.md-pane .md-h { padding: 5px 10px; color: var(--hi); font-weight: 600; background: var(--panel2); border-top: 1px solid var(--line); cursor: pointer; }
.md-pane .md-r { display: grid; grid-template-columns: 140px 1fr; gap: 6px; padding: 2px 10px 2px 18px; font-size: 11.5px; }
.md-pane .md-r span:first-child { color: var(--muted); }
.md-pane .md-r span:last-child { user-select: text; word-break: break-word; color: var(--text); }
.md-pane .md-src { padding: 6px 10px; font-size: 11px; color: var(--muted); word-break: break-all; }
`;
let target: string | null = null;
let fromBrowser = false;
let groups: Group[] = [];
export const metadataState = () => ({ target, groups });

export function metadataPanel(el: HTMLElement) {
  css('md', CSS);
  el.classList.add('md-pane');
  el.dataset.test = 'adv-meta';
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Buscar', dataset: { test: 'md-search' } }) as HTMLInputElement;
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const body = h('div', { dataset: { test: 'md-body' } });
  const src = h('div', { class: 'md-src' });
  el.append(search, src, body);
  const closed = new Set<string>();
  search.oninput = () => draw();
  let seq = 0;
  const load = async (p: string | null) => {
    if (p === target && groups.length) return;
    target = p;
    groups = [];
    const my = ++seq;
    src.textContent = p ?? '';
    if (!p) { draw(); return; }
    body.replaceChildren(h('div', { class: 'hint pad' }, 'Leyendo…'));
    const g = await api.invoke('medios:meta', p).catch(() => []) as Group[];
    if (my !== seq) return;
    groups = g;
    draw();
  };
  function draw() {
    if (!target) { body.replaceChildren(h('div', { class: 'hint pad' }, 'Seleccione un archivo en el Navegador de medios o una capa de material de archivo.')); return; }
    const q = search.value.trim().toLowerCase();
    const out: Node[] = [];
    for (const g of groups) {
      const rows = q ? g.rows.filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(q)) : g.rows;
      if (!rows.length) continue;
      out.push(h('div', { class: 'md-h', dataset: { test: 'md-group' }, onclick: () => { if (closed.has(g.name)) closed.delete(g.name); else closed.add(g.name); draw(); } }, `${closed.has(g.name) ? '▸' : '▾'} ${g.name}`));
      if (!closed.has(g.name)) out.push(...rows.map(([k, v]) => h('div', { class: 'md-r' }, h('span', {}, k), h('span', {}, v))));
    }
    body.replaceChildren(...(out.length ? out : [h('div', { class: 'hint pad' }, 'Sin metadatos.')]));
  }
  // the selected layer's footage (unless a file was just picked in the Media Browser)
  const fromLayer = () => {
    const l = adv.first();
    const m = l?.mediaId ? store.project.media.find((x) => x.id === l.mediaId) : undefined;
    if (m) { fromBrowser = false; void load(m.path); } else if (!fromBrowser) void load(null);
  };
  document.addEventListener('adv:meta-target', (e) => { fromBrowser = true; void load((e as CustomEvent<string>).detail); });
  adv.on((why) => { if (why === 'select') fromLayer(); });
  draw();
}

bindCommands({ 'panel-metadata': () => { (document.querySelector('[data-test=tab-metadata]') as HTMLElement | null)?.click(); } });
