// Ejemplo: crea una composición con un sólido que cruza la pantalla, un título y un desenfoque animado.
// Archivo ▸ Scripts ▸ Ejecutar archivo de secuencias de comandos… (o la herramienta MCP run_script).
#target aftereffects
(function () {
    app.beginUndoGroup("Crear composición de ejemplo");
    var comp = app.project.items.addComp("Ejemplo de script", 1280, 720, 1, 5, 30);
    comp.bgColor = [0.08, 0.08, 0.12];

    var solid = comp.layers.addSolid([1, 0.35, 0.1], "Barra", 300, 120, 1);
    var pos = solid.property("Transform").property("Position");
    pos.setValuesAtTimes([0, 2, 4], [[160, 360], [1120, 360], [640, 360]]);
    for (var i = 1; i <= pos.numKeys; i++) {
        var ease = new KeyframeEase(0, 33.33);
        pos.setTemporalEaseAtKey(i, [ease], [ease]);
    }
    solid.property("Transform").property("Rotation").expression = "time * 45";

    var blur = solid.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
    blur.property(1).setValueAtTime(0, 20);
    blur.property(1).setValueAtTime(1, 0);

    var title = comp.layers.addText("Hecho con un script");
    var td = title.property("Source Text").value;
    td.fontSize = 72;
    td.fillColor = [1, 1, 1];
    title.property("Source Text").setValue(td);
    title.property("Transform").property("Position").setValue([640, 160]);
    title.property("Transform").property("Opacity").setValueAtTime(0, 0);
    title.property("Transform").property("Opacity").setValueAtTime(1, 100);

    $.writeln("Capas: " + comp.numLayers + ", claves de posición: " + pos.numKeys);
    comp.openInViewer();
    app.endUndoGroup();
})();
