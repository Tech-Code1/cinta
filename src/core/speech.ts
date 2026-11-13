// Local speech-to-text (no internet): sherpa-onnx + Whisper ONNX + Silero VAD — same models as the shorts kit.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { decodePcm } from './analysis';
import type { Cue } from './srt';

export interface WhisperModel {
  encoder: string;
  decoder: string;
  tokens: string;
  vad: string;
}

/** Folders searched for a Whisper model (first match wins). */
export function modelSearchDirs(extra?: string): string[] {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return [
    extra,
    process.env.CINTA_WHISPER_DIR,
    join(process.env.CINTA_USER_DATA ?? join(appData, 'Cinta'), 'models'),
    join(homedir(), 'Desktop', 'Videos de Camilo en Br y En', '_shorts_kit', 'models'),
  ].filter((d): d is string => !!d && existsSync(d));
}

function findModelIn(dir: string, depth = 2): WhisperModel | null {
  let files: string[];
  try { files = readdirSync(dir); } catch { return null; }
  const enc = files.find((f) => /encoder.*\.onnx$/i.test(f) && /int8/i.test(f)) ?? files.find((f) => /encoder.*\.onnx$/i.test(f));
  const dec = files.find((f) => /decoder.*\.onnx$/i.test(f) && /int8/i.test(f)) ?? files.find((f) => /decoder.*\.onnx$/i.test(f));
  const tok = files.find((f) => /tokens\.txt$/i.test(f));
  if (enc && dec && tok) {
    const vadCandidates = [join(dir, 'silero_vad.onnx'), join(dirname(dir), 'silero_vad.onnx')];
    const vad = vadCandidates.find((p) => existsSync(p));
    if (vad) return { encoder: join(dir, enc), decoder: join(dir, dec), tokens: join(dir, tok), vad };
  }
  if (depth <= 0) return null;
  for (const f of files) {
    const p = join(dir, f);
    try { if (statSync(p).isDirectory()) { const m = findModelIn(p, depth - 1); if (m) return m; } } catch { /* skip */ }
  }
  return null;
}

export function findWhisperModel(extra?: string): WhisperModel | null {
  for (const d of modelSearchDirs(extra)) {
    const m = findModelIn(d);
    if (m) return m;
  }
  return null;
}

interface SherpaSegment { start: number; samples: Float32Array }
interface Sherpa {
  OfflineRecognizer: new (cfg: object) => { createStream(): { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void }; decode(s: unknown): void; getResult(s: unknown): { text: string } };
  Vad: new (cfg: object, buf: number) => { acceptWaveform(s: Float32Array): void; isEmpty(): boolean; front(external?: boolean): SherpaSegment; pop(): void; flush(): void };
}

/** Transcribes the sound of a media file into timed segments. */
export async function transcribe(path: string, o: { language?: string; modelDir?: string; from?: number; duration?: number; threads?: number; onProgress?: (f: number) => void } = {}): Promise<Cue[]> {
  const model = findWhisperModel(o.modelDir);
  if (!model) {
    throw new Error('No hay ningún modelo Whisper. Copie un modelo sherpa-onnx-whisper (encoder/decoder .onnx + tokens.txt) y silero_vad.onnx en %APPDATA%\\Cinta\\models o indique model_dir.');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node') as Sherpa;
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: model.encoder, decoder: model.decoder, language: o.language ?? '', task: 'transcribe', tailPaddings: -1 },
      tokens: model.tokens,
      numThreads: o.threads ?? Math.max(2, Math.min(8, cpus().length - 2)),
      provider: 'cpu',
      debug: 0,
    },
  });
  const vad = new sherpa.Vad({
    sileroVad: { model: model.vad, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.35, maxSpeechDuration: 12, windowSize: 512 },
    sampleRate: 16000,
    debug: false,
    numThreads: 1,
  }, 60);
  const pcm = await decodePcm(path, 16000, { from: o.from, duration: o.duration });
  const out: Cue[] = [];
  const off = o.from ?? 0;
  const drain = () => {
    while (!vad.isEmpty()) {
      // Electron (ELECTRON_RUN_AS_NODE) forbids external N-API buffers: ask for a copy
      const seg = vad.front(false);
      vad.pop();
      const s = rec.createStream();
      s.acceptWaveform({ sampleRate: 16000, samples: seg.samples });
      rec.decode(s);
      const text = rec.getResult(s).text.trim();
      const start = seg.start / 16000 + off;
      if (text) out.push({ start: Math.round(start * 1000) / 1000, end: Math.round((start + seg.samples.length / 16000) * 1000) / 1000, text });
    }
  };
  const win = 512;
  for (let i = 0; i + win <= pcm.length; i += win) {
    vad.acceptWaveform(pcm.subarray(i, i + win));
    drain();
    if (o.onProgress && i % (win * 400) === 0) {
      o.onProgress(i / pcm.length);
      await new Promise((r) => setImmediate(r));
    }
  }
  vad.flush();
  drain();
  o.onProgress?.(1);
  return out;
}
