// Requires `just browser`; skips if no browser binary is installed.

import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { shorten } from "../src/app/paths.ts";
import { serve } from "../src/server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = `${ROOT}test/fixtures/plan.html`;
const OTHER = `${ROOT}test/fixtures/other.html`;
const LABEL = shorten(PLAN);

// Decide whether to skip before declaring the suite; launch tests the binary.
let browser = null;
let unavailable = null;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
} catch (err) {
  unavailable = err.message.split("\n")[0];
  // bun:test does not report skip reasons.
  console.log(`skipping the browser suite: ${unavailable}`);
}

afterAll(async () => {
  await browser?.close();
});

async function planFrame(page) {
  await page.waitForFunction(() => document.getElementById("empty").hidden);
  await page.waitForFunction(() => window.frames.length > 0);
  return page.frames().find((f) => f !== page.mainFrame());
}

// Select text across one or two elements; return the selected quote.
function select(frame, from, needle, to = null, endNeedle = null) {
  return frame.evaluate(
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
        throw new Error(`no "${text}" under "${el.textContent.trim().slice(0, 40)}"`);
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
}

async function comment(page, body) {
  await page.waitForSelector("#add:not([hidden])");
  await page.click("#add");
  // addComment() focuses the new card, and cards sort into document order, so
  // "the last card" is not reliably the new one. Type into what has focus.
  await page.waitForSelector(".card textarea:focus");
  await page.keyboard.insertText(body);
  await page.waitForTimeout(500); // outlast the 400ms save debounce
}

describe.skipIf(unavailable !== null)("reviewer in a browser", () => {
  let server = null;
  let origin = "";
  const opened = new Set([PLAN]);

  beforeAll(() => {
    // Port 0 avoids collisions; /_open is covered by the CLI suite.
    server = serve({ port: 0, allow: opened });
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
      await frame.evaluate(() => [...document.querySelectorAll("h2")].map((h) => h.textContent)),
      ["Goal", "Context", "Steps", "Verification"],
    );
  });

  test("picker switches plans, keeps reviews, and removes without deleting them", async () => {
    const page = await open();
    try {
      const frame = await planFrame(page);
      await select(frame, "This sentence exists", "a selection can start");
      await comment(page, "first plan note");
      opened.add(OTHER); // as if a second CLI registration happened after page load
      await page.click("#plansBtn");
      await page.locator(`.plan-label[title="${OTHER}"]`).click();
      await page.waitForFunction(
        (path) => new URL(location.href).searchParams.get("plan") === path,
        OTHER,
      );
      assert.equal(await page.frameLocator("#plan").locator("h1").textContent(), "Other plan");
      assert.equal(await page.locator(".card").count(), 0);
      await page.reload();
      await planFrame(page);
      await page.goBack();
      await page.waitForFunction(
        (path) => document.querySelector("#name").getAttribute("title") === path,
        LABEL,
      );
      assert.equal(await page.locator(".card textarea").inputValue(), "first plan note");

      await page.click("#plansBtn");
      const removed = page.waitForResponse((res) => new URL(res.url()).pathname === "/plans/close");
      await page.getByRole("button", { name: `Remove ${PLAN} from open plans` }).click();
      assert.equal((await removed).status(), 200);
      await page.locator("#empty").waitFor({ state: "visible" });
      assert.equal(new URL(page.url()).searchParams.has("plan"), false);
      assert.equal((await fetch(`${origin}/plan?path=${encodeURIComponent(PLAN)}`)).status, 403);
      assert.equal((await readFile(PLAN, "utf8")).includes("Fixture plan"), true);
      assert.equal(await page.locator("#plansList .plan-row").count(), 1);
      opened.add(PLAN); // Reopen later; removing must not erase the review.
      await page.click("#plansClose");
      await page.click("#plansBtn");
      await page.locator(`.plan-label[title="${PLAN}"]`).click();
      assert.equal(await page.locator(".card textarea").inputValue(), "first plan note");
    } finally {
      opened.delete(OTHER);
      opened.add(PLAN);
      await page.close();
    }
  });

  test("missing plans remain in the picker and can be removed", async () => {
    const gone = `${ROOT}test/fixtures/gone.html`;
    opened.add(gone);
    const page = await open();
    try {
      await page.click("#plansBtn");
      const entry = page.locator(`.plan-label[title="${gone}"]`);
      await entry.waitFor();
      assert.equal(await entry.isDisabled(), true);
      assert.equal(await page.getByText("Missing", { exact: true }).count(), 1);
      const removed = page.waitForResponse((res) => new URL(res.url()).pathname === "/plans/close");
      await page.getByRole("button", { name: `Remove ${gone} from open plans` }).click();
      assert.equal((await removed).status(), 200);
      await page.locator(`.plan-label[title="${gone}"]`).waitFor({ state: "detached" });
    } finally {
      opened.delete(gone);
      await page.close();
    }
  });

  test("a selection inside one paragraph becomes one mark and one comment", async () => {
    const page = await open();
    const frame = await planFrame(page);

    const quote = await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "why does it exist?");

    assert.equal(await frame.locator("mark[data-comment]").count(), 1);
    assert.equal(await frame.locator("mark[data-comment]").textContent(), quote);
    // Verify injected CSS reaches the sandboxed frame.
    assert.equal(
      await frame.locator("mark[data-comment]").evaluate((m) => getComputedStyle(m).cursor),
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
          [...document.querySelectorAll("mark[data-comment]")].map((m) =>
            m.getAttribute("data-comment"),
          ),
        ).size,
    );
    assert.equal(ids, 1, "the marks share one comment id");
    assert.equal(await page.locator(".card").count(), 1);
    assert.equal((await page.evaluate(() => window.reviewer.markdown())).match(/^## /gm).length, 1);
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

    const quote = await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "still relevant");

    const revised = (await readFile(PLAN, "utf8")).replace(
      "<h2>Goal</h2>",
      "<h2>Goal</h2>\n<p>A paragraph inserted above the anchor, shifting every offset below it.</p>",
    );
    // Match the pathname, not the encoded plan query.
    await page.route(
      (url) => url.pathname === "/plan",
      (route) => route.fulfill({ contentType: "text/html", body: revised }),
    );
    await page.reload();
    const reanchored = await planFrame(page);

    assert.match(await page.textContent("#note"), /restored 1 comment/);
    assert.doesNotMatch(await page.textContent("#note"), /unanchored/);
    assert.match(await page.textContent("#note"), /plan has changed since/);
    assert.equal(await reanchored.locator("mark[data-comment]").textContent(), quote);
    assert.equal(await page.locator(".card textarea").inputValue(), "still relevant");
  });

  test("clicking a highlight focuses its card", async () => {
    const page = await open();
    const frame = await planFrame(page);

    await select(frame, "This sentence exists", "a selection can start");
    await comment(page, "click me");
    await page.locator(".card textarea").blur();
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");

    await frame.click("mark[data-comment]");
    await page.waitForSelector(".card.active");
    assert.equal(await frame.locator("mark[data-comment].active").count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");
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
    assert.ok(text.startsWith("This sentence exists so a selection can start"), text);
    assert.equal(nodes, 1, "normalize() should re-join the nodes paint() split");
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
    assert.equal(await page.locator(".card textarea").inputValue(), "about the surviving one");
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
    // Esc restores the value at focus, so first commit the new comment.
    await box.blur();
    await box.focus();
    await box.pressSequentially(" and this too");
    await box.press("Escape");

    assert.equal(await box.inputValue(), "keep me", "Esc used to clear the whole comment");
    assert.equal(await page.locator(".card").count(), 1);
  });
});
