// Demo: 3D lights — a floor and a back wall, three cards floating at different depths that cast shadows, a spot
// light that sweeps across, a warm point light, ambient fill and a camera with depth of field focused on the
// middle card. Built only with MCP calls.
//   node scripts/demo-luces.mjs <work dir> [--exe=<Cinta.exe>] [--video]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-luces'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
const PRJ = join(out, 'luces.cinta');
async function call(name, a = {}) {
  const r = await client.callTool({ name, arguments: { project: PRJ, ...a } }, undefined, { timeout: 900000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}
const C = 'Luces', W = 1280, H = 720, DUR = 4;
const prop = (layer, path, o) => call('prop_set', { comp: C, layer, path, ...o });
await call('project_new', { path: PRJ, width: W, height: H, fps: 30 });
await call('comp_new', { name: C, width: W, height: H, fps: 30, duration: DUR, bg: '#000000' });

// floor (lying flat) and back wall
const floor = (await call('layer_add', { comp: C, type: 'solid', name: 'Suelo', color: '#8a8f9c', width: 2400, height: 2400 })).layer.id;
await call('layer_set', { comp: C, layer: floor, three_d: true });
await prop(floor, 'position', { value: [W / 2, 560, 700] });
await prop(floor, 'rotationX', { value: 90 });
await call('effect_add', { comp: C, layer: floor, effect: 'grid', values: { sizeFrom: 'width', blendMode: 'normal', size: 120, width: 2, color: '#ffffff', opacity: 25 } });
const wall = (await call('layer_add', { comp: C, type: 'solid', name: 'Pared', color: '#a9aebb', width: 2600, height: 1400 })).layer.id;
await call('layer_set', { comp: C, layer: wall, three_d: true });
await prop(wall, 'position', { value: [W / 2, 0, 1500] });

// three cards at different depths, casting shadows
const cards = [['#e8455a', -330, 250, 'A'], ['#ffd400', 0, 700, 'B'], ['#1d6cff', 330, 1150, 'C']];
for (const [color, dx, z, txt] of cards) {
  const id = (await call('shape_add', { comp: C, kind: 'rect', width: 260, height: 340, roundness: 24, color, name: `Tarjeta ${txt}` })).layer.id;
  await call('shape_add', { comp: C, layer: id, kind: 'star', points: 5, width: 150, inner_radius: 34, color: '#ffffff', position: [0, 0] });
  await call('layer_set', { comp: C, layer: id, three_d: true, material: { casts_shadows: 'on' } });
  await prop(id, 'position', { value: [W / 2 + dx, 330, z] });
  await prop(id, 'rotationY', { keys: [{ t: 0, v: -25 }, { t: DUR, v: 25, ease: 'easy' }] });
  await prop(id, 'material.specular', { value: 80 });
  await prop(id, 'material.shininess', { value: 40 });
}

// lights: a sweeping spot with soft shadows, a warm point light, ambient fill
const spot = (await call('layer_add', { comp: C, type: 'light', light_type: 'spot', name: 'Foco' })).layer.id;
await call('layer_set', { comp: C, layer: spot, light: { casts_shadows: true } });
await prop(spot, 'position', { keys: [{ t: 0, v: [100, -500, -300] }, { t: DUR, v: [1180, -500, -300], ease: 'easy' }] });
await prop(spot, 'light.poi', { value: [W / 2, 450, 800] });
await prop(spot, 'light.coneAngle', { value: 110 });
await prop(spot, 'light.coneFeather', { value: 60 });
await prop(spot, 'light.intensity', { value: 140 });
await prop(spot, 'light.shadowDarkness', { value: 70 });
await prop(spot, 'light.shadowDiffusion', { value: 14 });
const warm = (await call('layer_add', { comp: C, type: 'light', light_type: 'point', name: 'Cálida', color: '#ff9a4a' })).layer.id;
await call('layer_set', { comp: C, layer: warm, light: { falloff: 'smooth' } });
await prop(warm, 'position', { value: [W - 120, 420, 600] });
await prop(warm, 'light.radius', { value: 200 });
await prop(warm, 'light.falloffDistance', { value: 700 });
await prop(warm, 'light.intensity', { value: 80 });
const amb = (await call('layer_add', { comp: C, type: 'light', light_type: 'ambient', name: 'Ambiente', color: '#7f8fb0' })).layer.id;
await prop(amb, 'light.intensity', { value: 40 });

// camera with depth of field on the middle card
const cam = (await call('layer_add', { comp: C, type: 'camera', name: 'Cámara' })).layer.id;
await prop(cam, 'position', { value: [W / 2, 180, -900] });
await prop(cam, 'camera.poi', { value: [W / 2, 380, 700] });
await call('layer_set', { comp: C, layer: cam, dof: true });
const camZ = 900 + 700;
await prop(cam, 'camera.dof.focus', { value: Math.round(Math.hypot(camZ, 200)) });
await prop(cam, 'camera.dof.aperture', { value: 40 });

for (const t of [0.5, 2, 3.5]) await call('comp_frame', { comp: C, time: t, width: 960, output: join(out, `f_${String(t).replace('.', '_')}.png`) });
if (process.argv.includes('--video')) await call('comp_render', { comp: C, output: join(out, 'luces.mp4') });
console.log(out);
await client.close();
