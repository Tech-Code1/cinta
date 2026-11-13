// Convert Audio to Keyframes (After Effects' keyframe assistant): a null «Amplitud de audio» with three sliders —
// left, right and both channels — keyed on every frame with the loudness of all the comp's audio (or chosen layers).
// Drive anything with an expression: thisComp.layer("Amplitud de audio").effect("Ambos canales")("value").
import type { Editor } from './ops';
import { runFfmpeg } from './ffmpeg';
import { motionOps } from './motion/ops';
import { findComp, findLayer, type Comp, type Layer } from './motion';

/** Stereo float PCM of a file (interleaved L R), at `rate`. */
async function stereoPcm(path: string, rate: number): Promise<Float32Array> {
  const { stdout } = await runFfmpeg(['-i', path, '-vn', '-ac', '2', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { stdout: 'buffer' });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength - (stdout.byteLength % 8)));
}

export async function audioToKeys(e: Editor, compId: string, o: { layers?: string[]; from?: number; to?: number } = {}): Promise<{ layer: string; frames: number; peak: number }> {
  const comps = (e.project as unknown as { comps?: Comp[] }).comps;
  const c = findComp(comps, compId);
  const chosen = o.layers?.length ? o.layers.map((id) => findLayer(c, id)) : c.layers.filter((l) => (l.type === 'audio' || l.type === 'video') && !l.audio.muted);
  const rate = 8000;
  const sources: { l: Layer; pcm: Float32Array }[] = [];
  for (const l of chosen) {
    const m = e.project.media.find((x) => x.id === l.mediaId);
    if (!m?.path || (l.type === 'video' && m.hasAudio === false)) continue;
    sources.push({ l, pcm: await stereoPcm(m.path, rate) });
  }
  if (!sources.length) throw new Error('No hay capas con sonido en la composición: añada una capa de audio o de vídeo con audio.');
  const fps = c.fps, t0 = Math.max(0, o.from ?? 0), t1 = Math.min(c.duration, o.to ?? c.duration);
  const n = Math.max(1, Math.round((t1 - t0) * fps));
  const L: number[] = [], R: number[] = [], B: number[] = [];
  for (let f = 0; f < n; f++) {
    const t = t0 + f / fps;
    let sl = 0, sr = 0;
    for (const { l, pcm } of sources) {
      if (t < l.in || t >= l.out) continue;
      // the frame's window of source samples; the layer's audio level (dB) scales it
      const src = (t - l.start) / (l.stretch || 1), gain = Math.pow(10, (Number(l.audio.level.v) || 0) / 20);
      const a = Math.max(0, Math.floor(src * rate)), b = Math.min(pcm.length / 2, Math.floor((src + 1 / fps / Math.abs(l.stretch || 1)) * rate));
      let ql = 0, qr = 0;
      for (let i = a; i < b; i++) { ql += pcm[i * 2] ** 2; qr += pcm[i * 2 + 1] ** 2; }
      const cnt = Math.max(1, b - a);
      sl += Math.sqrt(ql / cnt) * gain; sr += Math.sqrt(qr / cnt) * gain;
    }
    // amplitude on a 0…100 scale (full-scale sine ≈ 70), two decimals
    const k = (v: number) => Math.round(v * 10000) / 100;
    L.push(k(sl)); R.push(k(sr)); B.push(k((sl + sr) / 2));
  }
  const nl = motionOps.layerAdd(e, c.id, 'null', { name: 'Amplitud de audio' });
  const names = [['Canal izquierdo', L], ['Canal derecho', R], ['Ambos canales', B]] as const;
  for (const [name, vals] of names) {
    const fx = motionOps.effectAdd(e, c.id, nl.id, 'slider', {});
    motionOps.effectSet(e, c.id, nl.id, fx.id, { name });
    motionOps.propSet(e, c.id, nl.id, `effects.${fx.id}.value`, { keys: vals.map((v, i) => ({ t: t0 + i / fps, v })), clearKeys: true });
  }
  return { layer: nl.id, frames: n, peak: Math.max(...B) };
}
