#!/usr/bin/env bun
// The allowlist protects against local readers; CORS only protects browsers.
// Only authenticated requests can add plans to it.

import { timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";
import homepage from "./review.html";

// Keep the origin stable so saved reviews remain accessible.
export const PORT = 8422;

// The CLI checks this body to distinguish our server from another on the port.
const MARKER = "review-html";

export const TOKEN_HEADER = "x-review-token";

function under(path: string, base: string) {
  return path === base || path.startsWith(base + sep);
}

function text(body: string, status = 200) {
  return new Response(body, { status });
}

function forbidden() {
  return text("forbidden", 403);
}

function missing() {
  return text("not found", 404);
}

// timingSafeEqual throws on unequal lengths.
function sameToken(given: string | null, token: string) {
  return (
    token.length > 0 &&
    given?.length === token.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(token))
  );
}

export function serve({
  port = PORT,
  allow = new Set<string>(),
  token = "",
  ceiling = "",
  onListening,
  onShutdown,
}: {
  port?: number;
  // The caller owns the allowlist; tests can populate it directly.
  allow?: Set<string>;
  // Empty tokens refuse authenticated operations.
  token?: string;
  // Optional REVIEW_ROOT ceiling, in addition to the allowlist.
  ceiling?: string;
  onListening?: () => void;
  onShutdown?: () => void;
} = {}) {
  const bound = ceiling ? resolve(ceiling) : "";
  let ready = !onListening;

  // The token lives in a 0600 file; browsers cannot supply its custom header
  // without a CORS preflight, which this server does not answer.
  const open = async (req: Request) => {
    if (!sameToken(req.headers.get(TOKEN_HEADER), token)) return forbidden();

    let path = "";
    try {
      path = (await req.json())?.path ?? "";
    } catch {
      return text("expected a JSON body", 400);
    }
    if (!path.startsWith("/")) return text("plan path must be absolute", 400);

    const file = resolve(path);
    if (!/\.html?$/i.test(file)) return text(`not a plan: ${file}`, 403);
    if (bound && !under(file, bound)) {
      return text(`${file} is outside ${bound}`, 403);
    }
    if (!(await Bun.file(file).exists())) return text(`no such plan`, 404);

    allow.add(file);
    return text("ok");
  };

  const servePlan = async (path: string) => {
    const file = resolve(path);
    if (!allow.has(file)) {
      // Distinguish a disallowed file from a missing one.
      return text("not open for review — re-run review-html on this plan", 403);
    }
    const found = Bun.file(file);
    return (await found.exists()) ? new Response(found) : missing();
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: {
      "/review.html": homepage,
      "/_ping": () => (ready ? text(MARKER) : text("starting", 503)),
      "/_shutdown": {
        POST: (req) => {
          if (!sameToken(req.headers.get(TOKEN_HEADER), token)) return forbidden();
          if (!onShutdown) return missing();
          setTimeout(onShutdown, 50);
          return text("stopping");
        },
      },
      "/_open": {
        POST: (req) => open(req),
      },
      "/_status": (req) => {
        if (!sameToken(req.headers.get(TOKEN_HEADER), token)) {
          return forbidden();
        }
        return Response.json({ pid: process.pid, port, plans: [...allow] });
      },
      "/plan": (req) => {
        const asked = new URL(req.url).searchParams.get("path") ?? "";
        if (!asked.startsWith("/")) return text("plan path must be absolute", 400);
        return servePlan(asked);
      },
      "/*": () => missing(),
    },
  });

  try {
    onListening?.();
    ready = true;
  } catch (err) {
    server.stop(true);
    throw err;
  }
  return server;
}

export async function ping(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_ping`, {
      signal: AbortSignal.timeout(500),
    });
    return (await res.text()) === MARKER ? "ours" : "foreign";
  } catch {
    return "down";
  }
}
