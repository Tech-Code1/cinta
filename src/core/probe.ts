// ffprobe → MediaItem
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { runFfprobe } from './ffmpeg';
import { uid, type MediaItem, type MediaKind } from './model';
import { gltfInfo, gltfJson, MODEL_EXT, mtlTextures, objInfo, type ModelInfo } from './motion/model3d';

export const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.flv', '.m4v', '.mpg', '.mpeg', '.m2ts', '.mts', '.ts', '.3gp', '.ogv', '.vob', '.gif', '.mxf'];
export const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr'];
export const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.heif', '.avif', '.tga', '.sgi', '.rgb', '.dpx', '.cin', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.dng', '.orf', '.rw2', '.raf', '.pef', '.srw'];
export const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];
export { MODEL_EXT };

interface ProbeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

const rate = (r?: string) => {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a || 0;
};

export async function probeMedia(path: string): Promise<MediaItem> {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`No existe el archivo: ${abs}`);
  if (MODEL_EXT.includes(extname(abs).toLowerCase())) return probeModel(abs);
  const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', abs]);
  const info = JSON.parse(stdout.toString()) as { streams: ProbeStream[]; format: { duration?: string; format_name?: string } };
  const ext = extname(abs).toLowerCase();
  const v = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new Error(`Formato no compatible: ${abs}`);
  const isImage = !!v && (IMAGE_EXT.includes(ext) || /image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe/.test(info.format.format_name ?? ''));
  const kind: MediaKind = isImage ? 'image' : v ? 'video' : 'audio';
  let w = v?.width ?? 0, h = v?.height ?? 0;
  const rot = Math.abs(Number(v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)) % 360;
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  const duration = isImage ? 0 : Number(info.format.duration ?? v?.duration ?? a?.duration ?? 0);
  return {
    id: uid('m'),
    path: abs,
    kind,
    duration: Math.round(duration * 1000) / 1000,
    width: w,
    height: h,
    fps: v ? Math.round((rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30) * 1000) / 1000 : 0,
    hasAudio: !!a,
    hasVideo: !!v,
    rotation: rot || undefined,
  };
}

/** A 3D model (.glb / .gltf / .obj, advanced mode): meshes, animation clips and size read from the file. */
export function probeModel(path: string): MediaItem {
  const abs = resolve(path), ext = extname(abs).toLowerCase();
  let info: ModelInfo;
  try {
    if (ext === '.obj') {
      info = objInfo(readFileSync(abs, 'utf8'));
      // textures of its material libraries are files it needs too
      for (const lib of [...info.files]) { const f = join(dirname(abs), lib); if (existsSync(f)) info.files.push(...mtlTextures(readFileSync(f, 'utf8'))); }
    } else info = gltfInfo(gltfJson(readFileSync(abs)), ext === '.glb' ? 'glb' : 'gltf');
  } catch (e) { throw new Error(`No se pudo leer el modelo 3D ${abs}: ${(e as Error).message}`); }
  const missing = info.files.filter((f) => !existsSync(join(dirname(abs), f)));
  if (missing.length) throw new Error(`Al modelo 3D le faltan archivos junto a él: ${missing.join(', ')}`);
  const duration = Math.max(0, ...info.clips.map((c) => c.duration));
  return { id: uid('m'), path: abs, kind: 'model', duration: Math.round(duration * 1000) / 1000, width: 0, height: 0, fps: 0, hasAudio: false, hasVideo: false, model: info };
}
