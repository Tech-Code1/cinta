// UI state: the project mirrored from the main process, selection, playhead and helpers.
import type { Clip, Project, Track } from '../core/model';

export interface Api {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  on: (channel: string, fn: (...args: any[]) => void) => () => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  pathOf: (f: File) => string;
}
export const api = (window as unknown as { cinta: Api }).cinta;

export interface AppState {
  project: Project;
  path: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** main-process state counter (disk cache: which state a frame was drawn from) */
  version?: number;
}

type Listener = (why: string) => void;
class Store {
  s!: AppState;
  selection = new Set<string>();
  selectedTransition: string | null = null;
  selectedTrack: string | null = null;
  time = 0;
  zoom = 60; // px per second
  clipboard: Clip[] = [];
  previewVolume = 1;
  private listeners = new Set<Listener>();

  get project() { return this.s.project; }
  set(st: AppState, why = 'state') {
    this.s = st;
    // drop selections that no longer exist
    for (const id of [...this.selection]) if (!st.project.clips.some((c) => c.id === id)) this.selection.delete(id);
    if (this.selectedTransition && !st.project.clips.some((c) => c.id === this.selectedTransition && c.transition)) this.selectedTransition = null;
    this.emit(why);
  }
  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(why: string) { for (const l of this.listeners) l(why); }

  clip(id: string) { return this.project.clips.find((c) => c.id === id); }
  track(id: string) { return this.project.tracks.find((t) => t.id === id); }
  trackOf(c: Clip): Track | undefined { return this.track(c.trackId); }
  media(c: Clip) { return c.mediaId ? this.project.media.find((m) => m.id === c.mediaId) : undefined; }
  selected(): Clip[] { return [...this.selection].map((id) => this.clip(id)).filter((c): c is Clip => !!c); }
  first(): Clip | undefined { return this.selected()[0]; }
  select(ids: string[], add = false) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.selectedTransition = null;
    this.emit('select');
  }
  seek(t: number) {
    this.time = Math.max(0, Math.min(t, Math.max(0, this.duration())));
    this.emit('time');
  }
  duration() {
    let d = 0;
    for (const c of this.project.clips) d = Math.max(d, c.start + (c.out - c.in) / c.speed);
    return Math.round(d * 1000) / 1000;
  }
}
export const store = new Store();

/** Editor operation in the main process (result or a Spanish error shown as a toast). */
export async function op<T = unknown>(name: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return (await api.invoke('op', name, ...args)) as T;
  } catch (e) {
    toast(cleanErr(e), true);
    return undefined;
  }
}
export async function auto<T = unknown>(name: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return (await api.invoke('auto', name, ...args)) as T;
  } catch (e) {
    toast(cleanErr(e), true);
    return undefined;
  }
}
export const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let toastTimer = 0;
export function toast(msg: string, err = false) {
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.className = `show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = ''), err ? 6000 : 2600);
}

export const clipDur = (c: Clip) => (c.out - c.in) / c.speed;
export const clipEnd = (c: Clip) => c.start + clipDur(c);
export function fmt(s: number, ms = false) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return ms ? `${base}.${String(Math.floor((s % 1) * 1000 + 1e-6)).padStart(3, '0')}` : base;
}
export function fmtShort(s: number) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Creates an element with attributes and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  // screen readers: an icon-only button is announced by its tooltip
  if (tag === 'button' && attrs.title && !attrs['aria-label']) el.setAttribute('aria-label', String(attrs.title));
  return el;
}
