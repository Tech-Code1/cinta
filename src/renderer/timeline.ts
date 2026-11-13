// Timeline: tracks, clips (filmstrip + waveform), transitions, markers, playhead; drag, trim, drop, menus.
import type { Clip, Track, TrackKind } from '../core/model';
import { ICONS } from './icons';
import { contextMenu, stop, type MenuItem } from './player';
import { api, clipDur, clipEnd, fmtShort, h, op, store, toast } from './store';

const $ = (id: string) => document.getElementById(id)!;
const scroll = $('tl-scroll');
const content = $('tl-content');
const tracksEl = $('tracks');
const headers = $('tl-headers');
const ruler = $('ruler');
const playhead = $('playhead');
const markersEl = $('markers');
const RULER_H = 26;
const BASE_HEIGHTS: Record<TrackKind, number> = { title: 44, overlay: 58, main: 74, audio: 50 };
// track heights are adjustable (drag the bottom edge of a track header) and remembered per kind
const HEIGHTS: Record<TrackKind, number> = (() => {
  try { return { ...BASE_HEIGHTS, ...JSON.parse(localStorage.getItem('cinta.heights') ?? '{}') }; } catch { return { ...BASE_HEIGHTS }; }
})();
const PAD_LEFT = 14;

export interface DropPayload { kind: string; id: string; extra?: Record<string, unknown> }
export const DRAG_MIME = 'application/x-cinta';

/** Hooks the timeline needs from the rest of the UI. */
export interface TimelineHooks {
  openClip(c: Clip, dbl: boolean): void;
  openTransition(c: Clip): void;
  applyDrop(p: DropPayload, at: { trackId?: string; time: number; clip?: Clip }): void;
  importFiles(paths: string[], at: { trackId?: string; time: number }): void;
  clipMenu(c: Clip): MenuItem[];
}
let hooks: TimelineHooks;

const x2t = (x: number) => Math.max(0, (x - PAD_LEFT) / store.zoom);
const t2x = (t: number) => PAD_LEFT + t * store.zoom;

interface Row { track: Track; top: number; height: number }
let rows: Row[] = [];
function layoutRows(): Row[] {
  let y = 0;
  rows = store.project.tracks.map((t) => {
    const r = { track: t, top: y, height: HEIGHTS[t.kind] };
    y += r.height;
    return r;
  });
  return rows;
}
const rowAt = (y: number) => rows.find((r) => y >= r.top && y < r.top + r.height);

// ───────────────────────── caches for media visuals ─────────────────────────
const thumbs = new Map<string, string[] | Promise<string[]>>();
const waves = new Map<string, number[] | Promise<number[]>>();
function thumbsOf(mediaId: string): string[] | null {
  const v = thumbs.get(mediaId);
  if (Array.isArray(v)) return v;
  if (!v) {
    const m = store.project.media.find((x) => x.id === mediaId);
    const n = m && m.kind === 'video' ? Math.max(2, Math.min(40, Math.ceil(m.duration / 2))) : 1;
    thumbs.set(mediaId, api.invoke('media:thumbs', mediaId, n, 48).then((r: string[]) => { thumbs.set(mediaId, r); render(); return r; }));
  }
  return null;
}
function waveOf(mediaId: string): number[] | null {
  const v = waves.get(mediaId);
  if (Array.isArray(v)) return v;
  if (!v) waves.set(mediaId, api.invoke('media:wave', mediaId).then((r: number[]) => { waves.set(mediaId, r); render(); return r; }));
  return null;
}

// ───────────────────────── rendering ─────────────────────────
export function render() {
  const p = store.project;
  layoutRows();
  const dur = store.duration();
  const width = Math.max(scroll.clientWidth, t2x(dur + 30));
  content.style.width = `${width}px`;
  const totalH = rows.reduce((s, r) => s + r.height, 0);
  content.style.height = `${RULER_H + totalH + 40}px`;
  tracksEl.style.height = `${totalH}px`;
  drawRuler(width);
  drawHeaders();
  tracksEl.innerHTML = '';
  for (const r of rows) {
    const t = r.track;
    const el = h('div', { class: `track ${t.kind}`, style: { top: `${r.top}px`, height: `${r.height}px` }, dataset: { track: t.id } });
    const clips = p.clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
    if (t.kind === 'main' && !clips.length) el.append(h('div', { class: 'empty-hint', title: 'Arrastre aquí archivos' }, '+'));
    for (const c of clips) el.append(clipEl(c, r));
    if (t.kind === 'main') {
      clips.forEach((c, i) => {
        if (!c.transition || i === clips.length - 1) return;
        const next = clips[i + 1];
        const a = next.start, b = clipEnd(c);
        const tr = h('div', { class: `trans${store.selectedTransition === c.id ? ' sel' : ''}`, title: `Transición: ${c.transition.type} (${c.transition.duration.toFixed(1)} s)`, html: ICONS.transitions.replace(/width="24" height="24"/, 'width="14" height="14"'), dataset: { trans: c.id } });
        Object.assign(tr.style, { left: `${t2x(a)}px`, width: `${Math.max(18, (b - a) * store.zoom)}px`, top: `${r.height / 2 - 11}px` });
        el.append(h('div', { class: 'trans-zone', style: { left: `${t2x(a)}px`, width: `${Math.max(2, (b - a) * store.zoom)}px` } }));
        tr.onclick = (e) => { e.stopPropagation(); store.selection.clear(); store.selectedTransition = c.id; store.emit('select'); hooks.openTransition(c); };
        tr.oncontextmenu = (e) => contextMenu(e, [
          { label: 'Propiedades de la transición', fn: () => hooks.openTransition(c) },
          { label: 'Quitar transición', fn: () => void op('setTransition', c.id, null) },
          { label: 'Quitar todas las transiciones', fn: () => void op('transitionWizard', { type: null }) },
        ]);
        el.append(tr);
      });
    }
    tracksEl.append(el);
  }
  drawMarkers();
  placePlayhead();
}

function clipEl(c: Clip, r: Row): HTMLElement {
  const left = t2x(c.start), w = Math.max(4, clipDur(c) * store.zoom);
  const m = store.media(c);
  const kind = r.track.kind === 'overlay' && (c.type === 'video' || c.type === 'image') ? 'overlay' : c.type;
  const el = h('div', { class: `clip ${kind}${store.selection.has(c.id) ? ' sel' : ''}${c.hidden ? ' hidden-clip' : ''}`, dataset: { clip: c.id } });
  Object.assign(el.style, { left: `${left}px`, width: `${w}px` });
  const hasWave = !!m?.hasAudio && !c.audioDetached && (c.type === 'video' || c.type === 'audio');
  const visualH = r.height - 6;
  const waveH = c.type === 'audio' ? visualH : hasWave && r.track.kind === 'main' ? 22 : 0;
  if (m && (m.kind === 'video' || m.kind === 'image') && c.type !== 'audio') {
    const list = thumbsOf(m.id);
    const strip = h('div', { class: 'strip' });
    strip.style.setProperty('--strip-h', `${visualH - waveH}px`);
    if (list?.length) {
      const th = visualH - waveH;
      const tw = Math.max(20, th * (m.width / Math.max(1, m.height)));
      const n = Math.ceil(w / tw);
      for (let i = 0; i < n; i++) {
        const local = (i * tw + tw / 2) / store.zoom;
        const src = c.reverse ? c.out - local * c.speed : c.in + local * c.speed;
        const idx = m.kind === 'image' ? 0 : Math.max(0, Math.min(list.length - 1, Math.floor((src / Math.max(0.01, m.duration)) * list.length)));
        strip.append(h('div', { style: { flex: `0 0 ${tw}px`, height: '100%', background: `url(${list[idx]}) center/cover` } }));
      }
    }
    el.append(strip);
  } else if (c.type === 'color') {
    el.style.background = c.fill?.startsWith('gradient:') ? `linear-gradient(90deg, ${c.fill.slice(9)})` : (c.fill ?? '#000');
  }
  if (waveH && m) {
    const wv = h('div', { class: 'wave' });
    wv.style.setProperty('--wave-h', `${waveH}px`);
    const peaks = waveOf(m.id);
    if (peaks) {
      const cv = h('canvas', { width: String(Math.min(4000, Math.ceil(w))), height: String(waveH) }) as HTMLCanvasElement;
      const ctx = cv.getContext('2d')!;
      ctx.fillStyle = c.muted ? '#5c647e' : '#9cc6ff';
      const per = 40; // peaks per second
      let top = 0.05;
      for (const v of peaks) if (v > top) top = v;
      for (let x = 0; x < cv.width; x++) {
        const local = (x / cv.width) * clipDur(c);
        const src = c.reverse ? c.out - local * c.speed : c.in + local * c.speed;
        const v = Math.min(1, ((peaks[Math.floor(src * per)] ?? 0) / top) * Math.min(2, c.volume));
        const hh = Math.max(1, v * waveH);
        ctx.fillRect(x, (waveH - hh) / 2, 1, hh);
      }
      wv.append(cv);
    }
    el.append(wv);
  }
  const label = c.type === 'title' ? (c.title?.text ?? '').replace(/\\N|\n/g, ' ') : c.name ?? m?.path.split(/[\\/]/).pop() ?? c.type;
  if (c.fadeIn > 0) el.append(h('div', { class: 'fade in', title: `Fundido de entrada ${c.fadeIn.toFixed(1)} s`, style: { width: `${Math.min(w, c.fadeIn * store.zoom)}px` } }));
  if (c.fadeOut > 0) el.append(h('div', { class: 'fade out', title: `Fundido de salida ${c.fadeOut.toFixed(1)} s`, style: { width: `${Math.min(w, c.fadeOut * store.zoom)}px` } }));
  el.append(h('div', { class: 'name' }, label));
  const badges: string[] = [];
  if (c.speed !== 1) badges.push(`${+c.speed.toFixed(2)}×`);
  if (c.reverse) badges.push('⟲');
  if (c.filters.length) badges.push('fx');
  if (c.muted) badges.push('🔇');
  if (c.stabilize) badges.push('estab.');
  if (badges.length) el.append(h('div', { class: 'badges' }, ...badges.map((b) => h('span', {}, b))));
  el.append(h('div', { class: 'edge l', dataset: { edge: 'l' } }), h('div', { class: 'edge r', dataset: { edge: 'r' } }));
  el.addEventListener('pointerdown', (e) => clipPointer(e, c, el));
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); hooks.openClip(c, true); });
  el.addEventListener('contextmenu', (e) => {
    if (!store.selection.has(c.id)) store.select([c.id]);
    contextMenu(e, hooks.clipMenu(c));
  });
  return el;
}

function drawRuler(width: number) {
  ruler.innerHTML = '';
  const z = store.zoom;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * z >= 90) ?? 600;
  const minor = major / 5;
  const total = x2t(width);
  for (let i = 0; i * minor <= total; i++) {
    // integer steps: accumulating floats made labels like 00:00:03 instead of 00:00:04
    const t = Math.round(i * minor * 1000) / 1000;
    const isMajor = i % 5 === 0;
    ruler.append(h('div', { class: `tick ${isMajor ? 'major' : 'minor'}`, style: { left: `${t2x(t)}px` } }));
    if (isMajor) {
      const lbl = major < 1 ? `${fmtShort(t)}.${Math.round((t % 1) * 10)}` : `${String(Math.floor(t / 3600)).padStart(2, '0')}:${fmtShort(t % 3600)}`;
      ruler.append(h('div', { class: 'lbl', style: { left: `${t2x(t)}px` } }, lbl));
    }
  }
}

function drawHeaders() {
  headers.innerHTML = '';
  const kindIcon: Record<TrackKind, string> = { title: ICONS.trackTitle, overlay: ICONS.trackOverlay, main: ICONS.trackVideo, audio: ICONS.trackAudio };
  for (const r of rows) {
    const t = r.track;
    const b = (icon: string, title: string, on: boolean, fn: () => void, test?: string) => h('button', { class: `ib${on ? ' on' : ''}`, title, html: icon, onclick: fn, dataset: test ? { test } : undefined });
    const btns: HTMLElement[] = [];
    if (t.kind !== 'audio') btns.push(b(t.hidden ? ICONS.eyeOff : ICONS.eye, t.hidden ? 'Mostrar pista' : 'Ocultar pista', false, () => void op('setTrack', t.id, { hidden: !t.hidden })));
    if (t.kind === 'main' || t.kind === 'audio' || t.kind === 'overlay') btns.push(b(t.muted ? ICONS.speakerOff : ICONS.speaker, t.muted ? 'Reactivar audio de pista' : 'Silenciar pista', false, () => void op('setTrack', t.id, { muted: !t.muted })));
    if (t.kind === 'main') btns.push(b(ICONS.link, t.gaps ? 'Deshabilitar espacio vacío' : 'Habilitar espacio vacío', t.gaps, () => void op('setTrack', t.id, { gaps: !t.gaps })));
    if (t.kind === 'title' || t.kind === 'overlay') btns.push(b(ICONS.link, t.linked !== false ? 'Pista vinculada: sus clips siguen al vídeo al editarlo (clic para desvincular)' : 'Vincular pista al vídeo', t.linked !== false, () => void op('setTrack', t.id, { linked: t.linked === false })));
    if (t.kind === 'audio') btns.push(b(ICONS.duck, t.duck ? 'Atenuación automática activada (baja bajo la voz)' : 'Atenuar bajo la voz', !!t.duck, () => void op('setTrack', t.id, { duck: !t.duck })));
    btns.push(b(t.locked ? ICONS.lock : ICONS.unlock, t.locked ? 'Desbloquear pista' : 'Bloquear pista', t.locked, () => void op('setTrack', t.id, { locked: !t.locked })));
    const row = h('div', { class: `th-row${store.selectedTrack === t.id ? ' sel' : ''}`, style: { top: `${r.top}px`, height: `${r.height}px` }, title: t.name },
      h('div', { class: 'kind', html: kindIcon[t.kind] }), h('div', { class: 'btns' }, ...btns.slice(0, 3)));
    row.oncontextmenu = (e) => contextMenu(e, [
      { label: t.hidden ? 'Mostrar pista' : 'Ocultar pista', fn: () => void op('setTrack', t.id, { hidden: !t.hidden }), disabled: t.kind === 'audio' },
      { label: t.muted ? 'Reactivar audio de pista' : 'Silenciar pista', fn: () => void op('setTrack', t.id, { muted: !t.muted }) },
      { label: t.locked ? 'Desbloquear pista' : 'Bloquear pista', fn: () => void op('setTrack', t.id, { locked: !t.locked }) },
      ...(t.kind === 'main' ? [{ label: t.gaps ? 'Deshabilitar espacio vacío en la pista' : 'Habilitar espacio vacío en la pista', fn: () => void op('setTrack', t.id, { gaps: !t.gaps }) }] : []),
      ...(t.kind === 'title' || t.kind === 'overlay' ? [{ label: t.linked !== false ? 'Desvincular pista' : 'Vincular pista', fn: () => void op('setTrack', t.id, { linked: t.linked === false }) }] : []),
      ...(t.kind === 'audio' ? [{ label: t.duck ? 'Desactivar atenuación bajo la voz' : 'Atenuar bajo la voz (ducking)', fn: () => void op('setTrack', t.id, { duck: !t.duck }) }] : []),
      { sep: true },
      { label: 'Eliminar todo el espacio vacío', fn: () => void op('closeGaps', t.id) },
      { label: 'Eliminar pista', disabled: t.kind === 'main', fn: async () => {
        const has = store.project.clips.some((c) => c.trackId === t.id);
        if (has && (await api.invoke('dialog:message', { type: 'question', buttons: ['Eliminar', 'Cancelar'], message: 'Esta pista contiene archivos multimedia. ¿Seguro que desea eliminarla?' })) !== 0) return;
        void op('removeTrack', t.id);
      } },
    ]);
    const grip = h('div', { class: 'th-grip', title: 'Arrastre para cambiar la altura de la pista' });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const y0 = e.clientY, h0 = HEIGHTS[t.kind];
      const mv = (ev: PointerEvent) => { HEIGHTS[t.kind] = Math.round(Math.max(30, Math.min(200, h0 + ev.clientY - y0))); render(); };
      const up = () => {
        removeEventListener('pointermove', mv);
        removeEventListener('pointerup', up);
        try { localStorage.setItem('cinta.heights', JSON.stringify(HEIGHTS)); } catch { /* storage off */ }
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up);
    });
    row.append(grip);
    headers.append(row);
  }
}

function drawMarkers() {
  markersEl.innerHTML = '';
  for (const m of store.project.markers) {
    const el = h('div', { class: `marker${m.name === 'Ritmo' ? ' beat' : ''}`, title: `${m.name} — ${fmtShort(m.time)}`, style: { left: `${t2x(m.time)}px` } });
    el.onclick = (e) => { e.stopPropagation(); stop(); store.seek(m.time); };
    el.oncontextmenu = (e) => contextMenu(e, [
      { label: 'Renombrar marcador…', fn: () => renameMarker(m.id, m.name) },
      { label: 'Eliminar marcador', fn: () => void op('removeMarker', m.id) },
      { label: 'Eliminar todos los marcadores', fn: () => void op('removeMarker') },
    ]);
    markersEl.append(el);
  }
}
function renameMarker(id: string, name: string) {
  const inp = h('input', { value: name, style: { position: 'fixed', left: '40%', top: '40%', zIndex: '200', width: '260px' } }) as HTMLInputElement;
  document.body.append(inp);
  inp.focus();
  inp.select();
  const done = (ok: boolean) => { if (ok && inp.value.trim()) void op('renameMarker', id, inp.value.trim()); inp.remove(); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
}

export function placePlayhead() {
  playhead.style.left = `${t2x(store.time)}px`;
  if (store.time > 0) {
    const x = t2x(store.time);
    if (x < scroll.scrollLeft + 20 || x > scroll.scrollLeft + scroll.clientWidth - 20) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.3);
  }
}

// ───────────────────────── pointer interactions ─────────────────────────
function clipPointer(e: PointerEvent, c: Clip, el: HTMLElement) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const edge = (e.target as HTMLElement).dataset.edge as 'l' | 'r' | undefined;
  if (e.ctrlKey || e.shiftKey) {
    if (store.selection.has(c.id)) store.selection.delete(c.id); else store.selection.add(c.id);
    store.emit('select');
    render();
    return;
  }
  if (!store.selection.has(c.id) || store.selection.size > 1) { store.select([c.id]); render(); }
  hooks.openClip(c, false);
  const track = store.trackOf(c)!;
  if (track.locked) return;
  const x0 = e.clientX, y0 = e.clientY;
  const left0 = parseFloat(el.style.left), w0 = parseFloat(el.style.width);
  let moved = false;
  const m = store.media(c);
  let snapDx = 0;
  const mv = (ev: PointerEvent) => {
    const raw = ev.clientX - x0, dy = ev.clientY - y0;
    if (!moved && Math.abs(raw) < 4 && Math.abs(dy) < 4) return;
    moved = true;
    const dur = clipDur(c);
    // magnet: the edge being moved sticks to the playhead, clip edges and markers (Alt = free)
    const snap = (times: number[]) => {
      if (ev.altKey) { guide(null); return raw; }
      let best: number | null = null, bestD = SNAP_PX;
      for (const base of times) {
        const t = base + raw / store.zoom;
        for (const p of snapPoints(c.id)) {
          const d = Math.abs(p - t) * store.zoom;
          if (d < bestD) { bestD = d; best = raw + (p - t) * store.zoom; guide(p); }
        }
      }
      if (best === null) guide(null);
      return best ?? raw;
    };
    if (edge === 'l') {
      const dx = snap([c.start]);
      const maxDx = w0 - 6;
      const minDx = m && m.kind !== 'image' ? -(c.reverse ? (m.duration - c.out) : c.in) / c.speed * store.zoom : -Infinity;
      const d = Math.max(minDx, Math.min(maxDx, dx));
      el.style.left = `${left0 + (track.kind === 'main' ? 0 : d)}px`;
      el.style.width = `${w0 - d}px`;
    } else if (edge === 'r') {
      const dx = snap([c.start + dur]);
      const maxW = m && m.kind !== 'image' ? ((c.reverse ? c.out : m.duration - c.in) / c.speed) * store.zoom : Infinity;
      el.style.width = `${Math.max(6, Math.min(maxW, w0 + dx))}px`;
    } else {
      snapDx = snap([c.start, c.start + dur]);
      el.style.left = `${left0 + snapDx}px`;
      el.style.transform = `translateY(${dy}px)`;
      el.style.zIndex = '20';
      el.style.opacity = '.85';
    }
  };
  const up = (ev: PointerEvent) => {
    removeEventListener('pointermove', mv);
    removeEventListener('pointerup', up);
    guide(null);
    if (!moved) return;
    const dx = snapDx;
    if (edge === 'l') {
      const dt = (w0 - parseFloat(el.style.width)) / store.zoom;
      if (c.reverse) void op('trim', c.id, { out: c.out - dt * c.speed });
      else void op('trim', c.id, { in: c.in + dt * c.speed, start: track.kind === 'main' ? undefined : c.start + dt });
    } else if (edge === 'r') {
      const dur = parseFloat(el.style.width) / store.zoom;
      void op('trim', c.id, { duration: dur });
    } else {
      const contentRect = tracksEl.getBoundingClientRect();
      const row = rowAt(ev.clientY - contentRect.top);
      const start = Math.max(0, c.start + dx / store.zoom);
      const target = row?.track ?? track;
      void op('move', c.id, { start, trackId: target.id !== track.id ? target.id : undefined });
    }
  };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', up);
}

const SNAP_PX = 8;
/** Times a dragged edge can stick to: playhead, project start, markers and the edges of other clips. */
function snapPoints(exclude: string): number[] {
  const pts = [0, store.time, ...store.project.markers.map((m) => m.time)];
  for (const c of store.project.clips) if (c.id !== exclude) pts.push(c.start, clipEnd(c));
  return pts;
}
let guideEl: HTMLElement | null = null;
function guide(t: number | null) {
  if (t === null) { guideEl?.remove(); guideEl = null; return; }
  guideEl ??= content.appendChild(h('div', { class: 'snap-guide' }));
  guideEl.style.left = `${t2x(t)}px`;
}

function scrub(e: PointerEvent) {
  stop();
  const r = content.getBoundingClientRect();
  const set = (x: number) => store.seek(x2t(x - r.left));
  set(e.clientX);
  const mv = (ev: PointerEvent) => set(ev.clientX);
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', up);
}

export function zoomTo(z: number, anchorTime = store.time) {
  const before = t2x(anchorTime) - scroll.scrollLeft;
  store.zoom = Math.max(4, Math.min(600, z));
  render();
  scroll.scrollLeft = Math.max(0, t2x(anchorTime) - before);
  store.emit('zoom');
}
export function zoomFit() {
  const d = Math.max(1, store.duration());
  zoomTo((scroll.clientWidth - 60) / d, 0);
}

export function initTimeline(hk: TimelineHooks) {
  hooks = hk;
  ruler.addEventListener('pointerdown', scrub);
  playhead.querySelector('.knob')!.addEventListener('pointerdown', (e) => { e.stopPropagation(); scrub(e as PointerEvent); });
  tracksEl.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.clip, .trans')) return;
    const row = rowAt(e.clientY - tracksEl.getBoundingClientRect().top);
    store.selectedTrack = row?.track.id ?? null;
    store.select([]);
    render();
    scrub(e);
  });
  scroll.addEventListener('scroll', () => { headers.scrollTop = scroll.scrollTop; headers.style.transform = `translateY(${-scroll.scrollTop}px)`; });
  scroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const r = content.getBoundingClientRect();
      zoomTo(store.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), x2t(e.clientX - r.left));
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && scroll.scrollHeight <= scroll.clientHeight + 2) {
      scroll.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  // drops from the panels and from Explorer
  const dropAt = (e: DragEvent) => {
    const r = tracksEl.getBoundingClientRect();
    const row = rowAt(e.clientY - r.top);
    const time = x2t(e.clientX - content.getBoundingClientRect().left);
    const clip = row ? store.project.clips.find((c) => c.trackId === row.track.id && time >= c.start && time <= clipEnd(c)) : undefined;
    return { trackId: row?.track.id, time, clip };
  };
  content.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    document.querySelectorAll('.track.drop-ok').forEach((x) => x.classList.remove('drop-ok'));
    const at = dropAt(e);
    if (at.trackId) document.querySelector(`.track[data-track="${at.trackId}"]`)?.classList.add('drop-ok');
  });
  content.addEventListener('dragleave', () => document.querySelectorAll('.track.drop-ok').forEach((x) => x.classList.remove('drop-ok')));
  content.addEventListener('drop', (e) => {
    e.preventDefault();
    document.querySelectorAll('.track.drop-ok').forEach((x) => x.classList.remove('drop-ok'));
    const at = dropAt(e);
    const raw = e.dataTransfer?.getData(DRAG_MIME);
    if (raw) { hooks.applyDrop(JSON.parse(raw) as DropPayload, at); return; }
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathOf(f)).filter(Boolean);
    if (files.length) hooks.importFiles(files, at);
  });
  $('tl-corner').innerHTML = '';
  $('tl-corner').append(h('button', { class: 'ib', title: 'Añadir una pista', html: ICONS.addTrack, onclick: (e: MouseEvent) => contextMenu(e, [
    { label: 'Añadir pista de título', fn: () => void op('addTrack', 'title') },
    { label: 'Añadir pista de vídeo', fn: () => void op('addTrack', 'overlay') },
    { label: 'Añadir pista de música', fn: () => void op('addTrack', 'audio') },
  ]) }));
  new ResizeObserver(() => render()).observe(scroll);
  store.on((why) => {
    if (why === 'time' || why === 'time-play') placePlayhead();
    else if (why !== 'zoom') render();
  });
}

export function toastDrop() { toast('Suelte el elemento sobre la línea de tiempo'); }
