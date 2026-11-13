// Player: exact frames from the compositor while paused/scrubbing, a low-latency fMP4 stream while playing.
import { ICONS } from './icons';
import { api, clipDur, clipEnd, fmt, h, op, store, toast } from './store';
import type { Clip } from '../core/model';

const $ = (id: string) => document.getElementById(id)!;
const frame = $('frame') as HTMLImageElement;
const video = $('video') as HTMLVideoElement;
const stage = $('stage');
const playerEl = $('player');

let playing = false;
let streamId = 0;
let playSeq = 0;
let streamFrom = 0;
let quality: 'low' | 'high' = 'low';
let frameTimer = 0;
let frameSeq = 0;
let ms: MediaSource | null = null;
let sb: SourceBuffer | null = null;
const queue: Uint8Array[] = [];
let ended = false;

export function isPlaying() { return playing; }

export function previewSize() {
  const p = store.project.settings;
  const r = stage.getBoundingClientRect();
  const maxW = quality === 'high' ? Math.min(1920, Math.round(r.width * devicePixelRatio)) : Math.min(640, Math.round(r.width));
  const w = Math.max(160, Math.round(maxW / 2) * 2);
  const hgt = Math.max(90, Math.round((w * p.height) / p.width / 2) * 2);
  return { w, h: hgt };
}

export function layoutStage() {
  const p = store.project.settings;
  const scr = $('screen').getBoundingClientRect();
  const ar = p.width / p.height;
  let w = scr.width, hh = scr.width / ar;
  if (hh > scr.height) { hh = scr.height; w = hh * ar; }
  stage.style.width = `${Math.floor(w)}px`;
  stage.style.height = `${Math.floor(hh)}px`;
  drawHandles();
}

/** Requests the exact composited frame at the playhead (debounced, latest wins). */
export function refreshFrame(delay = 40) {
  if (playing) return;
  clearTimeout(frameTimer);
  frameTimer = window.setTimeout(async () => {
    const seq = ++frameSeq;
    const has = store.project.clips.length > 0;
    playerEl.classList.toggle('has-content', has);
    if (!has) { frame.removeAttribute('src'); return; }
    const { w, h: hh } = previewSize();
    try {
      const url = await api.invoke('preview:frame', store.time, w, hh);
      // a hover preview (filter / transition being tried) wins over a frame that was already on its way
      if (seq === frameSeq && url && !tryLabel) frame.src = url;
    } catch (e) {
      if (!/Cancelado/.test(String(e))) console.warn(e);
    }
  }, delay);
}

// ───── playback (MediaSource fed by ffmpeg's fragmented MP4) ─────
api.on('preview:data', (id: number, chunk: Uint8Array) => {
  if (id !== streamId) return;
  mark('firstData');
  queue.push(chunk);
  pump();
});
api.on('preview:end', (id: number, err: string | null) => {
  if (id !== streamId) return;
  ended = true;
  if (err) { toast(`No se pudo reproducir: ${err.split('\n').pop()}`, true); stop(); return; }
  pump();
});
function pump() {
  if (!sb || sb.updating || !ms) return;
  if (queue.length) {
    const total = queue.reduce((s, c) => s + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of queue.splice(0)) { buf.set(c, o); o += c.byteLength; }
    try { sb.appendBuffer(buf); } catch (e) { console.warn(e); }
  } else if (ended && ms.readyState === 'open') {
    try { ms.endOfStream(); } catch { /* already */ }
  }
}

// start-up timeline of the last playback (diagnostics, read by the self-test)
const marks: Record<string, number> = {};
const mark = (k: string) => { if (!(k in marks)) marks[k] = Math.round(performance.now() - (marks.t0 ?? 0)); };
(window as unknown as { __playMarks: typeof marks }).__playMarks = marks;
video.addEventListener('playing', () => mark('playing'));
video.addEventListener('canplay', () => mark('canplay'));

export async function play() {
  if (playing) return stop();
  for (const k of Object.keys(marks)) delete marks[k];
  marks.t0 = performance.now();
  if (!store.project.clips.length) return;
  if (store.time >= store.duration() - 0.05) store.seek(0);
  clearTry();
  playing = true;
  playerEl.classList.add('playing');
  setPlayIcon();
  queue.length = 0;
  ended = false;
  streamFrom = store.time;
  ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  video.muted = false;
  video.volume = store.previewVolume;
  await new Promise<void>((r) => ms!.addEventListener('sourceopen', () => r(), { once: true }));
  mark('sourceopen');
  sb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028, mp4a.40.2"');
  sb.mode = 'sequence';
  sb.addEventListener('updateend', pump);
  const { w, h: hh } = previewSize();
  // set the id first: ffmpeg starts sending (header included) before the invoke below returns
  const id = ++playSeq;
  streamId = id;
  const r = await api.invoke('preview:play', streamFrom, w, hh, id).catch((e: unknown) => { toast(String(e), true); return null; });
  mark('invoke');
  if (!r || !playing || streamId !== id) return;
  video.play().catch(() => {});
  connectMeter();
  tick();
}

export function stop() {
  if (!playing) return;
  playing = false;
  streamId = -1;
  void api.invoke('preview:stop');
  video.pause();
  if (video.currentTime > 0) store.seek(streamFrom + video.currentTime);
  video.removeAttribute('src');
  video.load();
  ms = null;
  sb = null;
  playerEl.classList.remove('playing');
  setPlayIcon();
  refreshFrame(0);
}

let lastNudge = 0;
function tick() {
  if (!playing) return;
  // Chromium sometimes pauses a MediaSource video that started before its first fragment arrived:
  // once data is buffered past the current position, nudge it to play again
  if (video.paused && !video.ended && Date.now() - lastNudge > 300) {
    const b = video.buffered;
    if (b.length && b.end(b.length - 1) > video.currentTime + 0.1) { lastNudge = Date.now(); video.play().catch(() => {}); }
  }
  const t = streamFrom + video.currentTime;
  if (t >= store.duration() - 0.02 || (ended && video.ended)) {
    store.time = store.duration();
    stop();
    return;
  }
  store.time = t;
  store.emit('time-play');
  drawMeter();
  requestAnimationFrame(tick);
}

// ───── VU meter ─────
let actx: AudioContext | null = null;
let an: [AnalyserNode, AnalyserNode] | null = null;
function connectMeter() {
  if (actx) return;
  actx = new AudioContext();
  const src = actx.createMediaElementSource(video);
  const split = actx.createChannelSplitter(2);
  const l = actx.createAnalyser(), r = actx.createAnalyser();
  l.fftSize = r.fftSize = 1024;
  src.connect(split);
  split.connect(l, 0);
  split.connect(r, 1);
  src.connect(actx.destination);
  an = [l, r];
}
const vu = $('vu-canvas') as HTMLCanvasElement;
const peaks = [0, 0];
function drawMeter() {
  const ctx = vu.getContext('2d')!;
  const W = vu.width, H = vu.height;
  ctx.clearRect(0, 0, W, H);
  const buf = new Float32Array(1024);
  [0, 1].forEach((ch) => {
    let v = 0;
    if (an && playing) {
      an[ch].getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s = Math.max(s, Math.abs(x));
      v = s;
    }
    const db = v > 0 ? 20 * Math.log10(v) : -60;
    const lvl = Math.max(0, Math.min(1, (db + 60) / 60));
    peaks[ch] = Math.max(lvl, peaks[ch] - 0.01);
    const x = ch * (W / 2) + 2, w = W / 2 - 4;
    for (let y = 0; y < H; y += 3) {
      const f = 1 - y / H;
      ctx.fillStyle = f <= lvl ? (f > 0.9 ? '#e25e5e' : f > 0.75 ? '#f8c91c' : '#36c48f') : '#232633';
      ctx.fillRect(x, y, w, 2);
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, H - peaks[ch] * H, w, 1);
  });
}

// ───── controls ─────
let playBtn: HTMLButtonElement;
function setPlayIcon() { if (playBtn) playBtn.innerHTML = playing ? ICONS.pause : ICONS.play; }

export function stepFrame(dir: 1 | -1) {
  stop();
  // snap to the frame grid so repeated steps do not drift (30 × 1/30 must land on 1.000)
  const fps = store.project.settings.fps;
  store.seek(Math.round(store.time * fps + dir) / fps);
}
export function jumpClip(dir: 1 | -1) {
  stop();
  const cuts = new Set<number>([0, store.duration()]);
  for (const c of store.project.clips) { cuts.add(c.start); cuts.add(clipEnd(c)); }
  const list = [...cuts].sort((a, b) => a - b);
  const t = store.time;
  const next = dir > 0 ? list.find((x) => x > t + 0.001) : [...list].reverse().find((x) => x < t - 0.001);
  if (next !== undefined) store.seek(next);
}

export function initPlayer(onAspect: (aspect: string | null) => void) {
  const tr = $('transport');
  const btn = (icon: string, title: string, fn: () => void, cls = 'ib') => h('button', { class: cls, title, html: icon, onclick: fn });
  playBtn = btn(ICONS.play, 'Reproducir/Pausar (Espacio)', () => void play(), 'ib big') as HTMLButtonElement;
  playBtn.dataset.test = 'play';
  tr.append(
    btn(ICONS.prevClip, 'Ir al clip anterior', () => jumpClip(-1)),
    btn(ICONS.prevFrame, 'Ir al fotograma anterior', () => stepFrame(-1)),
    playBtn,
    btn(ICONS.nextFrame, 'Ir al fotograma siguiente', () => stepFrame(1)),
    btn(ICONS.nextClip, 'Ir al clip siguiente', () => jumpClip(1)),
  );
  const right = $('player-right');
  const aspect = h('button', { class: 'aspect-btn', title: 'Relación de aspecto', html: `<span id="aspect-lbl">16:9</span>${ICONS.chevron}` });
  aspect.onclick = (e) => {
    const items: [string, string | null][] = [['16:9 Panorámico (YouTube, TV)', '16:9'], ['9:16 Historia/TikTok', '9:16'], ['1:1 Cuadrado', '1:1'], ['4:5 Publicación de Instagram/Facebook', '4:5'], ['4:3 Clásico', '4:3'], ['21:9 Cine', '21:9'], ['Personalizar…', null]];
    contextMenu(e as MouseEvent, items.map(([label, a]) => ({ label, fn: () => onAspect(a) })));
  };
  const volWrap = h('div', { style: { position: 'relative' } });
  const volBtn = btn(ICONS.volume, 'Volumen de la vista previa', () => pop.classList.toggle('open'));
  const range = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1' }) as HTMLInputElement;
  const pop = h('div', { class: 'vol-pop' }, range);
  range.oninput = () => {
    store.previewVolume = +range.value;
    video.volume = store.previewVolume;
    volBtn.innerHTML = store.previewVolume === 0 ? ICONS.mute : ICONS.volume;
  };
  volWrap.append(volBtn, pop);
  const snap = btn(ICONS.camera, 'Guarde una instantánea', () => void snapshot());
  const more = btn(ICONS.dots, 'Modos de vista previa', () => {});
  more.onclick = (e) => contextMenu(e as MouseEvent, [
    { label: `${quality === 'high' ? '✓ ' : ''}Vista previa de alta resolución`, fn: () => { quality = 'high'; refreshFrame(0); } },
    { label: `${quality === 'low' ? '✓ ' : ''}Vista previa de baja resolución`, fn: () => { quality = 'low'; refreshFrame(0); } },
    { sep: true },
    { label: 'Vista previa de pantalla completa', fn: fullscreen },
  ]);
  const grid = btn(ICONS.grid, 'Guías de composición', () => {});
  grid.dataset.test = 'guides';
  grid.onclick = (e) => contextMenu(e as MouseEvent, ([['none', 'Sin guías'], ['thirds', 'Regla de los tercios'], ['safe', 'Zona segura (redes y TV)'], ['both', 'Tercios y zona segura']] as const).map(([id, label]) => ({ label: `${guides === id ? '✓ ' : ''}${label}`, fn: () => setGuides(id) })));
  right.append(aspect, grid, volWrap, snap, more);

  // progress bar seek
  const prog = $('progress');
  const seekAt = (x: number) => {
    const r = prog.getBoundingClientRect();
    store.seek(((x - r.left) / r.width) * store.duration());
  };
  prog.addEventListener('pointerdown', (e) => {
    stop();
    seekAt(e.clientX);
    const mv = (ev: PointerEvent) => seekAt(ev.clientX);
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  });
  new ResizeObserver(() => { layoutStage(); refreshFrame(); }).observe($('screen'));
  store.on((why) => {
    if (why === 'time' || why === 'time-play') updateClock();
    if (why === 'time') { refreshFrame(); drawHandles(); }
    if (why === 'state' || why === 'open' || why === 'external' || why === 'init' || why === 'undo' || why === 'redo' || why.length > 12 || why === 'select') {
      if (why !== 'select') clearTry(); // the project changed: show the real frame
      $('aspect-lbl').textContent = aspectLabel();
      drawGuides();
      layoutStage();
      updateClock();
      if (why !== 'select') refreshFrame();
      drawHandles();
    }
  });
  drawMeter();
}

function aspectLabel() {
  const { width: w, height: hh } = store.project.settings;
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, hh);
  const r = `${w / d}:${hh / d}`;
  return ['16:9', '9:16', '1:1', '4:5', '4:3', '21:9'].includes(r) ? r : `${w}×${hh}`;
}

function updateClock() {
  const t = store.time;
  const s = fmt(t, true);
  $('tc-main').textContent = s.slice(0, 8);
  $('tc-ms').textContent = s.slice(8);
  const d = store.duration();
  const f = d > 0 ? Math.min(1, t / d) : 0;
  ($('progress-fill') as HTMLElement).style.width = `${f * 100}%`;
  ($('progress-knob') as HTMLElement).style.left = `${f * 100}%`;
}

async function snapshot() {
  stop();
  if (!store.project.clips.length) return;
  const p = await api.invoke('snapshot', store.time);
  if (p) toast(`Instantánea guardada: ${p}`);
}

export function fullscreen() {
  const el = $('screen');
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen();
}

// ───── on-screen handles for the selected overlay / title ─────
function overlayBox(c: Clip): { x: number; y: number; w: number; h: number } | null {
  const P = store.project.settings;
  if (c.type === 'title' && c.title) {
    const unit = Math.min(P.width, P.height) / 1080;
    const lines = c.title.text.split(/\n|\\N/);
    const fs = c.title.size * unit;
    const w = Math.max(...lines.map((l) => l.length)) * fs * 0.55 / P.width;
    const hh = lines.length * fs * 1.25 / P.height;
    const ax = c.title.align === 'left' ? c.title.x + w / 2 : c.title.align === 'right' ? c.title.x - w / 2 : c.title.x;
    return { x: ax, y: c.title.y, w, h: hh };
  }
  const t = store.trackOf(c);
  if (!t || t.kind === 'main' || t.kind === 'audio' || c.type === 'audio') return null;
  const tf = c.transform ?? { x: 0.5, y: 0.5, scale: c.type === 'sticker' || c.type === 'callout' ? 0.3 : 1, rotation: 0 };
  const m = store.media(c);
  let ar = m && m.width ? m.width / m.height : c.type === 'callout' ? 1.5 : 1;
  if (c.crop) ar = ar * (c.crop.w / c.crop.h);
  const frameAr = P.width / P.height;
  let w = 1, hh = frameAr / ar;
  if (hh > 1) { hh = 1; w = ar / frameAr; }
  return { x: tf.x, y: tf.y, w: w * tf.scale, h: hh * tf.scale };
}

export function drawHandles() {
  const root = $('handles');
  root.innerHTML = '';
  if (playing) return;
  const c = store.first();
  if (!c || store.time < c.start || store.time > clipEnd(c)) return;
  const b = overlayBox(c);
  if (!b) return;
  const r = stage.getBoundingClientRect();
  const box = h('div', { class: 'handle-box', title: 'Arrastre para mover; la esquina cambia el tamaño' });
  const place = (bb: typeof b) => Object.assign(box.style, { left: `${(bb.x - bb.w / 2) * r.width}px`, top: `${(bb.y - bb.h / 2) * r.height}px`, width: `${bb.w * r.width}px`, height: `${bb.h * r.height}px` });
  place(b);
  const corner = h('div', { class: 'h' });
  box.append(corner);
  root.append(box);
  const tf0 = c.transform ?? { x: 0.5, y: 0.5, scale: c.type === 'sticker' || c.type === 'callout' ? 0.3 : 1, rotation: 0 };
  if (c.type === 'title' && c.title) {
    box.title = 'Arrastre para mover · doble clic para escribir · la esquina cambia el tamaño';
    box.addEventListener('dblclick', () => editTitleInline(c, box));
  } else {
    // rotation knob above the box
    const rot = h('div', { class: 'rot', title: 'Girar (Mayús: de 15 en 15°)' });
    box.style.transform = `rotate(${tf0.rotation}deg)`;
    box.append(rot);
    rot.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const br = box.getBoundingClientRect();
      const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      let ang = tf0.rotation;
      const mv = (ev: PointerEvent) => {
        ang = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
        if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
        ang = ((ang + 540) % 360) - 180;
        box.style.transform = `rotate(${ang}deg)`;
      };
      const up = () => {
        removeEventListener('pointermove', mv);
        removeEventListener('pointerup', up);
        if (Math.abs(ang - tf0.rotation) > 0.2) void op('set', c.id, { transform: { ...tf0, rotation: Math.round(ang * 10) / 10 }, pip: null });
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up);
    });
  }
  box.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    e.preventDefault();
    const resize = e.target === corner;
    const x0 = e.clientX, y0 = e.clientY;
    const cur = { ...b };
    const mv = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / r.width, dy = (ev.clientY - y0) / r.height;
      if (resize) {
        const k = Math.max(0.05, 1 + (dx + dy) / Math.max(0.05, b.w + b.h));
        cur.w = b.w * k; cur.h = b.h * k;
      } else { cur.x = b.x + dx; cur.y = b.y + dy; }
      place(cur);
    };
    const up = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
      const k = cur.w / b.w;
      if (Math.abs(k - 1) < 1e-3 && Math.abs(cur.x - b.x) < 1e-3 && Math.abs(cur.y - b.y) < 1e-3) return;
      if (c.type === 'title' && c.title) {
        const dxT = cur.x - b.x;
        void op('set', c.id, { title: { ...c.title, x: +(c.title.x + dxT).toFixed(4), y: +cur.y.toFixed(4), size: Math.round(c.title.size * k) } });
      } else {
        const tf = c.transform ?? { x: 0.5, y: 0.5, scale: c.type === 'sticker' || c.type === 'callout' ? 0.3 : 1, rotation: 0 };
        void op('set', c.id, { transform: { ...tf, x: +cur.x.toFixed(4), y: +cur.y.toFixed(4), scale: +(tf.scale * k).toFixed(4) }, pip: null });
      }
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  });
}

/** Write a title right on the picture: Ctrl+Intro or clicking outside saves, Esc cancels. */
export function editTitleInline(c: Clip, box: HTMLElement) {
  if (!c.title || box.querySelector('textarea')) return;
  const ta = h('textarea', { class: 'inline-title', dataset: { test: 'inline-title' }, spellcheck: 'true' }) as HTMLTextAreaElement;
  ta.value = c.title.text.replace(/\\N/g, '\n');
  box.append(ta);
  ta.focus();
  ta.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const text = ta.value.trim();
    ta.remove();
    if (save && text && text !== c.title!.text) void op('set', c.id, { title: { ...c.title!, text } });
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') finish(false);
    if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener('blur', () => finish(true));
}

// ───── composition guides (rule of thirds, social safe zones) ─────
type Guides = 'none' | 'thirds' | 'safe' | 'both';
let guides: Guides = (() => { try { return (localStorage.getItem('cinta.guides') as Guides) || 'none'; } catch { return 'none'; } })();
export function setGuides(g: Guides) {
  guides = g;
  try { localStorage.setItem('cinta.guides', g); } catch { /* storage off */ }
  drawGuides();
}
export function drawGuides() {
  const el = $('guides');
  el.innerHTML = '';
  if (guides === 'none') return;
  const parts: string[] = [];
  if (guides === 'thirds' || guides === 'both') {
    for (const v of [33.33, 66.67]) parts.push(`<line x1="${v}%" y1="0" x2="${v}%" y2="100%"/><line x1="0" y1="${v}%" x2="100%" y2="${v}%"/>`);
  }
  if (guides === 'safe' || guides === 'both') {
    const { width: w, height: hh } = store.project.settings;
    if (hh > w) {
      // vertical video: areas usually covered by the app's own interface (top bar, caption and buttons)
      parts.push('<rect class="unsafe" x="0" y="0" width="100%" height="12%"/><rect class="unsafe" x="0" y="78%" width="100%" height="22%"/><rect class="unsafe" x="84%" y="12%" width="16%" height="66%"/>');
      parts.push('<text x="50%" y="6.5%">Zona de la interfaz de la app</text>');
    } else {
      parts.push('<rect class="safe" x="5%" y="5%" width="90%" height="90%"/><rect class="safe title" x="10%" y="10%" width="80%" height="80%"/>');
    }
  }
  el.innerHTML = `<svg width="100%" height="100%">${parts.join('')}</svg>`;
}

// ───── temporary preview (hovering a filter or a transition) ─────
let tryLabel: HTMLElement | null = null;
/** Drops the hover preview (label and picture) without asking for a new frame. */
export function clearTry() { tryLabel?.remove(); tryLabel = null; }
export async function previewTry(make: (() => Promise<string | null>) | null, label = '') {
  tryLabel?.remove();
  tryLabel = null;
  if (!make) { refreshFrame(0); return; }
  if (playing) return;
  const url = await make().catch(() => null);
  if (!url) return;
  frame.src = url;
  tryLabel = h('div', { class: 'try-label', dataset: { test: 'try-label' } }, `Vista previa: ${label}`);
  stage.append(tryLabel);
}

// ───── shared context menu ─────
export interface MenuItem { label?: string; fn?: () => void; disabled?: boolean; sep?: boolean; kbd?: string }
export function contextMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  document.querySelectorAll('.ctx').forEach((x) => x.remove());
  const m = h('div', { class: 'ctx' });
  for (const it of items) {
    if (it.sep) { m.append(h('hr')); continue; }
    m.append(h('button', { disabled: it.disabled, onclick: () => { m.remove(); it.fn?.(); } }, h('span', {}, it.label ?? ''), it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
  setTimeout(() => addEventListener('pointerdown', (ev) => { if (!m.contains(ev.target as Node)) m.remove(); }, { once: true }), 0);
}

export { clipDur };
