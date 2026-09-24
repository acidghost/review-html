// Route-based Bun servers are exercised over loopback, like the CLI uses them.

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, TOKEN_HEADER } from "../src/server.ts";
import { readPlans, writePlans } from "../src/state.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
const TOKEN = "a-token";

const allow = new Set<string>();
let listening = 0;
let shutdownRequested = false;
let server = serve({
  port: 8524,
  token: TOKEN,
  allow,
  onListening: () => {
    listening += 1;
  },
  onShutdown: () => {
    shutdownRequested = true;
  },
});
function request(target, path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${target.port}${path}`, init);
}
function get(path: string, init?: RequestInit) {
  return request(server, path, init);
}
function plan(path) {
  return get(`/plan?path=${encodeURIComponent(path)}`);
}
function post(path, headers) {
  return get("/_open", {
    method: "POST",
    body: JSON.stringify({ path }),
    headers,
  });
}
function open(path) {
  return post(path, { [TOKEN_HEADER]: TOKEN });
}

test("unmatched static paths are not served from the source tree", async () => {
  assert.equal((await get("/app/main.js")).status, 404);
  assert.equal((await get("/app/review.css")).status, 404);
});

test("serves the favicon linked from the reviewer", async () => {
  const page = await (await get("/")).text();
  const favicon = page.match(/<link rel="icon"[^>]*href="([^"]+)"/)?.[1];
  assert.ok(favicon, "the page links a favicon");

  const icon = await get(favicon);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.match(await icon.text(), /<svg .*viewBox="0 0 64 64">/);
});

test("answers the health check the CLI uses", async () => {
  assert.equal((await get("/_ping")).status, 200);
});

test("a missing file is 404", async () => {
  assert.equal((await get("/nope.html")).status, 404);
});

// Local processes can read loopback responses: the allowlist is the boundary.

test("a plan nobody registered is refused, however readable it is", async () => {
  // 403 and not 404: the fixture exists, and that is the point.
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
  assert.equal((await open(`${ROOT}test/nope.html`)).status, 404, "not there");
  assert.equal((await open("test/fixtures/plan.html")).status, 400, "relative");
  assert.equal((await get("/_open")).status, 404, "GET has no registered route");
});

test("a plan is asked for by absolute path, and 404s once it is gone", async () => {
  assert.equal((await plan("test/fixtures/plan.html")).status, 400);
  assert.equal((await get("/plan")).status, 400);

  const gone = `${ROOT}test/fixtures/gone.html`;
  allow.add(gone);
  assert.equal((await plan(gone)).status, 404);
  allow.delete(gone);
});

// REVIEW_ROOT adds an optional ceiling; without it, only the allowlist applies.
test("a ceiling narrows what may be registered", async () => {
  server.stop(true);
  server = serve({
    port: 8524,
    token: TOKEN,
    allow,
    ceiling: `${ROOT}test`,
    onListening: () => {
      listening += 1;
    },
    onShutdown: () => {
      shutdownRequested = true;
    },
  });
  assert.equal((await open(PLAN)).status, 200);
  assert.equal((await open(`${ROOT}src/review.html`)).status, 403);
});

test("status is behind the token too, and lists what is open", async () => {
  assert.equal((await get("/_status")).status, 403);
  const res = await get("/_status", { headers: { [TOKEN_HEADER]: TOKEN } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).plans, [PLAN]);
});

test("failed binds do not run the on-listening hook", async () => {
  assert.equal(listening, 2);
  assert.equal(await (await request(server, "/_ping")).text(), "review-html");
  assert.throws(() =>
    serve({
      port: server.port,
      onListening: () => {
        listening += 1;
      },
    }),
  );
  assert.equal(listening, 2);
  assert.equal(await (await request(server, "/_ping")).text(), "review-html");
});

test("shutdown requires the token and asks the server to stop itself", async () => {
  const shutdownRequest = (headers, method = "POST") =>
    request(server, "/_shutdown", { method, headers });

  assert.equal((await shutdownRequest({})).status, 403);
  assert.equal((await shutdownRequest({ [TOKEN_HEADER]: TOKEN }, "GET")).status, 404);
  assert.equal(shutdownRequested, false);

  const res = await shutdownRequest({ [TOKEN_HEADER]: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "stopping");
  assert.equal(shutdownRequested, false, "response is returned before shutdown");
  await Bun.sleep(75);
  assert.equal(shutdownRequested, true);
});

test("saved paths are validated, missing paths stay removable", async () => {
  server.stop(true);
  const file = join(mkdtempSync(join(tmpdir(), "review-open-")), "state.json");
  const gone = `${ROOT}test/fixtures/gone.html`;
  writePlans([PLAN, PLAN, gone, `${ROOT}package.json`, "relative.html"], file);
  const instance = serve({ port: 8524, stateFile: file });
  try {
    const ask = (path, init?: RequestInit) => request(instance, path, init);
    assert.deepEqual(await (await ask("/plans")).json(), [
      { path: PLAN, missing: false },
      { path: gone, missing: true },
    ]);
    assert.equal((await ask(`/plan?path=${encodeURIComponent(gone)}`)).status, 404);
    assert.equal((await ask(`/plan?path=${encodeURIComponent(PLAN)}`)).status, 200);
  } finally {
    instance.stop(true);
  }
});

test("a failed state write does not register a plan", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "review-open-")), "state.json");
  const instance = serve({ port: 8524, token: TOKEN, stateFile: file });
  try {
    mkdirSync(file); // Deliberately make the state path unwritable as a file.
    const res = await request(instance, "/_open", {
      method: "POST",
      headers: { [TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ path: PLAN }),
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await (await request(instance, "/plans")).json(), []);
    assert.equal((await request(instance, `/plan?path=${encodeURIComponent(PLAN)}`)).status, 403);
  } finally {
    instance.stop(true);
  }
});

test("registered plans persist, list and close through browser routes", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "review-open-")), "state.json");
  const other = `${ROOT}src/review.html`;
  let instance = serve({ port: 8524, token: TOKEN, stateFile: file });
  const ask = (path, init?: RequestInit) => request(instance, path, init);
  const register = (path) =>
    ask("/_open", {
      method: "POST",
      headers: { [TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ path }),
    });
  const close = (path, headers = {}) =>
    ask("/plans/close", {
      method: "POST",
      headers,
      body: JSON.stringify({ path }),
    });
  try {
    assert.deepEqual(await (await ask("/plans")).json(), []);
    assert.equal((await register(PLAN)).status, 200);
    assert.equal((await register(other)).status, 200);
    assert.deepEqual(await (await ask("/plans")).json(), [
      { path: PLAN, missing: false },
      { path: other, missing: false },
    ]);
    assert.deepEqual(readPlans(file), [PLAN, other]);
    instance.stop(true);
    instance = serve({ port: 8524, token: TOKEN, stateFile: file, ceiling: `${ROOT}src` });
    assert.deepEqual(await (await ask("/plans")).json(), [{ path: other, missing: false }]);
    assert.deepEqual(readPlans(file), [PLAN, other], "the ceiling does not erase saved paths");
    assert.equal((await ask(`/plan?path=${encodeURIComponent(PLAN)}`)).status, 403);
    instance.stop(true);
    instance = serve({ port: 8524, token: TOKEN, stateFile: file });
    assert.deepEqual(await (await ask("/plans")).json(), [
      { path: PLAN, missing: false },
      { path: other, missing: false },
    ]);
    assert.equal((await close(PLAN)).status, 403);
    assert.equal(
      (await close(PLAN, { "x-review-action": "close", origin: "http://evil.test" })).status,
      403,
    );
    assert.equal((await close(PLAN, { "x-review-action": "close" })).status, 403);
    assert.equal(
      (await close(PLAN, { "x-review-action": "close", origin: instance.url.origin })).status,
      200,
    );
    assert.equal((await ask(`/plan?path=${encodeURIComponent(PLAN)}`)).status, 403);
    instance.stop(true);
    instance = serve({ port: 8524, token: TOKEN, stateFile: file });
    assert.deepEqual(await (await ask("/plans")).json(), [{ path: other, missing: false }]);
    assert.equal((await ask(`/plan?path=${encodeURIComponent(other)}`)).status, 200);
  } finally {
    instance.stop(true);
  }
});
