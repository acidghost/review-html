/* server.fetch() dispatches without a socket, which is what makes these
   runnable where loopback is closed off — a sandbox, mainly. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { serve } from "../server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const server = serve({ root: ROOT, port: 0 });
const get = (path) => server.fetch(new Request(`http://x${path}`));

test("serves the reviewer and its modules with usable content types", async () => {
  for (const [path, type] of [
    ["/review.html", "text/html"],
    ["/app/main.js", "text/javascript"],
    ["/app/review.css", "text/css"],
    ["/test/fixtures/plan.html", "text/html"],
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
