// Registers Cinta's MCP server in Claude Desktop and Claude Code (same rules as Shot): the installed app
// does it on first run and keeps the entry current; it never re-adds an entry the user removed, never
// touches other servers and keeps a .bak of the config it edits.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
export type ClientState = 'connected' | 'other' | 'absent' | 'missing';

const NAME = 'cinta';

/**
 * Installed / dev: Cinta's own executable running dist/main/mcp.js as plain Node. Portable: the stub
 * extracts the app to a temporary folder on every run, so "prepare" copies the runtime to CintaData\mcp.
 */
export function launchCommand(): LaunchCommand {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) {
    const dir = join(app.getPath('userData'), 'mcp');
    return { command: join(dir, `${app.getName()}.exe`), args: [join(dir, 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  const server = join(__dirname, 'mcp.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Portable only: copy the running (extracted) app next to the portable exe so MCP clients can start it. */
export function preparePortableRuntime(): void {
  if (!process.env.PORTABLE_EXECUTABLE_FILE) return;
  const src = dirname(process.execPath);
  const dst = join(app.getPath('userData'), 'mcp');
  const marker = join(dst, 'version.txt');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === app.getVersion()) return;
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, force: true });
  writeFileSync(marker, app.getVersion());
}

export const signature = (c = launchCommand()) => JSON.stringify([c.command, c.args, c.env ?? {}]);
export const autoRegisterAllowed = () => (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) || process.env.CINTA_MCP_AUTOREG === '1';

type Entry = { command?: string; args?: string[]; env?: Record<string, string> };
const same = (e: Entry | undefined, c: LaunchCommand) => !!e && e.command === c.command && JSON.stringify(e.args ?? []) === JSON.stringify(c.args) && JSON.stringify(e.env ?? {}) === JSON.stringify(c.env ?? {});
// only an entry that points at this very copy of Cinta (never another install's or someone else's "cinta")
const ours = (e: Entry | undefined, c: LaunchCommand) => !!e && (e.command === c.command || (e.args ?? [])[0] === c.args[0]);
const quote = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const addArgs = (c: LaunchCommand) => ['mcp', 'add', '--scope', 'user', NAME, ...Object.entries(c.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', c.command, ...c.args];

function desktopConfigs(): string[] {
  if (process.env.CINTA_CLAUDE_DESKTOP_DIR) return [join(process.env.CINTA_CLAUDE_DESKTOP_DIR, 'claude_desktop_config.json')];
  const out = [join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json')];
  const pkgs = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Packages');
  try {
    for (const d of readdirSync(pkgs)) if (/^(AnthropicPBC\.)?Claude_/i.test(d)) out.push(join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  } catch { /* no Store packages */ }
  return out.filter((f) => existsSync(dirname(f)));
}
function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`No se pudo leer ${file} (JSON no válido).`); }
}
function writeJson(file: string, data: Record<string, unknown>) {
  if (existsSync(file)) writeFileSync(`${file}.bak`, readFileSync(file));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${file}.tmp`, file);
}
const desktopEntry = (f: string): Entry | undefined => { try { return (readJson(f).mcpServers as Record<string, Entry>)?.[NAME]; } catch { return undefined; } };

export function desktopState(c = launchCommand()): ClientState {
  const files = desktopConfigs();
  if (!files.length) return 'missing';
  const es = files.map(desktopEntry);
  return es.some((e) => same(e, c)) ? 'connected' : es.some(Boolean) ? 'other' : 'absent';
}
export function registerDesktop(c = launchCommand()): void {
  const files = desktopConfigs();
  if (!files.length) throw new Error('No se encontró Claude Desktop.');
  for (const f of files) {
    const cfg = readJson(f);
    cfg.mcpServers = { ...(cfg.mcpServers as object), [NAME]: { command: c.command, args: c.args, ...(c.env ? { env: c.env } : {}) } };
    writeJson(f, cfg);
  }
}
export function unregisterDesktop(c = launchCommand()): boolean {
  let done = false;
  for (const f of desktopConfigs()) {
    try {
      const cfg = readJson(f);
      const s = cfg.mcpServers as Record<string, Entry> | undefined;
      if (!s?.[NAME] || !ours(s[NAME], c)) continue;
      delete s[NAME];
      writeJson(f, cfg);
      done = true;
    } catch { /* unreadable config: leave it */ }
  }
  return done;
}

const codeConfig = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
const claudeCli = () => { const l = join(homedir(), '.local', 'bin', 'claude.exe'); return existsSync(l) ? l : 'claude'; };
function runClaude(args: string[], timeout = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn([claudeCli(), ...args].map(quote).join(' '), { shell: true, windowsHide: true, env });
    let out = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d: Buffer) => (out += d));
    p.stderr.on('data', (d: Buffer) => (out += d));
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
  });
}
const codeEntry = (): Entry | undefined => { try { return JSON.parse(readFileSync(codeConfig(), 'utf8')).mcpServers?.[NAME]; } catch { return undefined; } };
let cli: boolean | null = null;
// tests set CINTA_NO_CLAUDE_CODE so they never touch the real Claude Code configuration
const hasCli = async () => !process.env.CINTA_NO_CLAUDE_CODE && (cli ??= await runClaude(['--version'], 15_000).then((r) => r.code === 0 && /claude/i.test(r.out)));

export async function codeState(c = launchCommand()): Promise<ClientState> {
  const e = codeEntry();
  if (same(e, c)) return 'connected';
  if (e) return 'other';
  return (await hasCli()) ? 'absent' : 'missing';
}
export async function registerCode(c = launchCommand()) {
  if (!(await hasCli())) throw new Error('No se encontró Claude Code (comando «claude»).');
  if (codeEntry()) await runClaude(['mcp', 'remove', NAME, '-s', 'user']);
  const r = await runClaude(addArgs(c));
  if (r.code !== 0) throw new Error(r.out || `claude terminó con código ${r.code}`);
}
export async function unregisterCode(c = launchCommand()) {
  const e = codeEntry();
  if (!e || !ours(e, c) || !(await hasCli())) return false;
  return (await runClaude(['mcp', 'remove', NAME, '-s', 'user'])).code === 0;
}

export async function clientInfo() {
  const c = launchCommand();
  const entry = { command: c.command, args: c.args, ...(c.env ? { env: c.env } : {}) };
  return {
    command: c.command,
    args: c.args,
    configJson: JSON.stringify({ mcpServers: { [NAME]: entry } }, null, 2),
    claudeCodeCommand: ['claude', ...addArgs(c)].map(quote).join(' '),
    desktop: desktopState(c),
    code: await codeState(c),
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  };
}

export interface SyncRecord { desktop: string | null; code: string | null }

/** Plug and play for the installed build (see header). */
export async function syncClients(record: SyncRecord, force = false) {
  const c = launchCommand();
  const sig = signature(c);
  const next = { ...record };
  const added: string[] = [];
  const errors: string[] = [];
  if (force || record.desktop !== sig) {
    const st = desktopState(c);
    if (st === 'connected') next.desktop = sig;
    else if (st !== 'missing' && (st === 'absent' || force || record.desktop !== null)) {
      try { registerDesktop(c); next.desktop = sig; added.push('Claude Desktop'); } catch (e) { errors.push((e as Error).message); }
    }
  }
  if (force || record.code !== sig) {
    const st = await codeState(c);
    if (st === 'connected') next.code = sig;
    else if (st !== 'missing' && (st === 'absent' || force || record.code !== null)) {
      try { await registerCode(c); next.code = sig; added.push('Claude Code'); } catch (e) { errors.push((e as Error).message); }
    }
  }
  return { record: next, added, errors };
}

export async function unregisterAll() {
  const c = launchCommand();
  const removed: string[] = [];
  if (unregisterDesktop(c)) removed.push('Claude Desktop');
  if (await unregisterCode(c)) removed.push('Claude Code');
  return removed;
}
