# Inventario — After Effects 2024 → Cinta «Modo avanzado» → MCP

Estudio de After Effects 2024 a partir de su interfaz y su documentación: efectos (~300 entre propios y
CycoreFX), asistentes de fotogramas clave y ajustes preestablecidos (`Presets`: Behaviors, Text (17 familias), Backgrounds, Synthetics, Transitions, Image). Solo se replica la
**funcionalidad**: nombres, iconos, código, preajustes y recursos de Adobe no se usan. Todo lo de Cinta es propio.

Leyenda: ✅ en Cinta · ◐ versión simplificada · — fuera de alcance (motivo)

## 1. Composiciones y capas

| After Effects | Cinta (modo avanzado) | MCP |
| --- | --- | --- |
| Composición (tamaño, fps, duración, fondo), subcomposición/precomponer | ✅ Composiciones dentro del proyecto; capa de composición; precomponer | `comp_new`, `comp_set`, `comp_get`, `layer_precompose` |
| Capas: metraje, imagen, sólido, texto, forma, nulo, ajuste, cámara, audio | ✅ todas; además capa **Secuencia** (la línea de tiempo del modo simple) | `layer_add` |
| Interruptores: visible, solo, bloqueo, 3D, desenfoque de movimiento, modo de fusión, mate de seguimiento, primario (parenting) | ✅ | `layer_set` |
| Modos de fusión (normal, multiplicar, trama, superponer, luz suave/fuerte, sobreexponer/subexponer color, oscurecer/aclarar, diferencia, exclusión, tono, saturación, color, luminosidad, añadir) | ✅ 17 modos | `layer_set {blend}` |
| Mate de seguimiento alfa / alfa invertido / luma / luma invertido | ✅ | `layer_set {matte}` |
| Punto de entrada/salida, estirar tiempo, reasignación de tiempo, invertir | ✅ (invertir = estirar −100 %) | `layer_set` |
| Ordenar, duplicar, dividir capa, secuenciar capas | ✅ | `layer_reorder`, `layer_duplicate`, `layer_split`, `keyframe_assist {sequence}` |

## 2. Animación

| After Effects | Cinta | MCP |
| --- | --- | --- |
| Transformar: punto de anclaje, posición, escala, rotación, opacidad; 3D: Z, rotación X/Y/Z | ✅ | `prop_set` |
| Fotogramas clave: lineal, bezier, mantener; suavizado (F9), entrada/salida suave; influencia/velocidad | ✅ bezier temporal (cubic) por segmento | `keyframe_add`, `keyframe_ease` |
| Trayectorias espaciales curvas (auto-bezier) | ✅ Catmull-Rom con reparametrización por longitud | automático |
| Editor de gráficos (gráfico de valor, tiradores) | ✅ gráfico de valor con tiradores | `keyframe_ease {bezier}` |
| Expresiones (wiggle, loopOut/loopIn, time, linear/ease, random, valueAtTime, index…) | ✅ subconjunto JS compatible | `expression_set` |
| Animación basada en datos: JSON, MGJSON, CSV y TSV como material de archivo; footage().sourceData / sourceText / dataValue / dataKeyCount / dataKeyTimes / dataKeyValues; volver a cargar | ✅ (sin capa de datos en la composición) | `data_import` |
| Scripts de ExtendScript (.jsx / .js): Archivo ▸ Scripts ▸ Ejecutar archivo de secuencias de comandos | ◐ subconjunto del modelo de objetos, aislado, una sola acción de deshacer (docs/scripts-ae.md) | `run_script` |
| Asistentes: Easy Ease, Wiggler, Smoother, Secuenciar capas, invertir fotogramas clave, convertir expresión en fotogramas | ✅ | `keyframe_assist` |
| Motion Sketch, herramienta Marioneta (pines, MLS rígido sobre malla) | ✅ | `keyframe_assist {sketch}`, `puppet_pin` |
| Rotobrush, Content-Aware Fill | — (requieren la IA de Adobe) | |
| Desenfoque de movimiento (ángulo de obturación, muestras) | ✅ por subfotogramas | `comp_set {motionBlur}` |
| Cámara 3D (zoom, punto de interés), capas 3D con perspectiva | ✅ WebGL | `layer_add {type: camera}` |
| Luces (paralela, foco, punto, ambiente), sombras, opciones de material, profundidad de campo | ✅ | `layer_add {type: light}`, `prop_set` |
| Modelos 3D (.glb, .gltf, .obj) como capas 3D: cámara y luces de la comp., profundidad por píxel con las capas 3D, animaciones del archivo, materiales PBR, sombras entre modelos | ✅ (sin efectos, máscaras ni desenfoque en la capa) | `media_import`, `layer_add {type: model}`, `model_set` |
| Luz de entorno (HDRI) que ilumina y se refleja en los modelos | ✅ | `layer_add {type: light, light_type: environment}` |
| Texto y formas extruidos: Opciones de geometría (estilo y profundidad de bisel, bisel de hueco, profundidad de extrusión) y colores frontal / bisel / lateral / fondo | ✅ | `geometry_set` |
| Cinema 4D / Cineware | — (fuera de alcance) | |

## 3. Texto

| After Effects | Cinta | MCP |
| --- | --- | --- |
| Carácter: fuente, tamaño, peso, relleno, trazo, interletraje, interlineado, alineación | ✅ | `layer_add {type: text}`, `prop_set` |
| Animadores de texto: posición, escala, rotación, opacidad, color, interletraje, desenfoque, sesgo, desplazamiento de caracteres | ✅ | `text_animator_add` |
| Selector de rango (inicio, fin, desplazamiento, basado en caracteres/palabras/líneas, forma cuadrado/rampas/triángulo/redondo/suave, orden aleatorio) y selector de ondulación | ✅ | `text_animator_add` |
| Texto en trazado, texto de párrafo, texto 3D por carácter | ✅ | `layer_set`, `text_animator_add` |
| Crear formas / máscaras a partir del texto (un grupo o máscara por carácter, contornos reales de la fuente) | ✅ | `text_to_shapes` |
| Trazado automático (canal, invertir, desenfoque, tolerancia, umbral, área mínima, redondez de esquinas, entorno de trabajo) | ✅ | `auto_trace` |
| Fuentes variables: ejes (grosor, anchura, inclinación, tamaño óptico…) animables en el panel Carácter | ✅ (salvo CFF2) | `text_font_axes` |
| ~300 preajustes de animación de texto | ◐ 20 animaciones propias (máquina de escribir, caer, decodificar, rebote, desenfoque, ola…) | `preset_apply` |

## 4. Formas y máscaras

| After Effects | Cinta | MCP |
| --- | --- | --- |
| Rectángulo (redondez), elipse, estrella/polígono, trazado bezier (pluma) | ✅ | `shape_add` |
| Relleno, trazo (ancho, extremos, uniones, guiones), relleno degradado lineal/radial | ✅ | `shape_add` |
| Recortar trazados (inicio, fin, desplazamiento), repetidor (copias, transformación, opacidad) | ✅ | `shape_add` |
| Máscaras: modo añadir/restar/intersecar, calado, expansión, opacidad, invertida, trazado animado | ✅ | `mask_add`, `mask_set` |

## 5. Efectos (implementación propia con Canvas/WebGL)

292 efectos: todos los de After Effects 2024 dentro de alcance (incluidos los heredados y los CycoreFX clásicos), más el efecto Pintura. Nombres, orden de parámetros, valores por defecto,
rangos y opciones siguen los que muestra After Effects para cada efecto; el dibujo es código propio de Cinta (no es
el de Adobe, así que los píxeles se parecen pero no son idénticos bit a bit). Las pruebas `scripts/unit/*.mjs`
comprueban esos valores y `scripts/mcp-cases/*.mjs` los píxeles y el sonido renderizados.

| Categoría | Efectos | Destacados |
| --- | --- | --- |
| Desenfocar y enfocar | 15 | Cuadro, canal, inteligente, bilateral, Máscara de enfoque, CC Cross / Radial / Radial Fast / Vector Blur |
| Ruido y granulado | 12 | Mediana, Polvo y rascaduras, Ruido HLS, Ruido alfa, Añadir grano, Quitar grano, Aplicar granulado (mide el grano de otra capa) |
| Canal | 11 | Minimax, Aritmética, Fusionar, Cálculos, Combinador de canales, Aritmética compuesta, Niveles alfa |
| Mate e Incrustación | 4 + 12 | Keylight (con ajuste tonal), Clave de diferencia de color, Rango de color, Clave interior/exterior, Extraer |
| Corrección de color y Utilidad | 40 + 5 | Lumetri (con HSL secundario, Look creativo y HDR), Color selectivo, Gamma/Pedestal/Ganancia, Limitador de vídeo, CC Overbrights (32 bpc), Mapa arbitrario de PS (.amp), Ampliar límites |
| Distorsionar y Perspectiva | 36 + 9 | Deformar, CC Page Turn, CC Bender, CC Flo Motion, Compensación óptica, Sombra radial, 3D básico, CC Cylinder, CC Sphere, Gafas 3D, CC Blobbylize, Dar nueva forma, Alargar, Reparación de obturación desplazada, CC Environment |
| Transición | 17 | Barrido de tarjetas, CC Glass / Image / Light Wipe, CC Twister, CC WarpoMatic, CC Jaws… |
| Estilizar y Generar | 20 + 29 | Caricatura, Pinceladas, Rayo avanzado, Código de tiempo, Números, Cubo de pintura, CC Light Burst, CC Spotlight, CC Glass…, Fractal, CC Glue Gun |
| Simulación y Tiempo | 20 + 7 | Shatter, Card Dance, Caustics, Wave World, Foam, CC Particle World, CC Rainfall/Snowfall, CC Ball Action, CC Bubbles…, CC Particle Systems II, CC Mr. Mercury, CC Hair, CC Force Motion Blur; Shatter, Card Dance y Card Wipe con cámara (posición, pines o cámara de la comp.), iluminación y material |
| Audio | 10 | Graves y agudos, Retardo, Flanger y chorus, Paso alto/bajo, Mezclador estéreo, Modulador, EQ paramétrico, Reverberación, Al revés, Tono |
| Controles de expresión | 7 | |
| Ronda 7 — lente | 5 | Desenfoque de lente de cámara (iris, difracción, resaltes, mapa de desenfoque), Desenfoque rápido (heredado), Desenfoque de movimiento de píxeles (flujo óptico), Estabilización del desenfoque de temblores, Conservar detalles (ampliación) |
| Ronda 7 — generar | 8 | Degradado de 4 colores, Ruido de turbulencia, Compresión de resalte HDR, Convertidor perfiles de color, Estabilizador del color, CC Threshold, CC Threshold RGB, CC Burn Film |
| Ronda 7 — tiempo | 8 | Reducir parpadeo entrelazado, Diferencia de tiempo, CC Time Blend FX, CC Block Load, CC Mr. Smoothie, CC Composite, CC Ripple Pulse, Eliminar parpadeo (propio de Cinta: el «ADBE Deflicker» de AE es el Estabilizador del color) |
| Canal 3D y mates | 3 + 7 | Extraer canal 3D, Profundidad de campo, Mate de profundidad, Niebla 3D, ID de mate (leen los canales de un EXR o la profundidad del 3D propio de Cinta), Perfeccionar mate fuerte / suave |
| Ronda 7 — partículas y heredados | 6 | Animación del objeto (Particle Playground, los 10 grupos), CC PS Classic, CC PS LE Classic, Texto básico, Texto de trazado, Pintura vectorial (trazos en el efecto, dibujo en el visor) |
| Scripts `.jsx` | 250 / 258 | Tabla completa de nombres de coincidencia de AE 2024 (y nombres visibles en inglés y español) para `addProperty`; 6 efectos solo de Cinta, 2 sin equivalente (solo VR) |
| Aproximaciones conocidas | | Píxeles propios (no idénticos bit a bit); «Sintetizar bordes» del estabilizador sin fotogramas vecinos |
| OCIO, Cineware, VR | — (fuera de alcance) | |

## 6. Interfaz

| After Effects | Cinta |
| --- | --- |
| Paneles: Proyecto, Composición, Línea de tiempo, Controles de efectos, Efectos y ajustes preestablecidos, Carácter, Alinear, Previsualizar | ✅ en el modo avanzado (interruptor Simple/Avanzado) |
| Ventana ▸ Ámbitos de Lumetri: forma de onda (RGB, luminancia, YC, YC sin cromacidad), vectorescopios YUV (dianas 75 %/100 %, línea de tono de piel) y HLS, histograma, exposición (RGB / YUV), ajustes preestablecidos, 8 bits / flotante / HDR, fijar señal, brillo, espacio de color | ✅ panel acoplable (Ver ▸ Ámbitos de Lumetri), calculado en un worker sobre una copia reducida del fotograma; MCP `comp_scopes` |
| Herramientas: Selección, Mano, Zoom, Rotación, Anclaje, Rectángulo/Elipse/Estrella, Pluma, Texto | ✅ con atajos (V, H, Z, W, Y, Q, G, Ctrl+T) |
| Atajos de propiedades (P, S, R, T, A, U), J/K (fotograma clave anterior/siguiente), F9, Alt+[ ], Ctrl+Shift+D, Ctrl+D | ✅ |
| Previsualización RAM, resolución (completa, 1/2, 1/4), área de trabajo, bucle | ✅ |
| Cola de procesamiento (Render Queue) | ✅ exportar la composición (MP4/MOV ProRes 4444 con alfa/WebM con alfa/PNG secuencia/GIF) |

## 7. Herramientas de estudio (añadidas tras el inventario inicial)

| After Effects | Cinta | MCP |
| --- | --- | --- |
| Rastreador de movimiento (posición, rotación/escala, esquina fija, estabilizar) | ✅ subpíxel | `motion_track` |
| Rastreo plano en perspectiva (Mocha) y seguimiento de máscaras | ✅ | `mask_track {method: perspective}` |
| Rastreador de cámara 3D (cámara y nulos 3D resueltos desde un vídeo 2D) | ✅ | `camera_track` |
| Estabilizador de deformación (Warp Stabilizer): Suavizar movimiento / Sin movimiento, Posición · Posición, Escala, Rotación · Perspectiva · Deformación de subespacio, encuadre (Sólo estabilizar, Recortar, Escala automática, Sintetizar bordes), análisis en segundo plano con banda «Análisis en segundo plano (paso 1 de 2)» | ✅ parámetros de Stabilizer; subespacio = homografía + malla 6×4 propia; sintetizar bordes estira el borde (no toma píxeles de otros fotogramas) | `effect_add warpStabilizer`, `warp_stabilize` |
| Convertir audio en fotogramas clave | ✅ | `audio_to_keys` |
| Estilos de capa (sombra, resplandores, superposiciones, bisel, trazo) | ✅ | `layer_style` |
| Gráficos esenciales: propiedades maestras, sustitución de medios, plantillas | ✅ | `essential_props`, `template_export`, `template_import` |
| Importar Photoshop / Illustrator como composición | ✅ | `import_as_comp` |
| Exportar a Lottie | ✅ | `comp_export_lottie` |
| Cola de procesamiento, proxies, caché de disco | ✅ | `render_queue`, `proxy`, `disk_cache` |
| OpenEXR multicanal, Cryptomatte | ✅ | `exr_info`, `exr_import` |
| Interpolación inteligente de máscaras | ✅ | `mask_interpolate` |
| Configuración de color del proyecto (8/16/32 bpc, fundir con gamma 1.0) | ✅ | `color_settings` |
| Herramientas de pintura: Pincel, Tampón de clonar, Borrador (Ctrl+B), paneles Pintar y Pinceles, trazos animables con Escribir / Constante / Un fotograma | ✅ | `paint_stroke`, `paint_list`, `paint_edit`, `paint_options` |
| Gráfico de velocidad (velocidad e influencia), Velocidad de fotograma clave (Ctrl+Mayús+K), Easy Ease de entrada/salida, Separar dimensiones | ✅ | `keyframe_velocity`, `separate_dimensions` |

## 8. Ronda 8: lo que no son efectos

| After Effects | Cinta | MCP |
| --- | --- | --- |
| Importar secuencias de imágenes («Secuencia PNG…», Forzar orden alfabético, fotogramas que faltan), Interpretar material de archivo (alfa, velocidad de fotogramas, bucle) | ✅ PNG/JPEG/TIFF/TGA/EXR/DPX/Cineon/BMP/WebP/SGI/Camera Raw/HEIF; carpeta arrastrada = secuencia | `footage_import`, `footage_interpret` |
| Formatos: Targa, SGI, DPX, Cineon, MXF, HEIC/AVIF, Camera Raw | ✅ (Camera Raw: DNG decodificado; CR2/NEF/ARW con LibRaw si está instalado, si no la vista previa JPEG incrustada) | `media_import` |
| Importar proyecto de Premiere Pro (.prproj) y cámaras de Maya (.ma) | ✅ secuencias → composiciones o montaje simple; cámaras y localizadores con fotogramas clave | `premiere_import`, `maya_import`, `import_as_comp` |
| AAF / OMF, cámaras RPF | — (no hay lector libre / especificación pública) | |
| Capa de guía, Separar comp. del entorno de trabajo (Ctrl+Mayús+X), Recortar comp. según región de interés, región de interés | ✅ | `layer_guide`, `comp_crop`, `comp_roi` |
| Diseño interactivo: tiempo (intro, outro, zonas protegidas), marcadores de composición | ✅ | `responsive_time`, `comp_marker` |
| RotoBézier, Herramienta Calado de máscara (calado variable), Transformación de ondulación | ✅ | `mask_options`, `shape_operator` |
| Texto vertical (Tipo vertical, Tate-Chuu-Yoko), Faux negrita/cursiva, mayúsculas, versalitas, superíndice/subíndice, tsume, escalas; panel Párrafo completo, texto de párrafo, separación automática, composición línea por línea / multilínea | ✅ (sin ligaduras ni texto de derecha a izquierda) | `text_format` |
| Disposición de 1/2/4 vistas, vistas 3D (Frente, Izquierda, Superior… Vistas personalizadas), herramientas de cámara (1/2/3, C), F10–F12, Esc | ✅ (vistas ortogonales con una ligera perspectiva) | `comp_view_frame` |
| Diagrama de flujo, panel Propiedades, Navegador de medios, Metadatos | ✅ | `comp_flowchart`, `media_browse`, `media_metadata` |
| Métodos abreviados de teclado (teclado visual, conflictos, conjuntos) | ✅ todos los atajos del modo avanzado | — |
| Pincel tipo rotoscopia y Perfeccionar borde (Alt+W), Relleno según el contenido (Objeto / Superficie / Fusión de borde) | ◐ métodos clásicos locales (sin el modelo de IA de AE) | `roto_brush`, `content_aware_fill` |
