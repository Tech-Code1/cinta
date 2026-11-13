// Demo / stress test: «Bola de los elementos» — a ball bounces and turns into water, fire, electricity and rock,
// then a geyser of water rebuilds it (seamless 7.4 s loop, 720×1280 vertical). Built only with MCP calls, like an
// AI would. Timing measured frame by frame on the reference (impacts at 0.67 / 2.03 / 3.4 / 4.67 s, geyser 6.03 s).
// Uses wiggle paths, zigzag, lightning, cell pattern, gooey, burst / trailing particles (shard, drop), expressions
// with valueAtTime, directional blur and generated sound effects.
//   node scripts/demo-elementos.mjs <work dir> [--exe=<Cinta.exe>] [--frames-only]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-elementos'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
const framesOnly = process.argv.includes('--frames-only');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
let calls = 0;
async function call(name, a = {}) {
  calls++;
  const r = await client.callTool({ name, arguments: { project: P, ...a } }, undefined, { timeout: 900000 });
  if (r.isError) { console.log(`✘ ${name} ${JSON.stringify(a).slice(0, 200)}: ${r.content?.[0]?.text}`); throw new Error(r.content?.[0]?.text); }
  return r.structuredContent;
}
const P = join(out, 'elementos.cinta');
const M = 'Elementos';
const W = 720, H = 1280, DUR = 7.4;
const R = 125; // ball radius
const FLOOR = 1015, APEX = 425; // y of the ball's bottom point
const IMP = { water: 0.67, fire: 2.03, electric: 3.4, rock: 4.67 };
const HANG = { water: 0.53, fire: 1.87, electric: 3.2, rock: 4.45 }; // when each fall starts
const HOLD = { water: 0.06, fire: 0.11, electric: 0.09, rock: 0.07 }; // time on the floor (puddle / egg)
const ROCK_FALL = 5.93, GEYSER = 6.03, REFORM = 6.85;
const up = (k) => IMP[k] + HOLD[k]; // leaves the floor
const top = (k) => up(k) + 0.19; // reaches the apex
const ball = (dx = 0, dy = -R) => `add(thisComp.layer('Bola').position, [${dx}, ${dy}])`;
const shape = (o) => call('shape_add', { comp: M, ...o });
const prop = (layer, path, o) => call('prop_set', { comp: M, layer, path, ...o });
const fx = async (layer, effect, values) => (await call('effect_add', { comp: M, layer, effect, values })).effect.id;
const span = (layer, a, b) => call('layer_set', { comp: M, layer, in: a, out: b });
async function ballLayer(name) {
  const l = await call('layer_add', { comp: M, type: 'shape', name });
  await call('layer_set', { comp: M, layer: l.layer.id, parent: 'Bola' });
  await prop(l.layer.id, 'position', { value: [0, -R] });
  return l.layer.id;
}
async function fxLayer(name, blend = 'add') {
  const l = await call('layer_add', { comp: M, type: 'solid', name, color: '#00000000', width: W, height: H });
  await call('layer_set', { comp: M, layer: l.layer.id, blend });
  return l.layer.id;
}
/** solid flattened onto the floor (perspective): particles spread along the ground */
async function floorLayer(name, blend = 'add') {
  const id = await fxLayer(name, blend);
  await prop(id, 'anchor', { value: [W / 2, FLOOR] });
  await prop(id, 'position', { value: [W / 2, FLOOR] });
  await prop(id, 'scale', { value: [100, 22] });
  return id;
}

await call('project_new', { path: P, width: W, height: H, fps: 30 });
await call('comp_new', { name: M, width: W, height: H, fps: 30, duration: DUR, bg: '#05080a' });

// ───── background + floor light, tinted per element ─────
const bg = (await call('layer_add', { comp: M, type: 'solid', name: 'Fondo', color: '#05080a', width: W, height: H })).layer.id;
await fx(bg, 'gradientRamp', { start: [W / 2, 0], end: [W / 2, H], startColor: '#020405', endColor: '#0e3338' });
const tone = (water, fire, electric, rock) => [
  { t: 0, v: water, ease: 'hold' }, { t: IMP.fire, v: fire, ease: 'hold' }, { t: IMP.electric, v: electric, ease: 'hold' },
  { t: IMP.rock, v: rock, ease: 'hold' }, { t: GEYSER + 0.08, v: water, ease: 'hold' },
];
await prop(bg, 'effects.gradientRamp.endColor', { keys: tone('#0d3036', '#3b0905', '#0b3550', '#3a2a1c') });
await prop(bg, 'effects.gradientRamp.startColor', { keys: tone('#020506', '#0d0201', '#02070c', '#0b0806') });
const floor = await shape({ kind: 'ellipse', width: 620, height: 100, color: '#2aa7b4', name: 'Luz del suelo' });
await prop(floor.layer.id, 'position', { value: [W / 2, FLOOR + 25] });
await fx(floor.layer.id, 'gaussianBlur', { amount: 38 });
await prop(floor.layer.id, 'shapes.Luz del suelo.fill.color', { keys: tone('#2aa7b4', '#ff7a2a', '#36d6ff', '#c98a4a') });
const flash = [{ t: 0, v: 30 }];
for (const t of [...Object.values(IMP), GEYSER]) flash.push({ t: t - 0.01, v: 30 }, { t: t + 0.04, v: 100 }, { t: t + 0.7, v: 40, ease: 'out' });
flash.push({ t: DUR, v: 30 });
await prop(floor.layer.id, 'opacity', { keys: flash.sort((a, b) => a.t - b.t) });
const mark = await call('layer_add', { comp: M, type: 'text', text: 'CINTA', size: 34, color: '#ffffff', position: [W / 2, 965] });
await call('layer_set', { comp: M, layer: mark.layer.id, text_style: { weight: 800 } });
await prop(mark.layer.id, 'opacity', { value: 10 });

// ───── the rig: a null at the ball's bottom point ─────
const rig = (await call('layer_add', { comp: M, type: 'null', name: 'Bola' })).layer.id;
await prop(rig, 'anchor', { value: [0, 0] });
const fall = { ease: 'bezier', eo: [0.5, 0] }, land = { ease: 'bezier', ei: [1, 1] }, rise = { ease: 'bezier', eo: [0, 0.4] }, arrive = { ease: 'bezier', ei: [0.3, 1] };
const X = W / 2;
const pos = [{ t: 0, v: [X, APEX] }];
const scl = [{ t: 0, v: [100, 100] }];
for (const k of Object.keys(IMP)) {
  pos.push({ t: HANG[k], v: [X, APEX], ...fall }, { t: IMP[k], v: [X, FLOOR], ...land }, { t: up(k), v: [X, FLOOR], ...rise }, { t: top(k), v: [X, APEX], ...arrive });
  scl.push({ t: HANG[k], v: [100, 100] }, { t: IMP[k] - 0.05, v: [82, 124] });
  if (k === 'water') scl.push({ t: IMP[k], v: [255, 20] }, { t: up(k), v: [250, 21] }, { t: up(k) + 0.04, v: [80, 126] });
  else if (k === 'electric') scl.push({ t: IMP[k], v: [86, 120] }, { t: IMP[k] + 0.04, v: [84, 124] }, { t: up(k) + 0.06, v: [80, 128] });
  else scl.push({ t: IMP[k], v: [150, 55] }, { t: IMP[k] + 0.04, v: [84, 124] }, { t: up(k) + 0.06, v: [80, 128] });
  // overshoot at the apex: squashes wide, then tall, then settles (jelly)
  scl.push({ t: top(k), v: [124, 82] }, { t: top(k) + 0.08, v: [92, 110] }, { t: top(k) + 0.17, v: [104, 97] }, { t: top(k) + 0.27, v: [100, 100], ease: 'easy' });
}
pos.push({ t: ROCK_FALL, v: [X, APEX], ...fall }, { t: GEYSER, v: [X, FLOOR] }, { t: REFORM - 0.3, v: [X, APEX] });
scl.push({ t: ROCK_FALL, v: [100, 100] }, { t: GEYSER - 0.03, v: [84, 122] }, { t: GEYSER, v: [100, 100] });
await prop(rig, 'position', { keys: pos });
await prop(rig, 'scale', { keys: scl.sort((a, b) => a.t - b.t) });

// ───── WATER: glassy ball; while it hangs it wobbles like jelly (smooth zigzag) ─────
const water = await ballLayer('Agua');
const wob = { size: 5, detail: 6, speed: 2, seed: 4 };
const jelly = { size: 0, ridges: 5, smooth: true };
await shape({ layer: water, kind: 'ellipse', width: 2 * R, height: 2 * R, name: 'Cuerpo', gradient: { type: 'radial', colors: ['#1a535b', '#15454c', '#2b8790'], start: [0, 30], end: [0, 30 + R * 1.05] }, wiggle: wob, zigzag: jelly });
await shape({ layer: water, kind: 'ellipse', width: 2 * R - 6, height: 2 * R - 6, name: 'Borde', color: null, stroke: '#8fe0e6', stroke_width: 3, wiggle: wob, zigzag: jelly });
await shape({ layer: water, kind: 'ellipse', width: 2 * R - 60, height: 18, name: 'Anillo', color: null, stroke: '#8fe0e6', stroke_width: 3, position: [0, -10] });
await shape({ layer: water, kind: 'ellipse', width: 176, height: 62, name: 'Cáustica', position: [0, 55], gradient: { type: 'linear', colors: ['#d8fbfc', '#62bfc6'], start: [0, -30], end: [0, 30] }, wiggle: { size: 3, detail: 5, speed: 2, seed: 9 } });
await shape({ layer: water, kind: 'ellipse', width: 136, height: 44, name: 'Reflejo', position: [0, -88], color: '#ffffff' });
await shape({ layer: water, kind: 'ellipse', width: 26, height: 9, name: 'Brillo arriba', position: [0, -118], color: '#ffffff' });
await shape({ layer: water, kind: 'ellipse', width: 32, height: 10, name: 'Brillo abajo', position: [0, 117], color: '#ffffff' });
await prop(water, 'shapes.Reflejo.fill.opacity', { value: 20 });
await fx(water, 'glow', { threshold: 70, radius: 16, intensity: 0.7 });
// jelly: ridges come and go while it hangs (0–0.53, 1.45–1.87 and after the reform)
const wobble = `var on = (time < ${HANG.water}) || (time > 1.45 && time < ${HANG.fire}) || (time > ${REFORM + 0.15}); on ? 12 * Math.sin(time * 21) : 0`;
for (const s of ['Cuerpo', 'Borde']) await prop(water, `shapes.${s}.zigzag.size`, { expression: wobble });
await prop(water, 'shapes.Anillo.transform.opacity', { expression: `Math.abs(${wobble.replace('9 * ', '11 * ')}) * 8` });
await prop(water, 'opacity', { keys: [{ t: 0, v: 100, ease: 'hold' }, { t: IMP.fire, v: 0, ease: 'hold' }, { t: REFORM, v: 100, ease: 'hold' }] });
const splash = await floorLayer('Salpicadura');
await fx(splash, 'particles', { position: [X, FLOOR], birth: 'burst', burstAt: IMP.water, rate: 26, life: 0.45, velocity: 520, spread: 360, gravity: 0, drag: 5, size: 10, sizeVar: 60, colorStart: '#d6fbff', colorEnd: '#3aa7b0', shape: 'drop', radiusX: 70, radiusY: 4, seed: 3, fadeIn: 1 });
await span(splash, IMP.water, IMP.water + 0.5);

// ───── FIRE: lava splat → egg on the floor with a lava stream → cel-shaded swirl that sheds petals → flames ─────
const fire = await ballLayer('Fuego');
await shape({ layer: fire, kind: 'ellipse', width: 2 * R + 10, height: 2 * R + 10, name: 'Llama', color: '#d8321a', wiggle: { size: 14, detail: 12, speed: 4, seed: 11 } });
await shape({ layer: fire, kind: 'star', points: 6, width: 236, inner_radius: 50, name: 'Medio', color: '#f2602a', wiggle: { size: 10, detail: 18, speed: 5, seed: 12 } });
await shape({ layer: fire, kind: 'star', points: 5, width: 160, inner_radius: 30, name: 'Núcleo', color: '#ffb25a', wiggle: { size: 8, detail: 14, speed: 6, seed: 13 } });
await shape({ layer: fire, kind: 'star', points: 4, width: 80, inner_radius: 16, name: 'Centro', color: '#f2602a', wiggle: { size: 5, detail: 10, speed: 7, seed: 14 } });
await prop(fire, 'shapes.Medio.transform.rotation', { expression: 'time * 120' });
await prop(fire, 'shapes.Núcleo.transform.rotation', { expression: '30 + time * 160' });
await prop(fire, 'shapes.Centro.transform.rotation', { expression: '10 + time * 200' });
await fx(fire, 'twirl', { angle: 260, radius: 140 });
await prop(fire, 'effects.twirl.angle', { keys: [{ t: IMP.fire, v: 110 }, { t: top('fire'), v: 150 }, { t: top('fire') + 0.15, v: 280, ease: 'out' }, { t: 2.95, v: 300 }, { t: 3.12, v: 80, ease: 'in' }] });
// becomes a flame before falling: tall star arms point up (wiggle fast)
// polar outline: round ball (tongues = 0) or a flame whose tongues rise from the top
const flame = (tongues, n) => { const p = []; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 - Math.PI / 2, up = Math.max(0, -Math.sin(a)); const r = (R + 5) * (1 + tongues * up ** 2 * (0.35 + 0.65 * Math.abs(Math.sin(a * 3.5)))) * (1 - tongues * 0.12 * Math.max(0, Math.sin(a))); p.push(Math.cos(a) * r, Math.sin(a) * r - tongues * 20 * up); } return p; };
await call('shape_set', { comp: M, layer: fire, shape: 'Llama', to_path: true });
await prop(fire, 'shapes.Llama.path', { path_points: true, keys: [{ t: 2.88, v: flame(0, 40), ease: 'easy' }, { t: 3.12, v: flame(1.1, 72) }] });
await prop(fire, 'shapes.Medio.transform.scale', { keys: [{ t: 2.88, v: [100, 100], ease: 'easy' }, { t: 3.12, v: [80, 112] }] });
await fx(fire, 'glow', { threshold: 45, radius: 50, intensity: 0.9 });
await span(fire, IMP.fire, IMP.electric);
// lava stream from the floor to the rising ball (expressions: it stretches with the ball, thins, then breaks)
const stream = await shape({ kind: 'rect', width: 50, height: 10, color: '#d8321a', name: 'Chorro', wiggle: { size: 9, detail: 14, speed: 5, seed: 16 } });
const sid = stream.layer.id;
await prop(sid, 'position', { expression: `var b = thisComp.layer('Bola').position; [b[0], (b[1] - 40 + ${FLOOR}) / 2]` });
await prop(sid, 'shapes.Chorro.size', { expression: `var b = thisComp.layer('Bola').position; [linear(time, ${up('fire')}, ${top('fire') + 0.25}, 60, 6), Math.max(0, ${FLOOR} - b[1] + 40)]` });
await shape({ layer: sid, kind: 'ellipse', width: 30, height: 30, color: '#ffb25a', name: 'Gota de lava', position: [0, 0] });
await prop(sid, 'shapes.Gota de lava.size', { expression: `[linear(time, ${up('fire')}, ${top('fire') + 0.25}, 26, 2), Math.max(0, ${FLOOR} - thisComp.layer('Bola').position[1])]` });
await prop(sid, 'opacity', { keys: [{ t: top('fire') - 0.02, v: 100 }, { t: top('fire') + 0.12, v: 0 }] });
await span(sid, IMP.fire, top('fire') + 0.14);
// petals shed by the swirl (they stay where they were born and fall), and sparks
const petals = await fxLayer('Pétalos', 'normal');
await fx(petals, 'particles', { position: [X, APEX - R], rate: 24, life: 0.8, velocity: 230, spread: 360, gravity: 180, drag: 1.2, size: 30, sizeVar: 55, colorStart: '#f04a20', colorEnd: '#d8321a', shape: 'drop', radiusX: R * 0.9, radiusY: R * 0.9, seed: 21, fadeIn: 1 });
await prop(petals, 'effects.particles.position', { expression: ball() });
await prop(petals, 'effects.particles.rate', { keys: [{ t: top('fire'), v: 0, ease: 'hold' }, { t: top('fire') + 0.05, v: 24, ease: 'hold' }, { t: 2.85, v: 0, ease: 'hold' }] });
await fx(petals, 'particles', { position: [X, APEX - R], rate: 30, life: 1, velocity: 90, spread: 360, gravity: 120, size: 9, sizeVar: 60, colorStart: '#ffd27a', colorEnd: '#ff5a1a', shape: 'glow', radiusX: R, radiusY: R, seed: 22 });
await prop(petals, 'effects.Sistema de partículas 2.position', { expression: ball() });
await span(petals, up('fire'), IMP.electric);
// lava splat: an explosion on the floor and red shards spreading along the ground
const lava = await shape({ kind: 'ellipse', width: 300, height: 60, color: '#ffbf5a', name: 'Lava', wiggle: { size: 16, detail: 9, speed: 3, seed: 21 } });
await prop(lava.layer.id, 'position', { value: [X, FLOOR - 6] });
await fx(lava.layer.id, 'glow', { threshold: 30, radius: 40, intensity: 1.3 });
await prop(lava.layer.id, 'scale', { keys: [{ t: IMP.fire, v: [40, 80] }, { t: IMP.fire + 0.1, v: [110, 90], ease: 'out' }, { t: IMP.fire + 0.45, v: [70, 30], ease: 'easy' }] });
await prop(lava.layer.id, 'opacity', { keys: [{ t: IMP.fire + 0.2, v: 100 }, { t: IMP.fire + 0.5, v: 0 }] });
await span(lava.layer.id, IMP.fire, IMP.fire + 0.55);
const shards = await floorLayer('Esquirlas de lava', 'normal');
await fx(shards, 'particles', { position: [X, FLOOR], birth: 'burst', burstAt: IMP.fire, rate: 26, life: 1.1, velocity: 900, spread: 360, gravity: 0, drag: 3.5, size: 16, sizeVar: 60, colorStart: '#ff7a2a', colorEnd: '#c8200e', shape: 'drop', radiusX: 40, radiusY: 4, seed: 6, fadeIn: 1 });
await span(shards, IMP.fire, IMP.electric);

// ───── ELECTRICITY: plasma egg with lightning legs → an angular bolt chases it up → cage of arcs ─────
const elec = await ballLayer('Plasma');
await shape({ layer: elec, kind: 'ellipse', width: 2 * R - 14, height: 2 * R - 14, name: 'Plasma', gradient: { type: 'radial', colors: ['#f4feff', '#c6f6fc', '#7fe4f4'], start: [-20, -25], end: [-20 + R, -25] }, wiggle: { size: 3, detail: 10, speed: 8, seed: 41 } });
await fx(elec, 'glow', { threshold: 25, radius: 70, intensity: 1.5, mode: 'color', color: '#2fd2ff' });
await span(elec, IMP.electric, IMP.rock);
const arcs = await fxLayer('Rayos');
const bolt = async (o, keys) => { const id = await fx(arcs, 'lightning', { core: '#e9feff', glowColor: '#22c8ff', ...o }); if (keys) await prop(arcs, `effects.${id}.opacity`, { keys }); return id; };
const fade = (a, b, c = 0.06) => [{ t: a - 0.001, v: 0, ease: 'hold' }, { t: a, v: 100, ease: 'hold' }, { t: b, v: 100 }, { t: b + c, v: 0 }];
// legs to the floor while it sits there
for (const [i, dx] of [[0, -150], [1, 160]]) {
  const id = await bolt({ segments: 3, jag: 40, branching: 30, width: 3.5, glowRadius: 16, flicker: 15, seed: 60 + i }, fade(IMP.electric, up('electric')));
  await prop(arcs, `effects.${id}.origin`, { expression: ball(dx * 0.4, -R * 0.6) });
  await prop(arcs, `effects.${id}.end`, { value: [X + dx, FLOOR + 5] });
}
// the angular trail: few long segments from the floor to where the ball was a moment ago
const trail = await bolt({ origin: [X - 40, FLOOR], segments: 2, jag: 45, branching: 12, width: 5, glowRadius: 24, flicker: 6, seed: 64 }, fade(up('electric'), 4.0, 0.12));
await prop(arcs, `effects.${trail}.end`, { expression: `var b = thisComp.layer('Bola').transform.position.valueAtTime(time - 0.04); [b[0], b[1] - 10]` });
// cage of short arcs around the ball (more while settling at the top)
const cage = [[-125, -60, -40, -230], [110, -200, 140, -30], [-100, -10, 90, 10], [-135, -170, -20, -250], [30, -250, 135, -120]];
for (const [i, [ax, ay, bx, by]] of cage.entries()) {
  const id = await bolt({ segments: 3, jag: 35, branching: 25, width: 2.4, glowRadius: 12, flicker: 12 + i * 3, seed: 70 + i }, fade(3.85 + i * 0.03, 4.25 - i * 0.02, 0.1));
  await prop(arcs, `effects.${id}.origin`, { expression: ball(ax, ay + R - R) });
  await prop(arcs, `effects.${id}.end`, { expression: ball(bx, by + R - R) });
}
// a bolt follows it down before the next impact, sparks on the floor
const down = await bolt({ origin: [X - 260, FLOOR], segments: 2, jag: 40, branching: 10, width: 4, glowRadius: 20, flicker: 10, seed: 80 }, fade(HANG.rock + 0.05, IMP.rock, 0.02));
await prop(arcs, `effects.${down}.end`, { expression: ball(-60, -R) });
await fx(arcs, 'particles', { position: [X, FLOOR - 6], birth: 'burst', burstAt: up('electric'), rate: 40, life: 0.5, velocity: 650, spread: 140, gravity: 1400, drag: 3, size: 4, sizeVar: 50, colorStart: '#ffffff', colorEnd: '#22c8ff', radiusX: 40, radiusY: 4, streak: 0.05, seed: 8 });
await span(arcs, IMP.electric, IMP.rock);

// ───── ROCK: faceted boulder with glowing cracks; crater, debris that tumbles and floats ─────
const rock = await ballLayer('Roca');
await shape({ layer: rock, kind: 'ellipse', width: 2 * R + 4, height: 2 * R - 6, name: 'Roca', gradient: { type: 'radial', colors: ['#a0806a', '#77594a', '#3d2c22'], start: [-35, -45], end: [-35 + R * 1.45, -45] }, wiggle: { size: 14, detail: 15, speed: 0, seed: 81, smooth: false } });
await fx(rock, 'cellPattern', { type: 'plates', size: 48, contrast: 50, seed: 4 });
for (const [i, [ax, ay, bx, by]] of [[-30, -105, 5, 70], [5, -15, 110, -55], [-5, 25, -105, 50], [-40, -60, -95, -30]].entries()) {
  await fx(rock, 'lightning', { origin: [W / 2 + ax, H / 2 + ay], end: [W / 2 + bx, H / 2 + by], segments: 3, jag: 32, branching: 35, width: 4, core: '#ffc860', glowColor: '#e8701a', glowRadius: 8, glowOpacity: 70, flicker: 0, seed: 90 + i, taper: 1 });
}
await fx(rock, 'glow', { threshold: 80, radius: 22, intensity: 0.8 });
await prop(rock, 'rotation', { keys: [{ t: IMP.rock, v: -15 }, { t: ROCK_FALL, v: 30 }] });
await span(rock, IMP.rock, GEYSER + 0.02);
const ground = await fxLayer('Suelo roto', 'normal');
for (const [i, [x1, y1]] of [[50, FLOOR + 15], [670, FLOOR + 25], [140, FLOOR + 85], [590, FLOOR + 80], [360, FLOOR + 115]].entries()) {
  await fx(ground, 'lightning', { origin: [X + (i % 2 ? 25 : -25), FLOOR + 6], end: [x1, y1], segments: 4, jag: 22, branching: 35, width: 3, core: '#1a120c', glowColor: '#120c08', glowRadius: 0, flicker: 0, seed: 100 + i, taper: 1 });
}
await fx(ground, 'lightning', { origin: [X - 75, FLOOR + 6], end: [X + 75, FLOOR + 10], segments: 3, jag: 35, branching: 20, width: 11, core: '#ffd36e', glowColor: '#ff8a1a', glowRadius: 28, flicker: 0, seed: 110 });
await prop(ground, 'opacity', { keys: [{ t: IMP.rock, v: 0 }, { t: IMP.rock + 0.04, v: 100 }, { t: GEYSER, v: 100 }, { t: GEYSER + 0.15, v: 0 }] });
await fx(ground, 'particles', { position: [X, FLOOR - 10], birth: 'burst', burstAt: IMP.rock, rate: 16, life: 1.2, velocity: 560, spread: 120, gravity: 1500, drag: 0.8, size: 26, sizeVar: 60, colorStart: '#a88c76', colorEnd: '#5a463a', shape: 'shard', spin: 300, radiusX: 60, radiusY: 4, seed: 12, fadeIn: 1 });
await fx(ground, 'particles', { position: [X, FLOOR - 30], rate: 2, life: 3, velocity: 25, spread: 360, gravity: -6, size: 20, sizeVar: 50, colorStart: '#5a463a', colorEnd: '#3a2c24', shape: 'shard', spin: 40, radiusX: 300, radiusY: 25, seed: 13, warmup: 3, fadeIn: 20 });
await span(ground, IMP.rock, GEYSER + 0.2);

// ───── GEYSER: water erupts from the floor, pours back from the top and gathers into the ball ─────
const gey = await call('layer_add', { comp: M, type: 'shape', name: 'Géiser' });
const gid = gey.layer.id;
// content hangs below the layer origin (top edge), so scaling y shrinks it towards the top
await shape({ layer: gid, kind: 'ellipse', width: 520, height: 780, name: 'Masa', color: '#ffffff', position: [0, 390], wiggle: { size: 60, detail: 9, speed: 3, seed: 7 } });
await fx(gid, 'fractalNoise', { scale: 110, contrast: 190, complexity: 3, brightness: -4 });
await fx(gid, 'directionalBlur', { angle: 0, length: 140 }); // vertical streaks before posterising = cel foam veins
await prop(gid, 'effects.fractalNoise.evolution', { expression: 'time * 700' });
await prop(gid, 'effects.fractalNoise.offset', { expression: '[0, time * 900]' });
await fx(gid, 'toonBands', { bands: 4, c1: '#0d3f47', c2: '#1d6670', c3: '#5fb0b8', c4: '#d4f3f5', balance: -12 });
await fx(gid, 'turbulentDisplace', { amount: 40, size: 70, complexity: 2 });
await prop(gid, 'effects.turbulentDisplace.evolution', { expression: 'time * 400' });
await fx(gid, 'gooey', { radius: 10, threshold: 50, softness: 6 });
const streak = await fx(gid, 'directionalBlur', { angle: 0, length: 0 });
await prop(gid, 'position', { keys: [
  { t: GEYSER, v: [X, FLOOR - 40], ease: 'out' }, { t: GEYSER + 0.3, v: [X, -320] },
  { t: GEYSER + 0.42, v: [X, -260], ease: 'easy' }, { t: REFORM, v: [X, APEX - 2 * R], ease: 'in' },
] });
await prop(gid, 'scale', { keys: [
  { t: GEYSER, v: [60, 20] }, { t: GEYSER + 0.12, v: [115, 120], ease: 'out' }, { t: GEYSER + 0.42, v: [92, 135] },
  { t: GEYSER + 0.6, v: [62, 110], ease: 'easy' }, { t: REFORM, v: [48, 32], ease: 'in' },
] });
await prop(gid, `effects.${streak}.length`, { keys: [{ t: GEYSER, v: 20 }, { t: GEYSER + 0.1, v: 90 }, { t: GEYSER + 0.25, v: 30 }, { t: GEYSER + 0.4, v: 0 }, { t: REFORM, v: 0 }] });
await prop(gid, 'opacity', { keys: [{ t: REFORM - 0.04, v: 100 }, { t: REFORM + 0.08, v: 0 }] });
await span(gid, GEYSER, REFORM + 0.1);
// drips that fall from the top while it gathers, and the crown of droplets on the new ball
const drops = await fxLayer('Gotas', 'normal');
await fx(drops, 'particles', { position: [X, APEX - 2 * R + 6], birth: 'burst', burstAt: REFORM - 0.05, rate: 36, life: 0.8, velocity: 470, spread: 95, gravity: 1100, drag: 1, size: 13, sizeVar: 70, colorStart: '#cff6f8', colorEnd: '#4fb8c0', shape: 'drop', radiusX: 70, radiusY: 6, seed: 15, fadeIn: 1 });
await fx(drops, 'particles', { position: [X, 0], rate: 14, life: 0.6, velocity: 200, direction: 180, spread: 20, gravity: 900, size: 10, sizeVar: 60, colorStart: '#8fd2d8', colorEnd: '#1d6670', shape: 'drop', radiusX: 90, radiusY: 4, seed: 16, fadeIn: 1 });
await prop(drops, 'effects.Sistema de partículas 2.rate', { keys: [{ t: GEYSER + 0.4, v: 14, ease: 'hold' }, { t: REFORM, v: 0, ease: 'hold' }] });
await span(drops, GEYSER + 0.4, DUR);

for (const id of [fire, elec, rock]) await call('layer_set', { comp: M, layer: id, motion_blur: true });
await call('comp_set', { comp: M, motion_blur: { on: true, shutter: 180, samples: 10 } });
const adj = await call('layer_add', { comp: M, type: 'adjustment', name: 'Viñeta' });
await fx(adj.layer.id, 'vignette', { amount: 45 });

// ───── sound: impacts, a whoosh on each rise, a pop when the water ball is back ─────
const sfx = async (name, at, dur, level) => {
  const g = await call('media_generate', { kind: 'sfx', name, duration: dur, output: join(out, `${name}-${at}.wav`) });
  const l = await call('layer_add', { comp: M, type: 'audio', media_path: g.path, start: at });
  await prop(l.layer.id, 'audio.level', { value: level });
};
for (const t of Object.values(IMP)) { await sfx('impact', t - 0.02, 0.6, -4); }
for (const k of Object.keys(IMP)) await sfx('whoosh', up(k) - 0.05, 0.35, -10);
await sfx('impact', GEYSER - 0.02, 0.6, -2);
await sfx('whoosh', GEYSER, 0.7, -6);
await sfx('pop', REFORM, 0.3, -6);

console.log(`${calls} llamadas MCP`);
const times = [0.3, 0.62, 0.68, 0.85, 0.98, 1.6, 2.05, 2.12, 2.25, 2.55, 3.05, 3.2, 3.43, 3.6, 3.75, 4.05, 4.55, 4.72, 4.8, 5.3, 6.08, 6.25, 6.5, 6.7, 6.95, 7.25];
for (const t of times) await call('comp_frame', { comp: M, time: t, width: 360, output: join(out, `f_${t.toFixed(2).replace('.', '_')}.png`) });
if (!framesOnly) {
  const t0 = Date.now();
  const r = await call('comp_render', { comp: M, output: join(out, 'elementos.mp4') });
  console.log(`render: ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(r).slice(0, 200));
}
await client.close();
