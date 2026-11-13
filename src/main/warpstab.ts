// Main-process side of the Warp Stabilizer: the background analysis of a layer's footage (ffmpeg + tracking), with
// its progress sent to the window, which draws AE's «Análisis en segundo plano (paso 1 de 2)» banner meanwhile.
import { ipcMain, type BrowserWindow } from 'electron';
import type { Editor } from '../core';
import { analyzeWarpStab } from '../core/warpstab-analyze';

export function registerWarpStab(o: { editor: () => Editor; win: () => BrowserWindow | null }) {
  const jobs = new Map<string, AbortController>();
  ipcMain.handle('warpstab:analyze', async (_e, compId: string, layerId: string, fxId: string) => {
    jobs.get(fxId)?.abort();
    const ac = new AbortController();
    jobs.set(fxId, ac);
    const send = (phase: number, frac: number) => o.win()?.webContents.send('warpstab:progress', fxId, phase, frac);
    try {
      send(1, 0);
      return await analyzeWarpStab(o.editor(), compId, layerId, fxId, { signal: ac.signal, onProgress: send });
    } finally {
      if (jobs.get(fxId) === ac) jobs.delete(fxId);
      send(0, 1);
    }
  });
  ipcMain.handle('warpstab:cancel', (_e, fxId: string) => { jobs.get(fxId)?.abort(); });
}
