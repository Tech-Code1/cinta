// Advanced mode, main-process side: the cinta-media: protocol (media for the canvas engine, with byte ranges),
// a hidden render window that draws composition frames, export through ffmpeg (video + mixed audio), the
// render cache used when a composition is placed in the simple timeline, and the --render-comp command line
// used by the MCP server (which runs as plain Node and cannot draw).
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { cacheDir, motionCached, touchCached, exportProject, mediaInfo, motion, type Editor, type MediaItem, type Project } from '../core';
import { ffmpegPath } from '../core/ffmpeg';
import { audioCodecFor, audioMixArgs, compAudio, compHash, encoderArgs, formatOf, COMP_FORMATS, type CompFormat } from '../core/motion-io';
import { DiskCache, type FrameOpts } from '../core/diskcache';
import { encodePng } from '../core/png';
import { exrChannelBlock } from '../core/exrimport';

// ───────────────────────── protocol ─────────────────────────
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'cinta-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }]);
}
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
export function handleMediaProtocol() {
  protocol.handle('cinta-media', async (req) => {
    const u = new URL(req.url);
    // EXR channels for the 3D Channel effects: cinta-media://exr/?file=…&ch=a,b&crypto=…&sel=…
    if (u.host === 'exr') {
      try {
        const q = u.searchParams;
        const block = exrChannelBlock(q.get('file') ?? '', (q.get('ch') ?? '').split(',').filter(Boolean), q.get('crypto') ?? undefined, q.get('sel') ?? undefined);
        return new Response(new Uint8Array(block), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' } });
      } catch (e) { return new Response(String((e as Error).message ?? e), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }); }
    }
    const path = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!existsSync(path)) return new Response('no existe', { status: 404 });
    const size = statSync(path).size;
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start >= size) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
      const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
      return new Response(body, { status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  });
}

// ───────────────────────── render window ─────────────────────────
let rw: BrowserWindow | null = null;
let rwReady: Promise<BrowserWindow> | null = null;
interface Job { onFrame: (i: number, data: Uint8Array) => Promise<boolean>; resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (f: number) => void; total: number }
const jobs = new Map<string, Job>();
let ipcDone = false;

function setupIpc() {
  if (ipcDone) return;
  ipcDone = true;
  ipcMain.handle('render:frame', async (_e, id: string, i: number, data: Uint8Array) => {
    const j = jobs.get(id);
    if (!j) return false;
    j.onProgress?.((i + 1) / j.total);
    return j.onFrame(i, data);
  });
  ipcMain.handle('render:done', (_e, id: string, err: string | null, result?: unknown) => {
    const j = jobs.get(id);
    if (!j) return;
    jobs.delete(id);
    if (err) j.reject(new Error(err)); else j.resolve(result);
  });
  ipcMain.handle('render:ready', () => true);
}

export function renderWindow(preloadDir: string, rendererDir: string): Promise<BrowserWindow> {
  setupIpc();
  if (rw && !rw.isDestroyed() && rwReady) return rwReady;
  rw = new BrowserWindow({
    show: false, width: 640, height: 360, paintWhenInitiallyHidden: true,
    webPreferences: { preload: join(preloadDir, 'index.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  const w = rw;
  rwReady = new Promise((ok, ko) => {
    w.webContents.once('did-finish-load', () => ok(w));
    w.webContents.once('did-fail-load', (_e, _c, d) => ko(new Error(`No se pudo cargar el motor de render: ${d}`)));
  });
  w.on('closed', () => { rw = null; rwReady = null; });
  void w.loadFile(join(rendererDir, 'render.html'));
  return rwReady;
}
export function closeRenderWindow() { if (rw && !rw.isDestroyed()) rw.destroy(); rw = null; rwReady = null; }

let dirs = { preload: '', renderer: '' };
export function setDirs(preload: string, renderer: string) { dirs = { preload, renderer }; }

let seq = 0;
async function runJob(payload: Record<string, unknown>, total: number, onFrame: Job['onFrame'], onProgress?: (f: number) => void): Promise<unknown> {
  const w = await renderWindow(dirs.preload, dirs.renderer);
  const id = `j${Date.now()}_${seq++}`;
  return new Promise((ok, ko) => {
    jobs.set(id, { onFrame, resolve: ok, reject: ko, onProgress, total });
    w.webContents.send('render:job', { id, ...payload });
  });
}

/** «vectores»: text outlines / auto-trace computed by the render window (see motion-render/vectortasks.ts). */
export function renderTask(p: Project, compId: string, task: Record<string, unknown>): Promise<unknown> {
  return runJob({ project: p, compId, task, scale: 1 }, 1, async () => true);
}

// ───────────────────────── sequence layer & comp media ─────────────────────────
function seqHash(p: Project) {
  return motion.hashStr(JSON.stringify({ c: p.clips, t: p.tracks, s: p.settings, m: p.media.map((m) => [m.id, m.path, m.compHash]) })).toString(16);
}
/** Renders the simple-mode timeline once (cached) for "sequence" layers. */
export async function ensureSequence(p: Project): Promise<string | undefined> {
  const usesSeq = (p.comps ?? []).some((c) => c.layers.some((l) => l.type === 'sequence'));
  if (!usesSeq || !p.clips.length) return undefined;
  const out = motionCached(`seq_${seqHash(p)}.mp4`);
  if (existsSync(out)) return out;
  // comps that show the sequence cannot appear inside it (circular)
  const bad = new Set(p.media.filter((m) => m.compId && compUsesSequence(p, m.compId)).map((m) => m.id));
  const q: Project = { ...p, clips: p.clips.filter((c) => !c.mediaId || !bad.has(c.mediaId)) };
  await exportProject(q, { output: out, preset: 'mp4', hardware: 'auto' });
  return out;
}
function compUsesSequence(p: Project, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const c = p.comps?.find((x) => x.id === id);
  return !!c?.layers.some((l) => l.type === 'sequence' || (l.compId && compUsesSequence(p, l.compId, seen)));
}

/** Re-renders compositions used as clips in the simple timeline when they changed. Returns true if anything changed. */
export async function ensureCompMedia(e: Editor, onProgress?: (f: number) => void): Promise<boolean> {
  let changed = false;
  for (const m of e.project.media) {
    if (!m.compId) continue;
    const c = e.project.comps?.find((x) => x.id === m.compId);
    if (!c) continue;
    const h = compHash(e.project, c.id);
    if (m.compHash === h && existsSync(m.path)) { touchCached(m.path); continue; }
    const out = motionCached(`comp_${h}.mov`);
    if (!existsSync(out)) await renderCompToFile(e.project, c.id, out, { format: 'mov-alpha', onProgress });
    Object.assign(m, mediaFor(out, c, e.project), { compHash: h });
    changed = true;
  }
  return changed;
}
function mediaFor(path: string, c: motion.Comp, p: Project): Partial<MediaItem> {
  const info = mediaInfo(path);
  return { path, kind: 'video', duration: info.duration || c.duration, width: c.width, height: c.height, fps: c.fps, hasVideo: true, hasAudio: compAudio(p, c).length > 0 };
}
/** Adds a composition to the simple timeline (as a rendered clip that follows later changes). */
export async function compToTimeline(e: Editor, compId: string, o: { trackId?: string; at?: number } = {}, onProgress?: (f: number) => void) {
  const c = motion.findComp(e.project.comps, compId);
  const h = compHash(e.project, c.id);
  const out = motionCached(`comp_${h}.mov`);
  if (!existsSync(out)) await renderCompToFile(e.project, c.id, out, { format: 'mov-alpha', onProgress });
  return e.batch(async () => {
    let m = e.project.media.find((x) => x.compId === c.id);
    if (!m) {
      [m] = await e.importMedia([out]);
      e.mutate('Composición', (p) => { const mm = p.media.find((x) => x.id === m!.id)!; Object.assign(mm, mediaFor(out, c, p), { compId: c.id, compHash: h }); });
    }
    return e.addClip(m.id, { trackId: o.trackId, at: o.at });
  });
}

// ───────────────────────── export ─────────────────────────
export interface CompRenderOpts { format?: CompFormat | string; from?: number; to?: number; scale?: number; quality?: 'high' | 'medium' | 'low'; onProgress?: (f: number) => void; signal?: AbortSignal; mbSamples?: number; fps?: number; proxies?: 'current' | 'none' | 'all' | 'comps'; audio?: boolean }
/** One file written from the rendered frames (After Effects' Output Module). */
export interface CompOutput { path: string; format?: CompFormat | string; audio?: boolean; quality?: 'high' | 'medium' | 'low' }
type OutResult = { path: string; frames: number; duration: number; width: number; height: number; fps: number; format: CompFormat; audio: boolean };

export async function renderCompToFile(p: Project, compId: string, output: string, o: CompRenderOpts = {}) {
  const r = await renderCompOutputs(p, compId, [{ path: output, format: o.format, audio: o.audio, quality: o.quality }], o);
  return { ...r.outputs[0], seconds: r.seconds, perf: r.perf };
}

/** Renders the frames of a composition once and encodes them into every output at the same time. */
export async function renderCompOutputs(p: Project, compId: string, outs: CompOutput[], o: CompRenderOpts = {}): Promise<{ outputs: OutResult[]; seconds: number; perf: unknown }> {
  if (!outs.length) throw new Error('No hay salidas que escribir.');
  const comp = motion.findComp(p.comps, compId);
  const scale = o.scale ?? 1;
  const W = Math.max(2, Math.round((comp.width * scale) / 2) * 2), H = Math.max(2, Math.round((comp.height * scale) / 2) * 2);
  const fps = o.fps ?? comp.fps;
  const from = Math.max(0, o.from ?? comp.workArea?.[0] ?? 0), to = Math.min(comp.duration, o.to ?? comp.workArea?.[1] ?? comp.duration);
  const frames = Math.max(1, Math.round((to - from) * fps));
  const dur = frames / fps;
  const sequencePath = await ensureSequence(p);
  const targets = outs.map((x) => {
    const fmt = formatOf(x.format, x.path);
    const def = COMP_FORMATS.find((f) => f.id === fmt)!;
    let out = resolve(x.path);
    if (!extname(out)) out += `.${def.ext}`;
    mkdirSync(dirname(out), { recursive: true });
    return { ...x, fmt, def, out, file: fmt === 'png' ? join(dirname(out), `${basename(out, extname(out))}_%05d.png`) : out };
  });
  const dup = targets.find((x, i) => targets.findIndex((y) => y.file.toLowerCase() === x.file.toLowerCase()) !== i);
  if (dup) throw new Error(`Dos salidas escriben el mismo archivo: ${dup.file}`);
  // frames carry alpha if any output keeps it; the opaque outputs then lay them on the comp background
  const alpha = targets.some((x) => x.def.alpha);
  const pieces = compAudio(p, comp, sequencePath);
  const t0 = Date.now();
  const procs = targets.map((x) => {
    const aCodec = x.audio === false ? null : audioCodecFor(x.fmt);
    const audio = aCodec ? audioMixArgs(pieces, 1, from, dur) : null;
    const args = ['-hide_banner', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', 'pipe:0'];
    if (audio) args.push(...audio.inputs);
    const filters: string[] = [];
    let v = '0:v';
    if (alpha && !x.def.alpha) { filters.push(`color=c=${comp.bg.replace('#', '0x')}:s=${W}x${H}:r=${fps}[bg];[bg][0:v]overlay=shortest=1:format=auto[flat]`); v = '[flat]'; }
    if (x.fmt === 'gif') { filters.push(`${v === '0:v' ? '[0:v]' : v}fps=${Math.min(fps, 25)},split[g0][g1];[g0]palettegen=stats_mode=diff[pal];[g1][pal]paletteuse=dither=bayer:bayer_scale=4[vout]`); v = '[vout]'; }
    if (audio) filters.push(audio.filter);
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    args.push('-map', v);
    if (audio) args.push('-map', audio.label, ...aCodec!);
    args.push(...encoderArgs(x.fmt, x.quality ?? o.quality ?? 'high'), '-frames:v', String(frames), x.file);
    const ff = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const st = { ff, err: '', broken: false, audio: !!audio, exited: new Promise<number>((ok) => ff.on('close', (c) => ok(c ?? 1))) };
    ff.stderr.on('data', (d) => { st.err = (st.err + d).slice(-4000); });
    ff.stdin.on('error', () => { st.broken = true; });
    return st;
  });
  const write = (st: (typeof procs)[number], buf: Uint8Array) => new Promise<void>((ok) => { if (st.broken) return ok(); if (st.ff.stdin.write(buf)) ok(); else st.ff.stdin.once('drain', () => ok()); });
  let perf: unknown;
  try {
    perf = await runJob({ project: p, compId, from, frames, fps, scale: W / comp.width, opaque: !alpha, sequencePath, mbSamples: o.mbSamples, proxies: o.proxies ?? 'none' }, frames, async (_i, data) => {
      if (o.signal?.aborted || procs.every((x) => x.broken)) return false;
      await Promise.all(procs.map((st) => write(st, data)));
      return true;
    }, o.onProgress);
  } finally {
    for (const st of procs) st.ff.stdin.end();
  }
  const codes = await Promise.all(procs.map((x) => x.exited));
  if (o.signal?.aborted) throw new Error('Exportación cancelada.');
  const bad = codes.findIndex((c) => c !== 0);
  if (bad >= 0) throw new Error(`ffmpeg falló al escribir ${basename(targets[bad].file)}: ${procs[bad].err.split('\n').filter(Boolean).slice(-3).join(' ')}`);
  const outputs = targets.map((x, i): OutResult => {
    const info = x.fmt === 'png' ? { duration: dur, width: W, height: H } : mediaInfo(x.out);
    return { path: x.fmt === 'png' ? x.file : x.out, frames, duration: info.duration, width: W, height: H, fps, format: x.fmt, audio: procs[i].audio };
  });
  return { outputs, seconds: (Date.now() - t0) / 1000, perf };
}

// ───────────────────────── render queue ─────────────────────────
export interface QueueResult { id: string; status: 'done' | 'failed' | 'stopped'; log: NonNullable<motion.RenderItem['log']> }
/** Renders the queued items in order (After Effects' Render button). Output paths are templates relative to `baseDir`. */
export async function runRenderQueue(p: Project, baseDir: string, o: { items?: string[]; onItem?: (id: string, status: 'rendering' | QueueResult['status']) => void; onProgress?: (done: number, total: number, frac: number) => void; signal?: AbortSignal } = {}): Promise<QueueResult[]> {
  const todo = (p.renderQueue ?? []).filter((x) => (o.items ? o.items.includes(x.id) : x.status === 'queued'));
  const results: QueueResult[] = [];
  for (const [n, it] of todo.entries()) {
    const at = new Date();
    if (o.signal?.aborted) { results.push({ id: it.id, status: 'stopped', log: { at: at.toISOString(), seconds: 0, files: [], error: 'Detenido' } }); continue; }
    o.onItem?.(it.id, 'rendering');
    const s = it.settings;
    try {
      const comp = motion.findComp(p.comps, it.compId);
      // render settings act on a copy: motion blur off for every comp, the span and rate of the item
      const q: Project = JSON.parse(JSON.stringify(p));
      if (s.motionBlur === 'off') for (const c of q.comps ?? []) c.motionBlur.on = false;
      const [from, to] = s.span === 'comp' ? [0, comp.duration] : s.span === 'workArea' ? comp.workArea ?? [0, comp.duration] : s.span;
      const W = Math.max(2, Math.round((comp.width * s.resolution) / 2) * 2), H = Math.max(2, Math.round((comp.height * s.resolution) / 2) * 2);
      const outs = it.outputs.map((om) => {
        const def = COMP_FORMATS.find((f) => f.id === formatOf(om.format, om.path))!;
        const name = motion.outputName(om.path, { projectName: p.name || 'Proyecto', compName: comp.name, width: W, height: H, fps: s.fps ?? comp.fps, ext: def.ext, date: at });
        return { path: resolve(baseDir, name), format: def.id, audio: om.audio, quality: om.quality };
      });
      const r = await renderCompOutputs(q, it.compId, outs, { from, to, scale: s.resolution, fps: s.fps ?? undefined, proxies: s.proxies, mbSamples: s.quality === 'draft' ? 2 : undefined, signal: o.signal, onProgress: (f) => o.onProgress?.(n, todo.length, f) });
      results.push({ id: it.id, status: 'done', log: { at: at.toISOString(), seconds: r.seconds, files: r.outputs.map((x) => x.path) } });
    } catch (e) {
      results.push({ id: it.id, status: o.signal?.aborted ? 'stopped' : 'failed', log: { at: at.toISOString(), seconds: (Date.now() - at.getTime()) / 1000, files: [], error: String((e as Error).message ?? e) } });
    }
    o.onItem?.(it.id, results[results.length - 1].status);
  }
  return results;
}

// ───────────────────────── disk cache ─────────────────────────
/** Engine id for disk-cache keys: the app version and the build of the drawing code (a new build redraws).
 *  The build is told by the content of the renderer files, not their dates: inside app.asar a file's mtime is
 *  the time it is read, so packaged builds got a new id per process and never reused a cached frame. */
let engine: string | null = null;
export function engineId(version: string): string {
  if (engine) return engine;
  const h = createHash('sha1');
  const walk = (d: string) => { for (const f of readdirSync(d).sort()) { const x = join(d, f); if (statSync(x).isDirectory()) walk(x); else h.update(f).update(readFileSync(x)); } };
  try { walk(dirs.renderer); } catch { /* no renderer files: the version is enough */ }
  return (engine = `${version}|${h.digest('hex').slice(0, 16)}`);
}
/** Cache Work Area in Background: renders the frames of [from, to) missing from the disk cache, in the hidden
 *  render window (the interface stays free), at the preview resolution. */
export async function fillDiskCache(p: Project, compId: string, cache: DiskCache, o: FrameOpts & { from?: number; to?: number; onProgress?: (f: number) => void; signal?: AbortSignal }): Promise<{ rendered: number; cached: number }> {
  const comp = motion.findComp(p.comps, compId);
  const f0 = Math.round((o.from ?? comp.workArea[0]) * comp.fps), f1 = Math.round((o.to ?? comp.workArea[1]) * comp.fps);
  const missing: number[] = [];
  for (let f = f0; f < f1; f++) if (!cache.has(cache.key(p, compId, f, o))) missing.push(f);
  // contiguous runs: one render job each
  const runs: [number, number][] = [];
  for (const f of missing) { const r = runs[runs.length - 1]; if (r && r[1] === f) r[1]++; else runs.push([f, f + 1]); }
  const W = Math.max(1, Math.round(comp.width * o.res)), H = Math.max(1, Math.round(comp.height * o.res));
  const sequencePath = await ensureSequence(p);
  let done = 0;
  for (const [a, b] of runs) {
    if (o.signal?.aborted) break;
    await runJob({ project: p, compId, from: a / comp.fps, frames: b - a, fps: comp.fps, scale: o.res, size: [W, H], opaque: false, sequencePath, mbSamples: o.mbSamples, proxies: o.proxies ?? 'current', guides: true }, b - a, async (i, data) => {
      if (o.signal?.aborted) return false;
      cache.put(cache.key(p, compId, a + i, o), encodePng(W, H, data));
      done++;
      o.onProgress?.(done / missing.length);
      return true;
    });
  }
  return { rendered: done, cached: f1 - f0 - missing.length };
}

// ───────────────────────── proxies ─────────────────────────
/** Comp proxy: the comp rendered (with alpha, VP9 that the canvas engine plays) at `scale`, cached by its content. */
export async function renderCompProxy(p: Project, compId: string, dir: string, scale = 1, onProgress?: (f: number) => void): Promise<{ path: string; hash: string }> {
  const c = motion.findComp(p.comps, compId);
  const hash = compHash(p, c.id);
  const out = join(dir, `${c.name.replace(/[\\/:*?"<>|]+/g, '_')}_proxy_${Math.round(scale * 100)}_${hash}.webm`);
  if (!existsSync(out)) await renderCompToFile(p, c.id, out, { format: 'webm-alpha', from: 0, to: c.duration, scale, audio: false, quality: 'medium', onProgress });
  return { path: out, hash };
}

/** One frame of a composition as PNG. */
export async function renderCompStill(p: Project, compId: string, t: number, output: string, scale = 1): Promise<{ path: string; errors: string[] }> {
  const comp = motion.findComp(p.comps, compId);
  const sequencePath = await ensureSequence(p);
  const r = (await runJob({ project: p, compId, still: Math.max(0, Math.min(comp.duration - 1e-3, t)), scale, sequencePath }, 1, async () => true)) as { png: Uint8Array; errors: string[] };
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), Buffer.from(r.png));
  return { path: resolve(output), errors: r.errors };
}

/** Mixed audio of a composition (WAV, cached) for the live preview. */
export async function compAudioFile(p: Project, compId: string): Promise<string | null> {
  const comp = motion.findComp(p.comps, compId);
  const sequencePath = await ensureSequence(p);
  const pieces = compAudio(p, comp, sequencePath);
  const mix = audioMixArgs(pieces, 0, 0, comp.duration);
  if (!mix) return null;
  const out = motionCached(`audio_${motion.hashStr(JSON.stringify(pieces) + comp.duration).toString(16)}.wav`);
  if (existsSync(out)) return out;
  await new Promise<void>((ok, ko) => {
    const ff = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...mix.inputs, '-filter_complex', mix.filter, '-map', mix.label, '-c:a', 'pcm_s16le', out], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    ff.on('close', (c) => (c === 0 ? ok() : ko(new Error(err))));
  });
  return out;
}

// ───────────────────────── command line (for the MCP server) ─────────────────────────
/** `Cinta --render-comp job.json`: {project, compId, output, still?, format?, from?, to?, scale?} → writes job.json.result */
export async function runRenderCli(jobFile: string) {
  const job = JSON.parse(readFileSync(jobFile, 'utf8')) as { project: string; compId: string; output: string; still?: number; format?: string; from?: number; to?: number; scale?: number; quality?: 'high' | 'medium' | 'low'; queue?: string[]; compProxy?: { dir: string; scale?: number }; task?: Record<string, unknown>; cache?: FrameOpts & { action: 'fill' | 'status'; from?: number; to?: number } };
  let result: unknown;
  try {
    const p = motion.validateComps(JSON.parse(readFileSync(job.project, 'utf8')) as Project);
    const dc = () => new DiskCache(join(cacheDir(), 'diskcache'), 10 * 1024 ** 3, engineId(app.getVersion()));
    result = job.cache?.action === 'fill' ? await fillDiskCache(p, job.compId, dc(), job.cache)
      : job.cache?.action === 'status' ? (() => { const c = motion.findComp(p.comps, job.compId), bits = dc().status(p, job.compId, 0, Math.round(c.duration * c.fps), job.cache!); return { frames: bits.length, cached: bits.reduce((a, b) => a + b, 0), bits: [...bits].join('') }; })()
      : job.queue ? await runRenderQueue(p, dirname(job.project), { items: job.queue })
      : job.compProxy ? await renderCompProxy(p, job.compId, job.compProxy.dir, job.compProxy.scale)
      : job.task ? await renderTask(p, job.compId, job.task)
      : job.still !== undefined
      ? await renderCompStill(p, job.compId, job.still, job.output, job.scale ?? 1)
      : await renderCompToFile(p, job.compId, job.output, { format: job.format, from: job.from, to: job.to, scale: job.scale, quality: job.quality });
  } catch (e) {
    result = { error: String((e as Error).message ?? e) };
  }
  writeFileSync(`${jobFile}.result`, JSON.stringify(result));
}
