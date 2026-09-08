/* Where a comment belongs in the plan, and how to find it again after Claude
   has rewritten the plan around it. Nothing here touches the DOM. */

export const CONTEXT = 32; // characters of context kept either side of a quote

export const tidy = (s) => s.replace(/\s+/g, " ").trim();

export const hash = (text) => {
  let h = 0x811c9dc5; // FNV-1a: enough to notice "this is a different file"
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};

/* Where does this anchor's quote live now? The stored offset is only a hint —
   any edit above it shifts everything below. */
export const locate = (text, a) => {
  if (text.slice(a.start, a.start + a.quote.length) === a.quote) return a.start;

  // With no context to disambiguate with, this degrades to "first occurrence
  // wins", which is worse than the distance check below.
  if (a.prefix || a.suffix) {
    const ctx = a.prefix + a.quote + a.suffix;
    const inContext = text.indexOf(ctx);
    if (inContext >= 0) return inContext + a.prefix.length;
  }

  let best = -1;
  for (
    let i = text.indexOf(a.quote);
    i >= 0;
    i = text.indexOf(a.quote, i + 1)
  ) {
    if (best < 0 || Math.abs(i - a.start) < Math.abs(best - a.start)) best = i;
  }
  return best; // -1: the quote is gone, the comment is orphaned
};

/* The heading trail above an offset, so a comment reads as "Phase 2 › Storage"
   rather than a bare character position. */
export const sectionFor = (headings, start) => {
  const crumb = [];
  for (const h of headings) {
    if (h.start > start) break;
    crumb[h.level - 2] = h.text;
    crumb.length = h.level - 1; // a new h2 drops the stale h3
  }
  return crumb.filter(Boolean).join(" › ");
};
