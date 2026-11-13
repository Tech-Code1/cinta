// Update policy (pure, testable): when Cinta may look for a new version and whether the user should be told.
// The download/installation itself is electron-updater's job (src/main/updates.ts).

export interface UpdateSettings {
  /** look for updates on start and every few hours (default on) */
  auto: boolean;
  /** "Omitir esta versión": not offered again until a newer one appears */
  skip?: string;
  /** last automatic check (ms) */
  last?: number;
}

export const UPDATE_DEFAULTS: UpdateSettings = { auto: true };
/** automatic checks: at most this often (also between restarts) */
export const UPDATE_INTERVAL = 6 * 3600e3;

export type UpdateBlock = 'dev' | 'portable' | 'test' | null;

/** Why updates cannot run here: an unpackaged build (unless a test feed is given), the portable .exe (it has no
 *  installer to update) or a self-test/headless render. null = updates available. */
export function updateBlock(o: { packaged: boolean; portable: boolean; test: boolean; feed?: string }): UpdateBlock {
  if (o.test) return 'test';
  if (o.portable) return 'portable';
  if (!o.packaged && !o.feed) return 'dev';
  return null;
}

export const UPDATE_BLOCK_TEXT: Record<Exclude<UpdateBlock, null>, string> = {
  dev: 'Las actualizaciones solo funcionan en la versión instalada.',
  portable: 'La versión portátil no se actualiza sola: descargue la nueva desde la página de Cinta.',
  test: 'Actualizaciones desactivadas durante las pruebas.',
};

/** Semantic version comparison (1.2.10 > 1.2.9; 1.0.0 > 1.0.0-beta.1). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => { const [core, pre] = v.replace(/^v/, '').split('-', 2); return { n: core.split('.').map((x) => Number(x) || 0), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) { const d = (x.n[i] ?? 0) - (y.n[i] ?? 0); if (d) return Math.sign(d); }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Automatic check due? (manual "Buscar actualizaciones…" always checks) */
export function checkDue(s: UpdateSettings, now: number): boolean {
  return s.auto && (!s.last || now - s.last >= UPDATE_INTERVAL || s.last > now);
}

/** Offer an available version? Not when older/equal to the current one, nor the version the user skipped
 *  (a manual check offers it anyway). */
export function shouldOffer(current: string, available: string, s: UpdateSettings, manual: boolean): boolean {
  if (compareVersions(available, current) <= 0) return false;
  return manual || !s.skip || compareVersions(available, s.skip) > 0;
}

/** Release notes from GitHub come as HTML (or a list for multi-version jumps): plain text for the dialog. */
export function notesText(n: unknown, max = 1200): string {
  const raw = Array.isArray(n) ? n.map((x: { version?: string; note?: string }) => `${x.version ?? ''}\n${x.note ?? ''}`).join('\n\n') : String(n ?? '');
  const t = raw.replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n').replace(/<li>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}
