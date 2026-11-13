// Vector Paint in the Composition viewer: «Pintar en el visor» in the effect's controls turns the Brush tool's drag on the
// layer into strokes of the effect (stored in its «strokes» parameter with the time they were painted and how long
// each point took, as After Effects records them for Animate Strokes); «Borrar trazos» empties it.
import { apply, invert, worldMatrix } from '../../core/motion/geom';
import { vpParse } from '../../core/motion/fx-groups/particulas';
import type { Comp, FxInstance, Layer } from '../../core/motion/model';
import { h, toast } from '../store';
import { adv, mop } from './state';
import type { ViewCtx } from './paint-ui';

/** the Vector Paint effects being painted in the viewer (by effect id) */
const painting = new Set<string>();

const strokesOf = (f: FxInstance) => { const v = f.params.strokes?.v; return typeof v === 'string' ? v : '[]'; };
const val = (f: FxInstance, k: string, d: number | string) => { const v = f.params[k]?.v; return v === undefined ? d : v; };

export function vectorPaintControls(c: Comp, l: Layer, f: FxInstance): HTMLElement {
  const on = painting.has(f.id), n = vpParse(strokesOf(f)).length;
  return h('div', { class: 'fxrow', dataset: { test: 'vp-panel' } },
    h('button', { class: `btn small${on ? ' on' : ''}`, dataset: { test: 'vp-paint' }, title: 'Arrastre en el visor con la herramienta Pincel (Ctrl+B) para pintar trazos de este efecto', onclick: () => {
      if (on) painting.delete(f.id); else { painting.clear(); painting.add(f.id); adv.tool = 'brush'; adv.emit('tool'); toast('Pintura vectorial: arrastre en el visor para pintar.'); }
      adv.emit('select');
    } }, on ? 'Dejar de pintar' : 'Pintar en el visor'),
    h('button', { class: 'btn small', dataset: { test: 'vp-clear' }, disabled: !n, onclick: () => void mop('propSet', c.id, l.id, `effects.${f.id}.strokes`, { value: '[]' }) }, 'Borrar trazos'),
    h('span', { class: 'hint', dataset: { test: 'vp-count' } }, `${n} trazo${n === 1 ? '' : 's'}`));
}

/** a Brush drag on a layer whose Vector Paint is being painted: records a stroke; false = not ours (normal paint) */
export function vpPaintDown(e: PointerEvent, v: ViewCtx): boolean {
  const l = v.layer, f = l?.effects.find((q) => q.fx === 'vectorPaint' && q.on && painting.has(q.id));
  if (!l || !f) return false;
  const inv = invert(worldMatrix(v.c, l, adv.time)), toLayer = (p: [number, number]) => { const q = apply(inv, p[0], p[1]); return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]; };
  const t0 = performance.now(), pts: number[][] = [[...toLayer(v.toComp(e)), 0]];
  try { v.stage.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  const mv = (ev: PointerEvent) => {
    const q = toLayer(v.toComp(ev)), last = pts[pts.length - 1];
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 0.5) return;
    pts.push([q[0], q[1], Math.round((performance.now() - t0)) / 1000]);
  };
  const up = () => {
    v.stage.removeEventListener('pointermove', mv);
    v.stage.removeEventListener('pointerup', up);
    let list: unknown[] = [];
    try { const a = JSON.parse(strokesOf(f)); if (Array.isArray(a)) list = a; } catch { /* bad text: start again */ }
    list.push({ t: Math.round((adv.time - l.start) * 1000) / 1000, color: val(f, 'brushColor', '#ffffff'), radius: val(f, 'brushRadius', 8), feather: val(f, 'brushFeather', 50), opacity: val(f, 'brushOpacity', 100), points: pts });
    void mop('propSet', v.c.id, l.id, `effects.${f.id}.strokes`, { value: JSON.stringify(list) });
  };
  v.stage.addEventListener('pointermove', mv);
  v.stage.addEventListener('pointerup', up);
  return true;
}
