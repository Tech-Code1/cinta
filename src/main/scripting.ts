// Main-process side of «datos y scripting»: Archivo ▸ Scripts ▸ Ejecutar archivo de secuencias de comandos (After
// Effects scripts run on the open project, one undo step) and data footage read from disk (import / reload).
import { ipcMain, type BrowserWindow, type dialog } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { motion, runScriptFile, type Editor, type ScriptResult } from '../core';

let lastDir: string | undefined;
export function registerScripting(o: { editor: () => Editor; win: () => BrowserWindow | null; dlg: typeof dialog }) {
  ipcMain.handle('script:run', async (_e, file: string | null, activeComp?: string | null): Promise<(ScriptResult & { file: string }) | null> => {
    let f = file;
    if (!f) {
      const r = await o.dlg.showOpenDialog(o.win()!, { title: 'Ejecutar archivo de secuencias de comandos', defaultPath: lastDir, filters: [{ name: 'Archivo de Adobe ExtendScript', extensions: ['jsx', 'js'] }, { name: 'Todos los archivos', extensions: ['*'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return null;
      f = r.filePaths[0];
    }
    lastDir = dirname(f);
    return { ...(await runScriptFile(o.editor(), f, { activeComp })), file: f };
  });
  ipcMain.handle('data:import', async (_e, paths: string[] | null) => {
    let ps = paths;
    if (!ps?.length) {
      const r = await o.dlg.showOpenDialog(o.win()!, { title: 'Importar archivo de datos', filters: [{ name: 'Datos (JSON, MGJSON, CSV, TSV)', extensions: motion.DATA_EXT }], properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return [];
      ps = r.filePaths;
    }
    return motion.motionOps.dataAdd(o.editor(), ps.map((p) => ({ path: p, text: readFileSync(p, 'utf8') })));
  });
  // Volver a cargar material de archivo: the file is read again and the animation follows
  ipcMain.handle('data:reload', (_e, ids: string[]) => {
    const e = o.editor();
    return e.batch(async () => ids.map((id) => { const d = (e.project.dataItems ?? []).find((x) => x.id === id); if (!d) throw new Error('No existe ese archivo de datos.'); return motion.motionOps.dataReload(e, id, readFileSync(d.path, 'utf8')); }));
  });
}
