// Comfort features: command palette (Ctrl+K), start templates, first-run tour and the background task panel.
import { ICONS } from './icons';
import { api, auto, h, op, store, toast } from './store';

// ───────────────────────── command palette ─────────────────────────
export interface Cmd { label: string; group: string; keys?: string; run: () => void }
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Fuzzy search: every word of the query must appear; earlier and in-label matches rank higher. */
export function searchCommands(cmds: Cmd[], q: string): Cmd[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return cmds.slice(0, 60);
  const scored: [number, Cmd][] = [];
  for (const c of cmds) {
    const hay = norm(`${c.label} ${c.group}`);
    let score = 0, ok = true;
    for (const w of words) {
      const i = hay.indexOf(w);
      if (i < 0) { ok = false; break; }
      score += i + (norm(c.label).includes(w) ? 0 : 50);
    }
    if (ok) scored.push([score, c]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, 60).map((x) => x[1]);
}

export function openPalette(cmds: Cmd[]) {
  if (document.querySelector('.palette')) return;
  const input = h('input', { placeholder: 'Escriba una acción: «dividir», «9:16», «subtítulos», «sepia», «exportar mp4»…', dataset: { test: 'palette-input' } }) as HTMLInputElement;
  const list = h('div', { class: 'pal-list' });
  const back = h('div', { class: 'backdrop palette' }, h('div', { class: 'pal-box', role: 'dialog', 'aria-label': 'Paleta de comandos' }, input, list));
  let items: Cmd[] = [];
  let sel = 0;
  const draw = () => {
    items = searchCommands(cmds, input.value);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = '';
    items.forEach((c, i) => list.append(h('button', { class: `pal-item${i === sel ? ' on' : ''}`, onclick: () => run(c), onmousemove: () => { if (sel !== i) { sel = i; draw(); } } },
      h('span', { class: 'pal-group' }, c.group), h('span', { class: 'pal-label' }, c.label), c.keys ? h('span', { class: 'kbd' }, c.keys) : null)));
    if (!items.length) list.append(h('div', { class: 'hint', style: { padding: '12px' } }, 'Ninguna acción coincide.'));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => back.remove();
  const run = (c: Cmd) => { close(); c.run(); };
  input.oninput = () => { sel = 0; draw(); };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    if (e.key === 'Enter' && items[sel]) run(items[sel]);
  };
  back.onpointerdown = (e) => { if (e.target === back) close(); };
  document.getElementById('modal-root')!.append(back);
  draw();
  input.focus();
}

// ───────────────────────── background tasks ─────────────────────────
interface TaskView { el: HTMLElement; bar: HTMLElement; note: HTMLElement }
export interface TaskHandle { progress(f: number, note?: string): void; done(text: string, actions?: { label: string; fn: () => void }[]): void; fail(text: string): void }
let running = 0;
function tasksPop(): HTMLElement {
  let pop = document.getElementById('tasks-pop');
  if (!pop) {
    pop = h('div', { id: 'tasks-pop', class: 'tasks-pop' }, h('div', { class: 'tp-head' }, 'Tareas'));
    document.body.append(pop);
  }
  return pop;
}
function refreshBadge() {
  const b = document.querySelector('[data-test=tasks-btn]') as HTMLElement | null;
  if (b) { b.dataset.count = running ? String(running) : ''; b.classList.toggle('busy', running > 0); }
}
export function initTasks() {
  const status = document.getElementById('status')!;
  const btn = h('button', { class: 'tasks-btn', dataset: { test: 'tasks-btn' }, title: 'Tareas (exportaciones, transcripciones…)', html: `${ICONS.tGen}<span>Tareas</span>`, onclick: () => tasksPop().classList.toggle('open') });
  status.append(btn);
}
export function addTask(title: string, onCancel?: () => void): TaskHandle {
  const bar = h('i');
  const note = h('span', { class: 'tk-note' }, 'En cola…');
  const cancel = onCancel ? h('button', { class: 'ib', title: 'Cancelar', html: ICONS.close, onclick: () => onCancel() }) : null;
  const el = h('div', { class: 'task', dataset: { test: 'task' } }, h('div', { class: 'tk-top' }, h('span', { class: 'tk-title' }, title), cancel), h('div', { class: 'progress' }, bar), note);
  tasksPop().append(el);
  running++;
  refreshBadge();
  const v: TaskView = { el, bar, note };
  let finished = false;
  const end = () => { if (!finished) { finished = true; running--; refreshBadge(); cancel?.remove(); } };
  return {
    progress(f, n) { v.bar.style.width = `${Math.round(f * 100)}%`; v.note.textContent = n ?? `${Math.round(f * 100)} %`; },
    done(text, actions = []) {
      end();
      v.el.classList.add('done');
      v.bar.style.width = '100%';
      v.note.textContent = text;
      if (actions.length) v.el.append(h('div', { class: 'tk-actions' }, ...actions.map((a) => h('button', { class: 'btn', onclick: a.fn }, a.label))));
      notice(title, text, actions);
    },
    fail(text) { end(); v.el.classList.add('failed'); v.note.textContent = text; },
  };
}
/** A small non-blocking card in the corner (finished exports and the like). */
function notice(title: string, text: string, actions: { label: string; fn: () => void }[]) {
  const n = h('div', { class: 'notice', dataset: { test: 'notice' } }, h('b', {}, title), h('div', {}, text),
    h('div', { class: 'tk-actions' }, ...actions.map((a) => h('button', { class: 'btn', onclick: () => { a.fn(); n.remove(); } }, a.label)), h('button', { class: 'btn', onclick: () => n.remove() }, 'Cerrar')));
  document.body.append(n);
  setTimeout(() => n.remove(), 20000);
}

// ───────────────────────── start templates ─────────────────────────
export interface TemplateHooks { importAndAdd(paths: string[]): Promise<void>; slideshow(): void }
export function templateCards(hk: TemplateHooks): HTMLElement {
  const pick = async (aspect: string) => {
    await op('setSettings', { aspect });
    const files: string[] = await api.invoke('dialog:media', false);
    if (files.length) await hk.importAndAdd(files);
  };
  const card = (icon: string, title: string, sub: string, fn: () => void, test: string) =>
    h('button', { class: 'tpl', dataset: { test }, onclick: fn }, h('span', { class: 'tpl-icon', html: icon }), h('b', {}, title), h('span', {}, sub));
  const frame = (w: number, hh: number) => `<svg width="34" height="34" viewBox="0 0 34 34"><rect x="${17 - w / 2}" y="${17 - hh / 2}" width="${w}" height="${hh}" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  return h('div', { class: 'tpls' },
    h('div', { class: 'tpl-head' }, 'Empiece con una plantilla'),
    h('div', { class: 'tpl-grid' },
      card(frame(30, 17), 'YouTube / horizontal', '16:9 · 1920×1080', () => void pick('16:9'), 'tpl-16-9'),
      card(frame(17, 30), 'Short, Reel o TikTok', '9:16 · 1080×1920', () => void pick('9:16'), 'tpl-9-16'),
      card(frame(26, 26), 'Cuadrado', '1:1 · Instagram', () => void pick('1:1'), 'tpl-1-1'),
      card(frame(22, 28), 'Vertical', '4:5 · publicación', () => void pick('4:5'), 'tpl-4-5'),
      card(ICONS.slideshow, 'Presentación de fotos', 'Fotos + transiciones + música', () => hk.slideshow(), 'tpl-slides'),
      card(ICONS.sparkle, 'Short automático', 'Un vídeo → 9:16 con la cara centrada, sin silencios, subtítulos y música', () => void autoShort(hk), 'tpl-auto-short')));
}

/** The shorts-kit pipeline in one click: silences out, face-following 9:16, word-by-word captions, ducked music. */
export async function autoShort(hk: TemplateHooks, files?: string[]) {
  files ??= await api.invoke('dialog:media', false);
  if (!files?.length) return;
  const t = addTask('Short automático');
  try {
    t.progress(0.05, 'Importando…');
    await op('setSettings', { aspect: '16:9' });
    await hk.importAndAdd(files.slice(0, 1));
    t.progress(0.2, 'Quitando silencios…');
    await auto('removeSilences', {});
    t.progress(0.4, 'Siguiendo la cara (9:16)…');
    await auto('reframe', { aspect: '9:16', mode: 'face' });
    const prefs = await api.invoke('prefs:get');
    if (prefs.whisper) {
      t.progress(0.6, 'Escribiendo los subtítulos…');
      await auto('autoSubtitles', { style: 'subtitle-karaoke', language: 'es' });
    }
    t.progress(0.85, 'Añadiendo música…');
    const music = await api.invoke('generate', 'music', 'calm', Math.max(30, store.duration() + 2));
    await auto('addMusic', music, { duck: true, volume: 0.35 });
    t.done(prefs.whisper ? 'Listo: revise y exporte.' : 'Listo (sin subtítulos: falta el modelo Whisper).');
  } catch (e) {
    t.fail(String((e as Error).message ?? e));
  }
}

// ───────────────────────── first-run tour ─────────────────────────
const TOUR: { sel: string; title: string; text: string }[] = [
  { sel: '#rail', title: 'Colecciones', text: 'Importar, filtros, transiciones, títulos, adhesivos y más herramientas. Arrastre cualquier elemento a la línea de tiempo o haga doble clic.' },
  { sel: '#timeline', title: 'Línea de tiempo', text: 'La pista de vídeo es magnética. Los títulos siguen al vídeo al cortar. Arrastre los bordes para recortar; los clips se pegan al cursor (Alt para soltarlos).' },
  { sel: '#player', title: 'Reproductor', text: 'Muestra el fotograma exacto. Arrastre títulos y adhesivos para colocarlos; doble clic en un título para escribirlo. Las guías ayudan con 9:16.' },
  { sel: '#inspector', title: 'Inspector', text: 'Las propiedades de lo que seleccione y las herramientas que le sirven.' },
  { sel: '#export-btn', title: 'Exportar y buscar', text: 'Exporte cuando termine (sigue editando mientras tanto). Pulse Ctrl+K para buscar cualquier acción.' },
];
export function startTour(force = false) {
  try { if (!force && localStorage.getItem('cinta.tour') === 'done') return; } catch { return; }
  let i = 0;
  const bubble = h('div', { class: 'tour', role: 'dialog', dataset: { test: 'tour' } });
  const ring = h('div', { class: 'tour-ring' });
  document.body.append(ring, bubble);
  const finish = () => { bubble.remove(); ring.remove(); try { localStorage.setItem('cinta.tour', 'done'); } catch { /* storage off */ } };
  const show = () => {
    const s = TOUR[i];
    const target = document.querySelector(s.sel) as HTMLElement | null;
    if (!target || !target.offsetWidth) { i++; if (i < TOUR.length) show(); else finish(); return; }
    const r = target.getBoundingClientRect();
    Object.assign(ring.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    bubble.innerHTML = '';
    bubble.append(h('b', {}, `${s.title} (${i + 1}/${TOUR.length})`), h('div', {}, s.text), h('div', { class: 'tk-actions' },
      h('button', { class: 'btn', onclick: finish }, 'Saltar'),
      h('button', { class: 'btn primary', onclick: () => { i++; if (i < TOUR.length) show(); else finish(); } }, i < TOUR.length - 1 ? 'Siguiente' : 'Empezar')));
    const bw = 300, bh = bubble.offsetHeight || 140;
    let x = r.right + 12, y = r.top + 10;
    if (x + bw > innerWidth) x = Math.max(8, r.left - bw - 12);
    if (x < 8) { x = Math.min(innerWidth - bw - 8, r.left + 10); y = r.top - bh - 12; if (y < 8) y = r.bottom + 12; }
    Object.assign(bubble.style, { left: `${x}px`, top: `${Math.max(8, Math.min(innerHeight - bh - 8, y))}px` });
  };
  show();
}

export { toast };
