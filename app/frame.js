/* Everything that reaches into the plan's iframe. Its document is passed in
   rather than held here, so these stay plain functions over a document.

   Offsets count characters of the plan's body text. Range.toString() defines
   that text, and the TreeWalker below visits the same text nodes in the same
   order, so the two always agree. */

export const measure = (doc, container, offset) => {
  const r = doc.createRange();
  r.selectNodeContents(doc.body);
  r.setEnd(container, offset);
  return r.toString().length;
};

export const bodyText = (doc) => {
  const r = doc.createRange();
  r.selectNodeContents(doc.body);
  return r.toString();
};

export const pointAt = (doc, target) => {
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (seen + n.length > target) return { node: n, offset: target - seen };
    seen += n.length;
  }
  return null;
};

/* Wrap [start, start+length) in <mark>. A range that crosses element
   boundaries yields several marks sharing one id, which is fine. Splitting
   text nodes changes no character, so every other comment's offsets survive
   this. */
export const paint = (doc, start, length, id) => {
  const at = pointAt(doc, start);
  if (!at) return false;

  const first = at.offset > 0 ? at.node.splitText(at.offset) : at.node;
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  walk.currentNode = first;

  const targets = [];
  let left = length;
  for (let n = first; n && left > 0; n = walk.nextNode()) {
    if (n.length > left) n.splitText(left);
    if (n.length) targets.push(n);
    left -= n.length;
  }
  for (const t of targets) {
    const mark = doc.createElement("mark");
    mark.dataset.comment = id;
    t.parentNode.insertBefore(mark, t);
    mark.appendChild(t);
  }
  return left === 0;
};

export const unpaint = (doc, id) => {
  for (const m of doc.querySelectorAll(`mark[data-comment="${id}"]`)) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  }
};

export const readHeadings = (doc) =>
  [...doc.body.querySelectorAll("h2, h3")].map((h) => ({
    level: Number(h.tagName[1]),
    text: h.textContent.trim(),
    start: measure(doc, h, 0),
  }));
