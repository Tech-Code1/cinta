// Value editors of the advanced mode: draggable numbers (drag sideways; Shift ×10, Ctrl ×0.1; click to type),
// colour swatches, vectors, choices and text. Edits go to the working copy and are committed as one undo step.
import { keyedAt } from '../../core/motion/anim';
import { curveTable } from '../../motion-render/fx';
import type { ParamDef } from '../../core/motion/effects';
import type { Layer, PVal } from '../../core/motion/model';
import { h } from '../store';
import { adv, propAt, setProp } from './state';

const fmtNum = (v: number, unit = '') => `${Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2).replace(/\.?0+$/, '') || '0'}${unit}`;

/** Draggable number. */
export function scrub(value: number, o: { unit?: string; min?: number; max?: number; step?: number; test?: string; onInput: (v: number) => void; onCommit: () => void }): HTMLSpanElement {
  const el = h('span', { class: 'scrub', tabindex: '0', dataset: o.test ? { test: o.test } : {} }, fmtNum(value, o.unit));
  let v = value;
  const clamp = (x: number) => Math.max(o.min ?? -Infinity, Math.min(o.max ?? Infinity, x));
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, v0 = v;
    let moved = false;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const k = (ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1) * (o.step ?? 1);
      v = clamp(v0 + Math.round(dx) * k);
      el.textContent = fmtNum(v, o.unit);
      o.onInput(v);
    };
    const up = () => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      if (moved) o.onCommit();
      else typeIn();
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  });
  const typeIn = () => {
    const inp = h('input', { class: 'scrub-in', value: String(Math.round(v * 1000) / 1000) }) as HTMLInputElement;
    el.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      inp.replaceWith(el);
      if (!ok) return;
      // simple arithmetic is allowed ("100*2", "=50+10")
      let n = Number(inp.value.replace(',', '.'));
      if (!Number.isFinite(n)) { try { n = Number(Function(`"use strict"; return (${inp.value.replace(/^=/, '').replace(/[^-+*/().\d\s,]/g, '').replace(',', '.')})`)()); } catch { n = NaN; } }
      if (!Number.isFinite(n)) return;
      v = clamp(n);
      el.textContent = fmtNum(v, o.unit);
      o.onInput(v);
      o.onCommit();
    };
    inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  };
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); typeIn(); } });
  return el;
}

export interface EditorSpec { type: 'number' | 'vec' | 'color' | 'text' | 'choice' | 'bool' | 'angle' | 'percent' | 'path' | 'curve'; unit?: string; min?: number; max?: number; step?: number; choices?: { id: string; name: string }[]; dims?: number }

/** Infers the editor for a value (or from an effect parameter definition). */
export function specFor(v: PVal, def?: ParamDef, path = ''): EditorSpec {
  if (def) {
    if (def.type === 'choice') return { type: 'choice', choices: def.choices };
    if (def.type === 'curve') return { type: 'curve' };
    if (def.type === 'text') return { type: 'text' };
    // another layer of this composition: chosen from a list (stored as its id)
    if (def.type === 'layer') return { type: 'choice', choices: [{ id: '', name: 'Ninguna' }, ...(adv.comp()?.layers ?? []).map((l) => ({ id: l.id, name: l.name }))] };
    if (def.type === 'bool') return { type: 'bool' };
    if (def.type === 'color') return { type: 'color' };
    if (def.type === 'point') return { type: 'vec', dims: 2 };
    if (def.type === 'angle') return { type: 'number', unit: '°', step: 1 };
    if (def.type === 'percent') return { type: 'number', unit: '%', min: def.min, max: def.max, step: 1 };
    return { type: 'number', min: def.min, max: def.max, step: (def.max ?? 100) - (def.min ?? 0) <= 10 ? 0.05 : 1 };
  }
  if (/\.path$/.test(path)) return { type: 'path' };
  if (typeof v === 'string') return /^#[0-9a-f]{3,8}$/i.test(v) ? { type: 'color' } : { type: 'text' };
  if (Array.isArray(v)) {
    const dims = /scale$/.test(path) ? (v.length >= 3 ? 3 : 2) : v.length;
    return { type: 'vec', dims, unit: /scale$/.test(path) ? '%' : undefined };
  }
  if (/rotation|rotationX|rotationY|angle|direction|offset$/.test(path) && !/selectors/.test(path) && !/trim\.offset/.test(path)) return { type: 'number', unit: '°' };
  if (/opacity|start$|end$|amount|Amount|correlation/.test(path)) return { type: 'number', unit: '%', step: 1 };
  return { type: 'number', step: 1 };
}

/** Editor bound to a layer property: edits the working copy, re-renders live, commits on release. */
export function propEditor(layerId: string, path: string, spec: EditorSpec, label?: string): HTMLElement {
  const c = adv.comp();
  const l = c?.layers.find((x) => x.id === layerId);
  const p = l ? propAt(l, path) : undefined;
  if (!l || !p) return h('span', {});
  const v = keyedAt(p, adv.time, /position$|anchor$|poi$/.test(path));
  const live = (nv: PVal) => {
    const w = adv.begin();
    const wl = w?.layers.find((x) => x.id === layerId);
    if (!wl) return;
    setProp(wl, path, nv);
    adv.emit('comp');
  };
  const commit = () => void adv.commit(label ? `Cambiar ${label}` : 'Cambiar propiedad');
  const wrap = h('span', { class: 'pv', dataset: { path, layer: layerId } });
  switch (spec.type) {
    case 'number': case 'angle': case 'percent':
      wrap.append(scrub(Number(v) || 0, { unit: spec.unit, min: spec.min, max: spec.max, step: spec.step, test: `pv-${path}`, onInput: (n) => live(n), onCommit: commit }));
      break;
    case 'vec': {
      const arr = Array.isArray(v) ? [...v] : [Number(v) || 0];
      const n = spec.dims ?? arr.length;
      for (let i = 0; i < n; i++) {
        if (i) wrap.append(h('span', { class: 'sep' }, ','));
        wrap.append(scrub(arr[i] ?? 0, { unit: spec.unit, test: `pv-${path}-${i}`, onInput: (x) => { const w = adv.work?.layers.find((y) => y.id === layerId); const base = w ? (keyedAt(propAt(w, path)!, adv.time) as number[]) : arr; const nv = [...base]; nv[i] = x; if (/scale$/.test(path) && linked.has(`${layerId}|${path}`)) { const f = (base[i] || 1) === 0 ? 1 : x / (base[i] || 1); for (let j = 0; j < Math.min(2, nv.length); j++) if (j !== i) nv[j] = base[j] * f; } live(nv); }, onCommit: commit }));
      }
      if (/scale$/.test(path)) {
        const key = `${layerId}|${path}`;
        const lk = h('button', { class: `link${linked.has(key) ? ' on' : ''}`, title: 'Restringir proporciones', onclick: (e: MouseEvent) => { e.stopPropagation(); if (linked.has(key)) linked.delete(key); else linked.add(key); lk.classList.toggle('on'); } }, '⛓');
        wrap.prepend(lk);
      }
      break;
    }
    case 'color': {
      const inp = h('input', { type: 'color', value: String(v).slice(0, 7), dataset: { test: `pv-${path}` } }) as HTMLInputElement;
      inp.addEventListener('input', () => live(inp.value));
      inp.addEventListener('change', commit);
      wrap.append(inp);
      break;
    }
    case 'curve': {
      // Curves editor: click adds a point, drag moves it, Alt+click removes it (ends stay)
      const S = 128, cv = h('canvas', { width: S, height: S, class: 'pv-curve', title: 'Clic: añadir punto · arrastrar: mover · Alt+clic: quitar', dataset: { test: `pv-${path}` } }) as HTMLCanvasElement;
      let pts = String(v).trim().split(/\s+/).map((q) => q.split(',').map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
      const str = () => pts.map(([x, y]) => `${+x.toFixed(4)},${+y.toFixed(4)}`).join(' ');
      const paint = () => {
        const g = cv.getContext('2d')!;
        g.fillStyle = '#16181f'; g.fillRect(0, 0, S, S);
        g.strokeStyle = '#2c303c'; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo((i * S) / 4, 0); g.lineTo((i * S) / 4, S); g.moveTo(0, (i * S) / 4); g.lineTo(S, (i * S) / 4); g.stroke(); }
        const t = curveTable(str());
        g.strokeStyle = '#e8eaf0'; g.beginPath(); for (let i = 0; i < 256; i++) { const x = (i / 255) * S, y = S - t[i] * S; if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke();
        g.fillStyle = '#ffd400'; for (const [x, y] of pts) g.fillRect(x * S - 3, S - y * S - 3, 6, 6);
      };
      const at = (e: PointerEvent): [number, number] => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))]; };
      let dragI = -1;
      cv.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const [x, y] = at(e);
        let i = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.06);
        if (e.altKey) { if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); live(str()); commit(); paint(); } return; }
        if (i < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); i = pts.findIndex((q) => q[0] === x && q[1] === y); }
        dragI = i; cv.setPointerCapture(e.pointerId); live(str()); paint();
      });
      cv.addEventListener('pointermove', (e) => {
        if (dragI < 0) return;
        const [x, y] = at(e), lo = dragI > 0 ? pts[dragI - 1][0] + 0.004 : 0, hi = dragI < pts.length - 1 ? pts[dragI + 1][0] - 0.004 : 1;
        pts[dragI] = [Math.max(lo, Math.min(hi, x)), y]; live(str()); paint();
      });
      cv.addEventListener('pointerup', () => { if (dragI >= 0) { dragI = -1; commit(); } });
      paint();
      wrap.append(cv);
      break;
    }
    case 'text': {
      const inp = h('input', { value: String(v), class: 'pv-text', dataset: { test: `pv-${path}` } }) as HTMLInputElement;
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => { live(inp.value); commit(); });
      wrap.append(inp);
      break;
    }
    case 'choice': {
      const sel = h('select', { dataset: { test: `pv-${path}` } }, ...(spec.choices ?? []).map((ch) => h('option', { value: ch.id, selected: ch.id === v }, ch.name))) as HTMLSelectElement;
      sel.addEventListener('change', () => { live(sel.value); commit(); });
      wrap.append(sel);
      break;
    }
    case 'bool': {
      const cb = h('input', { type: 'checkbox', checked: !!Number(v), dataset: { test: `pv-${path}` } }) as HTMLInputElement;
      cb.addEventListener('change', () => { live(cb.checked ? 1 : 0); commit(); });
      wrap.append(cb);
      break;
    }
    case 'path':
      wrap.append(h('span', { class: 'muted' }, 'Forma'));
      break;
  }
  return wrap;
}
const linked = new Set<string>();

/** Layer label colour + name, used in lists. */
export function layerChip(l: Layer) { return h('span', { class: 'chip' }, h('i', { style: { background: l.label } }), l.name); }
