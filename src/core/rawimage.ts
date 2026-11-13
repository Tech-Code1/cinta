// Still formats After Effects imports that the bundled ffmpeg cannot read by itself, decoded to PNG here:
//  · Cineon (.cin): Kodak's 10-bit log film scans, converted with After Effects' «Ajustes de Cineon» Estándar
//    (10-bit black 95, white 685, gamma 1.7);
//  · Camera Raw (.cr2 .nef .arw .dng …): DNG through ffmpeg's own DNG decoder (demosaic included); the other raw
//    formats through LibRaw's dcraw_emu (LGPL / CDDL) when the user has it (CINTA_DCRAW or on the PATH), otherwise
//    the full-size JPEG the camera embeds in every raw file (what most viewers show);
//  · HEIF / HEIC and AVIF (ISO base media "image items"): the container is read here — single images and grids of
//    tiles, rotation and mirror — and each tile's HEVC / AV1 bitstream is decoded by ffmpeg, then stitched.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runFfmpeg } from './ffmpeg';
import { encodePng } from './png';

export const RAW_EXT = ['.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng', '.orf', '.rw2', '.raf', '.pef', '.srw', '.x3f', '.3fr', '.iiq', '.erf', '.kdc', '.mos', '.mrw', '.rwl'];
export const HEIF_EXT = ['.heic', '.heif', '.hif', '.avif'];
/** Files decoded here before ffmpeg sees them (AVIF only when ffmpeg alone fails: grids, alpha). */
export const needsDecode = (path: string) => { const x = extname(path).toLowerCase(); return x === '.cin' || (RAW_EXT.includes(x) && x !== '.dng') || (HEIF_EXT.includes(x) && x !== '.avif'); };

/** Decodes a Cineon / raw / HEIF still to an RGBA PNG. Returns notes about how it was read. */
export async function decodeToPng(path: string, out: string): Promise<string[]> {
  const x = extname(path).toLowerCase();
  mkdirSync(dirname(out), { recursive: true });
  if (x === '.cin') { const im = readCineon(readFileSync(path)); writeFileSync(out, encodePng(im.width, im.height, im.rgba)); return ['Cineon: conversión logarítmica a lineal Estándar (negro 95, blanco 685, gamma 1,7).']; }
  if (HEIF_EXT.includes(x)) { const im = await readHeif(readFileSync(path), dirname(out)); writeFileSync(out, encodePng(im.width, im.height, im.rgba)); return im.notes; }
  if (RAW_EXT.includes(x)) return rawToPng(path, out);
  await runFfmpeg(['-i', path, '-frames:v', '1', '-pix_fmt', 'rgba', out]);
  return [];
}

// ───────────────────────── Cineon ─────────────────────────
export interface Rgba { width: number; height: number; rgba: Uint8Array }
/** Kodak Cineon 4.5: 10-bit samples packed three per 32-bit word (or 8-bit), log → display with the Standard settings. */
export function readCineon(b: Buffer, o: { black?: number; white?: number; gamma?: number } = {}): Rgba {
  const magic = b.readUInt32BE(0);
  const le = magic === 0xd75f2a80;
  if (!le && magic !== 0x802a5fd7) throw new Error('No es un archivo Cineon (.cin).');
  const u32 = (p: number) => (le ? b.readUInt32LE(p) : b.readUInt32BE(p));
  const offset = u32(4), channels = b[193];
  const bits = b[196 + 2], width = u32(196 + 4), height = u32(196 + 8);
  const packing = b[681], eolPad = u32(684) === 0xffffffff ? 0 : u32(684);
  if (!width || !height || width > 32768 || height > 32768) throw new Error('Cineon: tamaño de imagen no válido.');
  if (channels !== 1 && channels !== 3) throw new Error(`Cineon: ${channels} canales no admitidos (1 o 3).`);
  // log → linear → display (After Effects' Cineon Settings «Estándar»)
  const black = o.black ?? 95, white = o.white ?? 685, gamma = o.gamma ?? 1.7;
  const lutMax = bits === 8 ? 255 : 1023, lut = new Uint8Array(lutMax + 1);
  const offs = Math.pow(10, ((black - white) * 0.002) / 0.6), gain = 1 / (1 - offs);
  for (let cv = 0; cv <= lutMax; cv++) {
    const code = bits === 8 ? cv * 4 : cv;
    const lin = Math.max(0, (Math.pow(10, ((code - white) * 0.002) / 0.6) - offs) * gain);
    lut[cv] = Math.round(255 * Math.min(1, Math.pow(lin, 1 / gamma)));
  }
  const n = width * height, rgba = new Uint8Array(n * 4), samples = new Uint16Array(n * channels);
  let p = offset;
  if (bits === 8) {
    for (let y = 0, k = 0; y < height; y++) { for (let i = 0; i < width * channels; i++) samples[k++] = b[p++]; p += eolPad; }
  } else if (bits === 10 && (packing === 5 || packing === 0 || packing === 1 || packing === 255)) {
    // three samples per word, from the high bits down (the two low bits are padding)
    for (let y = 0, k = 0; y < height; y++) {
      const per = width * channels;
      for (let i = 0; i < per; i += 3) {
        const w = u32(p); p += 4;
        samples[k++] = (w >>> 22) & 1023;
        if (i + 1 < per) samples[k++] = (w >>> 12) & 1023;
        if (i + 2 < per) samples[k++] = (w >>> 2) & 1023;
      }
      p += eolPad;
    }
  } else throw new Error(`Cineon: ${bits} bits con empaquetado ${packing} no admitido.`);
  for (let i = 0; i < n; i++) {
    const r = lut[samples[i * channels]], g = channels === 3 ? lut[samples[i * 3 + 1]] : r, bb = channels === 3 ? lut[samples[i * 3 + 2]] : r;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = bb; rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

// ───────────────────────── Camera Raw ─────────────────────────
/** LibRaw's dcraw_emu (or dcraw) chosen by the user: CINTA_DCRAW, else on the PATH. */
export function findDcraw(): string | null {
  const env = process.env.CINTA_DCRAW;
  if (env && existsSync(env)) return env;
  for (const d of (process.env.PATH ?? '').split(delimiter)) for (const exe of ['dcraw_emu.exe', 'dcraw.exe', 'dcraw_emu', 'dcraw']) { const f = join(d, exe); if (d && existsSync(f)) return f; }
  return null;
}
async function rawToPng(path: string, out: string): Promise<string[]> {
  const x = extname(path).toLowerCase();
  if (x === '.dng') {
    try { await runFfmpeg(['-i', path, '-frames:v', '1', '-pix_fmt', 'rgba', out]); return ['Camera Raw: DNG revelado por ffmpeg (balance de blancos de la cámara).']; } catch { /* lossy / unusual DNG: below */ }
  }
  const dc = findDcraw();
  if (dc) {
    const tif = `${out}.tiff`, emu = /dcraw_emu/i.test(dc);
    const r = emu ? spawnSync(dc, ['-w', '-o', '1', '-T', '-Z', tif, path], { windowsHide: true }) : spawnSync(dc, ['-w', '-o', '1', '-T', '-c', path], { windowsHide: true, maxBuffer: 1 << 30 });
    if (!emu && r.status === 0 && r.stdout?.length) writeFileSync(tif, r.stdout);
    if (r.status === 0 && existsSync(tif)) {
      await runFfmpeg(['-i', tif, '-frames:v', '1', '-pix_fmt', 'rgba', out]);
      rmSync(tif, { force: true });
      return [`Camera Raw: revelado con LibRaw (${dc}).`];
    }
  }
  const prev = rawPreview(readFileSync(path));
  if (!prev) throw new Error('Camera Raw: no se pudo revelar el archivo ni encontrar su vista previa incrustada. Instale LibRaw (dcraw_emu) y defina CINTA_DCRAW.');
  const jpg = `${out}.jpg`;
  writeFileSync(jpg, prev.jpeg);
  const rot = prev.orientation === 3 ? ['-vf', 'hflip,vflip'] : prev.orientation === 6 ? ['-vf', 'transpose=1'] : prev.orientation === 8 ? ['-vf', 'transpose=2'] : [];
  await runFfmpeg(['-i', jpg, ...rot, '-frames:v', '1', '-pix_fmt', 'rgba', out]);
  rmSync(jpg, { force: true });
  return [`Camera Raw: vista previa JPEG que la cámara incrusta (${prev.width}×${prev.height}); para revelar el raw instale LibRaw (dcraw_emu, LGPL) y defina CINTA_DCRAW.`];
}

/** The largest baseline / progressive JPEG inside a raw file (lossless raw data — SOF3 — is skipped), and the
 *  orientation of the TIFF-based containers. */
export function rawPreview(b: Buffer): { jpeg: Buffer; width: number; height: number; orientation: number } | null {
  let best: { s: number; e: number; w: number; h: number } | null = null;
  let at = 0;
  const soi = Buffer.from([0xff, 0xd8, 0xff]);
  while ((at = b.indexOf(soi, at)) >= 0) {
    const j = jpegExtent(b, at);
    if (j && (!best || j.w * j.h > best.w * best.h)) best = { s: at, ...j };
    at = j ? j.e : at + 3;
  }
  if (!best || best.w < 64) return null;
  return { jpeg: b.subarray(best.s, best.e), width: best.w, height: best.h, orientation: tiffOrientation(b) };
}
function jpegExtent(b: Buffer, s: number): { e: number; w: number; h: number } | null {
  let p = s + 2, w = 0, h = 0;
  while (p + 2 <= b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) return w ? { e: p + 2, w, h } : null;
    if (p + 4 > b.length) return null;
    const len = b.readUInt16BE(p + 2);
    if (m === 0xc3 || m === 0xc7 || m === 0xcb || m === 0xcf) return null; // lossless: the raw data itself
    if (m >= 0xc0 && m <= 0xc2) { h = b.readUInt16BE(p + 5); w = b.readUInt16BE(p + 7); }
    if (m === 0xda) {
      // entropy-coded data up to the next marker that is not a stuffed byte or a restart
      p += 2 + len;
      while (p + 1 < b.length) {
        if (b[p] === 0xff) { const n = b[p + 1]; if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { p += 2; continue; } if (n === 0xff) { p++; continue; } break; }
        p++;
      }
      continue;
    }
    p += 2 + len;
  }
  return null;
}
function tiffOrientation(b: Buffer): number {
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) return 1;
  try {
    const u16 = (p: number) => (le ? b.readUInt16LE(p) : b.readUInt16BE(p)), u32 = (p: number) => (le ? b.readUInt32LE(p) : b.readUInt32BE(p));
    const ifd = u32(4), n = u16(ifd);
    for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 0x0112) return u16(e + 8); }
  } catch { /* not a TIFF after all */ }
  return 1;
}

// ───────────────────────── HEIF / AVIF ─────────────────────────
interface Box { type: string; start: number; size: number; body: number }
function boxes(b: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = b.readUInt32BE(p), hdr = 8;
    const type = b.toString('latin1', p + 4, p + 8);
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = to - p;
    if (size < hdr || p + size > to) break;
    out.push({ type, start: p, size, body: p + hdr });
    p += size;
  }
  return out;
}
interface HeifItem { id: number; type: string; props: number[]; data?: Buffer }
/** Reads the primary image of a HEIF / AVIF file (one image or a grid of tiles) into RGBA. */
export async function readHeif(b: Buffer, tmp: string): Promise<Rgba & { notes: string[] }> {
  const top = boxes(b, 0, b.length), meta = top.find((x) => x.type === 'meta');
  if (!meta) throw new Error('HEIF: el archivo no tiene la caja «meta».');
  const kids = boxes(b, meta.body + 4, meta.start + meta.size);
  const find = (t: string) => kids.find((x) => x.type === t);
  const pitm = find('pitm'), iinf = find('iinf'), iloc = find('iloc'), iprp = find('iprp'), iref = find('iref'), idat = find('idat');
  if (!pitm || !iinf || !iloc || !iprp) throw new Error('HEIF: faltan cajas (pitm, iinf, iloc, iprp).');
  const primary = b[pitm.body] === 0 ? b.readUInt16BE(pitm.body + 4) : b.readUInt32BE(pitm.body + 4);
  // items
  const items = new Map<number, HeifItem>();
  const iv = b[iinf.body], infes = boxes(b, iinf.body + 4 + (iv === 0 ? 2 : 4), iinf.start + iinf.size);
  for (const e of infes) {
    if (e.type !== 'infe') continue;
    const v = b[e.body];
    if (v < 2) continue;
    const id = v === 2 ? b.readUInt16BE(e.body + 4) : b.readUInt32BE(e.body + 4);
    const tp = b.toString('latin1', e.body + (v === 2 ? 8 : 10), e.body + (v === 2 ? 12 : 14));
    items.set(id, { id, type: tp, props: [] });
  }
  // locations
  {
    const p0 = iloc.body, v = b[p0];
    let p = p0 + 4;
    const sz = b[p] >> 4, osz = b[p] & 15, bsz = b[p + 1] >> 4, isz = v === 1 || v === 2 ? b[p + 1] & 15 : 0;
    p += 2;
    const rd = (n: number) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + b[p++]; return x; };
    const count = v < 2 ? rd(2) : rd(4);
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? rd(2) : rd(4);
      const method = v === 1 || v === 2 ? rd(2) & 15 : 0;
      rd(2); // data reference index
      const base = rd(bsz), ext = rd(2), parts: Buffer[] = [];
      for (let k = 0; k < ext; k++) {
        if (isz) rd(isz);
        const off = rd(osz), len = rd(sz);
        const src = method === 1 && idat ? idat.body : 0;
        parts.push(b.subarray(src + base + off, src + base + off + (len || (method === 1 && idat ? idat.start + idat.size - idat.body : b.length) - base - off)));
      }
      const it = items.get(id);
      if (it) it.data = Buffer.concat(parts);
    }
  }
  // properties and their associations
  const ipco = boxes(b, iprp.body, iprp.start + iprp.size).find((x) => x.type === 'ipco');
  const ipma = boxes(b, iprp.body, iprp.start + iprp.size).find((x) => x.type === 'ipma');
  const props = ipco ? boxes(b, ipco.body, ipco.start + ipco.size) : [];
  if (ipma) {
    const v = b[ipma.body], flags = b.readUIntBE(ipma.body + 1, 3);
    let p = ipma.body + 4;
    const n = b.readUInt32BE(p); p += 4;
    for (let i = 0; i < n; i++) {
      const id = v < 1 ? b.readUInt16BE(p) : b.readUInt32BE(p); p += v < 1 ? 2 : 4;
      const k = b[p++];
      const it = items.get(id);
      for (let j = 0; j < k; j++) {
        const idx = flags & 1 ? b.readUInt16BE(p) & 0x7fff : b[p] & 0x7f; p += flags & 1 ? 2 : 1;
        if (it && idx) it.props.push(idx - 1);
      }
    }
  }
  const prop = (it: HeifItem, t: string) => { for (const i of it.props) if (props[i]?.type === t) return props[i]; return undefined; };
  // references: grid → tiles (dimg)
  const dimg = new Map<number, number[]>();
  if (iref) {
    const v = b[iref.body];
    for (const r of boxes(b, iref.body + 4, iref.start + iref.size)) {
      let p = r.body;
      const rd = () => { const x = v === 0 ? b.readUInt16BE(p) : b.readUInt32BE(p); p += v === 0 ? 2 : 4; return x; };
      const from = rd(), n = b.readUInt16BE(p); p += 2;
      const to: number[] = [];
      for (let i = 0; i < n; i++) to.push(rd());
      if (r.type === 'dimg') dimg.set(from, to);
    }
  }
  const main = items.get(primary);
  if (!main?.data) throw new Error('HEIF: no se encuentra la imagen principal.');
  const notes: string[] = [];
  let tiles: HeifItem[], cols = 1, rows = 1, outW = 0, outH = 0;
  if (main.type === 'grid') {
    const d = main.data, big = d[1] & 1;
    rows = d[2] + 1; cols = d[3] + 1;
    outW = big ? d.readUInt32BE(4) : d.readUInt16BE(4); outH = big ? d.readUInt32BE(8) : d.readUInt16BE(6);
    tiles = (dimg.get(main.id) ?? []).map((id) => items.get(id)!).filter(Boolean);
    if (tiles.length !== rows * cols) throw new Error('HEIF: la cuadrícula no tiene todas sus teselas.');
  } else tiles = [main];
  const kind = tiles[0].type;
  if (kind !== 'hvc1' && kind !== 'av01') throw new Error(`HEIF: imágenes «${kind}» no admitidas (HEVC o AV1).`);
  const cfg = prop(tiles[0], kind === 'hvc1' ? 'hvcC' : 'av1C');
  if (!cfg) throw new Error('HEIF: falta la configuración del códec.');
  const ispe = prop(tiles[0], 'ispe');
  const tw = ispe ? b.readUInt32BE(ispe.body + 4) : 0, th = ispe ? b.readUInt32BE(ispe.body + 8) : 0;
  if (!tw || !th) throw new Error('HEIF: falta el tamaño de la imagen (ispe).');
  if (main.type !== 'grid') { outW = tw; outH = th; }
  // one elementary stream with every tile as a frame
  const parts: Buffer[] = [];
  if (kind === 'hvc1') {
    const c = cfg.body, lenSize = (b[c + 21] & 3) + 1, nArr = b[c + 22], ps: Buffer[] = [];
    let p = c + 23;
    for (let i = 0; i < nArr; i++) {
      p++; const nn = b.readUInt16BE(p); p += 2;
      for (let j = 0; j < nn; j++) { const l = b.readUInt16BE(p); p += 2; ps.push(Buffer.from([0, 0, 0, 1]), b.subarray(p, p + l)); p += l; }
    }
    for (const t of tiles) {
      parts.push(...ps);
      const d = t.data!;
      for (let q = 0; q + lenSize <= d.length;) { const l = d.readUIntBE(q, lenSize); q += lenSize; parts.push(Buffer.from([0, 0, 0, 1]), d.subarray(q, q + l)); q += l; }
    }
  } else {
    const conf = b.subarray(cfg.body + 4, cfg.start + cfg.size);
    for (const t of tiles) parts.push(Buffer.from([0x12, 0x00]), conf, t.data!);
  }
  mkdirSync(tmp, { recursive: true });
  const es = join(tmp, `heif_${process.pid}_${Date.now()}.${kind === 'hvc1' ? 'hevc' : 'obu'}`);
  writeFileSync(es, Buffer.concat(parts));
  let raw: Buffer;
  try { raw = (await runFfmpeg(['-f', kind === 'hvc1' ? 'hevc' : 'obu', '-i', es, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${tw}x${th}`, 'pipe:1'], { stdout: 'buffer' })).stdout; } finally { rmSync(es, { force: true }); }
  const frame = tw * th * 4;
  if (raw.length < frame * tiles.length) throw new Error('HEIF: ffmpeg no pudo decodificar todas las teselas.');
  let W = outW, H = outH, rgba: Uint8Array = new Uint8Array(W * H * 4);
  for (let i = 0; i < tiles.length; i++) {
    const ox = (i % cols) * tw, oy = Math.floor(i / cols) * th;
    for (let y = 0; y < th && oy + y < H; y++) {
      const n = Math.min(tw, W - ox);
      if (n <= 0) continue;
      rgba.set(raw.subarray(i * frame + y * tw * 4, i * frame + (y * tw + n) * 4), ((oy + y) * W + ox) * 4);
    }
  }
  // rotation (anticlockwise quarter turns) and mirror of the primary item
  const irot = prop(main, 'irot'), imir = prop(main, 'imir');
  const turns = irot ? b[irot.body] & 3 : 0;
  for (let k = 0; k < turns; k++) {
    const o = new Uint8Array(rgba.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (y * W + x) * 4, d = ((W - 1 - x) * H + y) * 4; o[d] = rgba[s]; o[d + 1] = rgba[s + 1]; o[d + 2] = rgba[s + 2]; o[d + 3] = rgba[s + 3]; }
    rgba = o; [W, H] = [H, W];
  }
  if (imir) {
    const vertical = (b[imir.body] & 1) === 0;
    const o = new Uint8Array(rgba.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (y * W + x) * 4, d = vertical ? ((H - 1 - y) * W + x) * 4 : (y * W + (W - 1 - x)) * 4; o.set(rgba.subarray(s, s + 4), d); }
    rgba = o;
  }
  if (main.type === 'grid') notes.push(`HEIF: cuadrícula de ${cols}×${rows} teselas.`);
  return { width: W, height: H, rgba, notes };
}
