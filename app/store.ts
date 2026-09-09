/* Reviews live in localStorage, keyed by the plan's path and deliberately not
   by its content hash: a revised plan keeps its path, and reattaching the old
   review to it is the whole point. The hash is stored inside the record, where
   it only drives a "plan has changed since" note.

   The storage object is a parameter so the tests can pass a fake one. */

import type { Comment } from "./anchor.js";

/* The five members this module touches. localStorage satisfies it, and so can
   a fake without standing up the rest of the DOM interface. */
export type KeyValueStorage = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/* One plan's review, as it goes to storage and as `Save .json` exports it. */
export type Review = {
  name: string;
  path: string;
  hash: string;
  savedAt: string;
  comments: Comment[];
};

export const PREFIX = "planreview:";

export const keyFor = (id: string) => PREFIX + id;

/* A record is a cache, so a corrupt one is skipped rather than thrown: one bad
   entry must not take persistence down for the session. The Review here is a
   claim about someone else's JSON, which is why the readers below still check
   the fields they use. */
const parse = (raw: string | null): Review | null => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/* An emptied sidebar must not resurrect itself on the next load. */
export const write = (storage: KeyValueStorage, key: string, data: Review) => {
  if (data.comments.length) storage.setItem(key, JSON.stringify(data));
  else storage.removeItem(key);
};

/* Nothing under the exact key means the plan was opened through the file
   picker, which withholds the path, or saved before paths were recorded — so
   fall back to the newest review of a same-named file. Flagged as inexact,
   because a basename is a weak claim that this is the same document. */
export const read = (storage: KeyValueStorage, key: string, name: string) => {
  const data = parse(storage.getItem(key));
  if (data?.comments?.length) return { data, exact: true };

  let best: Review | null = null;
  for (let i = 0; i < storage.length; i += 1) {
    const other = storage.key(i);
    if (!other?.startsWith(PREFIX)) continue;
    const found = parse(storage.getItem(other));
    if (found?.name !== name || !found.comments?.length) continue;
    if (!best || found.savedAt > best.savedAt) best = found;
  }
  return best ? { data: best, exact: false } : null;
};
