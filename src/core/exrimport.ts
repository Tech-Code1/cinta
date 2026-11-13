// OpenEXR files and sequences as footage (After Effects' OpenEXR importer): the beauty (RGBA) becomes a picture
// or a movie the canvas engine shows; every other channel — depth, normals, object IDs, Cryptomatte — stays in
// the EXR and is read on demand, frame by frame, by the 3D Channel effects (EXtractoR, IDentifier, Cryptomatte).
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Editor } from './ops';
import type { ExrInfo, MediaItem } from './model';
import { runFfmpeg } from './ffmpeg';
import { cryptoLayers, cryptoSelection, readExr, readExrHeader, type CryptoLayer } from './exr';

/** The numbered files of a sequence a file belongs to ("shot.0012.exr" → shot.%04d.exr, 1…240). */
export function findSequence(path: string): { pattern: string; first: number; last: number; count: number } | null {
  const m = /^(.*?)(\d+)(\.exr)$/i.exec(basename(path));
  if (!m) return null;
  const [, pre, digits, ext] = m, dir = dirname(path), pad = digits.length;
  const re = new RegExp(`^${pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{${pad}})${ext.replace('.', '\\.')}$`, 'i');
  const nums = readdirSync(dir).map((f) => re.exec(f)).filter(Boolean).map((x) => Number(x![1])).sort((a, b) => a - b);
  if (nums.length < 2) return null;
  return { pattern: join(dir, `${pre}%0${pad}d${ext}`), first: nums[0], last: nums[nums.length - 1], count: nums.length };
}
/** File of a frame of an EXR footage item (missing frames hold the previous one). */
export function exrFrameFile(x: ExrInfo, frame: number): string {
  if (!x.pattern) return x.source;
  const n = Math.max(x.first ?? 0, Math.min(x.last ?? 0, Math.round(frame)));
  for (let k = n; k >= (x.first ?? 0); k--) {
    const f = x.pattern.replace(/%0(\d+)d/, (_, p) => String(k).padStart(Number(p), '0'));
    if (existsSync(f)) return f;
  }
  return x.source;
}

export async function exrImport(e: Editor, path: string, o: { sequence?: boolean; fps?: number; onProgress?: (f: number) => void } = {}): Promise<{ media: MediaItem; info: ExrInfo }> {
  const h = readExrHeader(readFileSync(path));
  const seq = o.sequence === false ? null : findSequence(path);
  const fps = o.fps ?? e.project.settings.fps ?? 30;
  const crypto = cryptoLayers(h);
  const info: ExrInfo = {
    source: path, channels: h.channels.map((c) => ({ name: c.name, type: c.type })), compression: h.compression,
    crypto: crypto.map((c) => ({ name: c.name, channels: c.channels, names: c.manifest ? Object.keys(c.manifest).length : 0 })),
    ...(seq ? { pattern: seq.pattern, first: seq.first, last: seq.last, fps } : {}),
  };
  // the beauty: ffmpeg reads EXR (every compression) — a PNG for a still, a VP9 movie with alpha for a sequence
  const dir = join(e.path ? dirname(e.path) : dirname(path), 'EXR');
  mkdirSync(dir, { recursive: true });
  const stem = basename(path, extname(path)).replace(/[.\s_-]*\d+$/, '') || 'exr';
  const out = join(dir, seq ? `${stem}_beauty.webm` : `${stem}_beauty.png`);
  const hasRgb = h.channels.some((c) => /^(R|G|B|Y)$/.test(c.name));
  if (!hasRgb) throw new Error('El EXR no tiene canales R, G, B (o Y) principales: no hay imagen que mostrar.');
  if (seq) await runFfmpeg(['-framerate', String(fps), '-start_number', String(seq.first), '-i', seq.pattern, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '15', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', out], { duration: seq.count / fps, onProgress: o.onProgress });
  else await runFfmpeg(['-i', path, '-frames:v', '1', '-pix_fmt', 'rgba', out]);
  return e.batch(async () => {
    const [m] = await e.importMedia([out]);
    e.mutate('Importar EXR', (p) => { const mm = p.media.find((x) => x.id === m.id)!; mm.exr = info; });
    return { media: e.project.media.find((x) => x.id === m.id)!, info };
  });
}

// ───────────────────────── channel data for the renderer ─────────────────────────
const cache = new Map<string, ReturnType<typeof readExr>>();
/** Channels of one frame as one binary block: [u32 json length][json {w, h, channels, ids?}][u32 data per channel].
 *  Float channels travel as their float bits, so IDs stored as floats arrive unchanged. With `crypto` + `selection`
 *  the IDs chosen (by name, wildcard or manifest) come in `ids`. */
export function exrChannelBlock(file: string, names: string[], crypto?: string, selection?: string): Buffer {
  let im = cache.get(file);
  if (!im) {
    im = readExr(readFileSync(file));
    cache.set(file, im);
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  const W = im.width, H = im.height;
  const chans: { name: string; type: number }[] = [], parts: Buffer[] = [];
  for (const n of names) {
    const c = im.header.channels.find((x) => x.name === n);
    if (!c) continue;
    const u = im.uint(n), f = im.channel(n);
    const data = u ? Buffer.from(u.buffer, u.byteOffset, u.byteLength) : Buffer.from(f!.buffer, f!.byteOffset, f!.byteLength);
    chans.push({ name: n, type: c.type });
    parts.push(data);
  }
  let ids: number[] | undefined;
  if (crypto) {
    const layer: CryptoLayer | undefined = cryptoLayers(im.header).find((c) => c.name === crypto);
    ids = layer && selection ? [...cryptoSelection(layer, selection)] : [];
  }
  const json = Buffer.from(JSON.stringify({ w: W, h: H, channels: chans, ...(ids ? { ids } : {}) }), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32LE(json.length);
  const padTo4 = Buffer.alloc((4 - ((4 + json.length) % 4)) % 4);
  return Buffer.concat([len, json, padTo4, ...parts]);
}
