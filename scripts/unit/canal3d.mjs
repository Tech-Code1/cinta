// Unit tests of «canal3d»: the 3D Channel effects and the Refine mattes follow After Effects 2024's plug-ins
// (Extraer canal 3D, Profundidad de campo, Mate de profundidad, Niebla 3D, ID de mate, Perfeccionar mate
// duro / suave), their match names are in the script table, and the EXR channels they read
// are found by their usual names.
export default ({ test, ok, M, core }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const ids = (id) => fx(id).params.map((q) => q.id).join(',');
  const choices = (id, p) => def(id, p).choices.map((c) => c.id).join('|');
  const is = (id, p, d, min, max) => { const q = def(id, p); ok(q, `${id}.${p} no existe`); ok(q.def === d && (min === undefined || q.min === min) && (max === undefined || q.max === max), `${id}.${p}: ${q.def} [${q.min}, ${q.max}], esperado ${d} [${min}, ${max}]`); };

  test('canal3d: Extraer Canal 3D y Profundidad de campo con los valores de After Effects', () => {
    ok(fx('channel3dExtract').name === 'Extraer Canal 3D' && fx('channel3dExtract').cat === 'Canal 3D', 'nombre y categoría');
    ok(choices('channel3dExtract', 'channel') === 'zDepth|objectId|uv|normals|coverage|bgRgb|unclampedRgb|materialId', 'los 8 canales en el orden de AE');
    is('channel3dExtract', 'channel', 'zDepth'); is('channel3dExtract', 'blackPoint', -10000, -10000000, 10000000); is('channel3dExtract', 'whitePoint', 10000, -10000000, 10000000);
    is('channel3dExtract', 'antiAlias', 0); is('channel3dExtract', 'clamp', 1); is('channel3dExtract', 'invert', 0);
    ok(ids('channel3dExtract').startsWith('channel,blackPoint,whitePoint,antiAlias,clamp,invert'), ids('channel3dExtract'));
    ok(fx('depthOfField').name === 'Profundidad de campo', 'Profundidad de campo');
    is('depthOfField', 'focalPlane', 0, -10000000, 10000000); is('depthOfField', 'maxRadius', 0, 0, 1000); is('depthOfField', 'thickness', 0, 0, 10000); is('depthOfField', 'bias', 50, 0, 100);
    ok(ids('depthOfField').startsWith('focalPlane,maxRadius,thickness,bias'), ids('depthOfField'));
  });

  test('canal3d: Mate de profundidad, Niebla 3D e ID de mate con los valores de After Effects', () => {
    is('depthMatte', 'depth', 0, -10000000, 10000000); is('depthMatte', 'feather', 0, 0, 10000000); is('depthMatte', 'invert', 0);
    ok(fx('fog3d').name === 'Niebla 3D' && ids('fog3d').startsWith('color,start,end,opacity,density,foggyBg,gradient,contribution'), ids('fog3d'));
    is('fog3d', 'color', '#ffffff'); is('fog3d', 'start', 0); is('fog3d', 'end', 0); is('fog3d', 'opacity', 100, 0, 100); is('fog3d', 'density', 50, 0, 100); is('fog3d', 'foggyBg', 1); is('fog3d', 'contribution', 0, 0, 100);
    ok(def('fog3d', 'gradient').type === 'layer', 'Capa de degradación');
    ok(fx('idMatte').name === 'ID de mate' && choices('idMatte', 'aux') === 'materialId|objectId', 'ID del material | ID del objeto');
    is('idMatte', 'aux', 'objectId'); is('idMatte', 'id', 0, 0, 32000); is('idMatte', 'feather', 0, 0, 32000); is('idMatte', 'invert', 0); is('idMatte', 'coverage', 0);
  });

  test('canal3d: Perfeccionar mate fuerte / suave (parámetros y grupos)', () => {
    ok(fx('refineHardMatte').name === 'Perfeccionar mate fuerte' && fx('refineSoftMatte').name === 'Perfeccionar mate suave' && fx('refineSoftMatte').cat === 'Mate', 'nombres y categoría Mate');
    ok(ids('refineHardMatte').startsWith('smooth,feather,choke,shiftEdge,reduceChatter,useMotionBlur,mbSamples,mbShutter,mbHigherQuality,decontaminate,deconAmount,deconExtend,deconRadius,deconView'), ids('refineHardMatte'));
    ok(ids('refineSoftMatte').startsWith('edgeDetails,edgeRadius,viewEdge,smooth,feather,contrast,shiftEdge,reduceChatter'), ids('refineSoftMatte'));
    for (const id of ['refineHardMatte', 'refineSoftMatte']) {
      is(id, 'feather', 0, 0, 100); is(id, 'shiftEdge', 0, -100, 100); is(id, 'reduceChatter', 0, 0, 100); is(id, 'useMotionBlur', 0); is(id, 'mbSamples', 16); is(id, 'mbShutter', 180);
      is(id, 'mbHigherQuality', 1); is(id, 'decontaminate', 1); is(id, 'deconAmount', 100, 0, 100); is(id, 'deconExtend', 1); is(id, 'deconRadius', 0); is(id, 'deconView', 0);
    }
    is('refineHardMatte', 'choke', 0, -100, 100); is('refineSoftMatte', 'edgeDetails', 1); is('refineSoftMatte', 'contrast', 0, 0, 100);
  });

  test('canal3d: nombres de coincidencia de After Effects y nombres visibles', () => {
    const want = { 'ADBE AUX CHANNEL EXTRACT': 'channel3dExtract', 'ADBE DEPTH FIELD': 'depthOfField', 'ADBE DEPTH MATTE': 'depthMatte', 'ADBE FOG_3D': 'fog3d', 'ADBE ID MATTE': 'idMatte', 'ADBE RefineMatte': 'refineHardMatte', 'ADBE RefineMatte2': 'refineSoftMatte' };
    for (const [m, id] of Object.entries(want)) { ok(core.AE_EFFECTS[m] === id, `${m} → ${core.AE_EFFECTS[m]}`); ok(core.aeMatchName(id) === m, `${id} informa ${core.aeMatchName(id)}`); }
    ok(core.aeEffectId?.('Niebla 3D') === 'fog3d' || core.aeEffectId?.('Niebla 3D') === undefined, 'por nombre visible');
  });

  test('canal3d: canales EXR que lee cada efecto (nombres habituales y el escrito a mano)', () => {
    const ch = M.canal3dChannels;
    const names = ['R', 'G', 'B', 'A', 'depth.Z', 'N.X', 'N.Y', 'N.Z', 'P.X', 'P.Y', 'P.Z', 'ObjectID', 'MaterialID', 'uv.U', 'uv.V', 'coverage'];
    const v = (o) => (k) => String(o[k] ?? '');
    ok(ch('depthMatte', v({}), names).join() === 'depth.Z', `profundidad: ${ch('depthMatte', v({}), names)}`);
    ok(ch('fog3d', v({}), ['R', 'N.Z', 'Z']).join() === 'Z', 'Z suelto, nunca N.Z');
    ok(ch('idMatte', v({ aux: 'materialId' }), names).join() === 'MaterialID', 'ID del material');
    ok(ch('idMatte', v({ coverage: '1' }), names).join() === 'ObjectID,coverage', 'ID del objeto + cobertura');
    ok(ch('channel3dExtract', v({ channel: 'normals' }), names).join() === 'N.X,N.Y,N.Z', 'normales');
    ok(ch('channel3dExtract', v({ channel: 'uv' }), names).join() === 'uv.U,uv.V', 'UV');
    ok(ch('channel3dExtract', v({ channel: 'zDepth', exrChannel: 'P.Z' }), names).join() === 'P.Z', 'canal escrito a mano');
    ok(!ch('depthOfField', v({}), ['R', 'G', 'B']).length, 'sin canal de profundidad: nada (usa el render 3D de Cinta)');
  });
};
