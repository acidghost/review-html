#!/usr/bin/env bun
/* Serves the work area on loopback, so the reviewer can fetch plans by path.
   Replaces `python3 -m http.server`, whose one-directory model is the reason
   the root has to be wide enough to hold both a plan and this checkout.

   Static, plus a transpile: the reviewer is plain ES modules written in
   TypeScript, so the browser asks for one file per module and each is stripped
   of its types on the way out. Nothing is bundled and nothing is written to
   disk. */

import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

// Types only ever come off; no target lowering, no bundling, no import
// rewriting — `./anchor.js` reaches the browser exactly as written.
const strip = new Bun.Transpiler({ loader: "ts" });

export const APP = import.meta.dir;
export const PORT = 8422;

/* Answered at /_ping. `just review` used to ask only for a 200; asking for the
   body too is what tells our server apart from anything else on the port. */
const MARKER = "review-html";

/* A plan and this checkout have to sit under one root; the directory this repo
   was cloned into is the smallest one that covers both without knowing the
   layout. Mirrors `root` in the justfile — keep the two in step. */
export const defaultRoot = () => process.env.REVIEW_ROOT ?? resolve(APP, "..");

export const serve = ({ root = defaultRoot(), port = PORT } = {}) => {
  const base = resolve(root);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      // `just review` health-checks this. It cannot use `/`, which is a
      // directory and so has nothing to serve.
      if (path === "/_ping") return new Response(MARKER);

      // `.${path}` keeps the resolve inside base for well-behaved paths; the
      // prefix test is what catches the rest, including symlinks' parents.
      const file = resolve(base, `.${path}`);
      if (file !== base && !file.startsWith(base + sep)) {
        return new Response("forbidden", { status: 403 });
      }

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

      return new Response("not found", { status: 404 });
    },
  });
};

/* ---------- the URL to open ---------- */

const under = (path: string, base: string) =>
  path === base || path.startsWith(base + sep);

/* Served paths are URL paths, so they keep their separator on any platform.
   Empty when `to` is `from` itself, which must add no segment at all. */
const urlPath = (from: string, to: string) =>
  relative(from, to).split(sep).filter(Boolean);

/* Every path calculation `just review` used to do in bash, and the reason it
   no longer needs jq: absolutise the plan, refuse one outside the root, make
   it root-relative, and name it for the header with $HOME back as a tilde.

   Pure — no disk, no socket — which is what makes it testable. The caller
   checks the plan exists; that is the one part that has to touch the disk. */
export const reviewUrl = ({
  plan = "",
  root = defaultRoot(),
  app = APP,
  port = PORT,
  home = homedir(),
}: {
  plan?: string;
  root?: string;
  app?: string;
  port?: number;
  home?: string;
} = {}) => {
  const base = resolve(root);
  const outside = (path: string) =>
    new Error(`${path} is outside ${base}; set REVIEW_ROOT to widen`);

  // The reviewer is served too: ES modules do not load over file://.
  if (!under(app, base)) throw outside(app);
  const url = new URL(
    [`http://127.0.0.1:${port}`, ...urlPath(base, app), "review.html"].join(
      "/",
    ),
  );

  if (plan) {
    const file = resolve(plan);
    if (!under(file, base)) throw outside(file);
    url.searchParams.set("plan", urlPath(base, file).join("/"));
    // A dropped file gets no label, and is then keyed on its basename alone.
    url.searchParams.set(
      "label",
      under(file, home) ? `~${file.slice(home.length)}` : file,
    );
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
    console.log(`serving ${root} on ${server.url.origin}`);
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
          `serving ${root} on 127.0.0.1:${port} (just stop to shut it down)`,
        );
      }
      Bun.spawn(["open", url], { cwd: APP }).unref();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }
}
