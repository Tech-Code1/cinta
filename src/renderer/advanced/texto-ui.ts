// «texto» in the advanced mode: the Character panel's extras (scales, baseline shift, tsume, Faux bold / italic,
// All caps, Small caps, Superscript, Subscript, Hindi digits, Tate-chu-yoko, standard vertical Roman alignment),
// the Paragraph panel, the Vertical Type tool (Ctrl+T cycles), paragraph text by dragging with a type tool, the
// text orientation and point ↔ paragraph conversion in the layer menu, and After Effects' text editing shortcuts.
// While editing text in the viewer, character attributes go to the selected characters; otherwise to the layer.
import { keyedAt } from '../../core/motion/anim';
import type { CharStyle, Comp, Layer, TextDoc } from '../../core/motion/model';
import { layoutText, type Layout } from '../../core/motion/text';
import { baseStyle, layoutExtras, styleResolver } from '../../core/motion/textstyle';
import { h } from '../store';
import { adv, mop } from './state';

type Item = { label?: string; fn?: () => void; disabled?: boolean; sep?: boolean; kbd?: string };

// ───────────────────────── Vertical Type tool ─────────────────────────
/** Herramienta Tipo vertical: the type tool creates vertical text. */
export let verticalType = false;
export function toggleVerticalType() { verticalType = !verticalType; refreshTypeButton(); }
function refreshTypeButton() {
  const b = document.querySelector<HTMLElement>('#adv-head .tool[data-tool="text"]');
  if (!b) return;
  b.textContent = verticalType ? 'T⇣' : 'T';
  b.title = `${verticalType ? 'Herramienta Tipo vertical' : 'Herramienta Tipo horizontal'} (Ctrl+T)`;
  b.dataset.vertical = verticalType ? '1' : '';
}
adv.on((why) => { if (why === 'tool') refreshTypeButton(); });

// ───────────────────────── editing state (the viewer's text box) ─────────────────────────
let editing: { ta: HTMLTextAreaElement; id: string; finish: (save: boolean) => void } | null = null;
/** The viewer registers its text box: attributes then go to its selection, and clicks on the Character /
 *  Paragraph panels do not end the editing. */
export function registerEditing(ta: HTMLTextAreaElement, id: string, finish: (save: boolean) => void) {
  editing = { ta, id, finish };
  const c = adv.comp(), l = c?.layers.find((x) => x.id === id);
  if (l?.text?.vertical) { ta.style.writingMode = 'vertical-rl'; ta.style.minHeight = '160px'; }
  ta.addEventListener('keydown', (ev) => { if (textoKey(ev)) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  const outside = (ev: PointerEvent) => {
    const t = ev.target as Node | null;
    if (t && (ta.contains(t) || (t instanceof Element && t.closest('.texto-keep')))) return;
    document.removeEventListener('pointerdown', outside, true);
    if (editing?.ta === ta) finish(true);
  };
  document.addEventListener('pointerdown', outside, true);
}
export function unregisterEditing(ta: HTMLTextAreaElement) { if (editing?.ta === ta) editing = null; }
/** blur that should not finish the editing: focus went to the Character / Paragraph panels */
export const keepEditing = (ev: FocusEvent) => { const r = ev.relatedTarget; return r instanceof Element && !!r.closest('.texto-keep'); };
const selection = (l: Layer): [number, number] | null => {
  if (!editing || editing.id !== l.id || !editing.ta.isConnected) return null;
  const { selectionStart: s, selectionEnd: e } = editing.ta;
  return e > s ? [s, e] : null;
};
/** commit what was typed so the selection's offsets match the layer's text */
async function syncTyped(c: Comp, l: Layer) {
  if (!editing || editing.id !== l.id) return;
  const cur = String(keyedAt(l.text!.text, adv.time) ?? '');
  if (editing.ta.value !== cur) await mop('textEdit', c.id, l.id, editing.ta.value, l.text!.text.k?.length ? adv.time : undefined);
}
const fresh = (l: Layer) => adv.comp()?.layers.find((x) => x.id === l.id) ?? l;

/** Character attributes to the selected characters (while editing) or to the whole layer. */
export async function applyChar(c: Comp, l: Layer, patch: Partial<Record<keyof CharStyle, unknown>>) {
  const sel = selection(l);
  if (sel) {
    const ta = editing!.ta;
    await syncTyped(c, l);
    await mop('textFormat', c.id, l.id, { character: patch, range: sel, t: adv.time });
    if (ta.isConnected) { ta.focus(); ta.setSelectionRange(sel[0], sel[1]); }
  } else await mop('textFormat', c.id, l.id, { character: patch });
}
/** The style shown by the panel: at the selection's first character, else the layer's. */
const shownStyle = (l: Layer): CharStyle => { const sel = selection(l); return sel ? styleResolver(l.text!)(sel[0]) : baseStyle(l.text!); };

// ───────────────────────── Character panel extras ─────────────────────────
/** Rows added at the bottom of the Character panel (After Effects' layout: scales, baseline shift / tsume, the six
 *  style buttons, then Hindi digits and the panel menu's vertical-text options). */
export function characterExtras(c: Comp, l: Layer): HTMLElement {
  const st = shownStyle(l), d = l.text!;
  const sel = () => !!selection(l);
  const num = (key: 'vScale' | 'hScale' | 'baselineShift' | 'tsume', title: string, unit: string, def: number) => {
    const i = h('input', { type: 'number', value: String(st[key] ?? def), title, style: { width: '62px' }, dataset: { test: `char-${key}` } }) as HTMLInputElement;
    i.onkeydown = (e) => e.stopPropagation();
    i.onchange = () => { const v = Number(i.value); void applyChar(c, fresh(l), { [key]: Number.isFinite(v) && v !== def ? v : sel() ? def : null }); };
    return h('span', { class: 'texto-num', title }, i, unit);
  };
  const toggle = (key: 'fauxBold' | 'fauxItalic' | 'allCaps' | 'smallCaps' | 'super' | 'sub', icon: string, title: string, css: Record<string, string>) => {
    const on = key === 'super' || key === 'sub' ? st.script === key : key === 'allCaps' ? !!(st.allCaps ?? d.allCaps) : !!st[key];
    return h('button', {
      class: `tb texto-st${on ? ' on' : ''}`, title, dataset: { test: `char-${key}` }, style: css,
      // keep the focus (and the selection) in the viewer's text box
      onmousedown: (e: MouseEvent) => e.preventDefault(),
      onclick: () => {
        const off = sel() ? false : null;
        const patch: Record<string, unknown> = key === 'super' || key === 'sub' ? { script: on ? (sel() ? 'none' : null) : key } : { [key]: on ? off : true };
        // All caps and Small caps exclude each other
        if (!on && key === 'smallCaps') patch.allCaps = sel() ? false : null;
        if (!on && key === 'allCaps') patch.smallCaps = sel() ? false : null;
        void applyChar(c, fresh(l), patch);
      },
    }, icon);
  };
  const flag = (key: 'hindiDigits' | 'romanStd', label: string) => {
    const b = h('input', { type: 'checkbox', checked: !!d[key], dataset: { test: `char-${key}` } }) as HTMLInputElement;
    b.onchange = () => void mop('textFormat', c.id, l.id, { [key]: b.checked });
    return h('label', {}, b, ` ${label}`);
  };
  const tcy = h('input', { type: 'checkbox', checked: !!st.tcy, dataset: { test: 'char-tcy' } }) as HTMLInputElement;
  tcy.onmousedown = (e) => e.preventDefault();
  tcy.onchange = () => void applyChar(c, fresh(l), { tcy: tcy.checked ? true : sel() ? false : null });
  const row = (label: string, ...kids: Node[]) => h('div', { class: 'crow' }, h('span', { class: 'nm' }, label), ...kids);
  return h('div', { class: 'texto-keep texto-char' },
    row('Ajustar', num('vScale', 'Ajustar verticalmente', ' % ↕', 100), num('hScale', 'Ajustar horizontalmente', ' % ↔', 100)),
    row('Línea de base / Tsume', num('baselineShift', 'Definir distancia a línea de base', ' px', 0), num('tsume', 'Definir Tsume de los caracteres seleccionados', ' %', 0)),
    h('div', { class: 'brow texto-styles' },
      toggle('fauxBold', 'T', 'Faux negrita', { fontWeight: '900' }), toggle('fauxItalic', 'T', 'Faux cursiva', { fontStyle: 'italic' }),
      toggle('allCaps', 'TT', 'Todo en mayúsculas', {}), toggle('smallCaps', 'Tᴛ', 'Versalitas', {}),
      toggle('super', 'T¹', 'Superíndice', {}), toggle('sub', 'T₁', 'Subíndice', {})),
    row('', flag('hindiDigits', 'Dígitos hindi')),
    row('Texto vertical', h('label', { title: 'Los caracteres seleccionados van uno al lado del otro en un solo espacio vertical' }, tcy, ' Tate-Chuu-Yoko'), flag('romanStd', 'Alineación latina vertical estándar')),
    sel() ? h('div', { class: 'hint' }, 'Se aplica a los caracteres seleccionados.') : null);
}

// ───────────────────────── Paragraph panel ─────────────────────────
export function paragraphPanel(el: HTMLElement) {
  el.classList.add('texto-keep');
  const draw = () => {
    if (adv.work) return;
    const c = adv.comp(), l = adv.first();
    if (!c || !l?.text) { el.replaceChildren(h('div', { class: 'hint pad' }, 'Seleccione una capa de texto.')); return; }
    const d = l.text, v = !!d.vertical, box = !!d.box;
    const set = (paragraph: Record<string, unknown>) => void mop('textFormat', c.id, l.id, { paragraph });
    const al = (a: 'left' | 'center' | 'right', icon: string) => {
      const title = v ? { left: 'Alinear texto arriba', center: 'Centrar texto', right: 'Alinear texto abajo' }[a] : { left: 'Alinear texto a la izquierda', center: 'Centrar texto', right: 'Alinear texto a la derecha' }[a];
      return h('button', { class: `tb${!d.justify && d.align === a ? ' on' : ''}`, title, dataset: { test: `para-align-${a}` }, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => set({ align: a, justify: null }) }, icon);
    };
    const js = (j: 'left' | 'center' | 'right' | 'all', icon: string) => {
      const title = j === 'all' ? 'Justificar todo' : v ? { left: 'Justificar último en la parte superior', center: 'Justificar último centrado', right: 'Justificar último en la parte inferior' }[j] : { left: 'Justificar último a la izquierda', center: 'Justificar último centrado', right: 'Justificar último a la derecha' }[j];
      // as in After Effects, justification is for paragraph text
      return h('button', { class: `tb${d.justify === j ? ' on' : ''}`, title: box ? title : `${title} (texto de párrafo)`, disabled: !box, dataset: { test: `para-justify-${j}` }, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => set({ justify: j }) }, icon);
    };
    const num = (key: 'indentLeft' | 'indentRight' | 'indentFirst' | 'spaceBefore' | 'spaceAfter', title: string, icon: string) => {
      const i = h('input', { type: 'number', value: String(d[key] ?? 0), title, style: { width: '62px' }, dataset: { test: `para-${key}` } }) as HTMLInputElement;
      i.onkeydown = (e) => e.stopPropagation();
      i.onchange = () => set({ [key]: Number(i.value) || 0 });
      return h('span', { class: 'texto-num', title }, icon, ' ', i, ' px');
    };
    const composer = (k: 'single' | 'every', label: string) => {
      const r = h('input', { type: 'radio', name: 'texto-composer', checked: (d.composer ?? 'single') === k, dataset: { test: `para-composer-${k}` } }) as HTMLInputElement;
      r.onchange = () => set({ composer: k });
      return h('label', {}, r, ` ${label}`);
    };
    const hy = h('input', { type: 'checkbox', checked: !!d.hyphenate, dataset: { test: 'para-hyphenate' } }) as HTMLInputElement;
    hy.onchange = () => set({ hyphenate: hy.checked });
    el.replaceChildren(h('div', { class: 'pad texto-para' },
      h('div', { class: 'brow' }, al('left', v ? '⤒' : '⯇'), al('center', '≡'), al('right', v ? '⤓' : '⯈'), js('left', '☰⯇'), js('center', '☰≡'), js('right', '☰⯈'), js('all', '☰')),
      h('div', { class: 'crow' }, num('indentLeft', v ? 'Sangría en margen superior' : 'Sangría en margen izquierdo', v ? '⇟' : '⇥'), num('indentRight', v ? 'Sangría en margen inferior' : 'Sangría en margen derecho', v ? '⇞' : '⇤')),
      h('div', { class: 'crow' }, num('indentFirst', 'Sangría en primera línea', '↦')),
      h('div', { class: 'crow' }, num('spaceBefore', 'Agregar espacio antes de párrafo', '⇡'), num('spaceAfter', 'Agregar espacio después de párrafo', '⇣')),
      h('div', { class: 'crow' }, composer('single', 'Composición línea por línea de Adobe')),
      h('div', { class: 'crow' }, composer('every', 'Composición multilínea de Adobe')),
      h('div', { class: 'crow' }, h('label', {}, hy, ' Separación automática')),
      h('div', { class: 'brow' }, h('button', { class: 'tb', dataset: { test: 'para-reset' }, onclick: () => set({ align: 'left', justify: null, indentLeft: 0, indentRight: 0, indentFirst: 0, spaceBefore: 0, spaceAfter: 0, hyphenate: false, composer: 'every' }) }, 'Restaurar párrafo'))));
  };
  adv.on((why) => { if (why === 'comp' || why === 'select') draw(); });
  draw();
}

// ───────────────────────── layout in the UI (measured like the renderer) ─────────────────────────
let mctx: CanvasRenderingContext2D | null = null;
export function measureLayout(l: Layer, o: { box?: number[] | null; t?: number } = {}): Layout & { size: number; lh: number } {
  const d = l.text!;
  const size = Math.max(1, Number(keyedAt(d.size, o.t ?? adv.time)) || 96);
  mctx ??= document.createElement('canvas').getContext('2d')!;
  mctx.font = `${d.italic ? 'italic ' : ''}${d.weight} ${size}px "${d.font}", "Segoe UI", system-ui, sans-serif`;
  const g = mctx;
  const lay = layoutText(String(keyedAt(d.text, o.t ?? adv.time) ?? ''), { size, tracking: Number(keyedAt(d.tracking, o.t ?? adv.time)) || 0, leading: d.leading, align: d.align, box: o.box === undefined ? d.box : o.box ?? undefined, ...layoutExtras(d) }, (s) => g.measureText(s).width);
  return { ...lay, size, lh: d.leading > 0 ? d.leading : size * 1.2 };
}
/** First visible glyph's position in layer space (to keep the text in place when converting). */
const firstAt = (lay: Layout) => { const g = lay.glyphs.find((x) => !x.space) ?? lay.glyphs[0]; return g ? [g.x, g.y] : [0, 0]; };

/** Convertir a texto de párrafo: a box around the text (with room so it does not wrap), the text kept in place. */
export async function toParagraph(c: Comp, l: Layer) {
  const d = l.text!;
  if (d.box) return;
  const a = measureLayout(l, { box: null });
  const [x0, , x1] = a.bounds;
  const pad = a.size * 0.5;
  const v = !!d.vertical;
  const W = v ? a.lines * a.lh + pad : x1 - x0 + pad, H = v ? Math.max(a.size, a.bounds[3] - a.bounds[1]) + pad : a.lines * a.lh + a.size * 0.3 + pad;
  const box = [Math.ceil(W), Math.ceil(H)];
  const b = measureLayout({ ...l, text: { ...d, composer: 'every' } }, { box });
  const p0 = firstAt(a), p1 = firstAt(b);
  await mop('textConvert', c.id, l.id, { box, anchorDelta: [p1[0] - p0[0], p1[1] - p0[1]] });
}
/** Convertir a texto de punto: every wrapped line ends with a return, the text kept in place. */
export async function toPoint(c: Comp, l: Layer) {
  const d = l.text!;
  if (!d.box) return;
  const a = measureLayout(l);
  const lines: [number, number][] = [];
  for (const g of a.glyphs) { if (g.src === undefined || g.src < 0) continue; const ln = lines[g.line]; if (!ln) lines[g.line] = [g.src, g.src + 1]; else ln[1] = Math.max(ln[1], g.src + 1); }
  const ranges = lines.filter(Boolean);
  const src = String(keyedAt(d.text, adv.time) ?? '');
  const text = ranges.map(([s, e]) => src.slice(s, e)).join('\n');
  const b = measureLayout({ ...l, text: { ...d, text: { v: text } } as TextDoc }, { box: null });
  const p0 = firstAt(a), p1 = firstAt(b);
  await mop('textConvert', c.id, l.id, { box: null, anchorDelta: [p1[0] - p0[0], p1[1] - p0[1]], ranges, t: d.text.k?.length ? adv.time : undefined });
}

// ───────────────────────── layer menu ─────────────────────────
export function textoMenuItems(c: Comp, l: Layer, open: (e: MouseEvent, items: Item[]) => void, e: MouseEvent): Item[] {
  if (l.type !== 'text' || !l.text) return [];
  const v = !!l.text.vertical;
  return [
    { label: 'Orientación del texto ▸', fn: () => open(e, [
      { label: `${!v ? '✓ ' : ''}Horizontal`, fn: () => void mop('textFormat', c.id, l.id, { vertical: false }) },
      { label: `${v ? '✓ ' : ''}Vertical`, fn: () => void mop('textFormat', c.id, l.id, { vertical: true }) }]) },
    l.text.box ? { label: 'Convertir a texto de punto', fn: () => void toPoint(c, l) } : { label: 'Convertir a texto de párrafo', fn: () => void toParagraph(c, l) },
  ];
}

// ───────────────────────── type tool: click = point text, drag = paragraph text ─────────────────────────
export function typeToolDown(e: PointerEvent, ctx: { c: Comp; p: [number, number]; stage: HTMLElement; toComp: (e: PointerEvent) => [number, number]; hit: (c: Comp, p: [number, number]) => Layer | undefined; editText: (id: string) => void }) {
  const { c, p, stage } = ctx;
  const r0 = stage.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
  let rect: HTMLElement | null = null, p1 = p;
  const mv = (ev: PointerEvent) => {
    p1 = ctx.toComp(ev);
    if (!rect && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    rect ??= stage.appendChild(h('div', { class: 'texto-rubber', dataset: { test: 'texto-rubber' }, style: { position: 'absolute', border: '1px dashed #fff', outline: '1px dashed #000', pointerEvents: 'none' } }));
    Object.assign(rect.style, { left: `${Math.min(sx, ev.clientX) - r0.left}px`, top: `${Math.min(sy, ev.clientY) - r0.top}px`, width: `${Math.abs(ev.clientX - sx)}px`, height: `${Math.abs(ev.clientY - sy)}px` });
  };
  const up = () => {
    removeEventListener('pointermove', mv);
    removeEventListener('pointerup', up);
    const dragged = !!rect;
    rect?.remove();
    if (!dragged && !e.shiftKey) {
      // a click on a text layer edits it, elsewhere (or with Shift, as in After Effects) starts point text
      const l = ctx.hit(c, p);
      if (l?.type === 'text') { adv.select([l.id]); ctx.editText(l.id); return; }
    }
    const box = dragged ? [Math.max(10, Math.abs(p1[0] - p[0])), Math.max(10, Math.abs(p1[1] - p[1]))] : undefined;
    const at = dragged ? [(p[0] + p1[0]) / 2, (p[1] + p1[1]) / 2] : p;
    void mop<Layer>('textCreate', c.id, { position: at, size: Math.round(c.height / 11), vertical: verticalType, box, text: dragged ? '' : 'Texto' }).then((l) => {
      if (!l) return;
      adv.select([l.id]);
      setTimeout(() => ctx.editText(l.id), 50);
    });
  };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', up);
}

// ───────────────────────── text editing shortcuts (After Effects' TextLayerUI) ─────────────────────────
function textoKey(ev: KeyboardEvent): boolean {
  if (!editing) return false;
  const c = adv.comp(), l = c?.layers.find((x) => x.id === editing!.id);
  if (!c || !l?.text) return false;
  const ctrl = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase(), code = ev.code;
  const st = shownStyle(l), sel = !!selection(l);
  const off = sel ? false : null;
  const para = (paragraph: Record<string, unknown>) => { void syncTyped(c, l).then(() => mop('textFormat', c.id, l.id, { paragraph })); return true; };
  const ch = (patch: Record<string, unknown>) => { void applyChar(c, l, patch); return true; };
  if (ctrl && ev.shiftKey) {
    if (!ev.altKey && k === 'l') return para({ align: 'left', justify: null });
    if (!ev.altKey && k === 'r') return para({ align: 'right', justify: null });
    if (!ev.altKey && k === 'c') return para({ align: 'center', justify: null });
    if (!ev.altKey && k === 'j') return para({ justify: 'left' });
    if (ev.altKey && k === 'j') return para({ justify: 'right' });
    if (!ev.altKey && k === 'f') return para({ justify: 'all' });
    if (ev.altKey && k === 't') return para({ composer: (l.text.composer ?? 'single') === 'every' ? 'single' : 'every' });
    if (!ev.altKey && k === 'k') return ch({ allCaps: st.allCaps ? off : true, ...(st.allCaps ? {} : { smallCaps: off }) });
    if (ev.altKey && k === 'k') return ch({ smallCaps: st.smallCaps ? off : true, ...(st.smallCaps ? {} : { allCaps: off }) });
    if (code === 'Equal' || code === 'NumpadAdd' || k === '+' || k === '=') return ch({ script: st.script === (ev.altKey ? 'sub' : 'super') ? (sel ? 'none' : null) : ev.altKey ? 'sub' : 'super' });
  }
  if (ev.shiftKey && ev.altKey && (k === 'arrowup' || k === 'arrowdown')) {
    const step = (ctrl ? 10 : 2) * (k === 'arrowup' ? 1 : -1);
    const v = (Number(st.baselineShift) || 0) + step;
    return ch({ baselineShift: v || (sel ? 0 : null) });
  }
  return false;
}
