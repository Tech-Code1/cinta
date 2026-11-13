// Demo: After Effects' Glow options in Cinta — composite original (behind / on top / none), operations and the
// A & B colour table (looping, loops, phase, midpoint). One text per cell. Built only with MCP calls.
//   node scripts/demo-resplandor.mjs <work dir> [--exe=<Cinta.exe>]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-resplandor'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
const PRJ = join(out, 'resplandor.cinta');
async function call(name, a = {}) {
  const r = await client.callTool({ name, arguments: { project: PRJ, ...a } }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}
const C = 'Resplandor', W = 1200, H = 800;
await call('project_new', { path: PRJ, width: W, height: H, fps: 30 });
await call('comp_new', { name: C, width: W, height: H, fps: 30, duration: 1, bg: '#101218' });
const cells = [
  ['Detrás (por defecto)', {}],
  ['Encima', { composite: 'onTop' }],
  ['Ninguno', { composite: 'none', operation: 'none' }],
  ['Trama', { operation: 'screen' }],
  ['A y B', { mode: 'ab', color: '#ffe066', colorB: '#ff2a6d', intensity: 2 }],
  ['A y B · 3 bucles', { mode: 'ab', color: '#00e5ff', colorB: '#7c3aed', loops: 3, intensity: 2 }],
  ['A y B · fase 120°', { mode: 'ab', color: '#ffe066', colorB: '#ff2a6d', phase: 120, intensity: 2 }],
  ['Basado en alfa', { basedOn: 'alpha', mode: 'color', color: '#36c48f' }],
];
for (let i = 0; i < cells.length; i++) {
  const [label, values] = cells[i];
  const x = 150 + (i % 4) * 300, y = 230 + Math.floor(i / 4) * 360;
  const t = (await call('layer_add', { comp: C, type: 'text', text: 'GLOW', size: 96, color: '#ffb86b' })).layer.id;
  await call('prop_set', { comp: C, layer: t, path: 'position', value: [x, y] });
  await call('effect_add', { comp: C, layer: t, effect: 'glow', values: { radius: 60, threshold: 30, ...values } });
  const l = (await call('layer_add', { comp: C, type: 'text', text: label, size: 22, color: '#c9d1e0' })).layer.id;
  await call('prop_set', { comp: C, layer: l, path: 'position', value: [x, y + 110] });
}
await call('comp_frame', { comp: C, time: 0, width: W, output: join(out, 'resplandor.png') });
console.log(join(out, 'resplandor.png'));
await client.close();
