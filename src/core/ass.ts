// Title clips → one ASS script rendered by libass at the end of the filtergraph.
import type { Clip, Project, TitleStyle } from './model';
import { clipDuration } from './model';

const assColor = (css: string, alpha = 0) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  const hex = m ? m[1] : 'ffffff';
  const a = Math.round(Math.min(255, Math.max(0, alpha * 255))).toString(16).padStart(2, '0');
  return `&H${a}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`.toUpperCase();
};
const ts = (s: number) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const esc = (t: string) => t.replace(/\r/g, '').replace(/[{}]/g, '').replace(/\n/g, '\\N');

export interface AssEvent {
  start: number;
  end: number;
  text: string;
  box?: boolean;
}

/** Builds the events of one title clip, in local output time (already shifted by -from). */
export function titleEvents(c: Clip, t: TitleStyle, start: number, end: number, W: number, H: number, opacity = 1): AssEvent[] {
  const unit = Math.min(W, H) / 1080;
  const fs = Math.round(t.size * unit);
  const an = t.align === 'left' ? 4 : t.align === 'right' ? 6 : 5;
  const x = Math.round(t.x * W), y = Math.round(t.y * H);
  const d = Math.max(0.05, Math.min(0.6 / t.animSpeed, (end - start) / 3));
  const ms = Math.round(d * 1000);
  const alpha = 1 - opacity * 1;
  const base = [
    `\\an${an}`,
    `\\fn${t.font}`,
    `\\fs${fs}`,
    `\\b${t.bold ? 1 : 0}`,
    `\\i${t.italic ? 1 : 0}`,
    `\\1c${assColor(t.color)}`,
    alpha > 0 ? `\\alpha${assColor('#000000', alpha).slice(0, 4)}&` : '',
  ];
  if (t.background) {
    base.push(`\\3c${assColor(t.backgroundColor)}`, `\\bord${Math.round(fs * 0.3)}`, `\\4c${assColor(t.backgroundColor)}`, `\\shad0`);
  } else {
    base.push(`\\3c${assColor(t.outlineColor)}`, `\\bord${Math.round(t.outline * unit)}`, `\\4c${assColor(t.shadowColor, 0.35)}`, `\\shad${Math.round(t.shadow * unit)}`);
  }
  const text = esc(t.uppercase ? t.text.toLocaleUpperCase('es') : t.text);
  const lines = text.split('\\N');
  const textH = lines.length * fs * 1.25;
  const textW = Math.max(...lines.map((l) => l.length)) * fs * 0.55;
  const fadeOut = c.fadeOut > 0 ? Math.round(c.fadeOut * 1000) : ms;
  const fadeIn = c.fadeIn > 0 ? Math.round(c.fadeIn * 1000) : ms;
  let anim = '';
  const pos = `\\pos(${x},${y})`;
  const dur = end - start;
  const move = (fx: number, fy: number) => `\\move(${fx},${fy},${x},${y},0,${ms})`;
  switch (t.anim) {
    case 'none': anim = pos; break;
    case 'fade': anim = `${pos}\\fad(${fadeIn},${fadeOut})`; break;
    case 'slide-left': anim = `${move(Math.round(x + W * 0.5), y)}\\fad(${Math.round(ms / 2)},${fadeOut})`; break;
    case 'slide-right': anim = `${move(Math.round(x - W * 0.5), y)}\\fad(${Math.round(ms / 2)},${fadeOut})`; break;
    case 'slide-up': anim = `${move(x, Math.round(y + H * 0.3))}\\fad(${Math.round(ms / 2)},${fadeOut})`; break;
    case 'slide-down': anim = `${move(x, Math.round(y - H * 0.3))}\\fad(${Math.round(ms / 2)},${fadeOut})`; break;
    case 'zoom-in': anim = `${pos}\\fscx0\\fscy0\\t(0,${ms},\\fscx100\\fscy100)\\fad(0,${fadeOut})`; break;
    case 'zoom-out': anim = `${pos}\\fscx220\\fscy220\\t(0,${ms},\\fscx100\\fscy100)\\fad(${ms},${fadeOut})`; break;
    case 'blur-in': anim = `${pos}\\blur25\\t(0,${ms * 2},\\blur0)\\fad(${ms},${fadeOut})`; break;
    case 'spin': anim = `${pos}\\frz-360\\fscx10\\fscy10\\t(0,${ms * 2},\\frz0\\fscx100\\fscy100)\\fad(0,${fadeOut})`; break;
    case 'pop': anim = `${pos}\\fscx30\\fscy30\\t(0,${Math.round(ms * 0.6)},\\fscx115\\fscy115)\\t(${Math.round(ms * 0.6)},${ms},\\fscx100\\fscy100)\\fad(0,${fadeOut})`; break;
    case 'scroll-up': {
      const ax = an === 4 ? 7 : an === 6 ? 9 : 8;
      base[0] = `\\an${ax}`;
      anim = `\\move(${x},${H},${x},${Math.round(-textH)},0,${Math.round(dur * 1000)})`;
      break;
    }
    case 'scroll-left':
      base[0] = '\\an4';
      anim = `\\move(${W},${y},${Math.round(-textW)},${y},0,${Math.round(dur * 1000)})`;
      break;
    case 'typewriter': {
      const plain = t.text.replace(/\r/g, '');
      const n = plain.length;
      if (!n) return [];
      const typeDur = Math.min(dur * 0.7, n * 0.06 / t.animSpeed);
      const steps = Math.min(n, 200);
      const out: AssEvent[] = [];
      for (let i = 1; i <= steps; i++) {
        const k = Math.round((i / steps) * n);
        const a0 = start + (typeDur * (i - 1)) / steps;
        const a1 = i === steps ? end : start + (typeDur * i) / steps;
        const shown = esc(plain.slice(0, k)), hidden = esc(plain.slice(k));
        out.push({ box: t.background, start: a0, end: a1, text: `{${base.join('')}${pos}${i === steps ? `\\fad(0,${fadeOut})` : ''}}${shown}${hidden ? `{\\alpha&HFF&}${hidden}` : ''}` });
      }
      return out;
    }
    case 'karaoke': {
      // word-by-word highlight like the shorts kit: each word lit for a share of the time ∝ its length
      const words = t.text.replace(/\\N|\n/g, ' ').split(/\s+/).filter(Boolean).map((w) => (t.uppercase ? w.toLocaleUpperCase('es') : w));
      if (!words.length) return [];
      const wts = words.map((w) => w.length + 1.5);
      const tot = wts.reduce((s, v) => s + v, 0);
      const hl = assColor(t.highlight ?? '#ffd400'), col = assColor(t.color);
      let acc = start;
      return words.map((_, i) => {
        const a0 = acc, a1 = i === words.length - 1 ? end : acc + ((end - start) * wts[i]) / tot;
        acc = a1;
        const body = words.map((w, j) => (j === i ? `{\\1c${hl}\\fscx108\\fscy108}${esc(w)}{\\1c${col}\\fscx100\\fscy100}` : esc(w))).join(' ');
        return { box: t.background, start: a0, end: a1, text: `{${base.join('')}${pos}${i === 0 ? `\\fad(${Math.min(120, ms)},0)` : ''}}${body}` };
      });
    }
    default: anim = `${pos}\\fad(${fadeIn},${fadeOut})`;
  }
  if (t.timerFrom !== undefined) {
    const out: AssEvent[] = [];
    const from = Math.max(0, Math.round(t.timerFrom));
    const step = dur / (from + 1);
    for (let i = 0; i <= from; i++) {
      out.push({ box: t.background, start: start + i * step, end: start + (i + 1) * step, text: `{${base.join('')}${pos}\\fscx130\\fscy130\\t(0,200,\\fscx100\\fscy100)}${from - i}` });
    }
    return out;
  }
  return [{ box: t.background, start, end, text: `{${base.join('')}${anim}}${text}` }];
}

export function buildAss(events: AssEvent[], W: number, H: number): string {
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Segoe UI,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,5,20,20,20,1',
    'Style: Box,Segoe UI,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,2,0,5,20,20,20,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const body = events.map((e, i) => `Dialogue: ${i % 100},${ts(e.start)},${ts(e.end)},${e.box ? 'Box' : 'Default'},,0,0,0,,${e.text}`);
  return [...head, ...body, ''].join('\n');
}

export const titleClipDuration = clipDuration;
export type { Project };
