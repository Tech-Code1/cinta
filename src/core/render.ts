// Project → ffmpeg command. One compositor for export, preview stream, single frames and the MCP.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { buildAss, titleEvents, type AssEvent } from './ass';
import { AUDIO_EFFECTS, AUDIO_ENHANCE, EQ_BANDS, EQ_PRESETS, EXPORT_PRESETS, FILTERS, PIP_LAYOUTS, QUALITY, TRANSITIONS, findIn, type ExportPreset, type Quality } from './catalog';
import { cacheDir, renderGraphic } from './graphics';
import { clipDuration, clipEnd, clipHasAudio, even, mediaOf, projectDuration, trackClips, transitionLength, type Clip, type Keyframe, type Project, type Track } from './model';

export interface RenderOptions {
  mode: 'export' | 'frame' | 'preview';
  output: string; // file path, or "pipe:1"
  from?: number;
  to?: number;
  /** render size (preview); export uses preset or project size */
  width?: number;
  height?: number;
  preset?: string | ExportPreset;
  quality?: Quality | 'custom';
  crf?: number;
  videoBitrate?: string; // e.g. "8M" (CBR-ish)
  bitrateMode?: 'auto' | 'cbr' | 'vbr';
  audioBitrate?: string;
  fps?: number;
  sampleRate?: number;
  codecPreset?: string; // x264 speed preset
  loudnorm?: boolean | number; // true = -14 LUFS
  /** hardware H.264/H.265 encoder chosen by exportProject (h264_nvenc, hevc_qsv…) */
  encoder?: string;
  audio?: boolean; // include audio (default true)
}

export interface Compiled {
  args: string[];
  duration: number;
  cwd: string;
  width: number;
  height: number;
  audioOnly: boolean;
  graph: string;
}

const n = (x: number) => (Math.round(x * 10000) / 10000).toString();
const hexColor = (c: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? `0x${m[1]}` : c.replace(/[^a-z0-9#@.]/gi, '');
};

class Graph {
  inputs: string[][] = [];
  chains: string[] = [];
  private k = 0;
  label(p = 'x') {
    return `${p}${this.k++}`;
  }
  input(args: string[]): number {
    this.inputs.push(args);
    return this.inputs.length - 1;
  }
  add(chain: string) {
    this.chains.push(chain);
  }
  /** Embeds a catalog chain that may use its own [labels]: they get unique names. */
  scoped(chain: string): string {
    const id = this.k++;
    return chain.replace(/\[([a-z][a-z0-9]*)\]/gi, (_, l: string) => `[${l}_${id}]`);
  }
}

/** Douglas–Peucker: drop points that a straight line already explains (≤ 400 points kept). */
function simplify(pts: { t: number; v: number }[], tol = 0.003): { t: number; v: number }[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const f = (pts[i].t - pts[a].t) / (pts[b].t - pts[a].t || 1);
      const d = Math.abs(pts[i].v - (pts[a].v + f * (pts[b].v - pts[a].v)));
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length > 400 ? simplify(pts, tol * 2) : out;
}

/** Piecewise-linear expression of t over keyframes (times already in output seconds). */
function pwl(points: { t: number; v: number }[], tv = 't'): string {
  const pts = [...points].sort((a, b) => a.t - b.t);
  if (!pts.length) return '0';
  if (pts.length === 1) return n(pts[0].v);
  let e = n(pts[pts.length - 1].v);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1];
    const seg = b.t - a.t > 1e-6 ? `${n(a.v)}+(${n(b.v - a.v)})*(${tv}-${n(a.t)})/${n(b.t - a.t)}` : n(b.v);
    e = `if(lt(${tv}\\,${n(b.t)})\\,${seg}\\,${e})`;
  }
  return `if(lt(${tv}\\,${n(pts[0].t)})\\,${n(pts[0].v)}\\,${e})`;
}

function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${n(s)}`);
  return out;
}

function colorChain(c: Clip, cwd: string): string[] {
  const k = c.color;
  if (!k) return [];
  const f: string[] = [];
  if (k.preset === 'auto-contrast') f.push('normalize=smoothing=24:independence=0:strength=0.8');
  if (k.preset === 'auto-saturation') f.push('eq=saturation=1.35');
  if (k.preset === 'white-balance') f.push('grayworld');
  if (k.preset === 'magic') f.push('normalize=smoothing=24:independence=0:strength=0.6', 'eq=saturation=1.2', 'unsharp=5:5:0.6');
  const eq: string[] = [];
  if (k.brightness) eq.push(`brightness=${n(k.brightness * 0.4)}`);
  if (k.contrast) eq.push(`contrast=${n(1 + k.contrast * (k.contrast > 0 ? 1 : 0.8))}`);
  if (k.saturation) eq.push(`saturation=${n(Math.max(0, 1 + k.saturation))}`);
  if (k.gamma) eq.push(`gamma=${n(Math.max(0.1, 1 + k.gamma * 0.8))}`);
  if (eq.length) f.push(`eq=${eq.join(':')}`);
  if (k.exposure) f.push(`exposure=exposure=${n(k.exposure * 2)}`);
  if (k.hue) f.push(`hue=h=${n(k.hue)}`);
  if (k.temperature) f.push(`colortemperature=temperature=${Math.round(6500 - k.temperature * 3500)}`);
  if (k.tint || k.shadows || k.highlights) {
    const tint = (k.tint ?? 0) * 0.2, sh = (k.shadows ?? 0) * 0.3, hi = (k.highlights ?? 0) * 0.3;
    f.push(`colorbalance=rm=${n(tint)}:gm=${n(-tint)}:bm=${n(tint)}:rs=${n(sh)}:gs=${n(sh)}:bs=${n(sh)}:rh=${n(hi)}:gh=${n(hi)}:bh=${n(hi)}`);
  }
  if (k.sharpen) f.push(`unsharp=5:5:${n(k.sharpen * 2.5)}`);
  if (k.vignette) f.push(`vignette=angle=${n(0.2 + k.vignette * 0.7)}`);
  if (k.lut && existsSync(k.lut)) {
    const name = `lut_${createHash('sha1').update(k.lut).digest('hex').slice(0, 10)}.cube`;
    const dst = join(cwd, name);
    if (!existsSync(dst)) copyFileSync(k.lut, dst);
    f.push(`lut3d=file=${name}`);
  }
  return f;
}

function audioFxChain(c: Clip): string[] {
  const a = c.audio;
  if (!a) return [];
  const f: string[] = [];
  const gains = a.eq ?? (a.eqPreset ? findIn(EQ_PRESETS, a.eqPreset, 'Preset de ecualizador').gains : undefined);
  if (gains) gains.forEach((g, i) => { if (Math.abs(g) > 0.05) f.push(`equalizer=f=${EQ_BANDS[i]}:t=o:w=1:g=${n(g)}`); });
  if (a.denoise) f.push(`afftdn=nr=${n(Math.max(1, a.denoise * 40))}:nf=-30`);
  if (a.gate) f.push(`agate=threshold=${n(10 ** (a.gate.threshold / 20))}:range=${n(10 ** (-Math.abs(a.gate.range) / 20))}:attack=${n(a.gate.attack)}:release=${n(a.gate.release)}`);
  if (a.compressor) {
    const k = a.compressor;
    f.push(`acompressor=threshold=${n(10 ** (k.threshold / 20))}:ratio=${n(k.ratio)}:attack=${n(k.attack)}:release=${n(k.release)}:makeup=${n(10 ** (k.makeup / 20))}:mix=${n(k.mix)}`);
  }
  if (a.reverb) f.push(`aecho=0.8:${n(0.3 + a.reverb.wet * 0.6)}:${Math.round(a.reverb.delay)}|${Math.round(a.reverb.delay * 1.7)}:${n(a.reverb.decay)}|${n(a.reverb.decay * 0.6)}`);
  if (a.enhance) f.push(AUDIO_ENHANCE[a.enhance].chain);
  if (a.effect) f.push(findIn(AUDIO_EFFECTS, a.effect, 'Efecto de audio').chain);
  return f;
}

function videoFxChain(g: Graph, c: Clip, cwd: string, w?: Win): string[] {
  const f: string[] = [];
  if (c.crop && c.focusTrack?.length && w && !c.reverse) {
    // crop window glides along the tracked face (chain time t → source time srcIn + t·speed)
    // only the points of this window, simplified so long clips do not build huge expressions
    const pts = c.focusTrack.filter((p) => p.t >= w.srcIn - 1 && p.t <= w.srcIn + w.srcLen + 1);
    const use = pts.length ? pts : [c.focusTrack.reduce((a, b) => (Math.abs(b.t - w.srcIn) < Math.abs(a.t - w.srcIn) ? b : a))];
    const at = (k: 'x' | 'y') => pwl(simplify(use.map((p) => ({ t: (p.t - w.srcIn) / c.speed, v: p[k] }))));
    f.push(`crop=iw*${n(c.crop.w)}:ih*${n(c.crop.h)}:x='max(0\\,min(iw-ow\\,iw*(${at('x')})-ow/2))':y='max(0\\,min(ih-oh\\,ih*(${at('y')})-oh/2))'`);
  } else if (c.crop) f.push(`crop=iw*${n(c.crop.w)}:ih*${n(c.crop.h)}:iw*${n(c.crop.x)}:ih*${n(c.crop.y)}`);
  if (c.rotate === 90) f.push('transpose=1');
  if (c.rotate === 180) f.push('hflip,vflip');
  if (c.rotate === 270) f.push('transpose=2');
  if (c.flipH) f.push('hflip');
  if (c.flipV) f.push('vflip');
  if (c.straighten) {
    const a = (Math.abs(c.straighten) * Math.PI) / 180;
    const k = Math.cos(a) + Math.sin(a) * 1.78;
    f.push(`rotate=${n((c.straighten * Math.PI) / 180)}`, `scale=trunc(iw*${n(k)}/2)*2:trunc(ih*${n(k)}/2)*2`, `crop=trunc(iw/${n(k)}/2)*2:trunc(ih/${n(k)}/2)*2`);
  }
  f.push(...colorChain(c, cwd));
  for (const fl of c.filters) {
    if (!fl.enabled) continue;
    const def = FILTERS.find((x) => x.id === fl.type);
    if (def) f.push(g.scoped(def.chain(Math.max(0, Math.min(1, fl.amount)))));
  }
  return f;
}

interface Win {
  /** output-time start and length */
  s: number;
  L: number;
  /** source seconds to read: [srcIn, srcIn + srcLen) */
  srcIn: number;
  srcLen: number;
}

function windowOf(c: Clip, from: number, to: number): Win | null {
  const end = clipEnd(c);
  const cs = Math.max(c.start, from), ce = Math.min(end, to);
  if (ce - cs < 1e-3) return null;
  const u0 = cs - c.start, u1 = ce - c.start;
  const srcIn = c.reverse ? c.out - u1 * c.speed : c.in + u0 * c.speed;
  return { s: cs - from, L: ce - cs, srcIn: Math.max(0, srcIn), srcLen: (u1 - u0) * c.speed };
}

/** Adds the input for a media/colour clip and returns the raw video label (or null). */
/** export renders stabilization everywhere; previews skip it deep inside a clip (it would decode from the clip start) */
let renderMode: RenderOptions['mode'] = 'export';

function videoSource(g: Graph, p: Project, c: Clip, w: Win, fps: number, W: number, H: number): { v: string; input?: number; pre?: string[] } {
  const m = mediaOf(p, c);
  if (c.type === 'color') {
    const fill = c.fill ?? '#000000';
    const v = g.label('col');
    if (fill.startsWith('gradient:')) {
      const [c0, c1] = fill.slice(9).split(',');
      g.add(`gradients=s=${W}x${H}:c0=${hexColor(c0)}:c1=${hexColor(c1 ?? c0)}:r=${fps}:d=${n(w.L)}:speed=0.0001,format=yuv420p[${v}]`);
    } else {
      g.add(`color=c=${hexColor(fill)}:s=${W}x${H}:r=${fps}:d=${n(w.L)},format=yuv420p[${v}]`);
    }
    return { v };
  }
  if (c.type === 'sticker' || c.type === 'callout') {
    const id = c.type === 'sticker' ? c.sticker?.name : c.callout?.shape;
    const color = c.type === 'sticker' ? c.sticker?.color : c.callout?.color;
    const img = renderGraphic(c.type, id ?? 'star', color, H * 0.6);
    const i = g.input(['-loop', '1', '-framerate', String(fps), '-t', n(w.L + 0.1), '-i', img.path]);
    return { v: `${i}:v`, input: i };
  }
  if (!m) throw new Error(`El clip ${c.id} no tiene archivo`);
  if (m.kind === 'image') {
    const i = g.input(['-loop', '1', '-framerate', String(fps), '-t', n(w.L + 0.1), '-i', m.path]);
    return { v: `${i}:v`, input: i };
  }
  // vid.stab transforms are a frame-by-frame list starting where the analysis started: read the source from
  // there and drop the frames before the window, or the transforms land on the wrong frames (and can crash)
  const s = c.stabilize;
  if (s?.trf && !c.reverse && m.hasVideo && existsSync(join(cacheDir('render'), s.trf))) {
    const offset = w.srcIn - (s.from ?? 0);
    if (offset >= -0.01 && (renderMode === 'export' || offset <= 20)) {
      const i = g.input(['-ss', n(s.from ?? 0), '-t', n(Math.max(0, offset) + w.srcLen + 0.25), '-i', m.path]);
      const pre = ['setpts=PTS-STARTPTS', `vidstabtransform=input=${s.trf}:smoothing=${Math.round(s.smoothing)}:crop=${s.crop}:zoom=${n(s.zoom)}:optzoom=${s.zoom ? 0 : 1}`, 'format=yuv420p'];
      // ↑ ffmpeg 6.1 segfaults when vidstabtransform feeds an auto-converted RGB filter (sepia); a format step avoids it
      if (offset > 0.001) pre.push(`trim=start=${n(offset)}`);
      return { v: `${i}:v`, input: i, pre };
    }
  }
  // converted footage with alpha (VP9 in WebM): only libvpx reads its alpha channel
  const alphaDec = m.footage?.hasAlpha && /\.webm$/i.test(m.path) ? ['-c:v', 'libvpx-vp9'] : [];
  const i = g.input(['-ss', n(w.srcIn), '-t', n(w.srcLen + 0.25), ...alphaDec, '-i', m.path]);
  return { v: m.hasVideo ? `${i}:v` : '', input: i };
}

/** Timing chain: speed, reverse, exact length at the project frame rate. */
function timing(c: Clip, w: Win, fps: number, image: boolean): string[] {
  const f = ['setpts=PTS-STARTPTS'];
  if (!image) {
    if (c.reverse) f.push(`trim=duration=${n(w.srcLen)}`, 'reverse');
    if (Math.abs(c.speed - 1) > 1e-4) f.push(`setpts=PTS/${n(c.speed)}`);
  }
  f.push(`fps=${fps}`, `tpad=stop_mode=clone:stop_duration=${n(Math.min(5, w.L))}`, `trim=duration=${n(w.L)}`, 'setpts=PTS-STARTPTS');
  return f;
}

/** Fit (contain) size of a source of aspect sw:sh inside W×H, times scale. */
function fitSize(sw: number, sh: number, W: number, H: number, scale: number) {
  const r = Math.min(W / sw, H / sh) * scale;
  return { w: even(sw * r), h: even(sh * r) };
}

function sourceSize(p: Project, c: Clip, H: number): { w: number; h: number } {
  const m = mediaOf(p, c);
  let w = m?.width || 1920, h = m?.height || 1080;
  if (c.type === 'sticker' || c.type === 'callout') {
    const id = c.type === 'sticker' ? c.sticker?.name : c.callout?.shape;
    const img = renderGraphic(c.type, id ?? 'star', c.type === 'sticker' ? c.sticker?.color : c.callout?.color, H * 0.6);
    w = img.width; h = img.height;
  }
  if (c.crop) { w *= c.crop.w; h *= c.crop.h; }
  if (c.rotate === 90 || c.rotate === 270) [w, h] = [h, w];
  return { w, h };
}

/** Default on-screen scale of graphics (stickers ~ a quarter of the frame height). */
const graphicScale = (c: Clip) => (c.type === 'sticker' || c.type === 'callout' ? 0.3 : 1);

export async function compile(p: Project, opts: RenderOptions): Promise<Compiled> {
  renderMode = opts.mode;
  const preset = typeof opts.preset === 'string' ? findIn(EXPORT_PRESETS, opts.preset, 'Preset de exportación') : opts.preset;
  const total = projectDuration(p);
  const reqFrom = Math.max(0, opts.from ?? 0);
  const to = Math.min(opts.to ?? total, total || (opts.to ?? 0));
  // A range starting inside a transition is rendered from the transition's start and trimmed afterwards,
  // otherwise xfade would restart its animation at the range start (scrubbing would show only clip A).
  const lead = transitionLead(p, reqFrom);
  const from = reqFrom - lead;
  const D = to - from;
  const OUT = to - reqFrom;
  if (!(OUT > 0.01)) throw new Error(total <= 0 ? 'El proyecto está vacío: añada algún clip a la línea de tiempo.' : 'El rango a renderizar está vacío.');
  const fps = opts.fps ?? (preset?.fps ?? p.settings.fps);
  const SR = opts.sampleRate ?? p.settings.sampleRate;
  // canvas size: preview size, or the project size (export scales to the preset at the end)
  const W = even(opts.width ?? p.settings.width), H = even(opts.height ?? p.settings.height);
  const cwd = cacheDir('render');
  const audioOnly = !!preset?.audioOnly;
  const withAudio = opts.audio !== false && opts.mode !== 'frame' && !preset?.gif;
  const g = new Graph();
  const bg = hexColor(p.settings.background);
  const visible = (t?: Track) => !!t && !t.hidden;
  const audioTracks: { label: string; duck: boolean; voice: boolean }[] = [];

  let vOut = '';
  if (!audioOnly) {
    // ───── main track
    const main = p.tracks.find((t) => t.kind === 'main');
    const mains = main && visible(main) ? trackClips(p, main.id).filter((c) => !c.hidden && c.type !== 'audio') : [];
    let acc = '';
    let accLen = 0;
    const filler = (len: number) => {
      const l = g.label('gap');
      g.add(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n(len)},format=yuv420p,settb=AVTB,setsar=1[${l}]`);
      return l;
    };
    const append = (lbl: string, len: number, overlap: number, xfade?: string) => {
      if (!acc) {
        acc = lbl; accLen = len; return;
      }
      const out = g.label('seq');
      if (overlap > 0.01 && xfade) {
        g.add(`[${acc}][${lbl}]xfade=transition=${xfade}:duration=${n(overlap)}:offset=${n(Math.max(0, accLen - overlap))}[${out}]`);
        accLen = accLen + len - overlap;
      } else {
        g.add(`[${acc}][${lbl}]concat=n=2:v=1:a=0[${out}]`);
        accLen += len;
      }
      acc = out;
    };
    mains.forEach((c, i) => {
      const w = windowOf(c, from, to);
      if (!w) return;
      const prev = i > 0 ? mains[i - 1] : undefined;
      // gap or overlap relative to what is already on the sequence
      const gap = w.s - accLen;
      if (!acc && w.s > 0.01) append(filler(w.s), w.s, 0);
      else if (acc && gap > 0.01) append(filler(gap), gap, 0);
      const overlap = acc ? Math.max(0, accLen - w.s) : 0;
      const src = videoSource(g, p, c, w, fps, W, H);
      const image = mediaOf(p, c)?.kind === 'image' || c.type === 'color';
      const out = g.label('mv');
      const chain = [...(src.pre ?? []), ...timing(c, w, fps, image), ...videoFxChain(g, c, cwd, w), `scale=${W}:${H}:force_original_aspect_ratio=decrease:eval=init`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg}`, 'setsar=1'];
      const u0 = w.s + from - c.start, dur = clipDuration(c);
      if (c.panZoom) {
        const pz = c.panZoom;
        const z = `(${n(pz.from.zoom)}+(${n(pz.to.zoom - pz.from.zoom)})*(it+${n(u0)})/${n(dur)})`;
        const cx = `(${n(pz.from.x)}+(${n(pz.to.x - pz.from.x)})*(it+${n(u0)})/${n(dur)})`;
        const cy = `(${n(pz.from.y)}+(${n(pz.to.y - pz.from.y)})*(it+${n(u0)})/${n(dur)})`;
        chain.push(`scale=${W * 2}:${H * 2}`, `zoompan=z='${z}':x='max(0\\,min(iw-iw/zoom\\,iw*${cx}-iw/zoom/2))':y='max(0\\,min(ih-ih/zoom\\,ih*${cy}-ih/zoom/2))':d=1:s=${W}x${H}:fps=${fps}`);
      }
      if (c.mask) chain.push(...maskChain(g, c, w, W, H, from));
      if (c.opacity < 0.999) chain.push('format=yuva420p', `colorchannelmixer=aa=${n(c.opacity)}`);
      if (c.fadeIn > 0 && u0 < c.fadeIn) chain.push(`fade=t=in:st=0:d=${n(Math.min(c.fadeIn - u0, w.L))}`);
      if (c.fadeOut > 0 && u0 + w.L > dur - c.fadeOut) chain.push(`fade=t=out:st=${n(Math.max(0, dur - c.fadeOut - u0))}:d=${n(Math.min(c.fadeOut, dur - u0))}`);
      if (c.opacity < 0.999) {
        const pre = g.label('op'), base = g.label('opb');
        g.add(`[${src.v}]${chain.join(',')}[${pre}]`);
        g.add(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n(w.L)}[${base}]`);
        g.add(`[${base}][${pre}]overlay=format=auto,format=yuv420p,settb=AVTB[${out}]`);
      } else {
        g.add(`[${src.v}]${chain.join(',')},format=yuv420p,settb=AVTB[${out}]`);
      }
      const xf = prev?.transition ? findIn(TRANSITIONS, prev.transition.type, 'Transición').xfade : undefined;
      append(out, w.L, overlap, xf ?? 'fade');
    });
    if (!acc) append(filler(D), D, 0);
    else if (accLen < D - 0.01) append(filler(D - accLen), D - accLen, 0);
    let base = acc;

    // ───── overlay tracks (bottom to top), then titles via ASS
    const events: AssEvent[] = [];
    const layers = [...p.tracks].reverse().filter((t) => t.kind === 'overlay' || t.kind === 'title');
    for (const t of layers) {
      if (!visible(t)) continue;
      for (const c of trackClips(p, t.id)) {
        if (c.hidden) continue;
        const w = windowOf(c, from, to);
        if (!w) continue;
        if (c.type === 'title' && c.title) {
          // absolute timeline times: the ass filter below sees timeline timestamps, so animations never restart
          events.push(...titleEvents(c, c.title, c.start, clipEnd(c), p.settings.width, p.settings.height, c.opacity));
          continue;
        }
        if (c.type === 'audio') continue;
        base = overlayClip(g, p, c, w, base, W, H, fps, cwd, from);
      }
    }
    if (events.length) {
      const name = `titles_${createHash('sha1').update(JSON.stringify(events)).digest('hex').slice(0, 12)}.ass`;
      writeFileSync(join(cwd, name), buildAss(events, p.settings.width, p.settings.height), 'utf8');
      const l = g.label('ass');
      const shift = from > 0 ? [`setpts=PTS+${n(from)}/TB,`, ',setpts=PTS-STARTPTS'] : ['', ''];
      g.add(`[${base}]${shift[0]}ass=f=${name}:original_size=${p.settings.width}x${p.settings.height}${shift[1]}[${l}]`);
      base = l;
    }
    // final size (export preset) and pixel format
    const outW = opts.mode === 'export' && preset?.width ? preset.width : W;
    const outH = opts.mode === 'export' && preset?.height ? preset.height : H;
    vOut = g.label('vout');
    const cut = lead > 0 ? `trim=start=${n(lead)},setpts=PTS-STARTPTS,` : '';
    const fit = outW !== W || outH !== H ? `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=${bg},` : '';
    if (preset?.gif) {
      const gw = Math.min(outW, 720);
      g.add(`[${base}]${cut}${fit}fps=${Math.min(fps, 15)},scale=${gw}:-2:flags=lanczos,split[gp0][gp1];[gp0]palettegen=stats_mode=diff[gpal];[gp1][gpal]paletteuse=dither=bayer:bayer_scale=4[${vOut}]`);
    } else {
      g.add(`[${base}]${cut}${fit}fps=${fps},format=yuv420p,setsar=1[${vOut}]`);
    }
  }

  // ───── audio
  let aOut = '';
  if (withAudio || audioOnly) {
    for (const t of p.tracks) {
      if (t.muted) continue;
      for (const c of trackClips(p, t.id)) {
        if (c.muted || c.volume <= 0 || !clipHasAudio(p, c)) continue;
        const w = windowOf(c, from, to);
        if (!w) continue;
        const m = mediaOf(p, c);
        if (!m) continue;
        const i = g.input(['-ss', n(w.srcIn), '-t', n(w.srcLen + 0.25), '-vn', '-i', m.path]);
        const f = ['asetpts=PTS-STARTPTS', `aresample=${SR}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
        if (c.reverse) f.push(`atrim=duration=${n(w.srcLen)}`, 'areverse');
        if (Math.abs(c.speed - 1) > 1e-4) {
          if (c.keepPitch) f.push(...atempoChain(c.speed));
          else f.push(`asetrate=${Math.round(SR * c.speed)}`, `aresample=${SR}`);
        }
        f.push(`apad=whole_dur=${n(w.L)}`, `atrim=duration=${n(w.L)}`, 'asetpts=PTS-STARTPTS');
        f.push(...audioFxChain(c));
        if (c.normalize) f.push('loudnorm=I=-16:TP=-1.5:LRA=11', `aresample=${SR}`);
        // clip-local time of this window start, for volume keys and fades
        const u0 = w.s + from - c.start;
        if (c.volumeKeys?.length) f.push(`volume='${n(c.volume)}*(${pwl(c.volumeKeys.map((k) => ({ t: k.t - u0, v: k.v })))})':eval=frame`);
        else if (Math.abs(c.volume - 1) > 1e-4) f.push(`volume=${n(c.volume)}`);
        // fades, plus automatic crossfades under main-track transitions
        let fin = c.fadeIn, fout = c.fadeOut;
        if (t.kind === 'main') {
          const list = trackClips(p, t.id);
          const idx = list.findIndex((x) => x.id === c.id);
          fin = Math.max(fin, idx > 0 ? transitionLength(list[idx - 1], c) : 0);
          fout = Math.max(fout, transitionLength(c, list[idx + 1]));
        }
        const dur = clipDuration(c);
        if (fin > 0 && u0 < fin) f.push(`volume='clip((t+${n(u0)})/${n(fin)}\\,0\\,1)':eval=frame`);
        if (fout > 0 && u0 + w.L > dur - fout) f.push(`volume='clip((${n(dur - u0)}-t)/${n(fout)}\\,0\\,1)':eval=frame`);
        if (w.s > 0.0005) f.push(`adelay=delays=${Math.round(w.s * 1000)}:all=1`);
        const l = g.label('a');
        g.add(`[${i}:a]${f.join(',')}[${l}]`);
        audioTracks.push({ label: l, duck: t.kind === 'audio' && !!t.duck, voice: !(t.kind === 'audio' && t.duck) });
      }
    }
    aOut = g.label('aout');
    const tail = `apad=whole_dur=${n(D)},atrim=start=${n(lead)}:duration=${n(OUT)},asetpts=PTS-STARTPTS`;
    const norm = opts.loudnorm ? `,loudnorm=I=${typeof opts.loudnorm === 'number' ? opts.loudnorm : -14}:TP=-1.5:LRA=11,aresample=${SR}` : '';
    if (!audioTracks.length) {
      g.add(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${n(OUT)}[${aOut}]`);
    } else {
      const music = audioTracks.filter((x) => x.duck), voice = audioTracks.filter((x) => !x.duck);
      const mix = (ls: string[], out: string) => {
        if (ls.length === 1) g.add(`[${ls[0]}]anull[${out}]`);
        else g.add(`${ls.map((l) => `[${l}]`).join('')}amix=inputs=${ls.length}:normalize=0:duration=longest[${out}]`);
      };
      if (music.length && voice.length) {
        const vm = g.label('voice'), mm = g.label('music'), key = g.label('key'), vv = g.label('vmix'), md = g.label('ducked');
        mix(voice.map((x) => x.label), vm);
        mix(music.map((x) => x.label), mm);
        g.add(`[${vm}]asplit=2[${vv}][${key}]`);
        g.add(`[${mm}][${key}]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400:makeup=1[${md}]`);
        g.add(`[${vv}][${md}]amix=inputs=2:normalize=0:duration=longest,${tail}${norm}[${aOut}]`);
      } else {
        const all = g.label('mix');
        mix(audioTracks.map((x) => x.label), all);
        g.add(`[${all}]${tail}${norm}[${aOut}]`);
      }
    }
  }

  // ───── output
  const graph = g.chains.join(';\n');
  const script = join(cwd, `graph_${createHash('sha1').update(graph).digest('hex').slice(0, 12)}.txt`);
  writeFileSync(script, graph, 'utf8');
  const args: string[] = [];
  for (const i of g.inputs) args.push(...i);
  args.push('-filter_complex_script', basename(script));
  if (vOut) args.push('-map', `[${vOut}]`);
  if (aOut) args.push('-map', `[${aOut}]`);
  const q = QUALITY[opts.quality === 'custom' || !opts.quality ? 'good' : opts.quality];
  if (opts.mode === 'frame') {
    args.push('-frames:v', '1', '-c:v', 'png', '-f', 'image2', opts.output);
  } else if (opts.mode === 'preview') {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28', '-g', String(fps), '-pix_fmt', 'yuv420p');
    if (aOut) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', String(SR));
    // 0.2 s fragments: the player gets its first picture without waiting for a whole GOP
    args.push('-t', n(OUT), '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '200000', '-flush_packets', '1', opts.output);
  } else {
    const pr = preset ?? findIn(EXPORT_PRESETS, 'mp4', 'Preset');
    if (pr.gif) {
      args.push('-loop', '0');
    } else if (!pr.audioOnly && pr.vcodec) {
      const hw = opts.encoder && /_(nvenc|qsv|amf)$/.test(opts.encoder) ? opts.encoder : null;
      args.push('-c:v', hw ?? pr.vcodec);
      const x26x = !hw && (pr.vcodec === 'libx264' || pr.vcodec === 'libx265');
      const cq = String(opts.crf ?? q.crf);
      if (hw && !opts.videoBitrate) {
        // constant-quality modes of each vendor, matched to the x264 CRF of the chosen quality
        if (hw.endsWith('nvenc')) args.push('-preset', 'p5', '-rc', 'vbr', '-cq', cq, '-b:v', '0');
        else if (hw.endsWith('qsv')) args.push('-global_quality', cq);
        else args.push('-rc', 'cqp', '-qp_i', cq, '-qp_p', cq);
      } else if (opts.videoBitrate && opts.bitrateMode === 'cbr') args.push('-b:v', opts.videoBitrate, '-minrate', opts.videoBitrate, '-maxrate', opts.videoBitrate, '-bufsize', opts.videoBitrate);
      else if (opts.videoBitrate) args.push('-b:v', opts.videoBitrate);
      else if (x26x) args.push('-crf', String(opts.crf ?? q.crf));
      else if (pr.vcodec === 'libvpx-vp9') args.push('-crf', String((opts.crf ?? q.crf) + 10), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4');
      else args.push('-q:v', String(Math.max(2, Math.round((opts.crf ?? q.crf) / 6))));
      if (x26x) args.push('-preset', opts.codecPreset ?? q.preset);
      args.push('-pix_fmt', 'yuv420p');
      if (pr.extra) args.push(...pr.extra);
    }
    if (aOut && pr.acodec) {
      args.push('-c:a', pr.acodec);
      if (!/pcm|flac/.test(pr.acodec)) args.push('-b:a', opts.audioBitrate ?? q.abr);
      args.push('-ar', String(pr.acodec === 'libopus' ? 48000 : SR));
    }
    if (['mp4', 'mov', 'm4a'].includes(pr.ext)) args.push('-movflags', '+faststart');
    args.push('-t', n(OUT), opts.output);
  }
  return { args, duration: OUT, cwd, width: W, height: H, audioOnly, graph };
}

/** How far before `t` the main-track transition that `t` falls into begins (0 when not inside one). */
function transitionLead(p: Project, t: number): number {
  const main = p.tracks.find((x) => x.kind === 'main');
  if (!main || main.hidden) return 0;
  const list = trackClips(p, main.id).filter((c) => !c.hidden && c.type !== 'audio');
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (!a.transition) continue;
    if (t > b.start + 1e-4 && t < clipEnd(a) - 1e-4) return t - b.start;
  }
  return 0;
}

/** Overlay a visual clip (PiP video, image, sticker, callout, colour) onto `base`. */
function overlayClip(g: Graph, p: Project, c: Clip, w: Win, base: string, W: number, H: number, fps: number, cwd: string, from: number): string {
  const src = videoSource(g, p, c, w, fps, W, H);
  if (!src.v) return base;
  const image = c.type !== 'video';
  const pip = c.pip ? PIP_LAYOUTS.find((x) => x.id === c.pip) : undefined;
  const crop = c.crop ?? pip?.crop;
  const clip = { ...c, crop };
  const tf = c.transform ?? (pip ? { x: pip.x, y: pip.y, scale: pip.scale, rotation: 0 } : { x: 0.5, y: 0.5, scale: graphicScale(c), rotation: 0 });
  const ss = sourceSize(p, clip, H);
  const size = fitSize(ss.w, ss.h, W, H, tf.scale);
  // pip side-by-side layouts fill their slot: scale to cover the slot instead of fitting the frame
  if (pip?.crop) {
    const slotW = W * pip.crop.w, slotH = H * pip.crop.h;
    const r = Math.max(slotW / ss.w, slotH / ss.h);
    size.w = even(Math.min(slotW, ss.w * r));
    size.h = even(Math.min(slotH, ss.h * r));
  }
  const chain = [...(src.pre ?? []), ...timing(c, w, fps, image), ...videoFxChain(g, clip, cwd, w)];
  if (c.chroma) {
    const k = c.chroma;
    chain.push('format=yuva420p', `chromakey=color=${hexColor(k.color)}:similarity=${n(Math.max(0.01, k.tolerance))}:blend=${n(Math.max(0, k.blend))}`);
    if (k.edges > 0) chain.push(`erosion=planes=8`);
  }
  chain.push('format=yuva420p', `scale=${size.w}:${size.h}`);
  // Times: inside the clip chain T/t run from 0 at the window start, so clip time = T + u0.
  // On the overlay, t is output time and the clip spans [Sc, Ec] (may start before the window).
  const u0 = w.s + from - c.start;
  const dur = clipDuration(c);
  const kf = (c.keyframes ?? []).map((k): Keyframe => ({ ...k, t: k.t - u0 }));
  const S = w.s, E = w.s + w.L;
  const Sc = c.start - from, Ec = clipEnd(c) - from;
  // per-frame scale (keyframes or zoom/pop animations)
  const scaleKeys = kf.filter((k) => k.scale !== undefined).map((k) => ({ t: k.t, v: k.scale! / tf.scale }));
  // the scale filter calls its time variable t (geq uses T)
  let scaleExpr = scaleKeys.length ? pwl(scaleKeys, 't') : '';
  const ai = c.animIn, ao = c.animOut;
  const pin = (d: number) => `clip((t+${n(u0)})/${n(Math.max(0.01, d))}\\,0\\,1)`;
  const pout = (d: number) => `clip((${n(dur - u0)}-t)/${n(Math.max(0.01, d))}\\,0\\,1)`;
  if (ai && (ai.type === 'zoom' || ai.type === 'pop')) scaleExpr = `${scaleExpr || '1'}*${ai.type === 'pop' ? `(1.15*sin(PI/2*${pin(ai.duration)})-0.15*${pin(ai.duration)})` : `max(0.02\\,${pin(ai.duration)})`}`;
  if (ao && (ao.type === 'zoom' || ao.type === 'pop')) scaleExpr = `${scaleExpr || '1'}*max(0.02\\,${pout(ao.duration)})`;
  if (scaleExpr) chain.push(`scale=w='max(2\\,trunc(${size.w}*(${scaleExpr})/2)*2)':h='max(2\\,trunc(${size.h}*(${scaleExpr})/2)*2)':eval=frame`);
  // rotation (static, keyframed or spin animation)
  const rotKeys = kf.filter((k) => k.rotation !== undefined).map((k) => ({ t: k.t, v: (k.rotation! * Math.PI) / 180 }));
  let rot = rotKeys.length ? pwl(rotKeys) : tf.rotation ? n((tf.rotation * Math.PI) / 180) : '';
  if (ai?.type === 'spin') rot = `${rot || '0'}-2*PI*(1-clip((t+${n(u0)})/${n(ai.duration)}\\,0\\,1))`;
  if (rot) {
    const diag = Math.ceil(Math.hypot(size.w, size.h) / 2) * 2;
    chain.push(`rotate=a='${rot}':ow=${diag}:oh=${diag}:c=none`);
  }
  // opacity, fades
  const opKeys = kf.filter((k) => k.opacity !== undefined).map((k) => ({ t: k.t, v: k.opacity! }));
  if (opKeys.length) chain.push(`geq=lum='lum(X\\,Y)':cb='cb(X\\,Y)':cr='cr(X\\,Y)':a='alpha(X\\,Y)*(${pwl(opKeys, 'T')})'`);
  else if (c.opacity < 0.999) chain.push(`colorchannelmixer=aa=${n(c.opacity)}`);
  const fin = Math.max(c.fadeIn, ai?.type === 'fade' ? ai.duration : 0), fout = Math.max(c.fadeOut, ao?.type === 'fade' ? ao.duration : 0);
  // the fade filter cannot start before 0: a window opening mid-fade restarts the remaining part
  if (fin > 0 && u0 < fin) chain.push(`fade=t=in:st=0:d=${n(Math.min(fin - u0, w.L))}:alpha=1`);
  if (fout > 0 && u0 + w.L > dur - fout) chain.push(`fade=t=out:st=${n(Math.max(0, dur - fout - u0))}:d=${n(Math.min(fout, dur - u0))}:alpha=1`);
  chain.push(`setpts=PTS-STARTPTS+${n(S)}/TB`);
  const ov = g.label('ov');
  g.add(`[${src.v}]${chain.join(',')}[${ov}]`);
  // position (keyframes + slide animations), centre-anchored
  const xKeys = (c.keyframes ?? []).filter((k) => k.x !== undefined).map((k) => ({ t: k.t + Sc, v: k.x! }));
  const yKeys = (c.keyframes ?? []).filter((k) => k.y !== undefined).map((k) => ({ t: k.t + Sc, v: k.y! }));
  let cx = xKeys.length ? pwl(xKeys) : n(tf.x);
  let cy = yKeys.length ? pwl(yKeys) : n(tf.y);
  const ease = (pp: string) => `(1-(1-${pp})^3)`;
  const tin = (d: number) => `clip((t-${n(Sc)})/${n(Math.max(0.01, d))}\\,0\\,1)`;
  const tout = (d: number) => `clip((${n(Ec)}-t)/${n(Math.max(0.01, d))}\\,0\\,1)`;
  const slide = (type: string, pp: string) => {
    if (type === 'slide-left') cx = `(${cx})-(1-${ease(pp)})*1.2`;
    if (type === 'slide-right') cx = `(${cx})+(1-${ease(pp)})*1.2`;
    if (type === 'slide-up') cy = `(${cy})+(1-${ease(pp)})*1.2`;
    if (type === 'slide-down' || type === 'drop') cy = `(${cy})-(1-${ease(pp)})*1.2`;
  };
  if (ai) slide(ai.type, tin(ai.duration));
  if (ao) slide(ao.type === 'slide-left' ? 'slide-right' : ao.type === 'slide-right' ? 'slide-left' : ao.type === 'slide-up' ? 'slide-down' : ao.type === 'slide-down' ? 'slide-up' : ao.type, tout(ao.duration));
  const out = g.label('comp');
  g.add(`[${base}][${ov}]overlay=x='${W}*(${cx})-w/2':y='${H}*(${cy})-h/2':eval=frame:eof_action=pass:enable='between(t\\,${n(S)}\\,${n(E)})',format=yuv420p[${out}]`);
  return out;
}

/** Highlight / conceal mask on a main-track clip (applied after fitting to the canvas). */
function maskChain(g: Graph, c: Clip, w: Win, W: number, H: number, from: number): string[] {
  const m = c.mask!;
  const mw = even(m.w * W), mh = even(m.h * H);
  const u0 = w.s + from - c.start;
  const track = (m.track ?? []).map((k) => ({ t: k.t - u0, x: k.x, y: k.y }));
  const mx = track.length ? pwl(track.map((k) => ({ t: k.t, v: k.x }))) : n(m.x);
  const my = track.length ? pwl(track.map((k) => ({ t: k.t, v: k.y }))) : n(m.y);
  const shape = m.shape === 'ellipse' ? `255*lte(((X-W/2)/(W/2))^2+((Y-H/2)/(H/2))^2\\,1)` : '255';
  const feather = m.feather > 0 ? `,boxblur=luma_radius=0:chroma_radius=0:alpha_radius=${Math.max(1, Math.round(m.feather * Math.min(mw, mh) * 0.15))}` : '';
  const alpha = `format=yuva420p,geq=lum='lum(X\\,Y)':cb='cb(X\\,Y)':cr='cr(X\\,Y)':a='${shape}*${n(m.opacity)}'${feather}`;
  const fx: Record<string, string> = {
    black: `drawbox=c=black:t=fill`,
    blur: `gblur=sigma=${Math.max(4, Math.round(Math.min(mw, mh) / 12))}`,
    pixelate: `pixelize=w=${Math.max(6, Math.round(mw / 12))}:h=${Math.max(6, Math.round(mw / 12))}`,
    light: 'null',
    bright: 'eq=brightness=0.18:contrast=1.1',
  };
  const id = g.label('mk');
  const pos = `x='${W}*(${mx})-${mw / 2}':y='${H}*(${my})-${mh / 2}'`;
  if (m.mode === 'light') {
    // dim everything except the area
    return [g.scoped(`split[mka${id}][mkb${id}];[mkb${id}]crop=${mw}:${mh}:'max(0\\,min(iw-${mw}\\,${W}*(${mx})-${mw / 2}))':'max(0\\,min(ih-${mh}\\,${H}*(${my})-${mh / 2}))',${alpha}[mkc${id}];[mka${id}]eq=brightness=-0.3[mkd${id}];[mkd${id}][mkc${id}]overlay=${pos}:eval=frame`)];
  }
  if (m.invert) {
    return [g.scoped(`split[mka${id}][mkb${id}];[mka${id}]${fx[m.mode]}[mke${id}];[mkb${id}]crop=${mw}:${mh}:'max(0\\,min(iw-${mw}\\,${W}*(${mx})-${mw / 2}))':'max(0\\,min(ih-${mh}\\,${H}*(${my})-${mh / 2}))',${alpha}[mkc${id}];[mke${id}][mkc${id}]overlay=${pos}:eval=frame`)];
  }
  return [g.scoped(`split[mka${id}][mkb${id}];[mkb${id}]${fx[m.mode]},crop=${mw}:${mh}:'max(0\\,min(iw-${mw}\\,${W}*(${mx})-${mw / 2}))':'max(0\\,min(ih-${mh}\\,${H}*(${my})-${mh / 2}))',${alpha}[mkc${id}];[mka${id}][mkc${id}]overlay=${pos}:eval=frame`)];
}
