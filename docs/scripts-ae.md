# Datos y scripts de After Effects en Cinta

## Animación basada en datos

**Importar ▸ Datos: JSON, MGJSON, CSV o TSV…** en el panel Proyecto (o la herramienta MCP `data_import`) añade el
archivo como material de archivo. El texto del archivo se guarda en el proyecto. Clic derecho ▸ **Volver a cargar material
de archivo** lo lee otra vez del disco y la animación cambia. Doble clic copia una expresión de ejemplo.

En las expresiones:

| Expresión | Resultado |
| --- | --- |
| `footage("datos.csv").dataValue([columna, fila])` | CSV/TSV: la primera fila son los nombres de las columnas; la fila 0 es la primera fila de datos. Los números se devuelven como números y lo demás como texto. La columna puede ser un índice (desde 0) o el nombre de la cabecera. |
| `footage("datos.csv").dataKeyCount([col])`, `dataKeyTimes([col], t0, t1)`, `dataKeyValues([col], t0, t1)` | CSV/TSV: una muestra por fila, separadas un fotograma de la composición. |
| `footage("x.mgjson").dataValue([i, j…])` | MGJSON: ruta en `dataOutline`, por grupos. Un flujo estático da su valor. Uno dinámico da la muestra vigente en el instante actual (se mantiene hasta la siguiente; los tiempos empiezan en 0 con la primera muestra del archivo). |
| `footage("x.mgjson").dataKeyCount / dataKeyTimes / dataKeyValues` | Muestras de un flujo dinámico. |
| `footage("x.json").sourceData` | El JSON ya convertido en objeto. En CSV/TSV devuelve las filas como objetos `{columna: valor}`. |
| `footage("x.json").sourceText` | El texto del archivo, por ejemplo para `eval("(" + … + ")")`. |
| `footage("x.json").dataValue(["clave", 0])` | Ruta de claves e índices dentro del JSON (es una extensión de Cinta). |
| `footage("video.mp4").width / height / duration / frameDuration` | También funciona con el material de archivo multimedia. |

Diferencias con After Effects:

- Un archivo de datos no se puede arrastrar a una composición como capa de datos. Hay que leerlo con `footage()`.
- Los flujos dinámicos de MGJSON mantienen cada muestra hasta la siguiente; no interpolan.

## Scripts (ExtendScript)

Hay dos formas de ejecutar un script `.jsx` o `.js`: el menú **Archivo ▸ Scripts ▸ Ejecutar archivo de secuencias de
comandos…** (así se llama en After Effects en español) o la herramienta MCP `run_script` (`file` o `code`).

- El script se ejecuta en un contexto de V8 aislado, sin `require`, `process`, red ni objetos del programa. El límite de
  tiempo es de 10 s por defecto.
- Toda la ejecución es **una sola acción de deshacer**: un Ctrl+Z (o `undo`) quita todo lo que hizo el script.
  `app.beginUndoGroup` y `app.endUndoGroup` se aceptan y sus nombres se devuelven en `undoGroups`.
- Si el script falla, lo que hizo hasta el error se conserva, como en After Effects. El error se muestra con su línea.
- `alert()`, `$.writeln()`, `$.write()` y `writeLn()` van al registro de salida: un diálogo en la ventana, o `log` en el MCP.
  `confirm()` devuelve `true` y `prompt()` devuelve el valor por defecto.
- Preprocesador: `#include "archivo.jsx"` y `//@include` se insertan en el código; `#target` y `#targetengine` se ignoran.

### Modelo de objetos disponible

| Objeto | Miembros |
| --- | --- |
| `app` | `project`, `version`, `language`, `beginUndoGroup`, `endUndoGroup`, `settings.haveSetting/getSetting/saveSetting` (no guardan nada), `scheduleTask` y `executeCommand` (no hacen nada) |
| `app.project` | `items`, `numItems`, `item(i)`, `itemByID`, `activeItem` (la composición abierta en el visor), `file`, `importFile(new ImportOptions(new File(ruta)))` (solo archivos de datos), `bitsPerChannel`, `linearBlending` |
| `ItemCollection` | `length`, `[i]`, `addComp(nombre, ancho, alto, proporción de píxeles, duración, fps)`, `addFolder` (solo existe durante el script) |
| `CompItem` | `name`, `width`, `height`, `duration`, `frameRate`, `frameDuration`, `bgColor`, `numLayers`, `layers`, `layer(i \| nombre)`, `workAreaStart`/`workAreaDuration`, `time`, `motionBlur`, `shutterAngle`/`shutterPhase`, `duplicate()`, `remove()`, `openInViewer()` |
| `FootageItem` | Datos y multimedia: `name`, `file`, `width`, `height`, `duration`, `frameRate`, `mainSource.reload()` (vuelve a leer un archivo de datos), `remove()` |
| `LayerCollection` | `length`, `[i]`, `addSolid(color, nombre, ancho, alto, proporción, duración)`, `addText(texto \| TextDocument)`, `addBoxText([an, al], texto)`, `addShape()`, `addNull(duración)`, `addCamera(nombre, puntoCentral)`, `addLight(nombre, puntoCentral)`, `add(CompItem \| FootageItem)`, `byName`, `precompose(índices, nombre)` |
| Capa (`AVLayer`, `TextLayer`, `ShapeLayer`, `CameraLayer`, `LightLayer`; `instanceof` funciona) | `name`, `index`, `inPoint`, `outPoint`, `startTime`, `stretch`, `enabled`, `solo`, `locked`, `shy`, `threeDLayer`, `motionBlur`, `parent`, `setParentWithJump`, `blendingMode` (`BlendingMode.*`), `lightType` (`LightType.*`), `source`, `containingComp`, `nullLayer`, `property(nombre \| nombre interno \| índice)`, `propertyGroup(…)`, `transform`, `remove()`, `duplicate()`, `moveToBeginning/End/Before/After` |
| Grupos | Transformar (`ADBE Transform Group`), Efectos (`ADBE Effect Parade`: `addProperty(nombre interno de AE o id de Cinta)`, `property(nombre \| índice)`), Texto (`Source Text` / `ADBE Text Document`), Opciones de cámara, Opciones de luz, Audio (`Audio Levels`), Contenido de formas (`ADBE Vector Group`, `ADBE Vector Shape - Rect / Ellipse / Star`, `ADBE Vector Graphic - Fill / Stroke`, la transformación del grupo). En cada grupo: `name`, `matchName`, `numProperties`, `propertyIndex`, `parentProperty`, `enabled` (efectos), `remove()`, `moveTo()` (efectos) |
| `Property` | `value`, `valueAtTime(t, antesDeLaExpresión)`, `setValue`, `setValueAtTime`, `setValuesAtTimes`, `setValueAtKey`, `numKeys`, `keyTime`, `keyValue`, `addKey`, `removeKey`, `nearestKeyIndex`, `setInterpolationTypeAtKey` y `keyIn/OutInterpolationType` (`KeyframeInterpolationType.LINEAR/BEZIER/HOLD`), `setTemporalEaseAtKey` y `keyIn/OutTemporalEase` (`KeyframeEase(velocidad, influencia)`), `setTemporalContinuousAtKey`, `setTemporalAutoBezierAtKey`, `expression`, `expressionEnabled`, `expressionError`, `dimensionsSeparated` (Posición), `propertyValueType`, `isTimeVarying` |
| `TextDocument` | `text`, `fontSize`, `fillColor`, `strokeColor`, `strokeWidth`, `applyFill`, `applyStroke`, `font`, `justification` (`ParagraphJustification.*`), `tracking` |
| `File` / `Folder` | Solo lectura y solo dentro de la carpeta del script y de la del proyecto: `exists`, `open("r")`, `read`, `readln`, `eof`, `close`, `name`, `fsName`, `fullName`, `path`, `parent`, `length`, `modified`, `getFiles(máscara)`. Para escribir, `open("w")` devuelve `false`. Los diálogos de archivo devuelven `null`. |
| `$` | `writeln`, `write`, `fileName`, `evalFile`, `os`, `sleep` (no hace nada), `global` |

Los nombres de las propiedades se aceptan en inglés, con el nombre interno (`ADBE Position`) o en español (`Posición`).
Los colores son matrices `[r, g, b]` de 0 a 1, como en After Effects. En Cinta se guardan como `#rrggbb`. En los
menús desplegables de los efectos, el valor es un número desde 1. La tabla `AE_EFFECTS` de
[`src/core/aescript.ts`](../src/core/aescript.ts) relaciona los nombres internos de los efectos de After Effects con los
efectos de Cinta: todos los efectos del catálogo que tienen equivalente en After Effects 2024 están en ella, con el
nombre interno que registra el plug-in (por ejemplo `CSSnowfall` para CC Snowfall) y sus nombres visibles en inglés y
en español (`Shadow/Highlight`, `Sombra/iluminación`), que `addProperty` y `property()` también aceptan; `matchName`
devuelve siempre el nombre de After Effects. Los efectos propios de Cinta se añaden con su id o su nombre en español.

No disponible: ScriptUI (ventanas y paneles), cola de render, máscaras, marcadores, abrir o guardar proyectos,
importar vídeo, audio o imágenes desde el script, escribir archivos, `system.callSystem`, red y `.jsxbin`. Cuando un
script llama a una de estas funciones, recibe un error que lo explica.

### Ejemplos

En [`docs/scripts-ae/`](scripts-ae/):

- `crear-composicion.jsx`: crea una composición con un sólido animado (facilidad temporal), una expresión, un
  desenfoque gaussiano animado y un título.
- `barras-desde-csv.jsx`: importa `ventas.csv` y crea un gráfico de barras animado. Cada barra lee su valor con
  `footage().dataValue`.
- `renombrar-capas.jsx`: numera las capas de la composición activa y escalona sus puntos de entrada.
