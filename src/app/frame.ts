// Range.toString() and the TreeWalker use the same body-text order for offsets.

import type { Heading } from "./anchor.js";

export function measure(doc: Document, container: Node, offset: number) {
  const r = doc.createRange();
  r.selectNodeContents(doc.body);
  r.setEnd(container, offset);
  return r.toString().length;
}

export function bodyText(doc: Document) {
  const r = doc.createRange();
  r.selectNodeContents(doc.body);
  return r.toString();
}

// SHOW_TEXT makes these Text casts safe despite TreeWalker's Node type.
export function pointAt(doc: Document, target: number) {
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (
    let n = walk.nextNode() as Text | null;
    n;
    n = walk.nextNode() as Text | null
  ) {
    if (seen + n.length > target) return { node: n, offset: target - seen };
    seen += n.length;
  }
  return null;
}

// Multiple marks may share an id across elements; splitting preserves offsets.
export function paint(
  doc: Document,
  start: number,
  length: number,
  id: string,
) {
  const at = pointAt(doc, start);
  if (!at) return false;

  const first = at.offset > 0 ? at.node.splitText(at.offset) : at.node;
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  walk.currentNode = first;

  const targets: Text[] = [];
  let left = length;
  for (
    let n: Text | null = first;
    n && left > 0;
    n = walk.nextNode() as Text | null
  ) {
    if (n.length > left) n.splitText(left);
    if (n.length) targets.push(n);
    left -= n.length;
  }
  for (const t of targets) {
    const mark = doc.createElement("mark");
    mark.dataset.comment = id;
    t.parentNode?.insertBefore(mark, t);
    mark.appendChild(t);
  }
  return left === 0;
}

// Null documents have no marks to unwrap.
export function unpaint(doc: Document | null, id: string) {
  for (const m of doc?.querySelectorAll(`mark[data-comment="${id}"]`) ?? []) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  }
}

export function readHeadings(doc: Document): Heading[] {
  return [...doc.body.querySelectorAll("h2, h3")].map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent ?? "").trim(),
    start: measure(doc, h, 0),
  }));
}
