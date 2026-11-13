// Ejemplo: importa ventas.csv (en esta misma carpeta) y crea un gráfico de barras animado: una capa de forma por
// fila, cuya escala vertical lee la columna "valor" con una expresión footage().dataValue([columna, fila]).
// Si cambia el CSV, «Volver a cargar material de archivo» en el panel Proyecto actualiza la animación.
#target aftereffects
(function () {
    app.beginUndoGroup("Barras desde CSV");
    var csv = new File($.fileName).parent.fsName + "/ventas.csv";
    var data = app.project.importFile(new ImportOptions(new File(csv)));
    var comp = app.project.items.addComp("Ventas", 1280, 720, 1, 4, 30);

    var f = new File(csv);
    f.open("r");
    var rows = -1;
    while (!f.eof) { if (f.readln() !== "") rows++; }
    f.close();

    for (var r = 0; r < rows; r++) {
        var shape = comp.layers.addShape();
        shape.name = "Barra " + (r + 1);
        var group = shape.property("Contents").addProperty("ADBE Vector Group");
        var rect = group.property("Contents").addProperty("ADBE Vector Shape - Rect");
        rect.property("Size").setValue([80, 400]);
        var fill = group.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([0.2, 0.5 + r * 0.1, 1]);
        shape.property("Transform").property("Anchor Point").setValue([0, 200]);
        shape.property("Transform").property("Position").setValue([200 + r * 140, 620]);
        shape.property("Transform").property("Scale").expression =
            'var v = footage("' + data.name + '").dataValue([1, ' + r + ']);\n' +
            '[100, linear(time, 0, 1.5, 0, v)]';
    }
    $.writeln(rows + " barras desde " + data.name);
    app.endUndoGroup();
})();
