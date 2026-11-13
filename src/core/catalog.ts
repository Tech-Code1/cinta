// Cinta's own catalogues. Same categories and functions as Movavi's editor, built from ffmpeg filters and
// our own drawings — no Movavi assets.

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
}

// ───────────────────────────── video filters ─────────────────────────────
// chain(a): ffmpeg filter chain for intensity a (0..1), applied to a yuv420p/rgba frame of the clip size.
export interface FilterDef extends CatalogItem {
  chain: (a: number) => string;
}

const lerp = (a: number, b: number, t: number) => +(a + (b - a) * t).toFixed(4);
const mixWith = (fx: string, a: number) =>
  a >= 0.999 ? fx : `split[fa][fb];[fb]${fx}[fx];[fa][fx]blend=all_expr='A*(1-${a.toFixed(3)})+B*${a.toFixed(3)}'`;

export const FILTERS: FilterDef[] = [
  // Ajustes
  { id: 'bw', name: 'Blanco y negro', category: 'Ajustes', chain: (a) => `hue=s=${lerp(1, 0, a)}` },
  { id: 'sepia', name: 'Sepia', category: 'Ajustes', chain: (a) => mixWith('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131', a) },
  { id: 'warm', name: 'Cálido', category: 'Ajustes', chain: (a) => `colortemperature=temperature=${Math.round(lerp(6500, 3500, a))}` },
  { id: 'cold', name: 'Frío', category: 'Ajustes', chain: (a) => `colortemperature=temperature=${Math.round(lerp(6500, 11000, a))}` },
  { id: 'vivid', name: 'Intenso', category: 'Ajustes', chain: (a) => `eq=saturation=${lerp(1, 1.8, a)}:contrast=${lerp(1, 1.15, a)}` },
  { id: 'faded', name: 'Desvaído', category: 'Ajustes', chain: (a) => `eq=saturation=${lerp(1, 0.55, a)}:contrast=${lerp(1, 0.8, a)}:brightness=${lerp(0, 0.06, a)}` },
  { id: 'invert', name: 'Invertir', category: 'Ajustes', chain: (a) => mixWith('negate', a) },
  { id: 'posterize', name: 'Posterización', category: 'Ajustes', chain: (a) => `lutrgb=r='bitand(val,${256 - 2 ** Math.round(lerp(3, 6, a))})':g='bitand(val,${256 - 2 ** Math.round(lerp(3, 6, a))})':b='bitand(val,${256 - 2 ** Math.round(lerp(3, 6, a))})'` },
  { id: 'duotone-blue', name: 'Duotono azul', category: 'Ajustes', chain: (a) => mixWith('hue=s=0,colorchannelmixer=.2:.2:.2:0:.35:.35:.35:0:.8:.8:.8', a) },
  { id: 'teal-orange', name: 'Cine (verde azulado y naranja)', category: 'Ajustes', chain: (a) => `colorbalance=rs=${lerp(0, -0.15, a)}:bs=${lerp(0, 0.2, a)}:rh=${lerp(0, 0.2, a)}:bh=${lerp(0, -0.15, a)}` },
  // Desenfoques
  { id: 'blur', name: 'Desenfocar', category: 'Desenfoques', chain: (a) => `gblur=sigma=${lerp(0.5, 20, a)}` },
  { id: 'blur-box', name: 'Desenfoque difuso', category: 'Desenfoques', chain: (a) => `boxblur=${Math.max(1, Math.round(lerp(1, 12, a)))}:1` },
  { id: 'motion-blur', name: 'Desenfoque de movimiento', category: 'Desenfoques', chain: (a) => `tmix=frames=${Math.max(2, Math.round(lerp(2, 8, a)))}` },
  { id: 'tilt-shift', name: 'Inclinación-desplazamiento', category: 'Desenfoques', chain: (a) => `split[ta][tb];[tb]gblur=sigma=${lerp(2, 12, a)}[tbl];[ta][tbl]blend=all_expr='if(between(Y/H\\,0.35\\,0.65)\\,A\\,B)'` },
  { id: 'glow', name: 'Resplandor', category: 'Desenfoques', chain: (a) => `split[ga][gb];[gb]gblur=sigma=12,eq=brightness=0.05[gbl];[ga][gbl]blend=all_mode=screen:all_opacity=${lerp(0.1, 0.7, a)}` },
  // Nitidez y ruido
  { id: 'sharpen', name: 'Enfocar', category: 'Básicos', chain: (a) => `unsharp=5:5:${lerp(0.3, 2.5, a)}` },
  { id: 'noise', name: 'Ruido', category: 'Ruido', chain: (a) => `noise=alls=${Math.round(lerp(5, 60, a))}:allf=t` },
  { id: 'noise-bw', name: 'Ruido B/N', category: 'Ruido', chain: (a) => `hue=s=0,noise=alls=${Math.round(lerp(5, 60, a))}:allf=t` },
  { id: 'grain', name: 'Grano de película', category: 'Ruido', chain: (a) => `noise=c0s=${Math.round(lerp(4, 30, a))}:c0f=t+u` },
  // Artísticos
  { id: 'edges', name: 'Contornos brillantes', category: 'Artísticos', chain: (a) => mixWith('edgedetect=low=0.1:high=0.3:mode=colormix', a) },
  { id: 'sketch', name: 'Boceto', category: 'Artísticos', chain: (a) => mixWith('edgedetect=low=0.05:high=0.2,negate,hue=s=0', a) },
  { id: 'oil', name: 'Pintura al óleo', category: 'Artísticos', chain: (a) => `median=radius=${Math.max(1, Math.round(lerp(1, 5, a)))},eq=saturation=1.3` },
  { id: 'cartoon', name: 'Cómic', category: 'Artísticos', chain: (a) => `median=radius=${Math.max(1, Math.round(lerp(1, 4, a)))},lutrgb=r='bitand(val,224)':g='bitand(val,224)':b='bitand(val,224)',eq=saturation=1.4` },
  { id: 'emboss', name: 'Relieve', category: 'Artísticos', chain: (a) => mixWith("convolution='-2 -1 0 -1 1 1 0 1 2':'-2 -1 0 -1 1 1 0 1 2':'-2 -1 0 -1 1 1 0 1 2':'-2 -1 0 -1 1 1 0 1 2'", a) },
  { id: 'erosion', name: 'Erosión', category: 'Artísticos', chain: (a) => Array(Math.max(1, Math.round(lerp(1, 4, a)))).fill('erosion').join(',') },
  { id: 'dilation', name: 'Dilatación', category: 'Artísticos', chain: (a) => Array(Math.max(1, Math.round(lerp(1, 4, a)))).fill('dilation').join(',') },
  { id: 'halftone', name: 'Semitono', category: 'Artísticos', chain: (a) => `hue=s=0,geq=lum='if(gt(lum(X\\,Y)\\,128+${Math.round(lerp(10, 90, a))}*sin(X/2)*sin(Y/2))\\,255\\,0)':cb=128:cr=128` },
  // Mosaico
  { id: 'pixelate', name: 'Píxeles', category: 'Mosaico', chain: (a) => `pixelize=w=${Math.round(lerp(4, 48, a))}:h=${Math.round(lerp(4, 48, a))}` },
  { id: 'tiles-4', name: 'Pop art 4 cuadros', category: 'Mosaico', chain: () => `scale=iw/2:ih/2,split=4[p1][p2][p3][p4];[p1]hue=h=0:s=2[q1];[p2]hue=h=90:s=2[q2];[p3]hue=h=180:s=2[q3];[p4]hue=h=270:s=2[q4];[q1][q2][q3][q4]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0` },
  { id: 'tiles-9', name: 'Mosaico 9 cuadros', category: 'Mosaico', chain: () => `scale=iw/3:ih/3,split=3[r1][r2][r3];[r1][r2][r3]hstack=3,split=3[s1][s2][s3];[s1][s2][s3]vstack=3` },
  // Lente
  { id: 'vignette', name: 'Viñeta', category: 'Lente', chain: (a) => `vignette=angle=${lerp(0.2, 0.9, a)}` },
  { id: 'fisheye', name: 'Ojo de pez', category: 'Lente', chain: (a) => `lenscorrection=k1=${lerp(-0.05, -0.5, a)}:k2=${lerp(-0.02, -0.2, a)}` },
  { id: 'pinch', name: 'Barril', category: 'Lente', chain: (a) => `lenscorrection=k1=${lerp(0.05, 0.5, a)}:k2=${lerp(0.02, 0.2, a)}` },
  { id: 'chromatic', name: 'Aberración cromática', category: 'Lente', chain: (a) => `rgbashift=rh=${Math.round(lerp(2, 16, a))}:bh=-${Math.round(lerp(2, 16, a))}` },
  // Reflejar
  { id: 'flip-h', name: 'Voltear ↔', category: 'Reflejar', chain: () => 'hflip' },
  { id: 'flip-v', name: 'Voltear ↕', category: 'Reflejar', chain: () => 'vflip' },
  { id: 'mirror-h', name: 'Reflejar ↔', category: 'Reflejar', chain: () => `crop=iw/2:ih:0:0,split[m1][m2];[m2]hflip[m3];[m1][m3]hstack` },
  { id: 'mirror-v', name: 'Reflejar ↕', category: 'Reflejar', chain: () => `crop=iw:ih/2:0:0,split[m1][m2];[m2]vflip[m3];[m1][m3]vstack` },
  { id: 'kaleido', name: 'Caleidoscopio', category: 'Reflejar', chain: () => `crop=iw/2:ih/2:0:0,split[k1][k2];[k2]hflip[k3];[k1][k3]hstack,split[k4][k5];[k5]vflip[k6];[k4][k6]vstack` },
  // Retro
  { id: 'old-film', name: 'Película antigua', category: 'Retro', chain: (a) => `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131,noise=alls=${Math.round(lerp(10, 40, a))}:allf=t,vignette=angle=0.7,eq=contrast=1.1` },
  { id: 'film-70s', name: 'Película de los 70', category: 'Retro', chain: (a) => `curves=preset=vintage,eq=saturation=${lerp(1, 0.75, a)},noise=alls=12:allf=t` },
  { id: 'vhs', name: 'VHS', category: 'Retro', chain: (a) => `chromashift=cbh=${Math.round(lerp(2, 8, a))}:crh=-${Math.round(lerp(2, 8, a))},noise=alls=${Math.round(lerp(6, 25, a))}:allf=t,eq=saturation=1.3:contrast=1.1` },
  { id: 'crt', name: 'TV de tubo', category: 'Retro', chain: (a) => `geq=lum='lum(X\\,Y)*(1-${lerp(0.15, 0.6, a).toFixed(2)}*mod(Y\\,3)/2)':cb='cb(X\\,Y)':cr='cr(X\\,Y)',vignette=angle=0.6` },
  { id: 'glitch', name: 'Glitch', category: 'Retro', chain: (a) => `rgbashift=rh=${Math.round(lerp(4, 24, a))}:gv=${Math.round(lerp(2, 10, a))}:bh=-${Math.round(lerp(4, 24, a))},noise=alls=10:allf=t` },
  { id: 'cross-process', name: 'Proceso cruzado', category: 'Retro', chain: () => 'curves=preset=cross_process' },
  { id: 'lighter', name: 'Más claro', category: 'Básicos', chain: (a) => `curves=preset=lighter,eq=brightness=${lerp(0, 0.05, a)}` },
  { id: 'darker', name: 'Más oscuro', category: 'Básicos', chain: (a) => `curves=preset=darker,eq=brightness=${lerp(0, -0.05, a)}` },
  { id: 'strong-contrast', name: 'Contraste fuerte', category: 'Básicos', chain: () => 'curves=preset=strong_contrast' },
  // Luces
  { id: 'light-leak', name: 'Fuga de luz', category: 'Luces', chain: (a) => `geq=r='min(255\\,r(X\\,Y)+${Math.round(lerp(20, 120, a))}*exp(-((X-W*0.85)^2+(Y-H*0.2)^2)/(W*W*0.08)))':g='min(255\\,g(X\\,Y)+${Math.round(lerp(10, 60, a))}*exp(-((X-W*0.85)^2+(Y-H*0.2)^2)/(W*W*0.08)))':b='b(X\\,Y)'` },
  { id: 'flash', name: 'Destello', category: 'Luces', chain: (a) => `eq=brightness='${lerp(0.05, 0.35, a)}*abs(sin(t*3))':eval=frame` },
  { id: 'strobe', name: 'Estroboscopio', category: 'Luces', chain: (a) => `eq=brightness='if(lt(mod(t\\,0.25)\\,0.06)\\,${lerp(0.2, 0.6, a)}\\,0)':eval=frame` },
  // Movimiento
  { id: 'shake', name: 'Sacudida de cámara', category: 'Movimiento', chain: (a) => `scale=iw*1.1:ih*1.1,crop=iw/1.1:ih/1.1:x='(iw-ow)/2+${lerp(4, 30, a)}*sin(t*37)':y='(ih-oh)/2+${lerp(4, 30, a)}*cos(t*29)'` },
  { id: 'wave', name: 'Ondulación', category: 'Movimiento', chain: (a) => `geq=lum='lum(X+${lerp(2, 14, a)}*sin(Y/20+T*4)\\,Y)':cb='cb(X+${lerp(1, 7, a)}*sin(Y/10+T*4)\\,Y)':cr='cr(X+${lerp(1, 7, a)}*sin(Y/10+T*4)\\,Y)'` },
  { id: 'ghost', name: 'Estela', category: 'Movimiento', chain: (a) => `lagfun=decay=${lerp(0.9, 0.98, a)}` },
  { id: 'echo', name: 'Eco visual', category: 'Movimiento', chain: (a) => `tmix=frames=${Math.round(lerp(3, 10, a))}:weights='1 1 1 1 1 1 1 1 1 4'` },
  { id: 'zoom-pulse', name: 'Pulso', category: 'Movimiento', chain: (a) => `scale=w='iw*(1+${lerp(0.02, 0.12, a)}*abs(sin(t*3)))':h=-2:eval=frame` },
];

// ───────────────────────────── transitions (ffmpeg xfade) ─────────────────────────────
export interface TransitionDef extends CatalogItem {
  xfade: string;
}

const T = (id: string, name: string, category: string, xfade = id): TransitionDef => ({ id, name, category, xfade });
export const TRANSITIONS: TransitionDef[] = [
  T('fade', 'Fundido cruzado', 'Fundidos'),
  T('fadeblack', 'Fundido a negro', 'Fundidos'),
  T('fadewhite', 'Fundido a blanco', 'Fundidos'),
  T('fadegrays', 'Fundido en grises', 'Fundidos'),
  T('dissolve', 'Desintegrar', 'Fundidos'),
  T('fadefast', 'Fundido rápido', 'Fundidos'),
  T('fadeslow', 'Fundido lento', 'Fundidos'),
  T('hblur', 'Desenfoque horizontal', 'Desenfoques'),
  T('distance', 'Distancia', 'Desenfoques'),
  T('circleopen', 'Círculo exterior', 'Círculo'),
  T('circleclose', 'Círculo interior', 'Círculo'),
  T('circlecrop', 'Recorte circular', 'Círculo'),
  T('radial', 'Radial', 'Círculo'),
  T('pixelize', 'Mosaico', 'Bloques'),
  T('rectcrop', 'Recorte rectangular', 'Bloques'),
  T('hlslice', 'Persianas ←', 'Bloques'),
  T('hrslice', 'Persianas →', 'Bloques'),
  T('vuslice', 'Persianas ↑', 'Bloques'),
  T('vdslice', 'Persianas ↓', 'Bloques'),
  T('diagtl', 'Diagonal ↖', 'Geométrico'),
  T('diagtr', 'Diagonal ↗', 'Geométrico'),
  T('diagbl', 'Diagonal ↙', 'Geométrico'),
  T('diagbr', 'Diagonal ↘', 'Geométrico'),
  T('horzopen', 'Puerta corrediza ↔ abrir', 'Geométrico'),
  T('horzclose', 'Puerta corrediza ↔ cerrar', 'Geométrico'),
  T('vertopen', 'Puerta corrediza ↕ abrir', 'Geométrico'),
  T('vertclose', 'Puerta corrediza ↕ cerrar', 'Geométrico'),
  T('squeezeh', 'Comprimir ↔', 'Deformación'),
  T('squeezev', 'Comprimir ↕', 'Deformación'),
  T('wipeleft', 'Borrado ←', 'Borrado'),
  T('wiperight', 'Borrado →', 'Borrado'),
  T('wipeup', 'Borrado ↑', 'Borrado'),
  T('wipedown', 'Borrado ↓', 'Borrado'),
  T('wipetl', 'Borrado ↖', 'Borrado'),
  T('wipetr', 'Borrado ↗', 'Borrado'),
  T('wipebl', 'Borrado ↙', 'Borrado'),
  T('wipebr', 'Borrado ↘', 'Borrado'),
  T('smoothleft', 'Gradiente ←', 'Borrado'),
  T('smoothright', 'Gradiente →', 'Borrado'),
  T('smoothup', 'Gradiente ↑', 'Borrado'),
  T('smoothdown', 'Gradiente ↓', 'Borrado'),
  T('zoomin', 'Acercar', 'Zoom'),
  T('slideleft', 'Deslizar ←', 'Desplazamiento'),
  T('slideright', 'Deslizar →', 'Desplazamiento'),
  T('slideup', 'Deslizar ↑', 'Desplazamiento'),
  T('slidedown', 'Deslizar ↓', 'Desplazamiento'),
  T('coverleft', 'Cubrir ←', 'Desplazamiento'),
  T('coverright', 'Cubrir →', 'Desplazamiento'),
  T('coverup', 'Cubrir ↑', 'Desplazamiento'),
  T('coverdown', 'Cubrir ↓', 'Desplazamiento'),
  T('revealleft', 'Descubrir ←', 'Desplazamiento'),
  T('revealright', 'Descubrir →', 'Desplazamiento'),
  T('revealup', 'Descubrir ↑', 'Desplazamiento'),
  T('revealdown', 'Descubrir ↓', 'Desplazamiento'),
  T('windleft', 'Viento ←', 'Ondulación', 'hlwind'),
  T('windright', 'Viento →', 'Ondulación', 'hrwind'),
  T('windup', 'Viento ↑', 'Ondulación', 'vuwind'),
  T('winddown', 'Viento ↓', 'Ondulación', 'vdwind'),
];

// ───────────────────────────── titles ─────────────────────────────
import type { TitleStyle } from './model';
export interface TitleDef extends CatalogItem {
  style: Partial<TitleStyle>;
  sample: string;
}
export const TITLE_ANIMS: CatalogItem[] = [
  { id: 'none', name: 'Sin animación', category: 'Texto' },
  { id: 'fade', name: 'Fundido', category: 'Texto' },
  { id: 'slide-left', name: 'Deslizar desde la derecha', category: 'Texto' },
  { id: 'slide-right', name: 'Deslizar desde la izquierda', category: 'Texto' },
  { id: 'slide-up', name: 'Subir', category: 'Texto' },
  { id: 'slide-down', name: 'Bajar', category: 'Texto' },
  { id: 'zoom-in', name: 'Acercar', category: 'Texto' },
  { id: 'zoom-out', name: 'Alejar', category: 'Texto' },
  { id: 'typewriter', name: 'Máquina de escribir', category: 'Texto' },
  { id: 'scroll-up', name: 'Créditos (desplazar ↑)', category: 'Texto' },
  { id: 'scroll-left', name: 'Desplazar ←', category: 'Texto' },
  { id: 'blur-in', name: 'Texto difuminado', category: 'Texto' },
  { id: 'spin', name: 'Girar', category: 'Texto' },
  { id: 'pop', name: 'Rebote', category: 'Texto' },
  { id: 'karaoke', name: 'Palabra a palabra', category: 'Texto' },
];
const TT = (id: string, name: string, category: string, sample: string, style: Partial<TitleStyle>): TitleDef => ({ id, name, category, sample, style });
export const TITLES: TitleDef[] = [
  TT('basic', 'Texto sencillo', 'Básicos', 'Su texto aquí', { size: 80, anim: 'fade' }),
  TT('shadow', 'Texto sombreado', 'Básicos', 'Su texto aquí', { size: 84, shadow: 6, anim: 'fade' }),
  TT('outline', 'Texto con contorno', 'Básicos', 'Su texto aquí', { size: 84, outline: 5, outlineColor: '#000000', shadow: 0 }),
  TT('boxed', 'Texto con fondo', 'Básicos', 'Su texto aquí', { size: 64, background: true, backgroundColor: '#1d6cff', shadow: 0 }),
  TT('title-sub', 'Título + subtítulo', 'Básicos', 'Título\\NSubtítulo', { size: 90, anim: 'slide-up' }),
  TT('bold-yellow', 'Impacto amarillo', 'Básicos', '¡ATENCIÓN!', { size: 110, color: '#ffd400', outline: 6, outlineColor: '#000000', anim: 'pop' }),
  TT('lower-third', 'Tercio inferior', 'Tercio inferior', 'Nombre Apellido\\NCargo', { size: 56, align: 'left', x: 0.06, y: 0.82, background: true, backgroundColor: '#e8455a', shadow: 0, anim: 'slide-right' }),
  TT('lower-third-dark', 'Tercio inferior oscuro', 'Tercio inferior', 'Nombre Apellido', { size: 52, align: 'left', x: 0.06, y: 0.84, background: true, backgroundColor: '#14161d', shadow: 0, anim: 'slide-right' }),
  TT('lower-third-line', 'Tercio inferior con línea', 'Tercio inferior', 'Información principal', { size: 54, align: 'left', x: 0.06, y: 0.84, outline: 0, shadow: 3, anim: 'slide-up' }),
  TT('footnote', 'Nota al pie', 'Notas al pie', 'Nota al pie', { size: 40, y: 0.92, shadow: 2, bold: false, anim: 'fade' }),
  TT('footnote-box', 'Nota al pie con cuadro', 'Notas al pie', 'Nota al pie', { size: 40, y: 0.92, background: true, backgroundColor: '#000000', shadow: 0, bold: false }),
  TT('subtitle', 'Subtítulos con fondo', 'Subtítulos', 'Subtítulo de ejemplo', { size: 52, y: 0.88, background: true, backgroundColor: '#000000', bold: false, shadow: 0, anim: 'none' }),
  TT('subtitle-karaoke', 'Subtítulos palabra a palabra', 'Subtítulos', 'CADA PALABRA SE ILUMINA', { size: 90, y: 0.72, outline: 7, outlineColor: '#000000', color: '#ffffff', highlight: '#ffd400', uppercase: true, anim: 'karaoke' }),
  TT('subtitle-shorts', 'Subtítulos para shorts', 'Subtítulos', 'PALABRA CLAVE', { size: 92, y: 0.7, outline: 7, outlineColor: '#000000', color: '#ffffff', anim: 'pop' }),
  TT('quote', 'Cita', 'Citas', '«Una frase importante»', { size: 70, italic: true, bold: false, shadow: 3, anim: 'blur-in' }),
  TT('bubble', 'Globo', 'Globos', '¡Hola!', { size: 64, color: '#111111', background: true, backgroundColor: '#ffffff', shadow: 0, anim: 'pop' }),
  TT('credits', 'Créditos', 'Créditos', 'Dirección\\NNombre\\N\\NEdición\\NNombre\\N\\NMúsica\\NNombre', { size: 54, bold: false, anim: 'scroll-up' }),
  TT('ticker', 'Desplazar ←', 'Desplazamiento', 'Última hora · Texto que se desplaza por la pantalla', { size: 50, y: 0.9, background: true, backgroundColor: '#c8102e', shadow: 0, anim: 'scroll-left' }),
  TT('typewriter', 'Máquina de escribir', 'Animados', 'Escribiendo…', { size: 72, font: 'Consolas', bold: false, anim: 'typewriter' }),
  TT('zoom', 'Acercar', 'Animados', 'Su texto aquí', { size: 96, anim: 'zoom-in' }),
  TT('spin', 'Girar', 'Animados', 'Su texto aquí', { size: 90, anim: 'spin' }),
  TT('timer', 'Temporizador', 'Temporizador', '10', { size: 160, anim: 'none', timerFrom: 10 }),
  TT('chapter', 'Capítulo', 'Introducción', 'CAPÍTULO 1', { size: 120, outline: 0, shadow: 8, anim: 'zoom-out' }),
  TT('neon', 'Neón', 'Introducción', 'NEÓN', { size: 130, color: '#5ff7ff', outline: 3, outlineColor: '#0b6cff', shadow: 10, shadowColor: '#00c8ff', anim: 'fade' }),
];

// ───────────────────────────── stickers and callouts (own SVG drawings) ─────────────────────────────
export interface GraphicDef extends CatalogItem {
  svg: (color?: string) => string;
  /** default size relative to frame height */
  size: number;
  recolor?: boolean;
}
const svg = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const face = (mouth: string, eyes = '<circle cx="70" cy="80" r="11" fill="#3b2a12"/><circle cx="130" cy="80" r="11" fill="#3b2a12"/>', extra = '') =>
  svg(200, 200, `<circle cx="100" cy="100" r="90" fill="#ffcc33" stroke="#e0a100" stroke-width="6"/>${eyes}${mouth}${extra}`);
const star = (cx: number, cy: number, r: number, fill: string, k = 0.45) => {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2, rr = i % 2 ? r * k : r;
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
  });
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
};
const burst = (text: string, fill: string, ink: string) => {
  const pts = Array.from({ length: 24 }, (_, i) => {
    const a = (Math.PI / 12) * i, rr = i % 2 ? 70 : 100;
    return `${(150 + rr * 1.4 * Math.cos(a)).toFixed(1)},${(110 + rr * Math.sin(a)).toFixed(1)}`;
  });
  return svg(300, 220, `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${ink}" stroke-width="6"/><text x="150" y="128" font-family="Segoe UI, Arial" font-weight="900" font-size="52" text-anchor="middle" fill="${ink}">${text}</text>`);
};
const heart = (fill: string) => 'M100 178 C 20 120 0 80 30 45 C 55 18 90 28 100 55 C 110 28 145 18 170 45 C 200 80 180 120 100 178 Z'.replace(/^/, `<path fill="${fill}" d="`) + '"/>';

export const STICKERS: GraphicDef[] = [
  { id: 'smile', name: 'Sonrisa', category: 'Emoji', size: 0.25, svg: () => face('<path d="M55 120 Q100 165 145 120" stroke="#3b2a12" stroke-width="10" fill="none" stroke-linecap="round"/>') },
  { id: 'laugh', name: 'Risa', category: 'Emoji', size: 0.25, svg: () => face('<path d="M50 110 Q100 185 150 110 Z" fill="#3b2a12"/><path d="M70 145 Q100 165 130 145" fill="#e8455a"/>', '<path d="M55 85 Q70 65 85 85" stroke="#3b2a12" stroke-width="9" fill="none"/><path d="M115 85 Q130 65 145 85" stroke="#3b2a12" stroke-width="9" fill="none"/>') },
  { id: 'wink', name: 'Guiño', category: 'Emoji', size: 0.25, svg: () => face('<path d="M60 125 Q100 160 140 125" stroke="#3b2a12" stroke-width="10" fill="none" stroke-linecap="round"/>', '<circle cx="70" cy="80" r="11" fill="#3b2a12"/><path d="M115 82 L145 82" stroke="#3b2a12" stroke-width="9" stroke-linecap="round"/>') },
  { id: 'sad', name: 'Triste', category: 'Emoji', size: 0.25, svg: () => face('<path d="M60 145 Q100 110 140 145" stroke="#3b2a12" stroke-width="10" fill="none" stroke-linecap="round"/>', undefined, '<path d="M135 95 Q128 115 135 122 Q142 115 135 95" fill="#4aa3ff"/>') },
  { id: 'love-eyes', name: 'Enamorado', category: 'Emoji', size: 0.25, svg: () => face('<path d="M55 120 Q100 170 145 120" stroke="#3b2a12" stroke-width="10" fill="none" stroke-linecap="round"/>', `<g transform="translate(42 52) scale(.3)">${heart('#e8455a')}</g><g transform="translate(102 52) scale(.3)">${heart('#e8455a')}</g>`) },
  { id: 'cool', name: 'Gafas de sol', category: 'Emoji', size: 0.25, svg: () => face('<path d="M65 130 Q100 150 135 130" stroke="#3b2a12" stroke-width="10" fill="none" stroke-linecap="round"/>', '<rect x="38" y="65" width="56" height="34" rx="10" fill="#111"/><rect x="106" y="65" width="56" height="34" rx="10" fill="#111"/><rect x="90" y="72" width="20" height="6" fill="#111"/>') },
  { id: 'surprised', name: 'Sorpresa', category: 'Emoji', size: 0.25, svg: () => face('<ellipse cx="100" cy="135" rx="18" ry="24" fill="#3b2a12"/>') },
  { id: 'heart', name: 'Corazón', category: 'Amor', size: 0.25, recolor: true, svg: (c = '#e8455a') => svg(200, 200, heart(c)) },
  { id: 'two-hearts', name: 'Dos corazones', category: 'Amor', size: 0.28, recolor: true, svg: (c = '#e8455a') => svg(260, 200, `<g transform="translate(0 20) scale(.8)">${heart(c)}</g><g transform="translate(100 0) scale(.8)">${heart('#ff8fb1')}</g>`) },
  { id: 'rose', name: 'Rosa', category: 'Amor', size: 0.3, svg: () => svg(160, 240, '<path d="M80 110 L80 230" stroke="#2e8b3a" stroke-width="10"/><path d="M80 170 Q40 150 35 175 Q60 190 80 175" fill="#3faa4a"/><circle cx="80" cy="75" r="55" fill="#d92b48"/><path d="M50 70 Q80 30 110 70 Q80 100 50 70" fill="#b51d37"/><path d="M62 80 Q80 55 98 80" stroke="#8f1129" stroke-width="5" fill="none"/>') },
  { id: 'gift', name: 'Regalo', category: 'Celebración', size: 0.25, svg: () => svg(200, 200, '<rect x="25" y="80" width="150" height="105" rx="8" fill="#6c5ce7"/><rect x="15" y="60" width="170" height="35" rx="8" fill="#8577ff"/><rect x="88" y="60" width="24" height="125" fill="#ffd400"/><path d="M100 60 Q60 10 50 45 Q55 62 100 60 Q140 10 150 45 Q145 62 100 60" fill="none" stroke="#ffd400" stroke-width="10"/>') },
  { id: 'cake', name: 'Pastel', category: 'Celebración', size: 0.25, svg: () => svg(200, 200, '<rect x="30" y="95" width="140" height="85" rx="10" fill="#ff9fb3"/><path d="M30 115 Q50 135 70 115 Q90 135 110 115 Q130 135 150 115 Q160 130 170 115 L170 95 L30 95Z" fill="#fff"/><rect x="95" y="50" width="10" height="45" fill="#4aa3ff"/><path d="M100 22 Q112 40 100 50 Q88 40 100 22" fill="#ffb300"/>') },
  { id: 'balloons', name: 'Globos', category: 'Celebración', size: 0.3, svg: () => svg(200, 260, '<path d="M70 120 Q80 190 100 250 M130 115 Q120 190 100 250" stroke="#777" stroke-width="3" fill="none"/><ellipse cx="70" cy="75" rx="45" ry="58" fill="#e8455a"/><ellipse cx="135" cy="70" rx="45" ry="58" fill="#4aa3ff"/><ellipse cx="55" cy="55" rx="10" ry="16" fill="#fff" opacity=".5"/>') },
  { id: 'trophy', name: 'Trofeo', category: 'Celebración', size: 0.25, svg: () => svg(200, 200, '<path d="M55 30 H145 V85 Q145 130 100 135 Q55 130 55 85Z" fill="#ffc400"/><path d="M55 45 H25 Q25 95 62 100 M145 45 H175 Q175 95 138 100" stroke="#ffc400" stroke-width="10" fill="none"/><rect x="88" y="135" width="24" height="30" fill="#e0a100"/><rect x="60" y="165" width="80" height="20" rx="4" fill="#8a5a00"/>') },
  { id: 'medal', name: 'Medalla', category: 'Celebración', size: 0.25, svg: () => svg(200, 220, '<path d="M60 10 L100 90 L140 10" stroke="#e8455a" stroke-width="26" fill="none"/><circle cx="100" cy="140" r="62" fill="#ffc400" stroke="#e0a100" stroke-width="8"/><text x="100" y="163" font-family="Segoe UI, Arial" font-weight="900" font-size="64" text-anchor="middle" fill="#8a5a00">1</text>') },
  { id: 'star', name: 'Estrella', category: 'Formas', size: 0.22, recolor: true, svg: (c = '#ffd400') => svg(200, 200, star(100, 105, 95, c)) },
  { id: 'sparkles', name: 'Destellos', category: 'Formas', size: 0.22, recolor: true, svg: (c = '#ffd400') => svg(200, 200, star(80, 110, 70, c, 0.2) + star(155, 50, 35, c, 0.2) + star(160, 160, 25, c, 0.2)) },
  { id: 'fire', name: 'Fuego', category: 'Formas', size: 0.25, svg: () => svg(180, 220, '<path d="M90 10 Q150 70 150 140 Q150 210 90 210 Q30 210 30 140 Q30 95 65 70 Q60 110 85 115 Q70 60 90 10Z" fill="#ff5a1f"/><path d="M90 95 Q125 135 120 165 Q115 200 90 200 Q65 200 62 168 Q60 140 90 95Z" fill="#ffc400"/>') },
  { id: 'lightbulb', name: 'Idea', category: 'Negocios', size: 0.25, svg: () => svg(160, 220, '<circle cx="80" cy="80" r="62" fill="#ffd94a" stroke="#e0a100" stroke-width="6"/><rect x="52" y="135" width="56" height="20" fill="#c7c7c7"/><rect x="52" y="158" width="56" height="16" fill="#a9a9a9"/><rect x="62" y="176" width="36" height="14" rx="6" fill="#8a8a8a"/><path d="M60 85 L80 105 L100 85" stroke="#e0a100" stroke-width="5" fill="none"/>') },
  { id: 'chart', name: 'Gráfico', category: 'Negocios', size: 0.25, svg: () => svg(220, 200, '<rect x="10" y="10" width="200" height="180" rx="14" fill="#fff"/><rect x="40" y="110" width="30" height="60" fill="#4aa3ff"/><rect x="90" y="80" width="30" height="90" fill="#36c48f"/><rect x="140" y="40" width="30" height="130" fill="#ff8a3d"/><path d="M40 90 L100 55 L160 25" stroke="#e8455a" stroke-width="6" fill="none"/>') },
  { id: 'dollar', name: 'Dinero', category: 'Negocios', size: 0.22, svg: () => svg(200, 200, '<circle cx="100" cy="100" r="88" fill="#36c48f" stroke="#1f8a5f" stroke-width="8"/><text x="100" y="135" font-family="Segoe UI, Arial" font-weight="900" font-size="110" text-anchor="middle" fill="#fff">$</text>') },
  { id: 'gear', name: 'Engranaje', category: 'Negocios', size: 0.22, recolor: true, svg: (c = '#8a93ad') => svg(200, 200, `${Array.from({ length: 8 }, (_, i) => `<rect x="88" y="8" width="24" height="40" rx="4" fill="${c}" transform="rotate(${i * 45} 100 100)"/>`).join('')}<circle cx="100" cy="100" r="62" fill="${c}"/><circle cx="100" cy="100" r="24" fill="#fff"/>`) },
  { id: 'target', name: 'Objetivo', category: 'Negocios', size: 0.22, svg: () => svg(200, 200, '<circle cx="100" cy="100" r="90" fill="#e8455a"/><circle cx="100" cy="100" r="65" fill="#fff"/><circle cx="100" cy="100" r="40" fill="#e8455a"/><circle cx="100" cy="100" r="16" fill="#fff"/>') },
  { id: 'clock', name: 'Reloj', category: 'Negocios', size: 0.22, svg: () => svg(200, 200, '<circle cx="100" cy="100" r="88" fill="#fff" stroke="#30364a" stroke-width="10"/><path d="M100 100 L100 45 M100 100 L140 120" stroke="#30364a" stroke-width="10" stroke-linecap="round"/>') },
  { id: 'calendar', name: 'Calendario', category: 'Negocios', size: 0.22, svg: () => svg(200, 200, '<rect x="20" y="35" width="160" height="150" rx="14" fill="#fff" stroke="#30364a" stroke-width="6"/><rect x="20" y="35" width="160" height="40" rx="14" fill="#e8455a"/><rect x="55" y="20" width="12" height="35" rx="6" fill="#30364a"/><rect x="133" y="20" width="12" height="35" rx="6" fill="#30364a"/><text x="100" y="160" font-family="Segoe UI, Arial" font-weight="900" font-size="70" text-anchor="middle" fill="#30364a">31</text>') },
  { id: 'book', name: 'Libro', category: 'Educación', size: 0.25, svg: () => svg(220, 180, '<path d="M110 40 Q60 15 15 30 V160 Q60 145 110 170Z" fill="#4aa3ff"/><path d="M110 40 Q160 15 205 30 V160 Q160 145 110 170Z" fill="#2f86e0"/><path d="M110 40 V170" stroke="#1d5fa8" stroke-width="5"/>') },
  { id: 'grad-cap', name: 'Graduación', category: 'Educación', size: 0.25, svg: () => svg(240, 180, '<polygon points="120,20 230,65 120,110 10,65" fill="#222"/><path d="M60 85 V130 Q120 165 180 130 V85 L120 110Z" fill="#333"/><path d="M200 75 V140" stroke="#ffc400" stroke-width="6"/><circle cx="200" cy="145" r="9" fill="#ffc400"/>') },
  { id: 'globe', name: 'Globo terráqueo', category: 'Viajes', size: 0.22, svg: () => svg(200, 200, '<circle cx="100" cy="100" r="88" fill="#4aa3ff"/><path d="M45 60 Q70 40 95 60 Q105 85 80 95 Q60 110 70 140 Q45 120 40 95Z M120 40 Q160 50 170 90 Q150 100 135 85 Q115 75 120 40Z M120 120 Q150 115 155 140 Q140 170 120 160Z" fill="#36c48f"/>') },
  { id: 'plane', name: 'Avión', category: 'Viajes', size: 0.25, recolor: true, svg: (c = '#ffffff') => svg(220, 220, `<path d="M110 10 Q122 10 122 40 V90 L205 140 V160 L122 135 V180 L145 198 V210 L110 200 L75 210 V198 L98 180 V135 L15 160 V140 L98 90 V40 Q98 10 110 10Z" fill="${c}" stroke="#30364a" stroke-width="5"/>`) },
  { id: 'camera', name: 'Cámara', category: 'Viajes', size: 0.22, svg: () => svg(220, 170, '<rect x="10" y="40" width="200" height="120" rx="16" fill="#30364a"/><rect x="70" y="20" width="80" height="30" rx="8" fill="#30364a"/><circle cx="110" cy="100" r="45" fill="#8a93ad"/><circle cx="110" cy="100" r="28" fill="#1b1e28"/><circle cx="180" cy="62" r="8" fill="#ffd400"/>') },
  { id: 'sun', name: 'Sol', category: 'Verano', size: 0.25, svg: () => svg(200, 200, `${Array.from({ length: 12 }, (_, i) => `<rect x="94" y="2" width="12" height="38" rx="6" fill="#ffb300" transform="rotate(${i * 30} 100 100)"/>`).join('')}<circle cx="100" cy="100" r="55" fill="#ffd400"/>`) },
  { id: 'palm', name: 'Palmera', category: 'Verano', size: 0.3, svg: () => svg(200, 240, '<path d="M100 90 Q115 160 95 235" stroke="#8a5a00" stroke-width="16" fill="none"/><path d="M100 90 Q60 40 10 70 Q60 60 100 90 Q140 40 190 70 Q140 60 100 90 Q90 20 40 15 Q90 40 100 90 Q115 25 165 20 Q115 45 100 90" fill="#2e9b4a"/>') },
  { id: 'snowflake', name: 'Copo de nieve', category: 'Invierno', size: 0.22, recolor: true, svg: (c = '#bfe6ff') => svg(200, 200, Array.from({ length: 6 }, (_, i) => `<g transform="rotate(${i * 60} 100 100)"><path d="M100 100 V15 M100 45 L80 30 M100 45 L120 30 M100 70 L82 58 M100 70 L118 58" stroke="${c}" stroke-width="9" stroke-linecap="round"/></g>`).join('')) },
  { id: 'music', name: 'Nota musical', category: 'Formas', size: 0.22, recolor: true, svg: (c = '#ffffff') => svg(180, 200, `<path d="M60 150 V30 L160 10 V130" stroke="${c}" stroke-width="12" fill="none"/><ellipse cx="45" cy="155" rx="28" ry="20" fill="${c}"/><ellipse cx="145" cy="135" rx="28" ry="20" fill="${c}"/>`) },
  { id: 'thumbs-up', name: 'Me gusta', category: 'Redes', size: 0.22, svg: () => svg(200, 200, '<circle cx="100" cy="100" r="92" fill="#1d6cff"/><path d="M60 95 H80 V150 H60Z M85 95 L105 50 Q120 45 118 70 L114 90 H145 Q158 92 154 108 L144 145 Q140 152 130 152 H85Z" fill="#fff"/>') },
  { id: 'subscribe', name: 'Suscribirse', category: 'Redes', size: 0.3, svg: () => svg(360, 110, '<rect x="5" y="5" width="350" height="100" rx="20" fill="#e62117"/><text x="180" y="72" font-family="Segoe UI, Arial" font-weight="800" font-size="46" text-anchor="middle" fill="#fff">SUSCRÍBETE</text>') },
  { id: 'bell', name: 'Campana', category: 'Redes', size: 0.2, svg: () => svg(200, 200, '<path d="M100 25 Q150 25 150 85 V125 L170 150 H30 L50 125 V85 Q50 25 100 25Z" fill="#ffc400"/><circle cx="100" cy="165" r="18" fill="#e0a100"/>') },
  { id: 'wow', name: '¡Guau!', category: 'Expresiones', size: 0.3, svg: () => burst('¡GUAU!', '#ffd400', '#d1001f') },
  { id: 'boom', name: '¡Bum!', category: 'Expresiones', size: 0.3, svg: () => burst('¡BUM!', '#ff6b1f', '#2b1300') },
  { id: 'ok', name: 'OK', category: 'Expresiones', size: 0.25, svg: () => burst('OK', '#36c48f', '#0b3d27') },
  { id: 'omg', name: '¡Dios mío!', category: 'Expresiones', size: 0.3, svg: () => burst('¡OMG!', '#ff8fb1', '#5a0020') },
  { id: 'thanks', name: 'Gracias', category: 'Expresiones', size: 0.3, svg: () => burst('GRACIAS', '#4aa3ff', '#002a5a') },
];

const arrowPath = (head: 'one' | 'two', thick: number) => {
  const t = thick / 2, hw = thick * 1.6, hl = thick * 2.2;
  const one = `M10 ${100 - t} H${290 - hl} V${100 - hw} L290 100 L${290 - hl} ${100 + hw} V${100 + t} H10Z`;
  const two = `M${10 + hl} ${100 - t} H${290 - hl} V${100 - hw} L290 100 L${290 - hl} ${100 + hw} V${100 + t} H${10 + hl} V${100 + hw} L10 100 L${10 + hl} ${100 - hw}Z`;
  return head === 'one' ? one : two;
};
const C = (id: string, name: string, category: string, body: (c: string) => string, size = 0.3): GraphicDef => ({ id, name, category, size, recolor: true, svg: (c = '#ff3b30') => body(c) });
export const CALLOUTS: GraphicDef[] = [
  C('arrow', 'Flecha', 'Flechas', (c) => svg(300, 200, `<path d="${arrowPath('one', 26)}" fill="${c}"/>`)),
  C('arrow-thin', 'Flecha delgada', 'Flechas', (c) => svg(300, 200, `<path d="${arrowPath('one', 12)}" fill="${c}"/>`)),
  C('arrow-thick', 'Flecha gruesa', 'Flechas', (c) => svg(300, 200, `<path d="${arrowPath('one', 44)}" fill="${c}"/>`)),
  C('arrow-double', 'Flecha de dos puntas', 'Flechas', (c) => svg(300, 200, `<path d="${arrowPath('two', 22)}" fill="${c}"/>`)),
  C('arrow-outline', 'Flecha (contorno)', 'Flechas', (c) => svg(300, 200, `<path d="${arrowPath('one', 34)}" fill="none" stroke="${c}" stroke-width="8" stroke-linejoin="round"/>`)),
  C('arrow-curved', 'Flecha curva', 'Flechas', (c) => svg(300, 220, `<path d="M20 190 Q40 40 230 60" stroke="${c}" stroke-width="18" fill="none" stroke-linecap="round"/><polygon points="215,20 290,62 220,105" fill="${c}"/>`)),
  C('rect', 'Rectángulo', 'Formas', (c) => svg(300, 200, `<rect x="8" y="8" width="284" height="184" fill="none" stroke="${c}" stroke-width="12"/>`)),
  C('rect-round', 'Rectángulo redondeado', 'Formas', (c) => svg(300, 200, `<rect x="8" y="8" width="284" height="184" rx="30" fill="none" stroke="${c}" stroke-width="12"/>`)),
  C('ellipse', 'Elipse', 'Formas', (c) => svg(300, 200, `<ellipse cx="150" cy="100" rx="140" ry="90" fill="none" stroke="${c}" stroke-width="12"/>`)),
  C('rect-fill', 'Rectángulo relleno', 'Formas', (c) => svg(300, 200, `<rect x="0" y="0" width="300" height="200" rx="16" fill="${c}" fill-opacity=".45"/>`)),
  C('ellipse-fill', 'Elipse rellena', 'Formas', (c) => svg(300, 200, `<ellipse cx="150" cy="100" rx="148" ry="98" fill="${c}" fill-opacity=".45"/>`)),
  C('triangle', 'Triángulo', 'Formas', (c) => svg(240, 210, `<polygon points="120,10 230,200 10,200" fill="none" stroke="${c}" stroke-width="12" stroke-linejoin="round"/>`), 0.25),
  C('hexagon', 'Hexágono', 'Formas', (c) => svg(240, 210, `<polygon points="60,8 180,8 235,105 180,202 60,202 5,105" fill="none" stroke="${c}" stroke-width="12"/>`), 0.25),
  C('circle', 'Círculo', 'Formas', (c) => svg(200, 200, `<circle cx="100" cy="100" r="90" fill="none" stroke="${c}" stroke-width="12"/>`), 0.25),
  C('check', 'Marca', 'Signos', (c) => svg(200, 200, `<path d="M25 105 L80 160 L180 40" stroke="${c}" stroke-width="28" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`), 0.2),
  C('cross', 'Cruz', 'Signos', (c) => svg(200, 200, `<path d="M35 35 L165 165 M165 35 L35 165" stroke="${c}" stroke-width="28" stroke-linecap="round"/>`), 0.2),
  C('info', 'Información', 'Signos', (c) => svg(200, 200, `<circle cx="100" cy="100" r="92" fill="${c}"/><circle cx="100" cy="55" r="14" fill="#fff"/><rect x="88" y="85" width="24" height="75" rx="10" fill="#fff"/>`), 0.2),
  C('question', 'Pregunta', 'Signos', (c) => svg(200, 200, `<circle cx="100" cy="100" r="92" fill="${c}"/><text x="100" y="142" font-family="Segoe UI, Arial" font-weight="900" font-size="120" text-anchor="middle" fill="#fff">?</text>`), 0.2),
  C('exclamation', 'Exclamación', 'Signos', (c) => svg(200, 200, `<circle cx="100" cy="100" r="92" fill="${c}"/><text x="100" y="142" font-family="Segoe UI, Arial" font-weight="900" font-size="120" text-anchor="middle" fill="#fff">!</text>`), 0.2),
  C('no-entry', 'Prohibido', 'Signos', (c) => svg(200, 200, `<circle cx="100" cy="100" r="85" fill="none" stroke="${c}" stroke-width="22"/><path d="M42 42 L158 158" stroke="${c}" stroke-width="22"/>`), 0.2),
  C('speech', 'Bocadillo', 'Notas', (c) => svg(300, 220, `<path d="M20 20 H280 V160 H110 L60 210 L70 160 H20Z" fill="#fff" stroke="${c}" stroke-width="8" stroke-linejoin="round"/>`)),
  C('note', 'Nota adhesiva', 'Notas', (c) => svg(240, 240, `<path d="M10 10 H230 V180 L180 230 H10Z" fill="${c === '#ff3b30' ? '#ffe66d' : c}"/><path d="M230 180 H180 V230" fill="#e0c440"/>`), 0.28),
];

// ───────────────────────────── clip tools ─────────────────────────────
export const MASKS: (CatalogItem & { shape: 'ellipse' | 'rect'; mode: 'black' | 'blur' | 'pixelate' | 'light' | 'bright' })[] = [
  { id: 'black-ellipse', name: 'Elipse negra', category: 'Esconder', shape: 'ellipse', mode: 'black' },
  { id: 'black-rect', name: 'Rectángulo negro', category: 'Esconder', shape: 'rect', mode: 'black' },
  { id: 'blur-ellipse', name: 'Elipse borrosa', category: 'Esconder', shape: 'ellipse', mode: 'blur' },
  { id: 'blur-rect', name: 'Rectángulo borroso', category: 'Esconder', shape: 'rect', mode: 'blur' },
  { id: 'pixel-ellipse', name: 'Elipse de píxeles', category: 'Esconder', shape: 'ellipse', mode: 'pixelate' },
  { id: 'pixel-rect', name: 'Rectángulo de píxeles', category: 'Esconder', shape: 'rect', mode: 'pixelate' },
  { id: 'light-ellipse', name: 'Elipse clara', category: 'Resaltar', shape: 'ellipse', mode: 'light' },
  { id: 'light-rect', name: 'Rectángulo claro', category: 'Resaltar', shape: 'rect', mode: 'light' },
  { id: 'bright-ellipse', name: 'Elipse brillante', category: 'Resaltar', shape: 'ellipse', mode: 'bright' },
  { id: 'bright-rect', name: 'Rectángulo brillante', category: 'Resaltar', shape: 'rect', mode: 'bright' },
];

/** Picture-in-picture layouts: transform of the overlay clip (center x, y; scale relative to fit). */
export const PIP_LAYOUTS: (CatalogItem & { x: number; y: number; scale: number; crop?: { x: number; y: number; w: number; h: number } })[] = [
  { id: 'overlay', name: 'Superposición', category: 'PiP', x: 0.78, y: 0.75, scale: 0.35 },
  { id: 'logo', name: 'Logotipo', category: 'PiP', x: 0.9, y: 0.1, scale: 0.14 },
  { id: 'side-left', name: 'Lado a lado - izquierda', category: 'PiP', x: 0.25, y: 0.5, scale: 1, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } },
  { id: 'side-right', name: 'Lado a lado - derecha', category: 'PiP', x: 0.75, y: 0.5, scale: 1, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } },
  { id: 'side-top', name: 'Lado a lado - arriba', category: 'PiP', x: 0.5, y: 0.25, scale: 1, crop: { x: 0, y: 0.25, w: 1, h: 0.5 } },
  { id: 'side-bottom', name: 'Lado a lado - abajo', category: 'PiP', x: 0.5, y: 0.75, scale: 1, crop: { x: 0, y: 0.25, w: 1, h: 0.5 } },
  { id: 'trio-left', name: 'Trío - izquierda', category: 'PiP', x: 0.167, y: 0.5, scale: 1, crop: { x: 0.333, y: 0, w: 0.333, h: 1 } },
  { id: 'trio-center', name: 'Trío - centro', category: 'PiP', x: 0.5, y: 0.5, scale: 1, crop: { x: 0.333, y: 0, w: 0.333, h: 1 } },
  { id: 'trio-right', name: 'Trío - derecha', category: 'PiP', x: 0.833, y: 0.5, scale: 1, crop: { x: 0.333, y: 0, w: 0.333, h: 1 } },
];

export const PAN_ZOOM: (CatalogItem & { from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number } })[] = [
  { id: 'zoom-in', name: 'Acercar', category: 'Zoom', from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: 1.4 } },
  { id: 'zoom-out', name: 'Alejar', category: 'Zoom', from: { x: 0.5, y: 0.5, zoom: 1.4 }, to: { x: 0.5, y: 0.5, zoom: 1 } },
  { id: 'pan-lr', name: 'De izquierda a derecha', category: 'Panorámica', from: { x: 0.35, y: 0.5, zoom: 1.3 }, to: { x: 0.65, y: 0.5, zoom: 1.3 } },
  { id: 'pan-rl', name: 'De derecha a izquierda', category: 'Panorámica', from: { x: 0.65, y: 0.5, zoom: 1.3 }, to: { x: 0.35, y: 0.5, zoom: 1.3 } },
  { id: 'pan-tb', name: 'De arriba a abajo', category: 'Panorámica', from: { x: 0.5, y: 0.35, zoom: 1.3 }, to: { x: 0.5, y: 0.65, zoom: 1.3 } },
  { id: 'pan-bt', name: 'De abajo a arriba', category: 'Panorámica', from: { x: 0.5, y: 0.65, zoom: 1.3 }, to: { x: 0.5, y: 0.35, zoom: 1.3 } },
  { id: 'zoom-in-lr', name: 'Acercar hacia la derecha', category: 'Zoom', from: { x: 0.4, y: 0.5, zoom: 1 }, to: { x: 0.6, y: 0.5, zoom: 1.5 } },
  { id: 'zoom-in-tl', name: 'Acercar arriba a la izquierda', category: 'Zoom', from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.35, y: 0.35, zoom: 1.6 } },
  { id: 'ken-burns', name: 'Ken Burns suave', category: 'Zoom', from: { x: 0.45, y: 0.55, zoom: 1.05 }, to: { x: 0.55, y: 0.45, zoom: 1.25 } },
];

/** Entry/exit animations of overlay clips (titles, stickers, PiP). */
export const ANIMATIONS: CatalogItem[] = [
  { id: 'fade', name: 'Fundido', category: 'Básicas' },
  { id: 'slide-left', name: 'Desde la izquierda', category: 'Deslizar' },
  { id: 'slide-right', name: 'Desde la derecha', category: 'Deslizar' },
  { id: 'slide-up', name: 'Desde abajo', category: 'Deslizar' },
  { id: 'slide-down', name: 'Desde arriba', category: 'Deslizar' },
  { id: 'zoom', name: 'Zoom', category: 'Zoom' },
  { id: 'pop', name: 'Rebote', category: 'Zoom' },
  { id: 'spin', name: 'Rotación', category: 'Rotación' },
  { id: 'drop', name: 'Caída', category: 'Deslizar' },
];

// ───────────────────────────── audio ─────────────────────────────
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS: (CatalogItem & { gains: number[] })[] = [
  { id: 'flat', name: 'Uniforme', category: 'EQ', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'voice', name: 'Mejora de voz', category: 'EQ', gains: [-8, -6, -3, 0, 2, 4, 5, 4, 2, 0] },
  { id: 'music', name: 'Mejora de música', category: 'EQ', gains: [3, 3, 1, 0, -1, 0, 1, 2, 3, 3] },
  { id: 'bass-boost', name: 'Graves - aumento', category: 'EQ', gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  { id: 'bass-cut', name: 'Graves - reducción', category: 'EQ', gains: [-8, -6, -4, -2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble-boost', name: 'Agudos - aumento', category: 'EQ', gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
  { id: 'treble-cut', name: 'Agudos - reducción', category: 'EQ', gains: [0, 0, 0, 0, 0, -1, -3, -5, -7, -8] },
  { id: 'hum', name: 'Reducción del zumbido', category: 'EQ', gains: [-12, -12, -4, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'loudness', name: 'Aumento del volumen', category: 'EQ', gains: [4, 3, 1, 0, 0, 0, 1, 2, 3, 3] },
  { id: 'small-speakers', name: 'Altavoces pequeños', category: 'EQ', gains: [-6, -4, 2, 4, 3, 1, 1, 2, 2, 1] },
  { id: 'acoustic', name: 'Acústica', category: 'EQ', gains: [4, 4, 3, 1, 1, 1, 2, 3, 3, 2] },
  { id: 'classical', name: 'Clásica', category: 'EQ', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  { id: 'dance', name: 'Dance', category: 'EQ', gains: [5, 7, 4, 0, 1, 3, 4, 4, 3, 0] },
  { id: 'deep', name: 'Profundo', category: 'EQ', gains: [5, 4, 2, 1, 3, 2, 1, -2, -4, -5] },
  { id: 'electronic', name: 'Electrónica', category: 'EQ', gains: [4, 4, 1, 0, -2, 2, 1, 1, 4, 5] },
  { id: 'hiphop', name: 'Hip-hop', category: 'EQ', gains: [5, 4, 1, 3, -1, -1, 1, -1, 2, 3] },
  { id: 'jazz', name: 'Jazz', category: 'EQ', gains: [4, 3, 1, 2, -2, -2, 0, 1, 3, 4] },
  { id: 'latin', name: 'Latina', category: 'EQ', gains: [4, 2, 0, 0, -2, -2, -2, 0, 3, 4] },
  { id: 'lounge', name: 'Lounge', category: 'EQ', gains: [-3, -1, 0, 1, 4, 3, 0, -2, 2, 1] },
  { id: 'piano', name: 'Piano', category: 'EQ', gains: [3, 2, 0, 2, 3, 1, 3, 4, 3, 3] },
  { id: 'pop', name: 'Pop', category: 'EQ', gains: [-1, -1, 0, 2, 4, 4, 2, 0, -1, -2] },
  { id: 'rnb', name: 'R&B', category: 'EQ', gains: [3, 7, 6, 1, -2, -1, 2, 3, 3, 4] },
  { id: 'rock', name: 'Rock', category: 'EQ', gains: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5] },
];

export const AUDIO_EFFECTS: (CatalogItem & { chain: string })[] = [
  { id: 'echo', name: 'Eco', category: 'Efectos', chain: 'aecho=0.8:0.85:350|700:0.45|0.25' },
  { id: 'muffled', name: 'Apagado', category: 'Efectos', chain: 'lowpass=f=900,lowpass=f=900' },
  { id: 'tremolo', name: 'Oscilación', category: 'Efectos', chain: 'tremolo=f=6:d=0.7' },
  { id: 'overdrive', name: 'Sobrecarga', category: 'Efectos', chain: 'volume=6,alimiter=limit=0.5,acrusher=bits=8:mix=0.4' },
  { id: 'phone', name: 'Teléfono', category: 'Efectos', chain: 'highpass=f=400,lowpass=f=3200,acrusher=bits=10:mix=0.3' },
  { id: 'radio', name: 'Radio', category: 'Efectos', chain: 'highpass=f=250,lowpass=f=5000,acompressor=threshold=0.1:ratio=6,volume=1.6' },
  { id: 'robot', name: 'Robot', category: 'Efectos', chain: "afftfilt=real='hypot(re\\,im)*sin(0)':imag='hypot(re\\,im)*cos(0)':win_size=512:overlap=0.75" },
  { id: 'vibrato', name: 'Vibrato', category: 'Efectos', chain: 'vibrato=f=7:d=0.6' },
  { id: 'pitch-high', name: 'Tono alto', category: 'Tono', chain: 'rubberband=pitch=1.26' },
  { id: 'pitch-very-high', name: 'Tono muy alto', category: 'Tono', chain: 'rubberband=pitch=1.6' },
  { id: 'pitch-low', name: 'Tono bajo', category: 'Tono', chain: 'rubberband=pitch=0.8' },
  { id: 'pitch-very-low', name: 'Tono muy bajo', category: 'Tono', chain: 'rubberband=pitch=0.6' },
];

export const AUDIO_ENHANCE: Record<'studio' | 'noisy' | 'voice', { name: string; chain: string }> = {
  studio: { name: 'Estudio de grabación', chain: 'highpass=f=70,afftdn=nf=-30,acompressor=threshold=0.125:ratio=3:attack=10:release=150,equalizer=f=3000:t=q:w=1:g=2' },
  noisy: { name: 'Lugar ruidoso', chain: 'highpass=f=120,afftdn=nf=-20:nr=20,agate=threshold=0.02:range=0.1,acompressor=threshold=0.1:ratio=4' },
  voice: { name: 'Grabación de voz mejorada', chain: 'highpass=f=90,afftdn=nf=-25,equalizer=f=200:t=q:w=1:g=-3,equalizer=f=4000:t=q:w=1:g=4,acompressor=threshold=0.1:ratio=3,dynaudnorm=f=200' },
};

// ───────────────────────────── export presets ─────────────────────────────
export interface ExportPreset extends CatalogItem {
  ext: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  audioOnly?: boolean;
  gif?: boolean;
  extra?: string[];
}
const V = (id: string, name: string, category: string, ext: string, vcodec: string, acodec: string, extra: Partial<ExportPreset> = {}): ExportPreset => ({ id, name, category, ext, vcodec, acodec, ...extra });
export const EXPORT_PRESETS: ExportPreset[] = [
  V('mp4', 'MP4 (H.264)', 'Vídeo', 'mp4', 'libx264', 'aac'),
  V('mp4-hevc', 'MP4 (H.265/HEVC)', 'Vídeo', 'mp4', 'libx265', 'aac', { extra: ['-tag:v', 'hvc1'] }),
  V('mkv', 'MKV', 'Vídeo', 'mkv', 'libx264', 'aac'),
  V('mov', 'MOV', 'Vídeo', 'mov', 'libx264', 'aac'),
  V('avi', 'AVI', 'Vídeo', 'avi', 'mpeg4', 'libmp3lame', { extra: ['-vtag', 'XVID'] }),
  V('wmv', 'WMV', 'Vídeo', 'wmv', 'wmv2', 'wmav2'),
  V('flv', 'FLV', 'Vídeo', 'flv', 'libx264', 'aac'),
  V('webm', 'WebM (VP9)', 'Vídeo', 'webm', 'libvpx-vp9', 'libopus'),
  V('mpeg2', 'MPEG-2', 'Vídeo', 'mpg', 'mpeg2video', 'mp2'),
  V('mpeg1', 'MPEG-1', 'Vídeo', 'mpg', 'mpeg1video', 'mp2'),
  V('m2ts', 'M2TS (H.264)', 'Vídeo', 'm2ts', 'libx264', 'ac3'),
  V('ogv', 'OGV', 'Vídeo', 'ogv', 'libtheora', 'libvorbis'),
  { id: 'gif', name: 'GIF animado', category: 'Vídeo', ext: 'gif', gif: true },
  V('mp4-1080p', 'MP4 Full HD 1080p', 'Web', 'mp4', 'libx264', 'aac', { width: 1920, height: 1080 }),
  V('mp4-720p', 'MP4 HD 720p', 'Web', 'mp4', 'libx264', 'aac', { width: 1280, height: 720 }),
  V('mp4-4k', 'MP4 4K', 'Web', 'mp4', 'libx264', 'aac', { width: 3840, height: 2160 }),
  V('youtube', 'YouTube 1080p', 'Web', 'mp4', 'libx264', 'aac', { width: 1920, height: 1080 }),
  V('shorts', 'Shorts / Reels / TikTok (9:16)', 'Web', 'mp4', 'libx264', 'aac', { width: 1080, height: 1920 }),
  V('instagram-square', 'Instagram cuadrado (1:1)', 'Web', 'mp4', 'libx264', 'aac', { width: 1080, height: 1080 }),
  V('instagram-portrait', 'Instagram vertical (4:5)', 'Web', 'mp4', 'libx264', 'aac', { width: 1080, height: 1350 }),
  V('phone', 'Teléfono móvil', 'Dispositivos', 'mp4', 'libx264', 'aac', { width: 1920, height: 1080, extra: ['-profile:v', 'high', '-level', '4.1'] }),
  V('tablet', 'Tableta', 'Dispositivos', 'mp4', 'libx264', 'aac', { width: 2048, height: 1152 }),
  V('tv-1080p', 'TV 1080p', 'TV', 'mp4', 'libx264', 'aac', { width: 1920, height: 1080 }),
  V('tv-4k', 'TV 4K', 'TV', 'mp4', 'libx265', 'aac', { width: 3840, height: 2160, extra: ['-tag:v', 'hvc1'] }),
  { id: 'mp3', name: 'MP3', category: 'Audio', ext: 'mp3', acodec: 'libmp3lame', audioOnly: true },
  { id: 'aac', name: 'AAC (M4A)', category: 'Audio', ext: 'm4a', acodec: 'aac', audioOnly: true },
  { id: 'wav', name: 'WAV', category: 'Audio', ext: 'wav', acodec: 'pcm_s16le', audioOnly: true },
  { id: 'flac', name: 'FLAC', category: 'Audio', ext: 'flac', acodec: 'flac', audioOnly: true },
  { id: 'ogg', name: 'OGG', category: 'Audio', ext: 'ogg', acodec: 'libvorbis', audioOnly: true },
  { id: 'wma', name: 'WMA', category: 'Audio', ext: 'wma', acodec: 'wmav2', audioOnly: true },
];

export const QUALITY = { draft: { crf: 30, preset: 'ultrafast', abr: '96k' }, good: { crf: 23, preset: 'medium', abr: '160k' }, high: { crf: 18, preset: 'slow', abr: '256k' } } as const;
export type Quality = keyof typeof QUALITY;

export const ASPECTS: (CatalogItem & { width: number; height: number })[] = [
  { id: '16:9', name: 'Panorámico (YouTube, TV)', category: 'Aspecto', width: 1920, height: 1080 },
  { id: '9:16', name: 'Historia/TikTok', category: 'Aspecto', width: 1080, height: 1920 },
  { id: '1:1', name: 'Cuadrado', category: 'Aspecto', width: 1080, height: 1080 },
  { id: '4:5', name: 'Publicación de Instagram/Facebook', category: 'Aspecto', width: 1080, height: 1350 },
  { id: '4:3', name: 'Clásico 4:3', category: 'Aspecto', width: 1440, height: 1080 },
  { id: '21:9', name: 'Cine 21:9', category: 'Aspecto', width: 2560, height: 1080 },
];

export const findIn = <K extends CatalogItem>(list: K[], id: string, what: string): K => {
  const hit = list.find((x) => x.id === id) ?? list.find((x) => x.name.toLowerCase() === id.toLowerCase());
  if (!hit) throw new Error(`${what} desconocido: «${id}». Disponibles: ${list.map((x) => x.id).join(', ')}`);
  return hit;
};
