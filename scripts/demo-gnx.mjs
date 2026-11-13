// Demo / stress test: «Despertar» — a vertical anime power-up edit (720×1280, 27.5 s) in the style of the
// "MUSTARD · GNX" reference: red moon and a silhouette on a cliff, a backlit shout, a shockwave, a white energy
// pillar with rocks rising, a dome explosion, fire, a beam in a red sky and the warrior floating among rocks with
// glowing hair, cut on the beat with white flashes, inverted strobes and camera shake. Every graphic is drawn here
// (own silhouettes, no footage) and the music is Cinta's generated trap beat. Built only with MCP calls.
// Uses rim light (contraluz), particles with depth and lit edges, turbulent / stretched fractal noise, nested
// compositions, expressions and generated sound (riser, boom, rumble, zap).
//   node scripts/demo-gnx.mjs <work dir> [--exe=<Cinta.exe>] [--frames-only]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-gnx'));
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
  const r = await client.callTool({ name, arguments: { project: PRJ, ...a } }, undefined, { timeout: 1800000 });
  if (r.isError) { console.log(`✘ ${name} ${JSON.stringify(a).slice(0, 200)}: ${r.content?.[0]?.text}`); throw new Error(r.content?.[0]?.text); }
  return r.structuredContent;
}
const PRJ = join(out, 'gnx.cinta');
const W = 720, H = 1280, FPS = 30, DUR = 27.5;

// ───── helpers (all take the composition name first) ─────
const solid = async (comp, name, color, blend = 'normal') => {
  const id = (await call('layer_add', { comp, type: 'solid', name, color, width: W, height: H })).layer.id;
  if (blend !== 'normal') await call('layer_set', { comp, layer: id, blend });
  return id;
};
const shapeLayer = async (comp, name, o) => (await call('shape_add', { comp, name, ...o })).layer.id;
const addShape = (comp, layer, o) => call('shape_add', { comp, layer, ...o });
const prop = (comp, layer, path, o) => call('prop_set', { comp, layer, path, ...o });
const fx = async (comp, layer, effect, values) => (await call('effect_add', { comp, layer, effect, values })).effect.id;
const span = (comp, layer, a, b) => call('layer_set', { comp, layer, in: a, out: b });
const mirror = (pts) => { const o = []; for (let i = pts.length - 2; i >= 0; i -= 2) o.push(-pts[i], pts[i + 1]); return o; };
const scale = (pts, k, dx = 0, dy = 0) => pts.map((v, i) => (i % 2 ? v * k + dy : v * k + dx));

// ───── silhouettes (own drawings, layer px around the origin) ─────
// standing warrior, front view, fists clenched: 900 px tall, feet at y = 457
const BODY_R = [28, -245, 34, -215, 105, -195, 150, -172, 172, -130, 178, -62, 168, -12, 186, 30, 207, 62, 202, 106, 176, 117, 152, 97, 146, 42, 128, -20, 116, -78, 108, -30, 90, 40, 102, 92, 132, 152, 142, 262, 126, 350, 152, 420, 162, 457, 58, 457, 64, 398, 52, 300, 16, 165];
const BODY = [...BODY_R, ...mirror(BODY_R)];
const HAIR = [-75, -300, -112, -362, -82, -352, -108, -425, -56, -382, -42, -474, -10, -396, 14, -486, 30, -392, 72, -448, 66, -372, 118, -404, 82, -332, 86, -294, 50, -322, 0, -334, -42, -318];
// crouching on the cliff, side view (≈150 px)
const CROUCH = [-55, 0, -60, -35, -45, -62, -20, -75, -5, -82, -10, -100, -2, -118, 6, -146, 18, -122, 30, -152, 35, -120, 54, -136, 45, -105, 60, -97, 41, -80, 31, -70, 41, -50, 56, -30, 50, 0];
// close-up bust shouting (3/4), fills the frame
const BUST = [-30, -90, -70, -62, -250, -12, -330, 60, -360, 200, -370, 650, 370, 650, 370, 300, 300, 205, 336, 120, 300, 55, 246, 88, 206, 40, 126, -28, 96, -70];
const BUST_HAIR = [-120, -262, -232, -334, -132, -332, -222, -472, -92, -402, -62, -562, 10, -422, 82, -562, 102, -412, 202, -502, 160, -372, 262, -382, 182, -302, 202, -232, 122, -272, 20, -302, -62, -282];
const CLIFF = [-370, 180, -300, 122, -150, 104, 0, 96, 130, 110, 262, 150, 332, 232, 300, 330, 370, 400, 370, 650, -370, 650];
const GROUND = [-370, 260, -250, 238, -120, 252, 0, 240, 140, 255, 260, 236, 370, 250, 370, 650, -370, 650];

await call('project_new', { path: PRJ, width: W, height: H, fps: FPS });

/** the warrior: dark body with red rim light, light hair; returns {body, hair} layer ids */
async function warrior(comp, o = {}) {
  const k = o.scale ?? 1;
  const body = await shapeLayer(comp, o.name ?? 'Guerrero', { kind: 'path', path: scale(BODY, k), color: o.body ?? '#22070a' });
  await addShape(comp, body, { kind: 'ellipse', width: 112 * k, height: 132 * k, color: o.body ?? '#22070a', position: [0, -292 * k], name: 'Cabeza' });
  await addShape(comp, body, { kind: 'path', path: scale(HAIR, k), color: o.hair ?? '#ffd9cf', name: 'Pelo' });
  await addShape(comp, body, { kind: 'path', path: scale([18, -300, 46, -292, 40, -284, 20, -288], k), color: o.eyes ?? '#ff4a3a', name: 'Ojos' });
  await addShape(comp, body, { kind: 'path', path: scale([-18, -300, -46, -292, -40, -284, -20, -288], k), color: o.eyes ?? '#ff4a3a', name: 'Ojo izq.' });
  if (o.position) await prop(comp, body, 'position', { value: o.position });
  await fx(comp, body, 'rimLight', { color: o.rim ?? '#ff5a3a', width: 7, softness: 5, intensity: 1.6, halo: o.halo ?? 45, haloOpacity: 85, haloColor: o.haloColor ?? '#ff2a12' });
  return body;
}

// ════════ A · Luna: red moon, cliff, the warrior crouching ════════
await call('comp_new', { name: 'Luna', width: W, height: H, fps: FPS, duration: 3, bg: '#2a0505' });
{
  const C = 'Luna';
  const sky = await solid(C, 'Cielo', '#000000');
  await fx(C, sky, 'gradientRamp', { start: [W / 2, 0], end: [W / 2, H], startColor: '#ff6a3a', endColor: '#5a0806' });
  const moon = await shapeLayer(C, 'Luna', { kind: 'ellipse', width: 1080, height: 1080, color: '#ffffff', position: [0, -170] });
  await fx(C, moon, 'fractalNoise', { scale: 260, complexity: 7, contrast: 170 });
  await prop(C, moon, 'effects.Ruido fractal.evolution', { expression: 'time*25' });
  await fx(C, moon, 'tritone', { high: '#fff3c8', mid: '#f0703a', low: '#9a1c12' });
  await fx(C, moon, 'glow', { threshold: 55, radius: 90, intensity: 1.2 });
  const haze = await solid(C, 'Bruma', '#000000', 'screen');
  await fx(C, haze, 'fractalNoise', { scale: 500, complexity: 4, contrast: 140, brightness: -30 });
  await prop(C, haze, 'effects.Ruido fractal.offset', { expression: '[time*-60, 0]' });
  await fx(C, haze, 'tint', { black: '#000000', white: '#ff4a2a' });
  await prop(C, haze, 'opacity', { value: 35 });
  const cliff = await shapeLayer(C, 'Acantilado', { kind: 'path', path: CLIFF, color: '#070102' });
  const fig = await shapeLayer(C, 'Silueta', { kind: 'path', path: scale(CROUCH, 1.4), color: '#070102', position: [30, 100] });
  // slow push-in on everything, and the light dimming before the cut
  for (const id of [moon, cliff, fig]) await prop(C, id, 'scale', { keys: [{ t: 0, v: [100, 100] }, { t: 3, v: [109, 109] }] });
  const dim = await solid(C, 'Apagar', '#000000');
  await prop(C, dim, 'opacity', { keys: [{ t: 0, v: 0 }, { t: 1.2, v: 0 }, { t: 1.8, v: 70, ease: 'in' }] });
}

// ════════ B · Grito: close-up, backlit, lightning on the body ════════
await call('comp_new', { name: 'Grito', width: W, height: H, fps: FPS, duration: 2, bg: '#200304' });
{
  const C = 'Grito';
  const bg = await solid(C, 'Fondo', '#000000');
  await fx(C, bg, 'fractalNoise', { scale: 420, complexity: 5, contrast: 120 });
  await prop(C, bg, 'effects.Ruido fractal.evolution', { expression: 'time*120' });
  await fx(C, bg, 'tritone', { high: '#c8322a', mid: '#6a0c0a', low: '#1a0203' });
  const bust = await shapeLayer(C, 'Busto', { kind: 'path', path: BUST, color: '#2a0607' });
  await addShape(C, bust, { kind: 'ellipse', width: 230, height: 270, color: '#2a0607', position: [40, -200], name: 'Cabeza' });
  await addShape(C, bust, { kind: 'path', path: BUST_HAIR, color: '#ffb8a4', name: 'Pelo' });
  await addShape(C, bust, { kind: 'path', path: [70, -170, 140, -160, 138, -100, 96, -92, 64, -122], color: '#ff6a4a', name: 'Boca' });
  await addShape(C, bust, { kind: 'path', path: [60, -232, 132, -246, 118, -220, 72, -218], color: '#fff2ea', name: 'Ojo' });
  await fx(C, bust, 'rimLight', { color: '#ffb090', width: 9, softness: 4, intensity: 2, halo: 60, haloOpacity: 90, haloColor: '#ff3a1a' });
  await prop(C, bust, 'scale', { keys: [{ t: 0, v: [118, 118] }, { t: 0.35, v: [100, 100], ease: 'out' }, { t: 2, v: [104, 104] }] });
  await prop(C, bust, 'position', { expression: 'wiggle(18, 9)' });
  const zap = await solid(C, 'Rayos', '#00000000', 'add');
  await fx(C, zap, 'lightning', { origin: [250, 520], end: [470, 1150], segments: 7, jag: 30, branching: 55, width: 2.5, core: '#ffffff', glowColor: '#ff3a2a', glowRadius: 16, flicker: 18, seed: 4 });
  await fx(C, zap, 'lightning', { origin: [560, 760], end: [690, 1000], segments: 6, jag: 35, branching: 40, width: 2, core: '#ffffff', glowColor: '#ff3a2a', glowRadius: 14, flicker: 14, seed: 9 });
  await prop(C, zap, 'opacity', { expression: 'posterizeTime(12); random() > 0.45 ? 100 : 0' });
}

// ════════ C · Onda: ring and spokes in the dark, then a single ember ════════
await call('comp_new', { name: 'Onda', width: W, height: H, fps: FPS, duration: 1.2, bg: '#000000' });
{
  const C = 'Onda';
  const ring = await shapeLayer(C, 'Anillo', { kind: 'ellipse', width: 520, height: 520, color: null, stroke: '#ffd0c4', stroke_width: 10, position: [0, 0] });
  await addShape(C, ring, { kind: 'rect', width: 8, height: 1500, color: '#ffd0c4', name: 'Radio', position: [0, 0] });
  await call('shape_set', { comp: C, layer: ring, shape: 'Radio', repeater: { copies: 3, rotation: 60, position: [0, 0] } });
  await addShape(C, ring, { kind: 'ellipse', width: 34, height: 34, color: '#ffffff', name: 'Centro' });
  await fx(C, ring, 'glow', { threshold: 30, radius: 40, intensity: 2, mode: 'color', color: '#ff4a3a' });
  await prop(C, ring, 'rotation', { keys: [{ t: 0, v: -20 }, { t: 0.5, v: 25, ease: 'out' }] });
  await prop(C, ring, 'scale', { keys: [{ t: 0, v: [140, 140] }, { t: 0.45, v: [60, 60], ease: 'easy' }, { t: 0.55, v: [6, 6], ease: 'in' }] });
  await span(C, ring, 0, 0.56);
  const ember = await shapeLayer(C, 'Brasa', { kind: 'ellipse', width: 90, height: 120, color: '#ffb08a' });
  await fx(C, ember, 'gaussianBlur', { amount: 18 });
  await fx(C, ember, 'glow', { threshold: 10, radius: 70, intensity: 2.5, mode: 'color', color: '#ff2a12' });
  await prop(C, ember, 'opacity', { keys: [{ t: 0.55, v: 100 }, { t: 0.85, v: 0 }] });
  await span(C, ember, 0.55, 0.9);
}

// ════════ D · Pilar: white energy pillar, the warrior inside, rocks rising ════════
await call('comp_new', { name: 'Pilar', width: W, height: H, fps: FPS, duration: 4, bg: '#fff6ec' });
{
  const C = 'Pilar';
  const streaks = await solid(C, 'Vetas', '#000000', 'multiply');
  await fx(C, streaks, 'fractalNoise', { type: 'turbulent', uniform: false, scaleWidth: 110, scaleHeight: 990, complexity: 5, contrast: 160, brightness: 25, invert: true });
  await prop(C, streaks, 'effects.Ruido fractal.offset', { expression: '[0, time*-2200]' });
  await prop(C, streaks, 'effects.Ruido fractal.evolution', { expression: 'time*200' });
  await fx(C, streaks, 'tritone', { high: '#ffffff', mid: '#f6a08c', low: '#c0281e' });
  const fig = await warrior(C, { scale: 0.62, position: [W / 2, 700], body: '#c0301e', hair: '#ffe6dc', eyes: '#ffffff', rim: '#ffffff', halo: 30, haloColor: '#ff6a4a' });
  await prop(C, fig, 'position', { expression: 'wiggle(20, 6)' });
  await fx(C, fig, 'directionalBlur', { angle: 0, length: 18 });
  const rocks = await solid(C, 'Rocas', '#00000000');
  await fx(C, rocks, 'particles', { position: [W / 2, H + 60], radiusX: 420, radiusY: 40, rate: 45, life: 2.6, velocity: 650, direction: 0, spread: 18, gravity: -120, size: 46, sizeVar: 70, colorStart: '#3a0804', colorEnd: '#5a1006', shape: 'shard', spin: 160, warmup: 3, seed: 21, depth: 85, depthBlur: 12, edge: 55, edgeColor: '#ff8a6a', lightAngle: 0, fadeIn: 2, fadeOut: 15, shrink: 0 });
  const glow = await call('layer_add', { comp: C, type: 'adjustment', name: 'Brillo' });
  await fx(C, glow.layer.id, 'glow', { threshold: 70, radius: 60, intensity: 1 });
}

// ════════ E · Cúpula: dome of energy on the horizon, rocks thrown out ════════
await call('comp_new', { name: 'Cupula', width: W, height: H, fps: FPS, duration: 2.5, bg: '#2a0e05' });
{
  const C = 'Cupula';
  const sky = await solid(C, 'Cielo', '#000000');
  await fx(C, sky, 'gradientRamp', { start: [W / 2, 0], end: [W / 2, 900], startColor: '#1a0703', endColor: '#b0501c' });
  const dome = await shapeLayer(C, 'Cúpula', { kind: 'ellipse', width: 1500, height: 1500, position: [0, 245], gradient: { type: 'radial', colors: ['#ffffff', '#fff6d8', '#ffd890'], start: [0, 0], end: [750, 0] } });
  await prop(C, dome, 'scale', { keys: [{ t: 0, v: [4, 4] }, { t: 0.55, v: [72, 72], ease: 'out' }, { t: 2.5, v: [100, 100] }] });
  await fx(C, dome, 'glow', { threshold: 40, radius: 120, intensity: 1.6, mode: 'color', color: '#ffb060' });
  const ground = await shapeLayer(C, 'Suelo', { kind: 'path', path: GROUND, color: '#3a1608' });
  await fx(C, ground, 'fractalNoise', { scale: 90, complexity: 5, contrast: 160 });
  await fx(C, ground, 'tritone', { high: '#8a3a14', mid: '#3a1206', low: '#120402' });
  await fx(C, ground, 'rimLight', { color: '#ffd9a0', mode: 'directional', direction: 0, width: 8, softness: 10, intensity: 1.4 });
  const rocks = await solid(C, 'Rocas', '#00000000');
  await fx(C, rocks, 'particles', { position: [W / 2, 900], birth: 'burst', burstAt: 0.15, rate: 70, life: 3, velocity: 900, direction: 0, spread: 150, gravity: 380, drag: 1.2, size: 40, sizeVar: 75, colorStart: '#1a0603', colorEnd: '#2a0a04', shape: 'shard', spin: 220, radiusX: 120, radiusY: 20, seed: 33, depth: 80, depthBlur: 10, fadeIn: 1, fadeOut: 30, shrink: 0 });
  await call('layer_set', { comp: C, layer: rocks, motion_blur: true });
}

// ════════ F · Llamas: a wall of fire rising from the ground, the warrior inside ════════
await call('comp_new', { name: 'Llamas', width: W, height: H, fps: FPS, duration: 3.5, bg: '#1a0402' });
{
  const C = 'Llamas';
  const fire = await solid(C, 'Fuego', '#000000');
  await fx(C, fire, 'fractalNoise', { type: 'turbulent', uniform: false, scaleWidth: 130, scaleHeight: 494, complexity: 6, contrast: 150, brightness: 10, invert: true });
  await prop(C, fire, 'effects.Ruido fractal.offset', { expression: '[0, time*-1100]' });
  await prop(C, fire, 'effects.Ruido fractal.evolution', { expression: 'time*260' });
  await fx(C, fire, 'tritone', { high: '#fffbe6', mid: '#ff8a20', low: '#3a0702' });
  await call('mask_add', { comp: C, layer: fire, shape: 'ellipse', x: 40, y: 120, width: 640, height: 1500, feather: 160 });
  await fx(C, fire, 'glow', { threshold: 50, radius: 80, intensity: 1.4 });
  const fig = await warrior(C, { scale: 0.42, position: [W / 2, 900], body: '#1a0402', hair: '#ffe8b0', rim: '#ffd27a', halo: 0 });
  await prop(C, fig, 'position', { expression: 'wiggle(16, 4)' });
  const ground = await shapeLayer(C, 'Suelo', { kind: 'path', path: scale(GROUND, 1, 0, 160), color: '#140302' });
  await fx(C, ground, 'rimLight', { color: '#ff7a2a', mode: 'directional', direction: 0, width: 10, softness: 8, intensity: 1.5 });
  const embers = await solid(C, 'Brasas', '#00000000', 'add');
  await fx(C, embers, 'particles', { position: [W / 2, 1000], radiusX: 300, radiusY: 30, rate: 70, life: 1.6, velocity: 500, direction: 0, spread: 30, gravity: -200, size: 7, sizeVar: 60, colorStart: '#fff2b0', colorEnd: '#ff3a0a', shape: 'glow', warmup: 2, seed: 41 });
}

// ════════ G · Haz: beam of light in a red sky, anamorphic streak ════════
await call('comp_new', { name: 'Haz', width: W, height: H, fps: FPS, duration: 2.5, bg: '#5a0806' });
{
  const C = 'Haz';
  const sky = await solid(C, 'Nubes', '#000000');
  await fx(C, sky, 'fractalNoise', { scale: 380, complexity: 6, contrast: 130 });
  await prop(C, sky, 'effects.Ruido fractal.evolution', { expression: 'time*60' });
  await fx(C, sky, 'tritone', { high: '#ff8a5a', mid: '#d0281a', low: '#5a0606' });
  const beam = await solid(C, 'Haz', '#000000', 'add');
  await fx(C, beam, 'fractalNoise', { type: 'turbulent', uniform: false, scaleWidth: 70, scaleHeight: 840, complexity: 4, contrast: 140, invert: true });
  await prop(C, beam, 'effects.Ruido fractal.offset', { expression: '[0, time*-2600]' });
  await fx(C, beam, 'tritone', { high: '#fff4e0', mid: '#ff8a50', low: '#000000' });
  await call('mask_add', { comp: C, layer: beam, shape: 'rect', x: 150, y: 0, width: 420, height: H, feather: 140 });
  const fig = await warrior(C, { scale: 0.6, position: [W / 2, 820], body: '#3a0806', hair: '#fff2ea', rim: '#ffd0b0', halo: 50 });
  await prop(C, fig, 'position', { expression: 'wiggle(14, 5)' });
  const streak = await shapeLayer(C, 'Destello', { kind: 'ellipse', width: 1500, height: 10, color: '#fff6ee', position: [0, -340] });
  await fx(C, streak, 'glow', { threshold: 10, radius: 30, intensity: 2, mode: 'color', color: '#ff7a5a' });
  await prop(C, streak, 'opacity', { expression: '70 + 30*Math.sin(time*40)' });
  const glow = await call('layer_add', { comp: C, type: 'adjustment', name: 'Brillo' });
  await fx(C, glow.layer.id, 'glow', { threshold: 72, radius: 70, intensity: 1.1 });
}

// ════════ H · Flotando: the warrior floating among rocks, hair glowing, sparks ════════
const HDUR = 10.5, FADE = 8.1; // local time the final fade to black starts
await call('comp_new', { name: 'Flotando', width: W, height: H, fps: FPS, duration: HDUR, bg: '#2a0a06' });
{
  const C = 'Flotando';
  const neb = await solid(C, 'Nebulosa', '#000000');
  await fx(C, neb, 'fractalNoise', { scale: 520, complexity: 6, contrast: 110, brightness: -5 });
  await prop(C, neb, 'effects.Ruido fractal.evolution', { expression: 'time*30' });
  await prop(C, neb, 'effects.Ruido fractal.offset', { expression: '[0, time*40]' });
  await fx(C, neb, 'tritone', { high: '#d8683a', mid: '#7a2410', low: '#1a0503' });
  const rays = await shapeLayer(C, 'Luz trasera', { kind: 'ellipse', width: 260, height: 520, color: '#ff8a5a', position: [0, -60] });
  await fx(C, rays, 'gaussianBlur', { amount: 70 });
  await fx(C, rays, 'lightRays', { center: [0, -60], intensity: 140, radius: 120 });
  await prop(C, rays, 'opacity', { expression: '55 + 15*Math.sin(time*3)' });
  const far = await solid(C, 'Rocas lejanas', '#00000000');
  await fx(C, far, 'particles', { position: [W / 2, H + 100], radiusX: 520, radiusY: 60, rate: 22, life: 9, velocity: 150, direction: 0, spread: 30, gravity: -6, drag: 0.2, size: 60, sizeVar: 70, colorStart: '#1e0503', colorEnd: '#1a0402', shape: 'shard', spin: 25, warmup: 9, seed: 51, depth: 90, depthBlur: 6, edge: 60, edgeColor: '#ff6a3a', lightAngle: 0, fadeIn: 4, fadeOut: 10, shrink: 0 });
  const fig = await warrior(C, { scale: 0.7, position: [W / 2, 640], body: '#2a0806', hair: '#ffffff', eyes: '#ff2a1a', rim: '#ff5a3a', halo: 70, haloColor: '#ff2a10' });
  await prop(C, fig, 'position', { expression: 'add(value, [Math.sin(time*1.6)*6, Math.sin(time*2.1)*14])' });
  await prop(C, fig, 'effects.Luz de contorno (contraluz).intensity', { expression: 'posterizeTime(15); 1.4 + random()*0.9' });
  // hair glow: a white copy of the hair, blurred and added
  const hair = await shapeLayer(C, 'Aura del pelo', { kind: 'path', path: scale(HAIR, 0.7), color: '#ffffff' });
  await call('layer_set', { comp: C, layer: hair, parent: fig, blend: 'add' });
  await prop(C, hair, 'position', { value: [0, 0] });
  await fx(C, hair, 'glow', { threshold: 10, radius: 50, intensity: 2.4, mode: 'color', color: '#ffe8f0' });
  await prop(C, hair, 'opacity', { expression: '85 + 15*Math.sin(time*23)' });
  const sparks = await solid(C, 'Chispas', '#00000000', 'add');
  await fx(C, sparks, 'lightning', { origin: [320, 560], end: [300, 900], segments: 6, jag: 40, branching: 50, width: 2, core: '#ffffff', glowColor: '#ff3a1a', glowRadius: 14, flicker: 16, seed: 3 });
  await fx(C, sparks, 'lightning', { origin: [420, 640], end: [440, 960], segments: 6, jag: 40, branching: 40, width: 2, core: '#ffffff', glowColor: '#ff3a1a', glowRadius: 14, flicker: 13, seed: 8 });
  await prop(C, sparks, 'position', { expression: 'add(value, [Math.sin(time*1.6)*6, Math.sin(time*2.1)*14])' });
  await prop(C, sparks, 'opacity', { expression: 'posterizeTime(10); random() > 0.55 ? 100 : 0' });
  const near = await solid(C, 'Rocas cercanas', '#00000000');
  await fx(C, near, 'particles', { position: [W / 2, H + 300], radiusX: 600, radiusY: 60, rate: 1.6, life: 9, velocity: 260, direction: 0, spread: 40, gravity: -4, size: 260, sizeVar: 55, colorStart: '#140302', colorEnd: '#140302', shape: 'shard', spin: 12, warmup: 9, seed: 57, edge: 40, edgeColor: '#5a1408', fadeIn: 1, fadeOut: 5, shrink: 0 });
  await fx(C, near, 'gaussianBlur', { amount: 14 });
  // final: everything goes dark except the hair and the sparks
  const dark = await solid(C, 'Oscuro', '#000000');
  await prop(C, dark, 'opacity', { keys: [{ t: FADE, v: 0 }, { t: FADE + 1.4, v: 100, ease: 'in' }] });
  await call('layer_arrange', { comp: C, action: 'reorder', layers: [dark], index: 5 }); // under the warrior: hair and sparks stay lit
  await prop(C, fig, 'opacity', { keys: [{ t: FADE + 0.6, v: 100 }, { t: FADE + 1.6, v: 0 }] });
}

// ════════ the edit ════════
const MAIN = 'GNX';
await call('comp_new', { name: MAIN, width: W, height: H, fps: FPS, duration: DUR, bg: '#000000' });
/** scene `comp` shown from main time a to b, starting at its local time `from` */
async function shot(comp, a, b, from = 0, o = {}) {
  const id = (await call('layer_add', { comp: MAIN, type: 'comp', comp_id: comp, name: `${comp} ${a}` })).layer.id;
  await call('layer_set', { comp: MAIN, layer: id, start: a - from, in: a, out: b });
  if (o.shake) await prop(MAIN, id, 'position', { expression: `wiggle(${o.shakeFreq ?? 14}, ${o.shake})` });
  if (o.scale) await prop(MAIN, id, 'scale', { value: [o.scale, o.scale] });
  return id;
}
await shot('Luna', 0, 1.85);
await shot('Grito', 1.85, 3.2, 0, { shake: 6 });
await shot('Onda', 3.2, 4.2);
const pillar = await shot('Pilar', 4.2, 8.0, 0, { shake: 12, scale: 106 });
// last part of the pillar: tilted camera, faster
await prop(MAIN, pillar, 'rotation', { keys: [{ t: 7.1, v: 0, ease: 'hold' }, { t: 7.12, v: -14 }] });
await prop(MAIN, pillar, 'scale', { keys: [{ t: 7.1, v: [106, 106], ease: 'hold' }, { t: 7.12, v: [128, 128] }, { t: 8, v: [138, 138] }] });
await shot('Cupula', 8.0, 9.45, 0, { shake: 8 });
await shot('Cupula', 9.65, 10.6, 1.2, { shake: 4 });
const dim = await shot('Flotando', 10.6, 11.5, 0, { shake: 3 });
await prop(MAIN, dim, 'opacity', { expression: 'posterizeTime(8); random() > 0.4 ? 100 : 25' });
await shot('Llamas', 11.5, 14.1, 0, { shake: 7 });
await shot('Haz', 14.75, 16.95, 0, { shake: 8 });
const teal = await shot('Luna', 16.95, 17.5, 1.0, { scale: 115 });
await fx(MAIN, teal, 'tint', { black: '#001014', white: '#9fe8e0', amount: 60 });
await shot('Llamas', 17.5, 18.4, 1.5, { shake: 9 });
await shot('Cupula', 18.4, 19.0, 0.9, { shake: 6 });
const fin = await shot('Flotando', 19.0, DUR, 1.5);
await prop(MAIN, fin, 'scale', { keys: [{ t: 19, v: [112, 112] }, { t: 21, v: [100, 100], ease: 'easy' }, { t: DUR, v: [106, 106] }] });
await prop(MAIN, fin, 'position', { expression: `wiggle(10, time < 21 ? 6 : 2.5)` });

// white flashes on the hits, inverted (teal) strobes in the tilted pillar
const HITS = [1.85, 3.2, 4.2, 8.0, 9.65, 11.5, 14.75, 17.5, 18.4, 19.0];
const flash = await solid(MAIN, 'Flash', '#fff8f2', 'screen');
const fk = [{ t: 0, v: 0, ease: 'hold' }];
for (const t of HITS) fk.push({ t, v: 100 }, { t: t + 0.22, v: 0, ease: 'hold' });
await prop(MAIN, flash, 'opacity', { keys: fk });
const inv = await call('layer_add', { comp: MAIN, type: 'adjustment', name: 'Estrobo' });
await fx(MAIN, inv.layer.id, 'invert', {});
await fx(MAIN, inv.layer.id, 'tint', { black: '#03191a', white: '#8fd8cc', amount: 70 });
await span(MAIN, inv.layer.id, 7.1, 8.0);
await prop(MAIN, inv.layer.id, 'opacity', { keys: [7.1, 7.18, 7.5, 7.56, 7.8, 7.85].map((t, i) => ({ t, v: i % 2 ? 0 : 100, ease: 'hold' })) });
// grade over everything: warm glow, chromatic edges on the hits, grain and vignette
const grade = (await call('layer_add', { comp: MAIN, type: 'adjustment', name: 'Grado' })).layer.id;
await fx(MAIN, grade, 'chromaticAberration', { amount: 0 });
await prop(MAIN, grade, 'effects.Aberración cromática.amount', { keys: [{ t: 0, v: 0 }, ...HITS.flatMap((t) => [{ t: t - 0.01, v: 0 }, { t, v: 14 }, { t: t + 0.3, v: 0 }])] });
await fx(MAIN, grade, 'vignette', { amount: 55 });
await fx(MAIN, grade, 'noise', { amount: 7 });

// ───── sound: the trap beat, a riser into each big hit, booms, rumble and electric zaps ─────
const gen = async (kind, name, dur, file) => (await call('media_generate', { kind, name, duration: dur, output: join(out, file) })).path;
const audio = async (path, at, level) => { const l = await call('layer_add', { comp: MAIN, type: 'audio', media_path: path, start: at }); await prop(MAIN, l.layer.id, 'audio.level', { value: level }); return l.layer.id; };
const beat = await audio(await gen('music', 'trap', DUR, 'trap.wav'), 0, -5);
for (const [a, d] of [[2.4, 1.8], [12.9, 1.85]]) await audio(await gen('sfx', 'riser', d, `riser-${a}.wav`), a, -8);
const boom = await gen('sfx', 'boom', 2, 'boom.wav');
for (const t of [1.85, 4.2, 8.0, 14.75, 19.0]) await audio(boom, t - 0.01, -3);
const imp = await gen('sfx', 'impact', 0.6, 'impact.wav');
for (const t of [3.2, 9.65, 11.5, 17.5, 18.4]) await audio(imp, t - 0.01, -6);
await audio(await gen('sfx', 'rumble', 3.6, 'rumble-a.wav'), 4.2, -6);
await audio(await gen('sfx', 'rumble', 2.6, 'rumble-b.wav'), 11.5, -8);
const zap = await gen('sfx', 'zap', 0.7, 'zap.wav');
for (const t of [2.0, 2.6, 20.2, 21.7, 23.1, 24.4]) await audio(zap, t, -12);
void beat;

console.log(`${calls} llamadas MCP`);
const times = [0.6, 1.5, 2.2, 3.35, 3.85, 5.0, 7.3, 8.3, 9.0, 10.0, 11.0, 12.5, 15.5, 17.2, 17.9, 18.6, 20.0, 23.0, 26.0, 27.2];
for (const t of times) await call('comp_frame', { comp: MAIN, time: t, width: 360, output: join(out, `f_${t.toFixed(2).replace('.', '_')}.png`) });
if (!framesOnly) {
  const t0 = Date.now();
  const r = await call('comp_render', { comp: MAIN, output: join(out, 'gnx.mp4') });
  console.log(`render: ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(r).slice(0, 200));
}
await client.close();
