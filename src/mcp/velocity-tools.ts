// MCP tools of the speed graph: keyframe velocity (After Effects' Keyframe Velocity dialog), the graph editor's
// interpolation buttons and Separate Dimensions of Position.
import * as z from 'zod';
import { Editor, motion } from '../core';
import type { Host } from './motion-tools';

const M = motion;
function pickComp(p: { comps?: motion.Comp[] }, id?: string) {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
}
const layerId = (c: motion.Comp, x: string) => M.findLayer(c, /^\d+$/.test(x) ? Number(x) : x).id;
const speed = z.union([z.number(), z.array(z.number())]).describe('Units per second (px/s along the path for position, anchor and points of interest; %/s, °/s… per dimension otherwise). A list gives one per dimension: the dimension that changes most is used (in Cinta the dimensions of a property share one easing curve).');
const side = z.object({ speed: speed.optional(), influence: z.number().min(0.1).max(100).optional().describe('% of the segment duration (0.1–100).') });
const round = (v: motion.KeyVel) => {
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  const s = (x: motion.Side | null) => (x ? { speed: v.dims === 1 ? r(x.speed[0]) : x.speed.map(r), influence: r(x.influence) } : null);
  return { key: v.index + 1, t: v.t, incoming: s(v.in), outgoing: s(v.out), continuous: v.continuous, ...(v.autoBezier ? { autoBezier: true } : {}), ...(v.spatial ? { alongPath: true } : {}) };
};

export function registerVelocityTools(H: Host) {
  const { tool, edit, ok, projectPath, P } = H;
  const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };
  const L = { layer: z.string().describe('Layer id, name or 1-based index.') };

  tool('keyframe_velocity', 'Velocidad de fotograma clave', 'After Effects Keyframe Velocity (Ctrl+Shift+K) and the speed graph: read or set the incoming / outgoing speed (units per second — along the motion path for position, anchor and points of interest, like After Effects; per dimension otherwise) and influence (% of the segment duration) of keys, and the Continuous lock (incoming = outgoing). Without in/out/continuous it only reads. Easy Ease is speed 0 and influence 33.33 %; a linear side reads its average speed at 16.67 %. Also interp: easy (F9), in (Easy Ease In, Shift+F9: incoming only), out (Easy Ease Out, Ctrl+Shift+F9: outgoing only), linear, hold, auto (auto-bezier) on those keys, applied before in/out.', {
    ...P, ...C, ...L, path: z.string().describe('Property path: position, scale, rotation, opacity, positionX… (as prop_set).'),
    times: z.array(z.number()).optional().describe('Which keys (comp seconds); default all.'),
    in: side.optional().describe('Incoming side (the segment arriving at the key).'), out: side.optional().describe('Outgoing side (the segment leaving the key).'),
    continuous: z.boolean().optional(), interp: z.enum(['easy', 'in', 'out', 'linear', 'hold', 'auto']).optional(),
  }, async (a) => {
    const set = a.in || a.out || a.continuous !== undefined ? { in: a.in, out: a.out, continuous: a.continuous } : undefined;
    if (!set && !a.interp) {
      const e = Editor.load(projectPath(a.project), true);
      const c = pickComp(e.project, a.comp);
      return ok({ path: M.canonPath(a.path), keys: (M.motionOps.keyframeVelocity(e, c.id, layerId(c, a.layer), a.path, { times: a.times }) as motion.KeyVel[]).map(round) });
    }
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp), id = layerId(c, a.layer);
      if (a.interp) M.motionOps.keyframeInterp(e, c.id, id, a.path, a.interp, a.times ?? 'all');
      return M.motionOps.keyframeVelocity(e, c.id, id, a.path, { times: a.times, set }) as motion.KeyVel[];
    });
    return ok({ path: M.canonPath(a.path), keys: out.map(round), project: e.path, canUndo: e.canUndo });
  });

  tool('separate_dimensions', 'Separar dimensiones', 'After Effects Separate Dimensions of a layer\'s Position: on splits it into positionX, positionY, positionZ (independent properties with their own keys, easing, speed graph and expressions; animate them with prop_set path positionX…); off joins them back into position. The keyframes are converted so the motion stays the same (keys are added where the dimensions eased differently or the path was curved).', {
    ...P, ...C, ...L, on: z.boolean(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.separateDimensions(e, c.id, layerId(c, a.layer), a.on); });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });
}
