// Main-process side of «ia»: the Roto Brush propagation and Content-Aware Fill run here (ffmpeg + pure TypeScript),
// with their progress sent to the window («Propagación de Pincel tipo rotoscopia @0 de @1», «Procesando (@0 de @1)...»).
import { ipcMain, type BrowserWindow } from 'electron';
import type { Editor } from '../core';
import { rotoPropagate } from '../core/roto-analyze';
import { cafReferenceFrame, contentAwareFill, type CafOptions } from '../core/caf';

export function registerRoto(o: { editor: () => Editor; win: () => BrowserWindow | null }) {
  const jobs = new Map<string, AbortController>();
  ipcMain.handle('roto:propagate', async (_e, compId: string, layerId: string, force?: boolean) => {
    jobs.get(layerId)?.abort();
    const ac = new AbortController();
    jobs.set(layerId, ac);
    const send = (done: number, total: number) => o.win()?.webContents.send('roto:progress', layerId, done, total);
    try {
      send(0, 1);
      return await o.editor().batch(() => rotoPropagate(o.editor(), compId, layerId, { signal: ac.signal, force, onProgress: send }));
    } finally {
      if (jobs.get(layerId) === ac) jobs.delete(layerId);
      send(-1, 1);
    }
  });
  ipcMain.handle('roto:cancel', (_e, layerId: string) => { jobs.get(layerId)?.abort(); });
  let caf: AbortController | null = null;
  const cafRun = async <T>(fn: (o: CafOptions) => Promise<T>, opts: CafOptions) => {
    caf?.abort();
    const ac = new AbortController();
    caf = ac;
    const send = (msg: string, frac: number) => o.win()?.webContents.send('caf:progress', msg, frac);
    try { return await o.editor().batch(() => fn({ ...opts, signal: ac.signal, onProgress: send })); } finally { if (caf === ac) caf = null; send('', -1); }
  };
  ipcMain.handle('caf:generate', (_e, compId: string, layerId: string, opts: CafOptions) => cafRun((x) => contentAwareFill(o.editor(), compId, layerId, x), opts));
  ipcMain.handle('caf:reference', (_e, compId: string, layerId: string, t: number, opts: CafOptions) => cafRun((x) => cafReferenceFrame(o.editor(), compId, layerId, t, x), opts));
  ipcMain.handle('caf:cancel', () => caf?.abort());
}
