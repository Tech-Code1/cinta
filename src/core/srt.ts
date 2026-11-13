// SubRip (.srt) read/write and caption chunking.
export interface Cue {
  start: number;
  end: number;
  text: string;
}

const tc = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};
const parseTc = (s: string) => {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s.trim());
  if (!m) throw new Error(`Marca de tiempo SRT no válida: ${s}`);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000;
};

export function parseSrt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const body = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (body) out.push({ start: parseTc(a), end: parseTc(b), text: body });
  }
  return out;
}

export function buildSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${tc(c.start)} --> ${tc(c.end)}\n${c.text}\n`).join('\n');
}

/** Splits long speech segments into readable captions (≤ maxChars per line, ≤ 2 lines, ≥ minDur). */
export function chunkCues(cues: Cue[], o: { maxChars?: number; maxLines?: number; words?: number } = {}): Cue[] {
  const maxChars = o.maxChars ?? 42, maxLines = o.maxLines ?? 2;
  const out: Cue[] = [];
  for (const c of cues) {
    const words = c.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const groups: string[][] = [];
    if (o.words) {
      for (let i = 0; i < words.length; i += o.words) groups.push(words.slice(i, i + o.words));
    } else {
      let cur: string[] = [];
      let lines = 1, len = 0;
      for (const w of words) {
        if (len + w.length + (len ? 1 : 0) > maxChars) {
          if (lines >= maxLines) { groups.push(cur); cur = []; lines = 1; len = 0; } else { lines++; len = 0; }
        }
        cur.push(w);
        len += w.length + (len ? 1 : 0);
      }
      if (cur.length) groups.push(cur);
    }
    const total = words.reduce((s, w) => s + w.length + 1, 0);
    let t = c.start, used = 0;
    for (const gr of groups) {
      const chars = gr.reduce((s, w) => s + w.length + 1, 0);
      used += chars;
      const end = c.start + ((c.end - c.start) * used) / total;
      out.push({ start: t, end, text: o.words ? gr.join(' ') : wrap(gr.join(' '), maxChars) });
      t = end;
    }
  }
  return out;
}

function wrap(s: string, max: number): string {
  if (s.length <= max) return s;
  const words = s.split(' ');
  let best = s, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const d = Math.abs(a.length - b.length);
    if (d < bestDiff && a.length <= max && b.length <= max) { bestDiff = d; best = `${a}\n${b}`; }
  }
  return best;
}
