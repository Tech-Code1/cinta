// Automatic updates (electron-updater, MIT) from the GitHub Releases of Cinta (publish: in electron-builder.yml).
// Nothing is downloaded without asking: Cinta checks on start and every 6 hours, offers the new version with its
// notes, downloads it in the background (progress in the status bar) and installs it on restart or on quit.
// CINTA_UPDATE_URL=<folder url> uses a plain web folder instead (tests, mirrors); with it an unpackaged build can
// check too.
import { app, dialog as realDialog, shell, type BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { checkDue, notesText, shouldOffer, updateBlock, UPDATE_BLOCK_TEXT, UPDATE_DEFAULTS, UPDATE_INTERVAL, type UpdateSettings } from '../core/updates';
import { logError } from './errors';

export interface UpdateHost {
  window: () => BrowserWindow | null;
  settings: () => UpdateSettings;
  save: (s: UpdateSettings) => void;
  /** ask to save the project; false = the user cancelled */
  prepareQuit: () => Promise<boolean>;
  /** self-test: blocked unless CINTA_UPDATE_URL is set; then nothing is installed on quit */
  test: boolean;
  /** the self-test answers dialogs (testdialogs.ts) */
  dialog?: Pick<typeof realDialog, 'showMessageBox'>;
}

export const RELEASES_URL = 'https://github.com/Tech-Code1/cinta/releases';

let host: UpdateHost | null = null;
let busy: 'checking' | 'downloading' | 'ready' | null = null;
let ready: UpdateInfo | null = null;

const feed = () => process.env.CINTA_UPDATE_URL;
const block = () => updateBlock({ packaged: app.isPackaged, portable: !!process.env.PORTABLE_EXECUTABLE_DIR, test: !!host?.test && !feed(), feed: feed() });

export function updateStatus() {
  const b = block();
  return { available: !b, reason: b ? UPDATE_BLOCK_TEXT[b] : '', busy, ready: ready?.version ?? null, version: app.getVersion(), releases: RELEASES_URL };
}

function box(o: Electron.MessageBoxOptions) {
  const d = (host?.dialog ?? realDialog) as typeof realDialog, win = host?.window();
  return win && !win.isDestroyed() ? d.showMessageBox(win, o) : d.showMessageBox(o);
}

let configured = '';
/** electron-updater settings; a CINTA_UPDATE_URL feed gets its own config file (and, in tests, its own download
 *  folder, so a test never leaves a pending update for the installed Cinta). */
function configure() {
  const url = feed() ?? '';
  if (configured === (url || '-')) return;
  if (!configured) autoUpdater.on('download-progress', (p) => task({ name: 'Descargando la actualización de Cinta', progress: p.percent / 100 }));
  configured = url || '-';
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = !host?.test;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  if (url) {
    const f = join(app.getPath('userData'), 'update-feed.yml');
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(f, `provider: generic
url: ${JSON.stringify(url)}
updaterCacheDirName: ${host?.test ? 'cinta-updater-test' : 'cinta-updater'}
`);
    autoUpdater.updateConfigPath = f;
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  }
}
const task = (t: { name: string; progress: number } | null) => host?.window()?.webContents.send('task', t);

export function initUpdates(h: UpdateHost) {
  host = h;
  if (block()) return;
  configure();
  const tick = () => { if (checkDue(host!.settings(), Date.now())) void checkForUpdates(false); };
  setTimeout(tick, 15_000);
  setInterval(tick, UPDATE_INTERVAL / 6).unref();
}

/** manual = from the menu or Preferences: always checks and says "Cinta está al día" / the error. */
export async function checkForUpdates(manual: boolean): Promise<string> {
  const b = block();
  if (b) { if (manual) await box({ type: 'info', title: 'Cinta', message: UPDATE_BLOCK_TEXT[b], buttons: ['Aceptar'], noLink: true }); return UPDATE_BLOCK_TEXT[b]; }
  if (ready) { if (manual) await offerRestart(ready); return `Cinta ${ready.version} está lista para instalarse.`; }
  if (busy) return busy === 'checking' ? 'Ya se están buscando actualizaciones.' : 'Ya se está descargando la actualización.';
  configure();
  busy = 'checking';
  const s = { ...UPDATE_DEFAULTS, ...host!.settings() };
  try {
    const r = await autoUpdater.checkForUpdates();
    host!.save({ ...s, last: Date.now() });
    const info = r?.updateInfo;
    busy = null;
    if (!info || !shouldOffer(app.getVersion(), info.version, s, manual)) {
      if (manual) await box({ type: 'info', title: 'Cinta', message: 'Cinta está al día.', detail: `Tiene la versión ${app.getVersion()}, la más reciente.`, buttons: ['Aceptar'], noLink: true });
      return 'Cinta está al día.';
    }
    const notes = notesText(info.releaseNotes);
    const { response } = await box({
      type: 'info', title: 'Cinta', noLink: true,
      message: `Hay una nueva versión de Cinta: ${info.version}`,
      detail: `Tiene la ${app.getVersion()}.${notes ? `\n\nNovedades:\n${notes}` : ''}\n\nSe descarga en segundo plano y se instala al reiniciar Cinta.`,
      buttons: ['Descargar', 'Más tarde', 'Omitir esta versión'], defaultId: 0, cancelId: 1,
    });
    if (response === 2) { host!.save({ ...s, last: Date.now(), skip: info.version }); return `Se omitirá la versión ${info.version}.`; }
    if (response !== 0) return 'Más tarde.';
    busy = 'downloading';
    await autoUpdater.downloadUpdate();
    task(null);
    ready = info;
    busy = 'ready';
    void offerRestart(info);
    return `Cinta ${info.version} descargada.`;
  } catch (e) {
    busy = null;
    task(null);
    const x = logError(e, 'actualizaciones');
    if (manual) {
      const { response } = await box({ type: 'warning', title: 'Cinta', noLink: true, message: 'No se pudo buscar actualizaciones.', detail: `${x.message}\n\nCompruebe la conexión a Internet o descargue la versión nueva desde la página de Cinta.`, buttons: ['Aceptar', 'Abrir la página de descargas'], defaultId: 0, cancelId: 0 });
      if (response === 1) void shell.openExternal(RELEASES_URL);
    }
    return `Error: ${x.message}`;
  }
}

async function offerRestart(info: UpdateInfo) {
  const { response } = await box({
    type: 'info', title: 'Cinta', noLink: true,
    message: `Cinta ${info.version} está lista para instalarse.`,
    detail: 'Reinicie ahora o se instalará sola cuando cierre Cinta.',
    buttons: ['Reiniciar ahora', 'Al cerrar Cinta'], defaultId: 0, cancelId: 1,
  });
  if (response !== 0 || !(await host!.prepareQuit())) return;
  // silent installer (same options as last time), then Cinta opens again
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
