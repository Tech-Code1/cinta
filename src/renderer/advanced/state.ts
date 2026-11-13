// Advanced-mode UI state: active composition, a local working copy edited during gestures (committed as one
// undo step when the gesture ends), layer/keyframe selection, current time and tool.
import type { Comp, Layer, Prop, PVal } from '../../core/motion/model';
import { api, store, toast, cleanErr } from '../store';
import { exprErrors } from '../../core/motion/anim';

export type Tool = 'select' | 'hand' | 'zoom' | 'rotate' | 'anchor' | 'rect' | 'ellipse' | 'star' | 'pen' | 'text' | 'puppet' | 'track' | 'sketch' | 'brush' | 'clone' | 'eraser' | 'orbit' | 'pan3d' | 'dolly' | 'feather' | 'roto' | 'refine';
export interface KeySel { layer: string; path: string; t: number }

type Why = 'comp' | 'time' | 'select' | 'tool' | 'keys' | 'view' | 'play' | 'cache' | 'errors';
class AdvState {
  compId: string | null = null;
  /** working copy while a gesture is in progress (null = use the project's) */
  work: Comp | null = null;
  selection = new Set<string>();
  keys: KeySel[] = [];
  /** property path shown in the graph editor */
  graphProp: { layer: string; path: string } | null = null;
  time = 0;
  tool: Tool = 'select';
  playing = false;
  /** preview resolution (1, 0.5, 0.333, 0.25) */
  res = 0.5;
  private ls = new Set<(why: Why) => void>();

  on(fn: (why: Why) => void) { this.ls.add(fn); return () => this.ls.delete(fn); }
  emit(why: Why) { for (const f of this.ls) f(why); }

  comps(): Comp[] { return store.project.comps ?? []; }
  /** composition being edited (working copy during gestures) */
  comp(): Comp | null {
    if (this.work && this.work.id === this.compId) return this.work;
    const c = this.comps().find((x) => x.id === this.compId) ?? null;
    return c;
  }
  layer(id: string): Layer | undefined { return this.comp()?.layers.find((l) => l.id === id); }
  selected(): Layer[] { const c = this.comp(); return c ? c.layers.filter((l) => this.selection.has(l.id)) : []; }
  first(): Layer | undefined { return this.selected()[0]; }
  select(ids: string[], add = false) {
    // picking layers drops the keyframe selection (Supr then deletes layers, like After Effects)
    if (!add) { this.selection.clear(); this.keys = []; }
    for (const id of ids) { if (add && this.selection.has(id) && ids.length === 1) this.selection.delete(id); else this.selection.add(id); }
    this.emit('select');
  }
  seek(t: number) {
    const c = this.comp();
    const fps = c?.fps ?? 30;
    const d = c?.duration ?? 0;
    this.time = Math.max(0, Math.min(d - 1 / fps / 2, Math.round(t * fps) / fps));
    this.emit('time');
  }
  frame() { return 1 / (this.comp()?.fps ?? 30); }

  /** Starts a gesture: subsequent edits go to a copy until commit(). */
  begin(): Comp | null {
    const c = this.comps().find((x) => x.id === this.compId);
    if (!c) return null;
    if (!this.work || this.work.id !== c.id) this.work = JSON.parse(JSON.stringify(c)) as Comp;
    return this.work;
  }
  /** Ends the gesture: one undo step with everything that changed. */
  async commit(label = 'Editar composición') {
    const w = this.work;
    if (!w) return;
    const orig = this.comps().find((x) => x.id === w.id);
    if (orig && JSON.stringify(orig) === JSON.stringify(w)) { this.work = null; return; }
    try { await api.invoke('motion', 'setComp', w, label); } catch (e) { toast(cleanErr(e), true); }
    this.work = null;
  }
  cancel() { this.work = null; this.emit('comp'); }
}
export const adv = new AdvState();

// ───────────────────────── disk cache ─────────────────────────
/** Frames of the current comp on the disk cache (one byte per frame), drawn as a blue line under the ruler. */
export const diskCache = { compId: '', bits: null as Uint8Array | null };
let statusTimer = 0;
/** Re-reads which frames are on disk (debounced). */
export function refreshDiskStatus(compId: string, o: { res: number; mbSamples: number }) {
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(async () => {
    const bits = await api.invoke('cache:status', compId, { ...o, proxies: 'current' }).catch(() => null) as Uint8Array | null;
    diskCache.compId = compId; diskCache.bits = bits;
    adv.emit('cache');
  }, 300);
}
/** A frame from the disk cache, if this exact frame of the committed state is there; else the key to file it under. */
export async function diskFrame(compId: string, frame: number, o: { res: number; mbSamples: number }): Promise<{ bmp: ImageBitmap | null; key: string; version: number } | null> {
  const version = store.s.version ?? -1;
  const r = await api.invoke('cache:get', version, compId, frame, { ...o, proxies: 'current' }).catch(() => null) as { key: string; png: Uint8Array | null } | null;
  if (!r) return null;
  return { key: r.key, version, bmp: r.png ? await createImageBitmap(new Blob([r.png as BlobPart], { type: 'image/png' })) : null };
}
/** Is any expression of the project failing now? (the error map also keeps entries of expressions since removed) */
export function failingExpressions(): boolean {
  for (const k of exprErrors.keys()) {
    const i = k.indexOf('|'), lid = k.slice(0, i), path = k.slice(i + 1);
    for (const c of store.project.comps ?? []) { const l = c.layers.find((x) => x.id === lid); const pr = l && propAt(l, path); if (pr?.x && !pr.xOff) return true; }
  }
  return false;
}
/** Files a rendered frame (the canvas is read now; the PNG is written in the background). */
export function storeFrame(cv: HTMLCanvasElement, key: string, version: number) {
  // a snapshot now (the renderer reuses its canvas); encoding and writing wait for idle time
  void createImageBitmap(cv).then((bmp) => {
    writes.push({ bmp, key, version });
    if (writes.length > 600) writes.shift()!.bmp.close();
    void drainWrites();
  }).catch(() => {});
}
/** Frames waiting to be written: one PNG at a time when the window is idle, never while playing (encoding a burst
 *  of frames right after a RAM preview would starve playback). */
const writes: { bmp: ImageBitmap; key: string; version: number }[] = [];
/** what the disk cache writer is doing (self-test diagnostics) */
export const diskWriteInfo = () => ({ pending: writes.length, draining, written, step, version: store.s.version ?? -1 });
let written = 0, step = '';
let draining = false;
async function drainWrites() {
  if (draining) return;
  draining = true;
  try {
    while (writes.length) {
      step = 'playing?';
      if (adv.playing) { await new Promise((r) => setTimeout(r, 250)); continue; }
      // frames of an older state of the project would be refused by the main process: drop them before paying for
      // the encoding (after a few edits the queue is mostly those, and they held the fresh frames back)
      if (writes[0].version !== (store.s.version ?? -1)) { writes.shift()!.bmp.close(); continue; }
      step = 'idle';
      // a short cap: under load the window is rarely idle and a 1 s wait per frame never caught up
      await new Promise((r) => (window.requestIdleCallback ? window.requestIdleCallback(() => r(null), { timeout: 200 }) : setTimeout(r, 16)));
      const w = writes.shift()!;
      if (!w) break;
      const c = document.createElement('canvas');
      c.width = w.bmp.width; c.height = w.bmp.height;
      c.getContext('2d')!.drawImage(w.bmp, 0, 0);
      w.bmp.close();
      step = 'toBlob';
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      step = 'put';
      if (blob) await api.invoke('cache:put', w.version, w.key, new Uint8Array(await blob.arrayBuffer())).catch(() => {});
      written++;
    }
  } finally { draining = false; }
  // frames written meanwhile: the blue line of the current comp follows
  const c = adv.comp();
  if (c) refreshDiskStatus(c.id, { res: adv.res, mbSamples: Math.min(c.motionBlur.samples, adv.res < 1 ? 8 : c.motionBlur.samples) });
}

/** Advanced-mode operation in the main process. */
export async function mop<T = unknown>(name: string, ...args: unknown[]): Promise<T | undefined> {
  try { return (await api.invoke('motion', name, ...args)) as T; } catch (e) { toast(cleanErr(e), true); return undefined; }
}

/** Prop at a path inside a layer (ids for effects, masks, shapes, animators; indexes for selectors). */
export function propAt(l: Layer, path: string): Prop | undefined {
  // essential.<id>: a Master Property of a comp layer
  if (path.startsWith('essential.')) return l.overrides?.find((x) => x.id === path.slice(10))?.prop;
  let o: any = l; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const k of path.split('.')) {
    if (Array.isArray(o)) o = o.find((x) => x?.id === k) ?? o[Number(k)];
    else if (o && o.fx && o.params && k in o.params) o = o.params[k];
    else if (o && Array.isArray(o.pins) && !(k in o)) o = o.pins.find((x: { id: string }) => x.id === k); // puppet.<pin>.position
    else o = o?.[k];
    if (o === undefined) return undefined;
  }
  return o && typeof o === 'object' && 'v' in o ? (o as Prop) : undefined;
}

/** Sets a property on the working copy: keyframe at the current time when the stopwatch is on. */
export function setProp(l: Layer, path: string, v: PVal) {
  // Separate Dimensions: a position goes to X / Y / Z
  if (path === 'transform.position' && l.transform.positionX && Array.isArray(v)) { (['X', 'Y', 'Z'] as const).forEach((d, i) => { if (l.transform[`position${d}`]) setProp(l, `transform.position${d}`, Number(v[i] ?? 0)); }); return; }
  const p = propAt(l, path);
  if (!p) return;
  if (p.k?.length) {
    const t = adv.time;
    const k = p.k.find((x) => Math.abs(x.t - t) < 1e-4);
    if (k) k.v = v;
    else { p.k.push({ t, v, i: p.k[0]?.i }); p.k.sort((a, b) => a.t - b.t); }
  } else p.v = v;
}
