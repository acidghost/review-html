/* The lifecycle: start detached, register a plan, stop, and recover from a
   server that was killed. These are the paths no in-process test reaches,
   since the whole point of them is a second process and a real socket.

   Needs a port it can both bind and connect to. A sandbox may allow neither,
   so the suite skips with the reason rather than failing. */

import { afterEach, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ping } from "../server.ts";
import { clear, read } from "../state.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
const CLI = `${ROOT}cli.ts`;
const PORT = 8523;
const STATE = join(mkdtempSync(join(tmpdir(), "review-html-")), "state.json");

/* Both halves have to be settled before the describe is declared, because
   that is when bun:test decides to skip it. */
let unavailable = null;
try {
  const decoy = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    fetch: () => new Response("x"),
  });
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    signal: AbortSignal.timeout(500),
  });
  if ((await res.text()) !== "x") throw new Error("something else answered");
  decoy.stop(true);
} catch (err) {
  unavailable = err.message.split("\n")[0];
  console.log(`skipping the lifecycle suite: ${unavailable}`);
}

const run = (...args) =>
  Bun.spawnSync(
    [process.execPath, "run", CLI, "--port", String(PORT), ...args],
    {
      env: { ...process.env, REVIEW_STATE: STATE },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

const output = (result) =>
  `${result.stdout.toString()}${result.stderr.toString()}`.trim();

// Started detached, so it has to be waited for rather than awaited.
const serving = async (want) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (((await ping(PORT)) === "ours") === want) return true;
    await Bun.sleep(50);
  }
  return false;
};

const spawnServer = () => {
  const child = Bun.spawn(
    [process.execPath, "run", CLI, "--port", String(PORT), "serve"],
    {
      env: { ...process.env, REVIEW_STATE: STATE },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  child.unref();
  return child;
};

describe.skipIf(unavailable !== null)("the command line", () => {
  beforeAll(async () => {
    assert.ok(await serving(false), `something is already on ${PORT}`);
  });

  afterEach(async () => {
    run("stop");
    await serving(false);
    clear(STATE);
  });

  test("serve records itself, readable only by its owner", async () => {
    spawnServer();
    assert.ok(await serving(true), "never came up");

    const state = read(STATE);
    assert.equal(state.port, PORT);
    assert.match(state.token, /^[0-9a-f-]{36}$/);
    assert.equal(statSync(STATE).mode & 0o777, 0o600);
    // The pid is what stop uses, so it has to be the process that is serving.
    assert.notEqual(state.pid, process.pid);
  });

  /* The state file exists before the socket does, so a /_ping that answers
     means the token is already readable. Without that ordering, `review-html
     <plan>` would race its own child. */
  test("a plan is registered and then readable, and only then", async () => {
    spawnServer();
    assert.ok(await serving(true));
    const { token } = read(STATE);

    const url = `http://127.0.0.1:${PORT}/plan?path=${encodeURIComponent(PLAN)}`;
    assert.equal((await fetch(url)).status, 403, "not registered yet");

    const opened = await fetch(`http://127.0.0.1:${PORT}/_open`, {
      method: "POST",
      headers: { "x-review-token": token },
      body: JSON.stringify({ path: PLAN }),
    });
    assert.equal(opened.status, 200);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("Fixture plan"));
  });

  test("status names the plans, stop ends it and clears the file", async () => {
    spawnServer();
    assert.ok(await serving(true));
    const { token } = read(STATE);
    await fetch(`http://127.0.0.1:${PORT}/_open`, {
      method: "POST",
      headers: { "x-review-token": token },
      body: JSON.stringify({ path: PLAN }),
    });

    assert.match(output(run("status")), new RegExp(PLAN.replace(/\./g, "\\.")));
    assert.match(output(run("stop")), /^stopped \d+$/);
    assert.equal(await ping(PORT), "down");
    assert.equal(read(STATE), null, "the file goes with the server");
  });

  /* SIGKILL leaves the file behind, which is why nothing trusts it without
     asking the port first. */
  test("a state file left by a killed server does not wedge anything", async () => {
    const child = spawnServer();
    assert.ok(await serving(true));
    const { pid } = read(STATE);

    process.kill(pid, "SIGKILL");
    await child.exited;
    assert.ok(await serving(false), "still answering");
    assert.notEqual(read(STATE), null, "the file should have outlived it");

    assert.match(output(run("status")), /not running \(cleared a stale/);
    assert.equal(read(STATE), null);
  });

  test("stop with nothing running says so instead of failing", () => {
    const result = run("stop");
    assert.equal(result.exitCode, 0);
    assert.match(output(result), /nothing to stop/);
  });

  test("one plan at a time", () => {
    const result = run("a.html", "b.html");
    assert.equal(result.exitCode, 1);
    assert.match(output(result), /one plan at a time/);
  });
});
