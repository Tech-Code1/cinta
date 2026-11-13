// «Ámbitos de Lumetri» panel (AE's Window ▸ Lumetri Scopes): the viewer's frame as waveform, vectorscopes,
// histogram and parade, updated while scrubbing and playing. A downsampled copy of each new frame is drawn into
// scopes by a worker (src/renderer/advanced/scopes.worker.ts); the panel adds the labels. Docked as a tab of the
// right column, or floating («Desacoplar»).
import { applyPreset, axisPos, axisTicks, BRIGHTNESS, COLOR_SPACES, PARADE_TYPES, PRECISIONS, SCOPE_DEFAULTS, SCOPE_NAMES, SCOPE_PRESETS, WAVEFORM_TYPES, type ScopeKind, type ScopeSettings } from '../../core/motion/scopes';
import { h } from '../store';
import { currentFrame, currentFrameSeq } from './viewer';
import { runScopeJob, type ScopeJob, type ScopeReply } from './scopes.worker';

const KEY = 'cinta.adv.scopes';
let settings: ScopeSettings = load();
function load(): ScopeSettings {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ScopeSettings | null; if (v?.scopes) return { ...SCOPE_DEFAULTS, ...v }; } catch { /* private */ }
  return { ...SCOPE_DEFAULTS, scopes: [...SCOPE_DEFAULTS.scopes] };
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private */ } }

/** what the self-test and the status line read: the last frame's numbers and how they were computed */
export const scopesInfo: { frames: number; mode: 'worker' | 'inline' | ''; stats: ScopeReply['stats'] | null; ms: number } = { frames: 0, mode: '', stats: null, ms: 0 };

let worker: Worker | null | undefined;
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./scopes.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = () => { worker?.terminate(); worker = null; busy = false; };
  } catch { worker = null; }
  return worker;
}
let busy = false;
let jobId = 0;

let canvas: HTMLCanvasElement | null = null;
let host: HTMLElement | null = null;
let lastSeq = -1, lastSig = '';
const small = document.createElement('canvas');

function visible(): boolean { return !!host && host.isConnected && host.offsetParent !== null && host.clientWidth > 20; }

function tick() {
  requestAnimationFrame(tick);
  if (!canvas || !visible() || busy) return;
  const seq = currentFrameSeq(), W = Math.max(40, Math.round(host!.clientWidth)), H = Math.max(40, Math.round(host!.clientHeight - 26));
  const sig = `${JSON.stringify(settings)}|${W}x${H}`;
  if (seq === lastSeq && sig === lastSig) return;
  const f = currentFrame();
  if (!f) return;
  lastSeq = seq; lastSig = sig;
  // a downsampled copy of the frame: ≤ 320 px wide
  const fw = (f as HTMLCanvasElement).width || 1, fh = (f as HTMLCanvasElement).height || 1, k = Math.min(1, 320 / fw);
  const w = Math.max(1, Math.round(fw * k)), hh = Math.max(1, Math.round(fh * k));
  if (small.width !== w || small.height !== hh) { small.width = w; small.height = hh; }
  const g = small.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, w, hh);
  g.drawImage(f, 0, 0, w, hh);
  const px = g.getImageData(0, 0, w, hh).data;
  const job: ScopeJob = { id: ++jobId, px, w, h: hh, s: { ...settings, scopes: [...settings.scopes] }, W, H };
  const t0 = performance.now();
  const wk = getWorker();
  if (wk) {
    busy = true;
    wk.onmessage = (e: MessageEvent<ScopeReply>) => { busy = false; scopesInfo.mode = 'worker'; done(e.data, W, H, t0); };
    wk.postMessage(job, [px.buffer]);
  } else { scopesInfo.mode = 'inline'; done(runScopeJob(job), W, H, t0); }
}

function done(r: ScopeReply, W: number, H: number, t0: number) {
  if (!canvas) return;
  const dpr = 1;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W; canvas.height = H; }
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#0a0a0c';
  g.fillRect(0, 0, W, H);
  for (const t of r.tiles) {
    g.putImageData(new ImageData(new Uint8ClampedArray(t.d), t.w, t.h), t.x + 1, t.y + 1);
    labels(g, t.kind as ScopeKind, t.x + 1, t.y + 1, t.w, t.h);
  }
  scopesInfo.frames++;
  scopesInfo.stats = r.stats;
  scopesInfo.ms = performance.now() - t0;
}

function labels(g: CanvasRenderingContext2D, kind: ScopeKind, x: number, y: number, w: number, hgt: number) {
  g.save();
  g.font = '10px "Segoe UI", sans-serif';
  g.fillStyle = 'rgba(200,200,200,0.75)';
  g.textBaseline = 'middle';
  const title = kind === 'waveform' ? `Forma de onda (${WAVEFORM_TYPES.find(([k]) => k === settings.waveform)?.[1]})` : kind === 'parade' ? `Exposición (${PARADE_TYPES.find(([k]) => k === settings.parade)?.[1]})` : SCOPE_NAMES[kind];
  g.fillText(title, x + 4, y + 8);
  if (kind === 'waveform' || kind === 'parade' || kind === 'histogram') {
    g.textAlign = 'right';
    for (const [v, s] of axisTicks(settings.precision, kind === 'waveform' && settings.waveform === 'luma')) {
      const Y = y + (1 - axisPos(v, settings.precision) * 0.9 - 0.05) * (hgt - 1);
      g.fillText(s, x + w - 3, Y - 5);
    }
  }
  if (kind === 'vectorYUV') {
    // target letters
    const side = Math.min(w, hgt), rad = side * 0.46, cx = x + w / 2, cy = y + hgt / 2;
    g.textAlign = 'center';
    const pos: [string, number, number, number][] = [['R', 1, 0, 0], ['Mg', 1, 0, 1], ['B', 0, 0, 1], ['Cy', 0, 1, 1], ['G', 0, 1, 0], ['Yl', 1, 1, 0]];
    for (const [nm, r, gg, b] of pos) {
      const kr = 0.2126, kb = 0.0722, Y = kr * r + (1 - kr - kb) * gg + kb * b, cb = (b - Y) / (2 * (1 - kb)), cr = (r - Y) / (2 * (1 - kr));
      g.fillText(nm, cx + (cb / 0.62) * rad * 1.12, cy - (cr / 0.62) * rad * 1.12);
    }
  }
  g.restore();
}

// ───────────────────────── settings ─────────────────────────
function set(p: Partial<ScopeSettings>) { settings = { ...settings, ...p }; save(); lastSig = ''; refreshBar?.(); }
let refreshBar: (() => void) | null = null;
const sel = <T extends string>(test: string, opts: [T, string][], cur: T, on: (v: T) => void) => {
  const s = h('select', { dataset: { test } }, ...opts.map(([v, n]) => h('option', { value: v, selected: v === cur }, n))) as HTMLSelectElement;
  s.onchange = () => on(s.value as T);
  s.onkeydown = (e) => e.stopPropagation();
  return s;
};

function settingsPopover(anchor: HTMLElement) {
  document.querySelectorAll('.scopes-pop').forEach((x) => x.remove());
  const row = (label: string, ...kids: Node[]) => h('div', { class: 'crow' }, h('span', { class: 'nm' }, label), ...kids);
  const kinds: ScopeKind[] = ['vectorYUV', 'vectorHLS', 'histogram', 'parade', 'waveform'];
  const pop = h('div', { class: 'scopes-pop', dataset: { test: 'scopes-settings' } },
    row('Ajustes preestablecidos', sel('scopes-preset', [['', 'Personalizado'], ...SCOPE_PRESETS.map((p) => [p.id, p.name] as [string, string])], '', (v) => { if (v) { settings = applyPreset(settings, v); save(); lastSig = ''; refreshBar?.(); settingsPopover(anchor); } })),
    ...kinds.map((k) => {
      const cb = h('input', { type: 'checkbox', checked: settings.scopes.includes(k), dataset: { test: `scopes-${k}` } }) as HTMLInputElement;
      cb.onchange = () => set({ scopes: kinds.filter((x) => (x === k ? cb.checked : settings.scopes.includes(x))) });
      return h('label', { class: 'crow' }, cb, ` ${SCOPE_NAMES[k]}`);
    }),
    row('Tipo de forma de onda', sel('scopes-waveform', WAVEFORM_TYPES, settings.waveform, (v) => set({ waveform: v }))),
    row('Tipo de exposición', sel('scopes-parade', PARADE_TYPES, settings.parade, (v) => set({ parade: v }))),
    row('Espacio de color', sel('scopes-colorspace', COLOR_SPACES, settings.colorSpace, (v) => set({ colorSpace: v }))),
    row('Brillo', sel('scopes-brightness', BRIGHTNESS, settings.brightness, (v) => set({ brightness: v }))),
    h('div', { class: 'brow' }, h('button', { class: 'btn small', onclick: () => pop.remove() }, 'Cerrar')));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(innerWidth - 300, r.right - 290))}px`;
  pop.style.top = `${Math.min(innerHeight - pop.offsetHeight - 4, r.bottom + 4)}px`;
  setTimeout(() => addEventListener('pointerdown', function off(ev) { if (!pop.isConnected) return; if (pop.contains(ev.target as Node) || ev.target === anchor) { addEventListener('pointerdown', off, { once: true }); return; } pop.remove(); }, { once: true }), 0);
}

// ───────────────────────── the panel ─────────────────────────
let floating: HTMLElement | null = null;
let dockEl: HTMLElement | null = null;
let body: HTMLElement | null = null;
export function scopesPanel(el: HTMLElement) {
  dockEl = el;
  const gear = h('button', { class: 'mini', title: 'Ajustes...', dataset: { test: 'scopes-gear' } }, '⚙') as HTMLButtonElement;
  gear.onclick = () => settingsPopover(gear);
  canvas = h('canvas', { class: 'scopes-cv', dataset: { test: 'scopes-canvas' } }) as HTMLCanvasElement;
  canvas.oncontextmenu = (e) => { e.preventDefault(); settingsPopover(gear); };
  const clamp = h('input', { type: 'checkbox', checked: settings.clamp, dataset: { test: 'scopes-clamp' } }) as HTMLInputElement;
  clamp.onchange = () => set({ clamp: clamp.checked });
  const prec = sel('scopes-precision', PRECISIONS, settings.precision, (v) => set({ precision: v }));
  const undock = h('button', { class: 'mini', title: 'Desacoplar / acoplar el panel', dataset: { test: 'scopes-float' }, onclick: () => toggleFloat() }, '⇱');
  refreshBar = () => { clamp.checked = settings.clamp; prec.value = settings.precision; };
  const bar = h('div', { class: 'scopes-bar' }, h('label', {}, clamp, ' Fijar señal'), prec, h('span', { class: 'grow' }), undock, gear);
  host = h('div', { class: 'scopes-host', dataset: { test: 'scopes-panel' } }, canvas, bar);
  body = host;
  el.append(host);
  if (!started) { started = true; requestAnimationFrame(tick); }
  (window as unknown as { __scopes: unknown }).__scopes = { info: scopesInfo, settings: () => settings, set, show: showScopes };
}
let started = false;

function toggleFloat() {
  if (!body || !dockEl) return;
  if (floating) { dockEl.append(body); floating.remove(); floating = null; lastSig = ''; return; }
  floating = h('div', { class: 'scopes-float', dataset: { test: 'scopes-floating' } },
    h('div', { class: 'scopes-title' }, 'Ámbitos de Lumetri'));
  floating.append(body);
  document.body.append(floating);
  const title = floating.firstChild as HTMLElement;
  title.onpointerdown = (e) => {
    const f = floating!, r = f.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = (ev: PointerEvent) => { f.style.left = `${Math.max(0, ev.clientX - dx)}px`; f.style.top = `${Math.max(0, ev.clientY - dy)}px`; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  lastSig = '';
}

/** Ventana ▸ Ámbitos de Lumetri: brings the panel to the front (its tab, or the floating window). */
export function showScopes() {
  if (floating) { floating.style.display = ''; return; }
  (document.querySelector('[data-test=tab-scopes]') as HTMLButtonElement | null)?.click();
}
