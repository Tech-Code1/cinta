# Especificación (delta) — editor

Cada requisito se cumple en la interfaz y por MCP; las pruebas e2e verifican el resultado por contenido.

## R1 Proyecto
- R1.1 Crear, abrir, guardar, guardar como, recientes, guardar portátil (copia medios), adjuntar otro proyecto.
- R1.2 Configuración: resolución (presets 16:9, 9:16, 1:1, 4:5, 4:3, personalizada), fps, frecuencia de muestreo.
- R1.3 Al añadir el primer archivo con otra relación de aspecto se ofrece adaptar el proyecto.
- R1.4 Archivos que faltan: aviso y reubicación.
**Escenario**: `project_new {width:1080,height:1920}` → `project_get` devuelve 1080×1920; exportar da un MP4 de 1080×1920.

## R2 Importar
- R2.1 Archivos y carpetas de vídeo, audio e imagen; arrastrar y soltar; contenedor de medios con miniaturas.
- R2.2 Fondos de color y degradado, música y efectos de sonido generados.
- R2.3 Asistente de presentación (fotos + transiciones + música).
**Escenario**: `media_import` de 2 vídeos y 1 imagen → `media_list` con duraciones correctas (±0,05 s).

## R3 Línea de tiempo
- R3.1 Pista principal magnética, pistas superpuestas, de títulos y de audio; añadir/quitar; ocultar, silenciar,
  bloquear, permitir huecos.
- R3.2 Dividir, recortar, mover, duplicar (clonar), copiar/pegar, eliminar con rizo, separar audio, fotograma fijo.
- R3.3 Marcadores; deshacer/rehacer ilimitado en la sesión.
- R3.4 Detectar escenas y compases.
**Escenario**: clip de 10 s → `clip_split` a 4 s → dos clips 4 s + 6 s; `clip_delete` del primero → duración 6 s;
`undo` → 10 s.

## R4 Clip
- R4.1 Velocidad 0,1–10× con/sin tono original, invertir, volumen, normalizar, fundidos, opacidad.
- R4.2 Rotar 90°, voltear, recortar, enderezar.
- R4.3 Color: presets automáticos, manual, LUT `.cube`; filtros del catálogo con intensidad.
- R4.4 Estabilización, clave de croma, PiP, logotipo, panorámica y zoom, máscaras resaltar/esconder,
  animaciones y fotogramas clave, sincronizar audio.
**Escenario**: clip rojo con `clip_chroma {color:"#ff0000"}` sobre fondo azul → el fotograma es azul.

## R5 Transiciones, títulos, adhesivos y llamadas
- R5.1 Catálogo de transiciones por categorías, duración, aplicar a todos, asistente aleatorio.
- R5.2 Títulos con estilos, edición completa del texto y animación; temporizador; créditos que se desplazan.
- R5.3 Adhesivos y llamadas propios con color y animación.
**Escenario**: dos clips de 3 s con transición de 1 s → exportación de 5 s; título «HOLA» → OCR/píxeles muestran texto.

## R6 Audio
- R6.1 Pistas de música/voz, grabar voz, EQ, compresor, puerta, reverberación, quitar ruido, mejora, efectos.
- R6.2 Ducking de música bajo la voz.
**Escenario**: música + voz con ducking → la sonoridad de la música durante la voz baja ≥ 6 dB.

## R7 Exportación
- R7.1 Vídeo (MP4, MKV, MOV, AVI, WMV, FLV, WebM, MPEG-2, M2TS, OGV, GIF), audio (MP3, AAC, WAV, FLAC, OGG, WMA).
- R7.2 Calidad borrador/buena/alta/personalizada, resolución, fps, códec, tasa de bits CBR/VBR, preset del códec.
- R7.3 Presets de dispositivos y redes (YouTube, TikTok/Reels 9:16, Instagram 1:1/4:5, TV 1080p/4K, móvil).
- R7.4 Exportar selección, instantánea, progreso y cancelación.
**Escenario**: `export {preset:"mp4-1080p"}` → H.264/AAC, 1920×1080, duración = la del proyecto (±0,1 s).

## R8 Automatización (MCP)
- R8.1 Quitar silencios; R8.2 subtítulos automáticos (+ SRT ida y vuelta); R8.3 reencuadre 9:16/1:1/4:5;
  R8.4 música con ducking; R8.5 unir archivos; R8.6 exportar MLT; R8.7 fotograma de vista previa.
**Escenario**: vídeo con 2 s de silencio en medio → `remove_silences` → duración menor en ≈ 2 s.

## R9 Interfaz
- R9.1 Disposición de Movavi (riel 56 px, categorías 176 px, colección, reproductor, barra 24 px, línea de tiempo,
  medidor de nivel, barra de estado), en español, iconos propios.
- R9.2 Atajos de teclado de Movavi (Ctrl+N/O/S, Ctrl+Z/Y, Ctrl+B dividir, Espacio, ←/→ fotograma, Supr…).
- R9.3 La app recarga el proyecto si el MCP lo modifica.
