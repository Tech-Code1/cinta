// Media Browser and Metadata panels, main-process side: folder listings, places and ffprobe metadata for the
// sandboxed renderer.
import { ipcMain } from 'electron';
import { fileMetadata, listFolder, mediaRoots } from '../core/medios';

let done = false;
export function registerMediosIpc() {
  if (done) return;
  done = true;
  ipcMain.handle('medios:list', (_e, dir: string, o?: { all?: boolean }) => listFolder(dir, o));
  ipcMain.handle('medios:roots', () => mediaRoots());
  ipcMain.handle('medios:meta', (_e, path: string) => fileMetadata(path));
}
