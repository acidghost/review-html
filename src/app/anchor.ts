export const CONTEXT = 32;

export type Anchor = {
  start: number;
  quote: string;
  prefix: string;
  suffix: string;
};

// `orphan` is computed when re-anchoring, not stored.
export type Comment = Anchor & {
  id: string;
  section: string;
  body: string;
  orphan?: boolean;
};

export type Heading = { level: number; text: string; start: number };

export function tidy(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

export function hash(text: string) {
  let h = 0x811c9dc5; // FNV-1a: enough to notice "this is a different file"
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Where does this anchor's quote live now? The stored offset is only a hint —
// any edit above it shifts everything below.
export function locate(text: string, a: Anchor) {
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
  return best;
}

// The heading trail above an offset, so a comment reads as "Phase 2 › Storage"
// rather than a bare character position.
export function sectionFor(headings: Heading[], start: number) {
  const crumb: string[] = [];
  for (const h of headings) {
    if (h.start > start) break;
    crumb[h.level - 2] = h.text;
    crumb.length = h.level - 1; // drop stale subheadings
  }
  return crumb.filter(Boolean).join(" › ");
}
