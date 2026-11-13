// Effects of the «particulas» line (see fx-groups/index.ts): Particle Playground, the classic CycoreFX particle
// systems and the legacy text / paint effects. Names, defaults, ranges and choices follow each After Effects 2024
// effect (Spanish names from AE's Spanish interface). The drawing is in
// src/motion-render/fx-groups/particulas.ts; the simulation and stroke logic below is pure so it can be unit-tested.
import type { FxDef, ParamDef } from '../effects';
import { n, pc, an, co, pt, bo, ly, tx, ch } from '../fxparams';

// ───────────────────────── CC PS Classic / CC PS LE Classic ─────────────────────────

/** CC PS Classic's animations (ParticleSystems: 18 with one separator) */
export const PS_CLASSIC_ANIM: [string, string][] = [['explosive', 'Explosivo'], ['sideways', 'Lateral'], ['fire', 'Fuego'], ['bonfire', 'Hoguera'], ['twirl', 'Remolino'], ['fountain', 'Fuente'], ['viscouse', 'Viscoso'], ['scatterize', 'Dispersar'], ['sparkle', 'Destello'], ['vortexy', 'Vorticial'], ['rainDrops', 'Gotas de lluvia'], ['starLight', 'Luz de estrella'], ['smokish', 'Humeante'], ['bubbly', 'Burbujeante'], ['bally', 'Bolas'], ['wateryDrops', 'Gotas de agua'], ['experimental', 'Experimental']];
/** CC PS LE Classic's animations (ParticleSystemsLE: 22 with one separator) */
export const PS_LE_ANIM: [string, string][] = [['explosive', 'Explosivo'], ['sideways', 'Lateral'], ['fire', 'Fuego'], ['bonfire', 'Hoguera'], ['twirl', 'Remolino'], ['fountain', 'Fuente'], ['viscouse', 'Viscoso'], ['scatterize', 'Dispersar'], ['sparkle', 'Destello'], ['fractalExplosion', 'Explosión fractal'], ['vortexy', 'Vorticial'], ['jet', 'Chorro'], ['jetSideways', 'Chorro lateral'], ['starLight', 'Luz de estrella'], ['bally', 'Bolas'], ['smokish', 'Humeante'], ['bubblish', 'Burbujeante'], ['fireFly', 'Luciérnaga'], ['wateryDrops', 'Gotas de agua'], ['experimental', 'Experimental'], ['experimental2', 'Experimental 2']];

/** What each classic animation means in CC Particle Systems II's terms (the newer plug-in grew out of these presets):
 * its physics animation, particle type, sizes, opacity map and gravity / resistance factors */
export interface PsPreset { animation: string; particleType: string; birthSize: number; deathSize: number; opacityMap: string; grav: number; resistance: number; colorMap?: string; dir?: number }
export const PS_PRESETS: Record<string, PsPreset> = {
  explosive: { animation: 'explosive', particleType: 'line', birthSize: 0.15, deathSize: 0.4, opacityMap: 'fadeOut', grav: 1, resistance: 0 },
  sideways: { animation: 'jetSideways', particleType: 'line', birthSize: 0.15, deathSize: 0.4, opacityMap: 'fadeOut', grav: 1, resistance: 0 },
  fire: { animation: 'fire', particleType: 'fadedSphere', birthSize: 0.6, deathSize: 1.2, opacityMap: 'fadeOut', grav: 1, resistance: 0 },
  bonfire: { animation: 'fire', particleType: 'shadedFadedSphere', birthSize: 1, deathSize: 2, opacityMap: 'fadeInOut', grav: 1.5, resistance: 0 },
  twirl: { animation: 'twirl', particleType: 'line', birthSize: 0.15, deathSize: 0.4, opacityMap: 'fadeOut', grav: 0.3, resistance: 0 },
  fountain: { animation: 'direction', particleType: 'line', birthSize: 0.15, deathSize: 0.3, opacityMap: 'fadeOutSharp', grav: 2, resistance: 0, dir: 0 },
  viscouse: { animation: 'explosive', particleType: 'fadedSphere', birthSize: 0.5, deathSize: 1, opacityMap: 'fadeOut', grav: 1, resistance: 30 },
  scatterize: { animation: 'explosive', particleType: 'texturedQuad', birthSize: 0.3, deathSize: 0.3, opacityMap: 'fadeOutSharp', grav: 0.5, resistance: 0, colorMap: 'originConstant' },
  sparkle: { animation: 'explosive', particleType: 'star', birthSize: 0.3, deathSize: 0.1, opacityMap: 'oscillate', grav: 0.5, resistance: 5 },
  fractalExplosion: { animation: 'fractalExplosive', particleType: 'line', birthSize: 0.15, deathSize: 0.4, opacityMap: 'fadeOut', grav: 1, resistance: 0 },
  vortexy: { animation: 'vortex', particleType: 'fadedSphere', birthSize: 0.3, deathSize: 0.6, opacityMap: 'fadeOut', grav: 0, resistance: 0 },
  jet: { animation: 'jet', particleType: 'line', birthSize: 0.15, deathSize: 0.4, opacityMap: 'fadeOut', grav: 1, resistance: 0 },
  jetSideways: { animation: 'jetSideways', particleType: 'line', birthSize: 0.15, deathSize: 0.4, opacityMap: 'fadeOut', grav: 1, resistance: 0 },
  rainDrops: { animation: 'direction', particleType: 'line', birthSize: 0.1, deathSize: 0.1, opacityMap: 'constant', grav: 2, resistance: 0, dir: 180 },
  starLight: { animation: 'explosive', particleType: 'star', birthSize: 0.4, deathSize: 0.15, opacityMap: 'fadeOut', grav: 0.3, resistance: 3 },
  smokish: { animation: 'fire', particleType: 'fadedSphere', birthSize: 1, deathSize: 3, opacityMap: 'fadeInOut', grav: 0.4, resistance: 10 },
  bubbly: { animation: 'fire', particleType: 'bubble', birthSize: 0.4, deathSize: 0.8, opacityMap: 'constant', grav: 0.5, resistance: 5 },
  bubblish: { animation: 'fire', particleType: 'bubble', birthSize: 0.4, deathSize: 0.8, opacityMap: 'constant', grav: 0.5, resistance: 5 },
  bally: { animation: 'explosive', particleType: 'shadedSphere', birthSize: 0.4, deathSize: 0.4, opacityMap: 'fadeOutSharp', grav: 1, resistance: 0 },
  fireFly: { animation: 'fractalExplosive', particleType: 'fadedSphere', birthSize: 0.3, deathSize: 0.3, opacityMap: 'oscillate', grav: 0, resistance: 20 },
  wateryDrops: { animation: 'explosive', particleType: 'shadedSphere', birthSize: 0.2, deathSize: 0.25, opacityMap: 'constant', grav: 2, resistance: 0 },
  experimental: { animation: 'fractalExplosive', particleType: 'motionPolygon', birthSize: 0.3, deathSize: 0.6, opacityMap: 'fadeOut', grav: 1, resistance: 0 },
  experimental2: { animation: 'twirly', particleType: 'quadPolygon', birthSize: 0.3, deathSize: 0.6, opacityMap: 'fadeInOut', grav: 0.5, resistance: 0 },
};

/** CC PS Classic / LE → CC Particle Systems II parameters (the shared emitter draws them). Turbulence works as PS II's
 * Extra; Classic is born from the layer's alpha (radius 0, the renderer moves the producer), LE from its ellipse. */
export function psClassicToII(p: Record<string, unknown>, le: boolean): Record<string, unknown> {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const pr = PS_PRESETS[String(p.animation ?? (le ? 'fractalExplosion' : 'starLight'))] ?? PS_PRESETS.explosive;
  return {
    birthRate: num(p.birthRate, le ? 5 : 10), longevity: num(p.longevity, 1), position: le ? p.producer : [0, 0],
    radiusX: le ? num(p.radiusX, 4) : 0, radiusY: le ? num(p.radiusY, 4) : 0, animation: pr.animation,
    velocity: num(p.velocity, 1), inheritVelocity: 0, gravity: num(p.gravity, 1) * pr.grav, resistance: pr.resistance,
    direction: pr.dir ?? 0, extra: num(p.turbulence, 1), particleType: pr.particleType, birthSize: pr.birthSize, deathSize: pr.deathSize,
    sizeVariation: 50, opacityMap: pr.opacityMap, maxOpacity: num(p.maxOpacity, 75), sourceAlpha: 0, colorMap: pr.colorMap ?? 'birthDeath',
    birthColor: p.birthColor ?? '#f0f010', deathColor: p.deathColor ?? (le ? '#c81010' : '#20f010'), transfer: 'composite', seed: 0,
  };
}

// ───────────────────────── Basic Text / Path Text ─────────────────────────

/** Display Options / Options of the legacy text effects (Basic_Text, Path_Text: 4, Fill Only) */
export const TXT_DISPLAY: [string, string][] = [['fill', 'Sólo relleno'], ['stroke', 'Sólo trazo'], ['fillOverStroke', 'Relleno sobre trazo'], ['strokeOverFill', 'Trazo sobre relleno']];
/** the «Edit Text…» dialog of the legacy text effects, as parameters: text, font family and style */
const TXT_EDIT = (def: string, extra: ParamDef[] = []): ParamDef[] => [tx('text', 'Editar texto: texto', def), tx('font', 'Editar texto: fuente', 'Arial'), ch('fontStyle', 'Editar texto: estilo', [['regular', 'Normal'], ['bold', 'Negrita'], ['italic', 'Cursiva'], ['boldItalic', 'Negrita cursiva']]), ...extra];

// ───────────────────────── Vector Paint ─────────────────────────

/** Vector Paint's Playback Mode (VectorPaint, 6; default Current Frame) */
export const VP_PLAYBACK: [string, string][] = [['all', 'Todos los trazos'], ['past', 'Trazos anteriores'], ['hold', 'Mantener trazos'], ['animate', 'Animar trazos'], ['current', 'Fotograma actual'], ['onion', 'Piel de cebolla']];
/** Vector Paint's Composite Paint (14 with four separators; default In Original) */
export const VP_COMPOSITE: [string, string][] = [['only', 'Sólo'], ['inOriginal', 'En el original'], ['overOriginal', 'Sobre el original'], ['underOriginal', 'Debajo del original'], ['trackMatte', 'Seguir máscara original'], ['trackMatteVisible', 'Seguir máscara original visible'], ['asMatte', 'Como máscara'], ['asInverseMatte', 'Como máscara inversa'], ['inAlpha', 'Sólo en el alfa original'], ['underAlpha', 'Sólo debajo del alfa original']];

/** One Vector Paint stroke as stored in the effect («strokes», JSON): painted at layer time t, colour, radius (px),
 * feather and opacity (%), erase; points x, y in layer px with the seconds since the stroke began */
export interface VpStroke { t: number; c: string; r: number; f: number; o: number; e?: boolean; pts: [number, number, number][] }

/** The strokes of a «strokes» text: [{ t, c|color, r|radius, f|feather, o|opacity, e|erase, p|points: [[x, y, dt?]…] or
 * [x, y, x, y…] }]; missing brush values come from the effect's brush settings. Bad entries are skipped. */
export function vpParse(txt: unknown, brush: { c: string; r: number; f: number; o: number } = { c: '#ffffff', r: 8, f: 50, o: 100 }): VpStroke[] {
  let raw: unknown;
  try { raw = typeof txt === 'string' ? (txt.trim() ? JSON.parse(txt) : []) : txt; } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const out: VpStroke[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>, P = (o.p ?? o.points) as unknown;
    if (!Array.isArray(P)) continue;
    const pts: [number, number, number][] = [];
    if (P.length && typeof P[0] === 'number') { for (let i = 0; i + 1 < P.length; i += 2) pts.push([fin(P[i], 0), fin(P[i + 1], 0), 0]); }
    else for (const q of P) if (Array.isArray(q) && q.length >= 2) pts.push([fin(q[0], 0), fin(q[1], 0), Math.max(0, fin(q[2], 0))]);
    if (!pts.length) continue;
    out.push({ t: fin(o.t ?? o.time, 0), c: String(o.c ?? o.color ?? brush.c), r: Math.max(0, fin(o.r ?? o.radius, brush.r)), f: Math.max(0, Math.min(100, fin(o.f ?? o.feather, brush.f))), o: Math.max(0, Math.min(100, fin(o.o ?? o.opacity, brush.o))), e: !!(o.e ?? o.erase), pts });
  }
  return out;
}

/** Which strokes Vector Paint shows at layer time t (Playback Mode): each with how much of it is drawn (seconds of its
 * recording, Infinity = all), an opacity factor and, for Onion Skin, a tint ('back' / 'fwd') */
export function vpVisible(strokes: VpStroke[], mode: string, t: number, fps: number, speed = 1): { s: VpStroke; upto: number; k: number; tint?: 'back' | 'fwd' }[] {
  const fr = (v: number) => Math.floor(v * fps + 1e-4), now = fr(t), out: { s: VpStroke; upto: number; k: number; tint?: 'back' | 'fwd' }[] = [];
  if (mode === 'all') return strokes.map((s) => ({ s, upto: Infinity, k: 1 }));
  if (mode === 'hold') {
    // the strokes of the last painted frame at or before now stay until the next painted frame
    let last = -Infinity; for (const s of strokes) if (fr(s.t) <= now) last = Math.max(last, fr(s.t));
    return strokes.filter((s) => fr(s.t) === last).map((s) => ({ s, upto: Infinity, k: 1 }));
  }
  if (mode === 'current') return strokes.filter((s) => fr(s.t) === now).map((s) => ({ s, upto: Infinity, k: 1 }));
  if (mode === 'onion') {
    // the current frame, and three frames each way fading out, tinted (After Effects' onion skin preferences)
    for (const s of strokes) { const d = fr(s.t) - now; if (d === 0) out.push({ s, upto: Infinity, k: 1 }); else if (Math.abs(d) <= 3) out.push({ s, upto: Infinity, k: 0.5 * (1 - (Math.abs(d) - 1) / 3), tint: d < 0 ? 'back' : 'fwd' }); }
    return out;
  }
  for (const s of strokes) {
    if (fr(s.t) > now) continue;
    // Animate Strokes: replayed as painted, Playback Speed times as fast, from the moment it was painted
    out.push({ s, upto: mode === 'animate' ? (t - s.t) * Math.abs(speed || 1) : Infinity, k: 1 });
  }
  return out;
}

/** Path Text's path as a polyline (flat x, y…): Bézier through Vertex 1, Tangent 1, Tangent 2, Vertex 2; Circle and
 * Loop around Vertex 1 / Circle Center through Tangent 1 / Circle Point (Circle starts at the top, Loop at the circle
 * point); Line from Vertex 1 to Vertex 2; a custom path (a mask outline) replaces them. Reverse Path runs it backwards. */
export function ptPath(shape: string, v1: number[], t1: number[], t2: number[], v2: number[], custom: number[] | null, reverse: boolean): { pts: number[]; closed: boolean } {
  let pts: number[] = [], closed = false;
  if (custom && custom.length >= 4) { pts = custom.slice(); closed = custom.length >= 6 && custom[0] === custom[custom.length - 2] && custom[1] === custom[custom.length - 1]; }
  else if (shape === 'circle' || shape === 'loop') {
    const r = Math.hypot(t1[0] - v1[0], t1[1] - v1[1]), a0 = shape === 'circle' ? -Math.PI / 2 : Math.atan2(t1[1] - v1[1], t1[0] - v1[0]), N = 128;
    for (let i = 0; i <= N; i++) { const a = a0 + (i / N) * 2 * Math.PI; pts.push(v1[0] + Math.cos(a) * r, v1[1] + Math.sin(a) * r); }
    closed = true;
  } else if (shape === 'line') pts = [v1[0], v1[1], v2[0], v2[1]];
  else {
    const N = 96;
    for (let i = 0; i <= N; i++) { const s = i / N, u = 1 - s; for (let k = 0; k < 2; k++) pts.push(u * u * u * v1[k] + 3 * u * u * s * t1[k] + 3 * u * s * s * t2[k] + s * s * s * v2[k]); }
  }
  if (reverse) { const r: number[] = []; for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]); pts = r; }
  return { pts, closed };
}

// ───────────────────────── Particle Playground ─────────────────────────

/** «Particles from» of every Affects group (Particle_Playground, 16 combinations; default All) */
export const PP_FROM: [string, string][] = [['all', 'Todas'], ['none', 'Ninguna'], ['c', 'Cannon'], ['g', 'Cuadrícula'], ['l', 'Explosión de capas'], ['p', 'Explosión de objetos'], ['cg', 'Cannon o cuadrícula'], ['cl', 'Cannon o explosión de capas'], ['cp', 'Cannon o explosión de objetos'], ['gl', 'Cuadrícula o explosión de capas'], ['gp', 'Cuadrícula o explosión de objetos'], ['lp', 'Explosión de capas o explosión de objetos'], ['cgl', 'Cannon o cuadrícula o explosión de capas'], ['cgp', 'Cannon o cuadrícula o explosión de objetos'], ['clp', 'Cannon o explosión de capas o explosión de objetos'], ['glp', 'Cuadrícula o explosión de capas o explosión de objetos']];
/** Persistent Property Mapper's properties (27) */
export const PP_PROPS: [string, string][] = [['none', 'Ninguno'], ['red', 'Rojo'], ['green', 'Verde'], ['blue', 'Azul'], ['kineticFriction', 'Fricción cinética'], ['staticFriction', 'Fricción estática'], ['angle', 'Ángulo'], ['angularVelocity', 'Velocidad angular'], ['torque', 'Par'], ['scale', 'Escala'], ['scaleX', 'Escala X'], ['scaleY', 'Escala Y'], ['x', 'X'], ['y', 'Y'], ['gradientVelocity', 'Velocidad de dispersión'], ['speedX', 'Velocidad X'], ['speedY', 'Velocidad Y'], ['gradientForce', 'Fuerza de dispersión'], ['forceX', 'Fuerza X'], ['forceY', 'Fuerza Y'], ['opacity', 'Opacidad'], ['mass', 'Masa'], ['lifespan', 'Duración'], ['character', 'Carácter'], ['fontSize', 'Tamaño de la fuente'], ['timeOffset', 'Compensación de tiempo'], ['scaleSpeed', 'Velocidad de escala']];
/** Ephemeral Property Mapper's properties (19: no friction, torque, forces, mass or lifespan) */
export const PP_PROPS_EPH: [string, string][] = PP_PROPS.filter(([k]) => !['kineticFriction', 'staticFriction', 'torque', 'gradientForce', 'forceX', 'forceY', 'mass', 'lifespan'].includes(k)).map(([k, v]) => [k, k === 'gradientVelocity' ? 'Velocidad de degradación' : v]);
const PP_OPS: [string, string][] = [['set', 'Definir'], ['add', 'Sumar'], ['difference', 'Diferencia'], ['subtract', 'Restar'], ['multiply', 'Multiplicar'], ['min', 'Mín.'], ['max', 'Máx.']];

/** an Affects group: Particles from, Selection Map, Characters, Older/Younger than (s, ±30000), Age Feather (0–60000) */
const ppAff = (k: string, g: string): ParamDef[] => [ch(`${k}From`, `${g}: objetos desde`, PP_FROM), ly(`${k}SelMap`, `${g}: mapa de selección`), ch(`${k}Chars`, `${g}: caracteres`, [['none', 'Ninguno'], ['sel1', 'Selección texto 1'], ['sel2', 'Selección texto 2'], ['sel3', 'Selección texto 3']]), n(`${k}Age`, `${g}: mayores/menores que`, 0, -30000, 30000), n(`${k}AgeFeather`, `${g}: calado de edad`, 0, 0, 60000)];
/** a property mapper: Use Layer As Map, Affects, Map Red / Green / Blue To (+ Operator for the ephemeral one), Min 0, Max 1 */
const ppMapper = (k: string, g: string, eph: boolean): ParamDef[] => [ly(`${k}Map`, `${g}: utilizar capa como mapa`), ...ppAff(k, `${g}: afecta a`),
  ...[['R', 'rojo'], ['G', 'verde'], ['B', 'azul']].flatMap(([c, nm]) => [ch(`${k}${c}To`, `${g}: mapear ${nm} a`, eph ? PP_PROPS_EPH : PP_PROPS), ...(eph ? [ch(`${k}${c}Op`, `${g}: operador (${nm})`, PP_OPS)] : []), n(`${k}${c}Min`, `${g}: mín. (${nm})`, 0, -200000, 200000), n(`${k}${c}Max`, `${g}: máx. (${nm})`, 1, -200000, 200000)])];

export const PP_PARAMS: ParamDef[] = [
  // Cannon (ids 100–110): centre, barrel radius 0 (±4000), 60 particles/s (0–30000), direction 0°, spread 20 (0–360),
  // velocity 130 (0–30000) ± 20 (0–20000), red, radius 2 (0–10000)
  pt('cPos', 'Cannon: posición'), n('cBarrel', 'Cannon: radio del cilindro', 0, -4000, 4000), n('cRate', 'Cannon: objetos por segundo', 60, 0, 30000), an('cDir', 'Cannon: dirección', 0), n('cDirSpread', 'Cannon: extensión aleator. de direcc.', 20, 0, 360), n('cVel', 'Cannon: velocidad', 130, 0, 30000), n('cVelSpread', 'Cannon: extensión aleator. de veloc.', 20, 0, 20000), co('cColor', 'Cannon: color', '#ff0000'), n('cRadius', 'Cannon: radio del objeto / tamaño de la fuente', 2, 0, 10000),
  // Grid (130–138): centre, 100 × 100 (0–10000), 0 × 0 particles (off), red, radius 2
  pt('gPos', 'Cuadrícula: posición'), n('gWidth', 'Cuadrícula: anchura', 100, 0, 10000), n('gHeight', 'Cuadrícula: altura', 100, 0, 10000), n('gAcross', 'Cuadrícula: objetos horizontal', 0, 0, 10000), n('gDown', 'Cuadrícula: objetos vertical', 0, 0, 10000), co('gColor', 'Cuadrícula: color', '#ff0000'), n('gRadius', 'Cuadrícula: radio del objeto / tamaño de la fuente', 2, 0, 10000),
  // Layer Exploder (200–204): no layer, radius 2, dispersion 20
  ly('leLayer', 'Explosión de capas: explotar capa'), n('leRadius', 'Explosión de capas: radio de los nuevos objetos', 2, 0, 10000), n('leDisp', 'Explosión de capas: velocidad de dispersión', 20, 0, 30000),
  // Particle Exploder (230–251): radius 0 (off), dispersion 20, Affects
  n('peRadius', 'Explosión de objetos: radio de los nuevos objetos', 0, -10000, 10000), n('peDisp', 'Explosión de objetos: velocidad de dispersión', 20, 0, 30000), ...ppAff('pe', 'Explosión de objetos: afecta a'),
  // Layer Map (280–301): Use Layer, Relative (4), offset 0 (±10000), Affects
  ly('lmLayer', 'Mapa de capa: utilizar capa'), ch('lmOffsetType', 'Mapa de capa: tipo de desplazam. de tiempo', [['relative', 'Relativo'], ['absolute', 'Absoluto'], ['relativeRandom', 'Aleatoriedad relativa'], ['absoluteRandom', 'Aleatoriedad absoluta']]), n('lmOffset', 'Mapa de capa: desplazamiento de tiempo', 0, -10000, 10000), ...ppAff('lm', 'Mapa de capa: afecta a'),
  // Gravity (330–351): force 120 (±10000), spread 0 (0–4000), direction 180°, Affects
  n('grForce', 'Gravedad: fuerza', 120, -10000, 10000), n('grSpread', 'Gravedad: extensión aleatoria de fuerza', 0, 0, 4000), an('grDir', 'Gravedad: dirección', 180), ...ppAff('gr', 'Gravedad: afecta a'),
  // Repel (380–421): force 0 (±2000), radius 10 (0–10000), Repeller, Affects
  n('rpForce', 'Rechazar: fuerza', 0, -2000, 2000), n('rpRadius', 'Rechazar: radio de fuerza', 10, 0, 10000), ...ppAff('rr', 'Rechazar: rechazar'), ...ppAff('rp', 'Rechazar: afecta a'),
  // Wall (450–471): Boundary (a mask; empty = none), Affects
  tx('wBoundary', 'Muro: límite', ''), ...ppAff('w', 'Muro: afecta a'),
  ...ppMapper('pm', 'Mapeado de propied. constantes', false), ...ppMapper('em', 'Mapeado de propiedades efímeras', true),
  // the Options dialog: cannon / grid text, Auto-Orient Rotation, the three selection texts
  tx('cText', 'Opciones: texto Cannon', ''), ch('cOrder', 'Opciones: orden del texto Cannon', [['ltr', 'Izquierda a derecha'], ['random', 'Aleatorio'], ['rtl', 'Derecha a izquierda']]), bo('cLoop', 'Opciones: repetir texto Cannon continuamente', true),
  tx('gText', 'Opciones: texto de cuadrícula', ''), ch('gAlign', 'Opciones: alineación de la cuadrícula', [['left', 'Izquierda'], ['center', 'Centrar'], ['right', 'Derecha']]), bo('gUseGrid', 'Opciones: utilizar cuadrícula', true), bo('gLoop', 'Opciones: repetir texto de cuadrícula continuamente', true),
  tx('font', 'Opciones: fuente', 'Arial'), bo('autoOrient', 'Opciones: orientación automática'), tx('sel1', 'Opciones: selección texto 1', ''), tx('sel2', 'Opciones: selección texto 2', ''), tx('sel3', 'Opciones: selección texto 3', ''),
];

/** one particle of the playground (layer px, px/s); the persistent properties live on it */
export interface PPart {
  id: number; src: 'c' | 'g' | 'l' | 'p'; born: number; x: number; y: number; vx: number; vy: number; r: number;
  col: [number, number, number]; op: number; ang: number; angVel: number; torque: number; scale: number; sx: number; sy: number;
  scaleSpeed: number; mass: number; life: number; kf: number; sf: number; fx: number; fy: number; gv: number; gf: number;
  ch: string; fs: number; tOff: number; cell?: [number, number, number, number];
}
export interface PPState { step: number; t: number; parts: PPart[]; next: number; acc: number; cIdx: number; exploded: boolean }
/** what the simulation reads from the renderer: other layers' pixels (stretched over this layer, 0–1 rgba) and masks */
export interface PPEnv {
  w: number; h: number; fps: number; seed: number;
  /** params at a layer time; points already in layer px */
  at: (t: number) => Record<string, unknown>;
  sample?: (layer: string, x: number, y: number) => [number, number, number, number] | null;
  /** a whole layer to explode: rgba bytes over this layer's w × h (stretched) */
  pixels?: (layer: string) => { data: Uint8ClampedArray | number[]; w: number; h: number } | null;
  mask?: (name: string) => number[] | null;
  /** the cap on live particles */
  max?: number;
}
const MAXP = 20000;
const h32 = (a: number, b: number) => { let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35); x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
const fnum = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const hex = (c: unknown): [number, number, number] => { const s = String(c ?? '#ff0000').replace('#', ''); const v = parseInt(s.length === 3 ? s.split('').map((q) => q + q).join('') : s.slice(0, 6), 16) || 0; return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };

export function ppNew(): PPState { return { step: 0, t: 0, parts: [], next: 0, acc: 0, cIdx: 0, exploded: false }; }
const blank = (id: number, src: PPart['src'], born: number, x: number, y: number, vx: number, vy: number, r: number, col: [number, number, number]): PPart =>
  ({ id, src, born, x, y, vx, vy, r, col, op: 1, ang: 0, angVel: 0, torque: 0, scale: 1, sx: 1, sy: 1, scaleSpeed: 0, mass: 1, life: Infinity, kf: 0, sf: 0, fx: 0, fy: 0, gv: 0, gf: 0, ch: '', fs: r, tOff: 0 });

/** How strongly an Affects group selects a particle (0–1): its source, the selection map's luminance where it is, its
 * character among a selection text, and its age (positive: older than; negative: younger than; feathered) */
export function ppAffects(q: PPart, P: Record<string, unknown>, k: string, t: number, env: PPEnv): number {
  const from = String(P[`${k}From`] ?? 'all');
  if (from === 'none') return 0;
  if (from !== 'all' && !from.includes(q.src)) return 0;
  let w = 1;
  const chs = String(P[`${k}Chars`] ?? 'none');
  if (chs !== 'none') { const sel = String(P[chs] ?? ''); if (!q.ch || !sel.includes(q.ch)) return 0; }
  const age = fnum(P[`${k}Age`]), fe = Math.max(0, fnum(P[`${k}AgeFeather`])), a = t - q.born;
  if (age !== 0) {
    const d = age > 0 ? a - age : -age - a;
    w *= fe > 0 ? Math.max(0, Math.min(1, 0.5 + d / fe)) : d >= 0 ? 1 : 0;
  }
  const sm = String(P[`${k}SelMap`] ?? '');
  if (sm && env.sample) { const s = env.sample(sm, q.x, q.y); w *= s ? (0.299 * s[0] + 0.587 * s[1] + 0.114 * s[2]) * s[3] : 0; }
  return w;
}

/** a mapped property value on a particle (Set / Add / … for the ephemeral mapper) */
function ppApply(q: PPart, prop: string, v: number, op: string, env: PPEnv): void {
  const f = (cur: number) => op === 'add' ? cur + v : op === 'difference' ? Math.abs(cur - v) : op === 'subtract' ? cur - v : op === 'multiply' ? cur * v : op === 'min' ? Math.min(cur, v) : op === 'max' ? Math.max(cur, v) : v;
  switch (prop) {
    case 'red': q.col = [f(q.col[0]), q.col[1], q.col[2]]; break;
    case 'green': q.col = [q.col[0], f(q.col[1]), q.col[2]]; break;
    case 'blue': q.col = [q.col[0], q.col[1], f(q.col[2])]; break;
    case 'kineticFriction': q.kf = f(q.kf); break;
    case 'staticFriction': q.sf = f(q.sf); break;
    case 'angle': q.ang = f(q.ang); break;
    case 'angularVelocity': q.angVel = f(q.angVel); break;
    case 'torque': q.torque = f(q.torque); break;
    case 'scale': q.scale = f(q.scale); break;
    case 'scaleX': q.sx = f(q.sx); break;
    case 'scaleY': q.sy = f(q.sy); break;
    case 'x': q.x = f(q.x); break;
    case 'y': q.y = f(q.y); break;
    case 'gradientVelocity': q.gv = f(q.gv); break;
    case 'speedX': q.vx = f(q.vx); break;
    case 'speedY': q.vy = f(q.vy); break;
    case 'gradientForce': q.gf = f(q.gf); break;
    case 'forceX': q.fx = f(q.fx); break;
    case 'forceY': q.fy = f(q.fy); break;
    case 'opacity': q.op = f(q.op); break;
    case 'mass': q.mass = f(q.mass); break;
    case 'lifespan': q.life = f(q.life); break;
    case 'character': if (q.ch) q.ch = String.fromCharCode(Math.max(32, Math.round(f(q.ch.charCodeAt(0))))); break;
    case 'fontSize': q.fs = f(q.fs); break;
    case 'timeOffset': q.tOff = f(q.tOff); break;
    case 'scaleSpeed': q.scaleSpeed = f(q.scaleSpeed); break;
  }
  void env;
}

/** Runs a property mapper on the particles: each channel of the map under a particle, scaled to Min…Max, goes to its
 * property (selected particles only, weighted by the selection). Returns the particles it changed. */
export function ppMap(parts: PPart[], P: Record<string, unknown>, k: string, t: number, env: PPEnv, eph: boolean): void {
  const map = String(P[`${k}Map`] ?? ''), ch3 = (['R', 'G', 'B'] as const).map((c, i) => ({ i, to: String(P[`${k}${c}To`] ?? 'none'), op: eph ? String(P[`${k}${c}Op`] ?? 'set') : 'set', lo: fnum(P[`${k}${c}Min`]), hi: fnum(P[`${k}${c}Max`], 1) })).filter((c) => c.to !== 'none');
  if (!map || !ch3.length || !env.sample) return;
  for (const q of parts) {
    const w = ppAffects(q, P, k, t, env);
    if (w <= 0) continue;
    const s = env.sample(map, q.x, q.y);
    if (!s || s[3] <= 0) continue;
    for (const c of ch3) {
      // gradient properties follow the slope of the map's channel
      if (c.to === 'gradientVelocity' || c.to === 'gradientForce') {
        const a = env.sample(map, q.x - 1, q.y), b = env.sample(map, q.x + 1, q.y), u = env.sample(map, q.x, q.y - 1), d = env.sample(map, q.x, q.y + 1);
        if (!a || !b || !u || !d) continue;
        const gx = (b[c.i] - a[c.i]) / 2, gy = (d[c.i] - u[c.i]) / 2, m = (c.lo + s[c.i] * (c.hi - c.lo)) * w * 100;
        if (c.to === 'gradientVelocity') { q.vx -= gx * m; q.vy -= gy * m; } else { q.fx -= gx * m; q.fy -= gy * m; }
        continue;
      }
      ppApply(q, c.to, c.lo + s[c.i] * (c.hi - c.lo), c.op, env);
    }
  }
}

const inside = (pts: number[], x: number, y: number) => { let c = false; for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) { const yi = pts[i + 1], yj = pts[j + 1]; if ((yi > y) !== (yj > y) && x < ((pts[j] - pts[i]) * (y - yi)) / (yj - yi) + pts[i]) c = !c; } return c; };

/** One frame of Particle Playground (1 / fps s): the cannon and grid give birth, the layer explodes on the first frame,
 * the particle exploder splits the selected particles, gravity / repel / the persistent mapper / friction act, the
 * particles move and bounce off the wall. Deterministic: the same params give the same particles. */
export function ppStep(S: PPState, env: PPEnv): void {
  const dt = 1 / Math.max(1, env.fps), t = S.step * dt, P = env.at(t), parts = S.parts, rnd = (id: number, k: number) => h32(id * 131 + env.seed, k);
  const max = env.max ?? MAXP;
  // ── birth: cannon (barrel disc, direction / velocity ± half their random spread) ──
  const rate = Math.max(0, fnum(P.cRate, 60)), cTxt = String(P.cText ?? '');
  S.acc += rate * dt;
  const [cx, cy] = (P.cPos as number[]) ?? [env.w / 2, env.h / 2];
  while (S.acc >= 1) {
    S.acc -= 1;
    if (parts.length >= max) break;
    const id = S.next++, ba = rnd(id, 1) * 2 * Math.PI, br = Math.sqrt(rnd(id, 2)) * Math.abs(fnum(P.cBarrel));
    const dir = ((fnum(P.cDir) + (rnd(id, 3) - 0.5) * fnum(P.cDirSpread, 20)) * Math.PI) / 180, v = Math.max(0, fnum(P.cVel, 130) + (rnd(id, 4) - 0.5) * fnum(P.cVelSpread, 20));
    const sub = rnd(id, 9) * dt, q = blank(id, 'c', t - sub, cx + Math.cos(ba) * br, cy + Math.sin(ba) * br, Math.sin(dir) * v, -Math.cos(dir) * v, fnum(P.cRadius, 2), hex(P.cColor));
    q.x += q.vx * sub; q.y += q.vy * sub;
    if (cTxt) {
      const ord = String(P.cOrder ?? 'ltr'), i = S.cIdx++;
      if (i < cTxt.length || fnum(P.cLoop, 1)) q.ch = ord === 'random' ? cTxt[Math.floor(rnd(id, 5) * cTxt.length)] : ord === 'rtl' ? cTxt[cTxt.length - 1 - (i % cTxt.length)] : cTxt[i % cTxt.length];
      else continue;
    }
    parts.push(q);
  }
  // ── birth: grid (a particle at every intersection on every frame) ──
  const na = Math.round(fnum(P.gAcross)), nd = Math.round(fnum(P.gDown));
  if (na > 0 && nd > 0) {
    const [gx, gy] = (P.gPos as number[]) ?? [env.w / 2, env.h / 2], gw = fnum(P.gWidth, 100), gh = fnum(P.gHeight, 100), gTxt = String(P.gText ?? ''), gr = fnum(P.gRadius, 2), gc = hex(P.gColor);
    for (let j = 0; j < nd; j++) for (let i = 0; i < na; i++) {
      if (parts.length >= max) break;
      let ch = '';
      if (gTxt) { const k = j * na + i; if (k >= gTxt.length && !fnum(P.gLoop, 1)) continue; ch = gTxt[k % gTxt.length]; if (ch === ' ') continue; }
      const q = blank(S.next++, 'g', t, gx - gw / 2 + (na > 1 ? (i * gw) / (na - 1) : gw / 2), gy - gh / 2 + (nd > 1 ? (j * gh) / (nd - 1) : gh / 2), 0, 0, gr, gc);
      q.ch = ch; q.cell = [i / na, j / nd, 1 / na, 1 / nd];
      parts.push(q);
    }
  }
  // ── Layer Exploder: the layer in pieces of the new radius, each with its colour, flying apart ──
  const le = String(P.leLayer ?? '');
  if (le && !S.exploded && env.pixels) {
    S.exploded = true;
    const img = env.pixels(le), r = Math.max(0.5, fnum(P.leRadius, 2)), disp = fnum(P.leDisp, 20);
    if (img) {
      const step = Math.max(1, 2 * r), sx = img.w / env.w, sy = img.h / env.h;
      for (let y = step / 2; y < env.h; y += step) for (let x = step / 2; x < env.w; x += step) {
        const i = (Math.min(img.h - 1, Math.floor(y * sy)) * img.w + Math.min(img.w - 1, Math.floor(x * sx))) * 4;
        if (img.data[i + 3] < 8 || parts.length >= max) continue;
        const id = S.next++, a = rnd(id, 1) * 2 * Math.PI, v = rnd(id, 2) * disp;
        const q = blank(id, 'l', t, x, y, Math.cos(a) * v, Math.sin(a) * v, r, [img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255]);
        q.op = img.data[i + 3] / 255; q.cell = [(x - step / 2) / env.w, (y - step / 2) / env.h, step / env.w, step / env.h];
        parts.push(q);
      }
    }
  }
  // ── Particle Exploder: selected particles larger than the new radius burst into smaller ones ──
  const pr = Math.abs(fnum(P.peRadius));
  if (pr > 0) {
    const born: PPart[] = [];
    for (let k = parts.length - 1; k >= 0; k--) {
      const q = parts[k];
      if (q.r <= pr * 1.01 || ppAffects(q, P, 'pe', t, env) < 0.5) continue;
      const nn = Math.max(2, Math.min(16, Math.round((q.r / pr) ** 2)));
      for (let c = 0; c < nn; c++) {
        const id = S.next++, a = rnd(id, 1) * 2 * Math.PI, v = rnd(id, 2) * fnum(P.peDisp, 20), d = Math.sqrt(rnd(id, 3)) * q.r;
        const z = blank(id, 'p', t, q.x + Math.cos(a) * d, q.y + Math.sin(a) * d, q.vx + Math.cos(a) * v, q.vy + Math.sin(a) * v, pr, q.col);
        z.op = q.op; born.push(z);
      }
      parts.splice(k, 1);
    }
    for (const z of born) if (parts.length < max) parts.push(z);
  }
  // ── forces ──
  ppMap(parts, P, 'pm', t, env, false);
  const gF = fnum(P.grForce, 120), gS = fnum(P.grSpread), gD = (fnum(P.grDir, 180) * Math.PI) / 180, gux = Math.sin(gD), guy = -Math.cos(gD);
  const rF = fnum(P.rpForce), rR = Math.max(0, fnum(P.rpRadius, 10));
  const reps = rF && rR > 0 ? parts.filter((q) => ppAffects(q, P, 'rr', t, env) > 0) : [];
  for (const q of parts) {
    let ax = q.fx, ay = q.fy;
    const wg = gF ? ppAffects(q, P, 'gr', t, env) : 0;
    if (wg > 0) { const f = gF + (rnd(q.id, 7) - 0.5) * gS * 2; ax += gux * f * wg; ay += guy * f * wg; }
    if (reps.length && ppAffects(q, P, 'rp', t, env) > 0) {
      // every repeller within Force Radius pushes the particle away (stronger close up)
      for (const o of reps) {
        if (o === q) continue;
        const dx = q.x - o.x, dy = q.y - o.y, d = Math.hypot(dx, dy);
        if (d >= rR || d < 1e-6) continue;
        const f = rF * 1000 * (1 - d / rR); ax += (dx / d) * f; ay += (dy / d) * f;
      }
    }
    const m = Math.max(1e-3, q.mass || 1);
    q.vx += (ax / m) * dt; q.vy += (ay / m) * dt;
    // kinetic friction slows a moving particle; static friction holds a slow one still
    if (q.kf) { const k = Math.max(0, 1 - q.kf * dt); q.vx *= k; q.vy *= k; }
    if (q.sf && Math.hypot(q.vx, q.vy) < q.sf * 10) { q.vx = 0; q.vy = 0; }
    q.angVel += (q.torque / m) * dt; q.ang += q.angVel * dt; q.scale += q.scaleSpeed * dt;
    const ox = q.x, oy = q.y;
    q.x += q.vx * dt; q.y += q.vy * dt;
    (q as PPart & { px?: number; py?: number }).px = ox; (q as PPart & { px?: number; py?: number }).py = oy;
  }
  // ── Wall: a mask the selected particles bounce off (from whichever side they are on) ──
  const wb = String(P.wBoundary ?? ''), wall = wb && env.mask ? env.mask(wb) : null;
  if (wall && wall.length >= 6) {
    for (const q of parts) {
      const o = q as PPart & { px?: number; py?: number };
      if (o.px === undefined || ppAffects(q, P, 'w', t, env) < 0.5) continue;
      if (inside(wall, o.px, o.py!) === inside(wall, q.x, q.y)) continue;
      // reflect the velocity on the edge crossed
      let best = -1, bd = Infinity;
      for (let i = 0, j = wall.length - 2; i < wall.length; j = i, i += 2) { const mx = (wall[i] + wall[j]) / 2, my = (wall[i + 1] + wall[j + 1]) / 2, d = Math.hypot(mx - q.x, my - q.y); if (d < bd) { bd = d; best = j; } }
      const i2 = (best + 2) % wall.length, ex = wall[i2] - wall[best], ey = wall[i2 + 1] - wall[best + 1], el = Math.hypot(ex, ey) || 1, nx = -ey / el, ny = ex / el;
      const vn = q.vx * nx + q.vy * ny; q.vx -= 2 * vn * nx; q.vy -= 2 * vn * ny;
      q.x = o.px; q.y = o.py!;
    }
  }
  // ── death: lifespan, and particles far outside the layer stop being simulated ──
  const far = Math.max(env.w, env.h) * 3;
  S.parts = parts.filter((q) => t + dt - q.born <= q.life && q.x > -far && q.y > -far && q.x < env.w + far && q.y < env.h + far);
  S.step++; S.t = S.step * dt;
}

/** The particles at a layer time (simulated from 0, one frame at a time), reusing a state already part way. */
export function ppSimulate(env: PPEnv, t: number, from?: PPState | null): PPState {
  const steps = Math.max(0, Math.round(t * env.fps)), S = from && from.step <= steps ? from : ppNew();
  while (S.step < steps) ppStep(S, env);
  return S;
}

/** the particles as drawn now: a copy with the ephemeral mapper applied (its values do not carry to the next frame) */
export function ppDisplay(S: PPState, env: PPEnv, t: number): PPart[] {
  const P = env.at(t), out = S.parts.map((q) => ({ ...q }));
  ppMap(out, P, 'em', t, env, true);
  return out;
}

const BT_DIR: [string, string][] =[['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['rotate', 'Rotar']];
const BT_ALIGN: [string, string][] = [['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']];

export const FX_PARTICULAS: FxDef[] = [
  // Particle Playground (Particle_Playground «ADBE Playgnd»): Cannon, Grid, Layer Exploder, Particle
  // Exploder, Layer Map, Gravity, Repel, Wall and the two property mappers, each force with its Affects group. A
  // simulation: the layer is replaced by the particles, simulated frame by frame from the layer's start
  { id: 'particlePlayground', name: 'Animación del objeto', cat: 'Simulación', params: PP_PARAMS, probe: { cRate: 400, cVel: 60, grForce: 0 } },
  // CC PS Classic (ParticleSystems, «2D particles produced from layer alpha»): velocity 1 (±1024), birth
  // rate 10 (0–1024), longevity 1 s (0–3000), gravity 1 and turbulence 1 (±1024), max opacity 75 %, #f0f010 → #20f010,
  // 18 animations (Star Light)
  { id: 'ccPsClassic', name: 'CC PS Classic (obsolete)', cat: 'Simulación', params: [n('velocity', 'Velocidad', 1, -1024, 1024), n('birthRate', 'Tasa de nacimiento', 10, 0, 1024), n('longevity', 'Longevidad (s)', 1, 0, 3000), n('gravity', 'Gravedad', 1, -1024, 1024), n('turbulence', 'Turbulencia', 1, -1024, 1024), pc('maxOpacity', 'Opacidad máxima', 75), co('birthColor', 'Color al nacer', '#f0f010'), co('deathColor', 'Color al morir', '#20f010'), ch('animation', 'Animación', PS_CLASSIC_ANIM, 'starLight')] },
  // CC PS LE Classic (ParticleSystemsLE, «from a point or an area»): radius 4 × 4 (0–1024), producer at the
  // centre, velocity 1, birth rate 5, longevity 1, gravity 1, turbulence 1, 75 %, #f0f010 → #c81010, 22 animations
  // (Fractal Explosion)
  { id: 'ccPsLe', name: 'CC PS LE Classic (obsolete)', cat: 'Simulación', params: [n('radiusX', 'Radio X', 4, 0, 1024), n('radiusY', 'Radio Y', 4, 0, 1024), pt('producer', 'Productor'), n('velocity', 'Velocidad', 1, -1024, 1024), n('birthRate', 'Tasa de nacimiento', 5, 0, 1024), n('longevity', 'Longevidad (s)', 1, 0, 3000), n('gravity', 'Gravedad', 1, -1024, 1024), n('turbulence', 'Turbulencia', 1, -1024, 1024), pc('maxOpacity', 'Opacidad máxima', 75), co('birthColor', 'Color al nacer', '#f0f010'), co('deathColor', 'Color al morir', '#c81010'), ch('animation', 'Animación', PS_LE_ANIM, 'fractalExplosion')] },
  // Basic Text (Basic_Text «ADBE Basic Text2»): position at the centre; Fill Only, red fill, white stroke 2 (0–128);
  // size 36 (0–1024), tracking 0 (±8000), line spacing 100 (±10000), Composite On Original off. The Edit Text dialog
  // (text, font, style, direction, alignment) is kept as parameters
  { id: 'basicText', name: 'Texto básico', cat: 'Obsoleto', params: [pt('position', 'Posición'), ch('display', 'Relleno y trazo: opciones de visualización', TXT_DISPLAY), co('fillColor', 'Relleno y trazo: color de relleno', '#ff0000'), co('strokeColor', 'Relleno y trazo: color del trazo', '#ffffff'), n('strokeWidth', 'Relleno y trazo: ancho del trazo', 2, 0, 128), n('size', 'Tamaño', 36, 0, 1024), n('tracking', 'Espacio entre caracteres', 0, -8000, 8000), n('lineSpacing', 'Espaciado interlineal', 100, -10000, 10000), bo('composite', 'Compuesto sobre el original'),
    ...TXT_EDIT('Texto', [ch('direction', 'Editar texto: dirección', BT_DIR), ch('alignment', 'Editar texto: alineación', BT_ALIGN, 'center')])] },
  // Path Text (Path_Text «ADBE Path Text», 54 params): Bézier; Tangent 1 (25 %, 40 %), Vertex 1 (20 %,
  // 50 %), Tangent 2 (75 %, 40 %), Vertex 2 (80 %, 50 %), custom path, reverse; Fill Only, red / white, stroke 2 (0–128);
  // size 36 (0–1024), tracking 0 (±8000), kerning value 0 (±30000); character rotation 0°, Perpendicular To Path and
  // Rotate Roman Characters on, Vertical Writing off, shear 0 (±70), scales 100 (0–2000); Left, margins 0 (±30000), line
  // spacing 100 (±10000), baseline shift 0 (±8000); visible characters 1024 (±1024), fade time 0 %, Normal; jitter maxima
  // 0 (baseline / kerning ±2000, rotation ±360, scale ±500); Composite On Original off
  { id: 'pathText', name: 'Texto de trazado', cat: 'Obsoleto', params: [ch('shapeType', 'Opciones de trazado: tipo de forma', [['bezier', 'Bézier'], ['circle', 'Círculo'], ['loop', 'Bucle'], ['line', 'Línea']]), pt('tangent1', 'Puntos de control: tangente 1/punto del círculo', 0.25, 0.4), pt('vertex1', 'Puntos de control: vértice 1/centro del círculo', 0.2, 0.5), pt('tangent2', 'Puntos de control: tangente 2', 0.75, 0.4), pt('vertex2', 'Puntos de control: vértice 2', 0.8, 0.5), tx('customPath', 'Opciones de trazado: trazado personalizado', ''), bo('reversePath', 'Opciones de trazado: invertir trazado'),
    ch('display', 'Relleno y trazo: opciones', TXT_DISPLAY), co('fillColor', 'Relleno y trazo: color de relleno', '#ff0000'), co('strokeColor', 'Relleno y trazo: color del trazo', '#ffffff'), n('strokeWidth', 'Relleno y trazo: anchura del trazo', 2, 0, 128),
    n('size', 'Carácter: tamaño', 36, 0, 1024), n('tracking', 'Carácter: espacio entre caracteres', 0, -8000, 8000), tx('kerningPairs', 'Espaciado manual: pares de espaciado manual', ''), n('kerningValue', 'Espaciado manual: valor de espaciado manual', 0, -30000, 30000), an('charRotation', 'Orientación: rotación de caracteres', 0), bo('perpendicular', 'Orientación: perpendicular al trazado', true), bo('verticalWriting', 'Orientación: escritura vertical'), bo('rotateRoman', 'Orientación: girar caracteres romanos', true), n('hShear', 'Carácter: proyección horizontal', 0, -70, 70), n('hScale', 'Carácter: escala horizontal', 100, 0, 2000), n('vScale', 'Carácter: escala vertical', 100, 0, 2000),
    ch('alignment', 'Párrafo: alineación', [['left', 'Izquierda'], ['right', 'Derecha'], ['center', 'Centro'], ['force', 'Fuerza']]), n('leftMargin', 'Párrafo: margen izquierdo', 0, -30000, 30000), n('rightMargin', 'Párrafo: margen derecho', 0, -30000, 30000), n('lineSpacing', 'Párrafo: espaciado interlinear', 100, -10000, 10000), n('baselineShift', 'Párrafo: distancia a línea de base', 0, -8000, 8000),
    n('visibleChars', 'Avanzado: caracteres visibles', 1024, -1024, 1024), pc('fadeTime', 'Avanzado: tiempo de transición', 0), ch('mode', 'Avanzado: modo', [['normal', 'Normal'], ['difference', 'Diferencia']]), n('baselineJitter', 'Configuración de vibración: variación máx. a línea de base', 0, -2000, 2000), n('kerningJitter', 'Configuración de vibración: variación máx. espac. manual', 0, -2000, 2000), n('rotationJitter', 'Configuración de vibración: variación máxima de rotación', 0, -360, 360), n('scaleJitter', 'Configuración de vibración: escalar vibración máxima', 0, -500, 500),
    bo('composite', 'Compuesto sobre el original'), ...TXT_EDIT('Texto')] },
  // Vector Paint (VectorPaint «ADBE Vector Paint»): Playback Mode Current Frame (6), speed 1 (±100); wiggle off, 30
  // wiggles/s, displacement variation 5 (±30000) / detail 100 (0–1000), pressure variation 70 / detail 50, Individual
  // Stroke Seeds on; Composite Paint In Original (10). The strokes live in the effect (JSON, drawn in the viewer or set
  // through MCP); AE keeps the brush (radius, feather, opacity, colour) in the Composition panel's toolbar: here they are
  // the settings new strokes are painted with
  { id: 'vectorPaint', name: 'Pintura vectorial', cat: 'Pintura', params: [ch('playback', 'Modo de reproducción', VP_PLAYBACK, 'current'), n('playbackSpeed', 'Velocidad de reproducción', 1, -100, 100), bo('wiggle', 'Control de ondulación: habilitar ondulación'), n('wigglesPerSec', 'Control de ondulación: ondulaciones/seg.', 30, -100, 100), n('dispVariation', 'Control de ondulación: variación del desplazamiento', 5, -30000, 30000), n('dispDetail', 'Control de ondulación: detalles del desplazamiento', 100, 0, 1000), n('pressVariation', 'Control de ondulación: variación de la presión', 70, -30000, 30000), n('pressDetail', 'Control de ondulación: detalles de la presión', 50, 0, 1000), bo('individualSeeds', 'Control de ondulación: raíces de trazo individuales', true), ch('composite', 'Pintura compuesta', VP_COMPOSITE, 'inOriginal'),
    n('brushRadius', 'Pincel: radio', 8, 0, 500), pc('brushFeather', 'Pincel: desvanecer', 50), pc('brushOpacity', 'Pincel: opacidad', 100), co('brushColor', 'Pincel: color', '#ffffff'), tx('strokes', 'Trazos', '[]')], still: true },
];
