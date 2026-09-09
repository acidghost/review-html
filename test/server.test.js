/* server.fetch() dispatches without a socket, which is what makes these
   runnable where loopback is closed off — a sandbox, mainly. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { serve } from "../server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
const server = serve({ app: ROOT, root: ROOT, port: 0 });
const get = (path) => server.fetch(new Request(`http://x${path}`));
const plan = (path) => get(`/plan?path=${encodeURIComponent(path)}`);

test("serves the reviewer and its modules with usable content types", async () => {
  for (const [path, type] of [
    ["/review.html", "text/html"],
    ["/app/main.js", "text/javascript"],
    ["/app/review.css", "text/css"],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    // A wrong type on .js blocks module loading outright.
    assert.match(res.headers.get("content-type"), new RegExp(`^${type}`), path);
  }
});

/* The transpile has one job on the way out, and one thing it must not do:
   take the types off, and leave every specifier alone. The browser resolves
   `./anchor.js` itself, so a rewritten one is a 404 it cannot recover from. */
test("app modules arrive as JavaScript with their specifiers intact", async () => {
  const main = await get("/app/main.js");
  const body = await main.text();
  assert.match(main.headers.get("content-type"), /^text\/javascript/);
  assert.ok(body.includes('from "./anchor.js"'), body.slice(0, 200));
  assert.ok(!body.includes("Document | null"), "annotations should be gone");

  const anchor = await (await get("/app/anchor.js")).text();
  assert.ok(!anchor.includes("export type"), "type exports should be gone");
});

test("answers the health check `just review` uses", async () => {
  assert.equal((await get("/_ping")).status, 200);
});

test("a missing file, and the root directory, are both 404", async () => {
  assert.equal((await get("/nope.html")).status, 404);
  assert.equal((await get("/")).status, 404);
});

/* `new URL()` folds plain ".." away before the handler sees it, so an encoded
   slash is the traversal that actually reaches the containment check. */
test("encoded traversal out of the root is refused", async () => {
  for (const path of [
    "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/app%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  ]) {
    assert.equal((await get(path)).status, 403, path);
  }
  assert.equal((await get("/../../etc/passwd")).status, 404);
});

/* ---------- plans, which come off a root of their own ---------- */

test("a plan is fetched by its absolute path", async () => {
  const res = await plan(PLAN);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.ok((await res.text()).includes("Fixture plan"));
});

test("a plan outside the root is refused, however it is spelled", async () => {
  for (const path of [
    "/etc/passwd",
    `${ROOT}../etc/passwd`,
    `${ROOT}test/../../etc/passwd`,
  ]) {
    assert.equal((await plan(path)).status, 403, path);
  }
});

/* The root is only a region; without this, anything readable under it is
   fetchable over loopback the moment someone widens it. */
test("a file inside the root that is not a plan is refused", async () => {
  assert.equal((await plan(`${ROOT}package.json`)).status, 403);
  assert.equal((await plan(`${ROOT}app/main.ts`)).status, 403);
});

test("a relative plan path is a bad request, not a guess", async () => {
  assert.equal((await plan("test/fixtures/plan.html")).status, 400);
  assert.equal((await get("/plan")).status, 400);
});

test("a plan that is gone is 404, not forbidden", async () => {
  assert.equal((await plan(`${ROOT}test/fixtures/nope.html`)).status, 404);
});
