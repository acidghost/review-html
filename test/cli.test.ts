// Lifecycle tests need loopback; skip when the sandbox blocks it.

import { afterEach, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ping } from "../src/server.ts";
import { read, write } from "../src/state.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
const CLI = `${ROOT}src/cli.ts`;
const PORT = 8523;
const STATE = join(mkdtempSync(join(tmpdir(), "review-html-")), "state.json");

// Determine skip status before declaring the suite.
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

function runAt(port, ...args) {
  return Bun.spawnSync([process.execPath, "run", CLI, "--port", String(port), ...args], {
    env: { ...process.env, REVIEW_STATE: STATE },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function run(...args) {
  return runAt(PORT, ...args);
}

function output(result) {
  return `${result.stdout.toString()}${result.stderr.toString()}`.trim();
}

// Started detached, so it has to be waited for rather than awaited.
async function serving(want) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (((await ping(PORT)) === "ours") === want) return true;
    await Bun.sleep(50);
  }
  return false;
}

function spawnServer() {
  const child = Bun.spawn([process.execPath, "run", CLI, "--port", String(PORT), "serve"], {
    env: { ...process.env, REVIEW_STATE: STATE },
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child;
}

describe.skipIf(unavailable !== null)("the command line", () => {
  beforeAll(async () => {
    assert.ok(await serving(false), `something is already on ${PORT}`);
  });

  afterEach(async () => {
    run("stop");
    await serving(false);
    rmSync(STATE, { force: true });
  });

  test("serve records itself, readable only by its owner", async () => {
    spawnServer();
    assert.ok(await serving(true), "never came up");

    const state = read(STATE);
    assert.equal(state.port, PORT);
    assert.match(state.token, /^[0-9a-f-]{36}$/);
    assert.equal(statSync(STATE).mode & 0o777, 0o600);
    assert.notEqual(state.pid, process.pid);
  });

  test("a failed bind leaves the running server's state and token intact", async () => {
    spawnServer();
    assert.ok(await serving(true), "never came up");
    const before = read(STATE);

    const result = run("serve");

    assert.equal(result.exitCode, 1);
    assert.deepEqual(read(STATE), before);
    assert.match(output(run("status")), new RegExp(String(before.pid)));
    assert.equal(await ping(PORT), "ours");
  });

  test("stop refuses a PID that does not match the server", async () => {
    spawnServer();
    assert.ok(await serving(true), "never came up");
    const recorded = read(STATE);
    const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    try {
      write({ ...recorded, pid: unrelated.pid }, STATE);
      const result = run("stop");

      assert.equal(result.exitCode, 1);
      assert.match(output(result), /state does not match|pid does not match/i);
      await Bun.sleep(50);
      assert.equal(unrelated.exitCode, null, "unrelated process must remain alive");
      assert.equal(await ping(PORT), "ours", "review server must remain alive");
    } finally {
      write(recorded, STATE);
      if (unrelated.exitCode === null) unrelated.kill();
      await unrelated.exited;
    }
  });

  test("stop on a different port does not clear the active server's state", async () => {
    spawnServer();
    assert.ok(await serving(true), "never came up");
    const before = read(STATE);

    const result = runAt(PORT + 1, "stop");

    assert.equal(result.exitCode, 1);
    assert.match(output(result), /records (?:a )?server on port|port mismatch/i);
    assert.deepEqual(read(STATE), before);
    assert.equal(await ping(PORT), "ours");
    runAt(PORT + 1, "status");
    assert.deepEqual(read(STATE), before);
  });

  // /_ping must not report ready before the token is written.
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

  test("plans survive stop and restart, unlike the server token", async () => {
    spawnServer();
    assert.ok(await serving(true));
    const first = read(STATE);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${PORT}/_open`, {
          method: "POST",
          headers: { "x-review-token": first.token },
          body: JSON.stringify({ path: PLAN }),
        })
      ).status,
      200,
    );
    run("stop");
    assert.equal(read(STATE), null);
    spawnServer();
    assert.ok(await serving(true));
    assert.notEqual(read(STATE).token, first.token);
    assert.match(output(run("status")), new RegExp(PLAN.replace(/\./g, "\\.")));
    assert.equal(
      (await fetch(`http://127.0.0.1:${PORT}/plan?path=${encodeURIComponent(PLAN)}`)).status,
      200,
    );
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

  // SIGKILL leaves stale state; verify it against the socket.
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

  test("the compiled server serves its HTML page and bundled assets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-html-build-"));
    const executable = join(dir, "review-html");
    let compiled = null;

    try {
      const built = await Bun.build({
        entrypoints: [CLI],
        compile: { outfile: executable, autoloadDotenv: false },
      });
      assert.ok(built.success, built.logs.map((log) => log.message).join("\n"));

      compiled = Bun.spawn([executable, "--port", String(PORT), "serve"], {
        env: { ...process.env, REVIEW_STATE: STATE },
        stdout: "ignore",
        stderr: "pipe",
      });
      assert.ok(await serving(true), "compiled server never came up");

      const response = await fetch(`http://127.0.0.1:${PORT}/review.html`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Plan reviewer/);

      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
      assert.ok(assets.length > 0, html);
      let hasClientScript = false;
      for (const path of assets) {
        const asset = await fetch(new URL(path, `http://127.0.0.1:${PORT}`));
        assert.equal(asset.status, 200, path);
        const body = await asset.text();
        assert.ok(body.length > 0, path);
        if (asset.headers.get("content-type")?.startsWith("text/javascript")) {
          hasClientScript = true;
          assert.ok(body.includes("mark[data-comment]"), "iframe CSS is embedded");
        }
      }
      assert.ok(hasClientScript, "the frontend JavaScript is served");

      assert.match(output(run("stop")), /^stopped \d+$/);
      assert.ok(await serving(false), "compiled server did not stop");
      await compiled.exited;
    } finally {
      run("stop");
      if (compiled?.exitCode === null) {
        compiled.kill();
        await compiled.exited;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
