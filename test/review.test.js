/* The URL `just review` opens. This is the path arithmetic that used to be
   bash and jq, so these are the tests that recipe never had. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import { reviewUrl } from "../server.ts";

const AT = { root: "/w", app: "/w/review-html", home: "/w/me", port: 8422 };
const query = (over) => new URL(reviewUrl({ ...AT, ...over })).searchParams;

test("the reviewer is reached at its path under the served root", () => {
  assert.equal(
    reviewUrl(AT),
    "http://127.0.0.1:8422/review-html/review.html",
    "no plan means no query string",
  );
});

test("the plan is named relative to the root, and labelled for a human", () => {
  const q = query({ plan: "/w/me/repo/.plans/thing.html" });
  assert.equal(q.get("plan"), "me/repo/.plans/thing.html");
  assert.equal(q.get("label"), "~/repo/.plans/thing.html");
});

test("a plan outside a home directory keeps its absolute label", () => {
  assert.equal(
    query({ plan: "/w/opt/thing.html" }).get("label"),
    "/w/opt/thing.html",
  );
});

/* `/w/mexican` starts with `/w/me` as a string but sits nowhere near it. The
   bash this replaces used a prefix substitution and got that wrong. */
test("a directory merely spelled like the home directory is left alone", () => {
  assert.equal(
    query({ plan: "/w/mexican/thing.html" }).get("label"),
    "/w/mexican/thing.html",
  );
});

/* How `just demo` reaches the fixture, and why the recipe cd's to the
   directory it was invoked from before handing the plan over. */
test("a relative plan resolves against the working directory", () => {
  const app = process.cwd();
  const q = query({ plan: "test/fixtures/plan.html", root: dirname(app), app });
  assert.equal(q.get("plan"), `${basename(app)}/test/fixtures/plan.html`);
});

/* The server refuses these too, but reaching that point means a browser has
   already opened on a URL that cannot work. */
test("a plan outside the served root is refused, and says how to widen", () => {
  assert.throws(() => reviewUrl({ ...AT, plan: "/elsewhere/thing.html" }), {
    message: "/elsewhere/thing.html is outside /w; set REVIEW_ROOT to widen",
  });
});

test("a root that does not contain the reviewer is refused", () => {
  // `just review` cannot work at all here: review.html would be unreachable.
  assert.throws(() => reviewUrl({ ...AT, root: "/w/me/plans" }), {
    message: "/w/review-html is outside /w/me/plans; set REVIEW_ROOT to widen",
  });
});

test("the reviewer sitting at the root itself still resolves", () => {
  assert.equal(
    reviewUrl({ ...AT, root: "/w/review-html" }),
    "http://127.0.0.1:8422/review.html",
    "no empty path segment",
  );
});

/* Both values cross a URL boundary, so anything a filename may legally hold
   has to survive the trip. The reviewer reads them back with URLSearchParams. */
test("characters that would break the query string are encoded", () => {
  const name = "a plan & one?two#three.html";
  const q = query({ plan: `/w/me/${name}` });
  assert.ok(
    !reviewUrl({ ...AT, plan: `/w/me/${name}` }).includes("#"),
    "no fragment",
  );
  assert.equal(q.get("plan"), `me/${name}`, "round-trips through the parser");
  assert.equal(q.get("label"), `~/${name}`);
});
