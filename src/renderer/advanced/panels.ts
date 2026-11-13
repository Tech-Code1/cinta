// Side panels of the advanced mode: Project (compositions, media, the simple-mode sequence), Effects & Presets,
// Effect Controls, Character, Align and Preview; dialogs for composition settings, export and precompose.
import { keyedAt } from '../../core/motion/anim';
import { characterExtras } from './texto-ui';
import { axesRows } from './vectores-ui';
import { FX, FX_CATS, fxDef } from '../../core/motion/effects';
import type { Comp, Layer } from '../../core/motion/model';
import type { MediaItem } from '../../core/model';
import { PRESETS, TEMPLATES as TEMPLATE_DEFS } from '../../core/motion/presets';
import { SMART_MASK_DEFAULTS, SPACING } from '../../core/motion/maskinterp';
import { modal } from '../dialogs';
import { contextMenu } from '../player';
import { api, cleanErr, fmtShort, h, op, store, toast } from '../store';
import { addTask } from '../ux';
import { adv, mop, propAt, refreshDiskStatus } from './state';
import { propEditor, specFor } from './widgets';
import { dataRows, importData } from './scripts-ui';
import { warpStabControls } from './warpstab-ui';
import { modelMeta, modelThumb } from './modelos3d-ui';
import { interpretDialog, mayaImportUI, premiereDialog, routeImport } from './importacion-ui';

import { vectorPaintControls } from './particulas-ui';
import { rotoControls } from './roto-ui';
const fmtDur = (s: number) => fmtShort(s) + (s % 1 ? `.${String(Math.round((s % 1) * 100)).padStart(2, '0')}` : '');

// ───────────────────────── project ─────────────────────────
export function projectPanel(el: HTMLElement) {
  const draw = () => {
    const p = store.project;
    el.replaceChildren(
      h('div', { class: 'pbar' },
        h('button', { class: 'btn primary small', dataset: { test: 'adv-new-comp' }, onclick: () => compSettingsDialog(null) }, '+ Composición'),
        h('button', { class: 'btn small', dataset: { test: 'adv-import' }, onclick: (e: MouseEvent) => importMenu(e) }, 'Importar ▸'),
        h('button', { class: 'btn small', title: 'Cola de render: varias composiciones y salidas de una vez', dataset: { test: 'adv-rq' }, onclick: () => renderQueueDialog() }, `Cola${p.renderQueue?.length ? ` (${p.renderQueue.length})` : ''}`),
        h('button', { class: 'btn small', title: 'Composiciones de ejemplo listas para editar', dataset: { test: 'adv-templates' }, onclick: (e: MouseEvent) => templatesMenu(e) }, 'Plantillas ▸')),
      h('div', { class: 'plist', dataset: { test: 'adv-project' } },
        ...(p.comps ?? []).map((c) => item('▦', c.name, `${c.width}×${c.height} · ${c.fps} fps · ${fmtDur(c.duration)}`, { kind: 'comp', id: c.id }, c.id === adv.compId, () => openComp(c.id), (e) => compMenu(e, c))),
        p.clips.length ? item('🎞', 'Secuencia (modo simple)', 'La línea de tiempo del modo simple como capa', { kind: 'sequence', id: 'seq' }, false, () => void addSource({ kind: 'sequence', id: 'seq' })) : null,
        ...p.media.filter((m) => !m.compId && m.kind === 'model').map((m) => item(modelThumb(m), m.path.split(/[\\/]/).pop()!, modelMeta(m), { kind: 'media', id: m.id }, false, () => void addSource({ kind: 'media', id: m.id }))),
        ...p.media.filter((m) => !m.compId && m.kind !== 'model').map((m) => item(m.kind === 'audio' ? '♪' : m.kind === 'image' ? '🖼' : '▶', `${m.proxy?.on ? '▣ ' : ''}${m.footage?.name ?? m.path.split(/[\\/]/).pop()!}`, m.kind === 'image' ? `${m.width}×${m.height}` : `${m.width ? `${m.width}×${m.height} · ` : ''}${fmtDur(m.duration)}`, { kind: 'media', id: m.id }, false, () => void addSource({ kind: 'media', id: m.id }), m.kind === 'audio' ? undefined : (e) => mediaMenu(e, m))),
        ...dataRows(p.dataItems, item),
        !(p.comps ?? []).length && !p.media.length && !p.dataItems?.length ? h('div', { class: 'hint', style: { padding: '12px' } }, 'Cree una composición o importe archivos. Arrastre los elementos al visor o a la línea de tiempo.') : null));
  };
  const item = (icon: string | HTMLElement, name: string, meta: string, payload: object, on: boolean, dbl: () => void, ctx?: (e: MouseEvent) => void) => {
    const it = h('div', { class: `pitem${on ? ' on' : ''}`, draggable: 'true', title: 'Doble clic para abrir o añadir · arrastre a la composición', dataset: { test: 'adv-pitem' } }, h('span', { class: 'ic' }, icon), h('span', { class: 'n' }, name), h('span', { class: 'm' }, meta));
    it.ondblclick = dbl;
    it.ondragstart = (e) => e.dataTransfer!.setData('application/x-cinta-adv', JSON.stringify(payload));
    if (ctx) it.oncontextmenu = ctx;
    return it;
  };
  store.on((why) => { if (why === 'state' || why === 'init' || why === 'undo' || why === 'redo') draw(); });
  adv.on((why) => { if (why === 'comp') draw(); });
  document.addEventListener('adv:open-comp', (e) => { const id = (e as CustomEvent<string>).detail; if ((store.project.comps ?? []).some((c) => c.id === id)) openComp(id); });
  // files dropped from the system: imported into the project (models, footage, EXR)
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathOf(f)).filter(Boolean) as string[];
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    void importFiles(files);
  });
  draw();
}
export function openComp(id: string) {
  adv.compId = id;
  adv.selection.clear();
  adv.keys = [];
  adv.work = null;
  try { localStorage.setItem('cinta.adv.comp', id); } catch { /* private */ }
  const c = adv.comp();
  if (c && adv.time >= c.duration) adv.time = 0;
  adv.emit('comp');
}
/** Import: footage, a layered Photoshop file as a composition, or a Motion Graphics template. */
function importMenu(e: MouseEvent) {
  contextMenu(e, [
    { label: 'Archivos multimedia…', kbd: 'Ctrl+I', fn: async () => {
      const paths: string[] = await api.invoke('dialog:media', false);
      if (paths?.length) await importFiles(paths);
    } },
    { label: 'Modelo 3D (.glb, .gltf, .obj)…', fn: async () => {
      const f: string | null = await api.invoke('dialog:file', { title: 'Importar modelo 3D', filters: [{ name: 'Modelos 3D', extensions: ['glb', 'gltf', 'obj'] }] });
      if (f) await importFiles([f]);
    } },
    { label: 'Datos: JSON, MGJSON, CSV o TSV…', fn: () => void importData() },
    { label: 'Archivo con opciones de secuencia (Secuencia PNG…)…', kbd: 'Ctrl+Alt+I', fn: () => void import('./importacion-ui').then((x) => x.importFileCommand(async (r) => { if (r.rest.length) await importFiles(r.rest); })) },
    { label: 'Proyecto de Adobe Premiere Pro…', fn: () => void premiereDialog() },
    { label: 'Escena Maya (cámaras)…', fn: () => void mayaImportUI() },
    { label: 'Photoshop o Illustrator como composición (capas)…', fn: async () => {
      const f: string | null = await api.invoke('dialog:file', { title: 'Importar como composición', filters: [{ name: 'Photoshop / Illustrator', extensions: ['psd', 'ai', 'pdf'] }] });
      if (!f) return;
      const r = await mop<{ comp: Comp; layers: number; warnings: string[] }>('psdImport', f, {});
      if (!r) return;
      openComp(r.comp.id);
      toast(`«${r.comp.name}»: ${r.layers} capas importadas${r.warnings.length ? ` · ${r.warnings.length} avisos: ${r.warnings.slice(0, 2).join(' ')}` : ''}`);
    } },
    { label: 'OpenEXR con canales (o secuencia)…', fn: async () => {
      const f: string | null = await api.invoke('dialog:file', { title: 'Importar OpenEXR', filters: [{ name: 'OpenEXR', extensions: ['exr'] }] });
      if (!f) return;
      const r = await mop<{ info: { channels: unknown[]; crypto: { name: string }[]; pattern?: string } }>('exrImport', f, {});
      if (r) toast(`EXR importado: ${r.info.channels.length} canales${r.info.crypto.length ? `, Cryptomatte: ${r.info.crypto.map((c) => c.name).join(', ')}` : ''}${r.info.pattern ? ' (secuencia)' : ''}. Use los efectos de «Canal 3D».`);
    } },
    { label: 'Plantilla de animación (.cintaplantilla)…', fn: async () => {
      const f: string | null = await api.invoke('dialog:file', { title: 'Importar plantilla de animación', filters: [{ name: 'Plantilla de Cinta', extensions: ['cintaplantilla'] }] });
      if (!f) return;
      const c = await mop<Comp>('templateImport', f);
      if (c) openComp(c.id);
    } },
  ]);
}
/** Imports files into the project: OpenEXR keeps its channels through the EXR importer (the canvas engine cannot
 *  show .exr itself); 3D models and footage through importMedia. */
export async function importFiles(paths: string[]) {
  paths = (await routeImport(paths, false)).rest;
  const exrs = paths.filter((p) => /\.exr$/i.test(p)), rest = paths.filter((p) => !/\.exr$/i.test(p));
  if (rest.length) await op('importMedia', rest);
  for (const f of exrs) await mop('exrImport', f, {});
}
/** Proxies of a footage item (After Effects: Create Proxy / Set Proxy). */
function mediaMenu(e: MouseEvent, m: MediaItem) {
  contextMenu(e, [
    { label: 'Interpretar material de archivo…', kbd: 'Ctrl+Alt+G', fn: () => void interpretDialog(m.id) }, { sep: true },
    ...(m.proxy ? [{ label: m.proxy.on ? '✓ Usar proxy' : 'Usar proxy', fn: () => void mop('mediaProxySet', m.id, { on: !m.proxy!.on }) }, { label: 'Quitar proxy', fn: () => void mop('mediaProxySet', m.id, { remove: true }) }, { sep: true }] : []),
    { label: 'Crear proxy (mitad)', fn: () => void createProxy('media', m.id, 0.5) },
    { label: 'Crear proxy (cuarto)', fn: () => void createProxy('media', m.id, 0.25) },
    { label: 'Usar otro archivo como proxy…', fn: async () => { const f: string | null = await api.invoke('dialog:file', { title: 'Elegir proxy', filters: [{ name: 'Vídeo o imagen', extensions: ['mp4', 'mov', 'webm', 'png', 'jpg', 'jpeg'] }] }); if (f) void mop('mediaProxySet', m.id, { path: f, on: true }); } },
  ]);
}
async function createProxy(kind: 'media' | 'comp', id: string, scale: number) {
  try { await api.invoke('motion:proxyCreate', kind, id, scale); toast('Proxy creado y activado.'); } catch (err) { toast(cleanErr(err), true); }
}

// ───────────────────────── smart mask interpolation ─────────────────────────
/** After Effects' Smart Mask Interpolation panel: options with its defaults, applied between the selected keys. */
export function smartMaskDialog(c: Comp, l: Layer, maskId: string, from: number, to: number) {
  const D = SMART_MASK_DEFAULTS;
  const num = (v: number, min: number, max: number, step = 1, test?: string) => h('input', { type: 'number', value: String(v), min: String(min), max: String(max), step: String(step), style: { width: '80px' }, dataset: test ? { test } : {} }) as HTMLInputElement;
  const chk = (v: boolean, test?: string) => h('input', { type: 'checkbox', checked: v, dataset: test ? { test } : {} }) as HTMLInputElement;
  const rate = h('select', {}, ...[['auto', 'Auto'], ['15', '15'], ['24', '24'], ['25', '25'], ['30', '30'], ['60', '60']].map(([v, n]) => h('option', { value: v }, n))) as HTMLSelectElement;
  const fields = chk(D.fields), linear = chk(D.linear, 'smi-linear');
  const bending = num(D.bending, 0, 100), quality = num(D.quality, 0, 100);
  const add = chk(!!D.addVertices), mode = h('select', {}, h('option', { value: 'pixels' }, 'Píxeles entre vértices'), h('option', { value: 'total' }, 'Vértices totales'), h('option', { value: 'percent' }, 'Porcentaje del contorno')) as HTMLSelectElement;
  const spacing = num(SPACING.pixels.def, SPACING.pixels.min, SPACING.pixels.max);
  mode.onchange = () => { const r = SPACING[mode.value as keyof typeof SPACING]; spacing.min = String(r.min); spacing.max = String(r.max); spacing.step = mode.value === 'percent' ? '0.01' : '1'; spacing.value = String(r.def); };
  const matching = h('select', {}, h('option', { value: 'auto' }, 'Auto'), h('option', { value: 'curve' }, 'Curva'), h('option', { value: 'polyline' }, 'Polilínea')) as HTMLSelectElement;
  const oneToOne = chk(D.oneToOne), firstMatch = chk(D.firstMatch);
  const row = (label: string, ...kids: (Node | string)[]) => h('div', { class: 'frow' }, h('label', {}, label), h('div', { class: 'fval' }, ...kids));
  const m = modal('Interpolación inteligente de máscaras', [
    row('Velocidad de fotogramas clave', rate, ' por segundo'),
    row('', h('label', { title: 'Usa el doble de la velocidad indicada.' }, fields, ' Campos de fotograma clave (duplica la velocidad)')),
    row('', h('label', { title: 'Si no está marcada, los vértices pueden viajar por trayectorias curvas: déjela sin marcar si la interpolación incluye partes que giran.' }, linear, ' Usar trayectorias de vértices lineales')),
    row('Resistencia a la flexión', bending),
    row('Calidad', quality, h('span', { class: 'hint' }, ' 0: primero con primero… 100: cualquier par')),
    row('', h('label', { title: 'Suele ayudar añadir vértices hasta que los trazados sean densos.' }, add, ' Añadir vértices de trazado de máscara'), ' ', spacing, ' ', mode),
    row('Método de coincidencia', matching),
    row('', h('label', {}, oneToOne, ' Usar coincidencias de vértices 1:1')),
    row('', h('label', { title: 'Desmárquela si los primeros vértices no se corresponden: se buscará la mejor coincidencia (lento).' }, firstMatch, ' Coincidencia de primeros vértices')),
  ], [
    h('button', { class: 'btn primary', dataset: { test: 'smi-apply' }, onclick: async () => {
      m.close();
      const r = await mop<{ keys: number }>('maskInterpolate', c.id, l.id, maskId, {
        from, to, rate: rate.value === 'auto' ? null : Number(rate.value), fields: fields.checked, linear: linear.checked,
        bending: Number(bending.value), quality: Number(quality.value), addVertices: add.checked ? { mode: mode.value, value: Number(spacing.value) } : false,
        matching: matching.value, oneToOne: oneToOne.checked, firstMatch: firstMatch.checked,
      });
      if (r) toast(`Se añadieron ${r.keys} fotogramas clave de trazado de máscara.`);
    } }, 'Aplicar'),
  ], { width: 600 });
}

// ───────────────────────── disk cache ─────────────────────────
/** After Effects' Cache Work Area in Background: the missing frames are drawn by the hidden render window. */
async function cacheWorkArea(c: Comp) {
  const o = { res: adv.res, mbSamples: Math.min(c.motionBlur.samples, adv.res < 1 ? 8 : c.motionBlur.samples) };
  try {
    const r: { rendered: number; cached: number } = await api.invoke('cache:fill', c.id, o);
    refreshDiskStatus(c.id, o);
    toast(`Caché de disco: ${r.rendered} fotogramas nuevos${r.cached ? `, ${r.cached} ya estaban` : ''}.`);
  } catch (e) { toast(cleanErr(e), true); }
}
const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
/** Disk cache preferences: on / off, size limit, how much it uses, empty it. */
export async function diskCacheDialog() {
  const info: { dir: string; bytes: number; frames: number; on: boolean; maxGB: number } = await api.invoke('cache:info');
  const on = h('input', { type: 'checkbox', checked: info.on, dataset: { test: 'dc-on' } }) as HTMLInputElement;
  const max = h('input', { type: 'number', min: '1', max: '10000', value: String(info.maxGB), style: { width: '90px' }, dataset: { test: 'dc-max' } }) as HTMLInputElement;
  const used = h('span', { dataset: { test: 'dc-used' } }, `${gb(info.bytes)} en ${info.frames} fotogramas`);
  const row = (label: string, ...kids: (Node | string)[]) => h('div', { class: 'frow' }, h('label', {}, label), h('div', { class: 'fval' }, ...kids));
  const m = modal('Caché de disco', [
    row('Activar', on, ' guardar en disco los fotogramas de la vista previa'),
    row('Tamaño máximo', max, ' GB (se borran primero los menos usados)'),
    row('En uso', used),
    row('Carpeta', h('span', { class: 'hint' }, info.dir)),
    h('div', { class: 'hint' }, 'Los fotogramas se reutilizan entre sesiones y al deshacer; cualquier cambio en la composición, sus composiciones anidadas o sus archivos los vuelve a dibujar.'),
  ], [
    h('button', { class: 'btn', dataset: { test: 'dc-clear' }, onclick: async () => { const n: number = await api.invoke('cache:clear'); used.textContent = '0 MB en 0 fotogramas'; const c = adv.comp(); if (c) refreshDiskStatus(c.id, { res: adv.res, mbSamples: Math.min(c.motionBlur.samples, adv.res < 1 ? 8 : c.motionBlur.samples) }); toast(`Caché de disco vaciada (${n} fotogramas).`); } }, 'Vaciar caché de disco'),
    h('button', { class: 'btn primary', onclick: async () => { await api.invoke('cache:settings', { on: on.checked, maxGB: Number(max.value) || 10 }); m.close(); } }, 'Aceptar'),
  ], { width: 560 });
}

// ───────────────────────── render queue ─────────────────────────
const FORMATS: [string, string][] = [['mp4', 'MP4 (H.264)'], ['mp4-hevc', 'MP4 (H.265)'], ['mov-alpha', 'MOV ProRes 4444 (alfa)'], ['mov', 'MOV ProRes 422 HQ'], ['webm-alpha', 'WebM VP9 (alfa)'], ['gif', 'GIF animado'], ['png', 'Secuencia PNG']];
/** After Effects' Render Queue panel: items with Render Settings and Output Modules, rendered in order. */
export function renderQueueDialog() {
  const list = h('div', { class: 'rq', dataset: { test: 'rq-list' } });
  const sel = (value: string, opts: [string, string][], onchange: (v: string) => void, test?: string) => { const s = h('select', { dataset: test ? { test } : {} }, ...opts.map(([v, n]) => h('option', { value: v, selected: v === value }, n))) as HTMLSelectElement; s.onchange = () => onchange(s.value); return s; };
  const draw = () => {
    if (!list.isConnected && drawn) { off(); return; }
    drawn = true;
    const q = store.project.renderQueue ?? [];
    list.replaceChildren(...(q.length ? q.map((it, i) => {
      const c = store.project.comps?.find((x) => x.id === it.compId);
      const s = it.settings;
      const set = (patch: Record<string, unknown>) => void mop('queueSet', it.id, patch);
      const on = h('input', { type: 'checkbox', checked: it.status === 'queued', title: 'Renderizar', disabled: it.status === 'rendering' }) as HTMLInputElement;
      on.onchange = () => set({ status: on.checked ? 'queued' : 'unqueued' });
      const status = ({ queued: 'En cola', unqueued: 'Fuera de cola', rendering: 'Renderizando…', done: 'Terminado', failed: 'Error', stopped: 'Detenido' } as Record<string, string>)[it.status];
      const span = Array.isArray(s.span) ? 'custom' : s.span;
      return h('div', { class: 'rq-item' },
        h('div', { class: 'rq-head' }, on, h('b', {}, `${i + 1}. ${c?.name ?? '(eliminada)'}`), h('span', { class: `rq-st ${it.status}`, title: it.log?.error ?? it.log?.files.join('\n') ?? '' }, status + (it.log && it.status === 'done' ? ` (${it.log.seconds.toFixed(1)} s)` : '')),
          h('button', { class: 'mini', title: 'Quitar de la cola', onclick: () => void mop('queueRemove', [it.id]) }, '✕')),
        h('div', { class: 'rq-set' }, 'Ajustes de render: ',
          sel(String(s.resolution), [['1', 'Completa'], ['0.5', 'Mitad'], ['0.3333', 'Tercio'], ['0.25', 'Cuarto'], ...(![1, 0.5, 0.3333, 0.25].includes(s.resolution) ? [[String(s.resolution), `×${s.resolution}`] as [string, string]] : [])], (v) => set({ settings: { resolution: Number(v) } })),
          sel(span, [['workArea', 'Área de trabajo'], ['comp', 'Duración completa'], ...(span === 'custom' ? [['custom', `${(s.span as number[])[0]}–${(s.span as number[])[1]} s`] as [string, string]] : [])], (v) => { if (v !== 'custom') set({ settings: { span: v } }); }),
          sel(s.proxies, [['none', 'Sin proxies'], ['current', 'Proxies activos'], ['all', 'Todos los proxies'], ['comps', 'Solo proxies de composición']], (v) => set({ settings: { proxies: v } })),
          sel(s.motionBlur, [['comp', 'Desenfoque de movimiento: según capas'], ['off', 'Sin desenfoque de movimiento']], (v) => set({ settings: { motionBlur: v } })),
          sel(s.quality, [['best', 'Óptima'], ['draft', 'Borrador']], (v) => set({ settings: { quality: v } }))),
        ...it.outputs.map((om) => {
          const path = h('input', { value: om.path, style: { flex: '1' }, title: 'Plantillas: [compName] [projectName] [width] [height] [frameRate] [fileExtension] [date]; relativa a la carpeta del proyecto' }) as HTMLInputElement;
          const upd = (patch: Record<string, unknown>) => set({ outputs: it.outputs.map((x) => (x.id === om.id ? { ...x, ...patch } : x)) });
          path.onchange = () => upd({ path: path.value.trim() || '[compName].[fileExtension]' });
          const audio = h('input', { type: 'checkbox', checked: om.audio, title: 'Incluir audio' }) as HTMLInputElement;
          audio.onchange = () => upd({ audio: audio.checked });
          return h('div', { class: 'rq-out' }, 'Salida: ', sel(om.format, FORMATS, (v) => upd({ format: v })), path, h('label', {}, audio, 'Audio'),
            it.outputs.length > 1 ? h('button', { class: 'mini', title: 'Quitar salida', onclick: () => set({ removeOutput: om.id }) }, '✕') : null);
        }),
        h('button', { class: 'btn small', onclick: () => set({ addOutput: {} }) }, '+ Salida'));
    }) : [h('div', { class: 'hint' }, 'La cola está vacía. Añada composiciones con el menú de cada composición («Añadir a la cola de render»).')]));
  };
  let drawn = false;
  draw();
  const off = store.on((why) => { if (why === 'state' || why === 'undo' || why === 'redo') draw(); });
  modal('Cola de render', [list], [
    h('button', { class: 'btn', onclick: () => void mop('queueRemove', 'done') }, 'Quitar terminados'),
    h('button', { class: 'btn primary', dataset: { test: 'rq-render' }, onclick: () => void runQueue() }, 'Renderizar'),
  ], { width: 760 });
}
async function runQueue() {
  if (!(store.project.renderQueue ?? []).some((x) => x.status === 'queued')) return toast('No hay elementos en cola.', true);
  const task = addTask('Cola de render', () => void api.invoke('motion:cancel'));
  const off = api.on('export:progress', (f: number) => task.progress(f));
  try {
    const r: { status: string; log: { files: string[] } }[] = await api.invoke('motion:queueRender');
    const ok = r.filter((x) => x.status === 'done').length;
    task.done(`${ok} de ${r.length} elementos renderizados`, r.find((x) => x.log.files.length) ? [{ label: 'Mostrar en la carpeta', fn: () => void api.invoke('shell:show', r.find((x) => x.log.files.length)!.log.files[0]) }] : []);
    if (ok < r.length) toast(`${r.length - ok} elementos fallaron: vea la cola de render.`, true);
  } catch (e) { task.fail(cleanErr(e)); toast(cleanErr(e), true); } finally { off(); }
}

function compMenu(e: MouseEvent, c: Comp) {
  contextMenu(e, [
    { label: 'Abrir', fn: () => openComp(c.id) },
    { label: 'Configuración de composición…', kbd: 'Ctrl+K', fn: () => compSettingsDialog(c) },
    { label: 'Exportar composición…', kbd: 'Ctrl+M', fn: () => exportCompDialog(c) },
    { label: 'Almacenar en caché el área de trabajo en segundo plano', fn: () => void cacheWorkArea(c) },
    { label: 'Caché de disco…', fn: () => void diskCacheDialog() },
    { label: 'Añadir a la cola de render', fn: () => void mop('queueAdd', c.id, { outputs: [{ format: c.transparent ? 'mov-alpha' : 'mp4' }] }).then(() => renderQueueDialog()) },
    ...(c.proxy ? [{ label: c.proxy.on ? '✓ Usar proxy de composición' : 'Usar proxy de composición', fn: () => void mop('compProxySet', c.id, { on: !c.proxy!.on }) }, { label: 'Quitar proxy', fn: () => void mop('compProxySet', c.id, { remove: true }) }] : []),
    { label: c.proxy ? 'Volver a crear el proxy' : 'Crear proxy (prerenderizar)', fn: () => void createProxy('comp', c.id, 1) },
    { label: 'Añadir a la línea de tiempo del modo simple', fn: () => void toTimeline(c) },
    { label: 'Exportar a Lottie (.json)…', fn: async () => {
      const f: string | null = await api.invoke('dialog:save', { title: 'Exportar a Lottie', defaultPath: `${c.name}.json`, filters: [{ name: 'Lottie', extensions: ['json'] }] });
      if (!f) return;
      const r = await mop<{ file: string; warnings: string[] }>('lottieExport', c.id, f);
      if (r) toast(`Lottie exportado: ${r.file}${r.warnings.length ? ` · ${r.warnings.length} avisos: ${r.warnings.slice(0, 2).join(' ')}` : ''}`);
    } },
    { label: 'Exportar como plantilla de animación…', disabled: !c.essential?.length, fn: async () => {
      const f: string | null = await api.invoke('dialog:save', { title: 'Exportar plantilla de animación', defaultPath: `${c.name}.cintaplantilla`, filters: [{ name: 'Plantilla de Cinta', extensions: ['cintaplantilla'] }] });
      if (f && await mop('templateExport', c.id, f)) toast(`Plantilla exportada: ${f}`);
    } },
    { sep: true },
    { label: 'Duplicar', fn: () => void mop<Comp>('compDuplicate', c.id) },
    { label: 'Eliminar', fn: () => void mop('compDelete', c.id).then(() => { if (adv.compId === c.id) { adv.compId = store.project.comps?.[0]?.id ?? null; adv.emit('comp'); } }) },
  ]);
}
async function toTimeline(c: Comp) {
  try {
    await api.invoke('motion:toTimeline', c.id);
    toast(`«${c.name}» está en la línea de tiempo del modo simple.`);
  } catch (e) { toast(cleanErr(e), true); }
}
/** Adds a media item, a composition or the simple-mode sequence as a layer of the open composition. */
export async function addSource(src: { kind: string; id: string }, at?: [number, number]) {
  const c = adv.comp();
  if (!c) { toast('Abra o cree primero una composición.', true); return; }
  let l: Layer | undefined;
  const pos = at ? { position: at } : {};
  if (src.kind === 'media') {
    const m = store.project.media.find((x) => x.id === src.id);
    if (!m) return;
    l = await mop<Layer>('layerAdd', c.id, m.kind === 'model' ? 'model' : m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video', { mediaId: m.id, start: adv.time, ...pos });
  } else if (src.kind === 'comp') {
    if (src.id === c.id) return toast('Una composición no puede contenerse a sí misma.', true);
    l = await mop<Layer>('layerAdd', c.id, 'comp', { compId: src.id, start: adv.time, ...pos });
  } else if (src.kind === 'sequence') l = await mop<Layer>('layerAdd', c.id, 'sequence', pos);
  else if (src.kind === 'fx') { const ids = [...adv.selection]; if (!ids.length) return toast('Seleccione la capa a la que aplicar el efecto.', true); for (const id of ids) await mop('effectAdd', c.id, id, src.id); return; }
  else if (src.kind === 'preset') { await applyPreset(src.id); return; }
  if (l) adv.select([l.id]);
}
export async function applyPreset(id: string) {
  const c = adv.comp();
  if (!c) return;
  const def = PRESETS.find((p) => p.id === id);
  if (!def) return;
  const ids = def.makesLayer ? [] : [...adv.selection];
  if (!def.makesLayer && !ids.length) return toast(`Seleccione la capa a la que aplicar «${def.name}».`, true);
  const r = await mop<string[]>('presetApply', c.id, id, ids, def.makesLayer ? { at: adv.time } : def.out ? {} : {});
  if (r?.length) { adv.select(r); toast(`«${def.name}» aplicado.`); }
}

// ───────────────────────── effects & presets ─────────────────────────
export function effectsPanel(el: HTMLElement) {
  const q = h('input', { placeholder: 'Buscar efectos y ajustes preestablecidos…', class: 'search', dataset: { test: 'adv-fx-search' } }) as HTMLInputElement;
  const list = h('div', { class: 'fxlist', dataset: { test: 'adv-fx-list' } });
  const closed = new Set<string>(['Comportamientos', 'Texto', 'Transiciones', 'Fondos', 'Cámara', ...FX_CATS]);
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const groups: [string, { id: string; name: string; kind: 'fx' | 'preset'; desc?: string }[]][] = [
      ...['Comportamientos', 'Texto', 'Transiciones', 'Fondos', 'Cámara'].map((cat): [string, { id: string; name: string; kind: 'fx' | 'preset'; desc?: string }[]] => [`★ ${cat}`, PRESETS.filter((p) => p.cat === cat).map((p) => ({ id: p.id, name: p.name, kind: 'preset', desc: p.desc }))]),
      ...FX_CATS.map((cat): [string, { id: string; name: string; kind: 'fx' | 'preset' }[]] => [cat, FX.filter((f) => f.cat === cat).map((f) => ({ id: f.id, name: f.name, kind: 'fx' }))]),
    ];
    list.replaceChildren(...groups.flatMap(([cat, items]) => {
      const vis = term ? items.filter((i) => i.name.toLowerCase().includes(term) || cat.toLowerCase().includes(term)) : items;
      if (!vis.length) return [];
      const isOpen = !!term || !closed.has(cat.replace('★ ', ''));
      const head = h('div', { class: 'fxcat', onclick: () => { const k = cat.replace('★ ', ''); if (closed.has(k)) closed.delete(k); else closed.add(k); draw(); } }, h('span', { class: `tw${isOpen ? ' open' : ''}` }, '▸'), cat);
      return [head, ...(isOpen ? vis.map((i) => {
        const it = h('div', { class: `fxitem ${i.kind}`, draggable: 'true', title: `${i.desc ?? ''}${i.desc ? '\n' : ''}Doble clic: aplicar a la capa seleccionada · o arrastre a una capa`, dataset: { test: `adv-${i.kind}-${i.id}` } }, i.name);
        it.ondblclick = () => void addSource({ kind: i.kind, id: i.id });
        it.ondragstart = (e) => e.dataTransfer!.setData('application/x-cinta-adv', JSON.stringify({ kind: i.kind, id: i.id }));
        return it;
      }) : [])];
    }));
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => e.stopPropagation());
  el.replaceChildren(q, list);
  draw();
}

// ───────────────────────── effect controls ─────────────────────────
export function controlsPanel(el: HTMLElement) {
  const draw = () => {
    if (adv.work) return;
    const c = adv.comp();
    const l = adv.first();
    if (!c || !l) { el.replaceChildren(h('div', { class: 'hint pad' }, 'Seleccione una capa para ver sus efectos.')); return; }
    if (!l.effects.length) { el.replaceChildren(h('div', { class: 'pad' }, h('div', { class: 'ctl-title' }, l.name), h('div', { class: 'hint' }, 'Sin efectos. Haga doble clic en uno del panel «Efectos y ajustes preestablecidos».'))); return; }
    el.replaceChildren(h('div', { class: 'ctl-title' }, l.name), ...l.effects.map((f, i) => {
      let def; try { def = fxDef(f.fx); } catch { def = undefined; }
      const on = h('input', { type: 'checkbox', checked: f.on, title: 'Activar o desactivar el efecto' }) as HTMLInputElement;
      on.onchange = () => void mop('effectSet', c.id, l.id, f.id, { on: on.checked });
      return h('div', { class: 'fxbox', dataset: { test: `fxbox-${f.fx}` } },
        h('div', { class: 'fxhead' }, on, h('b', {}, f.name),
          h('button', { class: 'mini', title: 'Subir', disabled: i === 0, onclick: () => void mop('effectSet', c.id, l.id, f.id, { index: i }) }, '↑'),
          h('button', { class: 'mini', title: 'Bajar', disabled: i === l.effects.length - 1, onclick: () => void mop('effectSet', c.id, l.id, f.id, { index: i + 2 }) }, '↓'),
          h('button', { class: 'mini', title: 'Restablecer', onclick: () => void resetFx(c, l, f.id) }, '↺'),
          h('button', { class: 'mini', title: 'Quitar', onclick: () => void mop('effectRemove', c.id, l.id, f.id) }, '✕')),
        ...(def?.params ?? []).map((pd) => {
          const path = `effects.${f.id}.${pd.id}`;
          const p = propAt(l, path);
          return h('div', { class: 'fxrow' },
            h('button', { class: `sw${p?.k?.length ? ' on' : ''}`, title: 'Cronómetro', onclick: () => void (p?.k?.length ? mop('keyframeRemove', c.id, l.id, path, 'all') : mop('propSet', c.id, l.id, path, { value: keyedAt(p!, adv.time), t: adv.time })) }, '⏱'),
            h('span', { class: 'nm' }, pd.name),
            propEditor(l.id, path, specFor(pd.def, pd), pd.name));
        }), f.fx === 'warpStabilizer' ? warpStabControls(c, l, f) : null, f.fx === 'vectorPaint' ? vectorPaintControls(c, l, f) : null, f.fx === 'rotoBrush' ? rotoControls(c, l, f) : null);
    }));
  };
  adv.on((why) => { if (why === 'comp' || why === 'select') draw(); if (why === 'time' && !adv.playing) draw(); });
  draw();
}
async function resetFx(c: Comp, l: Layer, fid: string) {
  const f = l.effects.find((x) => x.id === fid);
  if (!f) return;
  const def = fxDef(f.fx);
  const w = adv.begin()!;
  const wf = w.layers.find((x) => x.id === l.id)!.effects.find((x) => x.id === fid)!;
  const sz = l.solid ? [l.solid.width, l.solid.height] : [c.width, c.height];
  for (const p of def.params) wf.params[p.id] = { v: p.type === 'point' && p.rel && Array.isArray(p.def) ? [p.def[0] * sz[0], p.def[1] * sz[1]] : p.def };
  await adv.commit('Restablecer efecto');
}

// ───────────────────────── character ─────────────────────────
const FONTS = ['Segoe UI', 'Segoe UI Black', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Segoe Print', 'Segoe Script', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
export function characterPanel(el: HTMLElement) {
  const draw = () => {
    if (adv.work) return;
    const c = adv.comp();
    const l = adv.first();
    if (!c || !l?.text) { el.replaceChildren(h('div', { class: 'hint pad' }, 'Seleccione una capa de texto.')); return; }
    const t = l.text;
    const set = (patch: object) => void mop('layerSet', c.id, l.id, { text: patch });
    const font = h('select', { dataset: { test: 'char-font' } }, ...[...new Set([t.font, ...FONTS])].map((f) => h('option', { value: f, selected: f === t.font, style: { fontFamily: f } }, f))) as HTMLSelectElement;
    font.onchange = () => set({ font: font.value });
    const weight = h('select', {}, ...[[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']].map(([v, n]) => h('option', { value: String(v), selected: t.weight === v }, String(n)))) as HTMLSelectElement;
    weight.onchange = () => set({ weight: Number(weight.value) });
    const ital = h('input', { type: 'checkbox', checked: t.italic }) as HTMLInputElement;
    ital.onchange = () => set({ italic: ital.checked });
    const caps = h('input', { type: 'checkbox', checked: t.allCaps }) as HTMLInputElement;
    caps.onchange = () => set({ allCaps: caps.checked });
    const al = (a: 'left' | 'center' | 'right', icon: string) => h('button', { class: `tb${t.align === a ? ' on' : ''}`, title: { left: 'Alinear a la izquierda', center: 'Centrar', right: 'Alinear a la derecha' }[a], onclick: () => set({ align: a }) }, icon);
    const leading = h('input', { type: 'number', value: String(t.leading || ''), placeholder: 'Auto', style: { width: '70px' } }) as HTMLInputElement;
    leading.onchange = () => set({ leading: Number(leading.value) || 0 });
    leading.onkeydown = (e) => e.stopPropagation();
    const row = (label: string, ...kids: Node[]) => h('div', { class: 'crow' }, h('span', { class: 'nm' }, label), ...kids);
    el.replaceChildren(h('div', { class: 'pad' },
      row('Fuente', font), row('Estilo', weight, h('label', {}, ital, ' Cursiva')),
      row('Tamaño', propEditor(l.id, 'text.size', { type: 'number', unit: ' px', min: 1 }, 'tamaño')),
      row('Relleno', propEditor(l.id, 'text.fill', { type: 'color' }, 'relleno')),
      row('Trazo', propEditor(l.id, 'text.stroke', { type: 'color' }, 'trazo'), propEditor(l.id, 'text.strokeWidth', { type: 'number', unit: ' px', min: 0 }, 'anchura de trazo')),
      row('Interletraje', propEditor(l.id, 'text.tracking', { type: 'number' }, 'interletraje')),
      row('Interlineado', leading),
      row('Alineación', al('left', '⯇'), al('center', '≡'), al('right', '⯈')),
      row('Mayúsculas', h('label', {}, caps, ' Todo en mayúsculas')), axesRows(c, l), characterExtras(c, l)));
  };
  adv.on((why) => { if (why === 'comp' || why === 'select') draw(); });
  draw();
}

// ───────────────────────── align ─────────────────────────
export function alignPanel(el: HTMLElement) {
  const go = async (mode: string) => {
    const c = adv.comp();
    const sel = adv.selected();
    if (!c || !sel.length) return toast('Seleccione las capas que quiere alinear.', true);
    const w = adv.begin()!;
    const { renderer } = await import('./viewer');
    const boxes = sel.map((l) => { const q = renderer.boxes.get(l.id); if (!q) return null; const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]); return { l, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; }).filter((b): b is NonNullable<typeof b> => !!b);
    const sorted = (k: 'x' | 'y') => [...boxes].sort((a, b) => (k === 'x' ? a.x0 + a.x1 - b.x0 - b.x1 : a.y0 + a.y1 - b.y0 - b.y1));
    boxes.forEach((b, i) => {
      let dx = 0, dy = 0;
      if (mode === 'left') dx = -b.x0;
      if (mode === 'hcenter') dx = c.width / 2 - (b.x0 + b.x1) / 2;
      if (mode === 'right') dx = c.width - b.x1;
      if (mode === 'top') dy = -b.y0;
      if (mode === 'vcenter') dy = c.height / 2 - (b.y0 + b.y1) / 2;
      if (mode === 'bottom') dy = c.height - b.y1;
      if (mode === 'hdist' && boxes.length > 2) { const s = sorted('x'); const a = (s[0].x0 + s[0].x1) / 2, z = (s[s.length - 1].x0 + s[s.length - 1].x1) / 2; const j = s.indexOf(b); dx = a + ((z - a) * j) / (s.length - 1) - (b.x0 + b.x1) / 2; }
      if (mode === 'vdist' && boxes.length > 2) { const s = sorted('y'); const a = (s[0].y0 + s[0].y1) / 2, z = (s[s.length - 1].y0 + s[s.length - 1].y1) / 2; const j = s.indexOf(b); dy = a + ((z - a) * j) / (s.length - 1) - (b.y0 + b.y1) / 2; }
      void i;
      const wl = w.layers.find((x) => x.id === b.l.id)!;
      const p = propAt(wl, 'transform.position')!;
      const v = keyedAt(p, adv.time, true) as number[];
      const nv = [v[0] + dx, v[1] + dy, v[2] ?? 0];
      if (p.k?.length) { const k = p.k.find((x) => Math.abs(x.t - adv.time) < 1e-4); if (k) k.v = nv; else { p.k.push({ t: adv.time, v: nv }); p.k.sort((a, b2) => a.t - b2.t); } } else p.v = nv;
    });
    await adv.commit('Alinear capas');
  };
  const b = (mode: string, icon: string, title: string) => h('button', { class: 'tb', title, dataset: { test: `align-${mode}` }, onclick: () => void go(mode) }, icon);
  el.replaceChildren(h('div', { class: 'pad' },
    h('div', { class: 'hint' }, 'Alinear las capas seleccionadas a la composición:'),
    h('div', { class: 'brow' }, b('left', '⇤', 'Izquierda'), b('hcenter', '↔', 'Centro horizontal'), b('right', '⇥', 'Derecha'), b('top', '⤒', 'Arriba'), b('vcenter', '↕', 'Centro vertical'), b('bottom', '⤓', 'Abajo')),
    h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Distribuir (3 capas o más):'),
    h('div', { class: 'brow' }, b('hdist', '⋯', 'Distribuir horizontalmente'), b('vdist', '⋮', 'Distribuir verticalmente'))));
}

// ───────────────────────── dialogs ─────────────────────────
const SIZES: [string, number, number][] = [['HD 1080p (1920×1080)', 1920, 1080], ['4K UHD (3840×2160)', 3840, 2160], ['HD 720p (1280×720)', 1280, 720], ['Vertical 9:16 (1080×1920)', 1080, 1920], ['Cuadrado 1:1 (1080×1080)', 1080, 1080], ['Instagram 4:5 (1080×1350)', 1080, 1350]];
export function compSettingsDialog(c: Comp | null) {
  const s = store.project.settings;
  const name = h('input', { value: c?.name ?? `Composición ${(store.project.comps?.length ?? 0) + 1}`, dataset: { test: 'comp-name' } }) as HTMLInputElement;
  const preset = h('select', {}, h('option', { value: '' }, 'Personalizado'), ...SIZES.map(([n, w, hh]) => h('option', { value: `${w}x${hh}`, selected: (c?.width ?? s.width) === w && (c?.height ?? s.height) === hh }, n))) as HTMLSelectElement;
  const w = h('input', { type: 'number', value: String(c?.width ?? s.width), style: { width: '80px' }, dataset: { test: 'comp-w' } }) as HTMLInputElement;
  const hh = h('input', { type: 'number', value: String(c?.height ?? s.height), style: { width: '80px' }, dataset: { test: 'comp-h' } }) as HTMLInputElement;
  preset.onchange = () => { if (preset.value) { const [a, b] = preset.value.split('x'); w.value = a; hh.value = b; } };
  const fps = h('select', { dataset: { test: 'comp-fps' } }, ...[24, 25, 30, 50, 60].map((f) => h('option', { value: String(f), selected: (c?.fps ?? s.fps) === f }, `${f} fps`))) as HTMLSelectElement;
  const dur = h('input', { type: 'number', step: '0.1', value: String(c?.duration ?? 10), style: { width: '80px' }, dataset: { test: 'comp-dur' } }) as HTMLInputElement;
  const bg = h('input', { type: 'color', value: (c?.bg ?? '#000000').slice(0, 7) }) as HTMLInputElement;
  const transp = h('input', { type: 'checkbox', checked: c?.transparent ?? false }) as HTMLInputElement;
  const mbOn = h('input', { type: 'checkbox', checked: c?.motionBlur.on ?? true }) as HTMLInputElement;
  const shutter = h('input', { type: 'number', value: String(c?.motionBlur.shutter ?? 180), style: { width: '70px' } }) as HTMLInputElement;
  const samples = h('input', { type: 'number', value: String(c?.motionBlur.samples ?? 12), style: { width: '70px' } }) as HTMLInputElement;
  // project colour settings (shared by every comp, like After Effects' Project Settings › Color)
  const mc = store.project.motionColor ?? { depth: 8, blendGamma1: false };
  const bpc = h('select', { dataset: { test: 'proj-bpc' } }, ...[8, 16, 32].map((d) => h('option', { value: String(d), selected: mc.depth === d }, `${d} bits por canal${d === 32 ? ' (flotante)' : ''}`))) as HTMLSelectElement;
  const gamma1 = h('input', { type: 'checkbox', checked: mc.blendGamma1, dataset: { test: 'proj-gamma1' } }) as HTMLInputElement;
  const row = (label: string, ...kids: (Node | string)[]) => h('div', { class: 'frow' }, h('label', {}, label), h('div', { class: 'fval' }, ...kids));
  const m = modal(c ? 'Configuración de composición' : 'Nueva composición', [
    row('Nombre', name), row('Ajuste preestablecido', preset), row('Tamaño', w, ' × ', hh, ' px'), row('Velocidad de fotogramas', fps),
    row('Duración (s)', dur), row('Color de fondo', bg, h('label', { style: { marginLeft: '12px' } }, transp, ' Fondo transparente (exporta con alfa)')),
    row('Desenfoque de movimiento', h('label', {}, mbOn, ' Activado'), ' ángulo ', shutter, '° muestras ', samples),
    row('Color (todo el proyecto)', bpc, h('label', { style: { marginLeft: '12px' }, title: 'Las capas se funden en luz lineal: bordes suaves, resplandores y transparencias se mezclan como la luz' }, gamma1, ' Fundir colores con gamma 1.0')),
  ], [
    h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
    h('button', { class: 'btn primary', dataset: { test: 'comp-ok' }, onclick: async () => {
      const o = { name: name.value.trim() || 'Composición', width: Math.max(16, Number(w.value) || 1920), height: Math.max(16, Number(hh.value) || 1080), fps: Number(fps.value), duration: Math.max(0.1, Number(dur.value) || 10), bg: bg.value, transparent: transp.checked };
      m.close();
      const depth = Number(bpc.value) as 8 | 16 | 32;
      if (depth !== mc.depth || gamma1.checked !== mc.blendGamma1) await mop('colorSettings', { depth, blendGamma1: gamma1.checked });
      if (c) await mop('compSet', c.id, { ...o, motionBlur: { on: mbOn.checked, shutter: Number(shutter.value) || 180, samples: Math.max(2, Math.min(64, Number(samples.value) || 12)) } });
      else { const nc = await mop<Comp>('compNew', o); if (nc) openComp(nc.id); }
    } }, 'Aceptar'),
  ], { width: 560 });
}

export async function exportCompDialog(c: Comp) {
  const dir: string = await api.invoke('export:dir');
  const fmt = h('select', { dataset: { test: 'cexp-format' } }, ...[['mp4', 'MP4 (H.264) — para compartir'], ['mp4-hevc', 'MP4 (H.265/HEVC) — más pequeño'], ['mov-alpha', 'MOV ProRes 4444 — con transparencia'], ['mov', 'MOV ProRes 422 HQ — para editar'], ['webm-alpha', 'WebM VP9 — con transparencia (web)'], ['gif', 'GIF animado'], ['png', 'Secuencia PNG — con transparencia']].map(([v, n]) => h('option', { value: v, selected: v === (c.transparent ? 'mov-alpha' : 'mp4') }, n))) as HTMLSelectElement;
  const ext = () => ({ mp4: 'mp4', 'mp4-hevc': 'mp4', 'mov-alpha': 'mov', mov: 'mov', 'webm-alpha': 'webm', gif: 'gif', png: 'png' } as Record<string, string>)[fmt.value];
  const name = h('input', { value: c.name, dataset: { test: 'cexp-name' } }) as HTMLInputElement;
  const folder = h('input', { value: dir, style: { flex: '1' } }) as HTMLInputElement;
  const range = h('select', {}, h('option', { value: 'work' }, `Área de trabajo (${fmtDur(c.workArea[0])} – ${fmtDur(c.workArea[1])})`), h('option', { value: 'all' }, `Toda la composición (${fmtDur(c.duration)})`)) as HTMLSelectElement;
  const res = h('select', {}, h('option', { value: '1' }, `Completa (${c.width}×${c.height})`), h('option', { value: '0.5' }, `Mitad (${Math.round(c.width / 2)}×${Math.round(c.height / 2)})`), h('option', { value: '2' }, `Doble (${c.width * 2}×${c.height * 2})`)) as HTMLSelectElement;
  const quality = h('select', {}, h('option', { value: 'high' }, 'Alta'), h('option', { value: 'medium' }, 'Media'), h('option', { value: 'low' }, 'Borrador')) as HTMLSelectElement;
  const row = (label: string, ...kids: (Node | string)[]) => h('div', { class: 'frow' }, h('label', {}, label), h('div', { class: 'fval' }, ...kids));
  const m = modal('Exportar composición', [
    row('Formato', fmt), row('Nombre', name), row('Carpeta', folder, h('button', { class: 'btn small', onclick: async () => { const d = await api.invoke('dialog:folder'); if (d) folder.value = d; } }, '…')),
    row('Duración', range), row('Resolución', res), row('Calidad', quality),
  ], [
    h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
    h('button', { class: 'btn primary', dataset: { test: 'cexp-go' }, onclick: () => {
      m.close();
      const out = `${folder.value.replace(/[\\/]$/, '')}\\${(name.value.trim() || c.name).replace(/[<>:"/\\|?*]/g, '_')}.${ext()}`;
      void runCompExport(c, out, { format: fmt.value, scale: Number(res.value), quality: quality.value, ...(range.value === 'all' ? { from: 0, to: c.duration } : {}) });
    } }, 'Exportar'),
  ], { width: 600 });
}
export async function runCompExport(c: Comp, out: string, o: Record<string, unknown>) {
  const task = addTask(`Exportando «${c.name}»`, () => void api.invoke('motion:cancel'));
  const off = api.on('export:progress', (f: number) => task.progress(f));
  try {
    const r = await api.invoke('motion:export', c.id, out, o);
    task.done(`Listo: ${r.frames} fotogramas en ${r.seconds.toFixed(1)} s`, [{ label: 'Mostrar en la carpeta', fn: () => void api.invoke('shell:show', r.path) }]);
    toast(`Composición exportada: ${r.path}`);
    return r;
  } catch (e) {
    task.fail(cleanErr(e));
    toast(cleanErr(e), true);
    return null;
  } finally { off(); }
}

export function precomposeDialog() {
  const c = adv.comp();
  const sel = adv.selected();
  if (!c || !sel.length) return toast('Seleccione las capas que quiere precomponer.', true);
  const name = h('input', { value: `${sel[0].name} Composición 1`, dataset: { test: 'precomp-name' } }) as HTMLInputElement;
  const m = modal('Precomponer', [h('div', { class: 'frow' }, h('label', {}, 'Nombre de la nueva composición'), h('div', { class: 'fval' }, name)), h('div', { class: 'hint' }, `Se moverán ${sel.length} capa(s) a una composición nueva, que ocupará su lugar.`)], [
    h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
    h('button', { class: 'btn primary', dataset: { test: 'precomp-ok' }, onclick: async () => { m.close(); const r = await mop<{ layer: Layer }>('layerPrecompose', c.id, sel.map((l) => l.id), name.value.trim() || undefined); if (r) adv.select([r.layer.id]); } }, 'Aceptar'),
  ], { width: 480 });
}

function templatesMenu(e: MouseEvent) {
  contextMenu(e, TEMPLATES.map((t) => ({ label: t.name, fn: () => void t.build() })));
}
/** Starter compositions (built in the core, same as the MCP tool comp_template). */
export const TEMPLATES: { id: string; name: string; build: () => Promise<void> }[] = TEMPLATE_DEFS.map((t) => ({ id: t.id, name: t.name, build: async () => { const c = await mop<Comp>('templateBuild', t.id); if (c) openComp(c.id); } }));
export { addTask };
