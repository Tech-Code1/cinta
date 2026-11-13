// Parameter builders of the effects catalogue, shared by effects.ts and the per-category files in fx-groups/.
import type { ParamDef } from './effects';

export const n = (id: string, name: string, def: number, min?: number, max?: number): ParamDef => ({ id, name, type: 'number', def, min, max });
export const pc = (id: string, name: string, def: number, min = 0, max = 100): ParamDef => ({ id, name, type: 'percent', def, min, max });
export const an = (id: string, name: string, def: number): ParamDef => ({ id, name, type: 'angle', def });
export const co = (id: string, name: string, def: string): ParamDef => ({ id, name, type: 'color', def });
export const pt = (id: string, name: string, fx = 0.5, fy = 0.5): ParamDef => ({ id, name, type: 'point', def: [fx, fy], rel: true });
export const bo = (id: string, name: string, def = false): ParamDef => ({ id, name, type: 'bool', def: def ? 1 : 0 });
/** another layer of the same composition used as input (its source with masks and effects); '' = none */
export const ly = (id: string, name: string): ParamDef => ({ id, name, type: 'layer', def: '' });
export const CHANNELS: [string, string][] = [['luma', 'Luminancia'], ['red', 'Rojo'], ['green', 'Verde'], ['blue', 'Azul'], ['alpha', 'Alfa'], ['hue', 'Tono'], ['lightness', 'Luminosidad'], ['saturation', 'Saturación'], ['full', 'Completo'], ['half', 'Mitad'], ['off', 'Ninguno (gris 50 %)']];
/** Set Matte's «Use For Matte» (After Effects' 10 choices,; default Alpha) */
export const MATTE_CH: [string, string][] = [['red', 'Canal rojo'], ['green', 'Canal verde'], ['blue', 'Canal azul'], ['alpha', 'Canal alfa'], ['luma', 'Luminancia'], ['hue', 'Tono'], ['lightness', 'Luminosidad'], ['saturation', 'Saturación'], ['full', 'Completo'], ['none', 'Desactivado']];
export const FIT: [string, string][] = [['stretch', 'Ajustar a la capa'], ['center', 'Centrar (tamaño real)'], ['tile', 'Mosaico']];
/** curve: points 'x,y x,y …' in 0…1 (a string: it holds any number of points) */
export const cu = (id: string, name: string): ParamDef => ({ id, name, type: 'curve', def: '0,0 1,1' });
export const tx = (id: string, name: string, def = ''): ParamDef => ({ id, name, type: 'text', def });
export const lv = (pre: string, nm: string): ParamDef[] => [n(`${pre}InBlack`, `${nm}: negro de entrada`, 0, 0, 255), n(`${pre}InWhite`, `${nm}: blanco de entrada`, 255, 0, 255), n(`${pre}Gamma`, `${nm}: gamma`, 1, 0.1, 10), n(`${pre}OutBlack`, `${nm}: negro de salida`, 0, 0, 255), n(`${pre}OutWhite`, `${nm}: blanco de salida`, 255, 0, 255)];
/** a curve that is flat at 0.5 by default (Lumetri's hue / saturation curves: up adds, down takes away) */
export const hc = (id: string, name: string): ParamDef => ({ id, name, type: 'curve', def: '0,0.5 1,0.5' });
export const ch = (id: string, name: string, choices: [string, string][], def?: string): ParamDef => ({ id, name, type: 'choice', def: def ?? choices[0][0], choices: choices.map(([i, nm]) => ({ id: i, name: nm })) });
