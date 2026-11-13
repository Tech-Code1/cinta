# Cinta

Editor de vídeo para Windows, portable e instalable, con **servidor MCP** para que una IA (Claude, Cursor…)
edite vídeos. Software libre (GPL v3), gratis para usar y compartir. Es un clon funcional del flujo de trabajo de **Movavi Video Suite 22 → «Editar vídeo»**: la misma
disposición (riel de iconos, categorías, colección, reproductor, barra de edición, línea de tiempo magnética,
medidor de nivel y barra de estado), los mismos paneles y las mismas funciones, hechas con nombre, iconos,
adhesivos, títulos, música y efectos propios. No incluye ningún recurso de Movavi.

El inventario completo de funciones (Movavi → Cinta → herramienta MCP) está en
[docs/INVENTARIO.md](docs/INVENTARIO.md); la planificación SDD en [openspec/](openspec/changes/editor-fase1/).

## Uso

| Acción | Cómo |
| --- | --- |
| Importar | Panel **Importar** → *Añadir archivos* o arrastrar archivos/carpetas; `Ctrl+I` |
| Poner en la línea de tiempo | Doble clic o «+» en el contenedor de medios, o arrastrar a una pista |
| Dividir | Cursor en el punto → tijeras o `Ctrl+B` |
| Recortar | Arrastrar los bordes del clip |
| Mover / reordenar | Arrastrar el clip (la pista de vídeo es magnética; *Habilitar espacio vacío* en su cabecera la libera) |
| Transición | Panel **Transiciones** → arrastrar entre dos clips, o seleccionar el clip y doble clic |
| Filtro | Panel **Filtros** → arrastrar al clip o doble clic con el clip seleccionado |
| Título | Panel **Títulos** → doble clic (se añade en el cursor); doble clic en el clip para editarlo; se mueve arrastrándolo en el reproductor |
| Adhesivos y llamadas | Panel **Adhesivos** (las llamadas están en sus categorías) |
| Herramientas | Panel **Más herramientas**: color, recorte, estabilización, cámara lenta, croma, imagen en imagen, logotipo, panorámica y zoom, resaltar y esconder, animación y fotogramas clave, escenas, fotograma fijo, ecualizador, compresor, puerta de ruido, reverberación, ruido, autocorrección, efectos de audio, sincronizar audio, ritmo, grabar voz, y las propias de Cinta: **quitar silencios**, **subtítulos automáticos**, **reencuadrar** y **música con atenuación** |
| Exportar | Botón **Exportar**: vídeo (MP4, MKV, MOV, AVI, WMV, FLV, WebM, MPEG, M2TS, OGV, GIF), audio (MP3, AAC, WAV, FLAC, OGG, WMA), redes (Shorts/Reels 9:16, Instagram), dispositivos y TV; calidad, resolución, fps, tasa de bits, selección y −14 LUFS |
| Shotcut / Kdenlive | *Archivo → Exportar a Shotcut / Kdenlive (MLT)* |

Mejoras propias de Cinta sobre el flujo de Movavi:

- **Inspector** a la derecha (F4): propiedades del clip seleccionado, efectos aplicados y las herramientas que le sirven.
- **En el reproductor**: doble clic en un título para escribirlo sobre la imagen, tirador para girar adhesivos y
  vídeos superpuestos, guías de tercios y de zona segura (9:16).
- **Vista previa al pasar el ratón** por un filtro o una transición, aplicada al clip real sin cambiar nada.
- **Paleta de comandos** (Ctrl+K): escriba «dividir», «9:16», «sepia», «subtítulos», «exportar mp4»…
- **Plantillas de inicio** (16:9, 9:16, 1:1, 4:5, presentación) y **Short automático**: de un vídeo a un short
  vertical con la cara centrada, sin silencios, con subtítulos palabra a palabra y música.
- **Exportación en segundo plano** con panel de *Tareas* (se sigue editando; se exporta lo que había al pulsar),
  con la tarjeta gráfica (NVIDIA/Intel/AMD) cuando está disponible.
- **Autoguardado** cada minuto y recuperación tras un cierre inesperado.
- Pistas vinculadas (los títulos siguen al vídeo), imán al arrastrar, fundidos visibles, altura de pista
  ajustable, guía de primer uso y navegación con teclado.

Atajos: *Configuración → Métodos abreviados de teclado* (los de Movavi: `Espacio`, `←/→`, `Ctrl+←/→`,
`Shift+←/→`, `Ctrl+Z/Y`, `Supr`, `Ctrl+B`, `Ctrl+M`, `Ctrl+E`…).

La vista previa usa el mismo motor que la exportación (FFmpeg): al buscar se dibuja el fotograma exacto y al
reproducir se transmite un vídeo de baja resolución en tiempo real.

## Modo avanzado (composición y animación)

El interruptor **Simple | Avanzado** (barra de estado, *Ver → Modo avanzado* o `Ctrl+Mayús+A`) cambia toda la
ventana a un espacio de trabajo de gráficos en movimiento al estilo de After Effects; volver a *Simple* deja el
editor como siempre, sin nada que estorbe. Inventario completo: [docs/INVENTARIO-AE.md](docs/INVENTARIO-AE.md).

- **Composiciones** con capas de texto, forma, sólido, objeto nulo, ajuste, cámara, luz, vídeo, imagen, audio,
  composición anidada y **la línea de tiempo del modo simple** como capa. Precomponer, dividir, duplicar.
- **Animación**: fotogramas clave en cualquier propiedad con Easy Ease (F9), entrada/salida suave, lineal,
  mantener y curvas bezier en el **editor de gráficos**; trayectorias de movimiento curvas; **expresiones**
  (`wiggle`, `loopOut`, `inertia`, `time`, `linear`, `thisComp.layer(...)` con `valueAtTime`, controles de expresión…);
  asistentes (suavizar todo, wiggler, smoother, invertir, convertir expresión en claves, secuenciar capas).
- **Interruptores** por capa: visible, solo, bloqueo, 3D, desenfoque de movimiento, 17 modos de fusión,
  mate de seguimiento (alfa/luma, normal/invertido) y primario (parenting).
- **3D con cámara** (perspectiva real con WebGL; las capas 3D se ocultan entre sí **por píxel** con un búfer de
  profundidad), **profundidad de campo** (distancia de enfoque, apertura, nivel de desenfoque), **capas de luz**
  (paralela, foco, puntual y ambiente: color, intensidad, cono y calado, atenuación suave o cuadrática inversa) con
  **sombras proyectadas** suaves entre capas, **opciones de material** (proyecta sombras / solo sombras, acepta
  sombras y luces, ambiente, difusa, especular, brillo, metal) y **desenfoque de movimiento** por sub-fotogramas en la GPU.
- **Texto en trazado** (una máscara de la capa como camino, abierta o cerrada; márgenes animables, alinear,
  forzar alineación, invertir, perpendicular) y **texto de párrafo** en caja (ajuste de línea, lo que no cabe se oculta).
- **Texto** con animadores por carácter/palabra/línea (posición, escala, rotación, giro 3D, opacidad, color,
  interletraje, desenfoque, sesgo, decodificación) y selectores de rango u ondulación.
- **Formas** (rectángulo, elipse, estrella, polígono, pluma) con relleno sólido o degradado, trazo, *recortar
  trazados*, *repetidor*, *ondular trazados* (bordes orgánicos que se mueven: agua, fuego; o con
  esquinas duras: roca, hielo), *zigzag* y los operadores de After Effects: *contraer y engordar*, *redondear
  esquinas*, *desplazar trazados* (inglete, redondo o bisel), *torcer* y **combinar trazados** (sumar, restar,
  intersecar, excluir); trazo con degradado; *convertir en trazado* y **transformación de trazados** entre claves con distinto número de
  vértices (huevo → bola → llama); la forma nueva se dibuja encima, como en After Effects; **máscaras** con modo, calado, expansión e inversión.
- **Rastreador de movimiento** (Ctrl+Alt+T o `motion_track`): sigue detalles de una capa de vídeo con precisión de
  subpíxel (correlación normalizada en pirámide y refinado de Lucas–Kanade) y crea un nulo que los sigue, mueve otra
  capa, fija una capa a 4 puntos (esquina fija, para sustituir pantallas) o estabiliza el vídeo (también rotación y
  escala con 2 puntos); avisa si el punto está en una zona lisa o sobre un borde recto y propone uno cercano.
  **Seguimiento de máscaras** (botón «Seguir ▸» o `mask_track`): la máscara sigue lo que tiene dentro (posición, o
  también escala y rotación). **Mezcla de fotogramas** (fusión o **movimiento de píxeles** con flujo óptico) y efecto **Timewarp** (velocidad
  animable o fotograma de origen, con movimiento de píxeles) para cámaras lentas sin saltos.
- **Controles de expresión** de capa y de menú desplegable (`effect("Control de capa")("Capa")` devuelve esa capa;
  los parámetros se piden también por su nombre visible), asistentes **Escala exponencial** y **Motion Sketch**
  (herramienta ✍: arrastre la capa y el recorrido se graba en tiempo real).
- **Audio para animar**: «Convertir audio en fotogramas clave» (`audio_to_keys` o menú de la capa: un nulo con la
  amplitud de los canales izquierdo, derecho y ambos en cada fotograma) y los efectos **Espectro de audio** (bandas
  logarítmicas por FFT) y **Forma de onda de audio**, en barras, líneas o puntos.
- **Herramienta Marioneta** (Ctrl+P): clic pone pines sobre cualquier capa, arrastrarlos crea fotogramas clave; la
  zona opaca se convierte en una malla y cada parte sigue a los pines conectados **a lo largo del cuerpo** (un brazo
  se dobla sin arrastrar el torso), girando sin deformarse; densidad y expansión de la malla ajustables.
- **Estilos de capa** como en After Effects / Photoshop (después de máscaras y efectos): sombra paralela, sombra
  interior, resplandor exterior e interior, bisel y relieve (interior, exterior, relieve, acolchado), superposición
  de color y de degradado y trazo (fuera, dentro o centrado); todos sus valores se animan.
- **Corrección de color e incrustación de estudio**: **Color Lumetri** (básica, creativa, curvas, ruedas de color
  y viñeta), Cambiar color, Mezclador de canales, Sombras/Iluminaciones, Colorama, Corrector de 3 vías, Curvas (editor de puntos, RGB y por canal), Niveles por
  canal, Equilibrio de color, Cambiar a color, Aplicar LUT (.cube 3D); Keylight (pantalla verde / azul con
  ganancia, equilibrio, recortes, encoger / agrandar, suavidad, quitar puntos y supresión de derrame, vistas de
  mate y de estado), Key Cleaner, Supresor de derrames avanzado, Simple Choker y Matte Choker.
- **81 efectos propios** (efectos que **leen otra capa**: mapa de desplazamiento, barrido de degradado,
  establecer mate, desenfoque compuesto; desenfoques, color, resplandor, sombra, **luz de contorno** (contraluz: borde iluminado
  alrededor o desde una dirección y aura exterior), partículas continuas o en **ráfaga** con
  resistencia del aire y estela, que nacen donde estaba el productor (dejan rastro), con formas de esquirla o
  gota, **profundidad** (tamaño, velocidad y niebla según la distancia; las cercanas desenfocadas), lado
  iluminado y desvanecido / encogido ajustables (rocas que flotan), lluvia, nieve, ruido fractal (también
  **turbulento** y **estirado**: vetas de energía y fuego), **rayo avanzado**, **patrón de celdas**, **mate
  líquido** (gooey), **bandas de color** (cel: ruido o degradados en 2–4 tonos planos), destello, transiciones animables, aberración cromática, fallo digital, claves, eco, esquina fija…) y
  **~50 ajustes preestablecidos** (comportamientos —incluido *rebote con aplastamiento*, squash & stretch en bucle—, animaciones de texto, transiciones, fondos y cámara) más
  **plantillas** (título cinético, rótulo inferior, logo 3D).
- **Herramientas** del visor con los atajos de After Effects: Selección (V), Mano (H), Zoom (Z), Rotación (W),
  Anclaje (Y), Formas (Q), Pluma (G), Texto (Ctrl+T); P/S/R/T/A/U para mostrar propiedades, J/K para saltar entre
  claves, B/N para el área de trabajo, Alt+[ ] para recortar capas, Ctrl+D, Ctrl+Mayús+D, Ctrl+Mayús+C.
- **Previsualización RAM** fluida con sonido, resolución de vista previa y **exportación** a MP4 (H.264/H.265),
  MOV ProRes 4444 o WebM **con transparencia**, GIF o secuencia PNG.
- Una composición se puede **poner en la línea de tiempo del modo simple**: se vuelve a procesar sola si cambia.

El mismo motor (Canvas 2D + WebGL) dibuja la vista previa y la exportación, así que lo que se ve es lo que sale.

## Asistentes de IA (MCP)

La versión instalada se registra sola en Claude Desktop y Claude Code la primera vez que se abre (y se quita al
desinstalar). En la portable o en desarrollo: *Configuración → Preferencias → Añadir*, o copie la configuración.

Cada herramienta recibe `project` (ruta del `.cinta`); tras `project_new`/`project_open` puede omitirse. La
ventana de Cinta recarga el proyecto sola cuando la IA lo cambia.

| Herramientas | Para qué |
| --- | --- |
| `project_new`, `project_open`, `project_get`, `project_set`, `project_save`, `project_append`, `project_relink` | Proyectos: tamaño/aspecto, fps, guardar como o portátil, adjuntar, reubicar archivos que faltan |
| `media_import`, `media_list`, `media_info`, `media_generate` | Importar archivos o carpetas; música y efectos de sonido generados por Cinta |
| `clip_add`, `color_clip_add`, `clip_split`, `clip_trim`, `clip_move`, `clip_duplicate`, `clip_delete`, `clip_set` | Línea de tiempo: añadir, dividir, recortar, mover, clonar, eliminar con rizo, velocidad, invertir, volumen, fundidos, opacidad, rotar, voltear, recortar, enderezar |
| `clip_color`, `clip_filter_add`, `clip_filter_set`, `clip_filter_remove` | Color (automático, manual, LUT) y filtros con intensidad |
| `clip_audio`, `clip_detach_audio`, `clip_freeze_frame` | EQ, compresor, puerta, reverberación, ruido, mejora, efectos; separar audio; fotograma fijo |
| `clip_chroma`, `clip_pip`, `clip_pan_zoom`, `clip_mask`, `clip_animate`, `clip_keyframe`, `clip_stabilize` | Croma, imagen en imagen, panorámica y zoom, máscaras con seguimiento, animaciones, fotogramas clave, estabilización |
| `transition_set`, `transition_wizard`, `title_add`, `title_set`, `sticker_add`, `callout_add`, `logo_add` | Transiciones, títulos (estilos, animaciones, temporizador, créditos), adhesivos, llamadas, logotipo |
| `track_add`, `track_set`, `track_remove`, `timeline_close_gaps`, `marker_add`, `marker_remove`, `undo`, `redo` | Pistas (ocultar, silenciar, bloquear, huecos, atenuación), marcadores, deshacer entre llamadas |
| `remove_silences`, `auto_subtitles`, `subtitles_import`, `subtitles_export`, `reframe`, `music_add`, `voiceover_add`, `slideshow_create`, `join_files` | Quitar pausas, subtítulos con Whisper local, SRT, 9:16 / 1:1 / 4:5, música con *ducking*, voz en off, presentaciones, unir archivos |
| `detect_scenes`, `detect_beats`, `sync_audio` | Cortar por escenas, marcadores de ritmo, sincronizar dos grabaciones por el sonido |
| `export`, `export_mlt`, `preview_frame`, `snapshot`, `catalog_list`, `open_in_editor`, `cinta_status` | Exportar (presets, calidad, rango, −14 LUFS), MLT, ver un fotograma, instantánea, catálogos, abrir en Cinta |

**Modo avanzado por MCP**: `comp_new`, `comp_template`, `comp_get`, `comp_set`, `comp_delete`, `layer_add`,
`layer_set`, `layer_delete`, `layer_arrange`, `prop_set` (valores, fotogramas clave con suavizado y expresiones),
`keyframe_edit`, `keyframe_assist`, `effect_add`, `effect_set`, `effect_remove`, `mask_add`, `mask_set`,
`shape_add`, `layer_style`, `puppet_pin`, `motion_track`, `mask_track`, `audio_to_keys`, `text_animator_add`, `preset_apply`, `comp_frame` (ver un fotograma), `comp_render` (exportar) y
`comp_to_timeline` (usarla en el modo simple). Pídale a Claude, por ejemplo: «haz una intro de 5 s con el título
cayendo letra a letra, partículas y la cámara acercándose». `scripts/demo-elementos.mjs` construye solo con
llamadas MCP una bola que rebota y se convierte en agua, fuego, electricidad y roca (bucle vertical de 7,4 s). `scripts/demo-gnx.mjs`
monta un edit vertical de 27,5 s de «despertar» al estilo anime (luna roja, grito a contraluz, pilar de energía,
cúpula, llamas, guerrero flotando entre rocas) cortado al ritmo de una base trap generada con flashes, estrobos
invertidos y temblor de cámara.

**IA para editar: Claude por MCP (y, si quiere, una IA local)**. Las tareas que necesitan «pensar» las hace
Claude con las herramientas de Cinta; no hace falta configurar nada más:

| Pídale a Claude | Herramientas |
| --- | --- |
| Quitar muletillas, repeticiones y arranques en falso | `transcript_build`, `fillers_find`, `fillers_remove`, `transcript_cut` |
| Editar el vídeo por el texto («quita la parte de los anuncios») | `transcript_get`, `transcript_cut` (por palabras, frases o tramos) |
| Corregir o traducir subtítulos (portugués, inglés…) | `subtitles_from_transcript`, `subtitles_get`, `subtitles_update`, `subtitles_add_language` |
| Capítulos para YouTube | `chapters_set`, `chapters_get` |
| Los mejores momentos como shorts listos para publicar | `shorts_create` (9:16 siguiendo la cara, subtítulos palabra a palabra, título-gancho, música) |
| Voz en off a partir de un texto | `voiceover_tts`, `tts_voices` (voces de Windows, gratis y sin internet) |

En Claude aparecen también como comandos listos: `quitar-muletillas`, `editar-por-texto`,
`traducir-subtitulos`, `capitulos-youtube` y `shorts-de-una-clase`.

Dentro de Cinta, *Más herramientas → Inteligencia artificial* tiene **Editar con el texto** (clic en las
palabras para quitarlas, muletillas resaltadas), **Traducir subtítulos**, **Capítulos**, **Voz en off desde
texto**, **Shorts de los mejores momentos** y **Asistente de IA**. Lo que no requiere IA funciona siempre
(transcribir, cortar por texto, muletillas, voz, shorts a mano); lo que sí, ofrece copiar la petición para
Claude. **Opcional**: en *Preferencias → IA local* puede conectar una IA gratuita en su PC (Ollama o LM Studio,
cualquier servidor compatible con OpenAI) para que esos botones funcionen también sin Claude.

**Subtítulos automáticos**: sin internet, con sherpa-onnx + Whisper + VAD Silero (los mismos modelos del kit de
shorts). Cinta busca el modelo en *%APPDATA%\Cinta\models*, en la carpeta indicada en Preferencias o en el kit.

## Desarrollo

```bash
npm install
```

```bash
npm start
```

```bash
npm run test:mcp
```

```bash
npm run dist
```

- `npm run test:mcp` — prueba de extremo a extremo del servidor MCP con un cliente real: cada herramienta y cada
  elemento de los catálogos, verificando píxeles, duraciones, códecs y sonoridad (`--exe=<Cinta.exe>` prueba el
  empaquetado).
- `node scripts/motion-unit.mjs` — pruebas unitarias del motor del modo avanzado (suavizado, trayectorias,
  expresiones, recortar trazados, selectores de texto, operaciones con deshacer).
- `electron . --selftest=<carpeta>` — maneja la interfaz real (clics en los botones, vista previa, reproducción,
  exportación, recarga tras un cambio del MCP) y deja capturas y un registro. Use `CINTA_USER_DATA` para aislar
  el perfil.
- `npm run dist` — `release/Cinta-Setup-1.0.0.exe` y `release/Cinta-Portable-1.0.0.exe`.

Arquitectura: `src/core` (Node puro: modelo, operaciones con deshacer, catálogos, compositor FFmpeg, análisis,
voz a texto, SRT, MLT), `src/mcp` (servidor stdio), `src/main` (Electron), `src/renderer` (interfaz sin framework).
