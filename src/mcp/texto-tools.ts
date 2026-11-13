// MCP tools of «texto»: After Effects' Character / Paragraph attributes beyond font, size and colour (Faux bold /
// italic, caps, super / subscript, baseline shift, tsume, scales, Tate-chu-yoko, Hindi digits), on the whole layer
// or a range of characters; paragraph indents, spacing, justification, composer and hyphenation; vertical text.
import * as z from 'zod';
import { motion, type Project } from '../core';
import type { Host } from './motion-tools';

const M = motion;
const pickComp = (p: Project, id?: string) => {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
};
const layerOf = (c: motion.Comp, x: string) => M.findLayer(c, /^\d+$/.test(x) ? Number(x) : x);
const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };
const L = { layer: z.string().describe('Layer id, name or 1-based index.') };
const nb = z.boolean().nullable().optional();

/** What a text layer's formatting is (for the tools' answers). */
export function textFormatSummary(d: motion.TextDoc) {
  const ch = M.baseStyle(d);
  return {
    orientation: d.vertical ? 'vertical' : 'horizontal', paragraph_text: d.box ?? null,
    character: { ...ch, all_caps: d.allCaps || undefined, hindi_digits: d.hindiDigits || undefined, standard_vertical_roman: d.romanStd || undefined },
    runs: d.runs ?? [],
    paragraph: { align: d.align, justify: d.justify ?? null, indent_left: d.indentLeft ?? 0, indent_right: d.indentRight ?? 0, first_line_indent: d.indentFirst ?? 0, space_before: d.spaceBefore ?? 0, space_after: d.spaceAfter ?? 0, hyphenate: !!d.hyphenate, composer: d.composer ?? 'single' },
  };
}

export function registerTextoTools(H: Host) {
  const { tool, edit, ok, P } = H;

  tool('text_format', 'Carácter y párrafo', 'After Effects Character and Paragraph panel attributes of a text layer, beyond font / size / colour / tracking (layer_set text_style, prop_set). character (on the whole layer, or on `range` [start, end) — UTF-16 offsets of the source text at `time` — like selecting characters while editing; null removes an attribute): faux_bold, faux_italic, all_caps, small_caps (lowercase as capitals at 70 %), script super|sub|none (58.3 % size, ±33.3 % of the size), baseline_shift (px, + up), tsume (0–100 %, tightens the space around characters), vertical_scale / horizontal_scale (%), tate_chu_yoko (vertical text: those characters side by side in one slot). hindi_digits (0-9 as Arabic-Indic digits), orientation horizontal|vertical (Vertical Type: columns from right to left, characters upright; align left/center/right = top/centre/bottom), standard_vertical_roman (half-width characters turned 90° in vertical text). paragraph: align left|center|right, justify left|center|right|all (paragraph text only: lines spread to the box width, the last one aligned that way or justified too; null = off), indent_left / indent_right / first_line_indent, space_before / space_after (px), hyphenate (automatic hyphenation of paragraph text: syllables, words of 7+ letters, 3+3), composer every (Adobe Every-line Composer: evens out the lines) | single (Single-line, the default of older projects). Paragraph text = layer_set text_style.box. Text animators keep working per character on the result.', {
    ...P, ...C, ...L,
    range: z.array(z.number().int().min(0)).length(2).optional().describe('[start, end) characters the character attributes go to (default: all).'),
    time: z.number().min(0).optional().describe('Comp time of the source text the range refers to (keyframed text).'),
    character: z.object({
      faux_bold: nb, faux_italic: nb, all_caps: nb, small_caps: nb, script: z.enum(['super', 'sub', 'none']).nullable().optional(),
      baseline_shift: z.number().nullable().optional(), tsume: z.number().min(0).max(100).nullable().optional(),
      vertical_scale: z.number().min(1).nullable().optional(), horizontal_scale: z.number().min(1).nullable().optional(), tate_chu_yoko: nb,
    }).optional(),
    paragraph: z.object({
      align: z.enum(['left', 'center', 'right']).optional(), justify: z.enum(['left', 'center', 'right', 'all']).nullable().optional(),
      indent_left: z.number().optional(), indent_right: z.number().optional(), first_line_indent: z.number().optional(),
      space_before: z.number().optional(), space_after: z.number().optional(), hyphenate: z.boolean().optional(), composer: z.enum(['every', 'single']).optional(),
    }).optional(),
    orientation: z.enum(['horizontal', 'vertical']).optional(), standard_vertical_roman: z.boolean().optional(), hindi_digits: z.boolean().optional(),
  }, async (a) => {
    const ch = a.character, pa = a.paragraph;
    const character = ch ? { fauxBold: ch.faux_bold, fauxItalic: ch.faux_italic, allCaps: ch.all_caps, smallCaps: ch.small_caps, script: ch.script, baselineShift: ch.baseline_shift, tsume: ch.tsume, vScale: ch.vertical_scale, hScale: ch.horizontal_scale, tcy: ch.tate_chu_yoko } : undefined;
    if (character) for (const k of Object.keys(character) as (keyof typeof character)[]) if (character[k] === undefined) delete character[k];
    const paragraph = pa ? { align: pa.align, justify: pa.justify, indentLeft: pa.indent_left, indentRight: pa.indent_right, indentFirst: pa.first_line_indent, spaceBefore: pa.space_before, spaceAfter: pa.space_after, hyphenate: pa.hyphenate, composer: pa.composer } : undefined;
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp), l = layerOf(c, a.layer);
      return M.motionOps.textFormat(e, c.id, l.id, { character, range: a.range as [number, number] | undefined, t: a.time, paragraph, vertical: a.orientation === undefined ? undefined : a.orientation === 'vertical', romanStd: a.standard_vertical_roman, hindiDigits: a.hindi_digits });
    });
    return ok({ project: e.path, canUndo: e.canUndo, layer: { id: out.id, name: out.name }, ...textFormatSummary(out.text!) });
  });
}
