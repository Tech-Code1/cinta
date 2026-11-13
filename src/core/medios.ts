// Media Browser and Metadata panels (After Effects: Navegador de medios, Metadatos): folders on disk with the files
// Cinta can import, and a file's metadata as ffprobe reports it (file, container, each stream, tags, chapters),
// grouped and named in Spanish. No exiftool: what ffprobe gives.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { runFfprobe } from './ffmpeg';
import { AUDIO_EXT, IMAGE_EXT, MODEL_EXT, VIDEO_EXT } from './probe';

export type EntryKind = 'dir' | 'video' | 'audio' | 'image' | 'model' | 'project' | 'other';
export interface MediaEntry { name: string; path: string; kind: EntryKind; size: number; mtime: number }
export function entryKind(name: string): EntryKind {
  const e = extname(name).toLowerCase();
  if (VIDEO_EXT.includes(e)) return 'video';
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (IMAGE_EXT.includes(e) || ['.exr', '.psd', '.svg', '.tga', '.dpx', '.ai'].includes(e)) return 'image';
  if (MODEL_EXT.includes(e)) return 'model';
  if (['.cinta', '.cintaplantilla', '.json', '.csv', '.tsv', '.mgjson', '.jsx', '.srt'].includes(e)) return 'project';
  return 'other';
}
/** A folder: subfolders first, then files (alphabetical); hidden and system entries are skipped. */
export function listFolder(dir: string, o: { all?: boolean } = {}): { dir: string; parent: string | null; entries: MediaEntry[] } {
  const abs = resolve(dir);
  const entries: MediaEntry[] = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith('.') || /^(\$RECYCLE\.BIN|System Volume Information|desktop\.ini|thumbs\.db)$/i.test(name)) continue;
    const path = join(abs, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    const kind: EntryKind = st.isDirectory() ? 'dir' : entryKind(name);
    if (kind === 'other' && !o.all) continue;
    entries.push({ name, path, kind, size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => (a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
  const parent = dirname(abs);
  return { dir: abs, parent: parent === abs ? null : parent, entries };
}
/** Places for the browser's side list: home folders and the drives present. */
export function mediaRoots(): { name: string; path: string }[] {
  const home = homedir();
  const out = [{ name: 'Directorio de inicio', path: home }];
  for (const [n, d] of [['Escritorio', 'Desktop'], ['Vídeos', 'Videos'], ['Imágenes', 'Pictures'], ['Música', 'Music'], ['Documentos', 'Documents'], ['Descargas', 'Downloads']]) {
    const p = join(home, d);
    if (existsSync(p)) out.push({ name: n, path: p });
  }
  if (process.platform === 'win32') for (let c = 67; c <= 90; c++) { const p = `${String.fromCharCode(c)}:\\`; try { if (existsSync(p)) out.push({ name: `Disco (${String.fromCharCode(c)}:)`, path: p }); } catch { /* no drive */ } }
  else out.push({ name: 'Raíz', path: '/' });
  return out;
}

// ───────────────────────── metadata ─────────────────────────
export interface MetaGroup { name: string; rows: [string, string][] }
interface Probe { format?: Record<string, unknown> & { tags?: Record<string, string> }; streams?: (Record<string, unknown> & { tags?: Record<string, string>; side_data_list?: Record<string, unknown>[]; disposition?: Record<string, number> })[]; chapters?: { start_time?: string; end_time?: string; tags?: Record<string, string> }[] }
const fmtBytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`);
const fmtRate = (r: unknown) => { const [a, b] = String(r ?? '').split('/').map(Number); const v = b ? a / b : a; return Number.isFinite(v) && v > 0 ? `${Math.round(v * 1000) / 1000} fps` : ''; };
const fmtBits = (b: unknown) => { const n = Number(b); return n > 0 ? (n >= 1e6 ? `${(n / 1e6).toFixed(2)} Mbps` : `${Math.round(n / 1000)} kbps`) : ''; };
export const fmtDuration = (s: unknown) => {
  const v = Number(s);
  if (!Number.isFinite(v) || v <= 0) return '';
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), sec = v % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
};
const tagRows = (tags?: Record<string, string>): [string, string][] => Object.entries(tags ?? {}).map(([k, v]) => [TAG_ES[k.toLowerCase()] ?? k, String(v)]);
const TAG_ES: Record<string, string> = {
  title: 'Título', artist: 'Artista', album: 'Álbum', album_artist: 'Artista del álbum', comment: 'Comentario', description: 'Descripción', genre: 'Género', date: 'Fecha', creation_time: 'Fecha de creación',
  encoder: 'Codificador', copyright: 'Copyright', language: 'Idioma', handler_name: 'Controlador', major_brand: 'Marca principal', minor_version: 'Versión secundaria', compatible_brands: 'Marcas compatibles',
  track: 'Pista', composer: 'Compositor', location: 'Ubicación', make: 'Fabricante', model: 'Modelo', software: 'Software', rotate: 'Rotación', timecode: 'Código de tiempo', vendor_id: 'Proveedor',
};
const STREAM_ES: Record<string, string> = { video: 'Vídeo', audio: 'Audio', subtitle: 'Subtítulos', data: 'Datos', attachment: 'Adjunto' };
/** ffprobe's JSON → named groups (pure; the file group comes from the stat). */
export function metadataGroups(p: Probe, file?: { path: string; size: number; mtime: number; birthtime?: number }): MetaGroup[] {
  const out: MetaGroup[] = [];
  const add = (name: string, rows: [string, unknown][]) => { const r = rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)] as [string, string]); if (r.length) out.push({ name, rows: r }); };
  if (file) add('Archivo', [['Nombre', basename(file.path)], ['Carpeta', dirname(file.path)], ['Tamaño', `${fmtBytes(file.size)} (${file.size.toLocaleString('es-ES')} bytes)`], ['Tipo', extname(file.path).slice(1).toUpperCase()], ['Modificado', new Date(file.mtime).toLocaleString('es-ES')], ['Creado', file.birthtime ? new Date(file.birthtime).toLocaleString('es-ES') : '']]);
  const f = p.format;
  if (f) add('Formato', [['Contenedor', f.format_long_name ?? f.format_name], ['Duración', fmtDuration(f.duration)], ['Velocidad de bits', fmtBits(f.bit_rate)], ['Secuencias', f.nb_streams], ['Programas', Number(f.nb_programs) || ''], ['Inicio', Number(f.start_time) ? `${f.start_time} s` : ''], ...tagRows(f.tags)]);
  const count: Record<string, number> = {};
  for (const s of p.streams ?? []) {
    const type = String(s.codec_type ?? 'data');
    count[type] = (count[type] ?? 0) + 1;
    const title = `${STREAM_ES[type] ?? type} ${count[type]}${s.disposition?.attached_pic ? ' (carátula)' : ''}`;
    const rot = s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
    const common: [string, unknown][] = [['Códec', s.codec_long_name ? `${s.codec_long_name} (${s.codec_name})` : s.codec_name], ['Perfil', s.profile], ['Etiqueta del códec', s.codec_tag_string && s.codec_tag_string !== '[0][0][0][0]' ? s.codec_tag_string : '']];
    if (type === 'video') add(title, [...common,
      ['Dimensiones', s.width && s.height ? `${s.width} × ${s.height}` : ''], ['Proporción de aspecto de píxel', s.sample_aspect_ratio && s.sample_aspect_ratio !== '0:1' ? s.sample_aspect_ratio : ''], ['Proporción de aspecto', s.display_aspect_ratio && s.display_aspect_ratio !== '0:1' ? s.display_aspect_ratio : ''],
      ['Velocidad de fotogramas', fmtRate(s.avg_frame_rate) || fmtRate(s.r_frame_rate)], ['Fotogramas', s.nb_frames], ['Duración', fmtDuration(s.duration)], ['Formato de píxel', s.pix_fmt], ['Profundidad de bits', s.bits_per_raw_sample],
      ['Espacio de color', s.color_space], ['Primarias', s.color_primaries], ['Transferencia', s.color_transfer], ['Rango', s.color_range === 'tv' ? 'Limitado (tv)' : s.color_range === 'pc' ? 'Completo (pc)' : s.color_range],
      ['Orden de campos', s.field_order], ['Rotación', rot !== undefined ? `${rot}°` : ''], ['Velocidad de bits', fmtBits(s.bit_rate)], ...tagRows(s.tags)]);
    else if (type === 'audio') add(title, [...common,
      ['Frecuencia de muestreo', s.sample_rate ? `${Number(s.sample_rate).toLocaleString('es-ES')} Hz` : ''], ['Canales', s.channels], ['Disposición de canales', s.channel_layout], ['Formato de muestra', s.sample_fmt], ['Bits por muestra', Number(s.bits_per_sample) || ''],
      ['Duración', fmtDuration(s.duration)], ['Velocidad de bits', fmtBits(s.bit_rate)], ...tagRows(s.tags)]);
    else add(title, [...common, ['Duración', fmtDuration(s.duration)], ...tagRows(s.tags)]);
  }
  if (p.chapters?.length) add('Capítulos', p.chapters.map((c, i) => [`${i + 1}. ${fmtDuration(c.start_time) || '0:00.000'}`, c.tags?.title ?? '']));
  return out;
}
/** A file's metadata (ffprobe). */
export async function fileMetadata(path: string): Promise<MetaGroup[]> {
  const abs = resolve(path);
  const st = statSync(abs);
  if (st.isDirectory()) return [{ name: 'Carpeta', rows: [['Nombre', basename(abs)], ['Ruta', abs], ['Modificado', new Date(st.mtimeMs).toLocaleString('es-ES')]] }];
  const file = { path: abs, size: st.size, mtime: st.mtimeMs, birthtime: st.birthtimeMs };
  try {
    const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', abs]);
    return metadataGroups(JSON.parse(stdout.toString()) as Probe, file);
  } catch {
    return metadataGroups({}, file);
  }
}
