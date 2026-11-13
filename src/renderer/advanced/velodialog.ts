// After Effects' Keyframe Velocity dialog («Velocidad de fotogramas clave», Ctrl+Shift+K): incoming and outgoing
// velocity per dimension (spatial properties: one speed along the path) with their influence, and «Continuo».
import { isSpatial } from '../../core/motion/anim';
import { keyVelocity, segDeltas, setKeyVelocity, velKind } from '../../core/motion/velocity';
import { modal } from '../dialogs';
import { h, toast } from '../store';
import { adv, propAt } from './state';
import { timecode } from './timeline';
import { unitOf } from './graph';

const NAMES: Record<string, string> = { 'transform.anchor': 'Punto de anclaje', 'transform.position': 'Posición', 'transform.positionX': 'Posición X', 'transform.positionY': 'Posición Y', 'transform.positionZ': 'Posición Z', 'transform.scale': 'Escala', 'transform.rotation': 'Rotación', 'transform.rotationX': 'Rotación X', 'transform.rotationY': 'Rotación Y', 'transform.opacity': 'Opacidad' };
const r4 = (x: number) => String(Math.round(x * 1e4) / 1e4);

export function velocityDialog() {
  const c = adv.comp();
  const q = adv.keys[0];
  const l = q && c?.layers.find((x) => x.id === q.layer);
  const p = l && propAt(l, q.path);
  const idx = p?.k?.findIndex((k) => Math.abs(k.t - q.t) < 1e-4) ?? -1;
  if (!c || !l || !p || idx < 0) { toast('Seleccione uno o varios fotogramas clave.', true); return; }
  let kind;
  try { kind = velKind(p, isSpatial(q.path)); } catch (e) { toast(String((e as Error).message), true); return; }
  const spatial = kind.spatial, dims = kind.dims;
  const v = keyVelocity(p, idx, spatial);
  const same = adv.keys.filter((x) => x.layer === q.layer && x.path === q.path);
  const unit = `${unitOf(q.path) === 'unidades' ? 'unidades' : unitOf(q.path) === 'px' ? 'píxeles' : unitOf(q.path) === '%' ? '%' : 'grados'}/seg`;
  const DIMS = ['X', 'Y', 'Z', 'W'];
  // deltas of the two segments: the dimensions of a side keep their proportions (one easing curve per segment)
  const ks = p.k!;
  const dsIn = idx > 0 ? segDeltas(ks, idx - 1, spatial, dims) : null, dsOut = idx + 1 < ks.length ? segDeltas(ks, idx, spatial, dims) : null;
  const num = (x: number, test: string, dis: boolean) => h('input', { type: 'number', value: r4(x), step: 'any', style: { width: '110px' }, disabled: dis, dataset: { test } }) as HTMLInputElement;
  const cont = h('input', { type: 'checkbox', checked: v.continuous, dataset: { test: 'kv-cont' } }) as HTMLInputElement;
  const group = (which: 'in' | 'out') => {
    const sd = v[which], ds = which === 'in' ? dsIn : dsOut, dis = !sd;
    const speeds = Array.from({ length: dims }, (_, d) => num(sd?.speed[d] ?? 0, `kv-${which}-${d}`, dis));
    const inf = num(sd?.influence ?? 100 / 3, `kv-${which}-inf`, dis);
    inf.min = '0.1'; inf.max = '100';
    // one dimension changed: the others follow (shared curve); Continuo mirrors it on the other side
    speeds.forEach((el, d) => el.addEventListener('input', () => {
      const s = Number(el.value);
      if (ds && Math.abs(ds[d]) > 1e-9) speeds.forEach((o, e) => { if (e !== d) o.value = r4((s * ds[e]) / ds[d]); });
      if (cont.checked) { const other = which === 'in' ? groups.out : groups.in; if (!other.dis) { other.speeds[d].value = el.value; other.speeds[d].dispatchEvent(new Event('sync')); } }
    }));
    speeds.forEach((el, d) => el.addEventListener('sync', () => { const s = Number(el.value); if (ds && Math.abs(ds[d]) > 1e-9) speeds.forEach((o, e) => { if (e !== d) o.value = r4((s * ds[e]) / ds[d]); }); }));
    const lock = h('label', { title: 'En Cinta las dimensiones de una propiedad comparten la curva de velocidad' }, h('input', { type: 'checkbox', checked: true, disabled: true }), ' Bloquear dimensiones');
    const el = h('fieldset', { class: 'kv-group' }, h('legend', {}, which === 'in' ? 'Velocidad de entrada' : 'Velocidad de salida'),
      ...speeds.map((s, d) => h('div', { class: 'frow' }, h('label', {}, spatial || dims === 1 ? '' : `Dimensión: ${DIMS[d]}`), h('div', { class: 'fval' }, s, ` ${unit}`))),
      h('div', { class: 'frow' }, h('label', {}, 'Influencia:'), h('div', { class: 'fval' }, inf, ' %')),
      dims > 1 && !spatial ? lock : null);
    return { el, speeds, inf, dis };
  };
  const groups = { in: group('in'), out: group('out') };
  const info = same.length > 1 ? `Estableciendo velocidad para ${same.length} fotogramas clave` : `Para fotograma clave #${idx + 1} en el instante ${timecode(ks[idx].t, c.fps)}`;
  const m = modal('Velocidad de fotogramas clave', [
    h('div', { class: 'hint' }, `Tipo de fotograma clave: ${NAMES[q.path] ?? q.path.split('.').pop()}`),
    h('div', { class: 'hint' }, info),
    h('div', { class: 'kv-cols' }, groups.in.el, groups.out.el),
    h('label', {}, cont, ' Continuo (Bloquear saliente y entrante)'),
  ], [
    h('button', { class: 'btn primary', dataset: { test: 'kv-ok' }, onclick: async () => {
      const side = (g: typeof groups.in) => (g.dis ? undefined : { speed: g.speeds.map((x) => Number(x.value)), influence: Math.max(0.1, Math.min(100, Number(g.inf.value))) });
      const o = { in: side(groups.in), out: side(groups.out), continuous: cont.checked };
      m.close();
      const w = adv.begin()!;
      const wp = propAt(w.layers.find((x) => x.id === l.id)!, q.path)!;
      for (const s of same) { const i = wp.k!.findIndex((k) => Math.abs(k.t - s.t) < 1e-4); if (i >= 0) setKeyVelocity(wp, i, spatial, o); }
      await adv.commit('Velocidad de fotograma clave');
    } }, 'Aceptar'),
    h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
  ], { width: 560 });
}
