// Error log shared by the main process and the MCP server: one plain-text file per profile (logs/errores.log),
// rotated at 1 MB so it never grows without limit. Paths of the user's home are shortened to "~" so a log can be
// pasted into a bug report without exposing the user name.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ERROR_LOG_MAX = 1 << 20;

export interface ErrorEntry { when: string; origin: string; message: string; stack: string }

const home = (() => { try { return homedir(); } catch { return ''; } })();
const scrub = (s: string) => {
  if (!home) return s;
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '[\\\\/]');
  return s.replace(new RegExp(esc, 'gi'), '~');
};

/** Turns anything thrown (Error, string, object, undefined) into a log entry. */
export function describeError(e: unknown, origin: string, when = new Date()): ErrorEntry {
  let message: string, stack = '';
  if (e instanceof Error) { message = `${e.name}: ${e.message}`; stack = e.stack ?? ''; }
  else if (typeof e === 'string') message = e;
  else { try { message = JSON.stringify(e) ?? String(e); } catch { message = String(e); } }
  // the stack's first line repeats the message
  const lines = stack.split('\n');
  if (lines[0]?.trim() === message.split('\n')[0]?.trim()) lines.splice(0, message.split('\n').length);
  stack = lines.join('\n').trim();
  return { when: when.toISOString(), origin, message: scrub(message).slice(0, 4000), stack: scrub(stack).slice(0, 8000) };
}

export function formatEntry(x: ErrorEntry): string {
  return `[${x.when}] (${x.origin}) ${x.message}${x.stack ? `\n${x.stack.replace(/^/gm, '    ')}` : ''}\n`;
}

export const errorLogFile = (dir: string) => join(dir, 'errores.log');

/** Appends to logs/errores.log; at the size limit the old file becomes errores.1.log (only one old copy is kept). */
export function appendErrorLog(dir: string, x: ErrorEntry, max = ERROR_LOG_MAX): string {
  const f = errorLogFile(dir);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(f) && statSync(f).size > max) {
      const old = join(dir, 'errores.1.log');
      rmSync(old, { force: true });
      renameSync(f, old);
    }
    appendFileSync(f, formatEntry(x));
  } catch { /* the log must never throw: disk full or read-only profile */ }
  return f;
}

/** Same error over and over (a render loop, a timer) shows one dialog, not hundreds. */
export function errorKey(x: ErrorEntry): string {
  return `${x.origin}|${x.message}|${x.stack.split('\n')[0] ?? ''}`;
}
