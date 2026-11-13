// «Datos y scripting» in the window: running an After Effects script (Archivo ▸ Scripts) with its output shown
// like ExtendScript's console, and the data footage of the Project panel (import, reload, remove).
import type { DataItem } from '../../core/motion/data';
import { DATA_KIND_NAMES, dataSummary } from '../../core/motion/data';
import type { ScriptResult } from '../../core/aescript';
import { modal } from '../dialogs';
import { contextMenu } from '../player';
import { api, cleanErr, h, toast } from '../store';
import { adv, mop } from './state';

/** Runs a .jsx / .js file (asks for it when not given) and shows what it printed and changed. */
export async function runScriptUI(file?: string) {
  let r: (ScriptResult & { file: string }) | null;
  try { r = await api.invoke('script:run', file ?? null, adv.compId ?? null); } catch (e) { toast(cleanErr(e), true); return; }
  if (!r) return;
  const ch = r.changes;
  const parts = [
    ch.compsAdded.length ? `${ch.compsAdded.length} composición(es) nueva(s): ${ch.compsAdded.join(', ')}` : '',
    ch.layersAdded.length ? `${ch.layersAdded.length} capa(s) nueva(s)` : '', ch.layersRemoved ? `${ch.layersRemoved} capa(s) eliminada(s)` : '',
    ch.keyframes ? `${ch.keyframes > 0 ? '+' : ''}${ch.keyframes} fotogramas clave` : '', ch.expressions ? `${ch.expressions > 0 ? '+' : ''}${ch.expressions} expresiones` : '',
    ch.effects ? `${ch.effects > 0 ? '+' : ''}${ch.effects} efectos` : '', ch.dataItems ? `${ch.dataItems} archivo(s) de datos` : '',
  ].filter(Boolean);
  if (r.openComp) { const { openComp } = await import('./panels'); openComp(r.openComp); }
  const name = r.file.split(/[\\/]/).pop();
  if (!r.log.length && r.ok) { toast(`«${name}» ejecutado${parts.length ? `: ${parts.join(', ')}` : ''}. Ctrl+Z lo deshace entero.`); return; }
  const m = modal(`Script: ${name}`, [
    h('div', { class: 'hint', dataset: { test: 'script-summary' } }, r.ok ? `Ejecutado en ${r.seconds.toFixed(2)} s${parts.length ? ` · ${parts.join(' · ')}` : ' · sin cambios'}. Ctrl+Z deshace todo el script.` : `Error${r.error?.line ? ` en la línea ${r.error.line}` : ''}: ${r.error?.message}${parts.length ? ` · cambios hechos hasta el error: ${parts.join(' · ')}` : ''}`),
    h('pre', { class: 'script-log', dataset: { test: 'script-log' }, style: { maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap', userSelect: 'text', font: '12px Consolas, monospace', background: 'var(--bg2, #111)', padding: '8px', borderRadius: '4px' } },
      ...r.log.map((x) => h('div', { style: { color: x.kind === 'error' ? '#ff6b6b' : x.kind === 'alert' ? '#ffd166' : '' } }, x.text))),
  ], [h('button', { class: 'btn primary', dataset: { test: 'script-ok' }, onclick: () => m.close() }, 'Aceptar')], { width: 560 });
}

/** Project panel rows of the data files. */
export function dataRows(items: DataItem[] | undefined, item: (icon: string, name: string, meta: string, payload: object, on: boolean, dbl: () => void, ctx?: (e: MouseEvent) => void) => HTMLElement) {
  return (items ?? []).map((d) => {
    const s = dataSummary(d);
    const meta = `${DATA_KIND_NAMES[d.kind]}${s.columns ? ` · ${s.columns.length} columnas × ${s.rows} filas` : s.streams !== undefined ? ` · ${s.streams} flujos` : s.rows !== undefined ? ` · ${s.rows} elementos` : s.keys?.length ? ` · ${s.keys.slice(0, 3).join(', ')}` : ''}`;
    const el = item('{ }', d.name, meta, { kind: 'data', id: d.id }, false, () => copyExpr(d), (e) => dataMenu(e, d));
    el.dataset.test = 'adv-data-item';
    el.title = `${d.path}\nDoble clic: copia una expresión que lee este archivo. En las expresiones: footage("${d.name}")`;
    return el;
  });
}
function copyExpr(d: DataItem) {
  const x = d.kind === 'csv' || d.kind === 'tsv' ? `footage("${d.name}").dataValue([0, 0])` : d.kind === 'mgjson' ? `footage("${d.name}").dataValue([0])` : `footage("${d.name}").sourceData`;
  void navigator.clipboard?.writeText(x).catch(() => {});
  toast(`Expresión copiada: ${x}`);
}
function dataMenu(e: MouseEvent, d: DataItem) {
  contextMenu(e, [
    { label: 'Volver a cargar material de archivo', fn: () => void reloadData([d.id]) },
    { label: 'Copiar expresión footage()', fn: () => copyExpr(d) },
    { sep: true },
    { label: 'Quitar del proyecto', fn: () => void mop('dataRemove', [d.id]) },
  ]);
}
export async function reloadData(ids: string[]) {
  try { await api.invoke('data:reload', ids); toast('Material de archivo vuelto a cargar.'); } catch (e) { toast(cleanErr(e), true); }
}
export async function importData(paths?: string[]) {
  try {
    const r: DataItem[] = await api.invoke('data:import', paths ?? null);
    if (r?.length) toast(`${r.map((d) => d.name).join(', ')} importado. Úselo en las expresiones con footage("${r[0].name}").`);
  } catch (e) { toast(cleanErr(e), true); }
}
