import { test } from "bun:test";
import assert from "node:assert/strict";
import { shorten } from "../src/app/paths.ts";
import { reviewUrl } from "../src/cli.ts";

test("with no plan there is no query string", () => {
  assert.equal(reviewUrl({ port: 8422 }), "http://127.0.0.1:8422/review.html");
});

// Preserve arbitrary filenames across the query-string boundary.
test("characters that would break the query string are encoded", () => {
  const plan = "/w/me/a plan & one?two#three.html";
  const url = reviewUrl({ plan, port: 8422 });
  assert.ok(!url.includes("#"), "no fragment");
  assert.equal(new URL(url).searchParams.get("plan"), plan);
});

// Browser-derived labels must keep existing review keys stable.
test("the derived label matches the one ?label= used to carry", () => {
  for (const home of ["/Users/andrea", "/home/andrea"]) {
    const plan = `${home}/wa/repo/.plans/thing.html`;
    assert.equal(shorten(plan), `~${plan.slice(home.length)}`);
  }
});
