/* The DOM half: selection, painting, click-through, re-anchoring. These are
   exactly the paths the pure-function tests cannot reach.

   Needs a browser binary: `just browser`. Without one the suite skips rather
   than fails, so `just test` stays useful on a machine that has none.

   Drives the real server.ts, so a break in how plans are served shows up here
   rather than only in `just review`. */

import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { shorten } from "../src/app/paths.js";
import { serve } from "../src/server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
// What the reviewer derives for itself, now that no label is passed to it.
const LABEL = shorten(PLAN);

/* Both halves of "is there a browser" have to be settled before the describe
   is declared, because that is when bun:test decides to skip it — and only
   launching proves the second half. Hence an import and a launch out here.

   Dynamic, so a missing package skips the suite like a missing binary does. */
let browser = null;
let unavailable = null;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
} catch (err) {
  unavailable = err.message.split("\n")[0];
  // The reason is the point of skipping rather than failing; bun:test does
  // not carry one, so say it here.
  console.log(`skipping the browser suite: ${unavailable}`);
}

// Both suites share the one browser, so closing it belongs to neither.
afterAll(async () => {
  await browser?.close();
});

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

describe.skipIf(unavailable !== null)("reviewer in a browser", () => {
  let server;
  let origin;

  beforeAll(() => {
    // Port 0: a fixed one would collide with a server left running.
    // The fixture is handed over directly, since /_open is the CLI's job.
    server = serve({ port: 0, allow: new Set([PLAN]) });
    origin = server.url.origin;
  });

  afterAll(() => {
    server?.stop(true);
  });

  const open = async (query = `?plan=${encodeURIComponent(PLAN)}`) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("dialog", (d) => d.accept()); // the delete button confirms
    await page.goto(`${origin}/review.html${query}`);
    return page;
  };

  test("the served plan renders, and the header shows its path", async () => {
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

  test("a selection inside one paragraph becomes one mark and one comment", async () => {
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
    // plan.css is injected as a <style> into a sandboxed srcdoc frame; this
    // is the assertion that it actually arrived.
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

  test("a selection across two paragraphs is several marks but one comment", async () => {
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

  test("two comments export in document order with their own sections", async () => {
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

  test("a comment re-anchors after the plan is rewritten above it", async () => {
    const page = await open();
    const frame = await planFrame(page);

    const quote = await select(
      frame,
      "This sentence exists",
      "a selection can start",
    );
    await comment(page, "still relevant");

    const revised = (await readFile(PLAN, "utf8")).replace(
      "<h2>Goal</h2>",
      "<h2>Goal</h2>\n<p>A paragraph inserted above the anchor, shifting every offset below it.</p>",
    );
    // Matched on the pathname: the plan is in the query string now, where a
    // glob would have to account for its encoding.
    await page.route(
      (url) => url.pathname === "/plan",
      (route) => route.fulfill({ contentType: "text/html", body: revised }),
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

  test("clicking a highlight focuses its card", async () => {
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

  test("deleting a comment unwraps its highlight", async () => {
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

  test("Clear all empties the sidebar and the plan's highlights", async () => {
    const page = await open();
    const frame = await planFrame(page);

    await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "first");
    await select(frame, "A second paragraph", "the far end");
    await comment(page, "second");
    assert.equal(await page.locator(".card").count(), 2);

    await page.click("#clearBtn");

    assert.equal(await page.locator(".card").count(), 0);
    assert.equal(await frame.locator("mark[data-comment]").count(), 0);
    assert.ok(await page.isDisabled("#clearBtn"));
    // The emptied review must not come back on the next load.
    await page.waitForTimeout(500); // outlast the 400ms save debounce
    await page.reload();
    await planFrame(page);
    assert.equal(await page.locator(".card").count(), 0);
  });

  test("Clear unanchored drops the orphans and leaves the rest", async () => {
    const page = await open();
    const frame = await planFrame(page);

    await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "about the doomed paragraph");
    await select(frame, "A second paragraph", "the far end");
    await comment(page, "about the surviving one");

    // Drop the first anchor's paragraph: its comment has nowhere left to go.
    const revised = (await readFile(PLAN, "utf8")).replace(
      /<p>\s*This sentence exists[\s\S]*?<\/p>/,
      "",
    );
    await page.route(
      (url) => url.pathname === "/plan",
      (route) => route.fulfill({ contentType: "text/html", body: revised }),
    );
    await page.reload();
    const reanchored = await planFrame(page);
    assert.match(await page.textContent("#note"), /1 unanchored/);
    assert.equal(await page.locator(".card.orphan").count(), 1);

    await page.click("#orphanBtn");

    assert.equal(await page.locator(".card").count(), 1);
    assert.equal(
      await page.locator(".card textarea").inputValue(),
      "about the surviving one",
    );
    assert.equal(await reanchored.locator("mark[data-comment]").count(), 1);
    assert.ok(await page.isDisabled("#orphanBtn"));
    assert.ok(!(await page.isDisabled("#clearBtn")));
  });

  test("Esc undoes the current edit instead of wiping the comment", async () => {
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
