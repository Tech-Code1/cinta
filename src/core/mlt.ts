// Export to MLT XML (opens in Shotcut and Kdenlive): media, main/overlay/audio playlists, cuts, gaps,
// volume and mutes. Effects that MLT cannot express 1:1 are left out (listed in the result).
import { clipDuration, mediaOf, projectDuration, trackClips, type Project } from './model';

const esc = (s: string | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toMlt(p: Project): { xml: string; skipped: string[] } {
  const fps = p.settings.fps;
  const fr = (s: number) => Math.max(0, Math.round(s * fps));
  const skipped = new Set<string>();
  const prod: string[] = [];
  const producerOf = new Map<string, string>();
  p.media.forEach((m, i) => {
    const id = `producer${i}`;
    producerOf.set(m.id, id);
    const len = m.kind === 'image' ? fr(3600) : fr(m.duration);
    prod.push(`  <producer id="${id}" in="0" out="${Math.max(0, len - 1)}">\n    <property name="length">${len}</property>\n    <property name="resource">${esc(m.path.replace(/\\/g, '/'))}</property>\n    <property name="mlt_service">${m.kind === 'image' ? 'qimage' : 'avformat-novalidate'}</property>\n  </producer>`);
  });
  const colorProducers: string[] = [];
  const playlists: string[] = [];
  const tracks: { id: string; hide?: string }[] = [];
  // MLT stacks bottom → top: background, main, overlays (reverse display order), audio
  const order = [...p.tracks.filter((t) => t.kind === 'main'), ...[...p.tracks].reverse().filter((t) => t.kind === 'overlay'), ...p.tracks.filter((t) => t.kind === 'audio')];
  for (const t of p.tracks) if (t.kind === 'title' && trackClips(p, t.id).length) skipped.add('títulos (MLT no tiene un equivalente directo; expórtelos como .srt)');
  order.forEach((t, ti) => {
    const id = `playlist${ti}`;
    const items: string[] = [];
    let at = 0;
    for (const c of trackClips(p, t.id)) {
      if (c.start > at + 1 / fps) items.push(`    <blank length="${fr(c.start - at)}"/>`);
      const m = mediaOf(p, c);
      let producer = m ? producerOf.get(m.id) : undefined;
      if (c.type === 'color') {
        producer = `color${colorProducers.length}`;
        colorProducers.push(`  <producer id="${producer}" in="0" out="${fr(clipDuration(c)) - 1}">\n    <property name="mlt_service">color</property>\n    <property name="resource">${esc(c.fill?.startsWith('#') ? c.fill : '#000000')}</property>\n  </producer>`);
      }
      if (!producer) { skipped.add(`${c.type} (${c.name ?? c.id})`); continue; }
      const inF = c.type === 'color' ? 0 : fr(c.in), outF = c.type === 'color' ? fr(clipDuration(c)) - 1 : fr(c.out) - 1;
      const filters: string[] = [];
      if (c.volume !== 1 || c.muted) filters.push(`      <filter><property name="mlt_service">volume</property><property name="level">${c.muted ? -99 : (20 * Math.log10(Math.max(1e-4, c.volume))).toFixed(2)}</property></filter>`);
      if (c.speed !== 1 || c.reverse) skipped.add('velocidad / invertir');
      if (c.filters.length || c.color || c.transition) skipped.add('filtros, color y transiciones');
      items.push(filters.length ? `    <entry producer="${producer}" in="${inF}" out="${outF}">\n${filters.join('\n')}\n    </entry>` : `    <entry producer="${producer}" in="${inF}" out="${outF}"/>`);
      at = c.start + clipDuration(c);
    }
    const hide = t.kind === 'audio' ? 'video' : t.muted ? 'audio' : undefined;
    playlists.push(`  <playlist id="${id}">\n    <property name="shotcut:name">${esc(t.name)}</property>\n${t.kind === 'audio' ? '    <property name="shotcut:audio">1</property>\n' : ''}${items.join('\n')}\n  </playlist>`);
    tracks.push({ id, hide });
  });
  const total = fr(projectDuration(p));
  const bg = `  <producer id="black" in="0" out="${Math.max(0, total - 1)}">\n    <property name="mlt_service">color</property>\n    <property name="resource">${esc(p.settings.background)}</property>\n  </producer>\n  <playlist id="background">\n    <entry producer="black" in="0" out="${Math.max(0, total - 1)}"/>\n  </playlist>`;
  const transitions = tracks.map((_, i) => `    <transition><property name="mlt_service">mix</property><property name="a_track">0</property><property name="b_track">${i + 1}</property><property name="always_active">1</property><property name="sum">1</property></transition>\n    <transition><property name="mlt_service">frei0r.cairoblend</property><property name="a_track">0</property><property name="b_track">${i + 1}</property></transition>`);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.0.0" title="${esc(p.name)}" producer="main_bin">
  <profile description="Cinta" width="${p.settings.width}" height="${p.settings.height}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${p.settings.width}" display_aspect_den="${p.settings.height}" frame_rate_num="${Math.round(fps * 1000)}" frame_rate_den="1000" colorspace="709"/>
${prod.join('\n')}
${colorProducers.join('\n')}
${bg}
${playlists.join('\n')}
  <tractor id="tractor0" title="${esc(p.name)}" in="0" out="${Math.max(0, total - 1)}">
    <track producer="background"/>
${tracks.map((t) => `    <track producer="${t.id}"${t.hide ? ` hide="${t.hide}"` : ''}/>`).join('\n')}
${transitions.join('\n')}
  </tractor>
</mlt>
`;
  return { xml, skipped: [...skipped] };
}
