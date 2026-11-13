// Node side of the advanced mode: export formats, the audio mix of a composition and content hashes for the
// render cache. Frames themselves are drawn by the browser engine (src/motion-render) in Electron.
import { createHash } from 'node:crypto';
import type { Project } from './model';
import { valueAt } from './motion/anim';
import { findComp, type Comp, type Layer } from './motion/model';
import { AUDIO_FX, audioFxGraph, audioStage, toneSource, type AudioStage } from './motion/fx-groups/audio';

export const COMP_FORMATS = [
  { id: 'mp4', name: 'MP4 (H.264)', ext: 'mp4', alpha: false },
  { id: 'mp4-hevc', name: 'MP4 (H.265/HEVC)', ext: 'mp4', alpha: false },
  { id: 'mov-alpha', name: 'MOV ProRes 4444 (con transparencia)', ext: 'mov', alpha: true },
  { id: 'mov', name: 'MOV ProRes 422 HQ', ext: 'mov', alpha: false },
  { id: 'webm-alpha', name: 'WebM VP9 (con transparencia)', ext: 'webm', alpha: true },
  { id: 'gif', name: 'GIF animado', ext: 'gif', alpha: false },
  { id: 'png', name: 'Secuencia PNG (con transparencia)', ext: 'png', alpha: true },
] as const;
export type CompFormat = (typeof COMP_FORMATS)[number]['id'];
export const formatOf = (id: string | undefined, out: string): CompFormat => {
  if (id && COMP_FORMATS.some((f) => f.id === id)) return id as CompFormat;
  const ext = out.toLowerCase().split('.').pop();
  return ext === 'mov' ? 'mov-alpha' : ext === 'webm' ? 'webm-alpha' : ext === 'gif' ? 'gif' : ext === 'png' ? 'png' : 'mp4';
};

/**
 * A piece of sound in comp time. The source (a file, or an aevalsrc graph when `lavfi`) is read from `from` to `to`
 * (seconds), goes through the layer's audio effects (`pre`), is cut to `cut` (seconds after `from`; default all of
 * it), goes through the audio effects of the comp layers holding it (`post`) and plays at `at`.
 */
export interface AudioPiece { path: string; at: number; from: number; to: number; gainDb: number; lavfi?: boolean; pre?: AudioStage[]; cut?: [number, number]; post?: AudioStage[] }

/** Times (layer's comp time, in [a, b]) at which an animated audio effect is sampled: its keyframes and points between
 *  them (eased keys are curves), a regular grid for expressions; at most 48. */
function audioSampleTimes(props: { k?: { t: number }[]; x?: string; xOff?: boolean }[], a: number, b: number): number[] {
  const ts = new Set<number>([a, b]);
  let expr = false;
  for (const q of props) {
    if (q.x && !q.xOff) expr = true;
    const k = q.k ?? [];
    for (let i = 0; i < k.length; i++) {
      ts.add(k[i].t);
      if (i + 1 < k.length) for (let j = 1; j < 4; j++) ts.add(k[i].t + ((k[i + 1].t - k[i].t) * j) / 4);
    }
  }
  if (expr) for (let t = a; t < b; t += Math.max(0.1, (b - a) / 40)) ts.add(t);
  let out = [...ts].filter((t) => t >= a - 1e-9 && t <= b + 1e-9).sort((x, y) => x - y).filter((t, i, arr) => !i || t - arr[i - 1] > 1e-3);
  if (out.length > 48) { const step = (out.length - 1) / 47; out = Array.from({ length: 48 }, (_, i) => out[Math.round(i * step)]); }
  return out;
}

/** The audio effects of a layer (enabled, in order) with their values at `t` — and, when some change over [a, b],
 *  sampled over it; a Tone drops what comes before it. */
function layerAudioFx(comp: Comp, l: Layer, t: number, a = t, b = t): { stages: AudioStage[]; tone?: AudioStage } {
  let stages: AudioStage[] = [], tone: AudioStage | undefined;
  for (const f of l.effects ?? []) {
    if (!f.on || !AUDIO_FX.has(f.fx)) continue;
    const at = (tt: number) => audioStage(f.fx, (k) => (f.params[k] ? valueAt(f.params[k], tt, { comp, layer: l, path: `effects.${f.id}.${k}` }) : undefined));
    const s = at(t);
    // animated parameters (keyframes or an expression): the effect sampled along the layer (Tone keeps its mid value)
    const moving = Object.values(f.params).filter((q) => (q.k?.length ?? 0) > 1 || (q.x && !q.xOff));
    if (moving.length && f.fx !== 'audioTone' && b > a) {
      const ts = audioSampleTimes(moving, a, b), ps = ts.map((tt) => at(tt).p);
      if (ps.some((q) => JSON.stringify(q) !== JSON.stringify(ps[0]))) s.anim = { t: ts, p: ps };
    }
    if (f.fx === 'audioTone') { tone = s; stages = []; } else stages.push(s);
  }
  return { stages, tone };
}

/** Every piece of sound in a composition (nested comps flattened), in comp time. */
export function compAudio(p: Project, comp: Comp, sequencePath?: string, offset = 0, window: [number, number] = [0, comp.duration], depth = 0): AudioPiece[] {
  const out: AudioPiece[] = [];
  if (depth > 8) return out;
  const solo = comp.layers.some((l) => l.solo);
  for (const l of comp.layers) {
    if (l.audio.muted || l.guide || (solo && !l.solo && l.type !== 'audio') || l.hidden && l.type !== 'audio') continue;
    const a = Math.max(l.in, window[0]), b = Math.min(l.out, window[1]);
    if (b <= a) continue;
    const gainDb = Number(valueAt(l.audio.level, (a + b) / 2, { comp, layer: l, path: 'audio.level' })) || 0;
    const stretch = l.stretch || 1;
    const { stages, tone } = layerAudioFx(comp, l, (a + b) / 2, l.in, l.out);
    // sample times of animated effects in the top comp's time
    for (const s of stages) if (s.anim) s.anim.t = s.anim.t.map((tt) => tt + offset);
    // Tone replaces the layer's sound (any layer can carry it, even one without audio)
    if (tone) {
      out.push({ path: toneSource(tone, l.out - l.in), lavfi: true, at: offset + a, from: 0, to: l.out - l.in, cut: [a - l.in, b - l.in], gainDb, pre: stages });
      continue;
    }
    if (l.type === 'comp' && l.compId && stretch === 1) {
      const sub = p.comps?.find((c) => c.id === l.compId);
      if (!sub) continue;
      // the comp layer's effects go after each piece's own; Backwards also mirrors where the pieces play
      const flips = stages.filter((s) => s.fx === 'audioBackwards').length % 2 === 1;
      for (const x of compAudio(p, sub, sequencePath, offset + l.start, [a - l.start, b - l.start], depth + 1)) {
        const len = x.cut ? x.cut[1] - x.cut[0] : x.to - x.from;
        out.push({ ...x, gainDb: x.gainDb + gainDb, at: flips ? 2 * offset + a + b - x.at - len : x.at, post: stages.length ? [...(x.post ?? []), ...stages] : x.post });
      }
      continue;
    }
    let path: string | undefined;
    if (l.type === 'sequence') path = sequencePath;
    else if (l.type === 'video' || l.type === 'audio') { const m = p.media.find((x) => x.id === l.mediaId); if (m?.hasAudio) path = m.path; }
    if (!path || stretch !== 1) continue;
    // with effects the whole layer goes through them (echoes, reversal…) and is cut afterwards
    if (stages.length) out.push({ path, at: offset + a, from: l.in - l.start, to: l.out - l.start, cut: [a - l.in, b - l.in], gainDb, pre: stages });
    else out.push({ path, at: offset + a, from: a - l.start, to: b - l.start, gainDb });
  }
  return out;
}

/** ffmpeg inputs + filter that mix the pieces into one stereo track starting at `from` (comp time). */
export function audioMixArgs(pieces: AudioPiece[], firstInput: number, from: number, dur: number): { inputs: string[]; filter: string; label: string } | null {
  if (!pieces.length) return null;
  const inputs: string[] = [];
  const parts: string[] = [];
  const fmt = 'asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo';
  pieces.forEach((pc, i) => {
    if (pc.lavfi) inputs.push('-f', 'lavfi');
    inputs.push('-i', pc.path);
    const delay = Math.max(0, Math.round((pc.at - from) * 1000));
    const skip = Math.max(0, from - pc.at);
    const vol = `volume=${pc.gainDb.toFixed(2)}dB,adelay=${delay}|${delay}[a${i}]`;
    if (!pc.pre?.length && !pc.post?.length && !pc.cut) {
      parts.push(`[${firstInput + i}:a]atrim=start=${(pc.from + skip).toFixed(4)}:end=${pc.to.toFixed(4)},${fmt},${vol}`);
      return;
    }
    // source → layer effects → cut → comp layer effects → what's before `from` dropped
    const [c0, c1] = pc.cut ?? [0, pc.to - pc.from];
    parts.push(`[${firstInput + i}:a]atrim=start=${pc.from.toFixed(4)}:end=${pc.to.toFixed(4)},${fmt}[p${i}a]`);
    parts.push(audioFxGraph(pc.pre ?? [], `p${i}a`, `p${i}b`, `p${i}e`, 48000, pc.at - c0, pc.to - pc.from));
    parts.push(`[p${i}b]atrim=start=${c0.toFixed(4)}:end=${c1.toFixed(4)},asetpts=PTS-STARTPTS[p${i}c]`);
    parts.push(audioFxGraph(pc.post ?? [], `p${i}c`, `p${i}d`, `p${i}f`, 48000, pc.at, c1 - c0));
    parts.push(`[p${i}d]atrim=start=${skip.toFixed(4)}:end=${(c1 - c0).toFixed(4)},asetpts=PTS-STARTPTS,${vol}`);
  });
  const mix = pieces.length > 1 ? `${pieces.map((_, i) => `[a${i}]`).join('')}amix=inputs=${pieces.length}:normalize=0:dropout_transition=0,atrim=duration=${dur.toFixed(4)}[aout]` : `[a0]apad,atrim=duration=${dur.toFixed(4)}[aout]`;
  return { inputs, filter: [...parts, mix].join(';'), label: '[aout]' };
}

/** Encoder arguments for a comp export. */
export function encoderArgs(fmt: CompFormat, quality: 'high' | 'medium' | 'low' = 'high'): string[] {
  const crf = quality === 'high' ? 16 : quality === 'medium' ? 21 : 26;
  switch (fmt) {
    case 'mp4': return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    case 'mp4-hevc': return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf + 4), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart'];
    case 'mov-alpha': return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'];
    case 'mov': return ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0'];
    case 'webm-alpha': return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(crf + 14), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'];
    case 'gif': return [];
    case 'png': return ['-c:v', 'png', '-pix_fmt', 'rgba'];
  }
}
export const audioCodecFor = (fmt: CompFormat): string[] | null =>
  fmt === 'gif' || fmt === 'png' ? null : fmt === 'webm-alpha' ? ['-c:a', 'libopus', '-b:a', '192k'] : fmt.startsWith('mov') ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '256k'];

/** Hash of everything that affects a comp's pixels (layers, nested comps, media paths and dates). */
export function compHash(p: Project, compId: string, extra = ''): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const c = findComp(p.comps, id);
    // the comp's own proxy is not part of its pixels (it is made from them)
    parts.push(JSON.stringify({ ...c, proxy: undefined, roi: undefined }));
    for (const l of c.layers) {
      if (l.compId) walk(l.compId);
      if (l.mediaId) { const m = p.media.find((x) => x.id === l.mediaId); if (m) parts.push(m.path); }
      // Media Replacement overrides name other footage
      for (const o of l.overrides ?? []) if (typeof o.prop.v === 'string') { const m = p.media.find((x) => x.id === o.prop.v); if (m) parts.push(m.path); }
      if (l.type === 'sequence') parts.push(JSON.stringify({ c: p.clips, t: p.tracks, s: p.settings }));
    }
  };
  walk(compId);
  // the project colour settings change how every layer blends
  if (p.motionColor) parts.push(JSON.stringify(p.motionColor));
  // data files read by expressions (reloading one changes the frames)
  if (p.dataItems?.length) parts.push(JSON.stringify(p.dataItems.map((d) => [d.name, d.text])));
  return createHash('sha1').update(parts.join('|') + extra).digest('hex').slice(0, 16);
}
