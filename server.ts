#!/usr/bin/env bun
/* Serves the reviewer on loopback, and plans by absolute path.

   Two namespaces, because they are two different things. The reviewer's own
   files come off this checkout at the origin root — /review.html, /app/main.js
   — so its URL no longer depends on where the repo was cloned. Plans are read
   through one reserved route, /plan?path=<absolute>, bounded by a root of
   their own.

   Static, plus a transpile: the reviewer is plain ES modules written in
   TypeScript, so the browser asks for one file per module and each is stripped
   of its types on the way out. Nothing is bundled and nothing is written to
   disk. */

import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";

// Types only ever come off; no target lowering, no bundling, no import
// rewriting — `./anchor.js` reaches the browser exactly as written.
const strip = new Bun.Transpiler({ loader: "ts" });

export const APP = import.meta.dir;
export const PORT = 8422;

/* Answered at /_ping. `just review` used to ask only for a 200; asking for the
   body too is what tells our server apart from anything else on the port. */
const MARKER = "review-html";

/* The boundary on which files a request may read, and nothing else now that
   the reviewer is served from its own tree. The work area is where plans live;
   widening this to $HOME would put ~/.ssh behind a loopback GET.
   Mirrors `root` in the justfile — keep the two in step. */
export const defaultRoot = () => process.env.REVIEW_ROOT ?? resolve(APP, "..");

const under = (path: string, base: string) =>
  path === base || path.startsWith(base + sep);

const forbidden = () => new Response("forbidden", { status: 403 });
const missing = () => new Response("not found", { status: 404 });

/* Plans, not files. Containment is what keeps the read inside the root;
   the extension is what stops a wide root from making every readable file on
   the machine fetchable over loopback. */
const servePlan = async (path: string, base: string) => {
  if (!path.startsWith("/")) {
    return new Response("plan path must be absolute", { status: 400 });
  }
  const file = resolve(path); // folds away any `..` before the check
  if (!under(file, base) || !/\.html?$/i.test(file)) return forbidden();

  const found = Bun.file(file);
  return (await found.exists()) ? new Response(found) : missing();
};

const serveApp = async (path: string, base: string) => {
  // `.${path}` keeps the resolve inside base for well-behaved paths; the
  // prefix test is what catches the rest, including symlinks' parents.
  const file = resolve(base, `.${path}`);
  if (!under(file, base)) return forbidden();

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

export const serve = ({
  app = APP,
  root = defaultRoot(),
  port = PORT,
} = {}) => {
  const appBase = resolve(app);
  const planBase = resolve(root);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      // `just review` health-checks this. It cannot use `/`, which is a
      // directory and so has nothing to serve.
      if (path === "/_ping") return new Response(MARKER);
      if (path === "/plan") {
        return servePlan(url.searchParams.get("path") ?? "", planBase);
      }
      return serveApp(path, appBase);
    },
  });
};

/* ---------- the URL to open ---------- */

/* What `just review` opens: the reviewer at a fixed path, with the plan named
   by its absolute path. The browser shortens that for the header itself, so
   there is no second parameter to keep in step.

   Pure — no disk, no socket — which is what makes it testable. The caller
   checks the plan exists; that is the one part that has to touch the disk. */
export const reviewUrl = ({
  plan = "",
  root = defaultRoot(),
  port = PORT,
}: {
  plan?: string;
  root?: string;
  port?: number;
} = {}) => {
  const url = new URL(`http://127.0.0.1:${port}/review.html`);
  if (plan) {
    const base = resolve(root);
    const file = resolve(plan);
    if (!under(file, base)) {
      throw new Error(`${file} is outside ${base}; set REVIEW_ROOT to widen`);
    }
    url.searchParams.set("plan", file);
  }
  return url.href;
};

/* ---------- cli ---------- */

const probe = async (port: number) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_ping`, {
      signal: AbortSignal.timeout(500),
    });
    return (await res.text()) === MARKER ? "ours" : "foreign";
  } catch {
    return "down";
  }
};

/* Returns whether it had to start one. Detached, so `just review` hands the
   terminal back and `just stop` is what ends the server — the same lifetime
   the backgrounded shell gave it. */
const ensureServing = async (port: number, root: string) => {
  const found = await probe(port);
  if (found === "ours") return false;
  if (found === "foreign") {
    throw new Error(`port ${port} is answering, but it is not this server`);
  }

  // execPath, not "bun": the child runs the interpreter we are running, not
  // whichever one PATH happens to resolve to.
  Bun.spawn(
    [process.execPath, "run", `${APP}/server.ts`, "--port", String(port)],
    {
      cwd: APP,
      env: { ...process.env, REVIEW_ROOT: root },
      stdio: ["ignore", "ignore", "ignore"],
    },
  ).unref();

  // Polling rather than a flat sleep: it is usually listening within 100ms.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await probe(port)) === "ours") return true;
    await Bun.sleep(100);
  }
  throw new Error(`no answer from the server started on port ${port}`);
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { port: { type: "string" }, open: { type: "boolean" } },
    allowPositionals: true,
  });
  const port = values.port ? Number(values.port) : PORT;
  const root = defaultRoot();

  if (!values.open) {
    const server = serve({ root, port });
    console.log(`serving plans under ${root} on ${server.url.origin}`);
  } else {
    try {
      // Relative to where the recipe was invoked, which is why it cd's first.
      const plan = positionals[0] ?? "";
      if (plan && !(await Bun.file(resolve(plan)).exists())) {
        throw new Error(`no such plan: ${plan}`);
      }
      const url = reviewUrl({ plan, root, port });
      if (await ensureServing(port, root)) {
        console.log(
          `serving plans under ${root} on 127.0.0.1:${port} (just stop to shut it down)`,
        );
      }
      Bun.spawn(["open", url], { cwd: APP }).unref();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }
}
