import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), render: resolve(__dirname, 'src/renderer/render.html') } },
  },
});
