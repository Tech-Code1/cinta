// Installed fonts (Windows: the system and the per-user font folders): which file holds a family / weight / style,
// read from the files' own name and OS/2 tables (only their headers are read while indexing).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { faceInfo, faceOffsets, type FaceInfo } from './motion/fontfile';

export interface FontFace extends FaceInfo { path: string; index: number }
let index: FontFace[] | null = null;

function fontDirs(): string[] {
  const out = [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')];
  if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  if (process.platform === 'darwin') out.push('/System/Library/Fonts', '/Library/Fonts', join(process.env.HOME ?? '', 'Library/Fonts'));
  if (process.platform === 'linux') out.push('/usr/share/fonts', '/usr/local/share/fonts', join(process.env.HOME ?? '', '.fonts'));
  return out.filter((d) => existsSync(d));
}

function walk(dir: string, out: string[], depth = 0) {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    if (/\.(ttf|otf|ttc|otc)$/i.test(n)) out.push(p);
    else if (depth < 3 && !n.includes('.')) { try { if (statSync(p).isDirectory()) walk(p, out, depth + 1); } catch { /* skip */ } }
  }
}

/** Every face of every installed font file (indexed once per process). */
export function fontFaces(): FontFace[] {
  if (index) return index;
  const files: string[] = [];
  for (const d of fontDirs()) walk(d, files);
  index = [];
  for (const path of files) {
    let fd = -1;
    try {
      fd = openSync(path, 'r');
      const read = (off: number, len: number) => { const b = new Uint8Array(len); readSync(fd, b, 0, len, off); return b; };
      faceOffsets(read(0, 64 * 4 + 12)).forEach((at, i) => { try { index!.push({ ...faceInfo(read, at), path, index: i }); } catch { /* broken face */ } });
    } catch { /* unreadable */ } finally { if (fd >= 0) closeSync(fd); }
  }
  return index;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** The installed face the browser would pick for a CSS family, weight and style (closest weight, italic first). */
export function findFont(family: string, weight = 400, italic = false): FontFace | null {
  const f = norm(family);
  let cands = fontFaces().filter((x) => norm(x.typoFamily ?? x.family) === f || norm(x.family) === f);
  if (!cands.length) cands = fontFaces().filter((x) => norm(x.fullName) === f);
  if (!cands.length) return null;
  const wOf = (x: FontFace) => { const a = x.axes.find((k) => k.tag === 'wght'); return a ? Math.max(a.min, Math.min(a.max, weight)) : x.weight; };
  // CSS font matching: weights above 500 look heavier first, below 400 lighter first
  const dist = (x: FontFace) => {
    const w = wOf(x);
    if (w === weight) return 0;
    if (weight > 500) return w > weight ? w - weight : 1000 + weight - w;
    if (weight < 400) return w < weight ? weight - w : 1000 + w - weight;
    return w >= weight && w <= 500 ? w - weight : w < weight ? 500 + weight - w : 1000 + w - weight;
  };
  cands.sort((a, b) => (+(a.italic !== italic) - +(b.italic !== italic)) || dist(a) - dist(b));
  return cands[0];
}

/** Bytes of the file of a face (cached). */
const bytes = new Map<string, Uint8Array>();
export function fontBytes(path: string): Uint8Array {
  let b = bytes.get(path);
  if (!b) { b = new Uint8Array(readFileSync(path)); if (bytes.size > 24) bytes.clear(); bytes.set(path, b); }
  return b;
}

/** Families installed (for pickers). */
export function fontFamilies(): string[] {
  return [...new Set(fontFaces().map((x) => x.typoFamily ?? x.family).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
