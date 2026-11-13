// Cinta — Electron main process: window, menus, the project Editor, preview rendering, export and MCP setup.
import { app, BrowserWindow, clipboard, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  ASPECTS, AUDIO_EFFECTS, AUDIO_ENHANCE, ANIMATIONS, CALLOUTS, EQ_PRESETS, EXPORT_PRESETS, FILTERS, MASKS, MEDIA_EXT, MODEL_EXT, PAN_ZOOM, PIP_LAYOUTS, STICKERS, TITLE_ANIMS, TITLES, TRANSITIONS,
  Editor, addMusic, autoSubtitles, compile, detectBeatsMarkers, detectScenesSplit, exportProject, exportSubtitles, findWhisperModel, generateMedia, importSubtitles, newProject,
  reframe, removeSilences, renderGraphic, runFfmpeg, slideshow, stabilizeClip, syncAudio, thumbnails, toMlt, waveform, cacheDir, mediaInfo, GENERATED,
  buildTranscript, removeTimeRanges, phraseRanges, findFillers, cuesIn, cuesToTrack, setChapters, speak, subtitleCues, translateLines, addSubtitleTrack, transcriptLines,
  suggestChapters, chaptersText, suggestShorts, shortsFromRanges, transcriptView, timelineWords, listVoices, testLlm, LLM_PRESETS, projectDuration,
  type Project,
} from '../core';
import { spawnFfmpeg } from '../core/ffmpeg';
import { clientInfo, preparePortableRuntime, registerCode, registerDesktop, syncClients, unregisterAll, autoRegisterAllowed, type SyncRecord } from './clients';
import { runSelfTest } from './selftest';
import { pickDialog } from './testdialogs';
import { closeRenderWindow, compAudioFile, compToTimeline, engineId, ensureCompMedia, ensureSequence, fillDiskCache, handleMediaProtocol, registerMediaScheme, renderCompProxy, renderCompStill, renderCompToFile, runRenderCli, runRenderQueue, setDirs } from './motion';
import { createFootageProxy } from '../core/proxy';
import { DiskCache, type FrameOpts } from '../core/diskcache';
import { motion } from '../core';
import { trackLayer, trackMask, type MaskTrackOptions, type TrackOptions } from '../core/tracker';
import { audioToKeys } from '../core/audiokeys';
import { psdImport } from '../core/psd';
import { aiImport } from '../core/ai';
import { exrImport } from '../core/exrimport';
import { cameraTrack, type CameraTrackOptions } from '../core/cameratrack';
import { compToLottie } from '../core/lottie';
import { registerScripting } from './scripting';
import { registerFontIpc } from './fonts';
import { registerWarpStab } from './warpstab';
import { registerImport } from './importacion';
import { registerMediosIpc } from './medios';
import { registerRoto } from './roto';
import { installCrashHandlers, logDir, logError, watchWindow } from './errors';
import { checkForUpdates, initUpdates, updateStatus } from './updates';
import type { UpdateSettings } from '../core/updates';

// ───────────────────────── profile ─────────────────────────
if (process.env.CINTA_USER_DATA) app.setPath('userData', resolve(process.env.CINTA_USER_DATA));
else if (process.env.PORTABLE_EXECUTABLE_DIR) app.setPath('userData', join(process.env.PORTABLE_EXECUTABLE_DIR, 'CintaData'));
process.env.CINTA_USER_DATA = app.getPath('userData');
process.env.CINTA_CACHE ??= join(app.getPath('userData'), 'cache');

const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const selftest = argv.find((a) => a.startsWith('--selftest'));
// `--render-comp job.json`: headless composition render for the MCP server (no window, no single-instance lock)
const renderJob = argv.includes('--render-comp') ? argv[argv.indexOf('--render-comp') + 1] : undefined;
registerMediaScheme();
registerFontIpc();
registerMediosIpc();
// errors: Spanish dialog + logs/errores.log instead of Electron's raw dialog (see errors.ts)
installCrashHandlers({ window: () => win, autosave: () => autosaveNow(), reloaded: () => pushState('init'), quiet: !!selftest || !!renderJob });
// in --selftest mode native dialogs are answered by the test (see testdialogs.ts)
const dlg = pickDialog(!!selftest);
if (argv.includes('--uninstall-mcp')) {
  void app.whenReady().then(async () => { try { await unregisterAll(); } finally { app.exit(0); } });
} else if (!selftest && !renderJob && !app.requestSingleInstanceLock()) {
  app.quit();
}

interface Settings {
  recent: string[];
  exportDir?: string;
  mcp: SyncRecord;
  mcpAuto: boolean;
  whisperDir?: string;
  previewQuality: 'low' | 'high';
  /** advanced mode disk cache: folder (default inside the app cache) and size limit */
  diskCache?: { dir?: string; maxGB: number; on: boolean };
  /** optional local AI (Ollama, LM Studio…): only for the in-app buttons; Claude does the same through MCP */
  llm?: { enabled: boolean; baseUrl: string; model: string; apiKey?: string };
  /** automatic updates (see updates.ts) */
  updates?: UpdateSettings;
}
const settingsFile = () => join(app.getPath('userData'), 'settings.json');
let settings: Settings = { recent: [], mcp: { desktop: null, code: null }, mcpAuto: true, previewQuality: 'low' };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 1));
}

// ───────────────────────── project state ─────────────────────────
let win: BrowserWindow | null = null;
let editor = new Editor();
let dirty = false;
let ownWriteMtime = 0;

function title() {
  const name = editor.path ? basename(editor.path, '.cinta') : 'Nuevo proyecto';
  return `Cinta – ${name}${dirty ? ' *' : ''}`;
}
/** bumped on every state sent: the window says which state it drew from, so the disk cache never files a frame
 *  of an older state under the key of a newer one */
let stateVersion = 0;
let diskCache: DiskCache | null = null;
function pushState(label = '') {
  win?.setTitle(title());
  diskCache?.invalidate();
  win?.webContents.send('state', { project: editor.project, path: editor.path, dirty, canUndo: editor.canUndo, canRedo: editor.canRedo, label, version: ++stateVersion });
}
function attach(e: Editor) {
  if (editor.path) unwatchFile(editor.path);
  editor = e;
  editor.onChange = (label) => { dirty = true; pushState(label); };
  dirty = false;
  if (editor.path) {
    ownWriteMtime = statSync(editor.path).mtimeMs;
    watchFile(editor.path, { interval: 600 }, (cur) => {
      if (!editor.path || cur.mtimeMs === ownWriteMtime || cur.mtimeMs === 0) return;
      ownWriteMtime = cur.mtimeMs;
      void externalChange();
    });
    settings.recent = [editor.path, ...settings.recent.filter((p) => p.toLowerCase() !== editor.path!.toLowerCase())].slice(0, 10);
    saveSettings();
    buildMenu();
  }
  pushState('open');
}

/** The MCP (or anything else) changed the open project file. */
async function externalChange() {
  if (!editor.path) return;
  let fresh: Editor;
  try { fresh = Editor.load(editor.path); } catch { return; }
  if (dirty && win) {
    const r = await dlg.showMessageBox(win, { type: 'question', buttons: ['Recargar', 'Mantener mis cambios'], defaultId: 0, cancelId: 1, title: 'Cinta', message: 'El proyecto ha cambiado fuera de Cinta (por ejemplo, un asistente de IA).', detail: 'Si recarga, perderá los cambios sin guardar.' });
    if (r.response !== 0) return;
  }
  editor.replace(fresh.project, 'Cambios externos');
  dirty = false;
  pushState('external');
}

// ───────────────────────── autosave and crash recovery ─────────────────────────
// Every minute the unsaved project goes to userData/autosave/session-<pid>.json; a clean save or exit deletes
// it. A file left by a process that is no longer running means Cinta closed unexpectedly: offer to recover it.
const autosaveDir = () => join(app.getPath('userData'), 'autosave');
const autosaveFile = () => join(autosaveDir(), `session-${process.pid}.json`);
let lastAutosave = '';
function autosaveNow(): boolean {
  if (!dirty) return false;
  const json = JSON.stringify(editor.project);
  if (json === lastAutosave) return false;
  mkdirSync(autosaveDir(), { recursive: true });
  writeFileSync(`${autosaveFile()}.tmp`, JSON.stringify({ path: editor.path, savedAt: Date.now(), project: editor.project }));
  renameSync(`${autosaveFile()}.tmp`, autosaveFile());
  lastAutosave = json;
  return true;
}
function clearAutosave() {
  lastAutosave = '';
  rmSync(autosaveFile(), { force: true });
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function checkRecovery(): Promise<boolean> {
  let files: string[] = [];
  try { files = readdirSync(autosaveDir()).filter((f) => /^session-\d+\.json$/.test(f)); } catch { return false; }
  const orphans = files.map((f) => ({ f: join(autosaveDir(), f), pid: Number(/\d+/.exec(f)![0]) })).filter((x) => x.pid !== process.pid && !alive(x.pid));
  if (!orphans.length) return false;
  const data = orphans.map((o) => { try { return { ...o, ...(JSON.parse(readFileSync(o.f, 'utf8')) as { path: string | null; savedAt: number; project: Project }) }; } catch { return null; } }).filter((d): d is NonNullable<typeof d> => !!d).sort((a, b) => b.savedAt - a.savedAt);
  const best = data[0];
  let recovered = false;
  if (best && win) {
    const name = best.path ? basename(best.path, '.cinta') : best.project.name || 'Nuevo proyecto';
    const when = new Date(best.savedAt).toLocaleString('es');
    const r = await dlg.showMessageBox(win, { type: 'warning', buttons: ['Recuperar', 'Descartar'], defaultId: 0, cancelId: 1, title: 'Cinta', message: `Cinta se cerró sin guardar «${name}».`, detail: `Hay una copia guardada automáticamente el ${when}. ¿Quiere recuperarla?` });
    if (r.response === 0) {
      const e = new Editor(best.project);
      e.path = best.path;
      attach(e);
      dirty = true;
      pushState('recovered');
      recovered = true;
    }
  }
  for (const o of orphans) rmSync(o.f, { force: true });
  return recovered;
}

function saveTo(path: string) {
  editor.save(path);
  ownWriteMtime = statSync(editor.path!).mtimeMs;
  dirty = false;
  clearAutosave();
  attach(editor);
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty || !win) return true;
  const r = await dlg.showMessageBox(win, { type: 'warning', buttons: ['Guardar', 'No guardar', 'Cancelar'], defaultId: 0, cancelId: 2, title: 'Cinta', message: '¿Desea guardar los cambios del proyecto?' });
  if (r.response === 2) return false;
  if (r.response === 0) return saveProject(false);
  return true;
}

async function saveProject(as: boolean): Promise<boolean> {
  if (!as && editor.path) { saveTo(editor.path); return true; }
  const r = await dlg.showSaveDialog(win!, { title: 'Guardar proyecto', defaultPath: join(app.getPath('documents'), 'Cinta', `${editor.project.name || 'Proyecto'}.cinta`), filters: [{ name: 'Proyecto de Cinta', extensions: ['cinta'] }] });
  if (r.canceled || !r.filePath) return false;
  mkdirSync(dirname(r.filePath), { recursive: true });
  saveTo(r.filePath);
  return true;
}

async function openProject(path?: string) {
  if (!(await confirmDiscard())) return;
  if (!path) {
    const r = await dlg.showOpenDialog(win!, { title: 'Abrir proyecto', filters: [{ name: 'Proyecto de Cinta', extensions: ['cinta'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return;
    path = r.filePaths[0];
  }
  try {
    attach(Editor.load(path, true));
    const missing = editor.missingMedia();
    if (missing.length) win?.webContents.send('missing', missing);
  } catch (e) {
    dlg.showErrorBox('Cinta', `No se puede abrir el proyecto:\n${(e as Error).message}`);
  }
}

async function newProjectCmd() {
  if (!(await confirmDiscard())) return;
  attach(new Editor(newProject()));
}

// ───────────────────────── window and menu ─────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#191b23',
    title: 'Cinta',
    icon: join(__dirname, '..', '..', 'build', 'icon.png'),
    show: !selftest,
    // the player starts with sound right after the user presses play (also from shortcuts and the MCP)
    // the self-test runs hidden: without throttling off, requestAnimationFrame stops and playback never advances
    webPreferences: { preload: join(__dirname, '..', 'preload', 'index.js'), sandbox: true, contextIsolation: true, spellcheck: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: !selftest },
  });
  if (!selftest) win.maximize();
  watchWindow(win);
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (ev) => {
    if (!dirty || selftest) return;
    ev.preventDefault();
    void confirmDiscard().then((okk) => { if (okk) { dirty = false; win?.destroy(); } });
  });
  win.on('closed', () => { win = null; closeRenderWindow(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
}

const send = (cmd: string, ...args: unknown[]) => () => win?.webContents.send('menu', cmd, ...args);
function buildMenu() {
  const recent: MenuItemConstructorOptions[] = settings.recent.length
    ? settings.recent.map((p) => ({ label: basename(p), sublabel: p, click: () => void openProject(p) }))
    : [{ label: '(vacío)', enabled: false }];
  const noAcc = { registerAccelerator: false };
  const tpl: MenuItemConstructorOptions[] = [
    { label: '&Archivo', submenu: [
      { label: '&Crear nuevo proyecto', accelerator: 'Ctrl+N', click: () => void newProjectCmd() },
      { label: 'A&brir proyecto…', accelerator: 'Ctrl+O', click: () => void openProject() },
      { label: 'Proyectos &recientes', submenu: recent },
      { label: '&Guardar proyecto', accelerator: 'Ctrl+S', click: () => void saveProject(false) },
      { label: 'Guardar proyecto &como…', accelerator: 'Ctrl+Shift+S', click: () => void saveProject(true) },
      { label: 'Guardar proyecto &portátil…', click: send('save-portable') },
      { label: 'Adjuntar proyecto…', click: send('append-project') },
      { type: 'separator' },
      { label: '&Agregar archivo multimedia…', accelerator: 'Ctrl+I', click: send('import') },
      { label: 'Agregar carpeta…', click: send('import-folder') },
      { label: 'Importar', submenu: [
        { label: 'Archivo (secuencias, Targa, DPX, Cineon, Camera Raw, HEIF, MXF…)…', accelerator: 'Ctrl+Alt+I', click: send('import-file') },
        { label: 'Proyecto de Adobe Premiere Pro…', click: send('import-premiere') },
        { label: 'Escena Maya (cámaras)…', click: send('import-maya') },
      ] },
      { label: 'Interpretar material de archivo ▸ Principal…', accelerator: 'Ctrl+Alt+G', click: send('interpret-footage') },
      { type: 'separator' },
      { label: 'Guardar película como archivo &multimedia…', accelerator: 'Ctrl+E', click: send('export') },
      { label: 'Exportar a Shotcut / Kdenlive (MLT)…', click: send('export-mlt') },
      { type: 'separator' },
      { label: 'Scripts', submenu: [{ id: 'run-script', label: 'Ejecutar archivo de secuencias de comandos…', click: send('run-script') }] },
      { type: 'separator' },
      { label: '&Salir', accelerator: 'Alt+F4', click: () => win?.close() },
    ] },
    { label: '&Editar', submenu: [
      { label: '&Deshacer', accelerator: 'Ctrl+Z', ...noAcc, click: send('undo') },
      { label: '&Rehacer', accelerator: 'Ctrl+Y', ...noAcc, click: send('redo') },
      { type: 'separator' },
      { label: 'Cor&tar', accelerator: 'Ctrl+X', ...noAcc, click: send('cut') },
      { label: '&Copiar', accelerator: 'Ctrl+C', ...noAcc, click: send('copy') },
      { label: 'P&egar', accelerator: 'Ctrl+V', ...noAcc, click: send('paste') },
      { label: 'E&liminar', accelerator: 'Delete', ...noAcc, click: send('delete') },
      { label: 'Seleccionar todo', accelerator: 'Ctrl+A', ...noAcc, click: send('select-all') },
      { label: 'Buscar una acción…', accelerator: 'Ctrl+K', ...noAcc, click: send('palette') },
      { type: 'separator' },
      { label: 'Divid&ir clip', accelerator: 'Ctrl+B', ...noAcc, click: send('split') },
      { label: 'Clonar clip', accelerator: 'Ctrl+D', ...noAcc, click: send('duplicate') },
      { label: 'Separar audio', click: send('detach-audio') },
      { label: 'In&sertar fotograma fijo', click: send('freeze') },
      { label: 'Agregar &marcador', accelerator: 'Ctrl+M', ...noAcc, click: send('marker') },
      { type: 'separator' },
      { id: 'adv-shortcuts', label: "Métodos abreviados de teclado (modo avanzado)…", click: send('adv:shortcuts') },
    ] },
    { label: '&Ver', submenu: [
      { label: 'Modo &simple', click: send('mode-simple') },
      { label: 'Modo &avanzado (composición y animación)', click: send('mode-adv') },
      { label: 'Cambiar de modo', accelerator: 'Ctrl+Shift+A', ...noAcc, click: send('toggle-mode') },
      { type: 'separator' },
      { id: 'lumetri-scopes', label: 'Ámbitos de Lumetri', click: send('lumetri-scopes') },
      { type: 'separator' },
      { label: 'Cambiar el diseño de la vista', submenu: [['1', '1 Vista'], ['2', '2 Vistas'], ['4', '4 Vistas']].map(([n, l]) => ({ id: `adv-layout-${n}`, label: l, click: send(`adv:layout-${n}`) })) },
      { label: 'Cambiar vista 3D', submenu: [['active', 'Cámara activa (por defecto)', 'F12'], ['front', 'Parte frontal', 'F10'], ['left', 'Izquierda'], ['top', 'Parte superior'], ['back', 'Parte trasera'], ['right', 'Derecha'], ['bottom', 'Parte inferior'], ['custom1', 'Personalizar vista 1', 'F11'], ['custom2', 'Personalizar vista 2'], ['custom3', 'Personalizar vista 3']].map(([v, l, k]) => ({ id: `adv-view-${v}`, label: k ? `${l}	${k}` : l, click: send(`adv:view-${v}`) })) },
      { id: 'adv-last-3d-view', label: 'Cambiar a la última vista 3D	Esc', click: send('adv:last-3d-view') },
      { label: 'Restablecer vista 3D', click: send('adv:reset-3d-view') },
      { type: 'separator' },
      { id: 'adv-flowchart', label: 'Diagrama de flujo de la composición	Ctrl+Mayús+F11', click: send('adv:flowchart-comp') },
      { label: 'Propiedades', click: send('adv:panel-properties') },
      { id: 'adv-media', label: 'Navegador de medios', click: send('adv:panel-media') },
      { label: 'Metadatos', click: send('adv:panel-metadata') },
      { id: 'content-aware-fill', label: 'Relleno según el contenido', click: send('content-aware-fill') },
    ] },
    { label: '&Reproducción', submenu: [
      { label: '&Reproducir/Pausar', accelerator: 'Space', ...noAcc, click: send('play') },
      { label: 'Ir al &cuadro anterior', accelerator: 'Left', ...noAcc, click: send('prev-frame') },
      { label: 'Ir al &siguiente cuadro', accelerator: 'Right', ...noAcc, click: send('next-frame') },
      { label: 'Clip anterior', accelerator: 'Ctrl+Left', ...noAcc, click: send('prev-clip') },
      { label: 'Clip siguiente', accelerator: 'Ctrl+Right', ...noAcc, click: send('next-clip') },
      { label: '&Volver atrás 0,5 segundos', accelerator: 'Shift+Left', ...noAcc, click: send('back-half') },
      { label: 'Saltar &adelante 0,5 segundos', accelerator: 'Shift+Right', ...noAcc, click: send('fwd-half') },
      { type: 'separator' },
      { label: '&Vista previa de pantalla completa', accelerator: 'Alt+Enter', click: send('fullscreen') },
      { label: 'Guarde una instantánea', click: send('snapshot') },
    ] },
    { label: '&Configuración', submenu: [
      { label: 'Configuración del proyecto…', click: send('project-settings') },
      { label: '&Preferencias…', accelerator: 'Ctrl+,', click: send('preferences') },
      { label: 'Métodos abreviados de teclado', click: send('shortcuts') },
      { type: 'separator' },
      { label: 'Mostrar u ocultar el inspector', accelerator: 'F4', click: send('toggle-inspector') },
    ] },
    { label: 'E&xportar', submenu: [
      { label: 'Exportar vídeo…', click: send('export') },
      { label: 'Exportar audio…', click: send('export', 'audio') },
      { label: 'Exportar selección…', click: send('export', 'selection') },
      { label: 'Exportar subtítulos (.srt)…', click: send('export-srt') },
      { label: 'Exportar a Shotcut / Kdenlive (MLT)…', click: send('export-mlt') },
    ] },
    { label: 'A&yuda', submenu: [
      { label: 'Métodos abreviados de teclado', click: send('shortcuts') },
      { label: 'Asistentes de IA (MCP)…', click: send('preferences', 'mcp') },
      { label: 'Guía de primer uso', click: send('tour') },
      { label: 'Buscar una acción… (Ctrl+K)', click: send('palette') },
      { type: 'separator' },
      { label: 'Buscar actualizaciones…', click: () => void checkForUpdates(true) },
      { label: 'Abrir carpeta de registros de errores', click: () => { mkdirSync(logDir(), { recursive: true }); void shell.openPath(logDir()); } },
      { label: 'Acerca &de Cinta', click: send('about') },
      ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { label: 'Herramientas de desarrollo', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() }]),
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ───────────────────────── operations from the UI ─────────────────────────
/** Editor methods the renderer may call. */
const OPS = new Set(['setSettings', 'addClip', 'addColorClip', 'addTitle', 'addGraphic', 'split', 'trim', 'move', 'duplicate', 'remove', 'closeGaps', 'detachAudio', 'freezeFrame', 'set', 'addFilter', 'setFilter', 'removeFilter', 'setTransition', 'transitionWizard', 'setMask', 'addTrack', 'removeTrack', 'setTrack', 'addMarker', 'removeMarker', 'renameMarker', 'undo', 'redo', 'removeMedia', 'relink', 'importMedia', 'addLogo']);
const task = (name: string) => (f: number) => win?.webContents.send('task', { name, progress: f });
const AUTOMATIONS: Record<string, (e: Editor, ...a: never[]) => Promise<unknown> | unknown> = {
  removeSilences: (e, o: Parameters<typeof removeSilences>[1]) => removeSilences(e, o),
  autoSubtitles: (e, o: Parameters<typeof autoSubtitles>[1]) => autoSubtitles(e, { ...o, modelDir: settings.whisperDir, onProgress: task('Transcribiendo') }),
  importSubtitles: (e, path: string, o: { style?: string }) => importSubtitles(e, path, o),
  reframe: (e, o: Parameters<typeof reframe>[1]) => reframe(e, o),
  addMusic: (e, path: string, o: Parameters<typeof addMusic>[2]) => addMusic(e, path, o),
  detectScenes: (e, id: string, o: object) => detectScenesSplit(e, id, o),
  detectBeats: (e, id: string, o: object) => detectBeatsMarkers(e, id, o),
  syncAudio: (e, a: string, b: string) => syncAudio(e, a, b),
  stabilize: (e, id: string, o: object) => stabilizeClip(e, id, { ...o, onProgress: task('Estabilizando') }),
  slideshow: (e, paths: string[], o: object) => slideshow(e, paths, o),
  // transcript-based editing (no AI needed)
  buildTranscript: (e, o: { language?: string }) => buildTranscript(e, { ...o, modelDir: settings.whisperDir, onProgress: task('Transcribiendo') }),
  cutRanges: (e, ranges: { start: number; end: number }[], pad?: number) => removeTimeRanges(e, ranges, pad ?? 0.04),
  cutPhrase: (e, phrase: string) => { const r = phraseRanges(e.project, [phrase]); if (!r.length) throw new Error(`No se encontró «${phrase}» en la transcripción.`); return removeTimeRanges(e, r); },
  removeFillers: (e) => removeTimeRanges(e, findFillers(e.project).map((h) => ({ start: h[0].start, end: h[h.length - 1].end })), 0.03),
  subtitlesFromTranscript: (e, style: string) => { const cues = cuesIn(e.project, 0, projectDuration(e.project), style === 'subtitle' ? 8 : 3); if (!cues.length) throw new Error('Primero transcriba el vídeo.'); return cuesToTrack(e, cues, { style }); },
  setChapters: (e, list: { time: number; title: string }[]) => setChapters(e, list),
  voiceover: async (e, text: string, o: { voice?: string; rate?: number; at?: number }) => {
    const wav = await speak(text, { output: join(cacheDir('tts'), `voz_${Date.now()}.wav`), voice: o.voice, rate: o.rate });
    let t = e.project.tracks.find((x) => x.kind === 'audio' && x.name === 'Voz');
    if (!t) t = e.addTrack('audio', 'Voz');
    const [m] = await e.importMedia([wav]);
    return e.addClip(m.id, { trackId: t.id, at: o.at ?? 0 });
  },
  // the same jobs done by the optional local AI
  llmTranslate: async (e, target: string) => {
    const { cues } = subtitleCues(e.project);
    const texts = await translateLines(llmConfig(), cues.map((c) => c.text), target, task('Traduciendo'));
    return addSubtitleTrack(e, texts, { name: `Subtítulos (${target})`, hideSource: true });
  },
  llmChapters: async (e) => {
    const lines = transcriptLines(e.project);
    if (!lines) throw new Error('Primero transcriba el vídeo.');
    win?.webContents.send('task', { name: 'Pensando los capítulos', progress: 0.5 });
    const list = await suggestChapters(llmConfig(), lines);
    setChapters(e, list);
    return { chapters: list.length, youtube: chaptersText(e.project) };
  },
  llmShorts: async (e, count: number, dir: string) => {
    const lines = transcriptLines(e.project);
    if (!lines) throw new Error('Primero transcriba el vídeo.');
    win?.webContents.send('task', { name: 'Eligiendo los mejores momentos', progress: 0.3 });
    const specs = await suggestShorts(llmConfig(), lines, count);
    if (!specs.length) throw new Error('La IA local no propuso ningún momento válido (de 2 s o más).');
    const made = await shortsFromRanges(e.project, specs, { dir, onProgress: task('Creando shorts') });
    return { shorts: made };
  },
  shortsManual: (e, specs: { start: number; end: number; title?: string }[], dir: string) => shortsFromRanges(e.project, specs, { dir, onProgress: task('Creando shorts') }),

};

function llmConfig() {
  const l = settings.llm;
  if (!l?.enabled || !l.baseUrl || !l.model) throw new Error('No hay ninguna IA local configurada (Preferencias → IA local). También puede pedírselo a Claude por MCP.');
  return { baseUrl: l.baseUrl, model: l.model, apiKey: l.apiKey };
}
ipcMain.handle('transcript:view', () => ({ ...transcriptView(editor.project), words: timelineWords(editor.project), fillers: findFillers(editor.project).map((h) => h.map((w) => w.id)) }));
ipcMain.handle('chapters:text', () => chaptersText(editor.project));
ipcMain.handle('tts:voices', () => listVoices());
ipcMain.handle('updates:status', () => updateStatus());
ipcMain.handle('updates:check', () => checkForUpdates(true));
// errors of the window (window.onerror / unhandledrejection in the renderer) go to the same log
ipcMain.handle('app:logError', (_e, msg: unknown, stack: unknown) => { logError(Object.assign(new Error(String(msg).slice(0, 4000)), { name: 'Ventana', stack: `Ventana: ${String(msg)}
${String(stack ?? '')}` }), 'ventana'); });
ipcMain.handle('llm:test', (_e, cfg: { baseUrl: string; model: string; apiKey?: string }) => testLlm(cfg));
ipcMain.handle('llm:presets', () => LLM_PRESETS);
ipcMain.handle('state', () => ({ project: editor.project, path: editor.path, dirty, canUndo: editor.canUndo, canRedo: editor.canRedo, version: stateVersion }));
ipcMain.handle('op', async (_e, name: string, ...args: unknown[]) => {
  if (!OPS.has(name)) throw new Error(`Operación no permitida: ${name}`);
  const fn = (editor as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
  if (name === 'undo' || name === 'redo') return fn.apply(editor, args);
  return await editor.batch(async () => fn.apply(editor, args));
});
ipcMain.handle('auto', async (_e, name: string, ...args: unknown[]) => {
  const fn = AUTOMATIONS[name];
  if (!fn) throw new Error(`Operación no permitida: ${name}`);
  try { return await editor.batch(async () => fn(editor, ...(args as never[]))); } finally { win?.webContents.send('task', null); }
});
ipcMain.handle('project:save', (_e, as: boolean) => saveProject(as));
ipcMain.handle('project:open', (_e, path?: string) => openProject(path));
ipcMain.handle('project:new', () => newProjectCmd());
ipcMain.handle('project:portable', async () => {
  const r = await dlg.showOpenDialog(win!, { title: 'Carpeta del proyecto portátil', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const path = editor.savePortable(r.filePaths[0]);
  attach(Editor.load(path, false));
  return path;
});
ipcMain.handle('project:append', async () => {
  const r = await dlg.showOpenDialog(win!, { title: 'Adjuntar proyecto', filters: [{ name: 'Proyecto de Cinta', extensions: ['cinta'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return;
  editor.append(Editor.load(r.filePaths[0]).project);
});

ipcMain.handle('dialog:media', async (_e, folder: boolean) => {
  const r = await dlg.showOpenDialog(win!, folder
    ? { title: 'Agregar carpeta', properties: ['openDirectory'] }
    : { title: 'Añadir archivos', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Archivos multimedia', extensions: [...MEDIA_EXT, ...MODEL_EXT].map((x) => x.slice(1)) }, { name: 'Modelos 3D', extensions: MODEL_EXT.map((x) => x.slice(1)) }, { name: 'Todos los archivos', extensions: ['*'] }] });
  if (r.canceled) return [];
  if (!folder) return r.filePaths;
  const { readdirSync } = await import('node:fs');
  return readdirSync(r.filePaths[0]).filter((f) => MEDIA_EXT.includes(extname(f).toLowerCase())).sort().map((f) => join(r.filePaths[0], f));
});
ipcMain.handle('dialog:folder', async () => { const r = await dlg.showOpenDialog(win!, { title: 'Elegir carpeta', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('dialog:file', async (_e, o: { title: string; filters: { name: string; extensions: string[] }[] }) => {
  const r = await dlg.showOpenDialog(win!, { title: o.title, filters: o.filters, properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:save', async (_e, o: { title: string; defaultPath: string; filters: { name: string; extensions: string[] }[] }) => {
  const r = await dlg.showSaveDialog(win!, { title: o.title, defaultPath: o.defaultPath, filters: o.filters });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:message', async (_e, o: Electron.MessageBoxOptions) => (await dlg.showMessageBox(win!, o)).response);
ipcMain.handle('shell:show', (_e, path: string) => shell.showItemInFolder(path));
ipcMain.handle('shell:open', (_e, path: string) => shell.openPath(path));
ipcMain.handle('licenses', () => {
  const dir = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..');
  return { license: join(dir, app.isPackaged ? 'LICENSE.txt' : 'LICENSE'), notices: join(dir, 'THIRD_PARTY_NOTICES.md') };
});
ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text));

// ───────────────────────── catalogues and thumbnails ─────────────────────────
ipcMain.handle('catalog', () => ({
  filters: FILTERS.map(({ id, name, category }) => ({ id, name, category })),
  transitions: TRANSITIONS.map(({ id, name, category }) => ({ id, name, category })),
  titles: TITLES.map(({ id, name, category, sample, style }) => ({ id, name, category, sample, style })),
  titleAnims: TITLE_ANIMS,
  stickers: STICKERS.map(({ id, name, category, recolor }) => ({ id, name, category, recolor })),
  callouts: CALLOUTS.map(({ id, name, category }) => ({ id, name, category })),
  masks: MASKS, pip: PIP_LAYOUTS, panZoom: PAN_ZOOM, animations: ANIMATIONS, eqPresets: EQ_PRESETS,
  audioEffects: AUDIO_EFFECTS.map(({ id, name, category }) => ({ id, name, category })),
  audioEnhance: Object.entries(AUDIO_ENHANCE).map(([id, v]) => ({ id, name: v.name })),
  exportPresets: EXPORT_PRESETS, aspects: ASPECTS, generated: GENERATED,
}));

const thumbDir = () => cacheDir('thumbs');
async function sampleImages(): Promise<[string, string]> {
  const a = join(thumbDir(), 'sample_a.png'), b = join(thumbDir(), 'sample_b.png');
  // our own sample pictures: a sunset-like gradient with hills, and a night sky with a moon
  if (!existsSync(a)) await runFfmpeg(['-f', 'lavfi', '-i', "color=s=288x162:c=black,geq=r='255*(0.95-0.4*Y/H)':g='150+80*Y/H-60*lt(Y\\,H*0.7+20*sin(X/25))':b='90+120*Y/H-80*lt(Y\\,H*0.7+20*sin(X/25))'", '-frames:v', '1', a]);
  if (!existsSync(b)) await runFfmpeg(['-f', 'lavfi', '-i', "color=s=288x162:c=black,geq=r='20+30*Y/H+200*lt(hypot(X-210\\,Y-45)\\,22)':g='30+40*Y/H+200*lt(hypot(X-210\\,Y-45)\\,22)':b='70+80*Y/H+180*lt(hypot(X-210\\,Y-45)\\,22)'", '-frames:v', '1', b]);
  return [a, b];
}
const dataUrl = (p: string, mime = 'image/png') => `data:${mime};base64,${readFileSync(p).toString('base64')}`;
ipcMain.handle('thumb', async (_e, kind: string, id: string) => {
  const out = join(thumbDir(), `${kind}_${id}.png`);
  if (!existsSync(out)) {
    const [a, b] = await sampleImages();
    if (kind === 'filter') {
      const def = FILTERS.find((f) => f.id === id);
      if (!def) throw new Error(id);
      await runFfmpeg(['-loop', '1', '-t', '0.5', '-i', a, '-filter_complex', `[0:v]${def.chain(0.8)},scale=288:162,setsar=1`, '-frames:v', '1', out]);
    } else if (kind === 'transition') {
      const def = TRANSITIONS.find((t) => t.id === id);
      if (!def) throw new Error(id);
      await runFfmpeg(['-loop', '1', '-t', '2', '-r', '10', '-i', a, '-loop', '1', '-t', '2', '-r', '10', '-i', b, '-filter_complex', `[0:v]format=yuv420p,settb=AVTB[x];[1:v]format=yuv420p,settb=AVTB[y];[x][y]xfade=transition=${def.xfade}:duration=1:offset=0.5`, '-ss', '1', '-frames:v', '1', out]);
    } else if (kind === 'sticker' || kind === 'callout') {
      return dataUrl(renderGraphic(kind, id, undefined, 120).path);
    } else return null;
  }
  return dataUrl(out);
});

const thumbCache = new Map<string, string[]>();
ipcMain.handle('media:thumbs', async (_e, mediaId: string, count: number, height: number) => {
  const m = editor.project.media.find((x) => x.id === mediaId);
  if (!m || !existsSync(m.path)) return [];
  const key = `${m.path}|${count}|${height}`;
  if (!thumbCache.has(key)) {
    if (m.kind === 'audio' || m.kind === 'model') thumbCache.set(key, []);
    else if (m.kind === 'image') {
      const out = join(thumbDir(), `img_${createHash('sha1').update(key).digest('hex').slice(0, 12)}.jpg`);
      if (!existsSync(out)) await runFfmpeg(['-i', m.path, '-frames:v', '1', '-vf', `scale=-2:${height}`, out]);
      thumbCache.set(key, [dataUrl(out, 'image/jpeg')]);
    } else thumbCache.set(key, await thumbnails(m.path, m.duration, count, height));
  }
  return thumbCache.get(key);
});
const waveCache = new Map<string, number[]>();
ipcMain.handle('media:wave', async (_e, mediaId: string) => {
  const m = editor.project.media.find((x) => x.id === mediaId);
  if (!m || !m.hasAudio || !existsSync(m.path)) return [];
  if (!waveCache.has(m.path)) waveCache.set(m.path, await waveform(m.path, 40));
  return waveCache.get(m.path);
});

// ───────────────────────── preview ─────────────────────────
let frameJob: AbortController | null = null;
const frameCache = new Map<string, string>();
// a frame of a throw-away project (hover previews of filters and transitions)
ipcMain.handle('preview:frameOf', async (_e, p: Project, time: number, w: number, h: number) => {
  const total = projectOf(p);
  if (total <= 0) return null;
  const out = join(cacheDir('frames'), `try_${createHash('sha1').update(JSON.stringify(p)).update(String(time)).digest('hex').slice(0, 12)}.png`);
  if (!existsSync(out)) {
    const t = Math.max(0, Math.min(time, total - 1 / p.settings.fps));
    const c = await compile(p, { mode: 'frame', output: out, from: t, to: Math.min(total, t + 2 / p.settings.fps + 0.01), width: w, height: h, audio: false });
    await runFfmpeg(c.args, { cwd: c.cwd });
  }
  return dataUrl(out);
});
ipcMain.handle('preview:frame', async (_e, time: number, w: number, h: number) => {
  const key = createHash('sha1').update(JSON.stringify(editor.project)).update(`|${time.toFixed(3)}|${w}x${h}`).digest('hex');
  const hit = frameCache.get(key);
  if (hit) return hit;
  frameJob?.abort();
  const job = new AbortController();
  frameJob = job;
  const p: Project = JSON.parse(JSON.stringify(editor.project));
  const total = projectOf(p);
  if (total <= 0) return null;
  const out = join(cacheDir('frames'), `pv_${key.slice(0, 12)}.png`);
  const t = Math.max(0, Math.min(time, total - 1 / p.settings.fps));
  const c = await compile(p, { mode: 'frame', output: out, from: t, to: Math.min(total, t + 2 / p.settings.fps + 0.01), width: w, height: h, audio: false });
  try {
    await runFfmpeg(c.args, { cwd: c.cwd, signal: job.signal });
  } catch (e) {
    if (job.signal.aborted) return null; // a newer frame was requested
    throw e;
  }
  const url = dataUrl(out);
  frameCache.set(key, url);
  if (frameCache.size > 80) frameCache.delete(frameCache.keys().next().value!);
  return url;
});
function projectOf(p: Project) {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, c.start + (c.out - c.in) / c.speed);
  return d;
}

let stream: { id: number; kill: () => void } | null = null;
let streamSeq = 0;
// the renderer picks the stream id before asking, so the very first bytes (the MP4 header) are never dropped
ipcMain.handle('preview:play', async (_e, from: number, w: number, h: number, wanted?: number) => {
  stream?.kill();
  const id = wanted ?? ++streamSeq;
  streamSeq = id;
  const p: Project = JSON.parse(JSON.stringify(editor.project));
  const c = await compile(p, { mode: 'preview', output: 'pipe:1', from, width: w, height: h });
  if (id !== streamSeq) return null;
  // playback is interactive: normal priority, and the pending still-frame render must not compete with it
  frameJob?.abort();
  const child = spawnFfmpeg(c.args, c.cwd, false);
  let err = '';
  child.stdout!.on('data', (d: Buffer) => win?.webContents.send('preview:data', id, d));
  child.stderr!.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-3000); });
  child.on('close', (code) => win?.webContents.send('preview:end', id, code === 0 || code === null ? null : err.split('\n').slice(-6).join('\n')));
  stream = { id, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  return { id, duration: c.duration };
});
ipcMain.handle('preview:stop', () => { stream?.kill(); stream = null; });

// ───────────────────────── export ─────────────────────────
let exportJob: AbortController | null = null;
ipcMain.handle('export:start', async (_e, o: Parameters<typeof exportProject>[1]) => {
  exportJob = new AbortController();
  settings.exportDir = dirname(o.output);
  saveSettings();
  try {
    const { project, ...rest } = o as typeof o & { project?: Project };
    // compositions used as clips are re-rendered first if they changed
    if (await ensureCompMedia(editor, (f) => win?.webContents.send('task', { name: 'Procesando composiciones', progress: f }))) pushState('comps');
    if (project) for (const m of project.media) { const cur = editor.project.media.find((x) => x.id === m.id); if (cur?.compId) Object.assign(m, cur); }
    const r = await exportProject(project ?? JSON.parse(JSON.stringify(editor.project)), { ...rest, signal: exportJob.signal, onProgress: (f) => win?.webContents.send('export:progress', f) });
    return { ...r, info: mediaInfo(r.path) };
  } finally {
    exportJob = null;
  }
});
ipcMain.handle('export:cancel', () => exportJob?.abort());

// ───────────────────────── advanced mode ─────────────────────────
const MOTION_OPS = new Set(Object.keys(motion.motionOps));
registerScripting({ editor: () => editor, win: () => win, dlg });
registerWarpStab({ editor: () => editor, win: () => win });
registerImport({ editor: () => editor, win: () => win });
registerRoto({ editor: () => editor, win: () => win });
ipcMain.handle('motion', async (_e, name: string, ...args: unknown[]) => {
  // one undo step per call, whatever the operation does inside
  if (name === 'presetApply') return editor.batch(async () => motion.presetApply(editor, ...(args as [string, string, string[], object])));
  if (name === 'templateBuild') return editor.batch(async () => motion.templateBuild(editor, ...(args as [string, object])));
  // the motion tracker reads the video with ffmpeg (main process), then keys like any operation
  if (name === 'track') return editor.batch(async () => trackLayer(editor, ...(args as [string, string, TrackOptions])));
  if (name === 'audioToKeys') return editor.batch(async () => audioToKeys(editor, ...(args as [string, { layers?: string[]; from?: number; to?: number }])));
  // layered files and templates read / write files (main process)
  if (name === 'cameraTrack') return editor.batch(async () => cameraTrack(editor, ...(args as [string, string, CameraTrackOptions])));
  if (name === 'exrImport') return editor.batch(async () => exrImport(editor, ...(args as [string, { sequence?: boolean }])));
  if (name === 'psdImport') return editor.batch(async () => (/\.(ai|pdf)$/i.test(args[0] as string) ? aiImport(editor, args[0] as string) : psdImport(editor, ...(args as [string, { editableText?: boolean }]))));
  if (name === 'templateImport') return editor.batch(async () => motion.templateImport(editor, JSON.parse(readFileSync(args[0] as string, 'utf8')) as motion.MotionTemplate));
  if (name === 'lottieExport') { const r = compToLottie(editor.project, args[0] as string); writeFileSync(args[1] as string, JSON.stringify(r.json)); return { file: args[1], warnings: r.warnings }; }
  if (name === 'templateExport') { writeFileSync(args[1] as string, JSON.stringify(motion.templateExport(editor.project, args[0] as string), null, 1)); return args[1]; }
  if (name === 'trackMask') return editor.batch(async () => trackMask(editor, ...(args as [string, string, string, MaskTrackOptions])));
  if (!MOTION_OPS.has(name)) throw new Error(`Operación no permitida: ${name}`);
  return editor.batch(async () => (motion.motionOps as unknown as Record<string, (e: Editor, ...a: unknown[]) => unknown>)[name](editor, ...args));
});
let compJob: AbortController | null = null;
ipcMain.handle('motion:export', async (_e, compId: string, output: string, o: { format?: string; from?: number; to?: number; scale?: number; quality?: 'high' | 'medium' | 'low' } = {}) => {
  compJob = new AbortController();
  settings.exportDir = dirname(output);
  saveSettings();
  try {
    const r = await renderCompToFile(JSON.parse(JSON.stringify(editor.project)), compId, output, { ...o, signal: compJob.signal, onProgress: (f) => win?.webContents.send('export:progress', f) });
    return { ...r, info: r.format === 'png' ? null : mediaInfo(r.path) };
  } finally { compJob = null; }
});
ipcMain.handle('motion:cancel', () => compJob?.abort());
// ── disk cache (After Effects' Disk Cache): preview frames as PNG, keyed by their content ──
function cacheOf(): DiskCache | null {
  const s = settings.diskCache ?? { maxGB: 10, on: true };
  if (!s.on) return null;
  const dir = s.dir ?? join(cacheDir(), 'diskcache');
  if (!diskCache || diskCache.dir !== dir) diskCache = new DiskCache(dir, s.maxGB * 1024 ** 3, engineId(app.getVersion()));
  diskCache.maxBytes = s.maxGB * 1024 ** 3;
  return diskCache;
}
let fillJob: AbortController | null = null;
ipcMain.handle('cache:get', (_e, version: number, compId: string, frame: number, o: FrameOpts) => {
  const dc = cacheOf();
  if (!dc || version !== stateVersion || !editor.project.comps?.some((c) => c.id === compId)) return null;
  const key = dc.key(editor.project, compId, frame, o);
  return { key, png: dc.get(key) };
});
/** frames offered to / dropped by the disk cache (a stale version means the project changed meanwhile) */
const cachePuts = { got: 0, stale: 0 };
ipcMain.handle('cache:put', (_e, version: number, key: string, png: Uint8Array) => { cachePuts.got++; if (version === stateVersion) cacheOf()?.put(key, png); else cachePuts.stale++; });
ipcMain.handle('cache:status', (_e, compId: string, o: FrameOpts) => {
  const dc = cacheOf(), c = editor.project.comps?.find((x) => x.id === compId);
  if (!dc || !c) return null;
  return dc.status(editor.project, compId, 0, Math.round(c.duration * c.fps), o);
});
ipcMain.handle('cache:info', () => ({ ...(cacheOf()?.info() ?? { dir: '', bytes: 0, frames: 0, maxBytes: 0 }), puts: cachePuts, version: stateVersion, on: settings.diskCache?.on ?? true, maxGB: settings.diskCache?.maxGB ?? 10 }));
ipcMain.handle('cache:clear', () => cacheOf()?.clear() ?? 0);
ipcMain.handle('cache:settings', (_e, s: { maxGB?: number; on?: boolean; dir?: string | null }) => {
  const cur = settings.diskCache ?? { maxGB: 10, on: true };
  settings.diskCache = { ...cur, ...(s.maxGB !== undefined ? { maxGB: Math.max(1, Math.min(10000, s.maxGB)) } : {}), ...(s.on !== undefined ? { on: s.on } : {}), ...(s.dir !== undefined ? { dir: s.dir ?? undefined } : {}) };
  saveSettings();
  cacheOf()?.trim();
  return settings.diskCache;
});
ipcMain.handle('cache:fill', async (_e, compId: string, o: FrameOpts) => {
  const dc = cacheOf();
  if (!dc) throw new Error('La caché de disco está desactivada.');
  fillJob?.abort();
  fillJob = new AbortController();
  const job = fillJob;
  try {
    return await fillDiskCache(JSON.parse(JSON.stringify(editor.project)), compId, dc, { ...o, signal: job.signal, onProgress: (f) => win?.webContents.send('task', { name: 'Caché de disco: área de trabajo', progress: f }) });
  } finally { if (fillJob === job) fillJob = null; win?.webContents.send('task', null); }
});
ipcMain.handle('cache:stop', () => fillJob?.abort());

// render queue: statuses and logs are written straight into the project (not undo steps, as in After Effects)
ipcMain.handle('motion:queueRender', async () => {
  compJob = new AbortController();
  const setItem = (id: string, patch: Partial<motion.RenderItem>) => { const it = editor.project.renderQueue?.find((x) => x.id === id); if (it) { Object.assign(it, patch); dirty = true; pushState('Cola de render'); } };
  try {
    const base = editor.path ? dirname(editor.path) : settings.exportDir ?? join(app.getPath('videos'), 'Cinta');
    const results = await runRenderQueue(JSON.parse(JSON.stringify(editor.project)), base, {
      signal: compJob.signal,
      onItem: (id, status) => setItem(id, { status }),
      onProgress: (n, total, f) => win?.webContents.send('export:progress', (n + f) / total),
    });
    for (const r of results) setItem(r.id, { status: r.status, log: r.log });
    return results;
  } finally { compJob = null; }
});
// proxies: footage (ffmpeg, next to the project) or comp (rendered with alpha)
ipcMain.handle('motion:proxyCreate', async (_e, kind: 'media' | 'comp', id: string, scale?: number) => {
  const dir = join(editor.path ? dirname(editor.path) : cacheDir('proxies'), 'Proxies');
  const progress = (f: number) => win?.webContents.send('task', { name: 'Creando proxy', progress: f });
  try {
    if (kind === 'media') {
      const m = editor.project.media.find((x) => x.id === id);
      if (!m) throw new Error('Ese archivo ya no está en el proyecto.');
      const px = await createFootageProxy(m, dir, scale ?? 0.5, progress);
      return motion.motionOps.mediaProxySet(editor, id, { path: px.path, width: px.width, height: px.height, on: true });
    }
    const r = await renderCompProxy(JSON.parse(JSON.stringify(editor.project)), id, dir, scale ?? 1, progress);
    return motion.motionOps.compProxySet(editor, id, { path: r.path, hash: r.hash, on: true });
  } finally { win?.webContents.send('task', null); }
});
ipcMain.handle('motion:still', (_e, compId: string, t: number, output: string, scale = 1) => renderCompStill(JSON.parse(JSON.stringify(editor.project)), compId, t, output, scale));
ipcMain.handle('motion:audio', async (_e, compId: string) => compAudioFile(editor.project, compId));
ipcMain.handle('motion:sequence', async () => ensureSequence(editor.project));
ipcMain.handle('motion:toTimeline', async (_e, compId: string, o: { trackId?: string; at?: number } = {}) => {
  try { return await compToTimeline(editor, compId, o, (f) => win?.webContents.send('task', { name: 'Procesando la composición', progress: f })); } finally { win?.webContents.send('task', null); }
});
ipcMain.handle('motion:sync', async () => {
  try { if (await ensureCompMedia(editor, (f) => win?.webContents.send('task', { name: 'Procesando composiciones', progress: f }))) pushState('comps'); } finally { win?.webContents.send('task', null); }
});
ipcMain.handle('export:dir', () => settings.exportDir ?? join(app.getPath('videos'), 'Cinta'));
ipcMain.handle('export:mlt', async () => {
  const r = await dlg.showSaveDialog(win!, { title: 'Exportar a Shotcut / Kdenlive', defaultPath: join(app.getPath('documents'), `${editor.project.name || 'Proyecto'}.mlt`), filters: [{ name: 'MLT XML', extensions: ['mlt'] }] });
  if (r.canceled || !r.filePath) return null;
  const { xml, skipped } = toMlt(editor.project);
  writeFileSync(r.filePath, xml, 'utf8');
  return { path: r.filePath, skipped };
});
ipcMain.handle('export:srt', async () => {
  const r = await dlg.showSaveDialog(win!, { title: 'Exportar subtítulos', defaultPath: join(app.getPath('documents'), `${editor.project.name || 'Proyecto'}.srt`), filters: [{ name: 'Subtítulos SubRip', extensions: ['srt'] }] });
  if (r.canceled || !r.filePath) return null;
  return exportSubtitles(editor, r.filePath);
});
ipcMain.handle('snapshot', async (_e, time: number) => {
  const r = await dlg.showSaveDialog(win!, { title: 'Guarde una instantánea', defaultPath: join(app.getPath('pictures'), `Cinta ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`), filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (r.canceled || !r.filePath) return null;
  const { renderFrame } = await import('../core/export');
  return renderFrame(editor.project, time, { output: r.filePath });
});

// ───────────────────────── recording, generated media ─────────────────────────
ipcMain.handle('record:save', (_e, data: ArrayBuffer, ext: string) => {
  const dir = join(app.getPath('documents'), 'Cinta', 'Grabaciones');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `Grabación ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`);
  writeFileSync(path, Buffer.from(data));
  return path;
});
ipcMain.handle('generate', (_e, kind: 'music' | 'sfx', name: string, duration?: number) => generateMedia(kind, name, { duration }));
ipcMain.handle('shot:record', () => {
  const candidates = [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'shot', 'Shot.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Shot', 'Shot.exe')];
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) return false;
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  spawn(exe, ['--record'], { detached: true, stdio: 'ignore' }).unref();
  return true;
});

// ───────────────────────── preferences / MCP ─────────────────────────
ipcMain.handle('prefs:get', async () => ({ settings, mcp: await clientInfo(), whisper: findWhisperModel(settings.whisperDir)?.encoder ?? null, version: app.getVersion(), userData: app.getPath('userData') }));
ipcMain.handle('prefs:set', (_e, patch: Partial<Settings>) => { settings = { ...settings, ...patch }; saveSettings(); return settings; });
ipcMain.handle('mcp:add', async (_e, which: 'desktop' | 'code') => {
  preparePortableRuntime();
  if (which === 'desktop') registerDesktop(); else await registerCode();
  return clientInfo();
});
ipcMain.handle('mcp:remove', async () => { await unregisterAll(); settings.mcpAuto = false; saveSettings(); return clientInfo(); });

// ───────────────────────── lifecycle ─────────────────────────
app.on('second-instance', (_e, args) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const file = args.find((a) => a.toLowerCase().endsWith('.cinta') && existsSync(a));
  if (file) void openProject(file);
});

void app.whenReady().then(async () => {
  if (argv.includes('--uninstall-mcp')) return;
  handleMediaProtocol();
  setDirs(join(__dirname, '..', 'preload'), join(__dirname, '..', 'renderer'));
  if (renderJob) {
    try { await runRenderCli(resolve(renderJob)); } finally { closeRenderWindow(); app.exit(0); }
    return;
  }
  loadSettings();
  buildMenu();
  attach(editor); // the start-up project must notify the window too, not only opened ones
  createWindow();
  initUpdates({
    window: () => win,
    settings: () => settings.updates ?? { auto: true },
    save: (u) => { settings.updates = u; saveSettings(); },
    prepareQuit: async () => { if (!(await confirmDiscard())) return false; dirty = false; return true; },
    test: !!selftest,
    dialog: dlg,
  });
  const file = argv.find((a) => a.toLowerCase().endsWith('.cinta') && existsSync(a));
  win!.webContents.once('did-finish-load', () => {
    if (file) void openProject(resolve(file));
    else pushState('init');
    if (selftest) void runSelfTest(win!, { get editor() { return editor; }, attach, saveTo, autosaveNow, checkRecovery, autosaveFile }, selftest.split('=')[1]);
    else void checkRecovery();
  });
  setInterval(() => { try { autosaveNow(); } catch { /* disk full: try again next time */ } }, Number(process.env.CINTA_AUTOSAVE_MS) || 60_000);
  if (!selftest && settings.mcpAuto && autoRegisterAllowed()) {
    try {
      const r = await syncClients(settings.mcp);
      settings.mcp = r.record;
      saveSettings();
      if (r.added.length && win) {
        void dlg.showMessageBox(win, { type: 'info', title: 'Cinta', message: `Cinta se conectó a ${r.added.join(' y ')}.`, detail: 'Reinicie esas aplicaciones para que la IA pueda editar vídeos con Cinta. Puede desactivarlo en Configuración → Preferencias.' });
      }
    } catch { /* never block startup */ }
  }
});
app.on('window-all-closed', () => app.quit());
// a normal exit (saved, or the user chose not to save) leaves nothing to recover
app.on('will-quit', () => { if (!selftest) clearAutosave(); });
