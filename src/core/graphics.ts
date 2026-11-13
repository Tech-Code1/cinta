// Own stickers/callouts (SVG) rasterized with resvg — works without a window (MCP, tests).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CALLOUTS, STICKERS, findIn, type GraphicDef } from './catalog';

export const cacheDir = (sub = '') => {
  const d = join(process.env.CINTA_CACHE ?? join(tmpdir(), 'cinta-cache'), sub);
  mkdirSync(d, { recursive: true });
  return d;
};

/** Size cap of the motion cache (rendered comps, sequences and mixes for the simple timeline), in GB. */
export const motionCacheCap = () => Math.max(0.5, Number(process.env.CINTA_MOTION_CACHE_GB) || 5) * 2 ** 30;
/** Drops the least recently used files of the motion cache beyond `cap` bytes. Files used in the last `keepMs`
 * are always kept (an open project may point at them); the rest are re-rendered when needed again. */
export function pruneMotionCache(cap = motionCacheCap(), keepMs = 2 * 864e5): { removed: number; bytes: number } {
  const dir = cacheDir('motion');
  const files = readdirSync(dir).flatMap((n) => {
    try { const st = statSync(join(dir, n)); return st.isFile() ? [{ p: join(dir, n), size: st.size, used: st.mtimeMs }] : []; } catch { return []; }
  }).sort((a, b) => b.used - a.used);
  let total = files.reduce((s, f) => s + f.size, 0), removed = 0, bytes = 0;
  for (const f of files.reverse()) {
    if (total <= cap) break;
    if (Date.now() - f.used < keepMs) continue;
    try { rmSync(f.p, { force: true }); total -= f.size; bytes += f.size; removed++; } catch { /* in use */ }
  }
  return { removed, bytes };
}
let lastPrune = 0;
/** Path of a motion-cache file. An existing one is marked as just used; before a new one is written the cache is
 * trimmed to its cap (at most once a minute). */
export function motionCached(name: string): string {
  const p = join(cacheDir('motion'), name);
  try {
    if (existsSync(p)) { const now = new Date(); utimesSync(p, now, now); }
    else if (Date.now() - lastPrune > 6e4) { lastPrune = Date.now(); pruneMotionCache(); }
  } catch { /* best effort */ }
  return p;
}
/** Marks a motion-cache file as used (projects keep pointing at their rendered comps). */
export function touchCached(p: string) {
  try { const now = new Date(); utimesSync(p, now, now); } catch { /* gone */ }
}

type Resvg = new (svg: string, opts: object) => { render(): { asPng(): Buffer; width: number; height: number } };
let ResvgCtor: Resvg | null = null;
function resvg(): Resvg {
  if (!ResvgCtor) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ResvgCtor = (require('@resvg/resvg-js') as { Resvg: Resvg }).Resvg;
  }
  return ResvgCtor;
}

export function graphicDef(kind: 'sticker' | 'callout', id: string): GraphicDef {
  return findIn(kind === 'sticker' ? STICKERS : CALLOUTS, id, kind === 'sticker' ? 'Adhesivo' : 'Llamada');
}

/** Renders an SVG string to a PNG `height` pixels tall (cached by content). Returns path + size. */
export function svgToPng(svg: string, height: number): { path: string; width: number; height: number } {
  const h = Math.max(8, Math.round(height));
  const key = createHash('sha1').update(svg).update(String(h)).digest('hex').slice(0, 16);
  const path = join(cacheDir('graphics'), `${key}.png`);
  const R = resvg();
  const img = new R(svg, { fitTo: { mode: 'height', value: h }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render();
  if (!existsSync(path)) writeFileSync(path, img.asPng());
  return { path, width: img.width, height: img.height };
}

export function renderGraphic(kind: 'sticker' | 'callout', id: string, color: string | undefined, height: number) {
  const def = graphicDef(kind, id);
  return svgToPng(def.svg(color), height);
}
