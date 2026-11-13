// «importacion» in the UI: After Effects' Importar archivo options («Opciones de secuencia: Secuencia PNG»,
// «Forzar orden alfabético»), Interpretar material de archivo (Alfa, Velocidad de fotogramas, Bucle), Importar
// proyecto de Adobe Premiere Pro (Seleccionar secuencia, Importar audio) and Escena Maya; and the Importar section
// of the preferences (sequence footage frame rate, missing frames).
import { modal } from '../dialogs';
import { api, cleanErr, h, op, store, toast } from '../store';
import { bindCommands } from './atajos-ui';

type Detect = { path: string; folder: boolean; first: string | null; format: string; sequence: { name: string; frames: number; missing: number } | null };
type Prefs = { sequenceFps: number; reportMissing: boolean; sequence: boolean; alphabetical: boolean };
export interface Routed { rest: string[]; media: { id: string; kind: string; width: number; height: number; name: string }[] }

const row = (label: string, ...kids: (Node | string | null)[]) => h('div', { class: 'frow' }, h('label', {}, label), h('div', { class: 'fval' }, ...kids));
const chk = (on: boolean, test: string) => h('input', { type: 'checkbox', checked: on, dataset: { test } }) as HTMLInputElement;

async function footage(paths: string[], opts: { sequence?: boolean; alphabetical?: boolean }): Promise<Routed['media']> {
  try {
    const r: { media: Routed['media']; notes: string[] } = await api.invoke('import:footage', paths, opts);
    if (r.notes.length) toast(r.notes.join(' '));
    return r.media;
  } catch (e) { toast(cleanErr(e), true); return []; }
}

/** Takes from a list of files what the ordinary import cannot do: Premiere projects, Maya scenes, folders and — when
 *  `ask` (Archivo ▸ Importar) — a numbered file the user may want as a sequence. Returns what is left and the footage
 *  items imported here. Dropped folders import their sequence (as in After Effects); dropped files stay single. */
export async function routeImport(paths: string[], ask: boolean): Promise<Routed> {
  const rest: string[] = [], media: Routed['media'] = [];
  const special = paths.filter((p) => /\.(prproj|ma|mb)$/i.test(p));
  for (const p of special) { if (/\.prproj$/i.test(p)) await premiereDialog(p); else await mayaImportUI(p); }
  const others = paths.filter((p) => !special.includes(p));
  if (!others.length) return { rest, media };
  const det: Detect[] = await api.invoke('import:detect', others);
  const folders = det.filter((d) => d.folder);
  if (folders.length) media.push(...(await footage(folders.map((d) => d.path), { sequence: true })));
  const files = det.filter((d) => !d.folder);
  // AE shows «Secuencia …» for a single selected file that belongs to a numbered sequence
  if (ask && files.length === 1 && files[0].sequence) {
    const r = await sequenceDialog(files[0]);
    if (r === null) return { rest, media };
    if (r.sequence) { media.push(...(await footage([files[0].path], r))); return { rest, media }; }
  }
  rest.push(...files.map((d) => d.path));
  return { rest, media };
}

/** The import options of a numbered file: Secuencia PNG / Forzar orden alfabético (remembered, like AE). */
function sequenceDialog(d: Detect): Promise<{ sequence: boolean; alphabetical: boolean } | null> {
  return new Promise((done) => {
    void api.invoke('import:prefs').then((p: Prefs) => {
      const seq = chk(p.sequence, 'imp-seq'), alpha = chk(p.alphabetical, 'imp-alpha');
      let answered = false;
      const finish = (v: { sequence: boolean; alphabetical: boolean } | null) => { if (answered) return; answered = true; m.close(); done(v); };
      const m = modal('Importar archivo', [
        row('Archivo', h('span', {}, d.path.split(/[\\/]/).pop()!)),
        row('Formato:', h('span', {}, d.format)),
        row('Importar como:', h('select', { disabled: true }, h('option', {}, 'Material de archivo'))),
        row('Opciones de secuencia:', h('label', {}, seq, ` Secuencia ${d.format}`), '  ', h('label', {}, alpha, ' Forzar orden alfabético')),
        h('div', { class: 'hint', dataset: { test: 'imp-seq-info' } }, `${d.sequence!.name}: ${d.sequence!.frames} fotogramas${d.sequence!.missing ? `, faltan ${d.sequence!.missing}` : ''}.`),
      ], [
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar'),
        h('button', { class: 'btn primary', dataset: { test: 'imp-ok' }, onclick: () => { void api.invoke('import:prefs', { sequence: seq.checked, alphabetical: alpha.checked }); finish({ sequence: seq.checked, alphabetical: alpha.checked }); } }, 'Importar'),
      ], { width: 560 });
      // closing with the × or Esc cancels
      new MutationObserver((_, ob) => { if (!m.box.isConnected) { ob.disconnect(); finish(null); } }).observe(document.getElementById('modal-root')!, { childList: true, subtree: true });
    });
  });
}

/** Archivo ▸ Importar ▸ Archivo… (Ctrl+Alt+I): any file, with the sequence option. */
export async function importFileCommand(onMedia?: (r: Routed) => Promise<void>) {
  const paths: string[] = await api.invoke('dialog:media', false);
  if (!paths?.length) return;
  const r = await routeImport(paths, true);
  if (onMedia) await onMedia(r);
  else if (r.rest.length) await op('importMedia', r.rest);
}

// ───────────────────────── Interpretar material de archivo ─────────────────────────
type Info = { name: string; format: string; still: boolean; hasAlpha: boolean; nativeFps: number; sequence?: unknown; interpret: { fps?: number; alpha?: 'straight' | 'premultiplied' | 'ignore'; matte?: string; invertAlpha?: boolean; loop?: number }; notes?: string[] };
export async function interpretDialog(mediaId: string) {
  let f: Info;
  try { f = await api.invoke('import:describe', mediaId); } catch (e) { toast(cleanErr(e), true); return; }
  const m = store.project.media.find((x) => x.id === mediaId);
  const radio = (name: string, value: string, on: boolean, test: string) => h('input', { type: 'radio', name, value, checked: on, dataset: { test } }) as HTMLInputElement;
  const a = f.interpret.alpha ?? 'straight';
  const aIgn = radio('alpha', 'ignore', a === 'ignore', 'if-alpha-ignore'), aStr = radio('alpha', 'straight', a === 'straight', 'if-alpha-straight'), aPre = radio('alpha', 'premultiplied', a === 'premultiplied', 'if-alpha-premul');
  const matte = h('input', { type: 'color', value: f.interpret.matte ?? '#000000', dataset: { test: 'if-matte' } }) as HTMLInputElement;
  const inv = chk(!!f.interpret.invertAlpha, 'if-invert');
  const own = radio('fps', 'file', !f.sequence && (!f.interpret.fps || f.interpret.fps === f.nativeFps), 'if-fps-file');
  const conform = radio('fps', 'conform', !own.checked, 'if-fps-conform');
  const fps = h('input', { type: 'number', min: '1', max: '999', step: '0.001', value: String(f.interpret.fps ?? (f.nativeFps || 30)), style: { width: '90px' }, dataset: { test: 'if-fps' } }) as HTMLInputElement;
  fps.oninput = () => { conform.checked = true; };
  if (f.sequence) { own.disabled = true; conform.checked = true; }
  const loop = h('input', { type: 'number', min: '1', max: '9999', step: '1', value: String(f.interpret.loop ?? 1), style: { width: '70px' }, dataset: { test: 'if-loop' } }) as HTMLInputElement;
  const dlg = modal(`Interpretar material de archivo: ${f.name}`, [
    h('div', { class: 'hint' }, 'Opciones principales'),
    f.hasAlpha ? h('fieldset', { class: 'fgroup' }, h('legend', {}, 'Alfa'),
      h('div', {}, h('label', {}, aIgn, ' Ignorar'), '  ', h('label', {}, inv, ' Invertir alfa')),
      h('div', {}, h('label', {}, aStr, ' Recto - Sin máscara')),
      h('div', {}, h('label', {}, aPre, ' Premultiplicado - Máscara con color: '), matte)) : h('div', { class: 'hint' }, 'Alfa: el material no tiene canal alfa.'),
    !f.still ? h('fieldset', { class: 'fgroup' }, h('legend', {}, 'Velocidad de fotogramas'),
      h('div', {}, h('label', {}, own, ` Usar veloc. fotog. del archivo: ${f.nativeFps ? `(${f.nativeFps} fps)` : ''}`)),
      h('div', {}, h('label', {}, conform, ' Ajustar a la velocidad de fotogramas: '), fps, ' fotogramas por segundo')) : null,
    !f.still ? h('fieldset', { class: 'fgroup' }, h('legend', {}, 'Otras opciones'), h('div', {}, 'Bucle: ', loop, ' Tiempos')) : null,
    h('div', { class: 'hint' }, `${f.format}${m ? ` · ${m.width}×${m.height}${m.duration ? ` · ${m.duration.toFixed(2)} s` : ''}` : ''}`),
    ...(f.notes ?? []).map((n) => h('div', { class: 'hint' }, n)),
  ], [
    h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancelar'),
    h('button', { class: 'btn primary', dataset: { test: 'if-ok' }, onclick: async () => {
      const it: Info['interpret'] = {};
      if (f.hasAlpha) { it.alpha = aIgn.checked ? 'ignore' : aPre.checked ? 'premultiplied' : 'straight'; it.invertAlpha = inv.checked; if (aPre.checked) it.matte = matte.value; }
      if (!f.still) { it.fps = conform.checked ? Number(fps.value) : undefined; it.loop = Math.max(1, Math.round(Number(loop.value) || 1)); }
      dlg.close();
      try { await api.invoke('import:interpret', mediaId, it); toast('Material de archivo interpretado.'); } catch (e) { toast(cleanErr(e), true); }
    } }, 'Aceptar'),
  ], { width: 600 });
}

// ───────────────────────── Premiere Pro & Maya ─────────────────────────
/** Opens a comp the main process just made, once the new state has reached the window. */
async function openCompSoon(id: string) {
  for (let i = 0; i < 50 && !(store.project.comps ?? []).some((c) => c.id === id); i++) await new Promise((r) => setTimeout(r, 100));
  document.dispatchEvent(new CustomEvent('adv:open-comp', { detail: id }));
}
export async function premiereDialog(path?: string) {
  path ??= (await api.invoke('dialog:file', { title: 'Importar proyecto de Adobe Premiere Pro', filters: [{ name: 'Proyecto de Adobe Premiere Pro (*.prproj)', extensions: ['prproj'] }] })) ?? undefined;
  if (!path) return;
  let seqs: { id: string; name: string; width: number; height: number; fps: number; duration: number }[];
  try { seqs = await api.invoke('import:prprojInfo', path); } catch (e) { toast(cleanErr(e), true); return; }
  const sel = h('select', { dataset: { test: 'pr-seq' } }, h('option', { value: '' }, 'Todas las secuencias'), ...seqs.map((s) => h('option', { value: s.id }, `${s.name} (${s.width}×${s.height}, ${s.fps} fps)`))) as HTMLSelectElement;
  const aud = chk(true, 'pr-audio');
  const target = h('select', { dataset: { test: 'pr-target' } }, h('option', { value: 'comps' }, 'Composiciones (modo avanzado)'), h('option', { value: 'timeline' }, 'Línea de tiempo del modo simple')) as HTMLSelectElement;
  target.onchange = () => { if (target.value === 'timeline' && !sel.value && seqs[0]) sel.value = seqs[0].id; };
  await new Promise<void>((done) => {
    const m = modal('Premiere Pro Importer', [
      row('Seleccionar secuencia:', sel),
      row('', h('label', {}, aud, ' Importar audio')),
      row('Importar en:', target),
    ], [
      h('button', { class: 'btn', onclick: () => { m.close(); done(); } }, 'Cancelar'),
      h('button', { class: 'btn primary', dataset: { test: 'pr-ok' }, onclick: async () => {
        m.close();
        try {
          const r: { comps: { id: string; name: string }[]; clips: number; layers: number; warnings: string[] } = await api.invoke('import:prproj', path, { target: target.value, sequence: sel.value || undefined, audio: aud.checked });
          toast(`Ha finalizado la carga del proyecto de Premiere Pro: ${r.comps.length ? `${r.comps.length} composiciones, ${r.layers} capas` : `${r.clips} clips`}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
          if (r.comps[0]) void openCompSoon(r.comps[0].id);
        } catch (e) { toast(cleanErr(e), true); }
        done();
      } }, 'Aceptar'),
    ], { width: 560 });
  });
}
export async function mayaImportUI(path?: string) {
  path ??= (await api.invoke('dialog:file', { title: 'Importar escena Maya', filters: [{ name: 'Escena Maya (*.ma)', extensions: ['ma'] }] })) ?? undefined;
  if (!path) return;
  try {
    const r: { comp: { id: string; name: string }; cameras: number; nulls: number; frames: number; warnings: string[] } = await api.invoke('import:maya', path, {});
    toast(`«${r.comp.name}»: ${r.cameras} cámara${r.cameras === 1 ? '' : 's'}${r.nulls ? ` y ${r.nulls} nulos` : ''}, ${r.frames} fotogramas.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
    void openCompSoon(r.comp.id);
  } catch (e) { toast(cleanErr(e), true); }
}

/** Preferencias ▸ Importar: Material de archivo de secuencias. */
export function importPrefsSection(): Node[] {
  const box = h('div', {});
  void api.invoke('import:prefs').then((p: Prefs) => {
    const fps = h('input', { type: 'number', min: '1', max: '999', step: '0.001', value: String(p.sequenceFps), style: { width: '90px' }, dataset: { test: 'pref-seq-fps' } }) as HTMLInputElement;
    const miss = chk(p.reportMissing, 'pref-seq-missing');
    fps.onchange = () => void api.invoke('import:prefs', { sequenceFps: Math.max(1, Math.min(999, Number(fps.value) || 30)) });
    miss.onchange = () => void api.invoke('import:prefs', { reportMissing: miss.checked });
    box.append(h('div', { class: 'row' }, h('label', {}, 'Material de archivo de secuencias:'), h('div', {}, fps, ' fotogramas por segundo')), h('div', { class: 'row' }, h('label', {}, ''), h('label', {}, miss, ' Informar sobre los fotogramas no encontrados')));
  });
  return [h('h3', { style: { margin: '8px 0 0', color: '#fff' } }, 'Importar'), box];
}

/** Archivo ▸ Interpretar material de archivo ▸ Principal (Ctrl+Alt+G): the footage of the selected layer (advanced
 *  mode) or clip (simple mode); else the last converted footage item. */
export async function interpretSelected() {
  const { adv } = await import('./state');
  const advanced = !!document.querySelector('[data-test=adv-project]');
  let id = advanced ? adv.selected().find((l) => l.mediaId)?.mediaId : store.selected().find((c) => c.mediaId)?.mediaId;
  id ??= [...store.project.media].reverse().find((m) => m.footage && !m.compId)?.id;
  if (!id) { toast('Seleccione una capa o un clip con material de archivo.', true); return; }
  await interpretDialog(id);
}

// the advanced mode's command table (atajos.ts): Ctrl+Alt+I and Ctrl+Alt+G
bindCommands({
  'import-file': () => { document.dispatchEvent(new CustomEvent('cinta:command', { detail: 'import-file' })); },
  'interpret-footage': () => { void interpretSelected(); },
});
