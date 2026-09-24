#!/usr/bin/env bun

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
               review made on one port is not found on another. One server at
               a time; stop it before changing ports.

Subcommands win the bare word: a plan named "serve" is reachable as ./serve.`;

export function reviewUrl({ plan = "", port = PORT } = {}) {
  const url = new URL(`http://127.0.0.1:${port}/`);
  if (plan) url.searchParams.set("plan", plan);
  return url.href;
}

// Bun needs the script in development; the compiled executable does not.
function selfCommand() {
  const source = join(import.meta.dir, "cli.ts");
  return existsSync(source) ? [process.execPath, "run", source] : [process.execPath];
}

function refuseDifferentTrackedPort(port: number) {
  const existing = state.read();
  if (existing && existing.port !== port) {
    throw new Error(
      `review-html already tracks a server on port ${existing.port}; stop it before serving on ${port}`,
    );
  }
}

// Start detached; `review-html stop` ends the server.
async function ensureServing(port: number) {
  const found = await ping(port);
  if (found === "ours") return false;
  if (found === "foreign") {
    throw new Error(`port ${port} is answering, but it is not this server`);
  }
  refuseDifferentTrackedPort(port);

  Bun.spawn([...selfCommand(), "serve", "--port", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await ping(port)) === "ours") return true;
    await Bun.sleep(100);
  }
  throw new Error(`no answer from the server started on port ${port}`);
}

function withToken(port: number, path: string, init?: RequestInit) {
  const recorded = state.read();
  if (!recorded?.token) {
    throw new Error(
      `a server is answering on ${port}, but ${state.FILE} holds no token for it; review-html stop, then try again`,
    );
  }
  if (recorded.port !== port) {
    throw new Error(`${state.FILE} records a server on port ${recorded.port}, not ${port}`);
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { ...init?.headers, [TOKEN_HEADER]: recorded.token },
  });
}

type ServerStatus = { pid: number; port: number; plans: string[] };

function isServerStatus(value: unknown): value is ServerStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "port" in value &&
    typeof value.port === "number" &&
    "plans" in value &&
    Array.isArray(value.plans) &&
    value.plans.every((plan) => typeof plan === "string")
  );
}

async function readStatus(port: number) {
  const res = await withToken(port, "/_status");
  if (!res.ok) throw new Error(await res.text());
  const value: unknown = await res.json();
  if (!isServerStatus(value)) {
    throw new Error(`invalid server status response from port ${port}`);
  }
  return value;
}

function clearIfCurrent(expected: state.State) {
  const current = state.read();
  if (
    current?.pid === expected.pid &&
    current.port === expected.port &&
    current.token === expected.token
  ) {
    state.clear();
  }
}

// Only authenticated registration makes a plan readable.
async function register(plan: string, port: number) {
  const res = await withToken(port, "/_open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: plan }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function openPlan(plan: string, port: number) {
  // Resolve against the CLI caller's directory, not the server's.
  const file = plan ? resolve(plan) : "";
  if (file && !(await Bun.file(file).exists())) {
    throw new Error(`no such plan: ${plan}`);
  }

  if (await ensureServing(port)) {
    console.log(`serving on 127.0.0.1:${port} (review-html stop to shut it down)`);
  }
  if (file) await register(file, port);
  Bun.spawn(["open", reviewUrl({ plan: file, port })]).unref();
}

function serveHere(port: number, ceiling: string) {
  refuseDifferentTrackedPort(port);

  const recorded = { pid: process.pid, port, token: randomUUID() };
  const server = serve({
    port,
    token: recorded.token,
    ceiling,
    stateFile: state.FILE,
    onListening: () => state.write(recorded),
    onShutdown: () => process.kill(process.pid, "SIGTERM"),
  });
  console.log(`serving on ${server.url.origin}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      clearIfCurrent(recorded);
      server.stop(true);
      process.exit(0);
    });
  }
}

async function stop(port: number) {
  const recorded = state.read();
  if (recorded && recorded.port !== port) {
    throw new Error(
      `${state.FILE} records a server on port ${recorded.port}; refusing to stop port ${port}`,
    );
  }

  if ((await ping(port)) !== "ours") {
    if (recorded) clearIfCurrent(recorded);
    else state.clear();
    console.log(
      recorded
        ? `nothing listening on ${port}; cleared a stale ${state.FILE}`
        : `nothing to stop on ${port}`,
    );
    return;
  }
  if (!recorded) {
    throw new Error(`a server is answering on ${port}, but nothing recorded its identity`);
  }

  const status = await readStatus(port);
  if (status.port !== port || status.pid !== recorded.pid) {
    throw new Error(
      `state does not match the server answering on port ${port}; refusing to stop it`,
    );
  }

  const res = await withToken(port, "/_shutdown", { method: "POST" });
  if (!res.ok) throw new Error(await res.text());

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await ping(port)) !== "ours") {
      clearIfCurrent(recorded);
      console.log(`stopped ${recorded.pid}`);
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`server ${recorded.pid} is still answering on ${port}`);
}

async function status(port: number) {
  const recorded = state.read();
  if (recorded && recorded.port !== port) {
    console.log(`not running on ${port}; ${state.FILE} records port ${recorded.port}`);
    return;
  }
  if ((await ping(port)) !== "ours") {
    if (recorded) clearIfCurrent(recorded);
    else state.clear();
    console.log(recorded ? `not running (cleared a stale ${state.FILE})` : "not running");
    return;
  }

  const current = await readStatus(port);
  if (recorded && (current.pid !== recorded.pid || current.port !== port)) {
    throw new Error(`state does not match the server answering on port ${port}`);
  }
  console.log(`serving on 127.0.0.1:${port}, pid ${current.pid}`);
  for (const plan of current.plans) console.log(`  ${plan}`);
  if (!current.plans.length) console.log("  no plans open for review");
}

// Stop/status use the recorded port unless --port overrides it.
function recordedPort(given: string | undefined) {
  return given ? Number(given) : (state.read()?.port ?? PORT);
}

export async function main() {
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
      return serveHere(port, process.env.REVIEW_ROOT ?? "");
    }
    if (command === "stop") return await stop(recordedPort(values.port));
    if (command === "status") return await status(recordedPort(values.port));
    return await openPlan(command, port);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await main();
