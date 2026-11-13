// Global error handling of the main process. Without it Electron shows its own English dialog ("A JavaScript error
// occurred in the main process") with a raw stack and the work may be lost. Here every error is written to
// logs/errores.log, the project is autosaved first, and the user sees a Spanish dialog that lets them keep working,
// copy the details, open the log folder or restart. A crashed or frozen window can be reloaded without losing the
// project, because the project lives in the main process.
import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { appendErrorLog, describeError, errorKey, formatEntry, type ErrorEntry } from '../core/errlog';

export interface CrashHooks {
  window: () => BrowserWindow | null;
  /** saves the project to the recovery file; returns false when there was nothing to save */
  autosave: () => boolean;
  /** called after the window has been reloaded, to send it the project again */
  reloaded: () => void;
  /** self-test: log only, never block with a dialog */
  quiet: boolean;
}

export const logDir = () => join(app.getPath('userData'), 'logs');

let hooks: CrashHooks | null = null;
let showing = false;
const shown = new Set<string>();

/** Writes an error to the log (also from IPC: errors of the window) and returns the entry. */
export function logError(e: unknown, origin: string): ErrorEntry {
  const x = describeError(e, origin);
  appendErrorLog(logDir(), x);
  try { process.stderr.write(formatEntry(x)); } catch { /* closed pipe */ }
  return x;
}

async function report(x: ErrorEntry, title: string, saved: boolean) {
  if (!hooks || hooks.quiet || showing || shown.has(errorKey(x))) return;
  shown.add(errorKey(x));
  showing = true;
  try {
    const win = hooks.window();
    const opts = {
      type: 'error' as const,
      title: 'Cinta',
      message: title,
      detail: `${x.message}\n\n${saved ? 'Su proyecto se ha guardado en la copia de recuperación: si Cinta se cierra, se le ofrecerá recuperarlo al abrirla de nuevo.' : 'No había cambios sin guardar.'}\n\nEl error se ha anotado en ${join(logDir(), 'errores.log')}.`,
      buttons: ['Seguir trabajando', 'Copiar detalles', 'Abrir carpeta de registros', 'Reiniciar Cinta'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    for (;;) {
      const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response === 1) { clipboard.writeText(`Cinta ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron}\n${formatEntry(x)}`); continue; }
      if (response === 2) { void shell.openPath(logDir()); continue; }
      if (response === 3) { app.relaunch(); app.exit(0); }
      break;
    }
  } finally { showing = false; }
}

function trySave(): boolean {
  try { return hooks?.autosave() ?? false; } catch { return false; }
}

/** Call once, before the app is ready. */
export function installCrashHandlers(h: CrashHooks) {
  hooks = h;
  process.on('uncaughtException', (e) => {
    const x = logError(e, 'principal');
    void report(x, 'Se ha producido un error inesperado en Cinta.', trySave());
  });
  // a rejected promise nobody awaited: usually a failed background task (thumbnail, waveform…), not fatal
  process.on('unhandledRejection', (e) => { logError(e, 'promesa'); });
  app.on('child-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit' && d.reason !== 'killed') logError(`${d.type} terminó (${d.reason}, código ${d.exitCode})`, 'subproceso');
  });
}

/** Watches the main window: crash of its renderer and "not responding". */
export function watchWindow(win: BrowserWindow) {
  let reloading = false;
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit' || !hooks) return;
    if (reloading) { reloading = false; return; }
    const x = logError(`La ventana se cerró de forma inesperada (${d.reason}, código ${d.exitCode})`, 'ventana');
    if (hooks.quiet) return;
    const saved = trySave();
    void dialog.showMessageBox({
      type: 'error', title: 'Cinta', noLink: true,
      message: 'La ventana de Cinta ha dejado de funcionar.',
      detail: `${x.message}\n\nSu proyecto sigue abierto${saved ? ' y se ha guardado en la copia de recuperación' : ''}. Pulse «Recargar la ventana» para seguir trabajando.`,
      buttons: ['Recargar la ventana', 'Cerrar Cinta'], defaultId: 0, cancelId: 0,
    }).then(({ response }) => {
      if (response === 1 || win.isDestroyed()) { app.exit(0); return; }
      win.webContents.once('did-finish-load', () => hooks?.reloaded());
      win.reload();
    });
  });
  let asking = false;
  win.on('unresponsive', () => {
    if (!hooks || hooks.quiet || asking) return;
    asking = true;
    logError('La ventana no responde', 'ventana');
    void dialog.showMessageBox(win, {
      type: 'warning', title: 'Cinta', noLink: true,
      message: 'Cinta no responde.',
      detail: 'Puede que esté terminando una tarea larga (un render, un análisis…). Puede esperar o recargar la ventana: el proyecto no se pierde.',
      buttons: ['Esperar', 'Recargar la ventana'], defaultId: 0, cancelId: 0,
    }).then(({ response }) => {
      asking = false;
      if (response !== 1 || win.isDestroyed()) return;
      trySave();
      win.webContents.once('did-finish-load', () => hooks?.reloaded());
      reloading = true;
      win.webContents.forcefullyCrashRenderer();
      win.reload();
    });
  });
  win.on('responsive', () => { asking = false; });
}
