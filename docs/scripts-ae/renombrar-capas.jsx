// Ejemplo: numera las capas de la composición activa y escalona sus puntos de entrada 5 fotogramas.
#target aftereffects
var comp = app.project.activeItem;
if (!(comp instanceof CompItem)) {
    alert("Abra una composición primero.");
} else {
    app.beginUndoGroup("Numerar y escalonar capas");
    for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        layer.name = i + " · " + layer.name;
        layer.startTime = (i - 1) * 5 * comp.frameDuration;
    }
    app.endUndoGroup();
    $.writeln(comp.numLayers + " capas numeradas en «" + comp.name + "».");
}
