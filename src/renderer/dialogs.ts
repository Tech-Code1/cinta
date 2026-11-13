// Modal dialogs: export, project settings, preferences (AI assistants / MCP), shortcuts, about, missing files.
import { ICONS } from './icons';
import { api, clipEnd, fmt, h, op, store, toast } from './store';
import { stop } from './player';
import { addTask } from './ux';
import { importPrefsSection } from './advanced/importacion-ui';

export function modal(titleText: string, content: (Node | null)[], buttons: Node[], o: { width?: number } = {}) {
  const root = document.getElementById('modal-root')!;
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'modal', style: o.width ? { width: `${o.width}px` } : {} },
    h('header', {}, h('span', {}, titleText), h('button', { class: 'ib', html: ICONS.close, title: 'Cerrar', onclick: close })),
    h('div', { class: 'body' }, ...content),
    buttons.length ? h('footer', {}, ...buttons) : null);
  const back = h('div', { class: 'backdrop' }, box);
  root.append(back);
  document.addEventListener('keydown', esc);
  return { close, box };
}

// ───────────────────────── export ─────────────────────────
interface Preset { id: string; name: string; category: string; ext: string; width?: number; height?: number; audioOnly?: boolean }
export async function exportDialog(presets: Preset[], mode?: 'audio' | 'selection', presetId?: string) {
  stop();
  if (!store.project.clips.length) return toast('Este proyecto no puede guardarse porque está vacío.', true);
  const groups: [string, string, string][] = [
    ['Vídeo', 'Guardar archivo de vídeo', 'Guarde su proyecto como un vídeo reproducible en cualquier reproductor.'],
    ['Audio', 'Guardar archivo de audio', 'Guarde solamente las pistas de audio del proyecto en un único archivo.'],
    ['Web', 'Para internet y redes', 'YouTube, Shorts/Reels/TikTok (9:16), Instagram.'],
    ['Dispositivos', 'Guardar para dispositivos', 'Para verlo en teléfonos y tabletas.'],
    ['TV', 'Guardar para TV', 'Guarde el vídeo para verlo en una televisión.'],
  ];
  let group = mode === 'audio' ? 'Audio' : 'Vídeo';
  let preset = presets.find((p) => p.id === presetId) ?? presets.find((p) => p.category === group)!;
  if (presetId) group = preset.category;
  const dir: string = await api.invoke('export:dir');
  const name = h('input', { value: store.project.name && store.project.name !== 'Nuevo proyecto' ? store.project.name : 'Mi película', dataset: { test: 'export-name' } }) as HTMLInputElement;
  const folder = h('input', { value: dir, style: { flex: '1' } }) as HTMLInputElement;
  const quality = h('select', {}, h('option', { value: 'draft' }, 'Borrador — rápido, calidad media'), h('option', { value: 'good', selected: true }, 'Buena — tiempo y tamaño estándar'), h('option', { value: 'high' }, 'Alta — la mejor calidad')) as HTMLSelectElement;
  const res = h('select', {}) as HTMLSelectElement;
  const fps = h('select', {}, ...['', '24', '25', '30', '50', '60'].map((v) => h('option', { value: v }, v ? `${v} fps` : 'Como el proyecto'))) as HTMLSelectElement;
  const bitrate = h('input', { placeholder: 'Auto (p. ej. 8M)', style: { width: '120px' } }) as HTMLInputElement;
  const brMode = h('select', {}, h('option', { value: 'auto' }, 'Auto'), h('option', { value: 'vbr' }, 'Variable (VBR)'), h('option', { value: 'cbr' }, 'Constante (CBR)')) as HTMLSelectElement;
  const speed = h('select', {}, ...['', 'ultrafast', 'veryfast', 'fast', 'medium', 'slow', 'veryslow'].map((v) => h('option', { value: v }, v || 'Según la calidad'))) as HTMLSelectElement;
  const loud = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const gpu = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const sel = store.selected();
  const range = sel.length ? { from: Math.min(...sel.map((c) => c.start)), to: Math.max(...sel.map((c) => clipEnd(c))) } : null;
  const onlySel = h('input', { type: 'checkbox', disabled: !range }) as HTMLInputElement;
  onlySel.checked = mode === 'selection' && !!range;
  const formats = h('div', { class: 'chips' });
  const tabs = h('div', { class: 'tabs' });
  const info = h('div', { class: 'hint' });
  const P = store.project.settings;
  const fillRes = () => {
    const keep = res.value; // redrawing (format or selection changed) must not lose the chosen resolution
    res.innerHTML = '';
    res.append(h('option', { value: '' }, preset.width ? `${preset.width}×${preset.height} (del formato)` : `${P.width}×${P.height} (del proyecto)`));
    for (const [w, hh] of [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [854, 480], [640, 360], [1080, 1920], [1080, 1080], [1080, 1350]]) res.append(h('option', { value: `${w}x${hh}` }, `${w}×${hh}`));
    res.value = keep;
  };
  const draw = () => {
    tabs.innerHTML = '';
    for (const [g, label] of groups) tabs.append(h('button', { class: g === group ? 'on' : '', onclick: () => { group = g; preset = presets.find((p) => p.category === g)!; draw(); } }, label));
    formats.innerHTML = '';
    for (const p of presets.filter((x) => x.category === group)) formats.append(h('button', { class: `chip${p.id === preset.id ? ' on' : ''}`, dataset: { test: `preset-${p.id}` }, onclick: () => { preset = p; draw(); } }, p.name));
    info.textContent = `${groups.find((g) => g[0] === group)![2]} Duración: ${fmt(onlySel.checked && range ? range.to - range.from : store.duration())}`;
    fillRes();
    const isAudio = !!preset.audioOnly;
    res.disabled = fps.disabled = bitrate.disabled = brMode.disabled = speed.disabled = isAudio || preset.id === 'gif';
  };
  onlySel.onchange = draw;
  draw();
  const start = h('button', { class: 'btn primary', dataset: { test: 'export-start' } }, 'Iniciar');
  const m = modal('Exportar', [
    tabs, info,
    h('div', { class: 'row' }, h('label', {}, 'Formato:'), formats),
    h('div', { class: 'row' }, h('label', {}, 'Título:'), name),
    h('div', { class: 'row' }, h('label', {}, 'Guardar en:'), h('div', { style: { display: 'flex', gap: '8px' } }, folder, h('button', { class: 'btn', onclick: async () => {
      const f = await api.invoke('dialog:save', { title: 'Guardar en', defaultPath: `${folder.value}\\${name.value}.${preset.ext}`, filters: [{ name: preset.name, extensions: [preset.ext] }] });
      if (f) { folder.value = f.replace(/[\\/][^\\/]+$/, ''); name.value = f.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''); }
    } }, 'Examinar'))),
    h('div', { class: 'row' }, h('label', {}, 'Calidad:'), quality),
    h('div', { class: 'row' }, h('label', {}, 'Resolución:'), res),
    h('details', {}, h('summary', { style: { cursor: 'pointer', color: '#fff' } }, 'Avanzado'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' } },
      h('div', { class: 'row' }, h('label', {}, 'FPS:'), fps),
      h('div', { class: 'row' }, h('label', {}, 'Tasa de bits:'), h('div', { style: { display: 'flex', gap: '8px' } }, brMode, bitrate)),
      h('div', { class: 'row' }, h('label', {}, 'Velocidad del códec:'), speed),
      h('div', { class: 'row' }, h('label', {}, 'Normalizar a −14 LUFS:'), loud),
      h('div', { class: 'row' }, h('label', {}, 'Usar la tarjeta gráfica:'), gpu))),
    h('div', { class: 'row' }, h('label', {}, 'Solo la selección:'), h('div', {}, onlySel, h('span', { class: 'hint' }, range ? ` ${fmt(range.from)} – ${fmt(range.to)}` : ' (seleccione clips)'))),
  ], [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), start], { width: 680 });
  start.onclick = async () => {
    const out = `${folder.value.replace(/[\\/]$/, '')}\\${name.value.replace(/[<>:"/\\|?*]/g, '_')}.${preset.ext}`;
    const [w, hh] = res.value ? res.value.split('x').map(Number) : [undefined, undefined];
    const opts: Record<string, unknown> = {
      output: out, preset: w ? { ...preset, width: w, height: hh } : preset.id, quality: quality.value,
      fps: fps.value ? +fps.value : undefined, videoBitrate: bitrate.value.trim() || undefined, bitrateMode: brMode.value, codecPreset: speed.value || undefined,
      loudnorm: loud.checked || undefined, hardware: gpu.checked ? 'auto' : 'off', ...(onlySel.checked && range ? range : {}),
    };
    m.close();
    await runExport(opts);
  };
}

let queue: Promise<unknown> = Promise.resolve();
/**
 * Exports in the background: the task panel shows progress (several exports queue up) and you keep editing.
 * The project is copied when the export is queued, so later edits do not change it.
 */
export function runExport(opts: Record<string, unknown>): Promise<unknown> {
  const name = String(opts.output).split(/[\\/]/).pop()!;
  const task = addTask(`Exportar ${name}`, () => void api.invoke('export:cancel'));
  const snapshot = structuredClone(store.project);
  const job = queue.then(async () => {
    const t0 = Date.now();
    task.progress(0, 'Empezando…');
    const off = api.on('export:progress', (f: number) => {
      const el = (Date.now() - t0) / 1000;
      task.progress(f, `${Math.round(f * 100)} %${f > 0.02 ? ` · quedan ~${Math.max(0, Math.round(el / f - el))} s` : ''}`);
    });
    try {
      const r = await api.invoke('export:start', { ...opts, project: snapshot });
      task.done(`${r.info.width ? `${r.info.width}×${r.info.height} · ` : ''}${fmt(r.duration)} · ${(r.size / 1048576).toFixed(1)} MB · ${r.seconds.toFixed(1)} s${/_(nvenc|qsv|amf)$/.test(r.encoder ?? '') ? ' · con la tarjeta gráfica' : ''}`, [
        { label: 'Abrir carpeta', fn: () => void api.invoke('shell:show', r.path) },
        { label: 'Reproducir', fn: () => void api.invoke('shell:open', r.path) },
      ]);
      return r;
    } catch (e) {
      const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      task.fail(/Cancelado/.test(msg) ? 'Cancelado' : msg.split('\n').slice(-3).join(' '));
      if (!/Cancelado/.test(msg)) modal('No se pudo exportar', [h('pre', {}, msg)], []);
      return null;
    } finally {
      off();
    }
  });
  queue = job.catch(() => null);
  toast('Exportando en segundo plano: puede seguir editando (panel «Tareas»).');
  return job;
}

// ───────────────────────── project settings ─────────────────────────
export function projectSettingsDialog() {
  const s = store.project.settings;
  const w = h('input', { type: 'number', min: '16', step: '2', value: String(s.width) }) as HTMLInputElement;
  const hh = h('input', { type: 'number', min: '16', step: '2', value: String(s.height) }) as HTMLInputElement;
  const keep = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const ar = s.width / s.height;
  w.oninput = () => { if (keep.checked) hh.value = String(Math.round(+w.value / ar / 2) * 2); };
  hh.oninput = () => { if (keep.checked) w.value = String(Math.round(+hh.value * ar / 2) * 2); };
  const fps = h('select', {}, ...[23.976, 24, 25, 29.97, 30, 50, 60].map((v) => h('option', { value: String(v), selected: v === s.fps }, `${v}`))) as HTMLSelectElement;
  const sr = h('select', {}, ...[44100, 48000].map((v) => h('option', { value: String(v), selected: v === s.sampleRate }, `${v} Hz`))) as HTMLSelectElement;
  const bg = h('input', { type: 'color', value: s.background }) as HTMLInputElement;
  const presets = h('div', { class: 'chips' }, ...[['16:9', 1920, 1080], ['9:16', 1080, 1920], ['1:1', 1080, 1080], ['4:5', 1080, 1350], ['4:3', 1440, 1080], ['720p', 1280, 720], ['4K', 3840, 2160]].map(([l, a, b]) => h('button', { class: 'chip', onclick: () => { w.value = String(a); hh.value = String(b); } }, String(l))));
  const m = modal('Configuración del proyecto', [
    presets,
    h('div', { class: 'row' }, h('label', {}, 'Resolución:'), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, w, '×', hh)),
    h('div', { class: 'row' }, h('label', {}, 'Mantener relación de aspecto:'), keep),
    h('div', { class: 'row' }, h('label', {}, 'Fotogramas por segundo:'), fps),
    h('div', { class: 'row' }, h('label', {}, 'Frecuencia de muestreo:'), sr),
    h('div', { class: 'row' }, h('label', {}, 'Color de fondo:'), bg),
  ], [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => { void op('setSettings', { width: +w.value, height: +hh.value, fps: +fps.value, sampleRate: +sr.value, background: bg.value }); m.close(); } }, 'Aceptar')]);
}

// ───────────────────────── preferences (MCP) ─────────────────────────
type Prefs = { settings: { previewQuality: string; mcpAuto: boolean; updates?: { auto: boolean; skip?: string }; whisperDir?: string; llm?: { enabled: boolean; baseUrl: string; model: string; apiKey?: string } }; mcp: { command: string; args: string[]; configJson: string; claudeCodeCommand: string; desktop: string; code: string; portable: boolean }; whisper: string | null; version: string; userData: string };
export async function preferencesDialog() {
  let p: Prefs = await api.invoke('prefs:get');
  const stateLabel: Record<string, string> = { connected: 'Conectado', other: 'Otra configuración', absent: 'No conectado', missing: 'No instalado' };
  const bodyEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  const draw = () => {
    bodyEl.innerHTML = '';
    const row = (name: string, which: 'desktop' | 'code', st: string) => h('div', { class: 'row' }, h('label', {}, name), h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
      h('span', { class: `state ${st}` }, stateLabel[st] ?? st),
      st !== 'connected' && st !== 'missing' ? h('button', { class: 'btn', onclick: async () => { try { p.mcp = await api.invoke('mcp:add', which); toast(`Cinta añadido a ${name}. Reinícielo.`); draw(); } catch (e) { toast(String(e), true); } } }, 'Añadir') : null));
    const whisperDir = h('input', { value: p.settings.whisperDir ?? '', placeholder: `${p.userData}\\models`, style: { flex: '1' } }) as HTMLInputElement;
    whisperDir.onchange = async () => { await api.invoke('prefs:set', { whisperDir: whisperDir.value || undefined }); p = await api.invoke('prefs:get'); draw(); };
    bodyEl.append(
      h('h3', { style: { margin: 0, color: '#fff' } }, 'Asistentes de IA (MCP)'),
      h('div', { class: 'hint' }, 'Cinta incluye un servidor MCP para que Claude y otros asistentes editen vídeos: cortar, unir, quitar silencios, subtítulos automáticos, reencuadrar a 9:16, música con atenuación, títulos, transiciones y exportar.'),
      row('Claude Desktop', 'desktop', p.mcp.desktop),
      row('Claude Code', 'code', p.mcp.code),
      p.mcp.portable ? h('div', { class: 'hint' }, 'Versión portátil: al pulsar «Añadir» se copia el motor de Cinta a CintaData\\mcp (unos 300 MB) para que los asistentes puedan iniciarlo.') : '',
      h('div', { class: 'hint' }, 'Para otros clientes, copie esta configuración:'),
      h('pre', {}, p.mcp.configJson),
      h('div', { class: 'actions', style: { display: 'flex', gap: '10px' } },
        h('button', { class: 'btn', onclick: () => { void api.invoke('clipboard:write', p.mcp.configJson); toast('Configuración copiada.'); } }, 'Copiar configuración'),
        h('button', { class: 'btn', onclick: () => { void api.invoke('clipboard:write', p.mcp.claudeCodeCommand); toast('Comando copiado.'); } }, 'Copiar comando de Claude Code'),
        h('button', { class: 'btn', onclick: async () => { p.mcp = await api.invoke('mcp:remove'); toast('Cinta se quitó de los asistentes.'); draw(); } }, 'Desconectar')),
      ...localAiSection(p, async () => { p = await api.invoke('prefs:get'); draw(); }),
      ...importPrefsSection(),
      h('h3', { style: { margin: '8px 0 0', color: '#fff' } }, 'Subtítulos automáticos'),
      h('div', { class: 'hint' }, p.whisper ? `Modelo Whisper: ${p.whisper}` : 'No hay ningún modelo Whisper. Copie una carpeta sherpa-onnx-whisper (encoder/decoder .onnx y tokens.txt) junto con silero_vad.onnx en la carpeta de modelos.'),
      h('div', { class: 'row' }, h('label', {}, 'Carpeta de modelos:'), whisperDir),
      ...updatesSection(p, async () => { p = await api.invoke('prefs:get'); draw(); }),
      h('div', { class: 'hint' }, `Cinta ${p.version} · datos en ${p.userData}`),
    );
  };
  draw();
  const m = modal('Preferencias', [bodyEl], [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Cerrar')], { width: 680 });
}

/** Automatic updates: switch, "Buscar ahora" and why they are off (portable, development build). */
function updatesSection(p: Prefs, reload: () => Promise<void>): Node[] {
  const st = h('div', { class: 'hint' }, '…');
  const auto = h('input', { type: 'checkbox', checked: p.settings.updates?.auto ?? true }) as HTMLInputElement;
  auto.onchange = async () => { await api.invoke('prefs:set', { updates: { ...(p.settings.updates ?? {}), auto: auto.checked } }); await reload(); };
  const now = h('button', { class: 'btn' }, 'Buscar actualizaciones ahora') as HTMLButtonElement;
  now.onclick = async () => { now.disabled = true; try { st.textContent = String(await api.invoke('updates:check')); } finally { now.disabled = false; } };
  void api.invoke('updates:status').then((s: { available: boolean; reason: string; ready: string | null; version: string }) => {
    st.textContent = !s.available ? s.reason : s.ready ? `Cinta ${s.ready} está descargada: se instalará al cerrar Cinta.` : `Versión instalada: ${s.version}.${p.settings.updates?.skip ? ` Se omite la ${p.settings.updates.skip}.` : ''}`;
    if (!s.available) { auto.disabled = true; now.disabled = true; }
  });
  return [
    h('h3', { style: { margin: '8px 0 0', color: '#fff' } }, 'Actualizaciones'),
    h('label', { class: 'row', style: { gap: '8px', justifyContent: 'flex-start' } }, auto, 'Buscar actualizaciones automáticamente (pregunta antes de descargar nada)'),
    h('div', { class: 'actions', style: { display: 'flex', gap: '10px', alignItems: 'center' } }, now),
    st,
  ];
}

/** Optional local AI (Ollama / LM Studio): never required, Claude does the same through MCP. */
function localAiSection(p: Prefs, reload: () => Promise<void>): Node[] {
  const l = p.settings.llm ?? { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' };
  const on = h('input', { type: 'checkbox', dataset: { test: 'llm-enabled' } }) as HTMLInputElement;
  on.checked = l.enabled;
  const url = h('input', { value: l.baseUrl, style: { width: '100%' }, dataset: { test: 'llm-url' } }) as HTMLInputElement;
  const model = h('input', { value: l.model, style: { width: '100%' }, dataset: { test: 'llm-model' } }) as HTMLInputElement;
  const key = h('input', { value: l.apiKey ?? '', type: 'password', placeholder: '(normalmente vacía)', style: { width: '100%' } }) as HTMLInputElement;
  const result = h('div', { class: 'hint', dataset: { test: 'llm-result' } });
  const save = async () => { await api.invoke('prefs:set', { llm: { enabled: on.checked, baseUrl: url.value.trim(), model: model.value.trim(), apiKey: key.value.trim() || undefined } }); };
  for (const i of [on, url, model, key]) i.onchange = () => void save();
  return [
    h('h3', { style: { margin: '8px 0 0', color: '#fff' } }, 'IA local (opcional)'),
    h('div', { class: 'hint' }, 'No es necesaria: Claude hace todo esto por MCP. Si quiere que los botones de Cinta (traducir, capítulos, mejores momentos) funcionen sin Claude, use una IA gratuita en su PC: Ollama o LM Studio.'),
    h('div', { class: 'row' }, h('label', {}, 'Usar IA local:'), on),
    h('div', { class: 'row' }, h('label', {}, 'Programa:'), h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'chip', onclick: () => { url.value = 'http://localhost:11434/v1'; if (!model.value || model.value === 'local-model') model.value = 'llama3.1'; void save(); } }, 'Ollama'),
      h('button', { class: 'chip', onclick: () => { url.value = 'http://localhost:1234/v1'; model.value = 'local-model'; void save(); } }, 'LM Studio'))),
    h('div', { class: 'row' }, h('label', {}, 'Dirección:'), url),
    h('div', { class: 'row' }, h('label', {}, 'Modelo:'), model),
    h('div', { class: 'row' }, h('label', {}, 'Clave (opcional):'), key),
    h('div', { class: 'actions', style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('button', { class: 'btn', dataset: { test: 'llm-test' }, onclick: async () => {
      await save();
      result.textContent = 'Probando…';
      try { const r = await api.invoke('llm:test', { baseUrl: url.value.trim(), model: model.value.trim(), apiKey: key.value.trim() || undefined }); result.textContent = r.ok ? `Responde correctamente (${r.ms} ms).` : `Responde, pero de forma inesperada: «${r.answer}»`; } catch (e) { result.textContent = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
      void reload;
    } }, 'Probar conexión'), result),
  ];
}

// ───────────────────────── shortcuts, about, missing files ─────────────────────────
export function shortcutsDialog() {
  const list: [string, string][] = [
    ['Ctrl+N', 'Nuevo proyecto'], ['Ctrl+O', 'Abrir proyecto…'], ['Ctrl+S', 'Guardar proyecto'], ['Ctrl+Shift+S', 'Guardar proyecto como…'], ['Ctrl+I', 'Agregar archivos multimedia'], ['Ctrl+E', 'Exportar'],
    ['Ctrl+Z / Ctrl+Y', 'Deshacer / Rehacer'], ['Ctrl+X / C / V', 'Cortar / Copiar / Pegar'], ['Supr', 'Eliminar'], ['Ctrl+A', 'Seleccionar todo'], ['Ctrl+B', 'Dividir clip'], ['Ctrl+D', 'Clonar clip'], ['Ctrl+M', 'Agregar marcador'],
    ['Espacio', 'Reproducir / Pausar'], ['← / →', 'Fotograma anterior / siguiente'], ['Ctrl+← / Ctrl+→', 'Clip anterior / siguiente'], ['Shift+← / Shift+→', 'Volver atrás / Saltar adelante 0,5 s'], ['Inicio / Fin', 'Principio / final'],
    ['Ctrl++ / Ctrl+−', 'Acercar / alejar la escala de tiempo'], ['Ctrl+0', 'Ajustar la escala de tiempo'], ['Alt+Intro', 'Vista previa de pantalla completa'],
  ];
  const m = modal('Métodos abreviados de teclado', [h('table', {}, ...list.map(([k, v]) => h('tr', {}, h('td', { class: 'k' }, k), h('td', {}, v))))], [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Cerrar')]);
}

export async function aboutDialog() {
  const p: Prefs = await api.invoke('prefs:get');
  const m = modal('Acerca de Cinta', [
    h('div', { style: { fontSize: '22px', color: '#fff' } }, `Cinta ${p.version}`),
    h('div', {}, 'Editor de vídeo para Windows con asistentes de IA (MCP).'),
    h('div', {}, 'Software libre y gratuito: GNU GPL v3 o posterior. Puede compartirlo y modificarlo.'),
    h('div', { class: 'hint' }, 'Motor de vídeo: FFmpeg (GPL v3). Voz a texto: sherpa-onnx (Apache 2.0) + Whisper. Gráficos: resvg (MPL 2.0). Interfaz: Electron (MIT).'),
    h('div', { class: 'hint' }, 'Iconos, adhesivos, títulos, música y efectos son propios de Cinta.'),
  ], [
    h('button', { class: 'btn', dataset: { test: 'licenses' }, onclick: async () => { const l = await api.invoke('licenses'); void api.invoke('shell:open', l.notices); } }, 'Licencias de terceros'),
    h('button', { class: 'btn', onclick: async () => { const l = await api.invoke('licenses'); void api.invoke('shell:open', l.license); } }, 'Licencia GPL'),
    h('button', { class: 'btn primary', onclick: () => m.close() }, 'Cerrar'),
  ]);
}

export function missingDialog(missing: { id: string; path: string }[]) {
  const rows = missing.map((mi) => h('div', { class: 'row' }, h('label', { title: mi.path }, mi.path.split(/[\\/]/).pop()!), h('button', { class: 'btn', onclick: async (e: MouseEvent) => {
    const f = await api.invoke('dialog:file', { title: `Buscar ${mi.path.split(/[\\/]/).pop()}`, filters: [{ name: 'Todos los archivos', extensions: ['*'] }] });
    if (f && (await op('relink', mi.id, f)) !== undefined) (e.target as HTMLElement).replaceWith(h('span', { class: 'state connected' }, 'Reubicado'));
  } }, 'Buscar…')));
  const m = modal('Faltan archivos', [h('div', { class: 'hint' }, 'No se encontraron algunos archivos del proyecto. Indique dónde están ahora:'), ...rows], [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Aceptar')]);
}
