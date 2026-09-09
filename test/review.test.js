/* The URL `just review` opens. Much smaller than it was: the reviewer is at a
   fixed path now, so all that is left is the boundary and the query string. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { shorten } from "../app/paths.js";
import { reviewUrl } from "../server.ts";

const AT = { root: "/w", port: 8422 };
const query = (over) => new URL(reviewUrl({ ...AT, ...over })).searchParams;

test("the reviewer is reached at a path that does not depend on the layout", () => {
  assert.equal(
    reviewUrl(AT),
    "http://127.0.0.1:8422/review.html",
    "no plan means no query string",
  );
});

test("the plan is named by its absolute path", () => {
  assert.equal(
    query({ plan: "/w/me/repo/.plans/thing.html" }).get("plan"),
    "/w/me/repo/.plans/thing.html",
  );
});

test("a relative plan resolves against the working directory", () => {
  const cwd = process.cwd();
  assert.equal(
    query({ plan: "test/fixtures/plan.html", root: cwd }).get("plan"),
    `${cwd}/test/fixtures/plan.html`,
  );
});

/* The server refuses these too, but reaching that point means a browser has
   already opened on a URL that cannot work. */
test("a plan outside the served root is refused, and says how to widen", () => {
  assert.throws(() => reviewUrl({ ...AT, plan: "/elsewhere/thing.html" }), {
    message: "/elsewhere/thing.html is outside /w; set REVIEW_ROOT to widen",
  });
});

/* Reviews are keyed on the label, which the browser now derives with
   shorten() instead of reading it off ?label=. For a home directory of either
   shape the two agree, so saved reviews keep their key. */
test("the derived label matches the one ?label= used to carry", () => {
  for (const home of ["/Users/andrea", "/home/andrea"]) {
    const plan = `${home}/wa/repo/.plans/thing.html`;
    assert.equal(shorten(plan), `~${plan.slice(home.length)}`);
  }
});

/* The value crosses a URL boundary, so anything a filename may legally hold
   has to survive the trip. The reviewer reads it back with URLSearchParams. */
test("characters that would break the query string are encoded", () => {
  const plan = "/w/me/a plan & one?two#three.html";
  const url = reviewUrl({ ...AT, plan });
  assert.ok(!url.includes("#"), "no fragment");
  assert.equal(
    new URL(url).searchParams.get("plan"),
    plan,
    "round-trips through the parser",
  );
});
