// Demo: the puppet tool — a character (one shape layer) with pins on its feet that stay, a hand that waves and a
// head that sways, plus a flag (solid with a gradient) that ripples from two moving pins. Built only with MCP calls.
//   node scripts/demo-marioneta.mjs <work dir> [--exe=<Cinta.exe>] [--video]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-marioneta'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
const PRJ = join(out, 'marioneta.cinta');
async function call(name, a = {}) {
  const r = await client.callTool({ name, arguments: { project: PRJ, ...a } }, undefined, { timeout: 900000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}
const C = 'Marioneta', W = 1280, H = 720, DUR = 3;
await call('project_new', { path: PRJ, width: W, height: H, fps: 30 });
await call('comp_new', { name: C, width: W, height: H, fps: 30, duration: DUR, bg: '#1b2030' });

// a character: body (arms down a little) + head, centred at (440, 380), 600 px tall
const R = [28, -245, 34, -215, 105, -195, 150, -172, 172, -130, 190, -60, 205, 10, 225, 80, 240, 130, 222, 150, 196, 120, 170, 50, 148, -20, 116, -78, 108, -30, 90, 40, 102, 92, 132, 152, 142, 262, 126, 350, 152, 420, 162, 457, 58, 457, 64, 398, 52, 300, 16, 165];
const mirror = (p) => { const o = []; for (let i = p.length - 2; i >= 0; i -= 2) o.push(-p[i], p[i + 1]); return o; };
const k = 0.65, body = [...R, ...mirror(R)].map((v) => v * k);
const ch = await call('shape_add', { comp: C, kind: 'path', path: body, color: '#ff8a3d', name: 'Personaje', position: [440 - W / 2, 380 - H / 2] });
await call('shape_add', { comp: C, layer: ch.layer.id, kind: 'ellipse', width: 75, height: 88, color: '#ff8a3d', position: [440 - W / 2, 380 - 190 - H / 2] });
await call('layer_style', { comp: C, layer: ch.layer.id, style: 'stroke', values: { color: '#ffffff', size: 4 } });
const at = (x, y) => [440 + x * k, 380 + y * k];
const pin = async (name, x, y) => (await call('puppet_pin', { comp: C, layer: ch.layer.id, action: 'add', at: at(x, y), name })).pin.name;
for (const [n, x, y] of [['Pie izq.', -110, 440], ['Pie der.', 110, 440], ['Cadera', 0, 150]]) await pin(n, x, y);
await pin('Mano', 230, 140);
await pin('Cabeza', 0, -292);
await pin('Mano izq.', -230, 140);
// the right hand goes up and waves; the head sways; the left hand swings a little
const wave = [[0, [230, 140]], [0.7, [250, -260]], [1.1, [330, -330]], [1.5, [200, -330]], [1.9, [330, -330]], [2.3, [200, -330]], [3, [250, -260]]];
for (const [t, [x, y]] of wave) await call('puppet_pin', { comp: C, layer: ch.layer.id, action: 'move', pin: 'Mano', to: at(x, y), t, ease: 'easy' });
for (const [t, x] of [[0, 0], [1, 30], [2, -25], [3, 10]]) await call('puppet_pin', { comp: C, layer: ch.layer.id, action: 'move', pin: 'Cabeza', to: at(x, -292), t, ease: 'easy' });
for (const [t, x] of [[0, -230], [1.5, -260], [3, -230]]) await call('puppet_pin', { comp: C, layer: ch.layer.id, action: 'move', pin: 'Mano izq.', to: at(x, 150), t, ease: 'easy' });

// a flag: a gradient solid pinned at the pole, its free corners rippling
const flag = (await call('layer_add', { comp: C, type: 'solid', color: '#ffffff', width: 360, height: 220, name: 'Bandera' })).layer.id;
await call('effect_add', { comp: C, layer: flag, effect: 'gradientRamp', values: { start: [0, 0], end: [360, 220], startColor: '#e8455a', endColor: '#6c5ce7' } });
await call('effect_add', { comp: C, layer: flag, effect: 'grid', values: { sizeFrom: 'width', blendMode: 'normal', size: 40, width: 2, opacity: 35 } });
await call('prop_set', { comp: C, layer: flag, path: 'position', value: [1000, 250] });
await call('puppet_pin', { comp: C, layer: flag, action: 'set', density: 10 });
for (const [n, x, y] of [['Asta arriba', 0, 0], ['Asta abajo', 0, 220], ['Arriba', 360, 0], ['Abajo', 360, 220], ['Centro', 180, 110]]) await call('puppet_pin', { comp: C, layer: flag, action: 'add', at: [x, y], name: n, layer_space: true });
for (let i = 0; i <= 6; i++) {
  const t = (i / 6) * DUR, s = Math.sin(i * 1.7);
  await call('puppet_pin', { comp: C, layer: flag, action: 'move', pin: 'Arriba', to: [350, 0 + s * 30], t, layer_space: true, ease: 'easy' });
  await call('puppet_pin', { comp: C, layer: flag, action: 'move', pin: 'Abajo', to: [345, 220 - Math.cos(i * 1.7) * 26], t, layer_space: true, ease: 'easy' });
  await call('puppet_pin', { comp: C, layer: flag, action: 'move', pin: 'Centro', to: [180, 110 + Math.cos(i * 1.3) * 22], t, layer_space: true, ease: 'easy' });
}
const pole = await call('shape_add', { comp: C, kind: 'rect', width: 12, height: 420, color: '#c9d1e0', position: [820 - W / 2, 330 - H / 2] });
void pole;
for (const t of [0, 1.1, 2.3]) await call('comp_frame', { comp: C, time: t, width: 960, output: join(out, `f_${String(t).replace('.', '_')}.png`) });
if (process.argv.includes('--video')) await call('comp_render', { comp: C, output: join(out, 'marioneta.mp4') });
console.log(out);
await client.close();
