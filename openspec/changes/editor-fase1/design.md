# Diseño técnico — Cinta fase 1

## Arquitectura

```
src/core/      Node puro (sin Electron): lo usan la app, el MCP y las pruebas
  model.ts       tipos del proyecto .cinta, valores por defecto, validación, empaquetado de la pista principal
  ops.ts         Editor: operaciones con deshacer/rehacer (historial de instantáneas JSON)
  catalog.ts     filtros, transiciones, títulos, adhesivos, llamadas, máscaras, PiP, panorámica, animaciones,
                 audio (EQ, efectos, mejora), presets de exportación — todo propio
  ffmpeg.ts      rutas de ffmpeg/ffprobe (asar.unpacked), ejecutar con progreso y cancelación
  probe.ts       ffprobe → MediaItem
  render.ts      compilador Project → argumentos de ffmpeg (filter_complex) para exportar, vista previa y fotograma
  ass.ts         títulos y subtítulos → archivo ASS (libass)
  graphics.ts    adhesivos y llamadas SVG propios → PNG (resvg)
  analysis.ts    silencios, escenas, ritmo, sincronización de audio, estabilización (vid.stab), forma de onda
  speech.ts      subtítulos automáticos (sherpa-onnx + Whisper + VAD Silero)
  srt.ts, mlt.ts SRT de ida y vuelta; exportación MLT XML
  automate.ts    quitar silencios, reencuadre, ducking, unir archivos, slideshow
src/mcp/       servidor MCP stdio (zod) → core; escribe el proyecto de forma atómica
src/main/      Electron: ventana, menús, IPC, vista previa, vigilancia del archivo del proyecto
src/renderer/  interfaz (TS sin framework): riel, colección, reproductor, barra, línea de tiempo, paneles
```

## Modelo del proyecto (`.cinta`, JSON)

- `settings`: `width`, `height`, `fps`, `sampleRate`, `background`.
- `media[]`: contenedor de medios (ruta absoluta, tipo, duración, dimensiones, audio sí/no).
- `tracks[]` de arriba abajo: `title` · `overlay` · `main` (una, magnética) · `audio`. Cada una: `hidden`, `muted`,
  `locked`, `gaps` (permitir huecos).
- `clips[]`: `trackId`, `type` (`video|image|audio|color|title|sticker|callout`), `start` (s en la línea de tiempo),
  `in`/`out` (s del origen), `speed`, `reverse`, `keepPitch`, `volume`, `fadeIn`/`fadeOut`, `opacity`, rotación,
  volteo, recorte, color, `filters[]`, `audio{}`, `transform`, `chroma`, `stabilize`, `panZoom`, `mask`,
  `animIn`/`animOut`, `keyframes[]`, `transition` (hacia el siguiente clip de la pista principal), `title{}`,
  `sticker{}`, `callout{}`.
- `markers[]`.
- Duración del clip en la línea de tiempo = `(out − in) / speed`.
- Pista principal sin huecos: `start[i] = fin[i−1] − transición[i−1]` (las transiciones solapan, como en Movavi).

## Compositor (render.ts)

Un `filter_complex` por render:
1. Una entrada por clip con `-ss/-t` (búsqueda rápida); imágenes con `-loop 1`; color/títulos con `lavfi`.
2. Cadena de vídeo por clip: velocidad (`setpts`), invertir, recortar, rotar/voltear, enderezar, estabilizar
   (`vidstabtransform` con el `.trf` calculado), color (`eq`, `colorbalance`, `colortemperature`, `lut3d`), filtros
   del catálogo, encaje en el lienzo (`scale` + `pad`), panorámica y zoom, máscara, fundidos, `fps`/`format`/`settb`.
3. Pista principal: `xfade` entre clips con transición; `concat` para cortes; huecos con color de fondo.
4. Pistas superpuestas en orden: `overlay` con `enable='between(t,a,b)'`, posición/escala/rotación/opacidad,
   clave de croma (`chromakey`), PiP, animaciones (expresiones en `overlay x/y` y `fade` alfa), fotogramas clave.
5. Adhesivos y llamadas: PNG rasterizados por resvg como entradas `-loop 1` superpuestas.
6. Títulos y subtítulos: un único filtro `ass` al final.
7. Audio: cada clip con audio → `atempo`/`asetrate` (velocidad y tono), `areverse`, volumen y envolvente, fundidos,
   EQ, compresor, puerta, reverberación, ruido, efectos → `adelay` a su posición → `amix`. Música con ducking:
   `sidechaincompress` usando la mezcla de voz como clave. `loudnorm` opcional.
8. Rango (`from`, `to`): cada clip se recorta a la intersección y todo se desplaza a −`from` (exportar selección,
   vista previa desde el cursor, fotograma suelto).

Salidas: exportar (preset → códecs/contenedor/calidad), fotograma PNG (`-frames:v 1`), vista previa fMP4
fragmentado por tubería (`-movflags frag_keyframe+empty_moov+default_base_moof`) que el reproductor alimenta a
MediaSource.

## MCP

- Servidor stdio sin interfaz (Electron como Node: `ELECTRON_RUN_AS_NODE=1 Cinta.exe dist/main/mcp.js`).
- Cada herramienta recibe `project` (ruta `.cinta`), carga, opera con `Editor`, guarda de forma atómica
  (escritura a `.tmp` + `rename`) y devuelve el estado resumido. Deshacer/rehacer persiste en `<proyecto>.history`.
- La app vigila el archivo abierto (`fs.watch`) y recarga si cambió desde fuera.
- Registro en Claude Desktop/Code como en Shot (instalado: automático; portable/dev: botón en Preferencias).

## Decisiones

| Decisión | Alternativa descartada | Motivo |
| --- | --- | --- |
| Un compositor ffmpeg para todo | Compositor WebGL en el renderer | Lo que se ve = lo que se exporta = lo que hace el MCP; menos código duplicado |
| ASS/libass para textos | `drawtext` | Contorno, sombra, fondo, animaciones, multilínea y acentos sin trabajo extra |
| resvg para gráficos | Canvas de Electron | Funciona en el MCP sin ventana |
| sherpa-onnx-node | Python del kit | Sin instalar Python; mismo modelo Whisper y VAD Silero que el kit |
| JSON propio + MLT | MLT como formato nativo | Modelo simple para la IA; MLT sigue disponible para Shotcut/Kdenlive |
