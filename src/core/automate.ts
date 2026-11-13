// High-level edits for AI use: remove silences, auto subtitles, reframe, music with ducking, join, slideshow,
// scene/beat detection, audio sync and stabilization.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { audioOffset, detectBeats, detectScenes, detectSilences, stabilizeAnalyze } from './analysis';
import { ASPECTS, PAN_ZOOM, findIn } from './catalog';
import { clipDuration, clipEnd, mainTrack, newTrack, projectDuration, r3, trackClips, uid, type Clip, type Project } from './model';
import type { Editor } from './ops';
import { buildSrt, chunkCues, parseSrt, type Cue } from './srt';
import { transcribe } from './speech';
import { trackFace, type FocusPoint } from './faces';

const mediaPath = (p: Project, c: Clip) => p.media.find((m) => m.id === c.mediaId);

/** Clips with sound to analyse: given ids, or every video/audio clip of the main track. */
function targets(e: Editor, ids?: string[]): Clip[] {
  const p = e.project;
  const list = ids?.length ? ids.map((id) => e.clip(id)) : trackClips(p, mainTrack(p).id);
  return list.filter((c) => (c.type === 'video' || c.type === 'audio') && mediaPath(p, c)?.hasAudio);
}

/**
 * Cuts out silent passages (like the shorts kit's pause removal). Each clip is replaced by the spoken pieces,
 * keeping `padding` seconds of air around speech. Returns how much was removed.
 */
export async function removeSilences(e: Editor, o: { clipIds?: string[]; threshold?: number; minSilence?: number; padding?: number } = {}) {
  const p = e.project;
  const pad = o.padding ?? 0.12;
  const plan: { clip: Clip; keep: { in: number; out: number }[] }[] = [];
  for (const c of targets(e, o.clipIds)) {
    if (c.reverse) continue;
    const m = mediaPath(p, c)!;
    const sil = await detectSilences(m.path, { threshold: o.threshold ?? -35, minDuration: o.minSilence ?? 0.6, from: c.in, to: c.out });
    const keep: { in: number; out: number }[] = [];
    let at = c.in;
    for (const s of sil) {
      const a = Math.max(c.in, s.start + pad), b = Math.min(c.out, s.end - pad);
      if (b - a < 0.05) continue;
      if (a - at > 0.05) keep.push({ in: at, out: a });
      at = b;
    }
    if (c.out - at > 0.05) keep.push({ in: at, out: c.out });
    if (keep.length === 1 && Math.abs(keep[0].in - c.in) < 1e-3 && Math.abs(keep[0].out - c.out) < 1e-3) continue;
    plan.push({ clip: c, keep });
  }
  const before = projectDuration(p);
  let pieces = 0;
  e.mutate('Quitar silencios', (pp) => {
    for (const { clip, keep } of plan) {
      const t = pp.tracks.find((x) => x.id === clip.trackId)!;
      const orig = pp.clips.find((x) => x.id === clip.id)!;
      pp.clips = pp.clips.filter((x) => x !== orig);
      let start = orig.start;
      keep.forEach((k, i) => {
        const piece: Clip = { ...structuredClone(orig), id: uid('c'), in: r3(k.in), out: r3(k.out), start: r3(start + i * 1e-6) };
        if (i > 0) piece.fadeIn = 0;
        if (i < keep.length - 1) { piece.fadeOut = 0; delete piece.transition; }
        pp.clips.push(piece);
        pieces++;
        start += clipDuration(piece);
      });
      // free tracks: pull later clips of the same track back by the removed time
      if (t.kind !== 'main') {
        const removed = clipDuration(orig) - keep.reduce((s, k) => s + (k.out - k.in) / orig.speed, 0);
        for (const x of pp.clips) if (x.trackId === t.id && x.start > orig.start + 1e-3 && !keep.length) x.start = r3(x.start - removed);
      }
    }
  });
  return { clips: plan.length, pieces, removedSeconds: r3(before - projectDuration(e.project)), duration: projectDuration(e.project) };
}

/** Speech of the main track (or given clips) mapped to timeline time. */
export async function transcribeTimeline(e: Editor, o: { clipIds?: string[]; language?: string; modelDir?: string; onProgress?: (f: number) => void } = {}): Promise<Cue[]> {
  const p = e.project;
  const list = targets(e, o.clipIds);
  const cues: Cue[] = [];
  for (const [i, c] of list.entries()) {
    const m = mediaPath(p, c)!;
    const segs = await transcribe(m.path, { language: o.language, modelDir: o.modelDir, from: c.in, duration: c.out - c.in, onProgress: (f) => o.onProgress?.((i + f) / list.length) });
    for (const s of segs) {
      const a = c.start + (s.start - c.in) / c.speed, b = c.start + (s.end - c.in) / c.speed;
      if (b > c.start && a < clipEnd(c)) cues.push({ start: r3(Math.max(c.start, a)), end: r3(Math.min(clipEnd(c), b)), text: s.text });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Puts cues on a (new) subtitle track as title clips. */
export function cuesToTrack(e: Editor, cues: Cue[], o: { style?: string; trackName?: string; replace?: boolean } = {}) {
  const style = o.style ?? 'subtitle';
  return e.mutate('Subtítulos', (p) => {
    const name = o.trackName ?? 'Subtítulos';
    let t = p.tracks.find((x) => x.kind === 'title' && x.name === name);
    if (t && o.replace !== false) p.clips = p.clips.filter((c) => c.trackId !== t!.id);
    if (!t) { t = newTrack('title', name); p.tracks.unshift(t); }
    const tid = t.id;
    return cues.map((cue) => {
      const c = e.addTitleRaw(tid, cue.text, style, cue.start, Math.max(0.3, cue.end - cue.start));
      return c.id;
    }).length;
  });
}

export async function autoSubtitles(e: Editor, o: { clipIds?: string[]; language?: string; modelDir?: string; style?: string; maxChars?: number; words?: number; srtPath?: string; onProgress?: (f: number) => void } = {}) {
  const raw = await transcribeTimeline(e, o);
  const short = o.style === 'subtitle-shorts' || o.style === 'subtitle-karaoke';
  const cues = chunkCues(raw, { maxChars: o.maxChars ?? (short ? 18 : 42), maxLines: short ? 1 : 2, words: o.words ?? (o.style === 'subtitle-karaoke' ? 3 : undefined) });
  const count = cuesToTrack(e, cues, { style: o.style });
  if (o.srtPath) writeFileSync(resolve(o.srtPath), buildSrt(cues), 'utf8');
  return { segments: raw.length, captions: count, srt: o.srtPath ? resolve(o.srtPath) : undefined, text: raw.map((c) => c.text).join(' ') };
}

export function importSubtitles(e: Editor, path: string, o: { style?: string; offset?: number } = {}) {
  const cues = parseSrt(readFileSync(resolve(path), 'utf8')).map((c) => ({ ...c, start: c.start + (o.offset ?? 0), end: c.end + (o.offset ?? 0) }));
  return { captions: cuesToTrack(e, cues, { style: o.style }) };
}

export function exportSubtitles(e: Editor, path: string, o: { trackId?: string } = {}) {
  const p = e.project;
  const tracks = o.trackId ? [e.track(o.trackId)] : p.tracks.filter((t) => t.kind === 'title');
  const cues: Cue[] = [];
  for (const t of tracks) for (const c of trackClips(p, t.id)) if (c.title && c.title.timerFrom === undefined) cues.push({ start: c.start, end: clipEnd(c), text: c.title.text.replace(/\\N/g, '\n') });
  cues.sort((a, b) => a.start - b.start);
  writeFileSync(resolve(path), buildSrt(cues), 'utf8');
  return { path: resolve(path), captions: cues.length };
}

/**
 * Changes the project to another aspect ratio. "crop": centre-crop every main clip to fill the frame;
 * "blur": keep the whole picture over a blurred, zoomed copy (classic vertical video look); "fit": letterbox.
 */
export async function reframe(e: Editor, o: { aspect: string; mode?: 'blur' | 'crop' | 'fit' | 'face'; focusX?: number; focusY?: number; onProgress?: (f: number) => void }) {
  const a = findIn(ASPECTS, o.aspect, 'Relación de aspecto');
  const mode = o.mode ?? 'blur';
  // 'face': follow the speaker like the shorts kit (Windows face detector, smoothed path)
  const tracks = new Map<string, FocusPoint[] | null>();
  if (mode === 'face') {
    const list = trackClips(e.project, mainTrack(e.project).id).filter((c) => c.type === 'video' && !c.reverse);
    for (const [i, c] of list.entries()) {
      const m = mediaPath(e.project, c)!;
      tracks.set(c.id, await trackFace(m.path, c.in, c.out, { onProgress: (f) => o.onProgress?.((i + f) / list.length) }));
    }
  }
  let faces = 0;
  const out = e.mutate('Reencuadrar', (p) => {
    p.settings.width = a.width;
    p.settings.height = a.height;
    const target = a.width / a.height;
    const main = mainTrack(p);
    let overlay = p.tracks.find((t) => t.kind === 'overlay' && t.name === 'Reencuadre');
    for (const c of trackClips(p, main.id)) {
      const m = mediaPath(p, c);
      if (!m || !m.width) continue;
      const sw = c.rotate === 90 || c.rotate === 270 ? m.height : m.width;
      const sh = c.rotate === 90 || c.rotate === 270 ? m.width : m.height;
      const src = sw / sh;
      const fill = (fx = 0.5, fy = 0.5) => {
        if (src > target) { const w = target / src; return { x: r3(Math.min(1 - w, Math.max(0, fx - w / 2))), y: 0, w: r3(w), h: 1 }; }
        const h = src / target;
        return { x: 0, y: r3(Math.min(1 - h, Math.max(0, fy - h / 2))), w: 1, h: r3(h) };
      };
      if (mode === 'fit') { delete c.crop; continue; }
      if (mode === 'crop') { c.crop = fill(o.focusX, o.focusY); delete c.focusTrack; continue; }
      if (mode === 'face') {
        const tr = tracks.get(c.id);
        if (tr?.length) {
          faces++;
          const mid = (k: 'x' | 'y') => [...tr.map((q) => q[k])].sort((x, y) => x - y)[Math.floor(tr.length / 2)];
          c.crop = fill(mid('x'), mid('y'));
          c.focusTrack = tr;
        } else { c.crop = fill(0.5, 0.4); delete c.focusTrack; }
        continue;
      }
      if (!overlay) {
        overlay = newTrack('overlay', 'Reencuadre');
        p.tracks.splice(p.tracks.indexOf(main), 0, overlay);
      }
      const fg: Clip = { ...structuredClone(c), id: uid('c'), trackId: overlay.id, muted: true, transition: undefined, audioDetached: true, transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 } };
      delete fg.crop;
      p.clips.push(fg);
      c.crop = fill();
      c.filters = [...c.filters.filter((f) => f.type !== 'blur'), { id: uid('f'), type: 'blur', amount: 0.85, enabled: true }];
      c.color = { ...c.color, brightness: -0.25 };
    }
    return { width: a.width, height: a.height, mode };
  });
  return mode === 'face' ? { ...out, clipsWithFace: faces } : out;
}

/** Adds background music under the whole project (looped), on a ducking track. */
export async function addMusic(e: Editor, path: string, o: { volume?: number; duck?: boolean; fadeIn?: number; fadeOut?: number; start?: number; loop?: boolean } = {}) {
  const [m] = await e.importMedia([path]);
  if (!m.hasAudio) throw new Error('Ese archivo no tiene sonido');
  return e.mutate('Añadir música', (p) => {
    let t = p.tracks.find((x) => x.kind === 'audio' && x.name === 'Música');
    if (!t) { t = newTrack('audio', 'Música'); p.tracks.push(t); }
    t.duck = o.duck ?? true;
    const total = Math.max(projectDuration(p), 1);
    const start = o.start ?? 0;
    let at = start;
    const made: Clip[] = [];
    do {
      const len = Math.min(m.duration, total - at);
      if (len < 0.1) break;
      const c = { ...e.newAudioClip(t.id, m.id, at, len), volume: o.volume ?? 0.5 };
      made.push(c);
      p.clips.push(c);
      at += len;
    } while (o.loop !== false && at < total - 0.1);
    if (made.length) {
      made[0].fadeIn = o.fadeIn ?? 1.5;
      made[made.length - 1].fadeOut = o.fadeOut ?? 2.5;
    }
    return { track: t.id, clips: made.map((c) => c.id), duck: t.duck };
  });
}

export async function detectScenesSplit(e: Editor, clipId: string, o: { threshold?: number; minScene?: number } = {}) {
  const c = e.clip(clipId);
  const m = mediaPath(e.project, c);
  if (!m || m.kind !== 'video') throw new Error('La detección de escenas necesita un clip de vídeo');
  const cuts = await detectScenes(m.path, { threshold: o.threshold, minScene: o.minScene, from: c.in, to: c.out });
  const times = cuts.map((s) => c.start + (s - c.in) / c.speed).filter((t) => t > c.start + 0.1 && t < clipEnd(c) - 0.1);
  let current = c.id;
  for (const t of times) {
    const [right] = e.split(t, [current]);
    current = right.id;
  }
  return { scenes: times.length + 1, cuts: times.map(r3) };
}

export async function detectBeatsMarkers(e: Editor, clipId: string, o: { minInterval?: number } = {}) {
  const c = e.clip(clipId);
  const m = mediaPath(e.project, c);
  if (!m?.hasAudio) throw new Error('La detección de ritmo necesita un clip con sonido');
  const beats = await detectBeats(m.path, { minInterval: o.minInterval, from: c.in, duration: c.out - c.in });
  const times = beats.map((b) => r3(c.start + (b - c.in) / c.speed)).filter((t) => t >= c.start && t <= clipEnd(c));
  e.mutate('Detectar compases', (p) => {
    for (const t of times) p.markers.push({ id: uid('k'), time: t, name: 'Ritmo' });
    p.markers.sort((a, b) => a.time - b.time);
  });
  return { beats: times.length, times };
}

/** Moves clip B so its sound lines up with clip A (both need audio, on different tracks). */
export async function syncAudio(e: Editor, clipA: string, clipB: string) {
  const a = e.clip(clipA), b = e.clip(clipB);
  if (a.trackId === b.trackId) throw new Error('Coloque los clips en distintas pistas.');
  const ma = mediaPath(e.project, a), mb = mediaPath(e.project, b);
  if (!ma?.hasAudio || !mb?.hasAudio) throw new Error('Seleccione dos clips con sonido.');
  const { offset, confidence } = await audioOffset(ma.path, mb.path);
  const start = r3(a.start - a.in / a.speed + b.in / b.speed - offset);
  if (e.track(b.trackId).kind === 'main') throw new Error('El clip que se mueve no puede estar en la pista principal');
  e.move(b.id, { start: Math.max(0, start) });
  return { offset: r3(offset), confidence, start: e.clip(b.id).start };
}

export async function stabilizeClip(e: Editor, clipId: string, o: { accuracy?: number; shakiness?: number; smoothing?: number; crop?: 'keep' | 'black'; zoom?: number; onProgress?: (f: number) => void } = {}) {
  const c = e.clip(clipId);
  const m = mediaPath(e.project, c);
  if (!m || m.kind !== 'video') throw new Error('Solo se pueden estabilizar clips de vídeo');
  // analyse exactly the part of the source the clip uses (pieces cut from it later stay aligned)
  const trf = await stabilizeAnalyze(m, { accuracy: o.accuracy, shakiness: o.shakiness, from: c.in, to: c.out }, o.onProgress);
  e.set(clipId, { stabilize: { accuracy: o.accuracy ?? 9, shakiness: o.shakiness ?? 5, smoothing: o.smoothing ?? 15, crop: o.crop ?? 'keep', zoom: o.zoom ?? 0, trf, from: c.in } });
  return { trf };
}

/** Slideshow wizard: photos (and videos) with transitions, optional pan & zoom and music. */
export async function slideshow(e: Editor, paths: string[], o: { photoDuration?: number; transition?: string; transitionDuration?: number; panZoom?: boolean; music?: string } = {}) {
  const items = await e.importMedia(paths);
  const ids: string[] = [];
  for (const m of items) {
    const c = e.addClip(m.id, m.kind === 'image' ? { duration: o.photoDuration ?? 4 } : {});
    ids.push(c.id);
    if (o.panZoom !== false && m.kind === 'image') {
      const pz = PAN_ZOOM[ids.length % PAN_ZOOM.length];
      e.set(c.id, { panZoom: { preset: pz.id, from: { ...pz.from }, to: { ...pz.to } } });
    }
  }
  e.transitionWizard({ type: o.transition ?? 'random', duration: o.transitionDuration ?? 1, clipIds: ids });
  if (o.music) await addMusic(e, o.music, { duck: false, volume: 0.8 });
  return { clips: ids.length, duration: projectDuration(e.project) };
}
