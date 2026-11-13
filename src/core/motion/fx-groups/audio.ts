// After Effects' audio effects: the catalogue and the ffmpeg filters that play them in the
// mix of a composition (src/core/motion-io.ts). They don't change pixels (still: true). Every formula below is the
// plug-in's own processing re-expressed as filters: first order shelves / filters and peaking biquads with the plug-in's
// coefficients, tapped delays for the echoes, modulated delays for flange / vibrato.
import type { FxDef } from '../effects';
import type { PVal } from '../model';
import { n, pc, bo, ch } from '../fxparams';

const A = 'Audio';
const WAVES: [string, string][] = [['sine', 'Seno'], ['triangle', 'Triángulo'], ['saw', 'Sierra'], ['square', 'Cuadrado']];

export const FX_AUDIO: FxDef[] = [
  // Backwards (Aud_Reverse): the layer's audio reversed; swap channels off
  { id: 'audioBackwards', name: 'Hacia atrás', cat: A, still: true, params: [bo('swap', 'Intercambiar canales')] },
  // Bass & Treble (Aud_BT): ±100 each; first order shelves at 500 Hz (bass) and 1 kHz (treble), +100 doubles the band
  { id: 'audioBassTreble', name: 'Graves y agudos', cat: A, still: true, params: [n('bass', 'Graves', 0, -100, 100), n('treble', 'Agudos', 0, -100, 100)] },
  // Delay (Aud_Delay): 500 ms (0…5000), delay amount 50 %, feedback 50 % (0…1000), dry 75 %, wet 75 % (0…400)
  { id: 'audioDelay', name: 'Retardo', cat: A, still: true, params: [n('time', 'Tiempo de retardo (milisegundos)', 500, 0, 5000), pc('amount', 'Cantidad de retardo', 50, 0, 1000), pc('feedback', 'Retroalimentación', 50, 0, 1000), pc('dry', 'Salida sin procesar', 75, 0, 400), pc('wet', 'Salida procesada', 75, 0, 400)] },
  // Flange & Chorus (Aud_Flange): voice separation 3 ms (0…500), 1 voice (0…32), rate 0.3 Hz (0…1000), depth 50 %,
  // voice phase change 0° (0…360), invert phase and stereo voices off, dry 50 %, wet 50 % (0…400)
  { id: 'audioFlange', name: 'Flanger y chorus', cat: A, still: true, params: [n('separation', 'Tiempo de separación de voces (ms)', 3, 0, 500), n('voices', 'Voces', 1, 0, 32), n('rate', 'Velocidad de modulación', 0.3, 0, 1000), pc('depth', 'Profundidad de modulación', 50), n('phase', 'Cambio de fase de voz', 0, 0, 360), bo('invert', 'Invertir fase'), bo('stereo', 'Voces estéreo'), pc('dry', 'Salida sin procesar', 50, 0, 400), pc('wet', 'Salida procesada', 50, 0, 400)] },
  // High-Low Pass (Aud_HiLo): High Pass by default, cutoff 2000 Hz (1…20000), dry 0 %, wet 100 % (0…400)
  { id: 'audioHiLo', name: 'Paso alto-bajo', cat: A, still: true, params: [ch('mode', 'Opciones de filtro', [['high', 'Paso alto'], ['low', 'Paso bajo']]), n('cutoff', 'Frecuencia de corte', 2000, 1, 20000), pc('dry', 'Salida sin procesar', 0, 0, 400), pc('wet', 'Salida procesada', 100, 0, 400)] },
  // Modulator (Aud_Modulator): Sine / Triangle, rate 10 Hz (0…1000), depth 2 % (vibrato of up to ±20 ms), amplitude
  // modulation 50 %
  { id: 'audioModulator', name: 'Modulador', cat: A, still: true, params: [ch('type', 'Tipo de modulación', [['sine', 'Seno'], ['triangle', 'Triángulo']]), n('rate', 'Velocidad de modulación', 10, 0, 1000), pc('depth', 'Profundidad de modulación', 2), pc('amplitude', 'Modulación de amplitud', 50)] },
  // Parametric EQ (Aud_ParamEQ): three peaking bands (1, 5 and 10 kHz; only band 1 on), bandwidth 20 % of the
  // Nyquist band (0.1…99), boost/cut 50 (±100; ±100 = ×4 / ×¼)
  { id: 'audioParamEQ', name: 'EQ paramétrico', cat: A, still: true, params: [1, 2, 3].flatMap((b) => [bo(`band${b}`, `Banda ${b} activada`, b === 1), n(`freq${b}`, `Banda ${b}: frecuencia`, [1000, 5000, 10000][b - 1], 1, 21609), n(`width${b}`, `Banda ${b}: ancho de banda`, 20, 0.1, 99), n(`boost${b}`, `Banda ${b}: aumentar/cortar`, 50, -100, 100)]) },
  // Reverb (Aud_Reverb): reverb time 100 ms (0…5000), diffusion 75 %, decay 25 %, brightness 10 %, dry 90 %,
  // wet 10 % (0…400)
  { id: 'audioReverb', name: 'Reverberación', cat: A, still: true, params: [n('time', 'Tiempo de reverberación (ms)', 100, 0, 5000), pc('diffusion', 'Difusión', 75), pc('decay', 'Atenuación', 25), pc('brightness', 'Brillo', 10), pc('dry', 'Salida sin procesar', 90, 0, 400), pc('wet', 'Salida procesada', 10, 0, 400)] },
  // Stereo Mixer (Aud_Mixer): levels 100 % (0…400), left pan −100, right pan 100, invert phase off
  { id: 'audioStereoMixer', name: 'Mezclador estéreo', cat: A, still: true, params: [pc('left', 'Nivel izquierdo', 100, 0, 400), pc('right', 'Nivel derecho', 100, 0, 400), n('leftPan', 'Panorámica izquierda', -100, -100, 100), n('rightPan', 'Panorámica derecha', 100, -100, 100), bo('invert', 'Invertir fase')] },
  // Tone (Aud_Tone): replaces the layer's audio (any layer, even one without sound) with up to five tones of one
  // waveform (sine by default; a tone at 0 Hz is off): 440, 493.68, 554.4, 587.4 and 659.12 Hz (0…30000), level 20 %
  // of full scale per tone
  { id: 'audioTone', name: 'Tono', cat: A, still: true, params: [ch('wave', 'Opciones de forma de onda', WAVES), n('f1', 'Frecuencia 1', 440, 0, 30000), n('f2', 'Frecuencia 2', 493.68, 0, 30000), n('f3', 'Frecuencia 3', 554.4, 0, 30000), n('f4', 'Frecuencia 4', 587.4, 0, 30000), n('f5', 'Frecuencia 5', 659.12, 0, 30000), pc('level', 'Nivel', 20)] },
];

export const AUDIO_FX = new Set(FX_AUDIO.map((f) => f.id));

/** one audio effect with its values (at the time of the mix): what a piece of sound carries to the mixer. When some of
 *  its parameters change over time, `anim` holds its values sampled at increasing comp times (`t`, seconds): the
 *  graph then runs the effect once per sample and crossfades them (piecewise-linear in time). */
export interface AudioStage { fx: string; p: Record<string, number | string>; anim?: { t: number[]; p: AudioStage['p'][] } }

/** The values of an audio effect instance, read with `at(paramId)` (missing params take the catalogue default). */
export function audioStage(fx: string, at: (k: string) => PVal | undefined): AudioStage {
  const def = FX_AUDIO.find((f) => f.id === fx)!;
  const p: AudioStage['p'] = {};
  for (const q of def.params) {
    const v = at(q.id);
    p[q.id] = q.type === 'choice' ? String(v ?? q.def) : Number(v ?? q.def) || 0;
  }
  return { fx, p };
}

const f6 = (x: number) => (Math.abs(x) < 1e-12 ? '0' : x.toFixed(9).replace(/\.?0+$/, ''));
const biquad = (b0: number, b1: number, b2: number, a1: number, a2: number) => `biquad=a0=1:a1=${f6(a1)}:a2=${f6(a2)}:b0=${f6(b0)}:b1=${f6(b1)}:b2=${f6(b2)}`;
const num = (s: AudioStage, k: string) => Number(s.p[k]) || 0;
/** first order bilinear pole of a cutoff (the c of y = g·(x ± x₁) + c·y₁) */
const pole1 = (fc: number, sr: number) => { const K = Math.tan((Math.PI * Math.min(fc, sr / 2 - 1)) / sr); return (1 - K) / (1 + K); };

/** Bass & Treble as one biquad: x + bass·LP₅₀₀(x) + treble·HP₁₀₀₀(x). */
export function bassTrebleCoefs(bass: number, treble: number, sr: number): number[] {
  const cb = pole1(500, sr), ct = pole1(1000, sr), gb = (1 - cb) / 2 * bass, gt = (1 + ct) / 2 * treble;
  return [1 + gb + gt, -(cb + ct) + gb * (1 - ct) - gt * (1 + cb), cb * ct - gb * ct + gt * cb, -(cb + ct), cb * ct];
}
/** High-Low Pass: dry·x + wet·(first order LP or HP) */
export function hiLoCoefs(low: boolean, fc: number, dry: number, wet: number, sr: number): number[] {
  const c = pole1(fc, sr), g = low ? (1 - c) / 2 : (1 + c) / 2;
  return [dry + wet * g, -dry * c + (low ? wet * g : -wet * g), 0, -c, 0];
}
/** one Parametric EQ band: a peaking biquad centred on f (of 0.49·sr, the plug-in's top), bandwidth in % of it,
 *  gain 4^(boost/100) */
export function peakCoefs(f: number, width: number, boost: number, sr: number): number[] {
  const top = 0.49 * sr, w = (Math.PI * Math.min(f, top)) / top, K = Math.tan((Math.PI * width) / 200), G = Math.pow(4, boost / 100), d = 1 + K;
  return [(1 + K * G) / d, (-2 * Math.cos(w)) / d, (1 - K * G) / d, (-2 * Math.cos(w)) / d, (1 - K) / d];
}
/** Delay's echoes: [seconds, gain] after the dry signal (feedback loop unrolled until it fades) */
export function delayTaps(time: number, amount: number, feedback: number, wet: number, sr: number): [number, number][] {
  const D = Math.ceil((time / 1000) * sr);
  const out: [number, number][] = [];
  if (D <= 0) return out;
  let g = wet * (amount + feedback) * amount;
  for (let k = 1; k <= 60 && Math.abs(g) > 1e-4 && (k * D) / sr <= 120; k++, g *= feedback) out.push([(k * D) / sr, g]);
  return out;
}
/** Reverb's reflections ([seconds, gain]): the plug-in's five delay lines (0.32, 0.64, 0.86, 1 and 1.74 × the reverb
 *  time) and their diffusion taps, fading with decay; brightness lowpasses what goes in. An approximation of its
 *  all-pass network with the same lengths. */
export function reverbTaps(time: number, diffusion: number, decay: number, wet: number): [number, number][] {
  const T = time / 1000;
  if (T <= 0) return [];
  const lines = [0.32, 0.64, 0.86, 1, 1.74];
  const taps = [[0.02, 0.21, 0.4, 0.61, 0.79, 0.97], [0.05, 0.18, 0.37, 0.65, 0.83, 0.94], [0.08, 0.33, 0.59, 0.81], [0.04, 0.37, 0.53, 0.86]];
  const at: [number, number][] = lines.map((l) => [l * T, 1 - diffusion * 0.5]);
  taps.forEach((g, i) => g.forEach((f) => at.push([f * T * (i < 2 ? 1 : 1.74), diffusion / 2])));
  const keep = 1 - decay;
  const out: [number, number][] = [];
  // three passes round the loop, each one longer and fainter
  for (let pass = 0; pass < 3; pass++) for (const [t, g] of at) {
    const tt = t + pass * 1.74 * T;
    out.push([tt, (wet * g * Math.pow(keep, tt / T)) / Math.sqrt(at.length)]);
  }
  return out.filter((x) => x[0] > 0 && Math.abs(x[1]) > 1e-4).sort((a, b) => a[0] - b[0]);
}
/** Reverb's brightness as a one pole lowpass coefficient a (y = (1 − a)·x + a·y₁) */
export function brightPole(b: number): number {
  const c = 2 * Math.cos(Math.PI * Math.max(1e-4, Math.min(1, b))) - 4;
  return (-c - Math.sqrt(c * c - 4)) / 2;
}

/** dry + echoes in one aecho (its gains go up to 1, so they're scaled and the volume puts them back) */
const echo = (dry: number, taps: [number, number][]) => {
  const G = Math.max(1, Math.abs(dry), ...taps.map((t) => Math.abs(t[1])));
  if (!taps.length) return `volume=${f6(dry)}`;
  return `aecho=in_gain=${f6(Math.abs(dry) / G)}:out_gain=1:delays=${taps.map((t) => f6(t[0] * 1000)).join('|')}:decays=${taps.map((t) => f6(Math.max(1e-6, t[1] / G))).join('|')},volume=${f6(G)}`;
};

/**
 * A modulated delay (min `minMs`, swinging `swingMs` more at `rate` Hz) of [in] into [out], without the dry signal:
 * ffmpeg's flanger at width 100 % gives ½·(x + delayed), so twice that minus x is the delayed voice alone.
 */
function modDelay(inL: string, outL: string, u: string, minMs: number, swingMs: number, rate: number, tri: boolean, sr: number): string {
  const pre = Math.max(0, minMs - 25), base = minMs - pre, swing = Math.min(10, Math.max(0, swingMs));
  const shift = pre > 0 ? `adelay=delays=${Math.round((pre / 1000) * sr)}S:all=1,` : '';
  if (swing < 1e-3 || rate < 0.1) return `[${inL}]adelay=delays=${Math.round(((minMs + swing / 2) / 1000) * sr)}S:all=1[${outL}]`;
  return `[${inL}]${shift}asplit=2[${u}f][${u}n];[${u}f]flanger=delay=${f6(base)}:depth=${f6(swing)}:regen=0:width=100:speed=${f6(Math.min(10, rate))}:shape=${tri ? 'triangular' : 'sinusoidal'},volume=2[${u}f2];[${u}n]volume=-1[${u}n2];[${u}f2][${u}n2]amix=inputs=2:normalize=0:duration=first[${outL}]`;
}

/** The tone source (an aevalsrc graph, stereo) of a Tone stage lasting `dur` seconds. */
export function toneSource(s: AudioStage, dur: number, sr = 48000): string {
  const lv = num(s, 'level') / 100;
  const fs = [1, 2, 3, 4, 5].map((i) => num(s, `f${i}`)).filter((f) => f > 0);
  const w = String(s.p.wave);
  const one = (f: number) => {
    const ph = `mod(${f6(f)}*t,1)`;
    return w === 'triangle' ? `(1-4*abs(${ph}-0.5))` : w === 'saw' ? `(2*${ph}-1)` : w === 'square' ? `(2*lt(${ph},0.5)-1)` : `sin(${f6(2 * Math.PI * f)}*t)`;
  };
  const e = fs.length && lv ? `${f6(lv)}*(${fs.map(one).join('+')})` : '0';
  return `aevalsrc='${e}|${e}':s=${sr}:d=${f6(Math.max(0.001, dur))}`;
}

/** The filters of one stage (its values fixed) from [inL] to [outL]; `v` makes its inner labels unique. */
function stageGraph(s: AudioStage, inL: string, out: string, v: string, sr: number): string[] {
  const parts: string[] = [];
  const cur = inL;
  const lin = (f: string) => parts.push(`[${cur}]${f}[${out}]`);
  const P = (k: string) => num(s, k) / 100;
  switch (s.fx) {
    case 'audioBackwards': lin(`areverse${num(s, 'swap') ? ',pan=stereo|c0=c1|c1=c0' : ''}`); break;
    case 'audioBassTreble': { const c = bassTrebleCoefs(num(s, 'bass') / 100, num(s, 'treble') / 100, sr); lin(biquad(c[0], c[1], c[2], c[3], c[4])); break; }
    case 'audioHiLo': { const c = hiLoCoefs(s.p.mode === 'low', num(s, 'cutoff'), P('dry'), P('wet'), sr); lin(biquad(c[0], c[1], c[2], c[3], c[4])); break; }
    case 'audioParamEQ': {
      const bands = [1, 2, 3].filter((b) => num(s, `band${b}`)).map((b) => { const c = peakCoefs(num(s, `freq${b}`), num(s, `width${b}`), num(s, `boost${b}`), sr); return biquad(c[0], c[1], c[2], c[3], c[4]); });
      lin(bands.length ? bands.join(',') : 'anull'); break;
    }
    case 'audioStereoMixer': {
      const sg = num(s, 'invert') ? -1 : 1, lg = P('left') * sg, rg = P('right') * sg;
      const pl = (num(s, 'leftPan') / 100 + 1) / 2, pr = (1 - num(s, 'rightPan') / 100) / 2;
      const term = (a: number, b: number) => `${f6(a)}*c0${b < 0 ? '-' : '+'}${f6(Math.abs(b))}*c1`;
      lin(`pan=stereo|c0=${term((1 - pl) * lg, pr * rg)}|c1=${term(pl * lg, (1 - pr) * rg)}`); break;
    }
    case 'audioDelay': lin(echo(P('dry'), delayTaps(num(s, 'time'), P('amount'), P('feedback'), P('wet'), sr))); break;
    case 'audioReverb': {
      const a = brightPole(P('brightness'));
      // the wet path is lowpassed by brightness; the dry one is not
      parts.push(`[${cur}]asplit=2[${v}d][${v}w]`, `[${v}w]biquad=a0=1:a1=${f6(-a)}:a2=0:b0=${f6(1 - a)}:b1=0:b2=0,${echo(0, reverbTaps(num(s, 'time'), P('diffusion'), P('decay'), P('wet')))}[${v}w2]`, `[${v}d]volume=${f6(P('dry'))}[${v}d2]`, `[${v}d2][${v}w2]amix=inputs=2:normalize=0:duration=first[${out}]`);
      break;
    }
    case 'audioFlange': {
      const V = Math.max(0, num(s, 'voices')), sep = num(s, 'separation'), d = P('depth'), wet = P('wet') * (num(s, 'invert') ? -1 : 1), stereo = !!num(s, 'stereo');
      const nv = Math.ceil(V - 1e-9);
      if (!nv || !sep) { lin(`volume=${f6(P('dry') + (nv ? wet * V : 0))}`); break; }
      parts.push(`[${cur}]asplit=${nv + 1}${Array.from({ length: nv + 1 }, (_, k) => `[${v}i${k}]`).join('')}`, `[${v}i0]volume=${f6(P('dry'))}[${v}o0]`);
      for (let k = 1; k <= nv; k++) {
        const wk = Math.min(1, V - (k - 1)) * wet;
        parts.push(modDelay(`${v}i${k}`, `${v}m${k}`, `${v}v${k}`, sep * (k - d / 2), sep * d, num(s, 'rate'), false, sr));
        // stereo voices: odd voices on the left, even ones on the right
        parts.push(`[${v}m${k}]${stereo ? `pan=stereo|c0=${k % 2 ? f6(wk) : 0}*c0|c1=${k % 2 ? 0 : f6(wk)}*c1` : `volume=${f6(wk)}`}[${v}o${k}]`);
      }
      parts.push(`${Array.from({ length: nv + 1 }, (_, k) => `[${v}o${k}]`).join('')}amix=inputs=${nv + 1}:normalize=0:duration=first[${out}]`);
      break;
    }
    case 'audioModulator': {
      const rate = num(s, 'rate'), swing = 40 * P('depth'), am = P('amplitude');
      const trem = am > 0 && rate >= 0.1 ? `tremolo=f=${f6(Math.min(20000, rate))}:d=${f6(Math.min(1, am))}` : 'anull';
      if (swing > 0 && rate >= 0.1) { parts.push(modDelay(cur, `${v}m`, `${v}v`, 0, swing, rate, s.p.type === 'triangle', sr), `[${v}m]${trem}[${out}]`); }
      else lin(trem);
      break;
    }
    default: lin('anull');
  }
  return parts;
}

/** A crossfade weight in ffmpeg's expression language: 1 at τ[k], falling linearly to 0 at its neighbours (held
 *  before the first and after the last sample). */
function hat(tau: number[], k: number): string {
  const up = k > 0 ? `(t-${f6(tau[k - 1])})/${f6(tau[k] - tau[k - 1])}` : '', dn = k < tau.length - 1 ? `(${f6(tau[k + 1])}-t)/${f6(tau[k + 1] - tau[k])}` : '';
  return `clip(${up && dn ? `min(${up},${dn})` : up || dn},0,1)`;
}

/** The ffmpeg filtergraph of a list of audio stages from [inL] to [outL] (labels are made unique with `u`); Tone is
 *  not here (it is a source: see toneSource). The stream starts at comp time `origin` and lasts `len` s (animated
 *  stages map their sample times with them; after Backwards the stream runs from the end). */
export function audioFxGraph(stages: AudioStage[], inL: string, outL: string, u: string, sr = 48000, origin = 0, len = 0): string {
  const parts: string[] = [];
  let cur = inL, rev = false;
  stages.forEach((s, i) => {
    const out = i === stages.length - 1 ? outL : `${u}s${i}`, v = `${u}x${i}`;
    const an = s.anim && s.anim.t.length > 1 ? s.anim : null;
    if (!an) parts.push(...stageGraph(s, cur, out, v, sr));
    else {
      // one copy of the effect per sample, each weighted by its hat in stream time, summed
      let idx = an.t.map((_, k) => k);
      const st = an.t.map((t) => (rev ? len - (t - origin) : t - origin));
      if (rev) idx = idx.reverse();
      const tau = idx.map((k) => st[k]), K = idx.length;
      parts.push(`[${cur}]asplit=${K}${idx.map((_, j) => `[${v}a${j}]`).join('')}`);
      idx.forEach((k, j) => {
        parts.push(...stageGraph({ fx: s.fx, p: an.p[k] }, `${v}a${j}`, `${v}b${j}`, `${v}k${j}`, sr));
        parts.push(`[${v}b${j}]volume=volume='${hat(tau, j)}':eval=frame[${v}c${j}]`);
      });
      parts.push(`${idx.map((_, j) => `[${v}c${j}]`).join('')}amix=inputs=${K}:normalize=0:duration=first[${out}]`);
    }
    if (s.fx === 'audioBackwards') rev = !rev;
    cur = out;
  });
  if (!stages.length) parts.push(`[${inL}]anull[${outL}]`);
  return parts.join(';');
}
