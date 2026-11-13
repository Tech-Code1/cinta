// The .cinta project model: plain JSON shared by the app, the MCP server and the renderer.
// Times are seconds. Clip timeline duration = (out - in) / speed.

export type TrackKind = 'title' | 'overlay' | 'main' | 'audio';
export type ClipType = 'video' | 'image' | 'audio' | 'color' | 'title' | 'sticker' | 'callout';
export type MediaKind = 'video' | 'audio' | 'image' | 'model';

export interface MediaItem {
  id: string;
  path: string;
  kind: MediaKind;
  duration: number; // images: 0
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  rotation?: number;
  /** word-timed transcript of the parts used (source seconds), see transcript.ts */
  transcript?: import('./transcript').Transcript;
  /** rendered copy of an advanced-mode composition (re-rendered when the composition changes) */
  compId?: string;
  compHash?: string;
  /** After Effects' footage proxy: a lighter copy drawn instead (at the original size) while `on` */
  proxy?: { path: string; width: number; height: number; on: boolean };
  /** OpenEXR footage: `path` is its beauty; the channels stay in the EXR file(s) for the 3D Channel effects */
  exr?: ExrInfo;
  /** 3D model (.glb / .gltf / .obj): what it contains (kind 'model') */
  model?: import('./motion/model3d').ModelInfo;
  /** footage converted on import (sequences, Targa, DPX, Cineon, Camera Raw, HEIF, MXF…): the original file(s) and the
   *  interpretation (Interpretar material de archivo); `path` is the playable copy (footage.ts) */
  footage?: import('./footage').FootageInfo;
}
export interface ExrInfo {
  /** the EXR (first file of a sequence) */
  source: string;
  /** sequences: printf pattern (shot.%04d.exr), frame range and rate */
  pattern?: string; first?: number; last?: number; fps?: number;
  channels: { name: string; type: number }[];
  compression: number;
  /** Cryptomatte layers: name, ranked channels, how many names its manifest lists */
  crypto: { name: string; channels: string[]; names: number }[];
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  hidden: boolean;
  muted: boolean;
  locked: boolean;
  /** main track: allow empty space between clips (Movavi "Habilitar espacio vacío") */
  gaps: boolean;
  /** audio track: lower its volume while other tracks have sound (ducking) */
  duck?: boolean;
  /** title/overlay track: its clips move with the main video track when that is edited (default true) */
  linked?: boolean;
}

export interface ColorAdjust {
  preset?: 'auto-contrast' | 'auto-saturation' | 'white-balance' | 'magic';
  brightness?: number; // -1..1
  contrast?: number; // -1..1
  saturation?: number; // -1..1
  hue?: number; // degrees -180..180
  temperature?: number; // -1..1 (cold..warm)
  tint?: number; // -1..1 (green..magenta)
  exposure?: number; // -1..1
  gamma?: number; // -1..1
  shadows?: number; // -1..1
  highlights?: number; // -1..1
  sharpen?: number; // 0..1
  vignette?: number; // 0..1
  lut?: string; // path to .cube
  lutAmount?: number; // 0..1
}

export interface FilterRef {
  id: string;
  type: string; // catalog id
  amount: number; // 0..1
  enabled: boolean;
}

export interface AudioFx {
  eq?: number[]; // 10 bands, dB -20..20
  eqPreset?: string;
  compressor?: { threshold: number; ratio: number; attack: number; release: number; makeup: number; mix: number };
  gate?: { threshold: number; range: number; attack: number; release: number };
  reverb?: { delay: number; decay: number; wet: number };
  denoise?: number; // 0..1
  enhance?: 'studio' | 'noisy' | 'voice';
  effect?: string; // catalog id (echo, robot, phone...)
}

export interface Transform {
  x: number; // center, 0..1 of the frame
  y: number;
  scale: number; // 1 = fit the frame
  rotation: number; // degrees
}

export interface Keyframe {
  t: number; // seconds from clip start (timeline)
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

export interface TitleStyle {
  text: string;
  style: string; // catalog id
  font: string;
  size: number; // px at 1080p height
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  outline: number;
  outlineColor: string;
  shadow: number;
  shadowColor: string;
  background: boolean;
  backgroundColor: string;
  x: number; // anchor point 0..1
  y: number;
  anim: string; // catalog id of the text animation
  animSpeed: number; // 0.25..4
  timerFrom?: number; // countdown timer titles
  /** karaoke captions: colour of the word being spoken */
  highlight?: string;
  uppercase?: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  type: ClipType;
  mediaId?: string;
  start: number;
  in: number;
  out: number;
  speed: number;
  reverse: boolean;
  keepPitch: boolean;
  volume: number; // 1 = 100 %
  volumeKeys?: { t: number; v: number }[];
  muted: boolean;
  normalize: boolean;
  fadeIn: number;
  fadeOut: number;
  opacity: number;
  hidden: boolean;
  /** main-track video clip whose audio was separated into an audio clip */
  audioDetached?: boolean;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  straighten: number; // degrees
  crop?: { x: number; y: number; w: number; h: number }; // normalized
  /** face/subject path (t = source seconds, x/y = 0..1 of the source): the crop window follows it */
  focusTrack?: { t: number; x: number; y: number }[];
  color?: ColorAdjust;
  filters: FilterRef[];
  audio?: AudioFx;
  transform?: Transform;
  pip?: string; // layout id
  chroma?: { color: string; tolerance: number; blend: number; noise: number; edges: number; opacity: number };
  /** trf = vid.stab transforms computed from source second `from` (the clip's in point when analysed) */
  stabilize?: { accuracy: number; shakiness: number; smoothing: number; crop: 'keep' | 'black'; zoom: number; trf?: string; from?: number };
  panZoom?: { preset?: string; from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number } };
  mask?: { shape: 'ellipse' | 'rect'; mode: 'black' | 'blur' | 'pixelate' | 'light' | 'bright'; x: number; y: number; w: number; h: number; feather: number; opacity: number; invert: boolean; track?: { t: number; x: number; y: number }[] };
  animIn?: { type: string; duration: number };
  animOut?: { type: string; duration: number };
  keyframes?: Keyframe[];
  /** transition from this clip into the next one (main track) */
  transition?: { type: string; duration: number };
  title?: TitleStyle;
  sticker?: { name: string; color?: string };
  callout?: { shape: string; color: string; stroke: number; fill?: string; text?: string };
  fill?: string; // color clip: CSS color or "gradient:#a,#b"
  name?: string;
}

export interface Marker {
  id: string;
  time: number;
  name: string;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  background: string;
}

export interface Project {
  format: 'cinta';
  version: 1;
  name: string;
  settings: ProjectSettings;
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  /** advanced mode: motion-graphics compositions (see core/motion) */
  comps?: import('./motion/model').Comp[];
  /** advanced mode: the render queue (items render in order) */
  renderQueue?: import('./motion/model').RenderItem[];
  /** advanced mode: colour settings (After Effects' Project Settings › Color): bits per channel of the compositing,
   *  and whether layers blend in linear light (Blend Colors Using 1.0 Gamma). Absent: 8 bpc, gamma-encoded. */
  motionColor?: { depth: 8 | 16 | 32; blendGamma1: boolean };
  /** advanced mode: data files (JSON, MGJSON, CSV, TSV) read by expressions with footage("name") */
  dataItems?: import('./motion/data').DataItem[];
}

let seq = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;

export function newTrack(kind: TrackKind, name?: string): Track {
  const names: Record<TrackKind, string> = { title: 'Títulos', overlay: 'Vídeo superpuesto', main: 'Vídeo', audio: 'Audio' };
  return { id: uid('t'), kind, name: name ?? names[kind], hidden: false, muted: false, locked: false, gaps: false };
}

export function newProject(opts: Partial<ProjectSettings> & { name?: string } = {}): Project {
  return {
    format: 'cinta',
    version: 1,
    name: opts.name ?? 'Nuevo proyecto',
    settings: {
      width: even(opts.width ?? 1920),
      height: even(opts.height ?? 1080),
      fps: opts.fps ?? 30,
      sampleRate: opts.sampleRate ?? 48000,
      background: opts.background ?? '#000000',
    },
    media: [],
    tracks: [newTrack('title'), newTrack('main'), newTrack('audio', 'Música')],
    clips: [],
    markers: [],
  };
}

export function newClip(trackId: string, type: ClipType, init: Partial<Clip> = {}): Clip {
  return {
    id: uid('c'),
    trackId,
    type,
    start: 0,
    in: 0,
    out: 5,
    speed: 1,
    reverse: false,
    keepPitch: true,
    volume: 1,
    muted: false,
    normalize: false,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    hidden: false,
    rotate: 0,
    flipH: false,
    flipV: false,
    straighten: 0,
    filters: [],
    ...init,
  };
}

export const defaultTitle = (text: string, over: Partial<TitleStyle> = {}): TitleStyle => ({
  text,
  style: 'basic',
  font: 'Segoe UI',
  size: 80,
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  outline: 0,
  outlineColor: '#000000',
  shadow: 2,
  shadowColor: '#000000',
  background: false,
  backgroundColor: '#000000',
  x: 0.5,
  y: 0.5,
  anim: 'fade',
  animSpeed: 1,
  ...over,
});

export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
export const clipDuration = (c: Clip) => (c.out - c.in) / c.speed;
export const clipEnd = (c: Clip) => c.start + clipDuration(c);
export const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function mainTrack(p: Project): Track {
  const t = p.tracks.find((x) => x.kind === 'main');
  if (!t) throw new Error('El proyecto no tiene pista principal');
  return t;
}

export const trackClips = (p: Project, trackId: string) => p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);

export const mediaOf = (p: Project, c: Clip) => (c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined);

/** Clip has a sound stream that should be mixed. */
export function clipHasAudio(p: Project, c: Clip): boolean {
  if (c.type === 'audio') return true;
  if (c.type !== 'video' || c.audioDetached) return false;
  return !!mediaOf(p, c)?.hasAudio;
}

/** Usable transition length between two neighbours (never longer than half of either clip). */
export function transitionLength(a: Clip, b: Clip | undefined): number {
  if (!a.transition || !b) return 0;
  return Math.max(0, Math.min(a.transition.duration, clipDuration(a) / 2, clipDuration(b) / 2));
}

/** Magnetic main track: clips butt against each other, overlapping by their transitions. */
export function packMain(p: Project): void {
  const t = mainTrack(p);
  const clips = trackClips(p, t.id);
  let at = 0;
  clips.forEach((c, i) => {
    if (t.gaps) {
      c.start = Math.max(c.start, i === 0 ? 0 : clipEnd(clips[i - 1]) - transitionLength(clips[i - 1], c));
    } else {
      c.start = i === 0 ? 0 : at - transitionLength(clips[i - 1], c);
    }
    c.start = r3(Math.max(0, c.start));
    at = clipEnd(c);
  });
}

export function projectDuration(p: Project): number {
  let d = 0;
  for (const c of p.clips) {
    const t = p.tracks.find((x) => x.id === c.trackId);
    if (!t) continue;
    d = Math.max(d, clipEnd(c));
  }
  return r3(d);
}

export function validateProject(raw: unknown): Project {
  const p = raw as Project;
  if (!p || p.format !== 'cinta' || !Array.isArray(p.clips) || !Array.isArray(p.tracks)) throw new Error('No es un proyecto de Cinta válido');
  p.media ??= [];
  p.markers ??= [];
  for (const c of p.clips) c.filters ??= [];
  return p;
}

export function formatTime(s: number, ms = true): string {
  const neg = s < 0;
  s = Math.abs(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return (neg ? '-' : '') + (ms ? `${base}.${String(Math.floor((s % 1) * 1000 + 1e-6)).padStart(3, '0')}` : base);
}

/**
 * Maps a time on the old main track to the same picture on the new one (after cuts, trims, reordering,
 * speed changes or silence removal), following the source time of the clip under it. Times inside deleted
 * material go to where the next surviving material now starts.
 */
export function mainTimeMap(before: Project, after: Project): (t: number) => number {
  const oldMain = before.tracks.find((t) => t.kind === 'main');
  const newMain = after.tracks.find((t) => t.kind === 'main');
  if (!oldMain || !newMain) return (t) => t;
  const olds = trackClips(before, oldMain.id);
  const news = trackClips(after, newMain.id);
  const oldEnd = olds.length ? clipEnd(olds[olds.length - 1]) : 0;
  const newEnd = news.length ? clipEnd(news[news.length - 1]) : 0;
  const srcOf = (c: Clip, t: number) => (c.reverse ? c.out - (t - c.start) * c.speed : c.in + (t - c.start) * c.speed);
  const timeOf = (c: Clip, src: number) => c.start + (c.reverse ? c.out - src : src - c.in) / c.speed;
  const exact = (t: number): number | null => {
    const o = olds.find((c) => t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6);
    if (!o) return null;
    const src = srcOf(o, t);
    const sameMedia = news.filter((n) => (n.id === o.id || (o.mediaId && n.mediaId === o.mediaId) || (!o.mediaId && n.type === o.type && n.fill === o.fill)) && src >= Math.min(n.in, n.out) - 1e-6 && src <= Math.max(n.in, n.out) + 1e-6);
    if (!sameMedia.length) return null;
    const hit = sameMedia.find((n) => n.id === o.id) ?? sameMedia.sort((a, b) => Math.abs(a.start - o.start) - Math.abs(b.start - o.start))[0];
    return timeOf(hit, src);
  };
  return (t: number) => {
    if (t >= oldEnd - 1e-6) return Math.max(0, t + newEnd - oldEnd);
    const e = exact(t);
    if (e !== null) return r3(e);
    // deleted material: snap to the next old clip that still exists
    for (const o of olds) {
      if (o.start <= t) continue;
      const n = exact(o.start + 1e-4);
      if (n !== null) return r3(Math.max(0, n - 1e-4));
    }
    return r3(newEnd);
  };
}
