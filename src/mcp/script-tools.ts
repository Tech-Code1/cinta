// MCP tools of «datos y scripting»: data footage for data-driven animation (JSON, MGJSON, CSV, TSV read by
// expressions with footage("name")) and After Effects scripts (ExtendScript .jsx / .js) run on the project.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as z from 'zod';
import { Editor, motion, runScript } from '../core';
import type { Host } from './motion-tools';

const M = motion;
const brief = (d: motion.DataItem) => ({ id: d.id, name: d.name, kind: d.kind, path: d.path, ...M.dataSummary(d), expression: d.kind === 'csv' || d.kind === 'tsv' ? `footage("${d.name}").dataValue([0, 0])` : d.kind === 'mgjson' ? `footage("${d.name}").dataValue([0])` : `footage("${d.name}").sourceData` });

export function registerScriptTools(H: Host) {
  const { tool, edit, ok, projectPath, P } = H;

  tool('data_import', 'Importar datos', 'Data-driven animation (After Effects): import JSON, MGJSON, CSV or TSV files as footage items of the project (Project panel), list them, reload them from disk (Volver a cargar material de archivo: the animation follows the new contents) or remove them. Expressions read them with footage("file.csv"): .dataValue([column, row]) for CSV/TSV (0-based; row 0 is the first row after the header; numbers come back as numbers; column may also be the header name), .dataValue(path) for MGJSON streams (dynamic ones at the current time), .sourceData (parsed JSON; CSV/TSV rows as objects), .sourceText (raw text), .dataKeyCount([col]), .dataKeyTimes([col], t0, t1), .dataKeyValues([col], t0, t1) (CSV rows are one frame apart). Without paths / reload / remove it lists the data items.', {
    ...P, paths: z.array(z.string()).optional().describe('Files to import (.json, .mgjson, .csv, .tsv).'),
    reload: z.array(z.string()).optional().describe('Data items (id or name) to read again from their files.'),
    remove: z.array(z.string()).optional().describe('Data items (id or name) to remove from the project.'),
  }, async (a) => {
    if (!a.paths?.length && !a.reload?.length && !a.remove?.length) {
      const e = Editor.load(projectPath(a.project), true);
      return ok({ data: (e.project.dataItems ?? []).map(brief) });
    }
    const { e, out } = await edit(a.project, (e) => {
      const added = a.paths?.length ? M.motionOps.dataAdd(e, a.paths.map((p) => {
        const f = resolve(p);
        if (!existsSync(f)) throw new Error(`No existe ${f}`);
        return { path: f, text: readFileSync(f, 'utf8') };
      })) : [];
      for (const k of a.reload ?? []) {
        const d = (e.project.dataItems ?? []).find((x) => x.id === k || x.name === k);
        if (!d) throw new Error(`No existe el archivo de datos «${k}».`);
        M.motionOps.dataReload(e, d.id, readFileSync(d.path, 'utf8'));
      }
      const removed = a.remove?.length ? M.motionOps.dataRemove(e, a.remove) : 0;
      return { added: added.map((d) => d.id), removed };
    });
    return ok({ ...out, data: (e.project.dataItems ?? []).map(brief), project: e.path, canUndo: e.canUndo });
  });

  tool('run_script', 'Ejecutar script', 'Run an After Effects script (ExtendScript .jsx / .js, like File > Scripts > Run Script File) on the project: app.project (items, activeItem, item(i), importFile for data files), items.addComp(name, w, h, pixelAspect, duration, fps), comp.layers.addSolid / addText / addBoxText / addShape / addNull / addCamera / addLight / add / precompose, layer.name / inPoint / outPoint / startTime / enabled / parent / threeDLayer / blendingMode, layer.property("Transform").property("Position") (or "ADBE Position") .setValue / setValueAtTime / setValuesAtTimes / valueAtTime / numKeys / keyTime / keyValue / removeKey / setInterpolationTypeAtKey / setTemporalEaseAtKey / expression, property("ADBE Effect Parade").addProperty(matchName or Cinta effect id), shape Contents (ADBE Vector Group, Rect, Ellipse, Star, Fill, Stroke), Source Text with TextDocument, app.beginUndoGroup/endUndoGroup, alert / $.writeln (returned in log), File / Folder (read only, in the script\'s and the project\'s folders). Runs isolated (no require / process), with a time limit; the whole run is one undo step (undo reverts it). Give "file" or the code in "code". Returns the log, the error (with line) and the changes.', {
    ...P, file: z.string().optional().describe('Path of the .jsx / .js script.'), code: z.string().optional().describe('Script source (instead of file).'),
    comp: z.string().optional().describe('Comp (id or name) that app.project.activeItem returns (default: the first comp, if any).'),
    timeout: z.number().min(100).max(120000).optional().describe('Milliseconds (default 10000).'),
  }, async (a) => {
    if (!a.file && !a.code) throw new Error('Indique file (ruta del .jsx) o code.');
    const file = a.file ? resolve(a.file) : undefined;
    if (file && !existsSync(file)) throw new Error(`No se puede encontrar el archivo ${file}.`);
    const code = a.code ?? readFileSync(file!, 'utf8');
    const { e, out } = await edit(a.project, async (e) => {
      const list = e.project.comps ?? [];
      const active = a.comp ? M.findComp(list, a.comp).id : list[0]?.id ?? null;
      return runScript(e, code, { file, activeComp: active, timeout: a.timeout });
    });
    return ok({ ok: out.ok, error: out.error ?? null, log: out.output, undoGroups: out.undoGroups, changes: out.changes, seconds: out.seconds, project: e.path, canUndo: e.canUndo });
  });
}
