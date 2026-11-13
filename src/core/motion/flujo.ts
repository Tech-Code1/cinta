// Flowchart (After Effects: Composition ▸ Composition Flowchart / the Flowchart panel): compositions, their layers,
// the footage they use and nested compositions as a node graph flowing from sources to the comps that use them,
// with After Effects' options (show layers, footage, solids, effects; flow direction) and a layered layout.
import type { Comp } from './model';

export type FlowKind = 'comp' | 'layer' | 'footage' | 'solid';
export interface FlowNode { id: string; kind: FlowKind; name: string; compId?: string; layerId?: string; mediaId?: string; type?: string; effects?: string[]; x: number; y: number; w: number; h: number }
export interface FlowEdge { from: string; to: string }
export type FlowDir = 'LR' | 'RL' | 'TB' | 'BT';
/** Flow direction (the panel's button bar) */
export const FLOW_DIRS: { id: FlowDir; name: string }[] = [
  { id: 'LR', name: 'Izquierda a derecha' }, { id: 'RL', name: 'Derecha a izquierda' }, { id: 'TB', name: 'Descendente' }, { id: 'BT', name: 'Ascendente' },
];
export interface FlowOpts { root?: string; layers?: boolean; footage?: boolean; solids?: boolean; effects?: boolean; dir?: FlowDir }
interface ProjLike { comps?: Comp[]; media: { id: string; path: string; kind: string; compId?: string }[] }

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** Nodes and edges (from → to = what flows into what), laid out in columns by depth. root: a comp id for a comp
 *  flowchart (it and everything it uses); none for the project flowchart. */
export function flowGraph(p: ProjLike, o: FlowOpts = {}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const showLayers = o.layers ?? true, showFootage = o.footage ?? true, showSolids = o.solids ?? false, showFx = o.effects ?? false;
  const comps = p.comps ?? [];
  // which comps: the root and the comps it nests (recursively), or all
  let use = comps;
  if (o.root) {
    const seen = new Set<string>();
    const walk = (id: string) => { if (seen.has(id)) return; seen.add(id); const c = comps.find((x) => x.id === id); c?.layers.forEach((l) => { if (l.compId) walk(l.compId); }); };
    walk(o.root);
    use = comps.filter((c) => seen.has(c.id));
  }
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const add = (n: Omit<FlowNode, 'x' | 'y' | 'w' | 'h'>) => { if (!nodes.has(n.id)) nodes.set(n.id, { ...n, x: 0, y: 0, w: 0, h: 0 }); return n.id; };
  const edge = (from: string, to: string) => { if (from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to }); };
  for (const c of use) add({ id: `c:${c.id}`, kind: 'comp', name: c.name, compId: c.id });
  for (const c of use) {
    for (const l of c.layers) {
      // where the layer's content comes from
      let src: string | null = null;
      if (l.compId && use.some((x) => x.id === l.compId)) src = `c:${l.compId}`;
      else if (l.mediaId && showFootage) {
        const m = p.media.find((x) => x.id === l.mediaId);
        if (m) src = add({ id: `m:${m.id}`, kind: 'footage', name: base(m.path), mediaId: m.id, type: m.kind });
      } else if ((l.type === 'solid' || l.type === 'adjustment') && showSolids) src = add({ id: `s:${c.id}:${l.id}`, kind: 'solid', name: l.solid ? `${l.type === 'adjustment' ? 'Ajuste' : 'Sólido'} ${l.solid.width}×${l.solid.height}` : l.name, compId: c.id, layerId: l.id, type: l.type });
      if (showLayers) {
        const id = add({ id: `l:${c.id}:${l.id}`, kind: 'layer', name: l.name, compId: c.id, layerId: l.id, type: l.type, effects: showFx ? l.effects.map((f) => f.name ?? f.fx) : undefined });
        if (src) edge(src, id);
        edge(id, `c:${c.id}`);
      } else if (src) edge(src, `c:${c.id}`);
    }
  }
  const list = [...nodes.values()];
  layout(list, edges, o.dir ?? 'LR');
  return { nodes: list, edges };
}

/** Columns by longest path from the sources; rows ordered by the average row of what flows in (one sweep). */
function layout(nodes: FlowNode[], edges: FlowEdge[], dir: FlowDir) {
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // longest path (bounded: nesting cycles cannot loop forever)
  for (let it = 0; it < nodes.length; it++) {
    let changed = false;
    for (const e of edges) { const r = (rank.get(e.from) ?? 0) + 1; if (r > (rank.get(e.to) ?? 0) && r <= nodes.length) { rank.set(e.to, r); changed = true; } }
    if (!changed) break;
  }
  const cols: FlowNode[][] = [];
  for (const n of nodes) (cols[rank.get(n.id)!] ??= []).push(n);
  const row = new Map<string, number>();
  cols.forEach((col, ci) => {
    if (ci) col.sort((a, b) => avg(a) - avg(b));
    col.forEach((n, i) => row.set(n.id, i));
  });
  function avg(n: FlowNode) { const ins = edges.filter((e) => e.to === n.id).map((e) => row.get(e.from) ?? 0); return ins.length ? ins.reduce((s, x) => s + x, 0) / ins.length : 0; }
  const W = 170, H = 34, GX = 70, GY = 16;
  const nCols = cols.length;
  for (const n of nodes) {
    n.w = W; n.h = H + (n.effects?.length ? n.effects.length * 14 : 0);
    const r = rank.get(n.id)!, i = row.get(n.id)!;
    const c = dir === 'RL' || dir === 'BT' ? nCols - 1 - r : r;
    if (dir === 'LR' || dir === 'RL') { n.x = c * (W + GX); n.y = i * (H + GY + 14); }
    else { n.x = i * (W + 30); n.y = c * (H + GX); }
  }
}
