import { test } from "bun:test";
import assert from "node:assert/strict";
import { keyFor, read, write } from "../app/store.js";

// Enough of the Storage interface for store.ts: it only indexes and gets/sets.
const fakeStorage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
  };
};

const record = (over) => ({
  name: "plan.html",
  path: "~/path/to/repo/.plans/plan.html",
  hash: "abc",
  savedAt: "2026-09-08T10:00:00.000Z",
  comments: [{ id: "1", quote: "q", body: "b" }],
  ...over,
});

const stored = (records) =>
  fakeStorage(
    Object.fromEntries(records.map(([k, v]) => [k, JSON.stringify(v)])),
  );

test("a record under the exact key is an exact match", () => {
  const key = keyFor("~/path/to/repo/.plans/plan.html");
  const found = read(stored([[key, record()]]), key, "plan.html");
  assert.equal(found.exact, true);
  assert.equal(found.data.comments.length, 1);
});

test("nothing stored means nothing to restore", () => {
  assert.equal(read(fakeStorage(), keyFor("anything"), "plan.html"), null);
});

test("a dropped plan finds its review by basename, and says so", () => {
  // Saved from a served session (keyed by path), reopened by drop (keyed by name).
  const found = read(
    stored([[keyFor("~/path/to/repo/.plans/plan.html"), record()]]),
    keyFor("plan.html"),
    "plan.html",
  );
  assert.equal(
    found.exact,
    false,
    "a shared basename is a weak claim, not an exact one",
  );
  assert.equal(found.data.path, "~/path/to/repo/.plans/plan.html");
});

test("the newest same-named review wins the fallback", () => {
  const found = read(
    stored([
      [
        keyFor("~/work/a/plan.html"),
        record({ hash: "older", savedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      [
        keyFor("~/work/b/plan.html"),
        record({ hash: "newer", savedAt: "2026-09-08T00:00:00.000Z" }),
      ],
    ]),
    keyFor("plan.html"),
    "plan.html",
  );
  assert.equal(found.data.hash, "newer");
});

test("reviews of other plans are not offered", () => {
  const found = read(
    stored([[keyFor("~/work/other.html"), record({ name: "other.html" })]]),
    keyFor("plan.html"),
    "plan.html",
  );
  assert.equal(found, null);
});

test("unrelated storage keys are ignored", () => {
  // The plan template keeps its width slider in localStorage under this key,
  // and shares an origin with the reviewer.
  const storage = fakeStorage({
    "plan-width": "48rem",
    junk: "not json at all",
  });
  assert.equal(read(storage, keyFor("plan.html"), "plan.html"), null);
});

test("an emptied review is not offered as a fallback", () => {
  const found = read(
    stored([[keyFor("~/work/a/plan.html"), record({ comments: [] })]]),
    keyFor("plan.html"),
    "plan.html",
  );
  assert.equal(found, null);
});

test("writing a review round-trips through read", () => {
  const storage = fakeStorage();
  const key = keyFor("~/path/to/repo/.plans/plan.html");
  write(storage, key, record({ hash: "written" }));
  assert.equal(read(storage, key, "plan.html").data.hash, "written");
});

test("writing an empty review deletes the record", () => {
  const key = keyFor("~/path/to/repo/.plans/plan.html");
  const storage = stored([[key, record()]]);
  write(storage, key, record({ comments: [] }));
  assert.equal(
    storage.has(key),
    false,
    "an emptied sidebar must not come back",
  );
});

test("a corrupt record is skipped, not thrown", () => {
  const key = keyFor("~/path/to/repo/.plans/plan.html");
  const storage = fakeStorage({ [key]: "{ truncated" });
  // Throwing here would disable saving for the whole session.
  assert.equal(read(storage, key, "plan.html"), null);
});
