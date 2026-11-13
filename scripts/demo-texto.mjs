// Demo: text on a path (around a circle, along a wave, running with the first margin) and paragraph text that wraps
// inside a box. Built only with MCP calls.
//   node scripts/demo-texto.mjs <work dir> [--exe=<Cinta.exe>]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = resolve(args[0] ?? join(root, 'demo-texto'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
const PRJ = join(out, 'texto.cinta');
async function call(name, a = {}) {
  const r = await client.callTool({ name, arguments: { project: PRJ, ...a } }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}
const C = 'Texto', W = 1280, H = 720;
await call('project_new', { path: PRJ, width: W, height: H, fps: 30 });
await call('comp_new', { name: C, width: W, height: H, fps: 30, duration: 3, bg: '#14161c' });
// around a circle
const ring = (await call('layer_add', { comp: C, type: 'text', text: 'CINTA · TEXTO EN TRAZADO · CINTA · TEXTO EN TRAZADO ·', size: 34, color: '#ffd400' })).layer.id;
await call('prop_set', { comp: C, layer: ring, path: 'position', value: [300, 360] });
await call('mask_add', { comp: C, layer: ring, shape: 'ellipse', x: -190, y: -190, width: 380, height: 380, name: 'Círculo' });
await call('layer_set', { comp: C, layer: ring, text_style: { align: 'left', path: { mask: 'Círculo' } } });
await call('prop_set', { comp: C, layer: ring, path: 'text.path.firstMargin', keys: [{ t: 0, v: 0 }, { t: 3, v: 600 }] });
// along a wave
const wave = (await call('layer_add', { comp: C, type: 'text', text: 'olas de texto que siguen la curva', size: 40, color: '#00c2d1' })).layer.id;
await call('prop_set', { comp: C, layer: wave, path: 'position', value: [900, 200] });
await call('mask_add', { comp: C, layer: wave, shape: 'path', bezier: true, path: [-300, 20, 0, 0, 80, -90, 0, 20, -80, 90, 80, -90, 300, 20, -80, 90, 0, 0], name: 'Ola' });
await call('layer_set', { comp: C, layer: wave, text_style: { align: 'center', path: { mask: 'Ola', open: true } } });
// paragraph box
const para = (await call('layer_add', { comp: C, type: 'text', text: 'Un párrafo dentro de una caja: las palabras pasan solas a la línea siguiente al llegar al borde, y lo que no cabe en la altura se oculta, como el texto de párrafo de After Effects.', size: 28, color: '#e8eaf0' })).layer.id;
await call('prop_set', { comp: C, layer: para, path: 'position', value: [900, 480] });
await call('layer_set', { comp: C, layer: para, text_style: { align: 'left', box: [460, 200] } });
const frame = (await call('shape_add', { comp: C, kind: 'rect', width: 460, height: 200, color: null, stroke: '#4aa8ff', stroke_width: 2, position: [900 - W / 2, 480 - H / 2] })).layer.id;
void frame;
await call('comp_frame', { comp: C, time: 1, width: W, output: join(out, 'texto.png') });
console.log(join(out, 'texto.png'));
await client.close();
