// Data-driven animation (After Effects' JSON, MGJSON, CSV and TSV footage): the files are project items whose
// text is kept in the project (reloading the file replaces it), and expressions read them with footage("name"):
// sourceText, sourceData, dataValue([column, row]) / dataValue(path), dataKeyCount, dataKeyTimes, dataKeyValues.
// Pure TypeScript (no Node APIs): the renderer evaluates expressions too.

export type DataKind = 'json' | 'mgjson' | 'csv' | 'tsv';
export interface DataItem {
  id: string;
  /** name in the Project panel (the file name, like After Effects) */
  name: string;
  path: string;
  kind: DataKind;
  /** contents of the file when it was imported or last reloaded */
  text: string;
}
export const DATA_EXT: DataKind[] = ['json', 'mgjson', 'csv', 'tsv'];
export const DATA_KIND_NAMES: Record<DataKind, string> = { json: 'JSON', mgjson: 'MGJSON', csv: 'CSV', tsv: 'TSV' };
export function dataKind(path: string): DataKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (DATA_EXT as string[]).includes(ext ?? '') ? (ext as DataKind) : null;
}

// ───────────────────────── parsing ─────────────────────────
/** RFC 4180 rows: quoted fields with separators, doubled quotes and line breaks inside; CRLF / LF; BOM. */
export function parseDelimited(text: string, sep = ','): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
      continue;
    }
    if (ch === '"' && f === '') { q = true; any = true; continue; }
    if (ch === sep) { row.push(f); f = ''; any = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '' || any) rows.push(row);
      row = []; any = false;
      continue;
    }
    f += ch; any = true;
  }
  if (f !== '' || row.length || any) { row.push(f); rows.push(row); }
  return rows;
}
/** A cell as After Effects reads it: numbers become numbers, anything else stays text. */
export function cellValue(s: string): number | string {
  const t = s.trim();
  if (t !== '' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return s;
}
export interface Table { header: string[]; rows: (number | string)[][] }
/** CSV / TSV: the first row names the columns (data streams); the others are the data, row 0 first. */
export function parseTable(text: string, sep: string): Table {
  const all = parseDelimited(text, sep);
  const header = (all[0] ?? []).map((x) => x.trim());
  return { header, rows: all.slice(1).map((r) => header.map((_, i) => cellValue(r[i] ?? ''))) };
}

interface MgNode { objectType?: string; displayName?: string; sampleSetID?: string; value?: unknown; children?: MgNode[]; dataType?: { type?: string } }
interface Mg { outline: MgNode[]; sets: Map<string, { t: number[]; v: unknown[] }>; t0: number; t1: number }
const num = (v: unknown): unknown => (typeof v === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v) ? Number(v) : Array.isArray(v) ? v.map(num) : v);
function parseMg(text: string): Mg {
  const j = JSON.parse(text.replace(/^﻿/, '')) as { dataOutline?: MgNode[]; dataDynamicSamples?: { sampleSetID: string; samples: { time: string | number; value: unknown }[] }[] };
  const sets = new Map<string, { t: number[]; v: unknown[] }>();
  const abs: number[] = [];
  const raw = (j.dataDynamicSamples ?? []).map((d) => ({ id: d.sampleSetID, s: (d.samples ?? []).map((x) => ({ t: typeof x.time === 'number' ? x.time * 1000 : Date.parse(x.time), v: x.value })) }));
  for (const d of raw) for (const x of d.s) if (Number.isFinite(x.t)) abs.push(x.t);
  const base = abs.length ? Math.min(...abs) : 0, end = abs.length ? Math.max(...abs) : 0;
  for (const d of raw) {
    const s = d.s.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
    sets.set(d.id, { t: s.map((x) => (x.t - base) / 1000), v: s.map((x) => num(x.v)) });
  }
  return { outline: j.dataOutline ?? [], sets, t0: 0, t1: (end - base) / 1000 };
}

export type Parsed = { kind: 'table'; table: Table } | { kind: 'json'; value: unknown } | { kind: 'mgjson'; mg: Mg };
const cache = new Map<string, Parsed>();
/** Parsed contents (cached by kind and text). Throws on invalid JSON, with After Effects' message. */
export function parseData(item: Pick<DataItem, 'kind' | 'text' | 'name'>): Parsed {
  const key = `${item.kind}\u0000${item.text}`;
  let p = cache.get(key);
  if (p) return p;
  try {
    if (item.kind === 'csv' || item.kind === 'tsv') p = { kind: 'table', table: parseTable(item.text, item.kind === 'tsv' ? '\t' : ',') };
    else if (item.kind === 'mgjson') p = { kind: 'mgjson', mg: parseMg(item.text) };
    else p = { kind: 'json', value: JSON.parse(item.text.replace(/^﻿/, '')) };
  } catch (e) {
    if (item.kind === 'csv' || item.kind === 'tsv') throw e;
    throw new Error(`El archivo “${item.name}” no es un JSON válido. ${(e as Error).message}`);
  }
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  cache.set(key, p);
  return p;
}
/** Short description for the Project panel and the MCP. */
export function dataSummary(item: DataItem): { columns?: string[]; rows?: number; streams?: number; keys?: string[] } {
  try {
    const p = parseData(item);
    if (p.kind === 'table') return { columns: p.table.header, rows: p.table.rows.length };
    if (p.kind === 'mgjson') { let n = 0; const walk = (a: MgNode[]) => a.forEach((x) => (x.children ? walk(x.children) : n++)); walk(p.mg.outline); return { streams: n };
    }
    const v = p.value;
    return { keys: Array.isArray(v) ? (v.length && typeof v[0] === 'object' && v[0] ? Object.keys(v[0] as object) : []) : v && typeof v === 'object' ? Object.keys(v as object) : [], rows: Array.isArray(v) ? v.length : undefined };
  } catch { return {}; }
}

// ───────────────────────── the Footage object of expressions ─────────────────────────
let project: { dataItems?: DataItem[]; media?: { path: string; width: number; height: number; duration: number; fps: number }[] } | null = null;
/** The project whose items footage("name") finds (set before rendering / evaluating). */
export function useProjectData(p: typeof project) { project = p; }
const base = (s: string) => s.split(/[\\/]/).pop() ?? s;

function mgNode(mg: Mg, path: unknown): MgNode {
  const idx = Array.isArray(path) ? path.map(Number) : [Number(path)];
  let list = mg.outline, n: MgNode | undefined;
  for (const i of idx) {
    n = list[i];
    if (!n) throw new Error(`No existe la ruta de datos [${idx.join(', ')}].`);
    list = n.children ?? [];
  }
  if (!n) throw new Error('Ruta de datos vacía.');
  return n;
}
function tableCol(t: Table, path: unknown): number {
  const c = Array.isArray(path) ? path[0] : path;
  const i = typeof c === 'string' && !/^\d+$/.test(c) ? t.header.indexOf(c) : Number(c);
  if (!(i >= 0 && i < t.header.length)) throw new Error(`No existe la columna ${JSON.stringify(c)} (hay ${t.header.length}: ${t.header.join(', ')}).`);
  return i;
}

/** After Effects' Footage object (expressions): data files, and the size / duration of media items. */
export function footageApi(name: string, time: number, fps: number): Record<string, unknown> {
  const d = project?.dataItems?.find((x) => x.name === name || x.id === name) ?? project?.dataItems?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  const fd = 1 / (fps || 30);
  if (!d) {
    const m = project?.media?.find((x) => base(x.path) === name || base(x.path).toLowerCase() === name.toLowerCase());
    if (!m) throw new Error(`No existe el material de archivo «${name}» en el proyecto.`);
    return { name, width: m.width, height: m.height, duration: m.duration, frameDuration: 1 / (m.fps || fps || 30), pixelAspect: 1, ntscDropFrame: false };
  }
  const p = parseData(d);
  const times = (path: unknown, t0?: number, t1?: number): { t: number[]; v: unknown[] } => {
    if (p.kind === 'table') {
      const c = tableCol(p.table, path);
      const all = p.table.rows.map((r, i) => ({ t: i * fd, v: r[c] }));
      const s = all.filter((x) => x.t >= (t0 ?? -Infinity) - 1e-9 && x.t <= (t1 ?? Infinity) + 1e-9);
      return { t: s.map((x) => x.t), v: s.map((x) => x.v) };
    }
    if (p.kind === 'mgjson') {
      const n = mgNode(p.mg, path);
      const set = n.sampleSetID ? p.mg.sets.get(n.sampleSetID) : undefined;
      if (!set) return { t: [], v: [] };
      const a = t0 ?? p.mg.t0, b = t1 ?? p.mg.t1;
      const keep = set.t.map((_, i) => i).filter((i) => set.t[i] >= a - 1e-9 && set.t[i] <= b + 1e-9);
      return { t: keep.map((i) => set.t[i]), v: keep.map((i) => set.v[i]) };
    }
    throw new Error('dataKeyTimes / dataKeyValues leen archivos MGJSON, CSV o TSV.');
  };
  return {
    name: d.name, width: 0, height: 0, pixelAspect: 1, ntscDropFrame: false, frameDuration: fd,
    duration: p.kind === 'mgjson' ? p.mg.t1 : p.kind === 'table' ? p.table.rows.length * fd : 0,
    sourceText: d.text,
    get sourceData() {
      if (p.kind === 'json') return p.value;
      if (p.kind === 'table') return p.table.rows.map((r) => Object.fromEntries(p.table.header.map((h, i) => [h, r[i]])));
      return JSON.parse(d.text);
    },
    /** CSV / TSV: [column, row] (0-based; row 0 is the first row after the header). MGJSON: the path in the outline
     *  (a dynamic stream gives its sample at the current time). JSON: a path of keys / indexes. */
    dataValue(path: unknown) {
      if (p.kind === 'table') {
        const a = Array.isArray(path) ? path : [path];
        const c = tableCol(p.table, a[0]), r = Number(a[1] ?? 0);
        const row = p.table.rows[r];
        if (!row) throw new Error(`No existe la fila ${r} (hay ${p.table.rows.length}).`);
        return row[c];
      }
      if (p.kind === 'mgjson') {
        const n = mgNode(p.mg, path);
        if (n.objectType === 'dataDynamic' && n.sampleSetID) {
          const set = p.mg.sets.get(n.sampleSetID);
          if (!set?.t.length) return 0;
          let i = 0;
          while (i + 1 < set.t.length && set.t[i + 1] <= time + 1e-9) i++;
          return set.v[i];
        }
        return num(n.value);
      }
      let v: unknown = p.value;
      for (const k of Array.isArray(path) ? path : [path]) v = (v as Record<string, unknown> | undefined)?.[k as string];
      return v;
    },
    dataKeyCount(path: unknown) { return times(path).t.length; },
    dataKeyTimes(path: unknown, t0?: number, t1?: number) { return times(path, t0, t1).t; },
    dataKeyValues(path: unknown, t0?: number, t1?: number) { return times(path, t0, t1).v; },
  };
}
