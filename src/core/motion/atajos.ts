// Keyboard shortcuts of the advanced mode (After Effects' Edit ▸ Keyboard Shortcuts): the command table with
// After Effects' default keys, key combos (canonical "Ctrl+Alt+Shift+K" form, Spanish labels), shortcut sets
// (overrides of the defaults) and conflicts. Pure: the renderer binds the commands to handlers.

export interface ShortcutCmd { id: string; group: string; label: string; keys: string[] }
/** a saved set: the keys of every command that differs from the defaults */
export type ShortcutSet = Record<string, string[]>;
export interface ShortcutPrefs { current: string; sets: Record<string, ShortcutSet> }
export const DEFAULT_SET = 'Conjunto predeterminado';

const C = (group: string, id: string, label: string, ...keys: string[]): ShortcutCmd => ({ id, group, label, keys });
/** Commands of the advanced mode, in the order they are tried when several share a key (After Effects' names). */
export const ADV_SHORTCUTS: ShortcutCmd[] = [
  // Archivo / Edición
  C('Archivo', 'import-file', 'Importar ▸ Archivo…', 'Ctrl+Alt+I'),
  C('Archivo', 'interpret-footage', 'Interpretar material de archivo ▸ Principal…', 'Ctrl+Alt+G'),
  C('Edición', 'undo', 'Deshacer', 'Ctrl+Z'),
  C('Edición', 'redo', 'Rehacer', 'Ctrl+Shift+Z', 'Ctrl+Shift+Y'),
  C('Edición', 'duplicate', 'Duplicar', 'Ctrl+D'),
  C('Edición', 'split', 'Dividir capa', 'Ctrl+Shift+D'),
  C('Edición', 'select-all', 'Seleccionar todo', 'Ctrl+A'),
  C('Edición', 'delete', 'Borrar', 'Delete', 'Backspace'),
  C('Edición', 'shortcuts', 'Métodos abreviados de teclado', "Ctrl+Alt+'"),
  // Composición
  C('Composición', 'new-comp', 'Nueva composición…', 'Ctrl+Alt+N'),
  C('Composición', 'comp-settings', 'Ajustes de composición…', 'Ctrl+K'),
  C('Composición', 'export', 'Añadir a la cola de procesamiento', 'Ctrl+M'),
  C('Composición', 'flowchart-comp', 'Diagrama de flujo de la composición', 'Ctrl+Shift+F11'),
  C('Composición', 'flowchart', 'Diagrama de flujo del proyecto', 'Ctrl+F11'),
  // Capa
  C('Capa', 'new-text', 'Nuevo ▸ Texto', 'Ctrl+Alt+Shift+T'),
  C('Capa', 'new-solid', 'Nuevo ▸ Sólido…', 'Ctrl+Y'),
  C('Capa', 'new-light', 'Nuevo ▸ Luz…', 'Ctrl+Alt+Shift+L'),
  C('Capa', 'new-camera', 'Nuevo ▸ Cámara…', 'Ctrl+Alt+Shift+C'),
  C('Capa', 'new-null', 'Nuevo ▸ Objeto nulo', 'Ctrl+Alt+Shift+Y'),
  C('Capa', 'new-adjustment', 'Nuevo ▸ Capa de ajuste', 'Ctrl+Alt+Y'),
  C('Capa', 'precompose', 'Precomponer…', 'Ctrl+Shift+C'),
  C('Capa', 'layer-in', 'Mover el inicio de la capa al tiempo actual', '['),
  C('Capa', 'layer-out', 'Mover el final de la capa al tiempo actual', ']'),
  C('Capa', 'trim-in', 'Recortar el punto de entrada al tiempo actual', 'Alt+['),
  C('Capa', 'trim-out', 'Recortar el punto de salida al tiempo actual', 'Alt+]'),
  // Animación
  C('Animación', 'easy-ease', 'Desacelerac./Acelerac. suave', 'F9'),
  C('Animación', 'ease-in', 'Desaceleración suave', 'Shift+F9'),
  C('Animación', 'ease-out', 'Aceleración suave', 'Ctrl+Shift+F9'),
  C('Animación', 'keyframe-velocity', 'Velocidad de fotograma clave…', 'Ctrl+Shift+K'),
  C('Animación', 'prev-key', 'Ir al fotograma clave anterior', 'J'),
  C('Animación', 'next-key', 'Ir al fotograma clave siguiente', 'K'),
  // Ver
  C('Ver', 'mode-toggle', 'Cambiar entre modo simple y avanzado', 'Ctrl+Shift+A'),
  C('Ver', 'zoom-in', 'Acercar', '.'),
  C('Ver', 'zoom-out', 'Reducir', ','),
  C('Ver', 'zoom-fit', 'Ajustar a la vista', '/'),
  C('Ver', 'view-active', 'Cambiar vista 3D ▸ Cámara activa', 'F12'),
  C('Ver', 'view-front', 'Cambiar vista 3D ▸ Parte frontal', 'F10'),
  C('Ver', 'view-left', 'Cambiar vista 3D ▸ Izquierda'),
  C('Ver', 'view-top', 'Cambiar vista 3D ▸ Parte superior'),
  C('Ver', 'view-back', 'Cambiar vista 3D ▸ Parte trasera'),
  C('Ver', 'view-right', 'Cambiar vista 3D ▸ Derecha'),
  C('Ver', 'view-bottom', 'Cambiar vista 3D ▸ Parte inferior'),
  C('Ver', 'view-custom1', 'Cambiar vista 3D ▸ Personalizar vista 1', 'F11'),
  C('Ver', 'view-custom2', 'Cambiar vista 3D ▸ Personalizar vista 2'),
  C('Ver', 'view-custom3', 'Cambiar vista 3D ▸ Personalizar vista 3'),
  C('Ver', 'last-3d-view', 'Cambiar a la última vista 3D', 'Escape'),
  C('Ver', 'reset-3d-view', 'Restablecer vista 3D'),
  C('Ver', 'layout-1', 'Cambiar el diseño de la vista ▸ 1 Vista'),
  C('Ver', 'layout-2', 'Cambiar el diseño de la vista ▸ 2 Vistas'),
  C('Ver', 'layout-4', 'Cambiar el diseño de la vista ▸ 4 Vistas'),
  // Ventana
  C('Ventana', 'panel-properties', 'Propiedades'),
  C('Ventana', 'panel-media', 'Navegador de medios'),
  C('Ventana', 'panel-metadata', 'Metadatos'),
  // Herramientas
  C('Herramientas', 'tool-select', 'Selección', 'V'),
  C('Herramientas', 'tool-hand', 'Mano', 'H'),
  C('Herramientas', 'tool-zoom', 'Zoom', 'Z'),
  C('Herramientas', 'tool-rotate', 'Rotar', 'W'),
  C('Herramientas', 'tool-anchor', 'Panorámica trasera (Punto de anclaje)', 'Y'),
  C('Herramientas', 'tool-shape', 'Forma/máscara (avanzar)', 'Q', 'Shift+Q'),
  C('Herramientas', 'tool-pen', 'Pluma', 'G'),
  C('Herramientas', 'tool-text', 'Texto (Tipo horizontal / vertical: avanzar)', 'Ctrl+T'),
  C('Herramientas', 'tool-paint', 'Pintura (Pincel/Clonar/Borrador)', 'Ctrl+B'),
  C('Herramientas', 'tool-puppet', 'Posición libre (Marioneta)', 'Ctrl+P'),
  C('Herramientas', 'tool-track', 'Rastrear movimiento', 'Ctrl+Alt+T'),
  C('Herramientas', 'tool-roto', 'Pincel tipo rotoscopia / Perfeccionar borde', 'Alt+W'),
  C('Herramientas', 'tool-camera', 'Cámara (avanzar)', 'C'),
  C('Herramientas', 'tool-orbit', 'Cámara orbital', '1'),
  C('Herramientas', 'tool-pan3d', 'Cámara panorámica', '2'),
  C('Herramientas', 'tool-dolly', 'Cámara de travelling', '3'),
  C('Herramientas', 'pen-finish', 'Terminar el trazado de la pluma', 'Enter'),
  C('Herramientas', 'deselect', 'Anular la selección / cancelar el trazado', 'Escape'),
  // Previsualización / tiempo
  C('Previsualización', 'play', 'Reproducir/Detener', 'Space'),
  C('Previsualización', 'ram', 'Previsualización RAM', 'Numpad0'),
  C('Previsualización', 'next-frame', 'Ir al fotograma siguiente', 'PageDown', 'Right'),
  C('Previsualización', 'prev-frame', 'Ir al fotograma anterior', 'PageUp', 'Left'),
  C('Previsualización', 'go-start', 'Ir al inicio de la composición', 'Home'),
  C('Previsualización', 'go-end', 'Ir al final de la composición', 'End'),
  C('Previsualización', 'work-start', 'Definir el inicio del área de trabajo', 'B'),
  C('Previsualización', 'work-end', 'Definir el final del área de trabajo', 'N'),
  // Línea de tiempo
  C('Línea de tiempo', 'reveal-position', 'Mostrar Posición', 'P'),
  C('Línea de tiempo', 'reveal-scale', 'Mostrar Escala', 'S'),
  C('Línea de tiempo', 'reveal-rotation', 'Mostrar Rotación', 'R'),
  C('Línea de tiempo', 'reveal-opacity', 'Mostrar Opacidad', 'T'),
  C('Línea de tiempo', 'reveal-anchor', 'Mostrar Punto de anclaje', 'A'),
  C('Línea de tiempo', 'add-position', 'Añadir Posición a las propiedades mostradas', 'Shift+P'),
  C('Línea de tiempo', 'add-scale', 'Añadir Escala a las propiedades mostradas', 'Shift+S'),
  C('Línea de tiempo', 'add-rotation', 'Añadir Rotación a las propiedades mostradas', 'Shift+R'),
  C('Línea de tiempo', 'add-opacity', 'Añadir Opacidad a las propiedades mostradas', 'Shift+T'),
  C('Línea de tiempo', 'add-anchor', 'Añadir Punto de anclaje a las propiedades mostradas', 'Shift+A'),
  C('Línea de tiempo', 'reveal-animated', 'Mostrar las propiedades animadas', 'U'),
  C('Línea de tiempo', 'collapse-all', 'Contraer todas las capas', '`', 'º'),
  C('Línea de tiempo', 'time-zoom-in', 'Acercar el tiempo', '=', '+'),
  C('Línea de tiempo', 'time-zoom-out', 'Alejar el tiempo', '-'),
  C('Línea de tiempo', 'time-zoom-fit', 'Ajustar el tiempo a la composición', ';'),
];
/** keys that cannot be reassigned (After Effects: the space bar stays with Play) */
export const RESERVED: Record<string, string> = { Space: 'play' };

const MODS = ['Ctrl', 'Alt', 'Shift'] as const;
/** Canonical form: modifiers in Ctrl, Alt, Shift order, then the key ("ctrl+shift+k" → "Ctrl+Shift+K"). */
export function normCombo(s: string): string {
  const raw = s.trim();
  if (!raw) return '';
  // the key itself may be "+" ("Ctrl++"): split off the last part by hand
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw === '+' ? ['+'] : raw.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts.map((m) => ({ ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Ctrl', alt: 'Alt', shift: 'Shift', 'mayús': 'Shift', mayus: 'Shift' } as Record<string, string>)[m.toLowerCase()] ?? m));
  const k = key.length === 1 ? key.toUpperCase() : ({ esc: 'Escape', supr: 'Delete', del: 'Delete', espacio: 'Space', ' ': 'Space', intro: 'Enter', return: 'Enter', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down' } as Record<string, string>)[key.toLowerCase()] ?? key;
  return [...MODS.filter((m) => mods.has(m)), k].join('+');
}

/** Name of the pressed key (letters and digits by their physical key, so Shift+1 is "Shift+1" on any layout). */
export function keyName(key: string, code = ''): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return code;
  if (/^F\d{1,2}$/.test(key)) return key;
  const named: Record<string, string> = { ' ': 'Space', Spacebar: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Esc: 'Escape', Del: 'Delete' };
  if (named[key]) return named[key];
  return key.length === 1 ? key.toUpperCase() : key;
}
export interface KeyLike { key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altGraph?: boolean }
/** The combo of a keydown event. AltGr (Ctrl+Alt on Windows) typing a symbol counts as the symbol alone, and a
 *  symbol already typed with Shift ("+", "?", "[") does not add Shift. */
export function comboOf(e: KeyLike): string {
  const k = keyName(e.key, e.code);
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(k)) return '';
  const symbol = k.length === 1 && !/[A-Z0-9]/.test(k);
  let ctrl = !!(e.ctrlKey || e.metaKey), alt = !!e.altKey;
  if (e.altGraph && symbol) ctrl = alt = false;
  const shift = !!e.shiftKey && !symbol;
  return [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', k].filter(Boolean).join('+');
}

const KEY_ES: Record<string, string> = {
  Shift: 'Mayús', Space: 'Espacio', Delete: 'Supr', Backspace: 'Retroceso', Escape: 'Esc', Enter: 'Intro', Home: 'Inicio', End: 'Fin',
  PageUp: 'RePág', PageDown: 'AvPág', Left: 'Flecha izquierda', Right: 'Flecha derecha', Up: 'Flecha arriba', Down: 'Flecha abajo', Tab: 'Tabulador', Insert: 'Insert',
};
/** Spanish label of a combo ("Ctrl+Shift+K" → "Ctrl+Mayús+K", "Numpad0" → "0 (teclado numérico)"). */
export function comboLabel(combo: string): string {
  if (!combo) return '';
  const n = normCombo(combo);
  const parts = n.endsWith('++') ? [...n.slice(0, -2).split('+'), '+'] : n.split('+');
  return parts.map((p) => KEY_ES[p] ?? (/^Numpad\d$/.test(p) ? `${p.slice(6)} (teclado numérico)` : p)).join('+');
}

/** The keys of every command for a set (overrides over the defaults). */
export function resolveSet(set: ShortcutSet | undefined, cmds: ShortcutCmd[] = ADV_SHORTCUTS): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of cmds) out[c.id] = (set?.[c.id] ?? c.keys).map(normCombo).filter(Boolean);
  return out;
}
/** Only what differs from the defaults (what a saved set stores). */
export function diffSet(map: Record<string, string[]>, cmds: ShortcutCmd[] = ADV_SHORTCUTS): ShortcutSet {
  const out: ShortcutSet = {};
  for (const c of cmds) {
    const a = (map[c.id] ?? []).map(normCombo), b = c.keys.map(normCombo);
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) out[c.id] = a;
  }
  return out;
}
/** combo → the commands bound to it (in command-table order) */
export function keyIndex(map: Record<string, string[]>, cmds: ShortcutCmd[] = ADV_SHORTCUTS): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const c of cmds) for (const k of map[c.id] ?? []) { const a = idx.get(k) ?? []; a.push(c.id); idx.set(k, a); }
  return idx;
}
/** Pairs sharing a key. Escape is shared on purpose by «Cambiar a la última vista 3D» and «Anular la selección»
 *  (the first only acts after a 3D view change), so a default pairing is not reported. */
export function conflicts(map: Record<string, string[]>, cmds: ShortcutCmd[] = ADV_SHORTCUTS): { combo: string; ids: string[] }[] {
  const def = keyIndex(resolveSet(undefined, cmds), cmds);
  const out: { combo: string; ids: string[] }[] = [];
  for (const [combo, ids] of keyIndex(map, cmds)) {
    if (ids.length < 2) continue;
    const d = def.get(combo) ?? [];
    if (ids.every((i) => d.includes(i)) && ids.length === d.length) continue;
    out.push({ combo, ids });
  }
  return out;
}
/** Adds a key to a command; like After Effects, the key is taken away from any other command that had it.
 *  Returns the commands it was removed from (or an error for a reserved key). */
export function assignKey(map: Record<string, string[]>, id: string, combo: string, replace?: string): { removedFrom: string[]; error?: string } {
  const k = normCombo(combo);
  if (!k) return { removedFrom: [], error: 'Método abreviado vacío.' };
  if (RESERVED[k] && RESERVED[k] !== id) return { removedFrom: [], error: 'La barra espaciadora no se puede reasignar a otro comando ni desasignarse del actual.' };
  const removedFrom: string[] = [];
  for (const [cid, keys] of Object.entries(map)) {
    if (cid === id || !keys.includes(k)) continue;
    // the shared default Escape pair stays shared
    if (k === 'Escape' && ['last-3d-view', 'deselect'].includes(cid) && ['last-3d-view', 'deselect'].includes(id)) continue;
    map[cid] = keys.filter((x) => x !== k);
    removedFrom.push(cid);
  }
  const cur = (map[id] ?? []).filter((x) => x !== k && x !== (replace ? normCombo(replace) : undefined));
  map[id] = [...cur, k];
  return { removedFrom };
}
export function removeKey(map: Record<string, string[]>, id: string, combo: string): string | undefined {
  const k = normCombo(combo);
  if (RESERVED[k] === id) return 'La barra espaciadora no se puede reasignar a otro comando ni desasignarse del actual.';
  map[id] = (map[id] ?? []).filter((x) => x !== k);
  return undefined;
}
/** Text listing of a set (After Effects: «Copiar en el portapapeles»). */
export function shortcutsText(map: Record<string, string[]>, cmds: ShortcutCmd[] = ADV_SHORTCUTS): string {
  const lines: string[] = [];
  let g = '';
  for (const c of cmds) {
    if (c.group !== g) { g = c.group; lines.push('', g); }
    lines.push(`\t${c.label}\t${(map[c.id] ?? []).map(comboLabel).join(', ')}`);
  }
  return lines.join('\n').trim() + '\n';
}
