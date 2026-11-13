// Inspector: a right-hand column with what is selected — the clip's timing, its main properties, its applied
// effects and the tools that fit it — so editing never hides the collections on the left.
import type { Clip } from '../core/model';
import { ICONS } from './icons';
import { clipDur, fmt, h, op, store } from './store';
import { buildPanel, openToolFor, toolsFor } from './workspace';

const KEY = 'cinta.inspector';
let el: HTMLElement;
let open = true;

export function initInspector(onCommand: (cmd: string) => void) {
  el = document.getElementById('inspector')!;
  try { open = localStorage.getItem(KEY) !== '0'; } catch { /* storage off */ }
  apply();
  store.on((why) => { if (why !== 'time' && why !== 'time-play' && why !== 'zoom') render(onCommand); });
  render(onCommand);
}

export function toggleInspector(force?: boolean) {
  open = force ?? !open;
  try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* storage off */ }
  apply();
}
export const inspectorOpen = () => open;

function apply() {
  document.getElementById('app')!.classList.toggle('no-inspector', !open);
  document.querySelector('[data-test=inspector-toggle]')?.classList.toggle('on', open);
}

function render(onCommand: (cmd: string) => void) {
  if (!el || !open) return;
  // keep typing / dragging undisturbed: the inspector is rebuilt after the change is committed
  if (el.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('textarea, input[type=text], input[type=number]')) return;
  const scroll = el.scrollTop;
  el.innerHTML = '';
  const head = (title: string, sub?: string) => el.append(h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, title), sub ? h('div', { class: 'insp-sub' }, sub) : null));
  const sel = store.selected();
  const trans = store.selectedTransition ? store.clip(store.selectedTransition) : undefined;
  if (trans?.transition) {
    head('Transición', `${trans.transition.type} · ${trans.transition.duration.toFixed(1)} s`);
    el.append(buildPanel('transition', trans, { compact: true }));
  } else if (sel.length > 1) {
    head(`${sel.length} clips seleccionados`, `${fmt(Math.min(...sel.map((c) => c.start)))} – ${fmt(Math.max(...sel.map((c) => c.start + clipDur(c))))}`);
    el.append(h('div', { class: 'insp-actions' },
      h('button', { class: 'btn', onclick: () => onCommand('delete') }, 'Eliminar'),
      h('button', { class: 'btn', onclick: () => onCommand('export-selection') }, 'Exportar selección')));
  } else if (sel.length === 1) {
    clipView(sel[0]);
  } else {
    const s = store.project.settings;
    head(store.s.path ? store.s.path.split(/[\\/]/).pop()!.replace(/\.cinta$/i, '') : 'Proyecto sin guardar', `${s.width}×${s.height} · ${s.fps} fps`);
    el.append(
      h('div', { class: 'insp-stats' },
        stat('Duración', fmt(store.duration())), stat('Clips', String(store.project.clips.length)), stat('Pistas', String(store.project.tracks.length)), stat('Marcadores', String(store.project.markers.length))),
      h('div', { class: 'insp-hint' }, 'Seleccione un clip para ver y cambiar sus propiedades aquí.'),
      h('div', { class: 'insp-actions' },
        h('button', { class: 'btn', onclick: () => onCommand('project-settings') }, 'Configuración del proyecto'),
        h('button', { class: 'btn', onclick: () => onCommand('palette') }, 'Buscar una acción (Ctrl+K)'),
        h('button', { class: 'btn primary', onclick: () => onCommand('export') }, 'Exportar')));
  }
  el.scrollTop = scroll;
}

const stat = (k: string, v: string) => h('div', { class: 'stat' }, h('span', {}, k), h('b', {}, v));

function clipView(c: Clip) {
  const kinds: Record<string, string> = { video: 'Vídeo', image: 'Foto', audio: 'Audio', color: 'Fondo', title: 'Título', sticker: 'Adhesivo', callout: 'Llamada' };
  const m = store.media(c);
  el.append(h('div', { class: 'insp-head' },
    h('div', { class: 'insp-title' }, c.type === 'title' ? (c.title?.text ?? '').split(/\n|\\N/)[0] : c.name ?? kinds[c.type]),
    h('div', { class: 'insp-sub' }, `${kinds[c.type]}${m?.width ? ` · ${m.width}×${m.height}` : ''}${store.trackOf(c) ? ` · ${store.trackOf(c)!.name}` : ''}`)));
  // timing: editable start (free tracks) and duration
  const main = store.trackOf(c)?.kind === 'main';
  const num = (v: number, fn: (x: number) => void, disabled = false, test?: string) => {
    const i = h('input', { type: 'number', step: '0.01', min: '0', value: v.toFixed(2), disabled, dataset: test ? { test } : undefined }) as HTMLInputElement;
    i.onchange = () => fn(Math.max(0, +i.value));
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); e.stopPropagation(); };
    return i;
  };
  el.append(h('div', { class: 'insp-time' },
    h('label', {}, 'Inicio', num(c.start, (v) => void op('move', c.id, { start: v }), main, 'insp-start')),
    h('label', {}, 'Duración', num(clipDur(c), (v) => void op('trim', c.id, { duration: v }), false, 'insp-duration'))));
  el.append(buildPanel(c.type === 'title' ? 'title' : 'props', c, { compact: true }));
  const tools = toolsFor(c);
  if (tools.length) {
    el.append(h('div', { class: 'insp-sec' }, 'Herramientas'), h('div', { class: 'insp-tools' }, ...tools.map((t) => h('button', { title: t.name, html: `${ICONS[t.icon]}<span>${t.name}</span>`, onclick: () => openToolFor(t.id, c) }))));
  }
}
