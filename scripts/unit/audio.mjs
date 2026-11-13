// Unit tests of the audio effects: catalogue values and the filters' maths.
export default ({ test, ok, near, M }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  /** |H(e^jw)| of a biquad [b0, b1, b2, a1, a2] at f Hz */
  const mag = (c, f, sr = 48000) => {
    const w = (2 * Math.PI * f) / sr, re = (a, b, d) => a + b * Math.cos(w) + d * Math.cos(2 * w), im = (b, d) => -b * Math.sin(w) - d * Math.sin(2 * w);
    return Math.hypot(re(c[0], c[1], c[2]), im(c[1], c[2])) / Math.hypot(re(1, c[3], c[4]), im(c[3], c[4]));
  };

  test('audio: los diez efectos de audio con los valores de After Effects', () => {
    const ids = ['audioBackwards', 'audioBassTreble', 'audioDelay', 'audioFlange', 'audioHiLo', 'audioModulator', 'audioParamEQ', 'audioReverb', 'audioStereoMixer', 'audioTone'];
    ok(ids.every((id) => fx(id)?.cat === 'Audio' && fx(id).still), 'categoría Audio, sin cambiar píxeles');
    // Aud_Delay: 500 ms (0…5000), 50 % / 50 % (0…1000), dry / wet 75 % (0…400)
    ok(def('audioDelay', 'time').def === 500 && def('audioDelay', 'time').max === 5000 && def('audioDelay', 'feedback').max === 1000 && def('audioDelay', 'dry').def === 75 && def('audioDelay', 'wet').max === 400, 'Retardo: 500 ms, 50 %, 50 %, 75 %, 75 %');
    // Aud_Flange: 3 ms (0…500), 1 voice (0…32), 0.3 Hz (0…1000), 50 %, 0°, dry / wet 50 %
    ok(def('audioFlange', 'separation').def === 3 && def('audioFlange', 'voices').max === 32 && def('audioFlange', 'rate').def === 0.3 && def('audioFlange', 'depth').def === 50 && def('audioFlange', 'phase').max === 360 && def('audioFlange', 'wet').def === 50, 'Flanger y chorus: 3 ms, 1 voz, 0,3 Hz, 50 %');
    // Aud_HiLo: High Pass, 2000 Hz (1…20000), dry 0, wet 100
    ok(def('audioHiLo', 'mode').def === 'high' && def('audioHiLo', 'cutoff').def === 2000 && def('audioHiLo', 'cutoff').min === 1 && def('audioHiLo', 'dry').def === 0 && def('audioHiLo', 'wet').def === 100, 'Paso alto-bajo: paso alto a 2000 Hz');
    // Aud_Mixer: 100 % (0…400), pans −100 / 100
    ok(def('audioStereoMixer', 'left').max === 400 && def('audioStereoMixer', 'leftPan').def === -100 && def('audioStereoMixer', 'rightPan').def === 100 && def('audioStereoMixer', 'invert').def === 0, 'Mezclador estéreo');
    // Aud_Modulator: Sine, 10 Hz, 2 %, 50 %
    ok(def('audioModulator', 'type').def === 'sine' && def('audioModulator', 'rate').def === 10 && def('audioModulator', 'depth').def === 2 && def('audioModulator', 'amplitude').def === 50, 'Modulador: seno, 10 Hz, 2 %, 50 %');
    // Aud_ParamEQ: bands at 1 / 5 / 10 kHz (1…21609), only band 1 on, bandwidth 20 (0.1…99), boost/cut 50 (±100)
    ok(def('audioParamEQ', 'band1').def === 1 && def('audioParamEQ', 'band2').def === 0 && def('audioParamEQ', 'freq3').def === 10000 && def('audioParamEQ', 'freq1').max === 21609 && def('audioParamEQ', 'width2').min === 0.1 && def('audioParamEQ', 'boost1').def === 50, 'EQ paramétrico: tres bandas');
    // Aud_Reverb: 100 ms (0…5000), 75 %, 25 %, 10 %, dry 90, wet 10
    ok(def('audioReverb', 'time').def === 100 && def('audioReverb', 'diffusion').def === 75 && def('audioReverb', 'decay').def === 25 && def('audioReverb', 'brightness').def === 10 && def('audioReverb', 'dry').def === 90 && def('audioReverb', 'wet').def === 10, 'Reverberación');
    // Aud_Tone: Sine (4 waveforms), 440 / 493.68 / 554.4 / 587.4 / 659.12 Hz (0…30000), level 20 %
    ok(def('audioTone', 'wave').choices.length === 4 && [440, 493.68, 554.4, 587.4, 659.12].every((f, i) => near(def('audioTone', `f${i + 1}`).def, f, 1e-6)) && def('audioTone', 'f1').max === 30000 && def('audioTone', 'level').def === 20, 'Tono: cinco frecuencias, 20 %');
    ok(def('audioBassTreble', 'bass').min === -100 && def('audioBassTreble', 'treble').def === 0 && def('audioBackwards', 'swap').def === 0, 'Graves y agudos ±100; Hacia atrás sin intercambiar canales');
  });

  test('audio: filtros de Graves y agudos, Paso alto-bajo, EQ paramétrico, Retardo y Reverberación', () => {
    // Bass & Treble: neutral at 0; bass +100 doubles the lows (first order 500 Hz shelf), treble +100 the highs (1 kHz)
    ok(near(mag(M.bassTrebleCoefs(0, 0, 48000), 300), 1, 1e-9), 'Graves y agudos a 0: neutro');
    ok(near(mag(M.bassTrebleCoefs(1, 0, 48000), 20), 2, 0.01) && near(mag(M.bassTrebleCoefs(1, 0, 48000), 15000), 1, 0.02), 'graves +100: ×2 abajo, nada arriba');
    ok(near(mag(M.bassTrebleCoefs(0, 1, 48000), 20000), 2, 0.02) && near(mag(M.bassTrebleCoefs(0, -1, 48000), 30), 1, 0.01), 'agudos ±100: ×2 / nada en graves');
    // High-Low Pass: first order, −3 dB at the cutoff
    ok(near(mag(M.hiLoCoefs(false, 2000, 0, 1, 48000), 2000), Math.SQRT1_2, 0.01) && near(mag(M.hiLoCoefs(true, 2000, 0, 1, 48000), 2000), Math.SQRT1_2, 0.01), 'paso alto / bajo: −3 dB en el corte');
    ok(near(mag(M.hiLoCoefs(true, 2000, 1, 1, 48000), 10), 2, 0.01), 'seco 100 % + procesado 100 % en graves: ×2');
    // Parametric EQ: ×4 (boost 100) / ×¼ (−100) at the centre frequency (on the 0.49·sr scale), 1 far away
    const c = M.peakCoefs(4000, 10, 100, 48000), f0 = (4000 * 0.5) / 0.49;
    ok(near(mag(c, f0), 4, 0.01) && near(mag(c, 20), 1, 0.01), 'EQ paramétrico: ×4 en el centro, ×1 lejos');
    ok(near(mag(M.peakCoefs(4000, 10, -100, 48000), f0), 0.25, 0.01), 'EQ paramétrico −100: ×¼');
    // Delay: echoes every delay time, first one wet·(amount + feedback)·amount, then ×feedback
    const taps = M.delayTaps(300, 0.5, 0.5, 0.75, 48000);
    ok(near(taps[0][0], 0.3, 1e-6) && near(taps[1][0], 0.6, 1e-6) && near(taps[0][1], 0.375, 1e-9) && near(taps[1][1], 0.1875, 1e-9), 'Retardo: ecos a 0,3 y 0,6 s con 0,375 y 0,1875');
    ok(M.delayTaps(0, 0.5, 0.5, 0.75, 48000).length === 0 && M.delayTaps(100, 0.5, 0, 1, 48000).length === 1, 'Retardo: sin tiempo no hay ecos; sin retroalimentación, uno');
    // Reverb: reflections between 0 and three passes of 1.74 × the time, fainter with more decay
    const r = M.reverbTaps(100, 0.75, 0.25, 0.1), r2 = M.reverbTaps(100, 0.75, 0.9, 0.1);
    ok(r.length > 20 && r.every((x) => x[0] > 0 && x[0] < 0.53) && r2.at(-1)[1] < r.at(-1)[1], 'Reverberación: reflexiones dentro de 3 × 1,74 × el tiempo');
    ok(near(M.brightPole(1), (6 - Math.sqrt(32)) / 2, 1e-9) && M.brightPole(0.1) > 0.7 && M.brightPole(0.1) < 0.75, 'Reverberación: brillo como paso bajo de un polo');
  });

  test('audio: grafo de ffmpeg de una cadena de efectos', () => {
    const st = (fx, v = {}) => M.audioStage(fx, (k) => v[k]);
    const g = M.audioFxGraph([st('audioBackwards', { swap: 1 }), st('audioBassTreble', { bass: 50 }), st('audioFlange', { voices: 2 }), st('audioDelay')], 'i', 'o', 'u');
    ok(g.startsWith('[i]areverse,pan=stereo|c0=c1|c1=c0[us0]') && g.includes('biquad=') && g.includes('flanger=') && g.includes('aecho=') && g.endsWith('[o]'), 'hacia atrás, biquad, flanger y eco encadenados');
    ok((g.match(/\[us2\]/g) ?? []).length === 2, 'cada etapa se conecta con la siguiente');
    const t = M.toneSource(st('audioTone', { f2: 0, wave: 'square' }), 2);
    ok(t.startsWith("aevalsrc='0.2*((2*lt(mod(440*t,1),0.5)-1)+") && t.endsWith(':s=48000:d=2'), `tono cuadrado sin la frecuencia 2 (${t.slice(0, 60)}…)`);
    ok(M.audioFxGraph([], 'a', 'b', 'u') === '[a]anull[b]', 'sin efectos: anull');
  });

  test('audio: parámetros animados — una copia por muestra mezclada con pesos en triángulo', () => {
    const st = M.audioStage('audioBassTreble', (k) => ({ bass: 0 })[k]);
    st.anim = { t: [1, 2, 3], p: [{ bass: -100, treble: 0 }, { bass: 0, treble: 0 }, { bass: 100, treble: 0 }] };
    const g = M.audioFxGraph([st], 'i', 'o', 'u', 48000, 1, 2);
    ok(g.startsWith('[i]asplit=3[ux0a0][ux0a1][ux0a2]') && (g.match(/biquad=/g) ?? []).length === 3 && g.endsWith('amix=inputs=3:normalize=0:duration=first[o]'), g.slice(0, 80));
    // stream time = comp time − origin: hats at 0, 1 and 2 s
    ok(g.includes("volume=volume='clip((1-t)/1,0,1)':eval=frame") && g.includes("volume=volume='clip(min((t-0)/1,(2-t)/1),0,1)'") && g.includes("volume=volume='clip((t-1)/1,0,1)'"), 'pesos en triángulo');
    // after Backwards the stream runs from the end: the last sample comes first
    const rv = M.audioFxGraph([M.audioStage('audioBackwards', () => undefined), st], 'i', 'o', 'u', 48000, 1, 2);
    ok(rv.includes('[ux1a0]biquad=a0=1:a1=') && rv.indexOf('[ux1a0]') < rv.indexOf('[ux1a2]'), 'invertido');
    // unanimated stages: the graph stays as it was
    ok(M.audioFxGraph([M.audioStage('audioBassTreble', (k) => ({ bass: 50 })[k])], 'i', 'o', 'u').split(';').length === 1, 'sin animación: un solo biquad');
  });
};
