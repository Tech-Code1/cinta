// Keyboard shortcuts of the advanced mode: every key goes through this table (handlers registered by id), and the
// After Effects-style editor (Edit ▸ Keyboard Shortcuts, Ctrl+Alt+'): visual keyboard (coloured keys, modifiers),
// search, add / remove / reassign with conflicts (the key is taken from the other command, «Ir a conflicto»),
// undo, shortcut sets (Conjunto predeterminado read-only, Guardar como…, Eliminar), copy to the clipboard.
// Sets are saved in the preferences (settings.json: advShortcuts).
import { ADV_SHORTCUTS, DEFAULT_SET, assignKey, comboLabel, comboOf, conflicts, diffSet, keyIndex, removeKey, resolveSet, shortcutsText, type ShortcutPrefs } from '../../core/motion/atajos';
import { modal } from '../dialogs';
import { api, h, toast } from '../store';
import { css } from './paneles-css';

type Handler = (e?: KeyboardEvent) => boolean | void;
const handlers = new Map<string, Handler>();
/** Registers what a command does (returning false lets the next command bound to the same key try). */
export function bindCommands(o: Record<string, Handler>) { for (const [k, f] of Object.entries(o)) handlers.set(k, f); }
/** Runs a command by id (menus, buttons). */
export function runCommand(id: string): boolean { const f = handlers.get(id); if (!f) return false; return f() !== false; }

let prefs: ShortcutPrefs = { current: DEFAULT_SET, sets: {} };
let map = resolveSet(undefined);
let index = keyIndex(map);
function apply() { map = resolveSet(prefs.current === DEFAULT_SET ? undefined : prefs.sets[prefs.current]); index = keyIndex(map); }
/** loaded from the preferences when the module starts */
export const shortcutsReady = (async () => {
  try {
    const r = await api.invoke('prefs:get') as { settings?: { advShortcuts?: ShortcutPrefs } };
    const p = r?.settings?.advShortcuts;
    if (p?.sets && typeof p.current === 'string') { prefs = { current: p.sets[p.current] || p.current === DEFAULT_SET ? p.current : DEFAULT_SET, sets: p.sets }; apply(); }
  } catch { /* defaults */ }
})();
async function savePrefs() { await api.invoke('prefs:set', { advShortcuts: prefs }).catch(() => {}); }

/** Keys of a command in the current set (Spanish labels, for tooltips and menus). */
export function keysOf(id: string): string { return (map[id] ?? []).map(comboLabel).join(', '); }
/** The command ids a key event triggers. */
export const commandsFor = (e: KeyboardEvent) => index.get(comboOf(keyLike(e))) ?? [];
const keyLike = (e: KeyboardEvent) => ({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, altGraph: !!e.getModifierState?.('AltGraph') });
/** Dispatches a keydown of the advanced mode through the shortcut table. */
export function dispatchKey(e: KeyboardEvent): boolean {
  for (const id of commandsFor(e)) {
    const f = handlers.get(id);
    if (!f) continue;
    if (f(e) !== false) { e.preventDefault(); return true; }
  }
  return false;
}
/** test hook */
export const shortcutsState = () => ({ current: prefs.current, sets: Object.keys(prefs.sets), map });

// ───────────────────────── editor ─────────────────────────
const ROWS: [string, string, number?][][] = [
  [['Escape', 'Esc'], ['F1', 'F1'], ['F2', 'F2'], ['F3', 'F3'], ['F4', 'F4'], ['F5', 'F5'], ['F6', 'F6'], ['F7', 'F7'], ['F8', 'F8'], ['F9', 'F9'], ['F10', 'F10'], ['F11', 'F11'], ['F12', 'F12']],
  [['º', 'º'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['0', '0'], ["'", "'"], ['¡', '¡'], ['Backspace', 'Retroceso', 2]],
  [['Tab', 'Tab', 1.5], ['Q', 'Q'], ['W', 'W'], ['E', 'E'], ['R', 'R'], ['T', 'T'], ['Y', 'Y'], ['U', 'U'], ['I', 'I'], ['O', 'O'], ['P', 'P'], ['`', '`'], ['+', '+'], ['Enter', 'Intro', 1.5]],
  [['', 'Bloq Mayús', 1.8], ['A', 'A'], ['S', 'S'], ['D', 'D'], ['F', 'F'], ['G', 'G'], ['H', 'H'], ['J', 'J'], ['K', 'K'], ['L', 'L'], ['Ñ', 'Ñ'], ['[', '['], [']', ']'], [';', ';']],
  [['', 'Mayús', 1.4], ['<', '<'], ['Z', 'Z'], ['X', 'X'], ['C', 'C'], ['V', 'V'], ['B', 'B'], ['N', 'N'], ['M', 'M'], [',', ','], ['.', '.'], ['-', '-'], ['/', '/'], ['=', '=']],
  [['', 'Ctrl', 1.4], ['', 'Alt', 1.2], ['Space', 'Espacio', 6], ['Left', '←'], ['Up', '↑'], ['Down', '↓'], ['Right', '→'], ['Home', 'Inicio'], ['End', 'Fin'], ['PageUp', 'RePág'], ['PageDown', 'AvPág'], ['Delete', 'Supr'], ['Numpad0', '0 (num.)', 1.6]],
];
const CSS = `
.kse { display: flex; flex-direction: column; gap: 8px; min-width: 860px; }
.kse-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kse-kb { display: flex; flex-direction: column; gap: 3px; background: var(--bg2); padding: 8px; border-radius: 6px; user-select: none; }
.kse-kb .r { display: flex; gap: 3px; }
.kse-kb .k { flex: 0 0 calc(var(--w, 1) * 46px); height: 32px; border-radius: 4px; background: #3a3f4f; color: var(--text); font-size: 10.5px; display: flex; align-items: flex-start; justify-content: flex-start; padding: 2px 4px; overflow: hidden; line-height: 1.1; cursor: pointer; border: 1px solid transparent; }
.kse-kb .k.app { background: #6c4bd8; color: #fff; }
.kse-kb .k.mod { background: #2b2f3b; color: var(--muted); cursor: pointer; }
.kse-kb .k.mod.on { background: var(--accent); color: #fff; }
.kse-kb .k.sel { border-color: #ffd400; }
.kse-list { max-height: 300px; overflow: auto; border: 1px solid var(--line); border-radius: 4px; }
.kse-list .g { padding: 4px 8px; color: var(--hi); font-weight: 600; background: var(--panel2); position: sticky; top: 0; }
.kse-list .c { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 3px 8px 3px 18px; align-items: center; }
.kse-list .c.sel { background: #2c3a55; }
.kse-list .c .ks { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.kse-list .chip { background: #3a3f4f; border-radius: 4px; padding: 1px 6px; font-size: 11px; display: inline-flex; gap: 4px; align-items: center; }
.kse-list .chip.conf { background: #8a3a2a; }
.kse-list .chip button { color: var(--muted); font-size: 11px; padding: 0 2px; }
.kse-list .add { font-size: 11px; color: var(--muted); padding: 0 4px; border: 1px dashed var(--line2); border-radius: 4px; }
.kse-list .add.wait { color: #ffd400; border-color: #ffd400; }
.kse-msg { min-height: 18px; color: #ffb36b; font-size: 12px; display: flex; gap: 10px; align-items: center; }
`;

/** Edit ▸ Keyboard Shortcuts. */
export function shortcutsDialog() {
  css('kse', CSS);
  // working copy of the map; the dialog commits it on Aceptar
  let setName = prefs.current;
  let work: Record<string, string[]> = JSON.parse(JSON.stringify(map));
  const history: Record<string, string[]>[] = [];
  let selected: string | null = null, keySel: string | null = null, filter = '', lastConflict: string | null = null;
  const mods = { Ctrl: false, Alt: false, Shift: false };
  let capture: { id: string; btn: HTMLElement } | null = null;
  const label = (id: string) => ADV_SHORTCUTS.find((c) => c.id === id)!;

  const setSel = h('select', { dataset: { test: 'kse-set' } }) as HTMLSelectElement;
  const fillSets = () => setSel.replaceChildren(h('option', { value: DEFAULT_SET }, `${DEFAULT_SET} (sólo lectura)`), ...Object.keys(prefs.sets).map((n) => h('option', { value: n, selected: n === setName }, n)));
  fillSets();
  setSel.value = setName;
  setSel.onchange = () => { setName = setSel.value; work = resolveSet(setName === DEFAULT_SET ? undefined : prefs.sets[setName]); history.length = 0; draw(); };
  const search = h('input', { type: 'search', placeholder: 'Buscar comando o tecla', style: { flex: '1', minWidth: '220px' }, dataset: { test: 'kse-search' } }) as HTMLInputElement;
  search.addEventListener('keydown', (e) => e.stopPropagation());
  search.oninput = () => { filter = search.value.trim().toLowerCase(); keySel = null; draw(); };
  const kb = h('div', { class: 'kse-kb', dataset: { test: 'kse-keyboard' } });
  const list = h('div', { class: 'kse-list', dataset: { test: 'kse-list' } });
  const msg = h('div', { class: 'kse-msg', dataset: { test: 'kse-msg' } });

  const combo = (k: string) => [mods.Ctrl && 'Ctrl', mods.Alt && 'Alt', mods.Shift && 'Shift', k].filter(Boolean).join('+');
  const change = (fn: () => void) => { history.push(JSON.parse(JSON.stringify(work))); fn(); draw(); };
  const add = (id: string, c: string) => change(() => {
    const r = assignKey(work, id, c);
    if (r.error) { history.pop(); say(r.error); return; }
    if (r.removedFrom.length) {
      const o = label(r.removedFrom[0]);
      lastConflict = r.removedFrom[0];
      say(`El método abreviado "${comboLabel(c)}" ya en uso para el comando "${o.group} > ${o.label}". Se ha eliminado de ese comando.`, true);
    } else say('');
  });
  function say(t: string, conflict = false) {
    msg.replaceChildren(t, conflict && lastConflict ? h('button', { class: 'btn small', dataset: { test: 'kse-goto' }, onclick: () => { selected = lastConflict; filter = ''; search.value = ''; draw(); list.querySelector('.c.sel')?.scrollIntoView({ block: 'nearest' }); } }, 'Ir a conflicto') : '');
  }

  function draw() {
    const idx = keyIndex(work);
    const conf = new Set(conflicts(work).map((x) => x.combo));
    // keyboard: keys with a command under the current modifiers are coloured
    kb.replaceChildren(...ROWS.map((row) => h('div', { class: 'r' }, ...row.map(([k, lab, w]) => {
      const isMod = ['Ctrl', 'Alt', 'Mayús'].includes(lab);
      const modKey = lab === 'Mayús' ? 'Shift' : lab as 'Ctrl' | 'Alt';
      const ids = k ? idx.get(combo(k)) ?? [] : [];
      const el = h('div', {
        class: `k${isMod ? ` mod${mods[modKey] ? ' on' : ''}` : ''}${ids.length ? ' app' : ''}${keySel && k === keySel ? ' sel' : ''}`,
        style: { '--w': String(w ?? 1) }, title: ids.map((i) => label(i).label).join('\n'), dataset: { test: `kse-key-${isMod ? modKey : k}` },
        onclick: () => { if (isMod) { mods[modKey] = !mods[modKey]; draw(); return; } if (!k) return; keySel = combo(k); filter = ''; search.value = ''; draw(); },
      }, lab);
      return el;
    }))));
    // command list (filtered by text, or by the key clicked on the keyboard)
    const rows: HTMLElement[] = [];
    let g = '';
    for (const c of ADV_SHORTCUTS) {
      const keys = work[c.id] ?? [];
      if (keySel && !keys.includes(keySel)) continue;
      if (filter && !`${c.group} ${c.label}`.toLowerCase().includes(filter) && !keys.some((k) => comboLabel(k).toLowerCase().includes(filter) || k.toLowerCase() === filter)) continue;
      if (c.group !== g) { g = c.group; rows.push(h('div', { class: 'g' }, g)); }
      const addBtn = h('button', { class: `add${capture?.id === c.id ? ' wait' : ''}`, title: 'Añade un nuevo método abreviado al comando seleccionado: pulse la combinación de teclas', dataset: { test: `kse-add-${c.id}` }, onclick: (e: MouseEvent) => { e.stopPropagation(); capture = { id: c.id, btn: addBtn }; selected = c.id; draw(); } }, capture?.id === c.id ? 'Pulse las teclas…' : '+ Añadir');
      rows.push(h('div', { class: `c${selected === c.id ? ' sel' : ''}`, dataset: { test: `kse-cmd-${c.id}` }, onclick: () => { selected = c.id; draw(); } },
        h('span', {}, c.label),
        h('span', { class: 'ks' }, ...keys.map((k) => h('span', { class: `chip${conf.has(k) ? ' conf' : ''}`, dataset: { test: `kse-chip-${c.id}`, combo: k } }, comboLabel(k),
          h('button', { title: 'Quitar', dataset: { test: `kse-rm-${c.id}` }, onclick: (e: MouseEvent) => { e.stopPropagation(); change(() => { const err = removeKey(work, c.id, k); if (err) { history.pop(); say(err); } }); } }, '×'))), addBtn)));
    }
    if (!rows.length) rows.push(h('div', { class: 'hint pad' }, 'Ningún comando coincide.'));
    list.replaceChildren(...rows);
  }
  // capturing a new key: the next keydown anywhere in the dialog
  const onKey = (e: KeyboardEvent) => {
    if (!capture) return;
    const c = comboOf(keyLike(e));
    if (!c) return;
    e.preventDefault(); e.stopPropagation();
    const id = capture.id;
    capture = null;
    add(id, c);
  };
  document.addEventListener('keydown', onKey, true);

  const undo = h('button', { class: 'btn', title: 'Invierte el último método abreviado modificado, añadido o eliminado', dataset: { test: 'kse-undo' }, onclick: () => { const p = history.pop(); if (p) { work = p; say(''); draw(); } } }, 'Deshacer');
  const clearBtn = h('button', { class: 'btn', title: 'Quita todos los métodos abreviados del comando seleccionado', dataset: { test: 'kse-clear' }, onclick: () => { if (selected) change(() => { for (const k of [...(work[selected!] ?? [])]) removeKey(work, selected!, k); }); } }, 'Borrar');
  const saveAs = h('button', { class: 'btn', title: 'Guardar el conjunto de métodos abreviados actual con un nombre nuevo', dataset: { test: 'kse-saveas' }, onclick: () => {
    // (Electron has no window.prompt: the name is typed in the box next to the button)
    const name = nameIn.value.trim() || (setName === DEFAULT_SET ? 'Personalizado' : setName);
    if (name === DEFAULT_SET) { say(`El nombre "${name}" no está permitido.`); return; }
    void saveSet(name);
  } }, 'Guardar como...');
  const nameIn = h('input', { placeholder: 'Nombre del ajuste preestablecido', style: { width: '170px' }, dataset: { test: 'kse-name' } }) as HTMLInputElement;
  nameIn.addEventListener('keydown', (e) => e.stopPropagation());
  const del = h('button', { class: 'btn', title: 'Eliminar el conjunto de métodos abreviados de teclado actual', dataset: { test: 'kse-delete' }, onclick: async () => {
    if (setName === DEFAULT_SET) return;
    delete prefs.sets[setName];
    if (prefs.current === setName) prefs.current = DEFAULT_SET;
    setName = DEFAULT_SET; work = resolveSet(undefined); fillSets(); setSel.value = DEFAULT_SET;
    apply(); await savePrefs(); draw();
  } }, 'Eliminar');
  async function saveSet(name: string) {
    prefs.sets[name] = diffSet(work);
    setName = name; prefs.current = name;
    fillSets(); setSel.value = name;
    apply(); await savePrefs();
    toast(`Conjunto «${name}» guardado.`);
  }
  const copy = h('button', { class: 'btn', title: 'Copia la lista completa de métodos abreviados de teclado en el portapapeles del sistema operativo', dataset: { test: 'kse-copy' }, onclick: () => { void navigator.clipboard?.writeText(shortcutsText(work)).catch(() => {}); toast('Métodos abreviados copiados en el portapapeles.'); } }, 'Copiar en el portapapeles');
  const ok = h('button', { class: 'btn primary', dataset: { test: 'kse-ok' }, onclick: async () => {
    const changed = JSON.stringify(diffSet(work)) !== JSON.stringify(setName === DEFAULT_SET ? {} : diffSet(resolveSet(prefs.sets[setName])));
    // the default set is read-only: changes go to «Personalizado»
    if (setName === DEFAULT_SET && Object.keys(diffSet(work)).length) await saveSet('Personalizado');
    else if (setName !== DEFAULT_SET && changed) await saveSet(setName);
    else if (prefs.current !== setName) { prefs.current = setName; apply(); await savePrefs(); }
    close();
  } }, 'Aceptar');
  const cancel = h('button', { class: 'btn', dataset: { test: 'kse-cancel' }, onclick: () => close() }, 'Cancelar');
  const m = modal('Métodos abreviados de teclado', [h('div', { class: 'kse', dataset: { test: 'kse' } },
    h('div', { class: 'kse-top' }, h('span', {}, 'Ajuste preestablecido:'), setSel, nameIn, saveAs, del, search),
    kb,
    h('div', { class: 'hint' }, 'Teclas moradas: tienen un comando con los modificadores elegidos (Ctrl, Alt, Mayús). Clic en una tecla: sus comandos. «+ Añadir» y pulse la combinación; si estaba en uso se quita del otro comando.'),
    list, msg)], [undo, clearBtn, copy, h('span', { style: { flex: '1' } }), cancel, ok], { width: 920 });
  const close = () => { document.removeEventListener('keydown', onKey, true); m.close(); };
  // the modal's own close (× or Esc outside capture) must drop the key listener too
  new MutationObserver((_, o) => { if (!m.box.isConnected) { document.removeEventListener('keydown', onKey, true); o.disconnect(); } }).observe(document.getElementById('modal-root')!, { childList: true });
  draw();
  return m;
}
