import { test } from "bun:test";
import assert from "node:assert/strict";
import { elide, labelFor, shorten } from "../app/paths.js";

test("a macOS home directory collapses to a tilde", () => {
  assert.equal(
    shorten("/Users/username/path/to/repo/.plans/2026-09-08-thing.html"),
    "~/path/to/repo/.plans/2026-09-08-thing.html",
  );
});

test("a Linux home directory collapses too", () => {
  assert.equal(shorten("/home/username/work/plan.html"), "~/work/plan.html");
});

test("paths outside a home directory are left alone", () => {
  assert.equal(shorten("/opt/plans/plan.html"), "/opt/plans/plan.html");
  assert.equal(shorten("/tmp/plan.html"), "/tmp/plan.html");
});

test("the home directory itself is not collapsed", () => {
  // No trailing slash means no path under it, so there is nothing to shorten.
  assert.equal(shorten("/Users/username"), "/Users/username");
});

test("a basename with no directory survives unchanged", () => {
  assert.equal(shorten("plan.html"), "plan.html");
});

test("short labels are not elided", () => {
  const label = "~/work/review-html/.plans/plan.html";
  assert.equal(elide(label), label);
});

test("long labels keep both ends and land on the limit", () => {
  const label = `~/work/${"deep/".repeat(30)}plan.html`;
  const out = elide(label, 64);
  assert.equal(out.length, 64);
  assert.ok(out.startsWith("~/work/deep"));
  assert.ok(
    out.endsWith("plan.html"),
    "the filename is the part worth keeping",
  );
});

test("an explicit label from the query string is used verbatim", () => {
  assert.equal(
    labelFor("review-html/.plans/x.html", "~/work/review-html/.plans/x.html"),
    "~/work/review-html/.plans/x.html",
  );
});

test("without a label, a root-relative plan is shown under the home tilde", () => {
  // Only correct when the server root is $HOME; `just review` passes an
  // explicit label precisely because it may serve a tighter root.
  assert.equal(
    labelFor("work/repo/.plans/x.html", null),
    "~/work/repo/.plans/x.html",
  );
});

test("without a label, an absolute plan is shortened", () => {
  assert.equal(labelFor("/Users/username/work/x.html", null), "~/work/x.html");
});

test("an empty label falls back rather than showing nothing", () => {
  assert.equal(labelFor("work/x.html", ""), "~/work/x.html");
});
