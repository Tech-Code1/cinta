// Editing operations of data footage (JSON, MGJSON, CSV, TSV): import, reload (Volver a cargar material de
// archivo), rename and remove. The callers read the files (main process / MCP); these only change the project.
import type { Editor } from '../ops';
import { uid } from '../model';
import { dataKind, parseData, type DataItem } from './data';

const base = (s: string) => s.split(/[\\/]/).pop() ?? s;
const find = (list: DataItem[], key: string) => {
  const d = list.find((x) => x.id === key || x.name === key || x.path === key) ?? list.find((x) => x.name.toLowerCase() === key.toLowerCase());
  if (!d) throw new Error(`No existe el archivo de datos «${key}». Hay: ${list.map((x) => x.name).join(', ') || 'ninguno'}.`);
  return d;
};

export const DATA_OPS = {
  /** Adds data files to the project (their text is checked: invalid JSON is refused like After Effects). */
  dataAdd(e: Editor, files: { path: string; text: string; name?: string }[]): DataItem[] {
    return e.mutate('Importar datos', (p) => {
      p.dataItems ??= [];
      return files.map((f) => {
        const kind = dataKind(f.path);
        if (!kind) throw new Error(`«${base(f.path)}» no es un archivo de datos (JSON, MGJSON, CSV o TSV).`);
        const d: DataItem = { id: uid('d'), name: f.name ?? base(f.path), path: f.path, kind, text: f.text };
        parseData(d);
        p.dataItems!.push(d);
        return d;
      });
    });
  },
  /** Volver a cargar material de archivo: new contents of the file (the animation follows). */
  dataReload(e: Editor, key: string, text: string): DataItem {
    return e.mutate('Volver a cargar material de archivo', (p) => {
      const d = find(p.dataItems ?? [], key);
      parseData({ ...d, text });
      d.text = text;
      return d;
    });
  },
  dataSet(e: Editor, key: string, o: { name?: string; path?: string }): DataItem {
    return e.mutate('Material de archivo', (p) => {
      const d = find(p.dataItems ?? [], key);
      if (o.name) d.name = o.name;
      if (o.path) d.path = o.path;
      return d;
    });
  },
  dataRemove(e: Editor, keys: string[]): number {
    return e.mutate('Quitar del proyecto', (p) => {
      const gone = new Set(keys.map((k) => find(p.dataItems ?? [], k).id));
      p.dataItems = (p.dataItems ?? []).filter((d) => !gone.has(d.id));
      if (!p.dataItems.length) delete p.dataItems;
      return gone.size;
    });
  },
};
