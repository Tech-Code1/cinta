// Font files for the renderer windows (sandboxed: no file access): which installed file a text style uses and its
// bytes, so glyph outlines and variable-font axes come from the real font.
import { ipcMain } from 'electron';
import { findFont, fontBytes, fontFamilies } from '../core/fontfind';

let done = false;
export function registerFontIpc() {
  if (done) return;
  done = true;
  ipcMain.handle('font:get', (_e, family: string, weight: number, italic: boolean) => {
    const f = findFont(family, weight, italic) ?? findFont('Segoe UI', weight, italic);
    return f ? { path: f.path, index: f.index, bytes: fontBytes(f.path) } : null;
  });
  ipcMain.handle('font:families', () => fontFamilies());
}
