// Warp Stabilizer in the window: the analysis starts by itself in the background when the effect is applied (or
// when the layer's span or Detailed Analysis change), like After Effects; Effect Controls show the Analyze / Cancel
// button, the progress («NN % (fotograma X de N)») and the Auto-scale readout.
import type { Comp, FxInstance, Layer } from '../../core/motion/model';
import { stabilize, stabSpan } from '../../core/motion/warpstab';
import { stabParams, stabStats, stabStatus } from '../../motion-render/warpstab';
import { api, cleanErr, h, store, toast } from '../store';
import { adv } from './state';
import { requestRender } from './viewer';

/** analyses already started for an effect + key (an undone analysis is not started again by itself) */
const started = new Set<string>();
let wired = false;

function expectedKey(c: Comp, l: Layer, f: FxInstance): string | null {
  const m = store.project.media.find((x) => x.id === l.mediaId);
  if (l.type !== 'video' || !m?.path || l.timeRemap) return null;
  return stabSpan(l, m, c.fps, !!Number(f.params.detailed?.v ?? 0)).key;
}

/** Starts (or restarts) the background analysis of one effect. */
export async function analyzeStab(c: Comp, l: Layer, f: FxInstance) {
  const key = expectedKey(c, l, f);
  if (!key) { toast(`«${l.name}» no es una capa de vídeo: el Estabilizador de deformación analiza el metraje de la capa.`, true); return; }
  started.add(`${f.id}|${key}`);
  stabStatus.set(f.id, { phase: 1, frac: 0 });
  requestRender();
  adv.emit('comp');
  try {
    await api.invoke('warpstab:analyze', c.id, l.id, f.id);
  } catch (e) {
    const msg = cleanErr(e);
    if (!/cancelado/.test(msg)) toast(`Error de análisis. ${msg}`, true);
  } finally {
    stabStatus.delete(f.id);
    requestRender();
    adv.emit('comp');
  }
}

/** Effects of the open comp that need analysing and were not started yet: start them, one after the other. */
function autoAnalyze() {
  const c = adv.comp();
  if (!c || adv.work) return;
  for (const l of c.layers) for (const f of l.effects) {
    if (f.fx !== 'warpStabilizer' || !f.on || stabStatus.has(f.id)) continue;
    const key = expectedKey(c, l, f);
    if (!key || f.stab?.key === key || started.has(`${f.id}|${key}`)) continue;
    void analyzeStab(c, l, f);
  }
}

export function wireWarpStab() {
  if (wired) return;
  wired = true;
  const phases: number[] = [];
  (window as unknown as { __warpstab: unknown }).__warpstab = { phases, banners: stabStats };
  api.on('warpstab:progress', (id, phase, frac) => {
    const fxId = String(id);
    if (phases[phases.length - 1] !== Number(phase)) phases.push(Number(phase));
    if (!Number(phase)) stabStatus.delete(fxId); else stabStatus.set(fxId, { phase: Number(phase) as 1 | 2, frac: Number(frac) });
    requestRender();
    const f = adv.comp()?.layers.flatMap((l) => l.effects).find((x) => x.id === fxId);
    document.querySelectorAll<HTMLElement>(`[data-stab-status="${fxId}"]`).forEach((el) => { el.textContent = statusText(fxId, f); });
  });
  store.on((why) => { if (why === 'state' || why === 'init' || why === 'undo' || why === 'redo') setTimeout(autoAnalyze, 0); });
  adv.on((why) => { if (why === 'comp') setTimeout(autoAnalyze, 0); });
}

function statusText(fxId: string, f?: FxInstance): string {
  const st = stabStatus.get(fxId);
  if (st?.phase === 1) { const n = f?.stab?.n; return `Análisis en segundo plano (paso 1 de 2): ${Math.round(st.frac * 100)} %${n ? ` (fotograma ${Math.round(st.frac * n)} de ${n})` : ''}`; }
  if (st?.phase === 2) return 'Estabilización (paso 2 de 2)';
  if (!f?.stab) return 'Haga clic en Analizar para comenzar.';
  return `Estabilización finalizada: ${f.stab.n} fotogramas`;
}

/** Extra rows of the effect in Effect Controls: Analyze / Cancel, the status and the Auto-scale readout. */
export function warpStabControls(c: Comp, l: Layer, f: FxInstance): HTMLElement {
  wireWarpStab();
  const busy = stabStatus.has(f.id);
  const key = expectedKey(c, l, f), stale = !!f.stab && key !== null && f.stab.key !== key;
  let readout = '';
  if (f.stab && !stale) {
    const p: Record<string, unknown> = Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, v.v]));
    const r = stabilize(f.stab, stabParams(p));
    if (String(p.framing ?? 'cropScale') === 'cropScale') readout = `Escala automática (${Math.round(r.scale / (Number(p.additionalScale ?? 100) / 100 || 1) * 100)}%)`;
  }
  return h('div', { class: 'fxrow', dataset: { test: 'warpstab-panel' } },
    h('button', { class: 'btn small', dataset: { test: busy ? 'warpstab-cancel' : 'warpstab-analyze' }, onclick: () => (busy ? void api.invoke('warpstab:cancel', f.id) : void analyzeStab(c, l, f)) }, busy ? 'Cancelar' : 'Analizar'),
    h('span', { class: 'hint', dataset: { stabStatus: f.id, test: 'warpstab-status' } }, stale && !busy ? 'Los nuevos fotogramas necesitan análisis; haga clic en Analizar.' : statusText(f.id, f)),
    readout ? h('span', { class: 'hint', dataset: { test: 'warpstab-autoscale' } }, ` · ${readout}`) : null);
}

wireWarpStab();
