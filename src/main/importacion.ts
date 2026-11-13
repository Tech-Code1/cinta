// Main-process side of «importacion»: image sequences (the «Secuencia PNG» option), Interpretar material de
// archivo, Premiere Pro projects and Maya cameras; the import preferences (Preferencias ▸ Importar) live in
// import-prefs.json in the user data folder.
import { app, ipcMain, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Editor } from '../core';
import { detectSequence, describeFootage, formatName, importFootage, interpretFootage, seqName, sequenceInFolder, SEQ_EXT, SEQUENCE_FPS, type Interpretation } from '../core/footage';
import { prprojImport, readPrproj } from '../core/prproj';
import { mayaImport } from '../core/mayacam';

export interface ImportPrefs { sequenceFps: number; reportMissing: boolean; sequence: boolean; alphabetical: boolean }
const prefsFile = () => join(app.getPath('userData'), 'import-prefs.json');
export function importPrefs(): ImportPrefs {
  const def: ImportPrefs = { sequenceFps: SEQUENCE_FPS, reportMissing: true, sequence: true, alphabetical: false };
  try { return { ...def, ...JSON.parse(readFileSync(prefsFile(), 'utf8')) }; } catch { return def; }
}

export function registerImport(o: { editor: () => Editor; win: () => BrowserWindow | null }) {
  const task = (name: string) => (f: number) => o.win()?.webContents.send('task', f >= 1 ? null : { name, progress: f });
  ipcMain.handle('import:prefs', (_e, patch?: Partial<ImportPrefs>) => {
    if (patch) { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(prefsFile(), JSON.stringify({ ...importPrefs(), ...patch }, null, 1)); }
    return importPrefs();
  });
  /** What the import dialog shows for the files chosen: is one of them part of a numbered sequence? */
  ipcMain.handle('import:detect', (_e, paths: string[]) => paths.map((p) => {
    const folder = existsSync(p) && statSync(p).isDirectory();
    const f = folder ? sequenceInFolder(p) : p;
    const s = f && SEQ_EXT.includes(extname(f).toLowerCase()) ? detectSequence(f) : null;
    return { path: p, folder, first: f, format: f ? formatName(f) : '', sequence: s ? { name: seqName(s), frames: s.last - s.first + 1, missing: s.missing.length } : null };
  }));
  ipcMain.handle('import:footage', async (_e, paths: string[], opts: { sequence?: boolean; alphabetical?: boolean; interpret?: Interpretation } = {}) => {
    const pr = importPrefs(), done = task('Importando material de archivo');
    try {
      const r = await o.editor().batch(() => importFootage(o.editor(), paths, { ...opts, sequenceFps: pr.sequenceFps, onProgress: done }));
      return { media: r.media.map((m) => ({ id: m.id, kind: m.kind, width: m.width, height: m.height, name: m.footage?.name ?? basename(m.path) })), notes: pr.reportMissing ? r.notes : r.notes.filter((n) => !/fotograma/.test(n)) };
    } finally { done(1); }
  });
  ipcMain.handle('import:describe', async (_e, mediaId: string) => {
    const m = o.editor().media(mediaId);
    if (m.footage) return m.footage;
    return describeFootage(m.exr?.source ?? m.path, { sequence: !!m.exr?.pattern, interpret: m.exr?.fps ? { fps: m.exr.fps } : {} }).then((f) => ({ ...f, nativeFps: f.nativeFps || m.fps }));
  });
  ipcMain.handle('import:interpret', async (_e, mediaId: string, interp: Interpretation) => {
    const done = task('Interpretando material de archivo');
    try { const m = await o.editor().batch(() => interpretFootage(o.editor(), mediaId, interp, done)); return { id: m.id, duration: m.duration, fps: m.fps }; } finally { done(1); }
  });
  ipcMain.handle('import:prprojInfo', (_e, path: string) => readPrproj(readFileSync(path)).sequences.map((s) => ({ id: s.id, name: s.name, width: s.width, height: s.height, fps: s.fps, duration: s.duration, tracks: s.tracks.length })));
  ipcMain.handle('import:prproj', async (_e, path: string, opts: { target?: 'comps' | 'timeline'; sequence?: string; audio?: boolean }) => {
    const done = task('Cargando proyecto de Premiere Pro');
    try {
      const r = await o.editor().batch(() => prprojImport(o.editor(), path, opts));
      return { comps: r.comps.map((c) => ({ id: c.id, name: c.name })), clips: r.clips, layers: r.layers, missing: r.missing, warnings: r.warnings };
    } finally { done(1); }
  });
  ipcMain.handle('import:maya', async (_e, path: string, opts: { compId?: string; origin?: 'corner' | 'center' } = {}) => {
    const r = await o.editor().batch(async () => mayaImport(o.editor(), path, opts));
    return { comp: { id: r.comp.id, name: r.comp.name }, cameras: r.cameras.length, nulls: r.nulls.length, frames: r.frames, warnings: r.warnings };
  });
}
