/* server.fetch() dispatches without a socket, which is what makes these
   runnable where loopback is closed off — a sandbox, mainly. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { serve, TOKEN_HEADER } from "../server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
const TOKEN = "a-token";

const allow = new Set();
const server = serve({ app: ROOT, port: 0, token: TOKEN, allow });
const get = (path, init) => server.fetch(new Request(`http://x${path}`, init));
const plan = (path) => get(`/plan?path=${encodeURIComponent(path)}`);
const post = (path, headers) =>
  get("/_open", { method: "POST", body: JSON.stringify({ path }), headers });
const open = (path) => post(path, { [TOKEN_HEADER]: TOKEN });

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

test("answers the health check the CLI uses", async () => {
  assert.equal((await get("/_ping")).status, 200);
});

test("a missing file, and the root directory, are both 404", async () => {
  assert.equal((await get("/nope.html")).status, 404);
  assert.equal((await get("/")).status, 404);
});

/* `new URL()` folds plain ".." away before the handler sees it, so an encoded
   slash is the traversal that actually reaches the containment check. */
test("encoded traversal out of the app tree is refused", async () => {
  for (const path of [
    "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/app%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  ]) {
    assert.equal((await get(path)).status, 403, path);
  }
  assert.equal((await get("/../../etc/passwd")).status, 404);
});

/* ---------- the boundary ---------- */

/* These four are the security contract. Anything on this machine can reach
   loopback and read what comes back, so what may be read is the whole of it. */

test("a plan nobody registered is refused, however readable it is", async () => {
  // 403 and not 404: the file is right there, and that is the point.
  assert.equal((await plan(PLAN)).status, 403);
  assert.equal((await plan(`${ROOT}package.json`)).status, 403);
  assert.equal((await plan(`${homedir()}/.ssh/id_rsa`)).status, 403);
});

test("registering needs the token", async () => {
  assert.equal((await post(PLAN, {})).status, 403);
  assert.equal((await post(PLAN, { [TOKEN_HEADER]: "wrong" })).status, 403);
  assert.equal((await post(PLAN, { [TOKEN_HEADER]: "" })).status, 403);
  assert.equal((await plan(PLAN)).status, 403, "nothing was registered");
});

test("a registered plan is readable, and only then", async () => {
  assert.equal((await open(PLAN)).status, 200);
  const res = await plan(PLAN);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.ok((await res.text()).includes("Fixture plan"));
});

test("what may be registered is a plan that exists", async () => {
  assert.equal((await open(`${ROOT}package.json`)).status, 403, "not a plan");
  assert.equal((await open(`${ROOT}nope.html`)).status, 404, "not there");
  assert.equal((await open("test/fixtures/plan.html")).status, 400, "relative");
  assert.equal((await get("/_open")).status, 405, "GET cannot register");
});

test("a plan is asked for by absolute path, and 404s once it is gone", async () => {
  assert.equal((await plan("test/fixtures/plan.html")).status, 400);
  assert.equal((await get("/plan")).status, 400);

  const gone = `${ROOT}test/fixtures/gone.html`;
  const registered = new Set([gone]);
  const other = serve({ app: ROOT, port: 0, allow: registered });
  assert.equal(
    (
      await other.fetch(
        new Request(`http://x/plan?path=${encodeURIComponent(gone)}`),
      )
    ).status,
    404,
  );
  other.stop(true);
});

/* REVIEW_ROOT, for someone who wants a hard ceiling as well as the allowlist.
   Unset by default: the allowlist is the boundary, and a default ceiling
   would put back the "plans must live under one root" it replaces. */
test("a ceiling narrows what may be registered", async () => {
  const bounded = serve({
    app: ROOT,
    port: 0,
    token: TOKEN,
    ceiling: `${ROOT}test`,
  });
  const register = (path) =>
    bounded.fetch(
      new Request("http://x/_open", {
        method: "POST",
        body: JSON.stringify({ path }),
        headers: { [TOKEN_HEADER]: TOKEN },
      }),
    );
  assert.equal((await register(PLAN)).status, 200);
  assert.equal((await register(`${ROOT}review.html`)).status, 403);
  bounded.stop(true);
});

test("status is behind the token too, and lists what is open", async () => {
  assert.equal((await get("/_status")).status, 403);
  const res = await get("/_status", { headers: { [TOKEN_HEADER]: TOKEN } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).plans, [PLAN]);
});

/* ---------- compiled: one page, no tree ---------- */

test("an embedded reviewer is served from memory, and nothing else is", async () => {
  const compiled = serve({ port: 0, page: "<!doctype html><b>embedded" });
  const at = (path) => compiled.fetch(new Request(`http://x${path}`));

  const res = await at("/review.html");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.ok((await res.text()).includes("embedded"));

  assert.equal((await at("/app/main.js")).status, 404, "no source tree");
  assert.equal((await at("/_ping")).status, 200, "still ours");
  compiled.stop(true);
});
