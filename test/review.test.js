/* The URL the CLI opens. Almost nothing is left of it: the reviewer sits at a
   fixed path and the plan is one absolute path in the query string. What
   remains worth asserting is that the query string survives the trip, and
   that the label the browser derives is the one reviews are already keyed on. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { shorten } from "../src/app/paths.js";
import { reviewUrl } from "../src/cli.ts";

test("with no plan there is no query string", () => {
  assert.equal(reviewUrl({ port: 8422 }), "http://127.0.0.1:8422/review.html");
});

/* Both crossed a URL boundary, so anything a filename may legally hold has to
   survive it. The reviewer reads the value back with URLSearchParams. */
test("characters that would break the query string are encoded", () => {
  const plan = "/w/me/a plan & one?two#three.html";
  const url = reviewUrl({ plan, port: 8422 });
  assert.ok(!url.includes("#"), "no fragment");
  assert.equal(new URL(url).searchParams.get("plan"), plan);
});

/* Reviews are keyed on the label, which the browser derives with shorten()
   instead of reading it off the ?label= that used to be passed. For a home
   directory of either shape the two agree, so saved reviews keep their key. */
test("the derived label matches the one ?label= used to carry", () => {
  for (const home of ["/Users/andrea", "/home/andrea"]) {
    const plan = `${home}/wa/repo/.plans/thing.html`;
    assert.equal(shorten(plan), `~${plan.slice(home.length)}`);
  }
});
