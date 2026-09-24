// Key by path, not content hash, so reviews survive plan revisions.

import type { Comment } from "./anchor.ts";

export type KeyValueStorage = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type Review = {
  name: string;
  path: string;
  hash: string;
  savedAt: string;
  comments: Comment[];
};

export const PREFIX = "planreview:";

export function keyFor(id: string) {
  return PREFIX + id;
}

// Treat malformed cached records as absent; callers still validate fields.
function parse(raw: string | null): Review | null {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function write(storage: KeyValueStorage, key: string, data: Review) {
  if (data.comments.length) storage.setItem(key, JSON.stringify(data));
  else storage.removeItem(key);
}

// Dropped files have no path; fall back by basename, but flag the weak match.
export function read(storage: KeyValueStorage, key: string, name: string) {
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
}
