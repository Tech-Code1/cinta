// Adobe Premiere Pro projects (.prproj: gzip-compressed XML), like After Effects' «Importar proyecto de Adobe
// Premiere Pro»: every sequence becomes a composition (its video tracks as footage layers, bottom track at the
// bottom, audio tracks as audio layers when «Importar audio» is on, nested sequences as nested comps), or one
// sequence goes to the simple timeline (first video track → main track, the others → overlay tracks, audio →
// audio tracks). The XML is an object graph: elements carry ObjectID / ObjectUID and point at each other with
// ObjectRef / ObjectURef; times are ticks (254 016 000 000 per second).
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Editor } from './ops';
import type { MediaItem } from './model';
import { motionOps } from './motion/ops';
import type { Comp } from './motion/model';

export const TICKS = 254016000000;

// ───────────────────────── a small XML reader ─────────────────────────
export interface XEl { name: string; attrs: Record<string, string>; kids: XEl[]; text: string }
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
export function parseXml(src: string): XEl {
  const root: XEl = { name: '#root', attrs: {}, kids: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unent(a[2] ?? a[3] ?? '');
      const el: XEl = { name: m[3], attrs, kids: [], text: '' };
      top.kids.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += unent(m[6]);
  }
  return root;
}
const kid = (e: XEl | undefined, n: string) => e?.kids.find((k) => k.name === n);
const kids = (e: XEl | undefined, n: string) => e?.kids.filter((k) => k.name === n) ?? [];
/** first descendant with that name (depth-first) */
function deep(e: XEl | undefined, n: string, max = 6): XEl | undefined {
  if (!e || max < 0) return undefined;
  for (const k of e.kids) if (k.name === n) return k;
  for (const k of e.kids) { const f = deep(k, n, max - 1); if (f) return f; }
  return undefined;
}
const txt = (e: XEl | undefined) => e?.text.trim() ?? '';

// ───────────────────────── the project graph ─────────────────────────
export interface PrClip { start: number; end: number; inPoint: number; outPoint: number; media?: string; sequence?: string; name: string; enabled: boolean }
export interface PrTrack { kind: 'video' | 'audio'; clips: PrClip[]; muted?: boolean }
export interface PrSequence { id: string; name: string; width: number; height: number; fps: number; duration: number; tracks: PrTrack[] }
export interface PrProject { sequences: PrSequence[]; media: string[] }

export function readPrproj(buf: Buffer): PrProject {
  let xml: string;
  try { xml = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8'); } catch { throw new Error('No se puede cargar el proyecto de Premiere Pro, el número de versión es incorrecto o el archivo está dañado.'); }
  const root = parseXml(xml);
  const data = kid(root, 'PremiereData');
  if (!data) throw new Error('Sólo son compatibles los proyectos creados con Premiere Pro.');
  const byId = new Map<string, XEl>(), byUid = new Map<string, XEl>();
  for (const el of data.kids) { if (el.attrs.ObjectID) byId.set(el.attrs.ObjectID, el); if (el.attrs.ObjectUID) byUid.set(el.attrs.ObjectUID, el); }
  const deref = (e: XEl | undefined): XEl | undefined => (!e ? undefined : e.attrs.ObjectRef ? byId.get(e.attrs.ObjectRef) : e.attrs.ObjectURef ? byUid.get(e.attrs.ObjectURef) : e);
  const num = (e: XEl | undefined, def = 0) => { const v = Number(txt(e)); return Number.isFinite(v) && txt(e) !== '' ? v : def; };
  const mediaPath = (m: XEl | undefined) => txt(kid(m, 'ActualMediaFilePath')) || txt(kid(m, 'FilePath')) || txt(deep(m, 'ActualMediaFilePath')) || txt(deep(m, 'FilePath'));
  const seqUidOf = new Map<XEl, string>();
  const seqEls = data.kids.filter((x) => x.name === 'Sequence');
  for (const s of seqEls) seqUidOf.set(s, s.attrs.ObjectUID ?? s.attrs.ObjectID ?? '');
  const media = new Set<string>();
  // a track item → its clip: SubClip → (Video|Audio)Clip → Source → MediaSource → Media, or a nested sequence
  const clipOf = (ti: XEl): PrClip | null => {
    const cti = kid(ti, 'ClipTrackItem') ?? deep(ti, 'ClipTrackItem');
    const tItem = kid(cti, 'TrackItem') ?? deep(ti, 'TrackItem');
    const start = num(kid(tItem, 'Start')), end = num(kid(tItem, 'End'));
    const sub = deref(kid(cti, 'SubClip') ?? deep(ti, 'SubClip'));
    const clipEl = deref(kid(sub, 'Clip'));
    const clip = kid(clipEl, 'Clip') ?? clipEl;
    const src = deref(kid(clip, 'Source'));
    const inPoint = num(kid(clip, 'InPoint')), outPoint = num(kid(clip, 'OutPoint'), inPoint + (end - start));
    const name = txt(kid(sub, 'Name')) || txt(deep(clipEl, 'Name')) || '';
    const enabled = txt(deep(tItem, 'Disabled')) !== 'true';
    if (!src) return null;
    // nested sequence
    const seqRef = deref(deep(src, 'OriginalSequence') ?? deep(src, 'Sequence'));
    if (seqRef && seqRef.name === 'Sequence') return { start, end, inPoint, outPoint, sequence: seqUidOf.get(seqRef), name: name || txt(kid(seqRef, 'Name')), enabled };
    const mediaEl = deref(deep(src, 'Media'));
    const path = mediaPath(mediaEl);
    if (!path) return null;
    media.add(path);
    return { start, end, inPoint, outPoint, media: path, name: name || basename(path.replace(/\\/g, '/')), enabled };
  };
  const sequences: PrSequence[] = [];
  for (const s of seqEls) {
    const name = txt(kid(s, 'Name')) || txt(deep(kid(s, 'Node'), 'Name')) || 'Secuencia';
    const tracks: PrTrack[] = [];
    let width = 0, height = 0, fps = 0;
    for (const tg of kids(kid(s, 'TrackGroups'), 'TrackGroup')) {
      const g = deref(kid(tg, 'Second'));
      if (!g) continue;
      const kind = /^Audio/.test(g.name) ? 'audio' : 'video';
      const inner = kid(g, 'TrackGroup') ?? g;
      if (kind === 'video') {
        const rect = txt(kid(g, 'FrameRect') ?? deep(g, 'FrameRect')).split(',').map(Number);
        if (rect.length === 4 && rect[2] > rect[0]) { width = rect[2] - rect[0]; height = rect[3] - rect[1]; }
        const fr = num(kid(inner, 'FrameRate') ?? deep(g, 'FrameRate'));
        if (fr > 0) fps = Math.round((TICKS / fr) * 1000) / 1000;
      }
      for (const tr of kids(kid(inner, 'Tracks'), 'Track')) {
        const t = deref(tr);
        if (!t) continue;
        const items = kids(deep(t, 'TrackItems', 4), 'TrackItem').map(deref).filter((x): x is XEl => !!x);
        const clips = items.map(clipOf).filter((c): c is PrClip => !!c && c.end > c.start);
        tracks.push({ kind, clips, muted: txt(deep(t, 'IsMuted')) === 'true' });
      }
    }
    const duration = Math.max(0, ...tracks.flatMap((t) => t.clips.map((c) => c.end))) / TICKS;
    sequences.push({ id: seqUidOf.get(s)!, name, width: width || 1920, height: height || 1080, fps: fps || 30, duration, tracks });
  }
  if (!sequences.length) throw new Error('El proyecto de Premiere Pro no tiene secuencias.');
  return { sequences, media: [...media] };
}

/** Finds a media file the project points at, also where it was moved together with the project. */
function locate(path: string, projDir: string): string | null {
  if (existsSync(path)) return resolve(path);
  const name = basename(path.replace(/\\/g, '/'));
  for (const c of [join(projDir, name), join(projDir, 'Media', name), join(dirname(projDir), name)]) if (existsSync(c)) return c;
  return null;
}

export interface PrImportResult { comps: Comp[]; clips: number; layers: number; missing: string[]; warnings: string[] }
/** Imports a Premiere Pro project. target 'comps' (After Effects): every sequence (or `sequence`, by name) as a
 *  composition; 'timeline': that sequence (default the first) into the simple-mode timeline. Run inside e.batch. */
export async function prprojImport(e: Editor, path: string, o: { target?: 'comps' | 'timeline'; sequence?: string; audio?: boolean } = {}): Promise<PrImportResult> {
  const pr = readPrproj(readFileSync(path));
  const audio = o.audio ?? true;
  const wanted = o.sequence ? pr.sequences.filter((s) => s.name === o.sequence || s.id === o.sequence) : pr.sequences;
  if (!wanted.length) throw new Error(`El proyecto no tiene la secuencia «${o.sequence}». Hay: ${pr.sequences.map((s) => s.name).join(', ')}`);
  const missing: string[] = [], warnings: string[] = [];
  const found = new Map<string, MediaItem>();
  for (const p of pr.media) {
    const f = locate(p, dirname(resolve(path)));
    if (!f) { missing.push(p); continue; }
    try { const [m] = await e.importMedia([f]); found.set(p, m); } catch (err) { warnings.push(`${basename(f)}: ${(err as Error).message}`); missing.push(p); }
  }
  const sec = (t: number) => Math.round((t / TICKS) * 100000) / 100000;
  let layers = 0, clips = 0;
  const comps: Comp[] = [];
  if (o.target === 'timeline') {
    const s = wanted[0];
    const vids = s.tracks.filter((t) => t.kind === 'video'), auds = s.tracks.filter((t) => t.kind === 'audio');
    vids.forEach((t, i) => {
      const trackId = i === 0 ? undefined : e.addTrack('overlay').id;
      if (i === 0 && t.clips.some((c, k) => k > 0 && c.start > t.clips[k - 1].end + TICKS / 100)) warnings.push('La pista principal de Cinta es magnética: los huecos de V1 se cierran.');
      for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
        const m = c.media ? found.get(c.media) : undefined;
        if (!m) { if (c.sequence) warnings.push(`«${c.name}»: las secuencias anidadas solo se importan como composiciones.`); continue; }
        const dur = sec(c.end - c.start), inn = sec(c.inPoint);
        if (Math.abs(sec(c.outPoint - c.inPoint) - dur) > 0.05 && m.kind !== 'image') warnings.push(`«${c.name}»: el cambio de velocidad no se importa.`);
        e.addClip(m.id, m.kind === 'image' ? { trackId, at: trackId ? sec(c.start) : undefined, duration: dur } : { trackId, at: trackId ? sec(c.start) : undefined, in: inn, out: Math.min(m.duration, inn + dur) });
        clips++;
      }
    });
    if (audio) {
      for (const t of auds) {
        const trackId = e.addTrack('audio').id;
        for (const c of t.clips) {
          const m = c.media ? found.get(c.media) : undefined;
          if (!m || (!m.hasAudio && m.kind !== 'audio')) continue;
          const inn = sec(c.inPoint);
          e.addClip(m.id, { trackId, at: sec(c.start), in: inn, out: Math.min(m.duration, inn + sec(c.end - c.start)) });
          clips++;
        }
      }
    }
  } else {
    // nested sequences first, so the comps they become exist when another sequence uses them
    const compOf = new Map<string, Comp>();
    const build = (s: PrSequence, stack: string[]): Comp => {
      const have = compOf.get(s.id);
      if (have) return have;
      const c = motionOps.compNew(e, { name: s.name, width: s.width, height: s.height, fps: s.fps, duration: Math.max(1 / s.fps, Math.round(s.duration * 1000) / 1000) });
      compOf.set(s.id, c);
      // bottom video track first (layers are added on top); audio layers under the video
      const order = [...(audio ? s.tracks.filter((t) => t.kind === 'audio') : []), ...s.tracks.filter((t) => t.kind === 'video')];
      for (const t of order) for (const cl of t.clips) {
        const at = sec(cl.start), len = sec(cl.end - cl.start), srcLen = sec(cl.outPoint - cl.inPoint);
        let layerId: string | null = null;
        if (cl.sequence) {
          const sub = pr.sequences.find((x) => x.id === cl.sequence);
          if (!sub || stack.includes(sub.id)) continue;
          const sc = build(sub, [...stack, s.id]);
          if (t.kind === 'audio') continue;
          layerId = motionOps.layerAdd(e, c.id, 'comp', { compId: sc.id, start: at - sec(cl.inPoint), name: cl.name }).id;
        } else {
          const m = cl.media ? found.get(cl.media) : undefined;
          if (!m) {
            if (t.kind === 'video') { const l = motionOps.layerAdd(e, c.id, 'solid', { name: `Falta: ${cl.name}`, color: '#808080', start: at, duration: len }); layers++; motionOps.layerSet(e, c.id, l.id, { in: at, out: Math.min(c.duration, at + len) }); }
            continue;
          }
          if (t.kind === 'audio' && !m.hasAudio && m.kind !== 'audio') continue;
          if (t.kind === 'video' && m.kind === 'audio') continue;
          const type = t.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video';
          // the video of a clip with sound: its sound comes from the audio track (muted here, like After Effects)
          layerId = motionOps.layerAdd(e, c.id, type, { mediaId: m.id, start: type === 'image' ? at : at - sec(cl.inPoint), duration: type === 'image' ? len : m.duration, name: cl.name }).id;
        }
        const stretch = len > 0 && srcLen > 0 && Math.abs(srcLen - len) > 0.02 && !cl.sequence ? len / srcLen : 1;
        const patch: Record<string, unknown> = { in: at, out: Math.min(c.duration, at + len) };
        if (stretch !== 1) { patch.stretch = Math.round(stretch * 10000) / 10000; patch.start = at - sec(cl.inPoint) * stretch; }
        if (!cl.enabled) patch.hidden = true;
        motionOps.layerSet(e, c.id, layerId, patch as never);
        if ((t.kind === 'video' && audio && !cl.sequence) || (t.muted && t.kind === 'audio')) {
          e.mutate('Silenciar capa', (p) => { const l = (p.comps ?? []).find((x) => x.id === c.id)?.layers.find((x) => x.id === layerId); if (l && (l.type === 'video' || l.type === 'audio')) l.audio.muted = true; });
        }
        layers++;
      }
      return c;
    };
    for (const s of wanted) comps.push(build(s, []));
  }
  if (missing.length) warnings.push(`Faltan ${missing.length} archivos: ${missing.slice(0, 5).map((m) => basename(m.replace(/\\/g, '/'))).join(', ')}${missing.length > 5 ? '…' : ''}`);
  return { comps: comps.map((c) => (e.project.comps ?? []).find((x) => x.id === c.id) ?? c), clips, layers, missing, warnings };
}
export const isPrproj = (p: string) => extname(p).toLowerCase() === '.prproj';
