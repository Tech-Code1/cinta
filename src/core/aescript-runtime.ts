// @ts-nocheck — this function is not run here: its source is evaluated INSIDE the script sandbox (a separate V8
// context with no require / process), so it must be self-contained plain JavaScript. It builds After Effects'
// ExtendScript globals (app, CompItem, File, $, alert…) as thin handles; every member access goes through one
// string bridge to the host (aescript.ts), so no host object or function is ever reachable from the script.
export function aeRuntime(bridge, kindsJson) {
  'use strict';
  var kinds = JSON.parse(kindsJson);
  var G = globalThis;
  var cache = {};
  var enc = function (v) {
    if (v === undefined) return null;
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? null : v;
    if (v.__h) return { $h: v.__h };
    if (v instanceof TextDocument) return { $td: { text: v.text, fontSize: v.fontSize, fillColor: v.fillColor, strokeColor: v.strokeColor, strokeWidth: v.strokeWidth, font: v.font, justification: v.justification, applyFill: v.applyFill, applyStroke: v.applyStroke, tracking: v.tracking } };
    if (v instanceof File || v instanceof Folder) return { $file: v.fsName };
    if (Array.isArray(v)) return v.map(enc);
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = enc(v[k]);
    return o;
  };
  var dec = function (v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(dec);
    if (v.$h) return handle(v.$h);
    if (v.$td) { var td = new TextDocument(v.$td.text); for (var k in v.$td) td[k] = v.$td[k]; return td; }
    if (v.$file) return v.dir ? new Folder(v.$file) : new File(v.$file);
    if (v.$ease) return new KeyframeEase(v.$ease[0], v.$ease[1]);
    var o = {};
    for (var k2 in v) o[k2] = dec(v[k2]);
    return o;
  };
  var call = function (h, op, n, a) {
    var r = JSON.parse(bridge(JSON.stringify({ h: h, op: op, n: n, a: enc(a || []) })));
    if (r.e) { var err = new Error(r.e); err.name = 'Error'; throw err; }
    return dec(r.v);
  };
  var CLASSES = {};
  var cls = function (name, parent) {
    var C = function () { throw new Error('No se puede crear «' + name + '» con new: use los métodos de app.project.'); };
    if (parent) C.prototype = Object.create(parent.prototype);
    Object.defineProperty(C.prototype, 'constructor', { value: C, enumerable: false });
    Object.defineProperty(C, 'name', { value: name });
    CLASSES[name] = C;
    G[name] = C;
    return C;
  };
  var Item = cls('Item'), AVItem = cls('AVItem', Item);
  cls('CompItem', AVItem); cls('FootageItem', AVItem); cls('FolderItem', Item);
  cls('Application'); cls('Project'); cls('ItemCollection'); cls('LayerCollection');
  var PropertyBase = cls('PropertyBase');
  cls('PropertyGroup', PropertyBase); cls('Property', PropertyBase); cls('MaskPropertyGroup', CLASSES.PropertyGroup);
  var Layer = cls('Layer'), AVLayer = cls('AVLayer', Layer);
  cls('TextLayer', AVLayer); cls('ShapeLayer', AVLayer); cls('CameraLayer', Layer); cls('LightLayer', Layer);

  // a handle: a Proxy whose prototype is the class (instanceof works); members are bridged to the host
  var handle = function (h) {
    var key = JSON.stringify(h);
    if (cache[key]) return cache[key];
    var info = kinds[h.k] || { cls: 'Item', fn: [] };
    var target = Object.create(CLASSES[(h.t && kinds[h.k].sub && kinds[h.k].sub[h.t]) || info.cls].prototype);
    Object.defineProperty(target, '__h', { value: h, enumerable: false });
    var fns = {};
    var p = new Proxy(target, {
      get: function (t, n) {
        if (n === '__h') return h;
        if (typeof n === 'symbol') return n === Symbol.toPrimitive ? function () { return '[object ' + (info.cls) + ']'; } : undefined;
        if (n === 'toString' || n === 'toSource') return function () { return '[object ' + (info.cls) + ']'; };
        if (n === 'valueOf') return function () { return p; };
        if (n === 'constructor') return Object.getPrototypeOf(t).constructor;
        if (info.idx && /^\d+$/.test(n)) return call(h, 'call', info.idx, [Number(n)]);
        if (info.fn.indexOf(n) >= 0) return fns[n] || (fns[n] = function () { return call(h, 'call', n, Array.prototype.slice.call(arguments)); });
        // groups: properties are also reachable by name (layer.transform.position, layer.Effects, group.Opacity…)
        return call(h, 'get', n);
      },
      set: function (t, n, v) { if (typeof n === 'symbol') return false; call(h, 'set', n, [v]); return true; },
      has: function (t, n) { return typeof n === 'string' && (info.fn.indexOf(n) >= 0 || call(h, 'has', n) === true); },
    });
    cache[key] = p;
    return p;
  };

  // ── value types ──
  G.KeyframeEase = function KeyframeEase(speed, influence) { if (!(this instanceof KeyframeEase)) return new KeyframeEase(speed, influence); this.speed = Number(speed) || 0; this.influence = Math.max(0.1, Math.min(100, Number(influence) || 16.666667)); };
  G.TextDocument = function TextDocument(text) { if (!(this instanceof TextDocument)) return new TextDocument(text); this.text = text === undefined ? '' : String(text); };
  TextDocument.prototype.resetCharStyle = function () {};
  TextDocument.prototype.resetParagraphStyle = function () {};
  G.ImportOptions = function ImportOptions(file) { if (!(this instanceof ImportOptions)) return new ImportOptions(file); this.file = file; this.importAs = 0; this.sequence = false; this.forceAlphabetical = false; };
  ImportOptions.prototype.canImportAs = function () { return true; };
  G.Shape = function Shape() { if (!(this instanceof Shape)) return new Shape(); this.vertices = []; this.inTangents = []; this.outTangents = []; this.closed = true; };
  G.MarkerValue = function MarkerValue(comment) { if (!(this instanceof MarkerValue)) return new MarkerValue(comment); this.comment = comment || ''; this.duration = 0; };

  // ── enums (After Effects' values) ──
  G.KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
  G.LightType = { PARALLEL: 4401, SPOT: 4402, POINT: 4403, AMBIENT: 4404 };
  G.ParagraphJustification = { LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415, FULL_JUSTIFY_LASTLINE_LEFT: 7416, FULL_JUSTIFY_LASTLINE_RIGHT: 7417, FULL_JUSTIFY_LASTLINE_CENTER: 7418, FULL_JUSTIFY_LASTLINE_FULL: 7419 };
  G.PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
  G.PropertyValueType = { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424 };
  G.BlendingMode = { NORMAL: 5212, ADD: 5220, MULTIPLY: 5216, SCREEN: 5219, OVERLAY: 5224, SOFT_LIGHT: 5225, HARD_LIGHT: 5226, COLOR_DODGE: 5221, COLOR_BURN: 5217, DARKEN: 5215, LIGHTEN: 5218, DIFFERENCE: 5231, EXCLUSION: 5232, HUE: 5234, SATURATION: 5235, COLOR: 5236, LUMINOSITY: 5237 };
  G.TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 };
  G.ImportAsType = { COMP_CROPPED_LAYERS: 3812, FOOTAGE: 3813, COMP: 3814, PROJECT: 3815 };
  G.CloseOptions = { DO_NOT_SAVE_CHANGES: 1212, PROMPT_TO_SAVE_CHANGES: 1213, SAVE_CHANGES: 1214 };
  G.AutoOrientType = { ALONG_PATH: 4213, CAMERA_OR_POINT_OF_INTEREST: 4214, NO_AUTO_ORIENT: 4212 };

  // ── output ──
  var str = function (a) { return Array.prototype.map.call(a, function (x) { return x === undefined ? 'undefined' : x === null ? 'null' : typeof x === 'object' && !x.__h && !Array.isArray(x) && !(x instanceof File) && !(x instanceof Folder) ? (function () { try { return JSON.stringify(x); } catch (e) { return String(x); } })() : String(x); }).join(' '); };
  var log = function (kind, text) { call({ k: 'App' }, 'call', '__log', [kind, text]); };
  G.alert = function (m, title) { log('alert', (title ? title + ': ' : '') + str([m])); };
  G.confirm = function (m) { log('confirm', str([m])); return true; };
  G.prompt = function (m, def) { log('prompt', str([m])); return def === undefined ? '' : def; };
  G.writeLn = function () { log('log', str(arguments)); };
  G.localize = function (s) { if (s && typeof s === 'object') return s.es || s.en || ''; var a = Array.prototype.slice.call(arguments, 1); return String(s).replace(/%(\d+)/g, function (m, i) { return a[i - 1] === undefined ? m : a[i - 1]; }); };
  G.isValid = function (o) { if (!o) return false; if (o.__h) return call(o.__h, 'has', '__valid') === true; return true; };
  G.$ = {
    writeln: function () { log('log', str(arguments)); },
    write: function () { log('write', str(arguments)); },
    sleep: function () {}, gc: function () {}, bp: function () {}, clearbp: function () {},
    os: 'Windows', version: '4.5.5', engineName: 'main', level: 0, buildDate: new Date(0), locale: 'es_ES', screens: [],
    global: G, error: null, hiresTimer: 0,
    getenv: function () { return null; }, setenv: function () {},
    evalFile: function (f) { var src = call({ k: 'App' }, 'call', '__read', [f instanceof File ? f.fsName : String(f)]); return (0, eval)(src); },
  };
  Object.defineProperty(G.$, 'fileName', { get: function () { return call({ k: 'App' }, 'call', '__fileName', []); } });
  G.app = handle({ k: 'App' });

  // ── File / Folder: reading only, inside the allowed folders ──
  var fsx = function (op, path, a) { return call({ k: 'App' }, 'call', '__fs', [op, path].concat(a || [])); };
  var FsBase = function () {};
  var defPath = function (C) {
    Object.defineProperties(C.prototype, {
      fsName: { get: function () { return this._p; } },
      fullName: { get: function () { return this._p.replace(/\\/g, '/'); } },
      absoluteURI: { get: function () { return this._p.replace(/\\/g, '/'); } },
      name: { get: function () { return this._p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(); } },
      displayName: { get: function () { return this.name; } },
      path: { get: function () { var a = this._p.replace(/[\\/]+$/, '').split(/[\\/]/); a.pop(); return a.join('/'); } },
      parent: { get: function () { return new Folder(this.path); } },
      exists: { get: function () { return fsx('exists', this._p, [C === Folder]); } },
      modified: { get: function () { return new Date(fsx('mtime', this._p)); } },
    });
    C.prototype.toString = function () { return this.fullName; };
    C.prototype.toSource = function () { return 'new ' + (C === Folder ? 'Folder' : 'File') + '(' + JSON.stringify(this.fullName) + ')'; };
    C.prototype.getRelativeURI = function () { return this.fullName; };
    C.prototype.create = function () { this.error = 'Los scripts no pueden escribir archivos.'; return false; };
    C.prototype.remove = function () { this.error = 'Los scripts no pueden borrar archivos.'; return false; };
    C.prototype.rename = function () { this.error = 'Los scripts no pueden cambiar archivos.'; return false; };
    C.prototype.execute = function () { return false; };
  };
  G.File = function File(p) {
    if (!(this instanceof File)) return new File(p);
    this._p = fsx('resolve', p === undefined ? '' : String(p instanceof File ? p.fsName : p));
    this.encoding = 'UTF-8'; this.lineFeed = 'Windows'; this.error = ''; this._t = null; this._i = 0; this.eof = true;
  };
  G.File.prototype = Object.create(FsBase.prototype);
  defPath(G.File);
  Object.defineProperty(G.File.prototype, 'length', { get: function () { return fsx('size', this._p); } });
  G.File.prototype.open = function (mode) {
    if (mode && !/^r/i.test(mode)) { this.error = 'Los scripts no pueden escribir archivos (solo lectura).'; return false; }
    try { this._t = fsx('read', this._p); this._i = 0; this.eof = this._t.length === 0; return true; } catch (e) { this.error = e.message; return false; }
  };
  G.File.prototype.close = function () { this._t = null; this.eof = true; return true; };
  G.File.prototype.read = function (n) {
    if (this._t === null) { if (!this.open('r')) return ''; }
    var s = n === undefined ? this._t.slice(this._i) : this._t.substr(this._i, n);
    this._i += s.length; this.eof = this._i >= this._t.length; return s;
  };
  G.File.prototype.readln = function () {
    if (this._t === null) { if (!this.open('r')) return ''; }
    var j = this._t.indexOf('\n', this._i); var s = j < 0 ? this._t.slice(this._i) : this._t.slice(this._i, j);
    this._i = j < 0 ? this._t.length : j + 1; this.eof = this._i >= this._t.length; return s.replace(/\r$/, '');
  };
  G.File.prototype.readch = function () { return this.read(1); };
  G.File.prototype.seek = function (pos) { this._i = Number(pos) || 0; return true; };
  G.File.prototype.tell = function () { return this._i; };
  G.File.prototype.write = G.File.prototype.writeln = function () { this.error = 'Los scripts no pueden escribir archivos (solo lectura).'; return false; };
  G.File.prototype.copy = function () { this.error = 'Los scripts no pueden escribir archivos.'; return false; };
  G.File.openDialog = G.File.saveDialog = function () { return null; };
  G.File.prototype.openDlg = G.File.prototype.saveDlg = function () { return null; };
  G.File.decode = function (s) { return decodeURIComponent(s); };
  G.File.encode = function (s) { return encodeURIComponent(s); };
  G.File.fs = 'Windows';
  G.Folder = function Folder(p) {
    if (!(this instanceof Folder)) return new Folder(p);
    this._p = fsx('resolve', p === undefined ? '' : String(p instanceof Folder || p instanceof File ? p.fsName : p)); this.error = '';
  };
  G.Folder.prototype = Object.create(FsBase.prototype);
  defPath(G.Folder);
  G.Folder.prototype.getFiles = function (mask) {
    var list = fsx('list', this._p), out = [];
    var re = typeof mask === 'string' ? new RegExp('^' + mask.split(';').map(function (m) { return m.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'); }).join('$|^') + '$', 'i') : null;
    for (var i = 0; i < list.length; i++) {
      var it = list[i], f = it.dir ? new Folder(it.path) : new File(it.path);
      if (typeof mask === 'function' ? mask(f) : !re || re.test(f.name)) out.push(f);
    }
    return out;
  };
  G.Folder.prototype.selectDlg = function () { return null; };
  G.Folder.selectDialog = function () { return null; };
  G.Folder.decode = G.File.decode; G.Folder.encode = G.File.encode; G.Folder.fs = 'Windows';
  Object.defineProperty(G.Folder, 'current', { get: function () { return new Folder(fsx('cwd', '')); } });
  ['temp', 'desktop', 'myDocuments', 'userData', 'appData', 'commonFiles', 'system', 'startup', 'trash', 'appPackage'].forEach(function (k) {
    Object.defineProperty(G.Folder, k, { get: function () { return new Folder(fsx('special', k)); } });
  });
  // ExtendScript extras missing in modern JavaScript
  if (!Object.prototype.toSource) Object.defineProperty(Object.prototype, 'toSource', { value: function () { try { return '(' + JSON.stringify(this) + ')'; } catch (e) { return String(this); } }, writable: true, configurable: true });
  G.uneval = function (x) { return x === undefined ? 'undefined' : JSON.stringify(x); };
}
