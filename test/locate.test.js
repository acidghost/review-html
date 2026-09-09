import { test } from "bun:test";
import assert from "node:assert/strict";
import { locate } from "../app/anchor.js";

const anchor = (text, quote, context = 32) => {
  const start = text.indexOf(quote);
  assert.ok(start >= 0, `fixture does not contain ${quote}`);
  return {
    quote,
    start,
    prefix: text.slice(Math.max(0, start - context), start),
    suffix: text.slice(start + quote.length, start + quote.length + context),
  };
};

const PLAN =
  "Intro paragraph. The parser must handle nesting. Then we ship it.";

test("unchanged document resolves at the stored offset", () => {
  const a = anchor(PLAN, "must handle nesting");
  assert.equal(locate(PLAN, a), PLAN.indexOf("must handle nesting"));
});

test("text inserted above the anchor still resolves via context", () => {
  const a = anchor(PLAN, "must handle nesting");
  const revised = `A sentence added at the top. ${PLAN}`;
  assert.notEqual(revised.indexOf("must handle nesting"), a.start);
  assert.equal(locate(revised, a), revised.indexOf("must handle nesting"));
});

test("context picks the right one of two identical quotes", () => {
  const text = "left TARGET left. right TARGET right.";
  const a = { quote: "TARGET", prefix: "right ", suffix: " right.", start: 0 };
  assert.equal(locate(text, a), text.lastIndexOf("TARGET"));
});

test("a quote that is gone reports as orphaned", () => {
  const a = anchor(PLAN, "must handle nesting");
  const rewritten = PLAN.replace("must handle nesting", "handles nesting now");
  assert.equal(locate(rewritten, a), -1);
});

test("when context is gone too, the nearest occurrence wins", () => {
  const text = `TARGET ${"x".repeat(30)} TARGET`;
  const a = { quote: "TARGET", prefix: "absent", suffix: "absent", start: 40 };
  assert.equal(locate(text, a), text.lastIndexOf("TARGET"));
});

test("an anchor at the very start of the document has no prefix to match on", () => {
  const text = `TARGET ${"x".repeat(30)} TARGET`;
  const a = { quote: "TARGET", prefix: "", suffix: "", start: 36 };
  // Without the guard in locate() the empty context matches first and returns 0.
  assert.equal(locate(text, a), text.lastIndexOf("TARGET"));
});

test("quote is re-found even when the surrounding sentence was reworded", () => {
  const a = anchor(PLAN, "must handle nesting");
  const revised =
    "Completely different opening. The parser must handle nesting, we decided.";
  assert.equal(locate(revised, a), revised.indexOf("must handle nesting"));
});
