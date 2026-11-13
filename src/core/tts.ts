// Voice-over from text with the voices already installed in Windows (System.Speech): free, offline.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function ps(script: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cinta-tts-'));
  const file = join(dir, 'tts.ps1');
  writeFileSync(file, `﻿${script.replace(/\r?\n/g, '\r\n')}`, 'utf8');
  return new Promise((ok, ko) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, maxBuffer: 8 << 20 }, (err, out, errOut) => {
    rmSync(dir, { recursive: true, force: true });
    if (err) ko(new Error(`Voz de Windows: ${errOut || err.message}`)); else ok(out);
  }));
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function listVoices(): Promise<{ name: string; culture: string; gender: string }[]> {
  const out = await ps(`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { '{0}|{1}|{2}' -f $_.VoiceInfo.Name, $_.VoiceInfo.Culture.Name, $_.VoiceInfo.Gender }`);
  return out.split(/\r?\n/).filter(Boolean).map((l) => { const [name, culture, gender] = l.split('|'); return { name, culture, gender }; });
}

/** Speaks `text` into a WAV file. voice: name or culture prefix ("es", "pt-BR"); rate −10..10. */
export async function speak(text: string, o: { output: string; voice?: string; rate?: number }): Promise<string> {
  const out = resolve(o.output);
  mkdirSync(dirname(out), { recursive: true });
  const voices = await listVoices();
  const v = o.voice ? voices.find((x) => x.name.toLowerCase() === o.voice!.toLowerCase()) ?? voices.find((x) => x.culture.toLowerCase().startsWith(o.voice!.toLowerCase())) : voices.find((x) => x.culture.startsWith('es')) ?? voices[0];
  if (!v) throw new Error('No hay voces instaladas en Windows (Configuración → Hora e idioma → Voz).');
  await ps(`Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice(${q(v.name)})
$s.Rate = ${Math.max(-10, Math.min(10, Math.round(o.rate ?? 0)))}
$s.SetOutputToWaveFile(${q(out)})
$s.Speak(${q(text)})
$s.Dispose()`);
  return out;
}
