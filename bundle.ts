#!/usr/bin/env bun

/* Builds dist/review.html: the whole reviewer as one file, with nothing left
   to fetch, so it can be opened from Finder or embedded in a binary.

   Bun.build does the modules; the rest is substituting its output and the
   stylesheet into review.html in place of the two tags that point at them. */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";

const HERE = import.meta.dir;
const OUT = join(HERE, "dist", "review.html");

/* app/plan-css.ts fetches its own sibling, which a single file does not have.
   Swapping the module is what keeps that difference out of main.ts. */
const inlinePlanCss = (css: string): BunPlugin => ({
  name: "inline-plan-css",
  setup(build) {
    build.onLoad({ filter: /app[/\\]plan-css\.ts$/ }, () => ({
      contents: `export const planCss = async () => ${JSON.stringify(css)};`,
      loader: "ts",
    }));
  },
});

// An inline script ends at the first `</script`, wherever it appears.
const inlineable = (js: string) => js.replaceAll("</script", "<\\/script");

const read = (path: string) => Bun.file(join(HERE, path)).text();

export const bundle = async () => {
  const built = await Bun.build({
    entrypoints: [join(HERE, "app/main.ts")],
    target: "browser",
    plugins: [inlinePlanCss(await read("app/plan.css"))],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  if (built.outputs.length !== 1) {
    throw new Error(`expected one output, got ${built.outputs.length}`);
  }

  const js = await built.outputs[0].text();
  const shell = await read("review.html");
  const styled = shell.replace(
    '<link rel="stylesheet" href="app/review.css">',
    `<style>\n${await read("app/review.css")}    </style>`,
  );
  const page = styled.replace(
    '<script type="module" src="app/main.js"></script>',
    `<script type="module">\n${inlineable(js)}</script>`,
  );
  if (page === styled || styled === shell) {
    throw new Error("review.html no longer has the tags this replaces");
  }
  return page;
};

if (import.meta.main) {
  await mkdir(dirname(OUT), { recursive: true });
  const page = await bundle();
  await Bun.write(OUT, page);
  console.log(`${OUT} (${Math.round(page.length / 1024)}KB)`);
}
