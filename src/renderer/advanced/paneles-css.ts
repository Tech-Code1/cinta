// Styles of the «paneles» line (views, flowchart, properties, shortcuts, media browser, metadata), added once.
const done = new Set<string>();
export function css(id: string, text: string) {
  if (done.has(id)) return;
  done.add(id);
  const s = document.createElement('style');
  s.dataset.css = id;
  s.textContent = text;
  document.head.append(s);
}
