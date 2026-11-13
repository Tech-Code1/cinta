// Bundles the Electron main process, the preload script, the MCP server and the core library.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: ['electron', '@resvg/resvg-js', 'sherpa-onnx-node', 'ffmpeg-static', '@ffprobe-installer/win32-x64'],
  logLevel: 'warning',
};

await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' }),
  // stdio MCP server, run as plain Node (ELECTRON_RUN_AS_NODE) — no Electron APIs
  build({ ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/main/mcp.js' }),
  // core library for tests and scripts
  build({ ...common, entryPoints: ['src/core/index.ts'], outfile: 'dist/core/index.js' }),
]);
