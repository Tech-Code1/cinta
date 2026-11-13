// Lumetri Scopes worker: draws the scopes of a downsampled frame off the main thread (stays real-time while the
// comp plays) and returns the pictures of each tile plus the frame's numbers.
import { rasterScope, scopeData, scopeLayout, type ScopeSettings } from '../../core/motion/scopes';

export interface ScopeJob { id: number; px: Uint8ClampedArray; w: number; h: number; s: ScopeSettings; W: number; H: number }
export interface ScopeTile { kind: string; x: number; y: number; w: number; h: number; d: Uint8ClampedArray }
export interface ScopeReply { id: number; tiles: ScopeTile[]; stats: ReturnType<typeof scopeData> }

export function runScopeJob(j: ScopeJob): ScopeReply {
  const tiles = scopeLayout(j.s.scopes, j.W, j.H).map((t) => ({ ...t, w: Math.max(8, t.w - 2), h: Math.max(8, t.h - 2), d: rasterScope(t.kind, j.px, j.w, j.h, j.s, Math.max(8, t.w - 2), Math.max(8, t.h - 2)) }));
  return { id: j.id, tiles, stats: scopeData(j.px, j.w, j.h, j.s.colorSpace, 64) };
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<ScopeJob>) => void) | null; postMessage: (m: unknown, t?: Transferable[]) => void; document?: unknown };
if (typeof ctx.document === 'undefined') {
  ctx.onmessage = (e) => { const r = runScopeJob(e.data); ctx.postMessage(r, r.tiles.map((t) => t.d.buffer)); };
}
