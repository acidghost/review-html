/* Everything that reaches into the plan's iframe. Its document is passed in
   rather than held here, so these stay plain functions over a document.

   Offsets count characters of the plan's body text. Range.toString() defines
   that text, and the TreeWalker below visits the same text nodes in the same
   order, so the two always agree. */

import type { Heading } from "./anchor.js";

export const measure = (doc: Document, container: Node, offset: number) => {
  const r = doc.createRange();
  r.selectNodeContents(doc.body);
  r.setEnd(container, offset);
  return r.toString().length;
};

export const bodyText = (doc: Document) => {
  const r = doc.createRange();
  r.selectNodeContents(doc.body);
  return r.toString();
};

/* SHOW_TEXT is what makes the Text casts here and in paint() sound: the walker
   is filtered to text nodes, which TreeWalker's own type cannot express. */
export const pointAt = (doc: Document, target: number) => {
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
};

/* Wrap [start, start+length) in <mark>. A range that crosses element
   boundaries yields several marks sharing one id, which is fine. Splitting
   text nodes changes no character, so every other comment's offsets survive
   this. */
export const paint = (
  doc: Document,
  start: number,
  length: number,
  id: string,
) => {
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
    // Every target came out of the walk over doc.body, so it has a parent.
    t.parentNode?.insertBefore(mark, t);
    mark.appendChild(t);
  }
  return left === 0;
};

/* Null-tolerant, unlike the rest: no document means no marks, so there is
   nothing to unwrap. Saves every caller a guard it would only ever pass. */
export const unpaint = (doc: Document | null, id: string) => {
  for (const m of doc?.querySelectorAll(`mark[data-comment="${id}"]`) ?? []) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  }
};

export const readHeadings = (doc: Document): Heading[] =>
  [...doc.body.querySelectorAll("h2, h3")].map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent ?? "").trim(),
    start: measure(doc, h, 0),
  }));
