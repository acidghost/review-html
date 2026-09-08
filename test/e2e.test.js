/* The DOM half: selection, painting, click-through, re-anchoring. These are
   exactly the paths the pure-function tests cannot reach.

   Needs a browser binary: `just browser`. Without one the suite skips rather
   than fails, so `just test` stays useful on a machine that has none. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = "test/fixtures/plan.html";
const LABEL = "~/work/review-html/test/fixtures/plan.html";

/* Stands in for `python3 -m http.server`: the app only needs correct MIME
   types (a wrong one on .js blocks module loading outright) and a root. */
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

const startServer = async () => {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = join(ROOT, normalize(path));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[path.slice(path.lastIndexOf("."))] ?? "text/plain",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
};

const loadPlaywright = async () => {
  try {
    return await import("playwright");
  } catch {
    // Installed as a tool rather than a dependency, which is where mise puts it.
    const where = execFileSync("mise", ["where", "playwright"], {
      encoding: "utf8",
    }).trim();
    return await import(`${where}/node_modules/playwright/index.mjs`);
  }
};

let chromium = null;
let unavailable = null;
try {
  ({ chromium } = await loadPlaywright());
} catch (err) {
  unavailable = `playwright not importable: ${err.message}`;
}

/* ---------- driving the two documents ---------- */

// The plan lives in a srcdoc iframe, so most assertions run in the child frame.
const planFrame = async (page) => {
  await page.waitForFunction(() => document.getElementById("empty").hidden);
  await page.waitForFunction(() => window.frames.length > 0);
  return page.frames().find((f) => f !== page.mainFrame());
};

/* Select `needle` within the element whose text starts with `from`. Given a
   second element and needle, the range runs to the end of that one, crossing
   the boundary. Returns the selected text: the comment's quote. */
const select = (frame, from, needle, to = null, endNeedle = null) =>
  frame.evaluate(
    ({ from, needle, to, endNeedle }) => {
      const element = (text) =>
        [...document.body.querySelectorAll("p, li, td, h2, h3")].find((el) =>
          el.textContent.replace(/\s+/g, " ").trim().startsWith(text),
        );
      const find = (el, text) => {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const i = n.textContent.indexOf(text);
          if (i >= 0) return { node: n, index: i };
        }
        throw new Error(
          `no "${text}" under "${el.textContent.trim().slice(0, 40)}"`,
        );
      };
      const start = find(element(from), needle);
      const end = to ? find(element(to), endNeedle) : start;
      const range = document.createRange();
      range.setStart(start.node, start.index);
      range.setEnd(end.node, end.index + (to ? endNeedle : needle).length);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return range.toString();
    },
    { from, needle, to, endNeedle },
  );

const comment = async (page, body) => {
  await page.waitForSelector("#add:not([hidden])");
  await page.click("#add");
  // addComment() focuses the new card, and cards sort into document order, so
  // "the last card" is not reliably the new one. Type into what has focus.
  await page.waitForSelector(".card textarea:focus");
  await page.keyboard.insertText(body);
  await page.waitForTimeout(500); // outlast the 400ms save debounce
};

describe("reviewer in a browser", { skip: unavailable ?? false }, () => {
  let browser;
  let server;
  let origin;

  before(async () => {
    try {
      browser = await chromium.launch();
    } catch (err) {
      // No binary: report it as a skip on every test rather than a hard failure.
      unavailable = err.message.split("\n")[0];
      return;
    }
    ({ server, origin } = await startServer());
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  const open = async (
    query = `?plan=${encodeURIComponent(PLAN)}&label=${encodeURIComponent(LABEL)}`,
  ) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("dialog", (d) => d.accept()); // the delete button confirms
    await page.goto(`${origin}/review.html${query}`);
    return page;
  };

  test("the served plan renders, and the header shows its path", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    assert.equal(await page.textContent("#name"), LABEL);
    assert.equal(await page.title(), `${LABEL} — Plan reviewer`);
    assert.equal(await frame.locator("h1").textContent(), "Fixture plan");
    assert.deepEqual(
      await frame.evaluate(() =>
        [...document.querySelectorAll("h2")].map((h) => h.textContent),
      ),
      ["Goal", "Context", "Steps", "Verification"],
    );
  });

  test("a selection inside one paragraph becomes one mark and one comment", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    const quote = await select(
      frame,
      "This sentence exists",
      "a selection can start",
    );
    await comment(page, "why does it exist?");

    assert.equal(await frame.locator("mark[data-comment]").count(), 1);
    assert.equal(
      await frame.locator("mark[data-comment]").textContent(),
      quote,
    );
    // plan.css is injected as a <link> into a sandboxed srcdoc frame; this is
    // the assertion that it actually arrived.
    assert.equal(
      await frame
        .locator("mark[data-comment]")
        .evaluate((m) => getComputedStyle(m).cursor),
      "pointer",
    );

    const md = await page.evaluate(() => window.reviewer.markdown());
    assert.ok(md.startsWith(`Review of \`${LABEL}\` — 1 comment`), md);
    assert.ok(md.includes("## 1 · Steps › 1. Parse the input"), md);
    assert.ok(md.includes(quote.replace(/\s+/g, " ").trim()));
    assert.ok(md.includes("why does it exist?"));
  });

  test("a selection across two paragraphs is several marks but one comment", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    await select(
      frame,
      "This sentence exists",
      "in the middle of it and end",
      "A second paragraph",
      "the far end",
    );
    await comment(page, "spans a boundary");

    assert.ok(
      (await frame.locator("mark[data-comment]").count()) > 1,
      "one mark per text node touched",
    );
    const ids = await frame.evaluate(
      () =>
        new Set(
          [...document.querySelectorAll("mark[data-comment]")].map(
            (m) => m.dataset.comment,
          ),
        ).size,
    );
    assert.equal(ids, 1, "the marks share one comment id");
    assert.equal(await page.locator(".card").count(), 1);
    assert.equal(
      (await page.evaluate(() => window.reviewer.markdown())).match(/^## /gm)
        .length,
      1,
    );
  });

  test("two comments export in document order with their own sections", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    // Add the later one first, so ordering cannot come from insertion order.
    await select(frame, "A second paragraph", "the far end");
    await comment(page, "second");
    await select(frame, "Exercise the reviewer", "nested headings");
    await comment(page, "first");

    const md = await page.evaluate(() => window.reviewer.markdown());
    assert.ok(md.indexOf("first") < md.indexOf("second"), md);
    assert.ok(md.includes("## 1 · Goal"), md);
    assert.ok(md.includes("## 2 · Steps › 1. Parse the input"), md);
  });

  test("a comment re-anchors after the plan is rewritten above it", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    const quote = await select(
      frame,
      "This sentence exists",
      "a selection can start",
    );
    await comment(page, "still relevant");

    const revised = (await readFile(join(ROOT, PLAN), "utf8")).replace(
      "<h2>Goal</h2>",
      "<h2>Goal</h2>\n<p>A paragraph inserted above the anchor, shifting every offset below it.</p>",
    );
    await page.route(`**/${PLAN}`, (route) =>
      route.fulfill({ contentType: "text/html", body: revised }),
    );
    await page.reload();
    const reanchored = await planFrame(page);

    assert.match(await page.textContent("#note"), /restored 1 comment/);
    assert.doesNotMatch(await page.textContent("#note"), /unanchored/);
    assert.match(await page.textContent("#note"), /plan has changed since/);
    assert.equal(
      await reanchored.locator("mark[data-comment]").textContent(),
      quote,
    );
    assert.equal(
      await page.locator(".card textarea").inputValue(),
      "still relevant",
    );
  });

  test("clicking a highlight focuses its card", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "click me");
    await page.locator(".card textarea").blur();
    assert.notEqual(
      await page.evaluate(() => document.activeElement.tagName),
      "TEXTAREA",
    );

    await frame.click("mark[data-comment]");
    await page.waitForSelector(".card.active");
    assert.equal(await frame.locator("mark[data-comment].active").count(), 1);
    assert.equal(
      await page.evaluate(() => document.activeElement.tagName),
      "TEXTAREA",
    );
  });

  test("deleting a comment unwraps its highlight", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "to be deleted");
    await page.click(".card .del");

    assert.equal(await page.locator(".card").count(), 0);
    assert.equal(await frame.locator("mark[data-comment]").count(), 0);
    const [text, nodes] = await frame.evaluate(() => {
      const p = document.querySelectorAll("p")[2];
      return [p.textContent.replace(/\s+/g, " ").trim(), p.childNodes.length];
    });
    assert.ok(
      text.startsWith("This sentence exists so a selection can start"),
      text,
    );
    assert.equal(
      nodes,
      1,
      "normalize() should re-join the nodes paint() split",
    );
  });

  test("Esc undoes the current edit instead of wiping the comment", async (t) => {
    if (unavailable) return t.skip(unavailable);
    const page = await open();
    const frame = await planFrame(page);

    await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "keep me");

    const box = page.locator(".card textarea");
    // Commit it first: Esc reverts to the value at focus time, and without this
    // that value is "", which is the discard-a-new-draft case instead.
    await box.blur();
    await box.focus();
    await box.pressSequentially(" and this too");
    await box.press("Escape");

    assert.equal(
      await box.inputValue(),
      "keep me",
      "Esc used to clear the whole comment",
    );
    assert.equal(await page.locator(".card").count(), 1);
  });
});
