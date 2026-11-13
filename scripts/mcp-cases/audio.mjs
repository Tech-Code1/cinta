// MCP cases of the audio effects: the sound of comp_render measured with ffmpeg (band levels, echoes, channels…).
import { spawnSync } from 'node:child_process';

export default async ({ test, call, assert, ff, W, FF }) => {
  const AP = W('audiofx.cinta');
  const SR = 48000;
  /** decoded samples of a file (mono mix, or one channel) */
  const pcm = (p, chan) => {
    const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-i', p, '-vn', '-af', chan !== undefined ? `pan=mono|c0=c${chan}` : 'pan=mono|c0=0.5*c0+0.5*c1', '-ar', String(SR), '-f', 'f32le', '-'], { windowsHide: true, maxBuffer: 1 << 28 });
    const b = new Uint8Array(r.stdout);
    return new Float32Array(b.buffer, 0, Math.floor(b.length / 4));
  };
  const seg = (a, t0, t1) => a.subarray(Math.round(t0 * SR), Math.round(t1 * SR));
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
  const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  /** amplitude of frequency f in a window (Goertzel) */
  const band = (a, f) => {
    const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < a.length; i++) { const s = a[i] + c * s1 - s2; s2 = s1; s1 = s; }
    return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / a.length;
  };
  const db = (x) => 20 * Math.log10(Math.max(1e-9, x));
  let lay = null, n = 0;
  const setup = async () => {
    if (lay) return;
    // 200 Hz + 5 kHz at 0.25 each; a click every 1 s (from 0.2 s); a 1 kHz tone only in the first half second
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*200*t)+0.25*sin(2*PI*5000*t):s=48000:d=2', '-ac', '2', W('afx-lohi.wav'));
    ff('-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t-0.2,1),0.002)*gte(t,0.2),0.8,0)':s=48000:d=2", '-ac', '2', W('afx-click.wav'));
    ff('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*1000*t)*lt(t,0.5)':s=48000:d=2", '-ac', '2', W('afx-half.wav'));
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*1000*t):s=48000:d=2', '-ac', '2', W('afx-k1.wav'));
    await call('project_new', { path: AP, width: 64, height: 48, fps: 30 });
    await call('comp_new', { project: AP, name: 'Aud', width: 64, height: 48, fps: 30, duration: 2, bg: '#000000' });
  };
  /** render the comp with one audio layer (file `src`) carrying the effects, decoded */
  const render = async (src, effects, o = {}) => {
    await setup();
    if (lay) await call('layer_delete', { project: AP, comp: 'Aud', layers: [lay] });
    lay = (await call('layer_add', { project: AP, comp: 'Aud', type: src ? 'audio' : 'solid', ...(src ? { media_path: W(`afx-${src}`) } : { color: '#000000', width: 64, height: 48 }), name: 'A' })).layer.id;
    for (const [e, v, keys] of effects) {
      const r = await call('effect_add', { project: AP, comp: 'Aud', layer: lay, effect: e, values: v });
      // keyframed parameters: { param: [{ t, v }] }
      for (const [k, ks] of Object.entries(keys ?? {})) await call('prop_set', { project: AP, comp: 'Aud', layer: lay, path: `effects.${r.effect.id ?? r.effect.name}.${k}`, keys: ks });
    }
    const out = W(`afx-${n++}.mov`);
    await call('comp_render', { project: AP, comp: 'Aud', output: out, format: 'mov', ...o });
    return out;
  };

  await test('audiofx: Graves y agudos, Paso alto-bajo y EQ paramétrico con los filtros de After Effects', async () => {
    const a0 = pcm(await render('lohi.wav', [])), w0 = seg(a0, 0.5, 1.5);
    const lo0 = band(w0, 200), hi0 = band(w0, 5000);
    assert(Math.abs(lo0 - 0.177) < 0.015 && Math.abs(hi0 - 0.177) < 0.015, `sin efectos: 200 Hz y 5 kHz a 0,177 por canal (${lo0.toFixed(3)}, ${hi0.toFixed(3)})`);
    // bass −100 takes the 500 Hz lowpass out, treble +100 adds the 1 kHz highpass: 200 Hz → |1 − LP₅₀₀ + HP₁₀₀₀| = −5 dB,
    // 5 kHz → about ×2
    let w = seg(pcm(await render('lohi.wav', [['audioBassTreble', { bass: -100, treble: 100 }]])), 0.5, 1.5);
    let dl = db(band(w, 200) / lo0), dh = db(band(w, 5000) / hi0);
    assert(dl < -4.3 && dl > -5.7 && dh > 5.3 && dh < 6.2, `graves −100: 200 Hz ${dl.toFixed(1)} dB; agudos +100: 5 kHz ${dh.toFixed(1)} dB`);
    // High-Low Pass by default: first order highpass at 2 kHz, all wet (200 Hz ≈ −20 dB, 5 kHz ≈ −0.7 dB)
    w = seg(pcm(await render('lohi.wav', [['audioHiLo', {}]])), 0.5, 1.5);
    dl = db(band(w, 200) / lo0); dh = db(band(w, 5000) / hi0);
    assert(dl < -18 && dl > -22 && dh > -1.2 && dh < 0, `paso alto 2 kHz: 200 Hz ${dl.toFixed(1)} dB, 5 kHz ${dh.toFixed(1)} dB`);
    w = seg(pcm(await render('lohi.wav', [['audioHiLo', { mode: 'low', cutoff: 1000 }]])), 0.5, 1.5);
    dl = db(band(w, 200) / lo0); dh = db(band(w, 5000) / hi0);
    assert(dl > -0.5 && dh < -13, `paso bajo 1 kHz: 200 Hz ${dl.toFixed(1)} dB, 5 kHz ${dh.toFixed(1)} dB`);
    // Parametric EQ: band 1 on 5 kHz at boost 100 → ×4 (+12 dB) there
    w = seg(pcm(await render('lohi.wav', [['audioParamEQ', { freq1: 5000 * 0.98, boost1: 100, width1: 5 }]])), 0.5, 1.5);
    dl = db(band(w, 200) / lo0); dh = db(band(w, 5000) / hi0);
    assert(dh > 10.5 && dh < 12.6 && Math.abs(dl) < 1, `EQ paramétrico +100 en 5 kHz: ${dh.toFixed(1)} dB (200 Hz ${dl.toFixed(1)} dB)`);
  });

  await test('audiofx: Retardo, Reverberación, Hacia atrás y Mezclador estéreo', async () => {
    // Delay 300 ms by default amounts: dry 0.75, first echo 0.75·(0.5 + 0.5)·0.5 = 0.375, the next one half of that
    const a = pcm(await render('click.wav', [['audioDelay', { time: 300 }]]));
    const p0 = peak(seg(a, 0.19, 0.25)), p1 = peak(seg(a, 0.49, 0.55)), p2 = peak(seg(a, 0.79, 0.85)), gap = peak(seg(a, 0.3, 0.48));
    assert(Math.abs(p0 - 0.424) < 0.04 && Math.abs(p1 / p0 - 0.5) < 0.05 && Math.abs(p2 / p0 - 0.25) < 0.04 && gap < 0.01, `retardo: clic ${p0.toFixed(3)}, ecos ×${(p1 / p0).toFixed(2)} y ×${(p2 / p0).toFixed(2)} a 300 y 600 ms`);
    // Reverb: a tail after the click that dies away within a few reverb times
    const r = pcm(await render('click.wav', [['audioReverb', { time: 100, wet: 100 }]]));
    const tail = rms(seg(r, 0.25, 0.4)), late = rms(seg(r, 0.9, 1.15));
    assert(tail > 0.002 && late < tail / 10, `reverberación: cola ${tail.toFixed(4)}, después ${late.toFixed(5)}`);
    // Backwards: the first half second of tone now ends the layer
    const b = pcm(await render('half.wav', [['audioBackwards', {}]]));
    assert(rms(seg(b, 0.1, 0.4)) < 0.005 && rms(seg(b, 1.6, 1.9)) > 0.12, `hacia atrás: silencio al principio (${rms(seg(b, 0.1, 0.4)).toFixed(4)}), tono al final (${rms(seg(b, 1.6, 1.9)).toFixed(3)})`);
    // Stereo Mixer: left level 0 % silences the left channel, right pan −100 sends the right one to the left
    let out = await render('k1.wav', [['audioStereoMixer', { left: 0 }]]);
    let L = rms(seg(pcm(out, 0), 0.5, 1.5)), R = rms(seg(pcm(out, 1), 0.5, 1.5));
    assert(L < 0.002 && Math.abs(R - 0.15) < 0.015, `mezclador: izquierdo 0 % (${L.toFixed(4)}), derecho intacto (${R.toFixed(3)})`);
    out = await render('k1.wav', [['audioStereoMixer', { left: 0, rightPan: -100 }]]);
    L = rms(seg(pcm(out, 0), 0.5, 1.5)); R = rms(seg(pcm(out, 1), 0.5, 1.5));
    assert(Math.abs(L - 0.15) < 0.015 && R < 0.002, `mezclador: el derecho a la izquierda (${L.toFixed(3)}, ${R.toFixed(4)})`);
  });

  await test('audiofx: Tono en una capa sin sonido, Modulador y Flanger y chorus', async () => {
    // Tone on a solid: five sine tones at 20 % each (440 … 659.12 Hz)
    const t = seg(pcm(await render(null, [['audioTone', {}]])), 0.5, 1.5);
    const a440 = band(t, 440), a659 = band(t, 659.12), a1k = band(t, 1000);
    assert(Math.abs(a440 - 0.2) < 0.02 && Math.abs(a659 - 0.2) < 0.02 && a1k < 0.01, `tono: 440 Hz ${a440.toFixed(3)}, 659 Hz ${a659.toFixed(3)}, 1 kHz ${a1k.toFixed(4)}`);
    const sq = seg(pcm(await render(null, [['audioTone', { wave: 'square', f2: 0, f3: 0, f4: 0, f5: 0, level: 50 }]])), 0.5, 1.5);
    assert(Math.abs(rms(sq) - 0.5) < 0.03 && band(sq, 1320) > 0.15, `tono cuadrado: RMS ${rms(sq).toFixed(3)}, 3.er armónico ${band(sq, 1320).toFixed(3)}`);
    // Modulator: amplitude modulation 100 % at 2 Hz swings the level from silence to full
    const m = pcm(await render('k1.wav', [['audioModulator', { rate: 2, depth: 0, amplitude: 100 }]]));
    const env = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map((s) => rms(seg(m, s, s + 0.04)));
    assert(Math.max(...env) > 0.12 && Math.min(...env) < 0.05, `modulador AM 100 %: envolvente ${env.map((x) => x.toFixed(3)).join(' ')}`);
    // Flange with 0.5 ms voice separation and no sweep: x/2 + x(t − 0.5 ms)/2 cancels 1 kHz; inverting the phase doubles it
    const f = rms(seg(pcm(await render('k1.wav', [['audioFlange', { separation: 0.5, depth: 0 }]])), 0.5, 1.5));
    const fi = rms(seg(pcm(await render('k1.wav', [['audioFlange', { separation: 0.5, depth: 0, invert: true }]])), 0.5, 1.5));
    assert(f < 0.01 && Math.abs(fi - 0.15) < 0.015, `flanger: 1 kHz anulado (${f.toFixed(4)}), con fase invertida entero (${fi.toFixed(3)})`);
  });

  await test('audiofx: los efectos de una capa de composición y el tramo de comp_render', async () => {
    // a layer with Delay rendered from 0.4 s: the echo of the click at 0.2 s (at 0.5 s) is there, 0.1 s in
    const d = pcm(await render('click.wav', [['audioDelay', { time: 300 }]], { from: 0.4, to: 1.4 }));
    assert(peak(seg(d, 0.08, 0.14)) > 0.18 && peak(seg(d, 0, 0.07)) < 0.01, `tramo desde 0,4 s: eco a 0,1 s (${peak(seg(d, 0.08, 0.14)).toFixed(3)})`);
    // a precomp with the half-second tone; Backwards on the comp layer plays it at the end of the layer
    const pre = (await call('comp_new', { project: AP, name: 'Pre', width: 64, height: 48, fps: 30, duration: 2, bg: '#000000' })).comp.id;
    await call('layer_add', { project: AP, comp: 'Pre', type: 'audio', media_path: W('afx-half.wav'), name: 'H' });
    await call('layer_delete', { project: AP, comp: 'Aud', layers: [lay] });
    lay = (await call('layer_add', { project: AP, comp: 'Aud', type: 'comp', comp_id: pre, name: 'P' })).layer.id;
    await call('effect_add', { project: AP, comp: 'Aud', layer: lay, effect: 'audioBackwards' });
    const out = W(`afx-${n++}.mov`);
    await call('comp_render', { project: AP, comp: 'Aud', output: out, format: 'mov' });
    const b = pcm(out);
    assert(rms(seg(b, 0.1, 0.4)) < 0.005 && rms(seg(b, 1.6, 1.9)) > 0.12, `capa de composición hacia atrás: tono al final (${rms(seg(b, 0.1, 0.4)).toFixed(4)} → ${rms(seg(b, 1.6, 1.9)).toFixed(3)})`);
  });

  await test('audiofx: parámetros animados — Graves y agudos y panorámica del Mezclador estéreo con fotogramas clave', async () => {
    // bass keyed −100 → +100 over the layer: 200 Hz goes from −5 dB (start) through 0 dB (middle) to about +5 dB
    const a0 = pcm(await render('lohi.wav', [])), lo0 = band(seg(a0, 0.5, 1.5), 200);
    const a = pcm(await render('lohi.wav', [['audioBassTreble', {}, { bass: [{ t: 0, v: -100 }, { t: 2, v: 100 }] }]]));
    const d = [[0.05, 0.3], [0.85, 1.15], [1.7, 1.95]].map(([x, y]) => db(band(seg(a, x, y), 200) / lo0));
    assert(d[0] < -3 && Math.abs(d[1]) < 1 && d[2] > 3 && d[0] < d[1] && d[1] < d[2], `graves animados: 200 Hz ${d.map((x) => x.toFixed(1)).join(' → ')} dB`);
    // the treble (not animated) keeps 5 kHz as it is
    const hi = db(band(seg(a, 0.85, 1.15), 5000) / band(seg(a0, 0.5, 1.5), 5000));
    assert(Math.abs(hi) < 0.6, `5 kHz sin cambios (${hi.toFixed(2)} dB)`);
    // Stereo Mixer (its linear pan law: half and half in the middle): the left input panned from left (−100) to right (100) with the right input silenced
    const out = await render('k1.wav', [['audioStereoMixer', { right: 0 }, { leftPan: [{ t: 0.5, v: -100 }, { t: 1.5, v: 100 }] }]]);
    const L = pcm(out, 0), R = pcm(out, 1), at = (c, x) => rms(seg(c, x, x + 0.2));
    const l0 = at(L, 0.1), r0 = at(R, 0.1), l1 = at(L, 0.9), r1 = at(R, 0.9), l2 = at(L, 1.7), r2 = at(R, 1.7);
    assert(Math.abs(l0 - 0.15) < 0.015 && r0 < 0.005 && Math.abs(l1 - r1) < 0.015 && Math.abs(l1 - 0.075) < 0.015 && l2 < 0.005 && Math.abs(r2 - 0.15) < 0.015, `panorámica animada: I/D ${l0.toFixed(3)}/${r0.toFixed(3)} → ${l1.toFixed(3)}/${r1.toFixed(3)} → ${l2.toFixed(3)}/${r2.toFixed(3)}`);
  });
};
