import { test } from "bun:test";
import assert from "node:assert/strict";
import { sectionFor } from "../src/app/anchor.ts";

// Offsets stand in for a plan whose h2/h3 structure is what matters here.
const HEADINGS = [
  { level: 2, text: "Design decisions", start: 100 },
  { level: 3, text: "Anchoring", start: 200 },
  { level: 3, text: "Storage", start: 300 },
  { level: 2, text: "Phase 1", start: 400 },
  { level: 3, text: "Export", start: 500 },
];

test("text before the first heading has no section", () => {
  assert.equal(sectionFor(HEADINGS, 0), "");
});

test("under an h2 alone, the crumb is just that heading", () => {
  assert.equal(sectionFor(HEADINGS, 150), "Design decisions");
});

test("an h3 joins its parent h2", () => {
  assert.equal(sectionFor(HEADINGS, 250), "Design decisions › Anchoring");
});

test("a later sibling h3 replaces the earlier one", () => {
  assert.equal(sectionFor(HEADINGS, 350), "Design decisions › Storage");
});

test("a new h2 drops the stale h3", () => {
  // The bug this guards: without truncating, "Storage" would trail "Phase 1".
  assert.equal(sectionFor(HEADINGS, 450), "Phase 1");
});

test("the h3 under the new h2 attaches to it", () => {
  assert.equal(sectionFor(HEADINGS, 550), "Phase 1 › Export");
});

test("a plan with no headings yields no section", () => {
  assert.equal(sectionFor([], 500), "");
});

test("an h3 with no h2 above it still names itself", () => {
  assert.equal(sectionFor([{ level: 3, text: "Orphan", start: 0 }], 10), "Orphan");
});
