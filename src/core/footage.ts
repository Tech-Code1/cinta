// Footage After Effects imports that the canvas engine (Chromium) cannot show by itself, and image sequences
// (Importar archivo ▸ «Secuencia PNG»). Each one is converted once into a file both engines read — a PNG for a
// still, H.264 (or VP9 with alpha) for moving footage — kept in «Material convertido» next to the project, so it
// is one ordinary footage item in the simple timeline and in compositions. MediaItem.footage keeps the original
// file(s) and the interpretation (Interpretar material de archivo: frame rate, alpha, loop) to rebuild it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Editor } from './ops';
import type { MediaItem } from './model';
import { cacheDir } from './graphics';
import { runFfmpeg, runFfprobe } from './ffmpeg';
import { probeMedia } from './probe';
import { decodeToPng, HEIF_EXT, needsDecode, RAW_EXT } from './rawimage';

/** Preferencias ▸ Importar ▸ Material de archivo de secuencias: 30 fotogramas por segundo (After Effects 2024). */
export const SEQUENCE_FPS = 30;
export type AlphaMode = 'straight' | 'premultiplied' | 'ignore';
export interface Interpretation {
  /** Ajustar a la velocidad de fotogramas (sequences: the import default) */
  fps?: number;
  /** Recto - Sin máscara / Premultiplicado - Máscara con color / Ignorar */
  alpha?: AlphaMode;
  /** the matte colour of premultiplied footage (default black) */
  matte?: string;
  invertAlpha?: boolean;
  /** Bucle: N tiempos */
  loop?: number;
}
/** Numbered files: dir/prefix + number (padded to `pad` digits; 0 = not padded) + suffix + ext; or `names` in order
 *  (Forzar orden alfabético). */
export interface SeqSpec { dir: string; prefix: string; suffix: string; ext: string; pad: number; first: number; last: number; missing: number[]; names?: string[]; alphabetical?: boolean }
export interface FootageInfo {
  /** the file imported (the first frame of a sequence) */
  source: string;
  /** what After Effects calls it: «Secuencia PNG», «Targa», «Cineon», «Camera Raw», «MXF»… */
  format: string;
  /** shown in the Project panel: img_[0001-0240].png */
  name: string;
  sequence?: SeqSpec;
  /** the file's own frame rate (0 for stills and sequences) */
  nativeFps: number;
  hasAlpha: boolean;
  still: boolean;
  interpret: Interpretation;
  /** how it was read (embedded camera preview, Cineon conversion, missing frames…) */
  notes?: string[];
}

export const SEQ_EXT = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.tga', '.exr', '.dpx', '.cin', '.bmp', '.webp', '.sgi', '.rgb', '.rgba', '.bw', ...RAW_EXT, ...HEIF_EXT];
/** Formats converted on import (the rest are read as they are). */
export const CONVERT_EXT = ['.tga', '.icb', '.vda', '.vst', '.sgi', '.rgb', '.rgba', '.bw', '.dpx', '.cin', '.tif', '.tiff', '.mxf', ...RAW_EXT, ...HEIF_EXT];
export const needsConversion = (path: string) => CONVERT_EXT.includes(extname(path).toLowerCase());
const FORMAT: Record<string, string> = {
  '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.tif': 'TIFF', '.tiff': 'TIFF', '.tga': 'Targa', '.icb': 'Targa', '.vda': 'Targa', '.vst': 'Targa', '.exr': 'OpenEXR', '.dpx': 'DPX', '.cin': 'Cineon',
  '.bmp': 'BMP', '.webp': 'WebP', '.sgi': 'SGI', '.rgb': 'SGI', '.rgba': 'SGI', '.bw': 'SGI', '.heic': 'HEIF', '.heif': 'HEIF', '.hif': 'HEIF', '.avif': 'AVIF', '.mxf': 'MXF',
};
export const formatName = (path: string) => { const x = extname(path).toLowerCase(); return FORMAT[x] ?? (RAW_EXT.includes(x) ? 'Camera Raw' : x.slice(1).toUpperCase()); };

// ───────────────────────── sequences ─────────────────────────
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numName = (s: SeqSpec, n: number) => `${s.prefix}${s.pad ? String(n).padStart(s.pad, '0') : n}${s.suffix}${s.ext}`;
/** The numbered files a file belongs to (any padding; the last number of the name counts), or — alphabetical — every
 *  file of its type in its folder. null when it is alone. */
export function detectSequence(path: string, o: { alphabetical?: boolean } = {}): SeqSpec | null {
  const abs = resolve(path), dir = dirname(abs), ext = extname(abs), stem = basename(abs, ext);
  let all: string[];
  try { all = readdirSync(dir); } catch { return null; }
  const same = all.filter((f) => extname(f).toLowerCase() === ext.toLowerCase());
  if (o.alphabetical) {
    const names = same.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    return names.length < 2 ? null : { dir, prefix: '', suffix: '', ext, pad: 0, first: 0, last: names.length - 1, missing: [], names, alphabetical: true };
  }
  const m = /^(.*?)(\d+)(\D*)$/.exec(stem);
  if (!m) return null;
  const [, prefix, , suffix] = m;
  const re = new RegExp(`^${esc(prefix)}(\\d+)${esc(suffix)}${esc(ext)}$`, 'i');
  const nums = new Set<number>(), lens = new Set<number>();
  for (const f of same) { const x = re.exec(f); if (x) { nums.add(Number(x[1])); lens.add(x[1].length); } }
  if (nums.size < 2) return null;
  const sorted = [...nums].sort((a, b) => a - b), first = sorted[0], last = sorted[sorted.length - 1];
  // padded when every name has the same number of digits and some number is shorter than that
  const minLen = Math.min(...lens), pad = minLen > String(first).length ? minLen : 0;
  const missing: number[] = [];
  for (let n = first; n <= last && missing.length < 100000; n++) if (!nums.has(n)) missing.push(n);
  const s: SeqSpec = { dir, prefix, suffix, ext, pad, first, last, missing };
  // names whose real spelling differs (mixed padding): keep the list
  if (sorted.some((n) => !existsSync(join(dir, numName(s, n))))) s.names = same.filter((f) => re.test(f)).sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]));
  return s;
}
/** Frames in order, missing ones as null. */
export function seqFrames(s: SeqSpec): (string | null)[] {
  if (s.alphabetical && s.names) return s.names.map((n) => join(s.dir, n));
  // mixed padding: the names as they are, by number
  const byNum = s.names ? new Map(s.names.map((n) => [Number(n.slice(s.prefix.length, n.length - s.suffix.length - s.ext.length)), n])) : null;
  const miss = new Set(s.missing), out: (string | null)[] = [];
  for (let n = s.first; n <= s.last; n++) out.push(miss.has(n) ? null : join(s.dir, byNum?.get(n) ?? numName(s, n)));
  return out;
}
/** After Effects names a sequence item img_[0001-0240].png */
export function seqName(s: SeqSpec): string {
  if (s.alphabetical && s.names) return `${basename(s.names[0], s.ext)}… (${s.names.length})${s.ext}`;
  const f = (n: number) => (s.pad ? String(n).padStart(s.pad, '0') : String(n));
  return `${s.prefix}[${f(s.first)}-${f(s.last)}]${s.suffix}${s.ext}`;
}
/** The largest numbered sequence in a folder (dropping a folder imports its sequence), or null. */
export function sequenceInFolder(dir: string): string | null {
  let best: { f: string; n: number } | null = null;
  const seen = new Set<string>();
  let files: string[];
  try { files = readdirSync(dir).sort(); } catch { return null; }
  for (const f of files) {
    if (!SEQ_EXT.includes(extname(f).toLowerCase())) continue;
    const s = detectSequence(join(dir, f));
    if (!s) continue;
    const key = `${s.prefix}|${s.suffix}|${s.ext.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = s.last - s.first + 1 - s.missing.length;
    if (!best || n > best.n) best = { f: join(dir, f), n };
  }
  return best?.f ?? null;
}

// ───────────────────────── building the playable file ─────────────────────────
const isAlphaFmt = (pf: string) => /^(rgba|bgra|argb|abgr|ya|gbrap|yuva|pal8)/.test(pf);
async function probeStream(path: string): Promise<{ w: number; h: number; pixfmt: string; fps: number; audio: boolean; video: boolean; duration: number }> {
  const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path]);
  const j = JSON.parse(stdout.toString()) as { streams: { codec_type: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; r_frame_rate?: string; disposition?: { attached_pic?: number } }[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const rate = (r?: string) => { if (!r) return 0; const [a, b] = r.split('/').map(Number); return b ? a / b : a || 0; };
  return { w: v?.width ?? 0, h: v?.height ?? 0, pixfmt: v?.pix_fmt ?? '', fps: rate(v?.avg_frame_rate) || rate(v?.r_frame_rate), audio: j.streams.some((s) => s.codec_type === 'audio'), video: !!v, duration: Number(j.format.duration ?? 0) };
}
/** Where converted footage goes: next to the project, or the cache while it has never been saved. */
export const footageDir = (e: Editor) => (e.path ? join(dirname(e.path), 'Material convertido') : cacheDir('footage'));

/** The filters of an interpretation: alpha (invert, premultiplied with a matte colour, ignore). */
export function alphaFilters(f: Pick<FootageInfo, 'hasAlpha' | 'interpret'>): string[] {
  const a = f.interpret.alpha ?? 'straight';
  if (!f.hasAlpha || a === 'ignore') return ['format=rgb24'];
  const out = ['format=rgba'];
  if (f.interpret.invertAlpha) out.push("lut=a='negval'");
  if (a === 'premultiplied') {
    const m = /^#?([0-9a-f]{6})$/i.exec(f.interpret.matte ?? '#000000')?.[1] ?? '000000';
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
    if (!r && !g && !b) out.push('unpremultiply=inplace=1');
    else {
      // straight = (premultiplied − matte·(1 − α)) / α
      const ch = (c: string, k: number) => `if(gt(alpha(X\\,Y)\\,0)\\,clip((${c}(X\\,Y)-${k}*(255-alpha(X\\,Y))/255)*255/alpha(X\\,Y)\\,0\\,255)\\,0)`;
      out.push(`geq=r='${ch('r', r)}':g='${ch('g', g)}':b='${ch('b', b)}':a='alpha(X\\,Y)'`);
    }
  }
  return out;
}

export interface Built { path: string; width: number; height: number; duration: number; fps: number; hasAudio: boolean; still: boolean; notes: string[] }
/** Makes (or reuses) the playable file of a footage item with its interpretation. */
export async function buildFootage(f: FootageInfo, outDir: string, onProgress?: (x: number) => void): Promise<Built> {
  const loop = Math.max(1, Math.round(f.interpret.loop ?? 1));
  const fps = f.still ? 0 : f.sequence ? (f.interpret.fps || SEQUENCE_FPS) : (f.interpret.fps || f.nativeFps || SEQUENCE_FPS);
  const frames = f.sequence ? seqFrames(f.sequence) : null;
  const key = createHash('sha1').update(JSON.stringify({ s: f.source, q: f.sequence, i: f.interpret, a: f.hasAlpha, m: statSync(f.source).mtimeMs, v: 1 })).digest('hex').slice(0, 10);
  const dir = join(outDir, key);
  const stem = (f.sequence ? seqName(f.sequence) : basename(f.source)).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
  const alpha = f.hasAlpha && f.interpret.alpha !== 'ignore';
  const out = join(dir, `${stem}.${f.still ? 'png' : alpha ? 'webm' : 'mp4'}`);
  const notes: string[] = [];
  let hasAudio = false;
  if (!existsSync(out)) {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'tmp');
    try {
      const readable = async (p: string, i: number) => {
        if (!needsDecode(p)) return p;
        const png = join(tmp, `f${String(i).padStart(6, '0')}.png`);
        if (!existsSync(png)) notes.push(...(await decodeToPng(p, png)).filter((n) => !notes.includes(n)));
        return png;
      };
      const vf = [...alphaFilters(f)];
      let input: string[];
      if (frames) {
        // the frames in order (a missing frame holds the previous one), repeated for the loop
        const held: string[] = [];
        let prev = frames.find(Boolean)!;
        for (const fr of frames) { if (fr) prev = fr; held.push(prev); }
        const uniq = new Map<string, string>();
        let i = 0;
        for (const p of held) if (!uniq.has(p)) { uniq.set(p, await readable(p, i++)); onProgress?.(0.3 * (i / held.length)); }
        const d = (1 / fps).toFixed(9);
        let list = 'ffconcat version 1.0\n';
        for (let k = 0; k < loop; k++) for (const p of held) list += `file '${uniq.get(p)!.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\nduration ${d}\n`;
        mkdirSync(tmp, { recursive: true });
        writeFileSync(join(tmp, 'frames.ffconcat'), list);
        input = ['-safe', '0', '-f', 'concat', '-i', join(tmp, 'frames.ffconcat')];
      } else {
        const src = await readable(f.source, 0);
        input = f.still ? ['-i', src] : [...(loop > 1 ? ['-stream_loop', String(loop - 1)] : []), '-i', src];
        if (!f.still && f.interpret.fps && f.nativeFps && Math.abs(f.interpret.fps - f.nativeFps) > 1e-3) vf.unshift(`setpts=PTS*${f.nativeFps}/${f.interpret.fps}`);
        if (!f.still) hasAudio = (await probeStream(src)).audio;
      }
      if (f.still) await runFfmpeg([...input, '-frames:v', '1', '-vf', vf.join(','), '-pix_fmt', alpha ? 'rgba' : 'rgb24', out]);
      else {
        const n = frames ? frames.length * loop : 0, total = frames ? n / fps : undefined;
        vf.push('pad=ceil(iw/2)*2:ceil(ih/2)*2', `format=${alpha ? 'yuva420p' : 'yuv420p'}`);
        const venc = alpha
          ? ['-c:v', 'libvpx-vp9', '-crf', '15', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-auto-alt-ref', '0']
          : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '10', '-movflags', '+faststart'];
        const aenc = hasAudio ? (alpha ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '256k']) : ['-an'];
        await runFfmpeg([...input, '-vf', vf.join(','), '-r', String(fps), ...(frames ? ['-frames:v', String(n)] : []), ...venc, ...aenc, out], { duration: total, onProgress: (x) => onProgress?.((frames ? 0.3 : 0) + x * (frames ? 0.7 : 1)) });
      }
    } catch (err) {
      rmSync(out, { force: true });
      throw err;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  const pr = await probeStream(out);
  hasAudio = pr.audio;
  const duration = f.still ? 0 : frames ? (frames.length * loop) / fps : Math.round(pr.duration * 1000) / 1000;
  return { path: out, width: pr.w, height: pr.h, duration: Math.round(duration * 1000) / 1000, fps, hasAudio, still: f.still, notes };
}

// ───────────────────────── import & interpret ─────────────────────────
export interface FootageOptions {
  /** «Secuencia PNG»: import the numbered files the file belongs to as one footage item */
  sequence?: boolean;
  /** «Forzar orden alfabético» */
  alphabetical?: boolean;
  interpret?: Interpretation;
  /** default rate of sequences (Preferencias ▸ Importar) */
  sequenceFps?: number;
  onProgress?: (x: number) => void;
}
/** Reads what a file is (sequence, still or moving, alpha, rate) without converting it. */
export async function describeFootage(path: string, o: FootageOptions = {}): Promise<FootageInfo> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`No existe el archivo: ${abs}`);
  const ext = extname(abs).toLowerCase();
  const seq = o.sequence && SEQ_EXT.includes(ext) ? detectSequence(abs, { alphabetical: o.alphabetical }) : null;
  const first = seq ? seqFrames(seq).find(Boolean)! : abs;
  // the stream of the first frame (decoded first if ffmpeg cannot read it)
  let probe: Awaited<ReturnType<typeof probeStream>>;
  const notes: string[] = [];
  if (needsDecode(first)) {
    const tmp = join(cacheDir('footage'), `probe_${process.pid}_${Date.now()}.png`);
    try { notes.push(...(await decodeToPng(first, tmp))); probe = await probeStream(tmp); } finally { rmSync(tmp, { force: true }); }
  } else probe = await probeStream(first);
  if (!probe.video && !probe.audio) throw new Error(`Formato no compatible: ${abs}`);
  if (!probe.video) throw new Error('Ese archivo solo tiene sonido: impórtelo como audio.');
  const stillExt = SEQ_EXT.includes(ext) && ext !== '.mxf';
  const still = !seq && stillExt;
  if (seq?.missing.length) notes.push(`A «${seqName(seq)}» le ${seq.missing.length === 1 ? 'falta el fotograma' : 'faltan los fotogramas'} ${seq.missing.slice(0, 12).join(', ')}${seq.missing.length > 12 ? '…' : ''} (se repite el anterior).`);
  const hasAlpha = isAlphaFmt(probe.pixfmt);
  const interpret: Interpretation = { ...(hasAlpha ? { alpha: 'straight' as AlphaMode } : {}), ...(seq ? { fps: o.sequenceFps ?? SEQUENCE_FPS } : {}), ...o.interpret };
  return {
    source: first, format: seq ? `Secuencia ${formatName(abs)}` : formatName(abs), name: seq ? seqName(seq) : basename(abs),
    ...(seq ? { sequence: seq } : {}), nativeFps: still || seq ? 0 : Math.round(probe.fps * 1000) / 1000, hasAlpha, still, interpret, ...(notes.length ? { notes } : {}),
  };
}
/** A footage item for a file or sequence (converted; not yet in the project). */
export async function footageItem(e: Editor, path: string, o: FootageOptions = {}): Promise<MediaItem> {
  const info = await describeFootage(path, o);
  const b = await buildFootage(info, footageDir(e), o.onProgress);
  const m = await probeMedia(b.path);
  if (b.notes.length) info.notes = [...new Set([...(info.notes ?? []), ...b.notes])];
  return { ...m, kind: b.still ? 'image' : 'video', duration: b.duration, fps: b.still ? 0 : b.fps, width: b.width, height: b.height, hasAudio: b.hasAudio, hasVideo: true, footage: info };
}
/** Imports files as footage (sequences when asked); a folder imports the largest numbered sequence inside it. */
export async function importFootage(e: Editor, paths: string[], o: FootageOptions = {}): Promise<{ media: MediaItem[]; notes: string[] }> {
  const items: MediaItem[] = [];
  for (let i = 0; i < paths.length; i++) {
    let p = resolve(paths[i]), seq = o.sequence;
    if (existsSync(p) && statSync(p).isDirectory()) {
      const f = sequenceInFolder(p);
      if (!f) throw new Error(`La carpeta no contiene una secuencia numerada de imágenes: ${p}`);
      p = f; seq = true;
    }
    const known = e.project.media.find((m) => m.footage && resolve(m.footage.source).toLowerCase() === p.toLowerCase() && !!m.footage.sequence === !!seq && !m.compId);
    items.push(known ?? (await footageItem(e, p, { ...o, sequence: seq, onProgress: (x) => o.onProgress?.((i + x) / paths.length) })));
  }
  e.mutate('Importar', (pr) => { for (const m of items) if (!pr.media.some((x) => x.id === m.id)) pr.media.push(m); });
  return { media: items, notes: items.flatMap((m) => m.footage?.notes ?? []) };
}

/** After Effects' Interpretar material de archivo: rebuilds the footage with another frame rate, alpha or loop. Plain
 *  footage (an ordinary video or picture) becomes converted footage the first time. Layers and clips keep their
 *  timing; those that now run past the end of the footage are trimmed. */
export async function interpretFootage(e: Editor, mediaId: string, interp: Interpretation, onProgress?: (x: number) => void): Promise<MediaItem> {
  const m = e.media(mediaId);
  if (m.compId) throw new Error('Una composición no se interpreta: cambie su configuración.');
  if (m.kind === 'audio' || m.kind === 'model' || (!m.hasVideo && m.kind !== 'image')) throw new Error('Solo se interpreta material de archivo con imagen.');
  const base: FootageInfo = m.footage ?? await describeFootage(m.exr ? (m.exr.source) : m.path, { sequence: !!m.exr?.pattern, interpret: m.exr?.fps ? { fps: m.exr.fps } : {} });
  const next: FootageInfo = { ...base, interpret: { ...base.interpret, ...interp } };
  for (const k of Object.keys(next.interpret) as (keyof Interpretation)[]) if (next.interpret[k] === undefined || next.interpret[k] === null) delete next.interpret[k];
  if (next.interpret.fps !== undefined && !(next.interpret.fps >= 1 && next.interpret.fps <= 999)) throw new Error('La velocidad de fotogramas va de 1 a 999.');
  if (next.interpret.loop !== undefined && !(next.interpret.loop >= 1 && next.interpret.loop <= 9999)) throw new Error('El bucle va de 1 a 9999 veces.');
  const b = await buildFootage(next, footageDir(e), onProgress);
  return e.mutate('Interpretar material de archivo', (p) => {
    const mm = p.media.find((x) => x.id === m.id)!;
    Object.assign(mm, { path: b.path, kind: b.still ? 'image' : 'video', duration: b.duration, fps: b.still ? 0 : b.fps, width: b.width, height: b.height, hasAudio: b.hasAudio, hasVideo: true, footage: next });
    if (mm.exr && b.fps) mm.exr.fps = b.fps;
    if (mm.proxy) delete mm.proxy;
    if (!b.still) {
      for (const c of p.clips) if (c.mediaId === mm.id && c.out > b.duration) { c.out = Math.max(Math.min(c.in + 0.04, b.duration), b.duration); c.in = Math.min(c.in, Math.max(0, c.out - 0.04)); }
      for (const comp of p.comps ?? []) for (const l of comp.layers) {
        if (l.mediaId !== mm.id || l.timeRemap) continue;
        const end = l.start + b.duration * Math.abs(l.stretch || 1);
        if (l.out > end + 1e-6) l.out = Math.max(l.in + 1 / comp.fps, end);
      }
    }
    return mm;
  });
}
