#!/usr/bin/env bun
/* Serves the reviewer on loopback, and the plans it has been handed.

   Two namespaces, because they are two different things. The reviewer's own
   files come off this checkout at a fixed /review.html — or, compiled, out of
   the binary as one page. Plans are read through /plan?path=<absolute>, and
   only the ones something authenticated has registered.

   That allowlist is the boundary. A malicious web page can send a request
   here but cannot read the response, because no Access-Control-Allow-Origin
   comes back; the same-origin policy does that work. What the allowlist stops
   is a local reader — any other process on the machine can curl loopback and
   read whatever it is given, and CORS has nothing to say about that.

   Static, plus a transpile: the reviewer is plain ES modules written in
   TypeScript, so the browser asks for one file per module and each is stripped
   of its types on the way out. */

import { timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";

// Types only ever come off; no target lowering, no bundling, no import
// rewriting — `./anchor.js` reaches the browser exactly as written.
const strip = new Bun.Transpiler({ loader: "ts" });

export const APP = import.meta.dir;

/* Fixed, and not a preference: localStorage is partitioned by origin and the
   port is part of the origin, so a port per invocation would orphan every
   saved review. */
export const PORT = 8422;

/* Answered at /_ping, and asking for the body rather than just a 200 is what
   tells our server apart from anything else on the port. */
const MARKER = "review-html";

export const TOKEN_HEADER = "x-review-token";

const under = (path: string, base: string) =>
  path === base || path.startsWith(base + sep);

const text = (body: string, status = 200) => new Response(body, { status });
const html = (body: string) =>
  new Response(body, {
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
const forbidden = () => text("forbidden", 403);
const missing = () => text("not found", 404);

/* Length first: timingSafeEqual throws on a mismatch, and a throw here would
   be an oracle of its own. */
const sameToken = (given: string | null, token: string) =>
  token.length > 0 &&
  given?.length === token.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(token));

export const serve = ({
  app = APP,
  port = PORT,
  page = "",
  allow = new Set<string>(),
  token = "",
  ceiling = "",
  onListening,
  onShutdown,
}: {
  app?: string;
  port?: number;
  /* The reviewer as one page. Set in a compiled binary, which has no source
     tree to serve; empty means serve app/ off the disk. */
  page?: string;
  /* The plans that may be read. The caller owns it, so a test can populate it
     without going through /_open. */
  allow?: Set<string>;
  /* Authenticates /_open, /_status and /_shutdown. Empty refuses them, which
     is what a server nobody handed a token should do. */
  token?: string;
  /* Optional outer bound on what may be registered — REVIEW_ROOT, for someone
     who wants a hard ceiling as well as the allowlist. */
  ceiling?: string;
  /* Called after the socket binds, before /_ping reports this server as ready. */
  onListening?: () => void;
  /* Authenticated shutdown hook; the server owner decides how to exit. */
  onShutdown?: () => void;
} = {}) => {
  const appBase = resolve(app);
  const bound = ceiling ? resolve(ceiling) : "";
  let ready = !onListening;

  /* Registering a file and stopping the server are authenticated operations.
     A page that could add a path and then read it back would have arbitrary
     file read; shutdown is limited to the local CLI too. The token comes from
     a 0600 file, which a browser cannot read, and the custom header puts these
     requests behind a preflight that goes unanswered. */
  const open = async (req: Request) => {
    if (!sameToken(req.headers.get(TOKEN_HEADER), token)) return forbidden();

    let path = "";
    try {
      path = (await req.json())?.path ?? "";
    } catch {
      return text("expected a JSON body", 400);
    }
    if (!path.startsWith("/")) return text("plan path must be absolute", 400);

    const file = resolve(path); // folds away any `..` before the checks
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
      // Distinguishable from a 404 on purpose: the file may well be there.
      return text("not open for review — re-run review-html on this plan", 403);
    }
    const found = Bun.file(file);
    return (await found.exists()) ? new Response(found) : missing();
  };

  const serveApp = async (path: string) => {
    // `.${path}` keeps the resolve inside base for well-behaved paths; the
    // prefix test is what catches the rest, including symlinks' parents.
    const file = resolve(appBase, `.${path}`);
    if (!under(file, appBase)) return forbidden();

    // Content-Type is inferred from the extension, which is the only header
    // that matters here: a wrong one on .js blocks module loading outright.
    const found = Bun.file(file);
    if (await found.exists()) return new Response(found);

    /* The app's import specifiers say `.js`, because that is what a browser
       must be given; the file on disk is `.ts`. Checked only after the plain
       file misses, so a real .js still wins and needs no transpile. */
    if (file.endsWith(".js")) {
      const source = Bun.file(`${file.slice(0, -3)}.ts`);
      if (await source.exists()) {
        return new Response(strip.transformSync(await source.text()), {
          headers: { "Content-Type": "text/javascript;charset=utf-8" },
        });
      }
    }

    return missing();
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      // The health check the CLI uses. It cannot be `/`, which in served mode
      // is a directory and so has nothing to answer with.
      if (path === "/_ping") {
        return ready ? text(MARKER) : text("starting", 503);
      }

      if (path === "/_shutdown") {
        if (req.method !== "POST") return text("POST only", 405);
        if (!sameToken(req.headers.get(TOKEN_HEADER), token))
          return forbidden();
        if (!onShutdown) return missing();
        setTimeout(onShutdown, 50);
        return text("stopping");
      }
      if (path === "/_open") {
        return req.method === "POST" ? open(req) : text("POST only", 405);
      }
      if (path === "/_status") {
        if (!sameToken(req.headers.get(TOKEN_HEADER), token)) {
          return forbidden();
        }
        return Response.json({ pid: process.pid, port, plans: [...allow] });
      }
      if (path === "/plan") {
        const asked = url.searchParams.get("path") ?? "";
        if (!asked.startsWith("/"))
          return text("plan path must be absolute", 400);
        return servePlan(asked);
      }

      // Compiled, the reviewer is one page in memory and there is no tree.
      if (page) return path === "/review.html" ? html(page) : missing();
      return serveApp(path);
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
};

export const ping = async (port: number) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_ping`, {
      signal: AbortSignal.timeout(500),
    });
    return (await res.text()) === MARKER ? "ours" : "foreign";
  } catch {
    return "down";
  }
};
