/* Reviews live in localStorage, keyed by the plan's path and deliberately not
   by its content hash: a revised plan keeps its path, and reattaching the old
   review to it is the whole point. The hash is stored inside the record, where
   it only drives a "plan has changed since" note.

   The storage object is a parameter so the tests can pass a fake one. */

export const PREFIX = "planreview:";

export const keyFor = (id) => PREFIX + id;

/* A record is a cache, so a corrupt one is skipped rather than thrown: one bad
   entry must not take persistence down for the session. */
const parse = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/* An emptied sidebar must not resurrect itself on the next load. */
export const write = (storage, key, data) => {
  if (data.comments.length) storage.setItem(key, JSON.stringify(data));
  else storage.removeItem(key);
};

/* Nothing under the exact key means the plan was opened through the file
   picker, which withholds the path, or saved before paths were recorded — so
   fall back to the newest review of a same-named file. Flagged as inexact,
   because a basename is a weak claim that this is the same document. */
export const read = (storage, key, name) => {
  const data = parse(storage.getItem(key));
  if (data?.comments?.length) return { data, exact: true };

  let best = null;
  for (let i = 0; i < storage.length; i += 1) {
    const other = storage.key(i);
    if (!other?.startsWith(PREFIX)) continue;
    const found = parse(storage.getItem(other));
    if (found?.name !== name || !found.comments?.length) continue;
    if (!best || found.savedAt > best.savedAt) best = found;
  }
  return best ? { data: best, exact: false } : null;
};
