// Face tracking for reframing (like the shorts kit's track()): samples frames with ffmpeg, finds the largest
// face with Windows' built-in detector (Windows.Media.FaceAnalysis — free, offline, no downloads) and smooths
// the path so the crop glides instead of jittering.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFfmpeg } from './ffmpeg';

export interface FocusPoint { t: number; x: number; y: number }

const PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.FaceAnalysis.FaceDetector, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
if (-not [Windows.Media.FaceAnalysis.FaceDetector]::IsSupported) { Write-Output 'UNSUPPORTED'; exit 0 }
$fd = Await ([Windows.Media.FaceAnalysis.FaceDetector]::CreateAsync()) ([Windows.Media.FaceAnalysis.FaceDetector])
$dir = $args[0]
foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter '*.png' | Sort-Object Name)) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $gray = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bmp, [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8)
    $faces = Await ($fd.DetectFacesAsync($gray)) ([System.Collections.Generic.IList[Windows.Media.FaceAnalysis.DetectedFace]])
    $best = $null
    foreach ($x in $faces) { if (-not $best -or $x.FaceBox.Width * $x.FaceBox.Height -gt $best.Width * $best.Height) { $best = $x.FaceBox } }
    if ($best) { Write-Output ('{0} {1} {2} {3} {4} {5} {6}' -f $f.Name, $best.X, $best.Y, $best.Width, $best.Height, $dec.PixelWidth, $dec.PixelHeight) }
    else { Write-Output ('{0} -' -f $f.Name) }
  } finally { $stream.Dispose() }
}
`;

function powershell(script: string, args: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cinta-ps-'));
  const file = join(dir, 'faces.ps1');
  writeFileSync(file, `﻿${script.replace(/\r?\n/g, '\r\n')}`, 'utf8');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) reject(new Error(`Detección de caras: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** Smoothed face centre (0..1 of the source frame) over [from, to] of a video, sampled `rate` times a second. */
export async function trackFace(path: string, from: number, to: number, o: { rate?: number; onProgress?: (f: number) => void } = {}): Promise<FocusPoint[] | null> {
  const rate = o.rate ?? 2;
  const dir = mkdtempSync(join(tmpdir(), 'cinta-faces-'));
  try {
    await runFfmpeg(['-ss', from.toFixed(3), '-t', (to - from).toFixed(3), '-i', path, '-an', '-vf', `fps=${rate},scale=-2:360`, join(dir, 'f_%05d.png')], { duration: to - from, onProgress: (f) => o.onProgress?.(f * 0.4) });
    const n = readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    if (!n) return null;
    const out = await powershell(PS, [dir]);
    if (/UNSUPPORTED/.test(out)) throw new Error('La detección de caras no está disponible en este Windows.');
    o.onProgress?.(0.95);
    const xs: (number | null)[] = Array(n).fill(null), ys: (number | null)[] = Array(n).fill(null);
    for (const line of out.split(/\r?\n/)) {
      const m = /^f_(\d+)\.png ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) (\d+) (\d+)/.exec(line.trim());
      if (!m) continue;
      const i = +m[1] - 1, W = +m[6], H = +m[7];
      if (i < 0 || i >= n) continue;
      xs[i] = (+m[2] + +m[4] / 2) / W;
      ys[i] = (+m[3] + +m[5] / 2) / H;
    }
    if (!xs.some((v) => v !== null)) return null;
    const smooth = (arr: (number | null)[], dflt: number) => {
      // fill gaps by interpolation, then median (kills false detections) and a gaussian (glide)
      const known = arr.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
      const filled = arr.map((v, i) => {
        if (v !== null) return v;
        const prev = [...known].reverse().find((k) => k[0] < i), next = known.find((k) => k[0] > i);
        if (prev && next) return prev[1] + ((next[1] - prev[1]) * (i - prev[0])) / (next[0] - prev[0]);
        return (prev ?? next)?.[1] ?? dflt;
      });
      const k = 2;
      const med = filled.map((_, i) => median(filled.slice(Math.max(0, i - k), i + k + 1)));
      const sig = Math.max(1, rate * 1.5), r = Math.ceil(sig * 3);
      return med.map((_, i) => {
        let s = 0, w = 0;
        for (let j = -r; j <= r; j++) {
          const v = med[Math.min(med.length - 1, Math.max(0, i + j))];
          const g = Math.exp(-(j * j) / (2 * sig * sig));
          s += v * g; w += g;
        }
        return s / w;
      });
    };
    const sx = smooth(xs, 0.5), sy = smooth(ys, 0.4);
    o.onProgress?.(1);
    return sx.map((x, i) => ({ t: Math.round((from + (i + 0.5) / rate) * 1000) / 1000, x: Math.round(x * 1000) / 1000, y: Math.round(sy[i] * 1000) / 1000 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
