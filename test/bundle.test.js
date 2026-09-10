/* dist/review.html has one job: hold everything. These assertions are the
   ones the file:// browser case cannot make — that nothing was left behind
   for a neighbouring file to supply. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { bundle } from "../scripts/bundle.ts";

const page = await bundle();

test("nothing points at a neighbouring file", () => {
  assert.doesNotMatch(page, /(?:src|href)="(?!#)/, "no external references");
  assert.doesNotMatch(page, /^\s*import[ {]/m, "no import statements survive");
  // The one thing Bun.build leaves alone, and the reason plan-css.ts exists.
  assert.doesNotMatch(page, /import\.meta/);
});

test("both stylesheets arrive as text", () => {
  assert.ok(page.includes("--bg:"), "the reviewer's own chrome");
  assert.ok(
    page.includes("mark[data-comment]"),
    "the CSS injected into the plan's iframe",
  );
});

test("the script is inline and unbroken", () => {
  assert.match(page, /<script type="module">\n/);
  // An inline script ends at the first `</script`, wherever it appears.
  assert.equal(page.match(/<\/script>/g).length, 1);
});

/* The bundle cannot fetch a plan by path, so it has to say so rather than
   report a failed request. */
test("the file:// case is handled in the bundle, not only when served", () => {
  assert.ok(page.includes('location.protocol === "file:"'));
});
