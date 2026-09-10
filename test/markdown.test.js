import { test } from "bun:test";
import assert from "node:assert/strict";
import { markdown } from "../src/app/markdown.js";

const comment = (over) => ({
  section: "Design",
  quote: "a quote",
  body: "a note",
  ...over,
});

test("the header names the plan and counts the comments", () => {
  const out = markdown([comment()], "~/path/to/repo/.plans/x.html");
  assert.match(
    out,
    /^Review of `~\/path\/to\/repo\/\.plans\/x\.html` — 1 comment\n/,
  );
});

test("the count is pluralised", () => {
  assert.match(markdown([comment(), comment()], "x"), /— 2 comments/);
  assert.match(markdown([], "x"), /— 0 comments/);
});

test("each comment becomes a numbered block with its section and quote", () => {
  const out = markdown(
    [
      comment({
        section: "Phase 1 › Storage",
        quote: "keyed by path",
        body: "why not the hash?",
      }),
    ],
    "x",
  );
  assert.ok(
    out.includes(
      "## 1 · Phase 1 › Storage\n> keyed by path\n\nwhy not the hash?",
    ),
  );
});

test("blocks follow list order", () => {
  const out = markdown(
    [comment({ body: "first" }), comment({ body: "second" })],
    "x",
  );
  assert.ok(out.indexOf("first") < out.indexOf("second"));
  assert.ok(out.includes("## 1 ") && out.includes("## 2 "));
});

test("a comment with no section gets no separator", () => {
  const out = markdown([comment({ section: "" })], "x");
  assert.ok(out.includes("## 1\n>"), out);
});

test("unanchored comments say so, since their quote may no longer exist", () => {
  assert.match(
    markdown([comment({ orphan: true })], "x"),
    /## 1 · Design · unanchored/,
  );
});

test("a quote spanning several elements flattens to one blockquote line", () => {
  const out = markdown(
    [comment({ quote: "  across\n\n  two   paragraphs \n" })],
    "x",
  );
  assert.ok(out.includes("> across two paragraphs\n"));
});

test("the export ends with exactly one newline", () => {
  const out = markdown([comment()], "x");
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"));
});
