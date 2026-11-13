// Demo: the layer styles (drop shadow, inner shadow, outer / inner glow, bevel & emboss, colour and gradient
// overlays, stroke) on text and shapes, one per cell. Built only with MCP calls.
//   node scripts/demo-estilos.mjs <work dir> [--exe=<Cinta.exe>]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-estilos'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
const PRJ = join(out, 'estilos.cinta');
async function call(name, a = {}) {
  const r = await client.callTool({ name, arguments: { project: PRJ, ...a } }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}
const C = 'Estilos', W = 1200, H = 800;
await call('project_new', { path: PRJ, width: W, height: H, fps: 30 });
await call('comp_new', { name: C, width: W, height: H, fps: 30, duration: 1, bg: '#5b6274' });
const bg = (await call('layer_add', { comp: C, type: 'solid', color: '#000000', width: W, height: H })).layer.id;
await call('effect_add', { comp: C, layer: bg, effect: 'gradientRamp', values: { start: [0, 0], end: [W, H], startColor: '#7b8396', endColor: '#3c4252' } });
const cells = [
  ['dropShadow', 'Sombra', { distance: 14, size: 12, opacity: 80 }],
  ['innerShadow', 'Interior', { distance: 8, size: 10, opacity: 90 }],
  ['outerGlow', 'Resplandor', { color: '#ffd400', size: 26, spread: 20, opacity: 90 }],
  ['innerGlow', 'Brillo int.', { color: '#ffffff', size: 18, opacity: 90 }],
  ['bevel', 'Bisel', { size: 14, depth: 160, soften: 1 }],
  ['colorOverlay', 'Color', { color: '#36c48f' }],
  ['gradientOverlay', 'Degradado', { startColor: '#ff5fa2', endColor: '#ffd400', angle: 90 }],
  ['stroke', 'Trazo', { color: '#ffffff', size: 6, position: 'outside' }],
];
for (let i = 0; i < cells.length; i++) {
  const [style, label, values] = cells[i];
  const x = 150 + (i % 4) * 300, y = 220 + Math.floor(i / 4) * 360;
  const t = (await call('layer_add', { comp: C, type: 'text', text: label, size: 64, color: '#e8455a' })).layer.id;
  await call('prop_set', { comp: C, layer: t, path: 'position', value: [x, y - 40] });
  await call('layer_style', { comp: C, layer: t, style, values });
  const s = await call('shape_add', { comp: C, kind: 'star', points: 5, width: 150, inner_radius: 34, color: '#1d6cff', position: [x - W / 2, y + 90 - H / 2] });
  await call('layer_style', { comp: C, layer: s.layer.id, style, values });
}
await call('comp_frame', { comp: C, time: 0, width: W, output: join(out, 'estilos.png') });
console.log(join(out, 'estilos.png'));
await client.close();
