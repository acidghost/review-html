/* server.fetch() dispatches without a socket, which is what makes these
   runnable where loopback is closed off — a sandbox, mainly. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { serve, TOKEN_HEADER } from "../src/server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
const TOKEN = "a-token";

const allow = new Set();
const server = serve({ port: 0, token: TOKEN, allow });
const get = (path, init) => server.fetch(new Request(`http://x${path}`, init));
const plan = (path) => get(`/plan?path=${encodeURIComponent(path)}`);
const post = (path, headers) =>
  get("/_open", { method: "POST", body: JSON.stringify({ path }), headers });
const open = (path) => post(path, { [TOKEN_HEADER]: TOKEN });

test("unmatched static paths are not served from the source tree", async () => {
  assert.equal((await get("/app/main.js")).status, 404);
  assert.equal((await get("/app/review.css")).status, 404);
});

test("answers the health check the CLI uses", async () => {
  assert.equal((await get("/_ping")).status, 200);
});

test("a missing file, and the root directory, are both 404", async () => {
  assert.equal((await get("/nope.html")).status, 404);
  assert.equal((await get("/")).status, 404);
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
  const other = serve({ port: 0, allow: registered });
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

test("failed binds do not run the on-listening hook", async () => {
  let listening = 0;
  const original = serve({
    port: 0,
    onListening: () => {
      listening += 1;
    },
  });

  try {
    assert.equal(listening, 1);
    assert.equal(
      await (await original.fetch(new Request("http://x/_ping"))).text(),
      "review-html",
    );
    assert.throws(() =>
      serve({
        port: original.port,
        onListening: () => {
          listening += 1;
        },
      }),
    );
    assert.equal(listening, 1);
    assert.equal(
      await (await original.fetch(new Request("http://x/_ping"))).text(),
      "review-html",
    );
  } finally {
    original.stop(true);
  }
});

test("shutdown requires the token and asks the server to stop itself", async () => {
  let shutdownRequested = false;
  const controlled = serve({
    port: 0,
    token: TOKEN,
    onShutdown: () => {
      shutdownRequested = true;
    },
  });
  const shutdownRequest = (headers, method = "POST") =>
    controlled.fetch(
      new Request("http://x/_shutdown", {
        method,
        headers,
      }),
    );

  try {
    assert.equal((await shutdownRequest({})).status, 403);
    assert.equal(
      (await shutdownRequest({ [TOKEN_HEADER]: TOKEN }, "GET")).status,
      405,
    );
    assert.equal(shutdownRequested, false);

    const res = await shutdownRequest({ [TOKEN_HEADER]: TOKEN });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "stopping");
    assert.equal(
      shutdownRequested,
      false,
      "response is returned before shutdown",
    );
    await Bun.sleep(75);
    assert.equal(shutdownRequested, true);
  } finally {
    controlled.stop(true);
  }
});
