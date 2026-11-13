// Demo: the shape path operators (pucker & bloat, round corners, offset, twist, merge paths, gradient stroke) on a
// grid of shapes, so they can be compared at a glance. Built only with MCP calls.
//   node scripts/demo-formas.mjs <work dir> [--exe=<Cinta.exe>]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-formas'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
const PRJ = join(out, 'formas.cinta');
async function call(name, a = {}) {
  const r = await client.callTool({ name, arguments: { project: PRJ, ...a } }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}
const C = 'Formas';
await call('project_new', { path: PRJ, width: 1200, height: 800, fps: 30 });
await call('comp_new', { name: C, width: 1200, height: 800, fps: 30, duration: 2, bg: '#14161c' });
// one cell per operator: [label, column, row, shape options]
const cell = (col, row) => [-450 + col * 300, -230 + row * 380];
const label = async (text, col, row) => { const [x, y] = cell(col, row); const l = await call('layer_add', { comp: C, type: 'text', text, size: 26, color: '#c9d1e0' }); await call('prop_set', { comp: C, layer: l.layer.id, path: 'position', value: [600 + x, 400 + y + 150] }); };
const shape = async (col, row, o) => { const [x, y] = cell(col, row); return call('shape_add', { comp: C, position: [x, y], ...o }); };

await shape(0, 0, { kind: 'polygon', points: 5, width: 200, color: '#ff8a3d', pucker: { amount: 60 } }); await label('Engordar +60', 0, 0);
await shape(1, 0, { kind: 'polygon', points: 5, width: 200, color: '#36c48f', pucker: { amount: -60 } }); await label('Contraer −60', 1, 0);
await shape(2, 0, { kind: 'star', points: 5, width: 220, inner_radius: 50, color: '#1d6cff', round_corners: { radius: 22 } }); await label('Redondear esquinas', 2, 0);
await shape(3, 0, { kind: 'rect', width: 160, height: 160, color: '#e8455a', twist: { angle: 160 } }); await label('Torcer 160°', 3, 0);
const off = await shape(0, 1, { kind: 'star', points: 6, width: 200, inner_radius: 55, color: '#6c5ce7' });
await call('shape_add', { comp: C, layer: off.layer.id, kind: 'star', points: 6, width: 200, inner_radius: 55, color: null, stroke: '#ffd400', stroke_width: 4, offset: { amount: 22, join: 'round' }, position: cell(0, 1) });
await label('Desplazar +22 (redondo)', 0, 1);
// merge paths: two circles, each mode
const modes = [['add', 'Combinar: sumar'], ['subtract', 'Combinar: restar'], ['intersect', 'Combinar: intersecar']];
for (let i = 0; i < 3; i++) {
  const [x, y] = cell(i + 1, 1);
  const m = await call('shape_add', { comp: C, kind: 'ellipse', width: 150, color: '#ffffff', position: [x - 45, y] });
  await call('shape_add', { comp: C, layer: m.layer.id, kind: 'ellipse', width: 150, color: '#ffffff', position: [x + 45, y] });
  await call('shape_add', { comp: C, layer: m.layer.id, kind: 'merge', merge_mode: modes[i][0], color: '#00c2d1', stroke: '#ffffff', stroke_width: 3 });
  await label(modes[i][1], i + 1, 1);
}
const gs = await call('shape_add', { comp: C, kind: 'ellipse', width: 1000, height: 40, color: null, stroke: '#ffffff', stroke_width: 6, stroke_gradient: { colors: ['#ff5fa2', '#ffd400', '#00c2d1'] }, position: [0, 360] });
void gs;
await call('comp_frame', { comp: C, time: 0, width: 1200, output: join(out, 'formas.png') });
console.log(join(out, 'formas.png'));
await client.close();
