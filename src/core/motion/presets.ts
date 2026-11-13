// Cinta's own animation presets for the advanced mode (behaviours, text animations, backgrounds, transitions,
// camera moves). Each one writes ordinary keyframes, expressions, animators or effects, so the result can be
// edited afterwards like anything else.
import type { Editor } from '../ops';
import { uid, type Project } from '../model';
import { easeKeys, setKey } from './anim';
import { newFx } from './effects';
import { outlineBounds, shapeOutline } from './geom';
import { findComp, findLayer, newLayer, P, type Comp, type Layer, type Prop, type PVal, type TextAnimator } from './model';
import { comps, layerSize, makeSelector, motionOps } from './ops';

interface Opts { at?: number; duration?: number; amount?: number; color?: string; colors?: string[] }
interface Ctx { p: Project; c: Comp; l: Layer; at: number; d: number; o: Opts }
export interface PresetDef { id: string; name: string; cat: string; desc: string; text?: boolean; out?: boolean; makesLayer?: boolean; /** created above the other layers (overlays) */ top?: boolean; apply: (x: Ctx) => void }

/** expo-out ("fluid stop") and expo-in handles */
const EXPO_OUT: [[number, number], [number, number]] = [[0.16, 1], [0.3, 1]];
const EXPO_IN: [[number, number], [number, number]] = [[0.7, 0], [0.84, 0]];

function keys(prop: Prop, list: [number, PVal][], ease: 'easy' | 'expoOut' | 'expoIn' | 'linear' = 'easy') {
  delete prop.k;
  const ks = list.map(([t, v]) => setKey(prop, Math.max(0, t), v));
  if (ease === 'linear') return;
  if (ease === 'easy') { easeKeys(ks, 'easy'); return; }
  const [a, b] = ease === 'expoOut' ? EXPO_OUT : EXPO_IN;
  ks.forEach((k, i) => { k.i = 'bezier'; if (i < ks.length - 1) k.eo = [...a]; if (i > 0) k.ei = [...b]; });
}
const add3 = (v: number[], dx: number, dy: number) => [v[0] + dx, v[1] + dy, v[2] ?? 0];
const tr = (l: Layer) => l.transform;

function animator(l: Layer, name: string, props: TextAnimator['props'], sel: Parameters<typeof makeSelector>[0]): TextAnimator {
  const an: TextAnimator = { id: uid('a'), name, props, selectors: [makeSelector(sel)] };
  l.text!.animators.push(an);
  return an;
}
/** range selector window [0, w] whose offset sweeps −w → 100 (in) — characters animate one after another */
function sweep(an: TextAnimator, at: number, d: number, w = 30, ease: 'easy' | 'expoOut' | 'linear' = 'linear', out = false) {
  const s = an.selectors[0] as Extract<TextAnimator['selectors'][number], { type: 'range' }>;
  s.start.v = 0;
  s.end.v = w;
  keys(s.offset, out ? [[at, -w], [at + d, 100]] : [[at, -w], [at + d, 100]], ease);
}

export const PRESETS: PresetDef[] = [
  // ───────────── comportamientos ─────────────
  { id: 'fadeIn', name: 'Fundido de entrada', cat: 'Comportamientos', desc: 'Opacidad 0 → 100 con suavizado.', apply: ({ l, at, d }) => keys(tr(l).opacity, [[at, 0], [at + d, 100]]) },
  { id: 'fadeOut', name: 'Fundido de salida', cat: 'Comportamientos', out: true, desc: 'Opacidad 100 → 0.', apply: ({ l, at, d }) => keys(tr(l).opacity, [[at, 100], [at + d, 0]]) },
  ...(['Left', 'Right', 'Up', 'Down'] as const).map((dir): PresetDef => ({
    id: `slideIn${dir}`, name: `Deslizar desde ${{ Left: 'la izquierda', Right: 'la derecha', Up: 'arriba', Down: 'abajo' }[dir]}`, cat: 'Comportamientos', desc: 'Entra desde fuera del encuadre y frena suave (con desenfoque de movimiento).',
    apply: ({ c, l, at, d }) => {
      const v = tr(l).position.v;
      const dx = dir === 'Left' ? -c.width : dir === 'Right' ? c.width : 0, dy = dir === 'Up' ? -c.height : dir === 'Down' ? c.height : 0;
      keys(tr(l).position, [[at, add3(v, dx, dy)], [at + d, [...v]]], 'expoOut');
      l.motionBlur = true;
    },
  })),
  ...(['Left', 'Right', 'Up', 'Down'] as const).map((dir): PresetDef => ({
    id: `slideOut${dir}`, name: `Salir hacia ${{ Left: 'la izquierda', Right: 'la derecha', Up: 'arriba', Down: 'abajo' }[dir]}`, cat: 'Comportamientos', out: true, desc: 'Acelera y sale del encuadre.',
    apply: ({ c, l, at, d }) => {
      const v = tr(l).position.v;
      const dx = dir === 'Left' ? -c.width : dir === 'Right' ? c.width : 0, dy = dir === 'Up' ? -c.height : dir === 'Down' ? c.height : 0;
      keys(tr(l).position, [[at, [...v]], [at + d, add3(v, dx, dy)]], 'expoIn');
      l.motionBlur = true;
    },
  })),
  { id: 'zoomIn', name: 'Acercar con rebote', cat: 'Comportamientos', desc: 'Escala 0 → 110 → 100.', apply: ({ l, at, d }) => { const s = tr(l).scale.v; keys(tr(l).scale, [[at, [0, 0, s[2] ?? 100]], [at + d * 0.7, [s[0] * 1.1, s[1] * 1.1, s[2] ?? 100]], [at + d, [...s]]]); } },
  { id: 'popIn', name: 'Aparecer (pop)', cat: 'Comportamientos', desc: 'Escala con rebote elástico.', apply: ({ l, at, d }) => { const s = tr(l).scale.v; const k = (f: number) => [s[0] * f, s[1] * f, s[2] ?? 100]; keys(tr(l).scale, [[at, k(0)], [at + d * 0.5, k(1.2)], [at + d * 0.72, k(0.93)], [at + d * 0.88, k(1.03)], [at + d, k(1)]]); keys(tr(l).opacity, [[at, 0], [at + d * 0.25, tr(l).opacity.v || 100]]); } },
  { id: 'elasticScale', name: 'Escala elástica (inercia)', cat: 'Comportamientos', desc: 'Llega a su tamaño y oscila hasta asentarse (expresión inertia).', apply: ({ l, at, d }) => { const s = tr(l).scale.v; keys(tr(l).scale, [[at, [0, 0, s[2] ?? 100]], [at + d * 0.6, [...s]]], 'expoOut'); tr(l).scale.x = 'inertia(0.06, 3, 6)'; } },
  { id: 'elasticPosition', name: 'Posición elástica (inercia)', cat: 'Comportamientos', desc: 'Rebote tras cada fotograma clave de posición.', apply: ({ l }) => { tr(l).position.x = 'inertia(0.05, 2.5, 6)'; } },
  { id: 'dropBounce', name: 'Caer y rebotar', cat: 'Comportamientos', desc: 'Cae desde arriba con gravedad y rebota dos veces.',
    apply: ({ c, l, at, d }) => {
      const v = tr(l).position.v;
      const prop = tr(l).position;
      delete prop.k;
      const pts: [number, number, [number, number], [number, number]][] = [
        [0, -c.height * 0.9, [0.5, 0], [0.75, 0.5]], [0.45, 0, [0.25, 0.5], [0.5, 1]], [0.62, -c.height * 0.12, [0.5, 0], [0.75, 0.5]],
        [0.76, 0, [0.25, 0.5], [0.5, 1]], [0.86, -c.height * 0.03, [0.5, 0], [0.75, 0.5]], [0.94, 0, [0.33, 0.33], [0.5, 1]],
      ];
      pts.forEach(([f, dy, eo, ei]) => { const k = setKey(prop, at + d * 1.6 * f, add3(v, 0, dy)); k.i = 'bezier'; k.eo = eo; k.ei = ei; k.sl = true; });
    } },
  { id: 'squashBounce', name: 'Rebote con aplastamiento (squash & stretch)', cat: 'Comportamientos', desc: 'Bota sin parar: cae acelerando, se aplasta contra el suelo (posición actual), se estira al salir y frena arriba. amount = altura del salto (px); duration = un bote.',
    apply: ({ p, c, l, at, d, o }) => {
      const v = [...tr(l).position.v];
      const h = contentHeight(p, c, l, at);
      const up = -(o.amount ?? c.height * 0.4);
      const pos = tr(l).position, sc = tr(l).scale;
      delete pos.k; delete sc.k;
      const sq: [number, number] = [135, 68];
      // the centre drops while squashed so the bottom stays on the floor
      const low = (h / 2) * (1 - sq[1] / 100);
      const P0: [number, number, [number, number] | undefined, [number, number] | undefined][] = [
        [0, up, [0.42, 0], undefined], [0.47, 0, [0.5, 0.5], [1, 1]], [0.5, low, [0.5, 0.5], [0.5, 0.5]], [0.53, 0, [0, 0], [0.5, 0.5]], [1, up, undefined, [0.58, 1]],
      ];
      for (const [f, dy, eo, ei] of P0) { const k = setKey(pos, at + d * f, add3(v, 0, dy)); k.i = 'bezier'; if (eo) k.eo = eo; if (ei) k.ei = ei; k.sl = true; }
      const s0 = sc.v, S = (x: number, y: number) => [s0[0] * x / 100, s0[1] * y / 100, s0[2] ?? 100];
      keys(sc, [[at, S(100, 100)], [at + d * 0.36, S(100, 100)], [at + d * 0.47, S(84, 120)], [at + d * 0.5, S(sq[0], sq[1])], [at + d * 0.56, S(86, 118)], [at + d * 0.72, S(100, 100)], [at + d, S(100, 100)]]);
      pos.x = "loopOut('cycle')";
      sc.x = "loopOut('cycle')";
    } },
  { id: 'rotateIn', name: 'Girar al entrar', cat: 'Comportamientos', desc: 'Rotación −90° → 0 y fundido.', apply: ({ l, at, d }) => { keys(tr(l).rotation, [[at, (tr(l).rotation.v as number) - 90], [at + d, tr(l).rotation.v]], 'expoOut'); keys(tr(l).opacity, [[at, 0], [at + d * 0.6, 100]]); l.motionBlur = true; } },
  { id: 'blurIn', name: 'Enfocar al entrar', cat: 'Comportamientos', desc: 'Desenfoque 60 → 0 y fundido.', apply: ({ p, c, l, at, d }) => { const [w, h] = layerSize(p, c, l); const fx = newFx('gaussianBlur', w, h, { amount: 60 }); keys(fx.params.amount, [[at, 60], [at + d, 0]], 'expoOut'); l.effects.push(fx); keys(tr(l).opacity, [[at, 0], [at + d * 0.5, 100]]); } },
  { id: 'spin', name: 'Girar continuamente', cat: 'Comportamientos', desc: 'Rotación constante (expresión).', apply: ({ l, o }) => { tr(l).rotation.x = `value + time * ${o.amount ?? 90}`; } },
  { id: 'wigglePosition', name: 'Ondulación de posición', cat: 'Comportamientos', desc: 'wiggle() en la posición.', apply: ({ l, o }) => { tr(l).position.x = `wiggle(2, ${o.amount ?? 40})`; } },
  { id: 'wiggleRotation', name: 'Ondulación de rotación', cat: 'Comportamientos', desc: 'wiggle() en la rotación.', apply: ({ l, o }) => { tr(l).rotation.x = `wiggle(3, ${o.amount ?? 10})`; } },
  { id: 'wiggleScale', name: 'Ondulación de escala', cat: 'Comportamientos', desc: 'Escala que respira de forma orgánica.', apply: ({ l, o }) => { tr(l).scale.x = `var w = wiggle(1.5, ${o.amount ?? 8}); [w[0], w[0], value[2]]`; } },
  { id: 'pulse', name: 'Latido', cat: 'Comportamientos', desc: 'Escala que pulsa a ritmo.', apply: ({ l, o }) => { tr(l).scale.x = `var d = Math.pow(Math.max(0, Math.sin(time * Math.PI * 2 * ${o.amount ?? 1.2})), 8) * 12; add(value, [d, d, 0])`; } },
  { id: 'blink', name: 'Parpadeo', cat: 'Comportamientos', desc: 'Opacidad intermitente.', apply: ({ l, o }) => { tr(l).opacity.x = `Math.sin(time * Math.PI * 2 * ${o.amount ?? 2}) > 0 ? value : 0`; } },
  { id: 'float', name: 'Flotar', cat: 'Comportamientos', desc: 'Sube y baja suavemente.', apply: ({ l, o }) => { tr(l).position.x = `add(value, [0, Math.sin(time * Math.PI * 2 * 0.4) * ${o.amount ?? 20}, 0])`; tr(l).rotation.x = 'value + Math.sin(time * Math.PI * 2 * 0.27) * 2'; } },
  { id: 'shake', name: 'Temblor de cámara', cat: 'Comportamientos', desc: 'Sacudida rápida (wiggle de alta frecuencia).', apply: ({ l, o }) => { tr(l).position.x = `wiggle(14, ${o.amount ?? 18}, 2)`; tr(l).rotation.x = 'wiggle(10, 1.2)'; l.motionBlur = true; } },
  { id: 'swing', name: 'Péndulo', cat: 'Comportamientos', desc: 'Oscila y se detiene (amortiguado).', apply: ({ l, o }) => { tr(l).rotation.x = `value + ${o.amount ?? 25} * Math.sin((time - inPoint) * Math.PI * 2 * 1.2) * Math.exp(-1.2 * (time - inPoint))`; } },
  { id: 'autoScroll', name: 'Desplazamiento automático', cat: 'Comportamientos', desc: 'Avanza a velocidad constante (créditos, cintas).', apply: ({ l, o }) => { tr(l).position.x = `add(value, [0, -time * ${o.amount ?? 80}, 0])`; } },
  { id: 'kenBurns', name: 'Panorámica lenta (Ken Burns)', cat: 'Comportamientos', desc: 'Zoom y desplazamiento lentos durante toda la capa.', apply: ({ l }) => { const s = tr(l).scale.v, v = tr(l).position.v; keys(tr(l).scale, [[l.in, [...s]], [l.out, [s[0] * 1.15, s[1] * 1.15, s[2] ?? 100]]], 'linear'); keys(tr(l).position, [[l.in, [...v]], [l.out, add3(v, -60, -30)]], 'linear'); } },

  // ───────────── texto ─────────────
  { id: 'typewriter', name: 'Máquina de escribir', cat: 'Texto', text: true, desc: 'Los caracteres aparecen uno a uno.', apply: ({ l, at, d }) => { const an = animator(l, 'Máquina de escribir', { opacity: P(0) }, { shape: 'square' }); const s = an.selectors[0] as { start: Prop }; keys(s.start, [[at, 0], [at + d, 100]], 'linear'); } },
  { id: 'fadeUpChars', name: 'Subir y aparecer por caracteres', cat: 'Texto', text: true, desc: 'Cada carácter sube y aparece en cascada.', apply: ({ l, at, d }) => sweep(animator(l, 'Subir y aparecer', { position: P([0, 60]), opacity: P(0) }, { shape: 'rampUp' }), at, d, 35, 'easy') },
  { id: 'dropChars', name: 'Caída de caracteres', cat: 'Texto', text: true, desc: 'Los caracteres caen girando a su sitio.', apply: ({ l, at, d }) => sweep(animator(l, 'Caída', { position: P([0, -260]), rotation: P(-40), opacity: P(0) }, { shape: 'rampUp' }), at, d, 25, 'easy') },
  { id: 'blurInWords', name: 'Enfocar por palabras', cat: 'Texto', text: true, desc: 'Cada palabra pasa de desenfocada a nítida.', apply: ({ l, at, d }) => sweep(animator(l, 'Enfocar palabras', { blur: P(40), opacity: P(0), scale: P([130, 130]) }, { shape: 'rampUp', basedOn: 'words' }), at, d, 40, 'easy') },
  { id: 'scaleChars', name: 'Escala por caracteres', cat: 'Texto', text: true, desc: 'Cada carácter crece desde cero.', apply: ({ l, at, d }) => sweep(animator(l, 'Escala', { scale: P([0, 0]), opacity: P(0) }, { shape: 'rampUp' }), at, d, 30, 'easy') },
  { id: 'decode', name: 'Decodificar', cat: 'Texto', text: true, desc: 'Caracteres aleatorios que se resuelven en el texto.', apply: ({ l, at, d }) => { const an = animator(l, 'Decodificar', { charOffset: P(30), opacity: P(40) }, { shape: 'rampUp', randomize: true, seed: 7 }); an.props.charOffset!.x = 'wiggle(14, 20)'; sweep(an, at, d, 30, 'linear'); } },
  { id: 'trackingIn', name: 'Interletraje que se cierra', cat: 'Texto', text: true, desc: 'Las letras se juntan desde muy separadas.', apply: ({ l, at, d }) => { keys(l.text!.tracking, [[at, 600], [at + d, l.text!.tracking.v as number]], 'expoOut'); keys(tr(l).opacity, [[at, 0], [at + d * 0.5, 100]]); } },
  { id: 'wave', name: 'Ola', cat: 'Texto', text: true, desc: 'Una ola recorre el texto sin parar.', apply: ({ l }) => { const an = animator(l, 'Ola', { position: P([0, -40]) }, { shape: 'smooth', start: 0, end: 30 }); (an.selectors[0] as { offset: Prop }).offset.x = '((time * 60) % 160) - 30'; } },
  { id: 'spinChars', name: 'Giro por caracteres', cat: 'Texto', text: true, desc: 'Cada carácter da una vuelta al entrar.', apply: ({ l, at, d }) => sweep(animator(l, 'Giro', { rotation: P(360), scale: P([0, 0]), opacity: P(0) }, { shape: 'rampUp' }), at, d, 30, 'easy') },
  { id: 'flipChars', name: 'Volteo 3D por caracteres', cat: 'Texto', text: true, desc: 'Cada carácter gira sobre su eje vertical.', apply: ({ l, at, d }) => sweep(animator(l, 'Volteo', { rotationY: P(90), opacity: P(0) }, { shape: 'rampUp' }), at, d, 30, 'easy') },
  { id: 'randomFade', name: 'Aparición aleatoria', cat: 'Texto', text: true, desc: 'Los caracteres aparecen en orden aleatorio.', apply: ({ l, at, d }) => { const an = animator(l, 'Aleatorio', { opacity: P(0) }, { shape: 'square', randomize: true, seed: 3 }); keys((an.selectors[0] as { start: Prop }).start, [[at, 0], [at + d, 100]], 'linear'); } },
  { id: 'slideLines', name: 'Deslizar por líneas', cat: 'Texto', text: true, desc: 'Cada línea entra desde la izquierda.', apply: ({ l, at, d }) => sweep(animator(l, 'Líneas', { position: P([-300, 0]), opacity: P(0) }, { shape: 'rampUp', basedOn: 'lines' }), at, d, 50, 'easy') },
  { id: 'glitchText', name: 'Texto con fallos', cat: 'Texto', text: true, desc: 'Sacudidas y caracteres que fallan (continuo).', apply: ({ l }) => { animator(l, 'Fallo', { charOffset: P(6), position: P([14, 0]) }, { type: 'wiggly', speed: 6, correlation: 0, minAmount: -100, maxAmount: 100, mode: 'add' }); } },
  { id: 'colorSweep', name: 'Barrido de color', cat: 'Texto', text: true, desc: 'Un brillo de color recorre el texto.', apply: ({ l, at, d, o }) => { const an = animator(l, 'Barrido de color', { fill: P(o.color ?? '#ffd400'), scale: P([112, 112]) }, { shape: 'smooth' }); sweep(an, at, d, 30, 'linear'); } },
  { id: 'outFadeDown', name: 'Salida: bajar y desvanecer', cat: 'Texto', text: true, out: true, desc: 'Los caracteres bajan y desaparecen en cascada.', apply: ({ l, at, d }) => sweep(animator(l, 'Salida', { position: P([0, 60]), opacity: P(0) }, { shape: 'rampDown' }), at, d, 35, 'easy', true) },
  { id: 'outBlurWords', name: 'Salida: desenfocar por palabras', cat: 'Texto', text: true, out: true, desc: 'Cada palabra se desenfoca y desaparece.', apply: ({ l, at, d }) => sweep(animator(l, 'Salida desenfoque', { blur: P(40), opacity: P(0) }, { shape: 'rampDown', basedOn: 'words' }), at, d, 40, 'easy', true) },

  // ───────────── transiciones (sobre la capa) ─────────────
  ...([['linearWipe', 'Barrido lineal'], ['radialWipe', 'Barrido de reloj'], ['iris', 'Iris'], ['venetianBlinds', 'Persianas venecianas'], ['blockDissolve', 'Disolución en bloques']] as const).flatMap(([fx, name]): PresetDef[] => [
    { id: `${fx}In`, name: `${name} (entrada)`, cat: 'Transiciones', desc: `Revela la capa con ${name.toLowerCase()}.`, apply: ({ p, c, l, at, d }) => { const [w, h] = layerSize(p, c, l); const f = newFx(fx, w, h, fx === 'linearWipe' || fx === 'iris' ? { feather: 60 } : {}); if (fx === 'iris') keys(f.params.outerRadius, [[at, 0], [at + d, Math.hypot(w, h) / 2 + 60]], 'easy'); else keys(f.params.completion, [[at, 100], [at + d, 0]], 'easy'); l.effects.push(f); } },
    { id: `${fx}Out`, name: `${name} (salida)`, cat: 'Transiciones', out: true, desc: `Oculta la capa con ${name.toLowerCase()}.`, apply: ({ p, c, l, at, d }) => { const [w, h] = layerSize(p, c, l); const f = newFx(fx, w, h, fx === 'linearWipe' || fx === 'iris' ? { feather: 60 } : {}); if (fx === 'iris') keys(f.params.outerRadius, [[at, Math.hypot(w, h) / 2 + 60], [at + d, 0]], 'easy'); else keys(f.params.completion, [[at, 0], [at + d, 100]], 'easy'); l.effects.push(f); } },
  ]),

  // ───────────── fondos (crean una capa) ─────────────
  { id: 'bgGradient', name: 'Degradado animado', cat: 'Fondos', makesLayer: true, desc: 'Degradado de dos colores que se mueve lentamente.', apply: ({ c, l, o }) => { const [a, b] = o.colors ?? ['#1d6cff', '#6c5ce7']; const f = newFx('gradientRamp', c.width, c.height, { type: 'radial', startColor: a, endColor: b, start: [c.width * 0.3, c.height * 0.3], end: [c.width, c.height] }); f.params.start.x = `add(value, [Math.sin(time * 0.6) * ${Math.round(c.width * 0.2)}, Math.cos(time * 0.45) * ${Math.round(c.height * 0.2)}])`; l.effects.push(f); l.name = 'Fondo degradado'; } },
  { id: 'bgParticles', top: true, name: 'Partículas flotantes', cat: 'Fondos', makesLayer: true, desc: 'Destellos que suben despacio (bokeh).', apply: ({ c, l, o }) => { l.solid!.color = '#00000000'; l.effects.push(newFx('particles', c.width, c.height, { position: [c.width / 2, c.height * 1.05], radiusX: c.width / 2, radiusY: 10, rate: 25, life: 7, velocity: 120, direction: 0, spread: 25, gravity: -10, size: 14, sizeVar: 80, colorStart: o.color ?? '#ffd27a', colorEnd: '#ff8a3d', shape: 'glow', warmup: 7 })); l.blend = 'screen'; l.name = 'Partículas'; } },
  { id: 'bgNoise', name: 'Nubes de ruido fractal', cat: 'Fondos', makesLayer: true, desc: 'Ruido fractal que evoluciona, coloreado.', apply: ({ c, l, o }) => { const [a, b] = o.colors ?? ['#0b1a3a', '#36c48f']; const n = newFx('fractalNoise', c.width, c.height, { scale: 400, complexity: 5 }); n.params.evolution.x = 'time * 40'; l.effects.push(n, newFx('tint', c.width, c.height, { black: a, white: b })); l.name = 'Ruido fractal'; } },
  { id: 'bgGrid', name: 'Cuadrícula en movimiento', cat: 'Fondos', makesLayer: true, desc: 'Rejilla técnica que se desplaza.', apply: ({ c, l, o }) => { l.solid!.color = o.color ?? '#0d1117'; const g = newFx('grid', c.width, c.height, { sizeFrom: 'width', size: 80, width: 1, color: '#2f81f7', opacity: 40, blendMode: 'normal' }); g.params.anchor.x = '[time * 40, time * 20]'; l.effects.push(g, newFx('vignette', c.width, c.height, { amount: 70 })); l.name = 'Cuadrícula'; } },
  { id: 'bgSnow', top: true, name: 'Nieve', cat: 'Fondos', makesLayer: true, desc: 'Copos que caen con viento.', apply: ({ c, l }) => { l.solid!.color = '#00000000'; l.effects.push(newFx('snow', c.width, c.height, {})); l.name = 'Nieve'; } },
  { id: 'bgRain', top: true, name: 'Lluvia', cat: 'Fondos', makesLayer: true, desc: 'Lluvia inclinada.', apply: ({ c, l }) => { l.solid!.color = '#00000000'; l.effects.push(newFx('rain', c.width, c.height, {})); l.name = 'Lluvia'; } },
  { id: 'lightLeak', top: true, name: 'Fugas de luz', cat: 'Fondos', makesLayer: true, desc: 'Manchas de luz cálida que se mueven (modo Trama).', apply: ({ c, l }) => { l.solid!.color = '#00000000'; const a = newFx('circle', c.width, c.height, { radius: c.width * 0.35, feather: c.width * 0.3, color: '#ff7a1a', opacity: 70 }); a.params.center.x = `[${c.width * 0.2} + Math.sin(time * 0.7) * ${c.width * 0.25}, ${c.height * 0.3} + Math.cos(time * 0.5) * ${c.height * 0.2}]`; const b = newFx('circle', c.width, c.height, { radius: c.width * 0.25, feather: c.width * 0.25, color: '#ff2f6d', opacity: 55 }); b.params.center.x = `[${c.width * 0.8} + Math.cos(time * 0.6) * ${c.width * 0.2}, ${c.height * 0.7} + Math.sin(time * 0.8) * ${c.height * 0.2}]`; l.effects.push(a, b); l.blend = 'screen'; l.name = 'Fugas de luz'; } },

  // ───────────── cámara ─────────────
  { id: 'cameraPush', name: 'Cámara: acercamiento 3D', cat: 'Cámara', makesLayer: true, desc: 'Añade una cámara que avanza; las capas pasan a 3D (con profundidad). amount = intensidad (1 = 15 %).', apply: ({ c, l, at, d, o }) => {
    const z = l.transform.position.v[2];
    keys(l.transform.position, [[at, [c.width / 2, c.height / 2, z]], [at + d, [c.width / 2, c.height / 2, z * (1 - 0.15 * (o.amount ?? 1))]]], 'easy');
    for (const o of c.layers) if (o !== l && o.type !== 'adjustment' && o.type !== 'audio' && o.type !== 'camera') o.threeD = true;
  } },
  { id: 'cameraOrbit', name: 'Cámara: órbita', cat: 'Cámara', makesLayer: true, desc: 'La cámara gira alrededor del centro; las capas pasan a 3D.', apply: ({ c, l, o }) => {
    const r = -l.transform.position.v[2];
    l.transform.position.x = `var a = Math.sin(time * 0.5) * ${o.amount ?? 25} * Math.PI / 180; [${c.width / 2} + Math.sin(a) * ${r}, ${c.height / 2}, -Math.cos(a) * ${r}]`;
    for (const x of c.layers) if (x !== l && x.type !== 'adjustment' && x.type !== 'audio' && x.type !== 'camera') x.threeD = true;
  } },
];

export function presetDef(id: string): PresetDef {
  const d = PRESETS.find((p) => p.id === id || p.name.toLowerCase() === id.toLowerCase());
  if (!d) throw new Error(`No existe el ajuste preestablecido «${id}». Use catalog_list con kind motion_presets.`);
  return d;
}

/** Applies a preset to layers (or creates the layer for backgrounds/cameras). Returns the affected layer ids. */
export function presetApply(e: Editor, compId: string, presetId: string, layerIds: string[], o: Opts = {}): string[] {
  const def = presetDef(presetId);
  return e.mutate(`Ajuste preestablecido: ${def.name}`, (p) => {
    const c = findComp(comps(p), compId);
    const d = Math.max(1 / c.fps, o.duration ?? (def.cat === 'Texto' ? 1.5 : 0.8));
    if (def.makesLayer) {
      const type = def.cat === 'Cámara' ? 'camera' : 'solid';
      const l = newLayer(type, c, {});
      if (type === 'solid' && !def.top) c.layers.push(l); else c.layers.unshift(l);
      def.apply({ p, c, l, at: o.at ?? 0, d, o });
      return [l.id];
    }
    if (!layerIds.length) throw new Error('Indique las capas.');
    return layerIds.map((id) => {
      const l = findLayer(c, id);
      if (def.text && !l.text) throw new Error(`«${def.name}» es para capas de texto y «${l.name}» no lo es.`);
      const at = o.at ?? (def.out ? l.out - d : l.in);
      def.apply({ p, c, l, at, d, o });
      return l.id;
    });
  });
}

// ───────────────────────── starter compositions ─────────────────────────
export interface TemplateDef { id: string; name: string; desc: string; build: (e: Editor, o?: { name?: string }) => Comp }
const settingsOf = (e: Editor) => e.project.settings;
export const TEMPLATES: TemplateDef[] = [
  { id: 'kinetic', name: 'Título cinético', desc: 'Fondo degradado con partículas, título que cae letra a letra con resplandor y subtítulo.', build: (e, o = {}) => {
    const s = settingsOf(e);
    const c = motionOps.compNew(e, { name: o.name ?? 'Título cinético', width: s.width, height: s.height, fps: s.fps, duration: 6, bg: '#0b0f1a' });
    presetApply(e, c.id, 'bgGradient', [], { colors: ['#0b1a3a', '#341a6e'] });
    presetApply(e, c.id, 'bgParticles', [], {});
    const t = motionOps.layerAdd(e, c.id, 'text', { text: 'TU TÍTULO', size: Math.round(c.height / 7) });
    presetApply(e, c.id, 'dropChars', [t.id], { at: 0.3, duration: 1.2 });
    presetApply(e, c.id, 'outBlurWords', [t.id], {});
    motionOps.effectAdd(e, c.id, t.id, 'glow', { radius: 40, threshold: 50, intensity: 1 });
    motionOps.effectAdd(e, c.id, t.id, 'dropShadow', { distance: 12, softness: 20, opacity: 60 });
    const sub = motionOps.layerAdd(e, c.id, 'text', { text: 'Subtítulo de la escena', size: Math.round(c.height / 22), position: [c.width / 2, c.height * 0.64] });
    presetApply(e, c.id, 'fadeUpChars', [sub.id], { at: 1.2, duration: 1 });
    presetApply(e, c.id, 'fadeOut', [sub.id], {});
    return findComp(e.project.comps, c.id);
  } },
  { id: 'lowerthird', name: 'Rótulo inferior', desc: 'Barra que se despliega, acento de color y nombre (fondo transparente).', build: (e, o = {}) => {
    const s = settingsOf(e);
    const c = motionOps.compNew(e, { name: o.name ?? 'Rótulo inferior', width: s.width, height: s.height, fps: s.fps, duration: 5, transparent: true });
    const W = c.width, H = c.height;
    const bar = motionOps.shapeAdd(e, c.id, undefined, { kind: 'rect', width: W * 0.36, height: H * 0.075, color: '#1d6cff', position: [-W * 0.25, H * 0.32], name: 'Barra' });
    motionOps.propSet(e, c.id, bar.layer.id, `shapes.${bar.shape.id}.size`, { keys: [{ t: 0, v: [0, H * 0.075], ease: 'easy' }, { t: 0.6, v: [W * 0.36, H * 0.075], ease: 'easy' }, { t: 4.2, v: [W * 0.36, H * 0.075], ease: 'easy' }, { t: 4.8, v: [0, H * 0.075], ease: 'easy' }] });
    motionOps.layerSet(e, c.id, bar.layer.id, { name: 'Barra' });
    const acc = motionOps.shapeAdd(e, c.id, undefined, { kind: 'rect', width: 12, height: H * 0.075, color: '#ffd400', position: [-W * 0.43, H * 0.32], name: 'Acento' });
    motionOps.layerSet(e, c.id, acc.layer.id, { name: 'Acento' });
    presetApply(e, c.id, 'fadeIn', [acc.layer.id], { at: 0.4, duration: 0.3 });
    const t = motionOps.layerAdd(e, c.id, 'text', { text: 'Nombre Apellido', size: Math.round(H / 24), position: [W * 0.1, H * 0.83], color: '#ffffff' });
    motionOps.layerSet(e, c.id, t.id, { text: { align: 'left' } });
    presetApply(e, c.id, 'fadeUpChars', [t.id], { at: 0.4, duration: 0.8 });
    presetApply(e, c.id, 'fadeOut', [t.id], { duration: 0.4 });
    return findComp(e.project.comps, c.id);
  } },
  { id: 'logo3d', name: 'Logo 3D con cámara', desc: 'Estrella que gira en 3D, marca que se junta y cámara que avanza sobre nubes de ruido.', build: (e, o = {}) => {
    const s = settingsOf(e);
    const c = motionOps.compNew(e, { name: o.name ?? 'Logo 3D', width: s.width, height: s.height, fps: s.fps, duration: 6, bg: '#05070c' });
    presetApply(e, c.id, 'bgNoise', [], { colors: ['#05070c', '#1b2b55'] });
    const star = motionOps.shapeAdd(e, c.id, undefined, { kind: 'star', width: c.height * 0.3, color: '#ffd400', stroke: '#ffffff', strokeWidth: 6, trim: { end: 100 } });
    motionOps.propSet(e, c.id, star.layer.id, 'rotationY', { keys: [{ t: 0, v: -80, ease: 'easy' }, { t: 2, v: 0, ease: 'easy' }] });
    motionOps.effectAdd(e, c.id, star.layer.id, 'glow', { radius: 50 });
    const t = motionOps.layerAdd(e, c.id, 'text', { text: 'MARCA', size: Math.round(c.height / 8), position: [c.width / 2, c.height * 0.78] });
    presetApply(e, c.id, 'trackingIn', [t.id], { at: 1, duration: 1.5 });
    presetApply(e, c.id, 'cameraPush', [], { at: 0, duration: 6 });
    return findComp(e.project.comps, c.id);
  } },
];
/** Builds a starter composition (one undo step). */
export function templateBuild(e: Editor, id: string, o: { name?: string } = {}): Comp {
  const t = TEMPLATES.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!t) throw new Error(`No existe la plantilla «${id}». Hay: ${TEMPLATES.map((x) => x.id).join(', ')}.`);
  return t.build(e, o);
}

/** Visible height of a layer's content: the shapes' outlines on shape layers (whose layer size is the comp's). */
function contentHeight(p: Project, c: Comp, l: Layer, t: number): number {
  if (l.type !== 'shape' || !l.shapes?.length) return layerSize(p, c, l)[1] || 100;
  let y0 = Infinity, y1 = -Infinity;
  for (const s of l.shapes) {
    const [, a, , b] = outlineBounds(shapeOutline(c, l, s, t).pts);
    const sy = Math.abs(Number((s.transform.scale.v as number[])[1] ?? 100)) / 100, py = Number((s.transform.position.v as number[])[1] ?? 0);
    y0 = Math.min(y0, py + a * sy); y1 = Math.max(y1, py + b * sy);
  }
  return Number.isFinite(y1 - y0) && y1 > y0 ? y1 - y0 : 100;
}
