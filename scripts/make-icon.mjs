// Draws Cinta's own logo (a film-strip ribbon with a play mark on a blue squircle) to build/icon.png.
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a8cff"/><stop offset="1" stop-color="#6a3cf0"/></linearGradient>
    <linearGradient id="rib" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe7ff"/></linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#bg)"/>
  <path d="M40 96 Q128 60 216 96 L216 172 Q128 136 40 172 Z" fill="url(#rib)"/>
  ${Array.from({ length: 7 }, (_, i) => { const x = 54 + i * 24; const t = (x - 40) / 176; const y = 96 - Math.sin(Math.PI * t) * 26; return `<rect x="${x}" y="${y + 6}" width="12" height="9" rx="2" fill="#4a5bd8"/><rect x="${x}" y="${y + 59}" width="12" height="9" rx="2" fill="#4a5bd8"/>`; }).join('')}
  <path d="M112 104 L152 124 L112 144 Z" fill="#4a5bd8"/>
</svg>`;
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng());
console.log('build/icon.png');
