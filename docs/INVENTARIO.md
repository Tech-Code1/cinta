# Inventario de funciones — Movavi Video Suite 22 «Editar vídeo» → Cinta

Fuente (método: pregunta → observar el programa → recrear y verificar):

- La aplicación en marcha: textos de la interfaz en español (transiciones, títulos, adhesivos, llamadas, efectos,
  máscaras, panorámica, PiP, animaciones, efectos de audio, presets de exportación), distribución, colores y
  medidas de la ventana principal, la barra de herramientas y el reproductor.

No se copia nada propietario: ni iconos, ni imágenes, ni fuentes, ni vídeos de muestra, ni música, ni nombre o
logotipo. Los catálogos de Cinta son propios (efectos generados con filtros de ffmpeg, adhesivos dibujados en SVG
propio, títulos con estilos propios); solo se replica la función y el flujo de trabajo.

Leyenda: **F1** = fase 1 (clon funcional) · **F2** = fase 2 (mejora) · **—** = fuera de alcance (servicios de
Movavi: tienda, cuenta, nube).

## 1. Ventana principal y flujo

| Movavi | Cinta | MCP | Fase |
| --- | --- | --- | --- |
| Riel de iconos: Importar, Filtros, Transiciones, Títulos, Adhesivos, Más herramientas | Igual (+ Llamadas dentro de Adhesivos) | `catalog_list` | F1 |
| Lista de categorías + colección con miniaturas + búsqueda + favoritos (corazón) | Igual; miniaturas generadas por Cinta | `catalog_list` | F1 |
| Reproductor: código de tiempo con ms, clip/fotograma anterior/siguiente, reproducir, 16:9 (relación de aspecto), volumen de vista previa, instantánea, ⋮ (alta/baja resolución, pantalla completa) | Igual | `project_set` (aspecto), `snapshot`, `preview_frame` | F1 |
| Barra de edición: deshacer, rehacer, eliminar · dividir, rotar, recortar, ajustes de color, propiedades del clip · asistente de transiciones, marcador · grabar vídeo, grabar voz · zoom − + · Exportar ▾ | Igual (grabar vídeo abre Shot si está instalado) | `undo`, `redo`, `clip_delete`, `clip_split`, `clip_set`, `transition_wizard`, `marker_add`, `voiceover_add` | F1 |
| Barra de estado «Duración del proyecto» | Igual | `project_get` | F1 |
| Menús Archivo / Editar / Reproducción / Configuración / Exportar / Ayuda | Igual (sin tienda ni cuenta) | — | F1 |
| Proyecto nuevo, abrir, guardar, guardar como, proyectos recientes | `.cinta` (JSON) | `project_new`, `project_open`, `project_save` | F1 |
| Guardar proyecto portátil (copia los medios a una carpeta) | Igual | `project_save` `{portable:true}` | F1 |
| Adjuntar proyecto (insertar otro proyecto) | Igual | `project_append` | F1 |
| Archivos que faltan → reubicar | Igual | `project_relink` | F1 |
| Ajustar el proyecto a la relación de aspecto del primer archivo (diálogo) | Igual | `project_set` | F1 |
| Configuración del proyecto: resolución, personalizada, mantener relación | Igual + fps y frecuencia de muestreo | `project_set` | F1 |
| Métodos abreviados de teclado | Igual (tabla en Ayuda) | — | F1 |
| Tutorial / proyecto de muestra / Effects Store / cuenta / Movavi Cloud | — | — | — |

## 2. Importar

| Movavi | Cinta | MCP | Fase |
| --- | --- | --- | --- |
| Añadir archivos, añadir carpeta, arrastrar y soltar | Igual | `media_import` | F1 |
| Contenedor de medios (bin) | Igual | `media_list` | F1 |
| Sonidos, Música, Vídeos de archivo, Fondos (contenido de Movavi) | Fondos de color/degradado propios, música y efectos de sonido **sintetizados por Cinta** | `media_generate` | F1 |
| Grabar vídeo (webcam), grabar pantalla, grabar audio | Grabar voz en F1 (micrófono, en la app); pantalla → Shot | `voiceover_add` (archivo) | F1 |
| Slideshow / asistente de montaje (fotos + música + transiciones) | Igual | `slideshow_create` | F1 |

## 3. Línea de tiempo

| Movavi | Cinta | MCP | Fase |
| --- | --- | --- | --- |
| Pista de vídeo principal magnética (audio vinculado debajo) | Igual | `clip_add` | F1 |
| Pistas extra de vídeo (superpuesto), de título, de audio/música; «Añadir pista» | Igual | `track_add`, `track_remove` | F1 |
| Ocultar / mostrar pista, silenciar pista, vincular/desvincular pista | Igual | `track_set` | F1 |
| Habilitar espacio vacío en la pista (desactivar magnetismo) | Igual | `track_set {gaps}` | F1 |
| Eliminación de rizo / eliminar espacio vacío / todos | Igual | `timeline_close_gaps` | F1 |
| Dividir en la posición actual | Igual | `clip_split` | F1 |
| Recortar bordes arrastrando (trim) | Igual | `clip_trim` | F1 |
| Mover, copiar, cortar, pegar, clonar, eliminar, seleccionar todo | Igual | `clip_move`, `clip_duplicate`, `clip_delete` | F1 |
| Separar audio | Igual | `clip_detach_audio` | F1 |
| Silenciar clip, ocultar clip | Igual | `clip_set {mute, hidden}` | F1 |
| Insertar fotograma fijo | Igual | `clip_freeze_frame` | F1 |
| Puntos de volumen (envolvente) | Igual (fotogramas clave de volumen) | `clip_set {volumeKeys}` | F1 |
| Marcadores: añadir, renombrar, eliminar, todos | Igual | `marker_add`, `marker_remove` | F1 |
| Fotogramas clave (copiar, pegar, eliminar) | Animación por fotogramas clave de posición/escala/rotación/opacidad | `clip_keyframe` | F1 |
| Información del archivo, mostrar en carpeta | Igual | `media_info` | F1 |
| Zoom de la escala de tiempo, ajustar a la ventana | Igual | — | F1 |
| Exportar selección | Igual | `export {range}` | F1 |
| Detectar escenas (divide el clip) | Igual (`scdet`) | `detect_scenes` | F1 |
| Detectar compases de audio (marcadores de ritmo) | Igual (detección de inicios en PCM) | `detect_beats` | F1 |

## 4. Edición del clip

| Movavi | Cinta | MCP | Fase |
| --- | --- | --- | --- |
| Propiedades del clip: duración, velocidad, invertir, tono original, volumen, normalizar, fundido de entrada/salida, opacidad | Igual | `clip_set` | F1 |
| Rotar 90° | Igual | `clip_set {rotate}` | F1 |
| Recortar y girar (enderezar) | Igual | `clip_set {crop, straighten}` | F1 |
| Ajustes de color: presets (contraste automático, saturación automática, balance de blancos, mejora mágica), modo manual (brillo, contraste, saturación, tono, temperatura, matiz, exposición, sombras/luces, nitidez), LUT `.cube` | Igual | `clip_color` | F1 |
| Efectos aplicados (lista, intensidad, activar/desactivar, quitar) | Igual | `clip_filter_add`, `clip_filter_set`, `clip_filter_remove` | F1 |
| Cámara lenta / tono original | Igual (velocidad 0.1×–10×) | `clip_set {speed}` | F1 |
| Estabilización (precisión, sacudida, radio, recorte de bordes) | Igual (vid.stab) | `clip_stabilize` | F1 |
| Clave de croma (color, tolerancia, ruido, bordes, opacidad) | Igual | `clip_chroma` | F1 |
| Imagen en imagen: superposición, logotipo, lado a lado, trío | Igual | `clip_pip` | F1 |
| Añadir logotipo a todo el vídeo | Igual | `logo_add` | F1 |
| Panorámica y zoom (plantillas y manual) | Igual | `clip_pan_zoom` | F1 |
| Resaltar y esconder (máscaras: negra, borrosa, píxeles, clara, brillante; tamaño, contorno, difuminado, opacidad) | Igual (estática y con seguimiento simple) | `clip_mask` | F1 |
| Rastreo de movimiento (títulos/adhesivos siguen un objeto) | Seguimiento por correlación de plantilla | `track_motion` | F2 |
| Animación (plantillas de entrada/salida + fotogramas clave) | Igual | `clip_animate`, `clip_keyframe` | F1 |
| Sincronizar audio de dos clips | Igual (correlación cruzada) | `sync_audio` | F1 |

## 5. Filtros (efectos de vídeo) — 180 en Movavi, por categorías

Categorías de Movavi: Ajustes, Artísticos, Básicos, Desenfoques, Bokeh/Luces, Fugas de luz, Películas/Retro,
Ruido, Mosaico/Píxeles, Semitono, Pop art, Ondulación/Deformación, Reflejar/Voltear, Viñeta, Marcos, Objetos
volando (partículas), Glitch/VHS/TV de tubo, Inclinación-desplazamiento.
Cinta: catálogo propio de ~70 filtros con las mismas categorías hechos con filtros de ffmpeg (eq, hue,
colorbalance, curves, gblur, boxblur, unsharp, noise, pixelize/scale, edgedetect, negate, vignette, lenscorrection,
hflip/vflip, tile, chromashift, rgbashift, lagfun, tmix, geq…) e intensidad 0–100 %. `catalog_list {kind:"filters"}`,
`clip_filter_add`. **F1**. Partículas (corazones, nieve…) con adhesivos propios animados: **F2**.

## 6. Transiciones — 105 en Movavi

Categorías: Fundidos, Desenfoques, Círculo, Bloques, Geométrico, Ondulación, Deformación, Borrado, Zoom,
Desplazamiento (empuje/deslizar), Paralaje, Artísticos, Con sonido.
Cinta: las 50+ transiciones de `xfade` de ffmpeg (fade, fadeblack, fadewhite, dissolve, wipe*, slide*, smooth*,
circleopen/close, circlecrop, rectcrop, radial, pixelize, hblur, zoomin, squeeze*, diag*, hl/hr/vu/vd slices,
cover*, reveal*, distance, fadegrays, wind*) agrupadas en esas categorías. Duración, «aplicar a todos», rellenar
con contenido recortado / fotograma fijo. Asistente: aleatorias / una para todas + duración de fotos.
`transition_set`, `transition_wizard`. **F1**.

## 7. Títulos — 73 estilos en Movavi

Categorías: Básicos, Tercio inferior, Notas al pie, Globos, Créditos, Desplazamiento, Temporizador (cuenta atrás),
Máquina de escribir, Subtítulos con fondo. Editor: texto multilínea, fuente, tamaño, negrita/cursiva, alineación,
color, contorno, sombra, fondo, posición/escala en el reproductor, velocidad de animación, duración, guardar
estilo propio. Cinta: estilos propios renderizados con libass (ASS) — mismas funciones. `title_add`, `title_set`,
`catalog_list {kind:"titles"}`. **F1**.

## 8. Adhesivos y llamadas

Adhesivos (130, temas: emoji, negocios, educación, amor, verano, viajes…) y llamadas (46: flechas, formas, notas,
contornos, animadas). Cinta: ~40 adhesivos y ~20 llamadas dibujados en SVG propio, color y contorno editables,
animación de entrada/salida. `sticker_add`, `callout_add`. **F1**.

## 9. Audio

| Movavi | Cinta | MCP | Fase |
| --- | --- | --- | --- |
| Volumen, silenciar, fundidos, normalizar | Igual | `clip_set` | F1 |
| Ecualizador (10 bandas, 20 presets, guardar preset) | Igual (`superequalizer`) | `clip_audio {eq}` | F1 |
| Compresor, puerta de ruido, reverberación, eliminación de ruido | Igual (`acompressor`, `agate`, `aecho`, `afftdn`) | `clip_audio` | F1 |
| Autocorrección de sonido (estudio, lugar ruidoso, voz mejorada) | Igual (cadenas de filtros) | `clip_audio {enhance}` | F1 |
| Efectos de audio: eco, apagado, oscilación, sobrecarga, teléfono, tonos, radio, robot, vibrato | Igual | `clip_audio {effect}` | F1 |
| Grabar voz en off desde la posición actual | Igual | `voiceover_add` | F1 |
| Detección de ritmo | Igual | `detect_beats` | F1 |

## 10. Exportación

| Movavi | Cinta | MCP | Fase |
| --- | --- | --- | --- |
| Guardar archivo de vídeo: MP4, AVI, MOV, MKV, WMV, FLV, WebM, MPEG-1/2, M2TS, OGV, GIF | Igual (SWF, DVD: —) | `export` | F1 |
| Guardar solo audio: MP3, AAC, WAV, FLAC, OGG, WMA | Igual | `export` | F1 |
| Para dispositivos (iPhone, iPad, Android…) y TV (1080p, 4K) | Presets genéricos sin marcas | `export {preset}` | F1 |
| Calidad borrador / buena / alta / personalizada; resolución; fps; códec; CBR/VBR; velocidad del códec; dos pasos | Igual | `export` | F1 |
| Subir a YouTube / Vimeo / Google Drive / Movavi Cloud | — | — | — |
| Exportar selección | Igual | `export {range}` | F1 |
| Instantánea del fotograma | Igual | `snapshot` | F1 |

## 11. Más allá de Movavi (pedido: automatización con IA) — F1 por MCP

| Función | MCP |
| --- | --- |
| Quitar silencios / pausas (umbral, margen, duración mínima) | `remove_silences` |
| Subtítulos automáticos (Whisper local con sherpa-onnx, sin internet) → pista de títulos o `.srt` | `auto_subtitles` |
| Importar / exportar `.srt` | `subtitles_import`, `subtitles_export` |
| Reencuadre a 9:16 / 1:1 / 4:5 (relleno desenfocado o recorte centrado) | `reframe` |
| Música con atenuación automática bajo la voz (ducking) | `music_add {duck:true}` |
| Normalización de sonoridad a −14 LUFS (redes) | `export {loudnorm}` |
| Unir varios archivos en uno | `join_files` |
| Exportar a Shotcut/Kdenlive (MLT XML) | `export_mlt` |
| Vista previa de un fotograma como imagen | `preview_frame` |
