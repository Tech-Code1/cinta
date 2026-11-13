// Transcript-based editing (works with no AI at all, and is what Claude uses through MCP):
// a word-timed transcript per media file, mapped onto the timeline; cut by words, phrases or time ranges;
// filler words; chapters; and short videos made from chosen ranges.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clipDuration, clipEnd, mainTrack, newProject, r3, trackClips, type Clip, type Project } from './model';
import { Editor } from './ops';
import { transcribe } from './speech';
import { chunkCues, type Cue } from './srt';

export interface Word { w: string; start: number; end: number }
export interface Segment { start: number; end: number; text: string; words: Word[] }
/** Stored on the media item; times are SOURCE seconds. */
export interface Transcript { language?: string; segments: Segment[]; covered: [number, number][] }

/** Whisper gives timed sentences: words get a share of the sentence proportional to their length. */
export function wordsOf(start: number, end: number, text: string): Word[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const weights = parts.map((w) => w.length + 1);
  const total = weights.reduce((s, v) => s + v, 0) || 1;
  let t = start;
  return parts.map((w, i) => {
    const d = ((end - start) * weights[i]) / total;
    const word = { w, start: r3(t), end: r3(t + d) };
    t += d;
    return word;
  });
}

const covers = (tr: Transcript | undefined, a: number, b: number) => !!tr && tr.covered.some(([x, y]) => x <= a + 0.05 && y >= b - 0.05);

/** Transcribes (once) the parts of the media used by the main track (or the given clips). */
export async function buildTranscript(e: Editor, o: { clipIds?: string[]; language?: string; modelDir?: string; force?: boolean; onProgress?: (f: number) => void } = {}) {
  const p = e.project;
  const list = (o.clipIds?.length ? o.clipIds.map((id) => e.clip(id)) : trackClips(p, mainTrack(p).id))
    .filter((c) => (c.type === 'video' || c.type === 'audio') && p.media.find((m) => m.id === c.mediaId)?.hasAudio);
  const todo = list.filter((c) => o.force || !covers(p.media.find((m) => m.id === c.mediaId)!.transcript as Transcript | undefined, Math.min(c.in, c.out), Math.max(c.in, c.out)));
  let done = 0;
  for (const c of todo) {
    const m = p.media.find((x) => x.id === c.mediaId)!;
    const a = Math.min(c.in, c.out), b = Math.max(c.in, c.out);
    const segs = await transcribe(m.path, { language: o.language, modelDir: o.modelDir, from: a, duration: b - a, onProgress: (f) => o.onProgress?.((done + f) / todo.length) });
    e.mutate('Transcribir', (pp) => {
      const mm = pp.media.find((x) => x.id === m.id)!;
      const prev = (mm.transcript as Transcript | undefined) ?? { segments: [], covered: [] };
      const keep = prev.segments.filter((s) => s.end <= a || s.start >= b);
      mm.transcript = {
        language: o.language ?? prev.language,
        segments: [...keep, ...segs.map((s) => ({ start: s.start, end: s.end, text: s.text, words: wordsOf(s.start, s.end, s.text) }))].sort((x, y) => x.start - y.start),
        covered: [...prev.covered, [a, b] as [number, number]],
      };
    });
    done++;
  }
  return { transcribed: todo.length, clips: list.length };
}

export interface TimelineWord { id: string; w: string; start: number; end: number; clipId: string; seg: number }

/** Words of the main track in timeline order (ids w0, w1… valid until the project changes). */
export function timelineWords(p: Project): TimelineWord[] {
  const out: Omit<TimelineWord, 'id'>[] = [];
  for (const c of trackClips(p, mainTrack(p).id)) {
    const tr = p.media.find((m) => m.id === c.mediaId)?.transcript as Transcript | undefined;
    if (!tr || c.reverse) continue;
    tr.segments.forEach((s, si) => {
      for (const w of s.words) {
        const mid = (w.start + w.end) / 2;
        if (mid < c.in || mid > c.out) continue;
        const a = c.start + (Math.max(w.start, c.in) - c.in) / c.speed;
        const b = c.start + (Math.min(w.end, c.out) - c.in) / c.speed;
        out.push({ w: w.w, start: r3(a), end: r3(Math.min(b, clipEnd(c))), clipId: c.id, seg: si });
      }
    });
  }
  return out.sort((x, y) => x.start - y.start).map((w, i) => ({ ...w, id: `w${i}` }));
}

/** Readable transcript: sentences with their timeline times and word ids. */
export function transcriptView(p: Project) {
  const words = timelineWords(p);
  const sentences: { start: number; end: number; text: string; from: string; to: string }[] = [];
  let cur: TimelineWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    sentences.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.w).join(' '), from: cur[0].id, to: cur[cur.length - 1].id });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (w.seg !== cur[0].seg || w.clipId !== cur[0].clipId || w.start - cur[cur.length - 1].end > 0.6)) flush();
    cur.push(w);
  }
  flush();
  return { words: words.length, sentences };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '').trim();

/** Filler words / hesitations in Spanish, Portuguese and English (no AI needed). */
export const FILLERS = ['eh', 'ehh', 'ehhh', 'em', 'emm', 'mm', 'mmm', 'hmm', 'ah', 'ahh', 'este', 'esteee', 'osea', 'o sea', 'pues', 'bueno', 'digamos', 'tipo', 'ne', 'tipo assim', 'entao', 'uh', 'uhm', 'um', 'umm', 'er', 'erm', 'like', 'you know', 'i mean'];

export function findFillers(p: Project, extra: string[] = []): TimelineWord[][] {
  const words = timelineWords(p);
  const list = [...FILLERS, ...extra].map((f) => norm(f).split(' '));
  const hits: TimelineWord[][] = [];
  for (let i = 0; i < words.length; i++) {
    for (const f of list) {
      if (f.every((part, k) => words[i + k] && norm(words[i + k].w) === part)) {
        // single "bueno"/"pues"/"tipo"/"like" only count as fillers when they start or end a pause-separated chunk
        const soft = f.length === 1 && ['pues', 'bueno', 'tipo', 'like', 'este', 'digamos'].includes(f[0]);
        const gapBefore = i === 0 || words[i].start - words[i - 1].end > 0.25;
        const gapAfter = i + f.length >= words.length || words[i + f.length].start - words[i + f.length - 1].end > 0.25;
        if (soft && !(gapBefore || gapAfter)) continue;
        hits.push(words.slice(i, i + f.length));
        i += f.length - 1;
        break;
      }
    }
  }
  return hits;
}

/** Timeline ranges of phrases (accent/case-insensitive, punctuation ignored). */
export function phraseRanges(p: Project, phrases: string[]): { phrase: string; start: number; end: number }[] {
  const words = timelineWords(p);
  const nw = words.map((w) => norm(w.w));
  const out: { phrase: string; start: number; end: number }[] = [];
  for (const ph of phrases) {
    const parts = norm(ph).split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    for (let i = 0; i + parts.length <= nw.length; i++) {
      if (parts.every((pt, k) => nw[i + k] === pt)) out.push({ phrase: ph, start: words[i].start, end: words[i + parts.length - 1].end });
    }
  }
  return out;
}

export function wordRanges(p: Project, ids: { from: string; to?: string }[]): { start: number; end: number }[] {
  const words = timelineWords(p);
  const idx = new Map(words.map((w, i) => [w.id, i]));
  return ids.map(({ from, to }) => {
    const a = idx.get(from), b = idx.get(to ?? from);
    if (a === undefined || b === undefined) throw new Error(`Palabra desconocida: ${a === undefined ? from : to}. Pida la transcripción otra vez (los ids cambian al editar).`);
    return { start: words[Math.min(a, b)].start, end: words[Math.max(a, b)].end };
  });
}

/**
 * Cuts timeline ranges out of the main track (ripple). Titles and overlays on linked tracks follow.
 * `pad` widens each cut a little into the surrounding silence.
 */
export async function removeTimeRanges(e: Editor, ranges: { start: number; end: number }[], pad = 0.04) {
  const merged = ranges.map((r) => ({ start: Math.max(0, r.start - pad), end: r.end + pad })).filter((r) => r.end - r.start > 0.02).sort((a, b) => a.start - b.start)
    .reduce<{ start: number; end: number }[]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end);
      else acc.push({ ...r });
      return acc;
    }, []);
  const before = e.project.clips.length;
  let removed = 0;
  await e.batch(async () => {
    // from the end, so earlier ranges keep their times
    for (const r of [...merged].reverse()) {
      const main = mainTrack(e.project);
      const cross = (t: number) => trackClips(e.project, main.id).filter((c) => t > c.start + 0.02 && t < clipEnd(c) - 0.02).map((c) => c.id);
      if (cross(r.end).length) e.split(r.end, cross(r.end));
      if (cross(r.start).length) e.split(r.start, cross(r.start));
      const inside = trackClips(e.project, main.id).filter((c) => c.start >= r.start - 0.03 && clipEnd(c) <= r.end + 0.03);
      if (inside.length) { e.remove(inside.map((c) => c.id)); removed += inside.reduce((s, c) => s + clipDuration(c), 0); }
    }
  });
  return { cuts: merged.length, removedSeconds: r3(removed), clipsBefore: before, clipsAfter: e.project.clips.length };
}

// ───────────────────────── chapters ─────────────────────────
export const CHAPTER = 'Capítulo: ';
export function setChapters(e: Editor, chapters: { time: number; title: string }[]) {
  return e.mutate('Capítulos', (p) => {
    p.markers = p.markers.filter((m) => !m.name.startsWith(CHAPTER));
    for (const c of chapters) p.markers.push({ id: `k${Math.random().toString(36).slice(2, 9)}`, time: r3(Math.max(0, c.time)), name: `${CHAPTER}${c.title}` });
    p.markers.sort((a, b) => a.time - b.time);
    return p.markers.filter((m) => m.name.startsWith(CHAPTER)).length;
  });
}
/** YouTube description format: first chapter at 00:00, one per line. */
export function chaptersText(p: Project): string {
  const list = p.markers.filter((m) => m.name.startsWith(CHAPTER)).sort((a, b) => a.time - b.time);
  if (!list.length) return '';
  const ts = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  if (list[0].time > 0.5) list.unshift({ id: '', time: 0, name: `${CHAPTER}Inicio` });
  return list.map((m) => `${ts(m.time)} ${m.name.slice(CHAPTER.length)}`).join('\n');
}

// ───────────────────────── shorts from ranges ─────────────────────────
/** Cues (from the transcript) inside a timeline range, shifted to start at 0. */
export function cuesIn(p: Project, start: number, end: number, words = 3): Cue[] {
  const ws = timelineWords(p).filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  const raw: Cue[] = [];
  let cur: typeof ws = [];
  const flush = () => { if (cur.length) raw.push({ start: cur[0].start - start, end: cur[cur.length - 1].end - start, text: cur.map((w) => w.w).join(' ') }); cur = []; };
  for (const w of ws) { if (cur.length && (w.seg !== cur[0].seg || w.start - cur[cur.length - 1].end > 0.6)) flush(); cur.push(w); }
  flush();
  return chunkCues(raw, { words, maxLines: 1 });
}

/** A new project holding only [start, end] of this project's main track (titles/overlays inside too). */
export function extractRange(p: Project, start: number, end: number, name: string): Editor {
  const e = new Editor(newProject({ width: p.settings.width, height: p.settings.height, fps: p.settings.fps, name }));
  const q = e.project;
  q.media = structuredClone(p.media);
  const mainId = mainTrack(q).id;
  const trackMap = new Map<string, string>([[mainTrack(p).id, mainId]]);
  for (const t of p.tracks) if (t.kind !== 'main') { const nt = { ...structuredClone(t), id: `${t.id}x` }; trackMap.set(t.id, nt.id); if (!q.tracks.some((x) => x.kind === t.kind && x.name === t.name)) q.tracks.push(nt); else trackMap.set(t.id, q.tracks.find((x) => x.kind === t.kind && x.name === t.name)!.id); }
  for (const c of p.clips) {
    const ce = clipEnd(c);
    if (ce <= start || c.start >= end) continue;
    const a = Math.max(c.start, start), b = Math.min(ce, end);
    const copy: Clip = { ...structuredClone(c), id: `${c.id}r`, trackId: trackMap.get(c.trackId) ?? mainId, start: r3(a - start) };
    delete copy.transition;
    if (c.mediaId && !c.reverse) { copy.in = r3(c.in + (a - c.start) * c.speed); copy.out = r3(c.in + (b - c.start) * c.speed); }
    else { copy.in = 0; copy.out = r3((b - a) * c.speed); }
    q.clips.push(copy);
  }
  return e;
}

export interface ShortSpec { start: number; end: number; title?: string }
/**
 * The shorts kit as a tool: each range becomes its own project (9:16 following the face, word-by-word captions
 * from the transcript, optional hook title and ducked music), saved next to `dir` and optionally exported.
 */
export async function shortsFromRanges(p: Project, specs: ShortSpec[], o: { dir: string; aspect?: string; faces?: boolean; captions?: boolean; music?: string | null; titleStyle?: string; onProgress?: (f: number) => void; makeProject?: (e: Editor) => Promise<void> }) {
  const { reframe, addMusic, cuesToTrack } = await import('./automate');
  const dir = resolve(o.dir);
  mkdirSync(dir, { recursive: true });
  const out: { project: string; duration: number; captions: number }[] = [];
  for (const [i, s] of specs.entries()) {
    if (!(s.end > s.start + 0.5)) throw new Error(`Tramo ${i + 1} demasiado corto`);
    const name = `Short ${String(i + 1).padStart(2, '0')}${s.title ? ` - ${s.title.replace(/[<>:"/\\|?*]/g, '').slice(0, 50)}` : ''}`;
    const e = extractRange(p, s.start, s.end, name);
    await reframe(e, { aspect: o.aspect ?? '9:16', mode: o.faces === false ? 'crop' : 'face' });
    let captions = 0;
    if (o.captions !== false) {
      const cues = cuesIn(p, s.start, s.end);
      if (cues.length) captions = cuesToTrack(e, cues, { style: 'subtitle-karaoke' });
    }
    if (s.title) e.addTitle(s.title, { style: o.titleStyle ?? 'bold-yellow', start: 0, duration: Math.min(3, s.end - s.start), y: 0.18 });
    if (o.music) await addMusic(e, o.music, { duck: true, volume: 0.35 });
    await o.makeProject?.(e);
    const path = e.save(join(dir, `${name}.cinta`));
    out.push({ project: path, duration: r3(s.end - s.start), captions });
    o.onProgress?.((i + 1) / specs.length);
  }
  return out;
}

/** "[mm:ss] sentence" lines of the main track — what an AI reads to choose chapters or shorts. */
export function transcriptLines(p: Project): string {
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return transcriptView(p).sentences.map((s) => `[${mmss(s.start)}] (${s.start.toFixed(1)}–${s.end.toFixed(1)} s) ${s.text}`).join('\n');
}

// ───────────────────────── subtitles in other languages ─────────────────────────
/** Captions of a title track (default: the first track with titles), in time order. */
export function subtitleCues(p: Project, trackId?: string) {
  const t = trackId ? p.tracks.find((x) => x.id === trackId) : p.tracks.find((x) => x.kind === 'title' && p.clips.some((c) => c.trackId === x.id && c.title));
  if (!t) throw new Error('No hay ninguna pista de subtítulos o títulos.');
  return { track: t, cues: trackClips(p, t.id).filter((c) => c.title && c.title.timerFrom === undefined).map((c) => ({ id: c.id, start: c.start, end: clipEnd(c), text: c.title!.text })) };
}

/** A copy of a subtitle track with the texts replaced (same timing and style) — e.g. a translation. */
export function addSubtitleTrack(e: Editor, texts: string[], o: { sourceTrackId?: string; name: string; hideSource?: boolean }) {
  const { track, cues } = subtitleCues(e.project, o.sourceTrackId);
  if (texts.length !== cues.length) throw new Error(`Se esperaban ${cues.length} textos (uno por subtítulo) y llegaron ${texts.length}.`);
  return e.mutate('Subtítulos traducidos', (p) => {
    let t = p.tracks.find((x) => x.kind === 'title' && x.name === o.name);
    if (t) p.clips = p.clips.filter((c) => c.trackId !== t!.id);
    else {
      t = { ...structuredClone(track), id: `t${Math.random().toString(36).slice(2, 9)}`, name: o.name, hidden: false };
      p.tracks.splice(p.tracks.findIndex((x) => x.id === track.id), 0, t);
    }
    const tid = t.id;
    if (o.hideSource) p.tracks.find((x) => x.id === track.id)!.hidden = true;
    cues.forEach((c, i) => {
      const orig = p.clips.find((x) => x.id === c.id)!;
      p.clips.push({ ...structuredClone(orig), id: `${orig.id}${tid.slice(-4)}`, trackId: tid, title: { ...orig.title!, text: texts[i] } });
    });
    return { track: tid, captions: cues.length };
  });
}

