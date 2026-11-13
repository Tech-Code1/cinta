// Optional local AI (Ollama, LM Studio or any OpenAI-compatible server on this PC). Nothing requires it:
// the same jobs are done by Claude through the MCP tools; this only lets the in-app buttons do them alone.
export interface LlmConfig { baseUrl: string; model: string; apiKey?: string }

export const LLM_PRESETS = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
];

export async function chat(cfg: LlmConfig, system: string, user: string, o: { timeoutMs?: number } = {}): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 180_000);
  try {
    const r = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`La IA local respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('La IA local tardó demasiado en responder.');
    if (/fetch failed|ECONNREFUSED/i.test(String((e as Error).message))) throw new Error(`No se pudo conectar con la IA local en ${cfg.baseUrl}. ¿Está abierta (Ollama / LM Studio)?`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** First JSON value in a model answer (models like to wrap it in prose or ``` fences). */
export function parseJson<T>(text: string): T {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = m ? m[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('La IA local no devolvió datos utilizables.');
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)) as T; } catch { /* shorten */ }
  }
  throw new Error('La IA local no devolvió datos utilizables.');
}

export async function testLlm(cfg: LlmConfig) {
  const t0 = Date.now();
  const a = await chat(cfg, 'Responde solo con la palabra OK.', 'Di OK', { timeoutMs: 60_000 });
  return { ok: /ok/i.test(a), answer: a.slice(0, 60), ms: Date.now() - t0 };
}

const LANGS: Record<string, string> = { es: 'español', pt: 'portugués de Brasil', en: 'inglés', fr: 'francés', it: 'italiano', de: 'alemán' };

/** Translates subtitle lines in batches, keeping their count and order. */
export async function translateLines(cfg: LlmConfig, lines: string[], target: string, onProgress?: (f: number) => void): Promise<string[]> {
  const out: string[] = [];
  const lang = LANGS[target] ?? target;
  for (let i = 0; i < lines.length; i += 25) {
    const batch = lines.slice(i, i + 25);
    const ans = await chat(cfg, `Eres traductor de subtítulos. Traduce cada línea al ${lang}, natural y breve, sin explicaciones. Devuelve SOLO un array JSON de cadenas con el mismo número de elementos (${batch.length}).`, JSON.stringify(batch));
    const arr = parseJson<string[]>(ans);
    if (!Array.isArray(arr) || arr.length !== batch.length) throw new Error('La IA local devolvió un número distinto de líneas.');
    out.push(...arr.map(String));
    onProgress?.(Math.min(1, (i + batch.length) / lines.length));
  }
  return out;
}

/** Chapter titles for a transcript ("[mm:ss] sentence" lines). */
export async function suggestChapters(cfg: LlmConfig, transcript: string): Promise<{ time: number; title: string }[]> {
  const ans = await chat(cfg, 'Divide este vídeo en capítulos para YouTube (entre 3 y 12). Devuelve SOLO un array JSON de objetos {"time": segundos, "title": "título breve en el idioma del vídeo"}. El primero en 0.', transcript.slice(0, 60_000));
  return parseJson<{ time: number; title: string }[]>(ans).filter((c) => typeof c.time === 'number' && c.title).map((c) => ({ time: Math.max(0, c.time), title: String(c.title).slice(0, 80) }));
}

/** Best moments for shorts: ranges of 20–60 s that stand alone, with a hook title. */
export async function suggestShorts(cfg: LlmConfig, transcript: string, count = 5): Promise<{ start: number; end: number; title: string }[]> {
  const ans = await chat(cfg, `Elige los ${count} mejores fragmentos para shorts verticales (20 a 60 s cada uno, que se entiendan solos, con un gancho fuerte). Devuelve SOLO un array JSON de objetos {"start": s, "end": s, "title": "gancho corto en mayúsculas"} usando los tiempos del texto.`, transcript.slice(0, 60_000));
  return parseJson<{ start: number; end: number; title: string }[]>(ans).filter((x) => typeof x.start === 'number' && x.end > x.start + 2).slice(0, count);
}
