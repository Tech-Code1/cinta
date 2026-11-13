// Media analysis with ffmpeg: silences, scenes, beats, audio sync, stabilization, waveform, thumbnails.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runFfmpeg } from './ffmpeg';
import { cacheDir } from './graphics';
import type { MediaItem } from './model';

export interface Range {
  start: number;
  end: number;
}

/** Silent ranges of a file (ffmpeg silencedetect). threshold in dB, minimum duration in s. */
export async function detectSilences(path: string, o: { threshold?: number; minDuration?: number; from?: number; to?: number } = {}): Promise<Range[]> {
  const th = o.threshold ?? -35, md = o.minDuration ?? 0.5;
  const pre = o.from ? ['-ss', String(o.from)] : [];
  const dur = o.to !== undefined ? ['-t', String(o.to - (o.from ?? 0))] : [];
  const { stderr } = await runFfmpeg([...pre, ...dur, '-i', path, '-vn', '-af', `silencedetect=noise=${th}dB:d=${md}`, '-f', 'null', '-']);
  const out: Range[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, +s[1]);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== null) { out.push({ start: start + (o.from ?? 0), end: +e[1] + (o.from ?? 0) }); start = null; }
  }
  if (start !== null) out.push({ start: start + (o.from ?? 0), end: Infinity });
  return out;
}

/** Scene changes (seconds) with ffmpeg's scene score. */
export async function detectScenes(path: string, o: { threshold?: number; minScene?: number; from?: number; to?: number } = {}): Promise<number[]> {
  const th = o.threshold ?? 0.3, min = o.minScene ?? 1;
  const pre = o.from ? ['-ss', String(o.from)] : [];
  const dur = o.to !== undefined ? ['-t', String(o.to - (o.from ?? 0))] : [];
  const { stderr } = await runFfmpeg([...pre, ...dur, '-i', path, '-an', '-vf', `scale=320:-2,select='gt(scene\\,${th})',showinfo`, '-f', 'null', '-']);
  const cuts: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const t = +m[1] + (o.from ?? 0);
    if (!cuts.length ? t - (o.from ?? 0) >= min : t - cuts[cuts.length - 1] >= min) cuts.push(Math.round(t * 1000) / 1000);
  }
  return cuts;
}

/** Mono PCM (float32) at `rate` Hz for analysis. */
export async function decodePcm(path: string, rate = 8000, o: { from?: number; duration?: number } = {}): Promise<Float32Array> {
  const pre = o.from ? ['-ss', String(o.from)] : [];
  const dur = o.duration ? ['-t', String(o.duration)] : [];
  const { stdout } = await runFfmpeg([...pre, ...dur, '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1']);
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength - (stdout.byteLength % 4)));
}

/** Beat times by spectral-flux-like onset detection on the energy envelope. */
export async function detectBeats(path: string, o: { minInterval?: number; from?: number; duration?: number } = {}): Promise<number[]> {
  const rate = 11025, hop = 256;
  const pcm = await decodePcm(path, rate, o);
  const frames = Math.floor(pcm.length / hop);
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let j = 0; j < hop; j++) { const v = pcm[i * hop + j]; s += v * v; }
    env[i] = Math.sqrt(s / hop);
  }
  const flux = new Float32Array(frames);
  for (let i = 1; i < frames; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);
  const win = Math.round((0.5 * rate) / hop);
  const minGap = (o.minInterval ?? 0.3) * rate / hop;
  const beats: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < frames - 1; i++) {
    let mean = 0, cnt = 0;
    for (let j = Math.max(0, i - win); j < Math.min(frames, i + win); j++) { mean += flux[j]; cnt++; }
    mean /= cnt;
    if (flux[i] > mean * 1.8 + 0.005 && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && i - last >= minGap) {
      beats.push(Math.round(((i * hop) / rate + (o.from ?? 0)) * 1000) / 1000);
      last = i;
    }
  }
  return beats;
}

/**
 * Offset (s) of `b` relative to `a` by cross-correlating their energy envelopes:
 * positive = b's sound happens later inside b than in a → move b earlier by the offset.
 */
export async function audioOffset(a: string, b: string, maxShift = 10): Promise<{ offset: number; confidence: number }> {
  const rate = 1000;
  const env = async (p: string) => {
    const pcm = await decodePcm(p, 8000, { duration: 60 });
    const hop = 8000 / rate;
    const out = new Float32Array(Math.floor(pcm.length / hop));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let j = 0; j < hop; j++) s += Math.abs(pcm[i * hop + j]);
      out[i] = s / hop;
    }
    // remove mean, normalise
    let m = 0;
    for (const v of out) m += v;
    m /= out.length || 1;
    let n = 0;
    for (let i = 0; i < out.length; i++) { out[i] -= m; n += out[i] * out[i]; }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= n;
    return out;
  };
  const [ea, eb] = await Promise.all([env(a), env(b)]);
  const maxLag = Math.round(maxShift * rate);
  let best = 0, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < ea.length; i++) {
      const j = i + lag;
      if (j >= 0 && j < eb.length) s += ea[i] * eb[j];
    }
    if (s > best) { best = s; bestLag = lag; }
  }
  return { offset: bestLag / rate, confidence: Math.round(best * 1000) / 1000 };
}

/** vid.stab analysis pass → .trf file name inside the render cache dir. */
export async function stabilizeAnalyze(m: MediaItem, o: { accuracy?: number; shakiness?: number; from?: number; to?: number }, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<string> {
  const accuracy = Math.round(Math.max(1, Math.min(15, o.accuracy ?? 9)));
  const shakiness = Math.round(Math.max(1, Math.min(10, o.shakiness ?? 5)));
  const key = createHash('sha1').update(`${m.path}|${accuracy}|${shakiness}|${o.from ?? 0}|${o.to ?? ''}`).digest('hex').slice(0, 12);
  // ASCII: on Windows vid.stab reads the binary format in text mode and chokes on some bytes
  const name = `stab_${key}a.trf`;
  const cwd = cacheDir('render');
  if (existsSync(join(cwd, name))) return name;
  const pre = o.from ? ['-ss', String(o.from)] : [];
  const dur = o.to !== undefined ? ['-t', String(o.to - (o.from ?? 0))] : [];
  await runFfmpeg([...pre, ...dur, '-i', m.path, '-an', '-vf', `vidstabdetect=shakiness=${shakiness}:accuracy=${accuracy}:fileformat=1:result=${name}`, '-f', 'null', '-'], {
    cwd, duration: (o.to ?? m.duration) - (o.from ?? 0), onProgress, signal,
  });
  return name;
}

/** Peaks (0..1) for drawing a waveform: `perSecond` values per second. */
export async function waveform(path: string, perSecond = 50): Promise<number[]> {
  const rate = 8000;
  const pcm = await decodePcm(path, rate);
  const hop = Math.max(1, Math.round(rate / perSecond));
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += hop) {
    let mx = 0;
    for (let j = i; j < Math.min(pcm.length, i + hop); j++) mx = Math.max(mx, Math.abs(pcm[j]));
    out.push(Math.round(Math.min(1, mx) * 255) / 255);
  }
  return out;
}

/** A strip of `count` thumbnails (JPEG data URLs) for a video, `height` px tall. */
export async function thumbnails(path: string, duration: number, count: number, height = 54): Promise<string[]> {
  const times = Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
  const out: string[] = Array(count).fill('');
  // one ffmpeg per thumbnail seeks fast; four at a time quarter the wait on long videos
  let next = 0;
  const worker = async () => {
    while (next < times.length) {
      const i = next++;
      const { stdout } = await runFfmpeg(['-ss', times[i].toFixed(3), '-i', path, '-frames:v', '1', '-vf', `scale=-2:${height}`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1']);
      out[i] = `data:image/jpeg;base64,${stdout.toString('base64')}`;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

/** Loudness (LUFS integrated, true peak) of a file or a time window. */
export async function loudness(path: string, o: { from?: number; duration?: number } = {}): Promise<{ lufs: number; peak: number }> {
  const pre = o.from ? ['-ss', String(o.from)] : [];
  const dur = o.duration ? ['-t', String(o.duration)] : [];
  const { stderr } = await runFfmpeg([...pre, ...dur, '-i', path, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const i = /I:\s+(-?[\d.]+|-inf) LUFS/g;
  let m: RegExpExecArray | null, lufs = -70;
  while ((m = i.exec(stderr))) lufs = m[1] === '-inf' ? -70 : +m[1];
  const pk = /Peak:\s+(-?[\d.]+|-inf) dBFS/g;
  let peak = -70;
  while ((m = pk.exec(stderr))) peak = m[1] === '-inf' ? -70 : +m[1];
  return { lufs, peak };
}
