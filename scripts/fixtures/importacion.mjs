// Test files for «importacion», written by the tests themselves: Cineon, DNG, a raw file with an embedded preview,
// HEIC (single and grid, from x265), a Premiere Pro project and a Maya ASCII scene.
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

/** 10-bit Cineon, 3 samples per word; code(x, y) → [r, g, b] code values 0…1023. */
export function cineon(w, h, code) {
  const off = 2048, b = Buffer.alloc(off + w * h * 4);
  b.writeUInt32BE(0x802a5fd7, 0); b.writeUInt32BE(off, 4); b.writeUInt32BE(1024, 8); b.writeUInt32BE(1024, 12); b.writeUInt32BE(0, 16); b.writeUInt32BE(b.length, 20);
  b.write('V4.5', 24, 'latin1');
  b[192] = 0; b[193] = 3;
  for (let c = 0; c < 3; c++) { const p = 196 + c * 28; b[p] = 0; b[p + 1] = c + 1; b[p + 2] = 10; b.writeUInt32BE(w, p + 4); b.writeUInt32BE(h, p + 8); }
  b[680] = 0; b[681] = 5; b.writeUInt32BE(0, 684); b.writeUInt32BE(0, 688);
  let p = off;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, bb] = code(x, y); b.writeUInt32BE(((r << 22) | (g << 12) | (bb << 2)) >>> 0, p); p += 4; }
  return b;
}

/** A TIFF from tags: [tag, type, values] (1 byte, 2 ascii, 3 short, 4 long, 5 rational, 10 srational) + one strip. */
function tiff(tags, strip) {
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };
  const all = [...tags, [273, 4, [0]], [279, 4, [strip.length]]].sort((a, b) => a[0] - b[0]);
  const n = all.length, ifd = Buffer.alloc(2 + n * 12 + 4), blobs = [];
  ifd.writeUInt16LE(n, 0);
  let data = 8 + ifd.length, stripAt = -1;
  all.forEach(([tag, type, v], i) => {
    const o = 2 + i * 12, count = type === 2 ? v.length : v.length;
    ifd.writeUInt16LE(tag, o); ifd.writeUInt16LE(type, o + 2); ifd.writeUInt32LE(count, o + 4);
    let b;
    if (type === 2) b = Buffer.from(v, 'latin1');
    else { b = Buffer.alloc(SIZE[type] * v.length); v.forEach((x, k) => { if (type === 1 || type === 7) b.writeUInt8(x, k); else if (type === 3) b.writeUInt16LE(x, k * 2); else if (type === 4) b.writeUInt32LE(x, k * 4); else { b.writeInt32LE(x[0], k * 8); b.writeInt32LE(x[1], k * 8 + 4); } }); }
    if (tag === 273) stripAt = o + 8;
    if (b.length <= 4) b.copy(ifd, o + 8);
    else { ifd.writeUInt32LE(data, o + 8); blobs.push(b); data += b.length; if (b.length & 1) { blobs.push(Buffer.alloc(1)); data++; } }
  });
  ifd.writeUInt32LE(data, stripAt);
  return Buffer.concat([Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]), ifd, ...blobs, strip]);
}
/** Uncompressed CFA DNG (RGGB); left half red, right half blue. */
export function dng(W = 64, H = 48) {
  const px = Buffer.alloc(W * H * 2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = y % 2 === 0 ? (x % 2 === 0 ? 'R' : 'G') : (x % 2 === 0 ? 'G' : 'B'), red = x < W / 2;
    px.writeUInt16LE(c === 'R' ? (red ? 60000 : 2000) : c === 'B' ? (red ? 2000 : 60000) : 4000, (y * W + x) * 2);
  }
  return tiff([[254, 4, [0]], [256, 4, [W]], [257, 4, [H]], [258, 3, [16]], [259, 3, [1]], [262, 3, [32803]], [277, 3, [1]], [278, 4, [H]], [284, 3, [1]],
    [33421, 3, [2, 2]], [33422, 1, [0, 1, 1, 2]], [50706, 1, [1, 4, 0, 0]], [50707, 1, [1, 1, 0, 0]], [50708, 2, 'Cinta\0'], [50717, 4, [65535]],
    [50721, 10, [[1, 1], [0, 1], [0, 1], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1], [1, 1]]], [50728, 5, [[1, 1], [1, 1], [1, 1]]]], px);
}
/** A "raw" file the way cameras write them: TIFF header, a small thumbnail, the lossless raw data (SOF3) and the
 *  full-size JPEG preview. */
export function fakeRaw(ff, dir, color = 'green') {
  const big = ff('-f', 'lavfi', '-i', `color=c=${color}:s=320x200`, '-frames:v', '1', '-f', 'mjpeg', 'pipe:1');
  const small = ff('-f', 'lavfi', '-i', 'color=c=red:s=80x50', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1');
  const lossless = Buffer.from([0xff, 0xd8, 0xff, 0xc3, 0, 11, 8, 0x0f, 0xa0, 0x0f, 0xa0, 1, 1, 0x11, 0, 0xff, 0xd9]);
  return Buffer.concat([tiff([[256, 4, [80]], [257, 4, [50]], [259, 3, [6]], [274, 3, [1]]], small), lossless, Buffer.alloc(64), big]);
}

// ── HEIC: x265 tiles wrapped in a HEIF container ──
const box = (type, ...parts) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
const full = (type, v, flags, ...parts) => box(type, Buffer.from([v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const u16 = (x) => { const b = Buffer.alloc(2); b.writeUInt16BE(x); return b; };
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x); return b; };
function nals(b) {
  const pos = [];
  for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) { pos.push(i + 3); i += 2; }
  return pos.map((s, k) => { let e = k + 1 < pos.length ? pos[k + 1] - 3 : b.length; while (e > s && b[e - 1] === 0) e--; return b.subarray(s, e); });
}
/** HEIC with one image or a grid of `colors` tiles (each tw×th) cropped to outW×outH. */
export function heic(ff, colors, tw, th, outW, outH) {
  const tiles = colors.map((c) => nals(ff('-f', 'lavfi', '-i', `color=c=${c}:s=${tw}x${th}`, '-frames:v', '1', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-pix_fmt', 'yuv420p', '-f', 'hevc', 'pipe:1')));
  const typ = (n) => (n[0] >> 1) & 63;
  const ps = tiles[0].filter((n) => [32, 33, 34].includes(typ(n)));
  const hvcC = box('hvcC', Buffer.alloc(21), Buffer.from([3, ps.length]), ...ps.map((n) => Buffer.concat([Buffer.from([typ(n)]), u16(1), u16(n.length), n])));
  const ispe = (w, h) => full('ispe', 0, 0, u32(w), u32(h));
  const data = tiles.map((t) => Buffer.concat(t.filter((n) => !([32, 33, 34].includes(typ(n)))).map((n) => Buffer.concat([u32(n.length), n]))));
  const grid = colors.length > 1;
  const ids = grid ? colors.map((_, i) => i + 2) : [1];
  const gridData = grid ? Buffer.concat([Buffer.from([0, 0, 0, colors.length - 1]), u16(outW), u16(outH)]) : null;
  const items = grid ? [{ id: 1, type: 'grid', data: gridData }, ...ids.map((id, i) => ({ id, type: 'hvc1', data: data[i] }))] : [{ id: 1, type: 'hvc1', data: data[0] }];
  const iinf = full('iinf', 0, 0, u16(items.length), ...items.map((it) => full('infe', 2, 0, u16(it.id), u16(0), Buffer.from(it.type, 'latin1'), Buffer.from([0]))));
  // properties: 1 hvcC, 2 ispe tile, 3 ispe grid
  const ipco = box('ipco', hvcC, ispe(tw, th), ispe(outW, outH));
  const assoc = items.map((it) => (it.type === 'grid' ? [it.id, [3]] : [it.id, [0x81, 2]]));
  const ipma = full('ipma', 0, 0, u32(assoc.length), ...assoc.map(([id, ps2]) => Buffer.concat([u16(id), Buffer.from([ps2.length, ...ps2])])));
  const iref = grid ? full('iref', 0, 0, box('dimg', u16(1), u16(ids.length), ...ids.map(u16))) : Buffer.alloc(0);
  const build = (offsets) => {
    const iloc = full('iloc', 0, 0, Buffer.from([0x44, 0x00]), u16(items.length), ...items.map((it, k) => Buffer.concat([u16(it.id), u16(0), u16(1), u32(offsets[k]), u32(it.data.length)])));
    return full('meta', 0, 0, full('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)), full('pitm', 0, 0, u16(1)), iloc, iinf, iref, box('iprp', ipco, ipma));
  };
  const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1'));
  const metaLen = build(items.map(() => 0)).length;
  let at = ftyp.length + metaLen + 8;
  const offs = items.map((it) => { const o = at; at += it.data.length; return o; });
  return Buffer.concat([ftyp, build(offs), box('mdat', ...items.map((it) => it.data))]);
}

// ── Premiere Pro project ──
const T = 254016000000;
/** seqs: [{ name, w, h, fps, video: [[{ file, start, end, in }]], audio: [[…]] , nested?: [{ seq, start, end }] }] */
export function prproj(seqs) {
  let id = 100;
  const out = [];
  const media = new Map();
  const mediaUid = (file) => { if (!media.has(file)) { const u = `m-${media.size + 1}`; media.set(file, u); out.push(`<Media ObjectUID="${u}" ClassID="x" Version="30"><ActualMediaFilePath>${file.replace(/&/g, '&amp;')}</ActualMediaFilePath><FilePath>${file.replace(/&/g, '&amp;')}</FilePath></Media>`); } return media.get(file); };
  const item = (kind, c, seqUid) => {
    const ti = id++, sub = id++, clip = id++, src = id++;
    out.push(`<${kind}ClipTrackItem ObjectID="${ti}" ClassID="x" Version="8"><ClipTrackItem Version="8"><TrackItem Version="4"><Start>${Math.round(c.start * T)}</Start><End>${Math.round(c.end * T)}</End></TrackItem><SubClip ObjectRef="${sub}"/></ClipTrackItem></${kind}ClipTrackItem>`);
    out.push(`<SubClip ObjectID="${sub}" ClassID="x" Version="5"><Clip ObjectRef="${clip}"/><Name>${c.name ?? 'clip'}</Name></SubClip>`);
    out.push(`<${kind}Clip ObjectID="${clip}" ClassID="x" Version="11"><Clip Version="18"><Source ObjectRef="${src}"/><InPoint>${Math.round((c.in ?? 0) * T)}</InPoint><OutPoint>${Math.round(((c.in ?? 0) + (c.srcLen ?? c.end - c.start)) * T)}</OutPoint></Clip></${kind}Clip>`);
    if (seqUid) out.push(`<${kind}SequenceSource ObjectID="${src}" ClassID="x" Version="4"><SequenceSource Version="4"><Sequence ObjectURef="${seqUid}"/></SequenceSource></${kind}SequenceSource>`);
    else out.push(`<${kind}MediaSource ObjectID="${src}" ClassID="x" Version="2"><MediaSource Version="2"><Media ObjectURef="${mediaUid(c.file)}"/></MediaSource></${kind}MediaSource>`);
    return ti;
  };
  seqs.forEach((s, si) => {
    const groups = [];
    for (const kind of ['Video', 'Audio']) {
      const tracks = (kind === 'Video' ? s.video : s.audio) ?? [];
      const trackUids = tracks.map((clips, ti) => {
        const items = clips.map((c) => item(kind, c, c.seq !== undefined ? `seq-${c.seq + 1}` : null));
        const u = `${kind[0]}t-${si}-${ti}`;
        out.push(`<${kind}ClipTrack ObjectUID="${u}" ClassID="x" Version="2"><ClipTrack Version="3"><Track Version="2"/><ClipItems Version="3"><TrackItems Version="1">${items.map((x, k) => `<TrackItem Index="${k}" ObjectRef="${x}"/>`).join('')}</TrackItems></ClipItems></ClipTrack></${kind}ClipTrack>`);
        return u;
      });
      const g = id++;
      out.push(`<${kind}TrackGroup ObjectID="${g}" ClassID="x" Version="1"><TrackGroup Version="1"><Tracks Version="1">${trackUids.map((u, k) => `<Track Index="${k}" ObjectURef="${u}"/>`).join('')}</Tracks><FrameRate>${Math.round(T / (s.fps ?? 25))}</FrameRate></TrackGroup>${kind === 'Video' ? `<FrameRect>0,0,${s.w},${s.h}</FrameRect>` : ''}</${kind}TrackGroup>`);
      groups.push(g);
    }
    out.push(`<Sequence ObjectUID="seq-${si + 1}" ClassID="x" Version="11"><Node Version="1"><Properties Version="1"/></Node><Name>${s.name}</Name><TrackGroups Version="1">${groups.map((g, k) => `<TrackGroup Version="1" Index="${k}"><First>{0000}</First><Second ObjectRef="${g}"/></TrackGroup>`).join('')}</TrackGroups></Sequence>`);
  });
  return gzipSync(Buffer.from(`<?xml version="1.0" encoding="UTF-8" ?>\n<PremiereData Version="3"><Project ObjectRef="1"/>${out.join('\n')}</PremiereData>`, 'utf8'));
}

/** Maya ASCII: camera1 at (0, 0, 1000) looking down −Z, moving +X 0 → 240 from frame 1 to 25 (24 fps), 35 mm on a
 *  36 mm gate (horizontal fit); a locator at (100, 50, 0); 1920×1080. */
export function mayaScene() {
  return `//Maya ASCII 2024 scene
//Name: cam.ma
requires maya "2024";
currentUnit -l centimeter -a degree -t film;
createNode transform -s -n "persp";
	setAttr ".t" -type "double3" 28 21 28 ;
createNode camera -s -n "perspShape" -p "persp";
	setAttr ".fl" 34.999999999999993;
createNode transform -n "camera1";
	setAttr ".t" -type "double3" 0 0 1000 ;
	setAttr ".r" -type "double3" 0 0 0 ;
createNode camera -n "cameraShape1" -p "camera1";
	setAttr -k off ".v";
	setAttr ".rnd" no;
	setAttr ".cap" -type "double2" 1.4173228346456692 0.94488188976377951 ;
	setAttr ".ff" 1;
	setAttr ".fl" 35;
createNode transform -n "locator1";
	setAttr ".t" -type "double3" 100 50 0 ;
createNode locator -n "locatorShape1" -p "locator1";
createNode animCurveTL -n "camera1_translateX";
	setAttr ".tan" 18;
	setAttr ".wgt" no;
	setAttr -s 2 ".ktv[0:1]"  1 0 25 240;
createNode script -n "sceneConfigurationScriptNode";
	setAttr ".b" -type "string" "playbackOptions -min 1 -max 25 -ast 1 -aet 25 ";
	setAttr ".st" 6;
select -ne :defaultResolution;
	setAttr ".w" 1920;
	setAttr ".h" 1080;
connectAttr "camera1_translateX.o" "camera1.tx";
// End of cam.ma
`;
}
export const runFf = (FF) => (...a) => execFileSync(FF, ['-hide_banner', '-v', 'error', '-y', ...a], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
