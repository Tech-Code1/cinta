// Disk cache of preview frames (After Effects' Disk Cache): frames rendered for the preview are kept as PNG
// files keyed by everything that decides their pixels — the comp and the comps it nests, the media files they
// use (path, size, date), the frame, the preview resolution, motion-blur samples, proxy use and the engine — so
// a frame is reused after restarting, and after an undo brings back an earlier state; any change gives new
// keys, so a stale frame is never shown. Least recently used frames go first when the folder passes its size.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './model';
import { compHash } from './motion-io';
import { findComp } from './motion/model';

export interface FrameOpts { res: number; mbSamples?: number; proxies?: string }

export class DiskCache {
  private bases = new Map<string, string>();
  private bytes = -1;
  private puts = 0;
  constructor(public dir: string, public maxBytes: number, private engine: string) { mkdirSync(dir, { recursive: true }); }

  /** Call when the project changed (keys are memoised per comp until then). */
  invalidate() { this.bases.clear(); }

  /** Key part shared by every frame of a comp in the project's current state. */
  private base(p: Project, compId: string): string {
    let b = this.bases.get(compId);
    if (b) return b;
    // media files of the comp and of the comps it nests: a file changed on disk is a different input
    const files: string[] = [], seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const l of findComp(p.comps, id).layers) {
        if (l.compId) walk(l.compId);
        const ids = [l.mediaId, ...(l.overrides ?? []).map((o) => o.prop.v)];
        for (const m of p.media) if (ids.includes(m.id)) for (const f of [m.path, m.proxy?.path]) if (f) { try { const s = statSync(f); files.push(`${f}|${s.size}|${s.mtimeMs}`); } catch { files.push(`${f}|-`); } }
      }
      const c = findComp(p.comps, id);
      if (c.proxy?.path) { try { const s = statSync(c.proxy.path); files.push(`${c.proxy.path}|${s.size}|${s.mtimeMs}`); } catch { /* gone */ } }
    };
    walk(compId);
    b = createHash('sha1').update(`${this.engine}|${compHash(p, compId)}|${files.join(';')}`).digest('hex');
    this.bases.set(compId, b);
    return b;
  }
  key(p: Project, compId: string, frame: number, o: FrameOpts): string {
    // preview frames show the comp's guide layers (never in exports)
    const g = findComp(p.comps, compId).layers.some((l) => l.guide) ? '|g' : '';
    return createHash('sha1').update(`${this.base(p, compId)}|${frame}|${o.res}|${o.mbSamples ?? ''}|${o.proxies ?? 'current'}${g}`).digest('hex');
  }
  private file(key: string) { return join(this.dir, key.slice(0, 2), `${key}.png`); }

  get(key: string): Buffer | null {
    const f = this.file(key);
    if (!existsSync(f)) return null;
    // the date marks the last use (least recently used frames are removed first)
    try { const now = new Date(); utimesSync(f, now, now); return readFileSync(f); } catch { return null; }
  }
  has(key: string): boolean { return existsSync(this.file(key)); }
  put(key: string, png: Uint8Array) {
    const f = this.file(key);
    mkdirSync(join(this.dir, key.slice(0, 2)), { recursive: true });
    writeFileSync(f, png);
    if (this.bytes >= 0) this.bytes += png.byteLength;
    if (++this.puts % 50 === 0 || (this.bytes >= 0 && this.bytes > this.maxBytes)) this.trim();
  }
  /** Which frames of [from, to) are on disk (one byte per frame). */
  status(p: Project, compId: string, from: number, to: number, o: FrameOpts): Uint8Array {
    const out = new Uint8Array(Math.max(0, to - from));
    for (let i = from; i < to; i++) out[i - from] = this.has(this.key(p, compId, i, o)) ? 1 : 0;
    return out;
  }
  private list(): { f: string; size: number; used: number }[] {
    const out: { f: string; size: number; used: number }[] = [];
    if (!existsSync(this.dir)) return out;
    for (const d of readdirSync(this.dir)) {
      const sub = join(this.dir, d);
      let names: string[] = [];
      try { names = readdirSync(sub); } catch { continue; }
      for (const n of names) { if (!n.endsWith('.png')) continue; const f = join(sub, n); try { const s = statSync(f); out.push({ f, size: s.size, used: s.mtimeMs }); } catch { /* removed meanwhile */ } }
    }
    return out;
  }
  info(): { dir: string; bytes: number; frames: number; maxBytes: number } {
    const l = this.list();
    this.bytes = l.reduce((a, x) => a + x.size, 0);
    return { dir: this.dir, bytes: this.bytes, frames: l.length, maxBytes: this.maxBytes };
  }
  /** Deletes the least recently used frames until the folder is under 90 % of its size. */
  trim(): number {
    const l = this.list().sort((a, b) => a.used - b.used);
    let total = l.reduce((a, x) => a + x.size, 0), n = 0;
    for (const x of l) { if (total <= this.maxBytes * 0.9) break; try { rmSync(x.f, { force: true }); total -= x.size; n++; } catch { /* in use */ } }
    this.bytes = total;
    return n;
  }
  clear(): number {
    const n = this.list().length;
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.bytes = 0;
    return n;
  }
}
