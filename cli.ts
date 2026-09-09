#!/usr/bin/env bun
/* The command line: open a plan for review, and start or stop the server it
   is opened on. This is the compile entrypoint's other half — see binary.ts,
   which adds the embedded reviewer and nothing else. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PORT, ping, serve, TOKEN_HEADER } from "./server.ts";
import * as state from "./state.ts";

const USAGE = `review-html <plan>   open a plan for review
review-html          the reviewer with no plan, ready for a dropped file
review-html serve    run the server in the foreground
review-html stop     stop the server
review-html status   what is running, and which plans it will serve

  --port <n>   default ${PORT}. Saved reviews are keyed to the origin, so a
               review made on one port is not found on another.

Subcommands win the bare word: a plan named "serve" is reachable as ./serve.`;

/* The reviewer's URL. The plan is one absolute path, which the browser
   shortens for the header itself. */
export const reviewUrl = ({ plan = "", port = PORT } = {}) => {
  const url = new URL(`http://127.0.0.1:${port}/review.html`);
  if (plan) url.searchParams.set("plan", plan);
  return url.href;
};

/* How to run ourselves again. Compiled there is no source tree to hand back
   to bun — the binary is the interpreter, and import.meta.dir points inside
   it — whereas in development the interpreter needs the script named. */
const selfCommand = () => {
  const source = join(import.meta.dir, "cli.ts");
  return existsSync(source)
    ? [process.execPath, "run", source]
    : [process.execPath];
};

/* Returns whether it had to start one. Detached, so the shell comes back and
   `review-html stop` is what ends the server. */
const ensureServing = async (port: number) => {
  const found = await ping(port);
  if (found === "ours") return false;
  if (found === "foreign") {
    throw new Error(`port ${port} is answering, but it is not this server`);
  }

  Bun.spawn([...selfCommand(), "serve", "--port", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  // Polling rather than a flat sleep: it is usually listening within 100ms.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await ping(port)) === "ours") return true;
    await Bun.sleep(100);
  }
  throw new Error(`no answer from the server started on port ${port}`);
};

const withToken = (port: number, path: string, init?: RequestInit) => {
  const token = state.read()?.token;
  if (!token) {
    throw new Error(
      `a server is answering on ${port}, but ${state.FILE} holds no token for it; review-html stop, then try again`,
    );
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { ...init?.headers, [TOKEN_HEADER]: token },
  });
};

/* The server serves nothing it was not handed, so this is what makes a plan
   readable — and the only reason a plan may live anywhere at all. */
const register = async (plan: string, port: number) => {
  const res = await withToken(port, "/_open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: plan }),
  });
  if (!res.ok) throw new Error(await res.text());
};

const openPlan = async (plan: string, port: number) => {
  // Relative to where it was typed, which is the point of resolving it here
  // rather than in the server.
  const file = plan ? resolve(plan) : "";
  if (file && !(await Bun.file(file).exists())) {
    throw new Error(`no such plan: ${plan}`);
  }

  if (await ensureServing(port)) {
    console.log(
      `serving on 127.0.0.1:${port} (review-html stop to shut it down)`,
    );
  }
  if (file) await register(file, port);
  Bun.spawn(["open", reviewUrl({ plan: file, port })]).unref();
};

const serveHere = (port: number, page: string, ceiling: string) => {
  const token = randomUUID();
  /* Recorded before the socket exists, so an answered /_ping implies a
     readable token; cleared again if the bind then fails. */
  state.write({ pid: process.pid, port, token });
  try {
    const server = serve({ port, page, token, ceiling });
    console.log(`serving on ${server.url.origin}`);
  } catch (err) {
    state.clear();
    throw err;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      state.clear();
      process.exit(0);
    });
  }
};

const stop = async (port: number) => {
  const recorded = state.read();
  if ((await ping(port)) !== "ours") {
    // A file left behind by a server that was killed is not a failure.
    state.clear();
    console.log(
      recorded
        ? `nothing listening on ${port}; cleared a stale ${state.FILE}`
        : `nothing to stop on ${port}`,
    );
    return;
  }
  if (!recorded) {
    throw new Error(
      `a server is answering on ${port}, but nothing recorded its pid`,
    );
  }

  process.kill(recorded.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await ping(port)) !== "ours") {
      state.clear();
      console.log(`stopped ${recorded.pid}`);
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`${recorded.pid} is still answering on ${port}`);
};

const status = async (port: number) => {
  const recorded = state.read();
  if ((await ping(port)) !== "ours") {
    if (recorded) state.clear();
    console.log(
      recorded ? `not running (cleared a stale ${state.FILE})` : "not running",
    );
    return;
  }

  const { pid, plans } = await (await withToken(port, "/_status")).json();
  console.log(`serving on 127.0.0.1:${port}, pid ${pid}`);
  for (const plan of plans) console.log(`  ${plan}`);
  if (!plans.length) console.log("  no plans open for review");
};

/* --port wins; otherwise a recorded server's port, so stop and status find
   one that was started on something other than the default. */
const recordedPort = (given: string | undefined) =>
  given ? Number(given) : (state.read()?.port ?? PORT);

export const main = async ({ page = "" } = {}) => {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const [command = "", ...extra] = positionals;
  const port = values.port ? Number(values.port) : PORT;

  try {
    if (values.help || command === "help") return console.log(USAGE);
    if (extra.length) throw new Error("one plan at a time");

    if (command === "serve") {
      return serveHere(port, page, process.env.REVIEW_ROOT ?? "");
    }
    if (command === "stop") return await stop(recordedPort(values.port));
    if (command === "status") return await status(recordedPort(values.port));
    return await openPlan(command, port);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
};

if (import.meta.main) await main();
