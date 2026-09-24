import { CONTEXT, type Comment, type Heading, hash, locate, sectionFor, tidy } from "./anchor.js";
import { bodyText, measure, paint, readHeadings, unpaint } from "./frame.js";
import { markdown } from "./markdown.js";
import { elide, shorten } from "./paths.js";
import { planCss } from "./plan-css.js";
import { keyFor, type Review, read as readStore, write as writeStore } from "./store.js";

declare global {
  interface Window {
    // Chromium only; saveMarkdown() falls back to a download elsewhere.
    showSaveFilePicker?: (options: {
      suggestedName?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
    reviewer: typeof reviewer;
  }
}

// Missing ids in our fixed HTML are programmer errors.
function $<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
const iframe = $<HTMLIFrameElement>("plan");

let doc: Document | null = null;
let comments: Comment[] = [];
let headings: Heading[] = [];
let planName = "";
let planPath = "";
let planLabel = "";
let planText = "";
let planHash = "";
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let storageOk = true;
let seq = 0;
let active: string | null = null;

// Show orphans first, since they have no place in the document.
function sortComments() {
  return comments.sort((a, b) => Number(!!b.orphan) - Number(!!a.orphan) || a.start - b.start);
}

// Removing a focused textarea may not fire blur to discard its empty draft.
function pruneEmpty() {
  for (const c of comments.filter((x) => !x.body.trim())) unpaint(doc, c.id);
  comments = comments.filter((c) => c.body.trim());
}

function addComment() {
  const sel = doc?.getSelection();
  if (!doc || !sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const quote = range.toString();
  if (!quote.trim()) return;

  // Measure before pruning: unpaint() normalizes text nodes, and the offset is
  // stable across that whereas the range's containers are not.
  const start = measure(doc, range.startContainer, range.startOffset);
  pruneEmpty();
  const id = String(++seq);
  if (!paint(doc, start, quote.length, id)) return;

  comments.push({
    id,
    start,
    quote,
    prefix: planText.slice(Math.max(0, start - CONTEXT), start),
    suffix: planText.slice(start + quote.length, start + quote.length + CONTEXT),
    section: sectionFor(headings, start),
    body: "",
  });
  sortComments();

  sel.removeAllRanges();
  hideAdd();
  render();
  queueSave();
  const box = document.querySelector<HTMLTextAreaElement>(`.card[data-id="${id}"] textarea`);
  box?.focus();
  box?.scrollIntoView({ block: "nearest" });
}

// Avoid re-rendering mid-focus: focus would land on a detached card.
function dropEmpty(id: string) {
  const c = comments.find((x) => x.id === id);
  if (!c || c.body.trim()) return;
  comments = comments.filter((x) => x.id !== id);
  unpaint(doc, id);
  document.querySelector(`.card[data-id="${id}"]`)?.remove();
  $("none").hidden = comments.length > 0;
  refreshCount();
  queueSave();
}

function deleteComment(id: string) {
  comments = comments.filter((x) => x.id !== id);
  unpaint(doc, id);
  if (active === id) active = null;
  render();
  queueSave();
}

function discard(doomed: Comment[]) {
  const ids = new Set(doomed.map((c) => c.id));
  for (const id of ids) unpaint(doc, id);
  comments = comments.filter((c) => !ids.has(c.id));
  if (active && ids.has(active)) active = null;
  render();
  queueSave();
}

// Clear all with one confirmation, not one per card.
function clearComments() {
  const n = written().length;
  if (!n || !confirm(`Delete all ${n} comment${n === 1 ? "" : "s"}?`)) return;
  discard(comments);
}

function clearOrphans() {
  const lost = orphans();
  const n = lost.length;
  if (!n || !confirm(`Delete ${n} unanchored comment${n === 1 ? "" : "s"}?`)) return;
  discard(lost);
}

function setActive(id: string | null) {
  active = id;
  for (const card of $("cards").children) {
    card.classList.toggle("active", (card as HTMLElement).dataset.id === id);
  }
  for (const m of doc?.querySelectorAll<HTMLElement>("mark[data-comment]") ?? []) {
    m.classList.toggle("active", m.dataset.comment === id);
  }
}

function revealMark(id: string) {
  setActive(id);
  doc
    ?.querySelector(`mark[data-comment="${id}"]`)
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function focusCard(id: string) {
  setActive(id);
  const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

function onPlanClick(e: Event) {
  // Optional call: clicks land on the document too, which has no closest().
  const mark = (e.target as Element).closest?.("mark[data-comment]");
  const id = mark?.getAttribute("data-comment");
  if (id) focusCard(id);
  else setActive(null);
}

function render() {
  const cards = $("cards");
  cards.textContent = "";
  for (const c of comments) {
    const card = document.createElement("article");
    card.className = c.orphan ? "card orphan" : "card";
    card.dataset.id = c.id;

    const top = document.createElement("div");
    top.className = "top";
    const sec = document.createElement("div");
    sec.className = "sec";
    sec.textContent = c.section || "(no section)";
    top.append(sec);
    if (c.orphan) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "unanchored";
      top.append(tag);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "×";
    del.title = "Delete comment";
    del.addEventListener("click", () => {
      if (!c.body.trim() || confirm("Delete this comment?")) deleteComment(c.id);
    });
    top.append(del);

    const quote = document.createElement("blockquote");
    const flat = tidy(c.quote);
    quote.textContent = flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;

    const box = document.createElement("textarea");
    box.placeholder = "Comment… (Esc to cancel)";
    box.value = c.body;
    let atFocus = c.body;
    box.addEventListener("focus", () => {
      atFocus = c.body;
    });
    box.addEventListener("input", () => {
      c.body = box.value;
      refreshCount();
      queueSave();
    });
    // Blurring an empty comment discards it, so Esc on a new one removes the
    // card; on an existing one it only undoes the current edit.
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      c.body = atFocus;
      box.value = atFocus;
      box.blur();
      refreshCount();
      queueSave();
    });
    box.addEventListener("blur", () => dropEmpty(c.id));

    card.addEventListener("click", (e) => {
      if (!(e.target as Element).closest("button")) revealMark(c.id);
    });

    card.append(top, quote, box);
    cards.append(card);
  }
  $("none").hidden = comments.length > 0;
  if (active) setActive(active);
  refreshCount();
}

function written() {
  return comments.filter((c) => c.body.trim());
}
function orphans() {
  return comments.filter((c) => c.orphan);
}

function note(msg: string) {
  $("note").textContent = msg ? `· ${msg}` : "";
}

function refreshCount() {
  const n = written().length;
  $("count").textContent = doc ? `${n} comment${n === 1 ? "" : "s"}` : "";
  $<HTMLButtonElement>("exportBtn").disabled = n === 0;
  $<HTMLButtonElement>("jsonBtn").disabled = n === 0;
  $<HTMLButtonElement>("clearBtn").disabled = n === 0;
  $<HTMLButtonElement>("orphanBtn").disabled = orphans().length === 0;
}

function restore(saved: Review, exact = true) {
  if (!doc) return;
  for (const c of comments) unpaint(doc, c.id);

  // Reviews saved before context was recorded carry neither field.
  comments = saved.comments.map((c) => ({
    ...c,
    prefix: c.prefix ?? "",
    suffix: c.suffix ?? "",
  }));
  let lost = 0;
  for (const c of comments) {
    const at = locate(planText, c);
    c.orphan = !(at >= 0 && paint(doc, at, c.quote.length, c.id));
    if (c.orphan) lost += 1;
    else c.start = at;
    seq = Math.max(seq, Number(c.id) || 0);
  }
  sortComments();
  render();

  const n = comments.length;
  note(
    [
      `restored ${n} comment${n === 1 ? "" : "s"}`,
      lost ? `${lost} unanchored` : "",
      exact ? "" : "matched by filename",
      saved.path && planPath && saved.path !== planPath ? `saved as ${saved.path}` : "",
      saved.name && saved.name !== planName ? `from ${saved.name}` : "",
      saved.hash && saved.hash !== planHash ? "plan has changed since" : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

function currentKey() {
  return keyFor(planPath || planName);
}

function snapshot(): Review {
  return {
    name: planName,
    path: planPath,
    hash: planHash,
    savedAt: new Date().toISOString(),
    comments: written().map(({ id, start, quote, prefix, suffix, section, body }) => ({
      id,
      start,
      quote,
      prefix,
      suffix,
      section,
      body,
    })),
  };
}

function persist() {
  if (!storageOk || !planName) return;
  try {
    writeStore(localStorage, currentKey(), snapshot());
  } catch {
    storageOk = false;
    note("not saved: storage unavailable");
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}

function readSaved() {
  try {
    return readStore(localStorage, currentKey(), planName);
  } catch {
    storageOk = false;
    return null;
  }
}

function baseName() {
  return planName.replace(/\.html?$/i, "");
}

function exportText() {
  return markdown(written(), planLabel);
}

function download(text: string, name: string, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  document.body.append(link); // Safari ignores a click on a detached anchor
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function saveJSON() {
  return download(
    JSON.stringify(snapshot(), null, 2),
    `${baseName()}.review.json`,
    "application/json",
  );
}

function importJSON(text: string) {
  if (!doc) return note("open the plan first, then drop the review");
  let data: Review;
  try {
    data = JSON.parse(text);
  } catch {
    return note("that file is not valid JSON");
  }
  if (!Array.isArray(data.comments)) return note("no comments in that file");
  restore(data);
  queueSave();
}

// Save next to the plan when the browser supports it; otherwise download.
async function saveMarkdown() {
  const name = `${baseName()}.review.md`;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      });
      const stream = await handle.createWritable();
      await stream.write(exportText());
      await stream.close();
      $("status").textContent = `Saved ${handle.name}`;
      return;
    } catch (err) {
      const aborted = err as DOMException;
      if (aborted.name === "AbortError") return;
      $("status").textContent = `Could not save: ${aborted.message}`;
      return;
    }
  }
  download(exportText(), name, "text/markdown");
  $("status").textContent = `Downloaded ${name}`;
}

async function showExport() {
  const text = exportText();
  const md = $<HTMLTextAreaElement>("md");
  md.value = text;
  $("overlay").hidden = false;
  $("status").textContent = "";
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      md.select();
      ok = document.execCommand("copy");
    } catch {}
  }
  $("status").textContent = ok ? "Copied to clipboard" : "Select and copy";
  if (!ok) md.select();
}

function hideAdd() {
  $("add").hidden = true;
}

function onSelect() {
  const sel = doc?.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return hideAdd();

  const range = sel.getRangeAt(0);
  if (!range.toString().trim()) return hideAdd();

  const box = range.getBoundingClientRect();
  const frame = iframe.getBoundingClientRect();
  const add = $("add");
  add.hidden = false;
  const above = frame.top + box.top - add.offsetHeight - 6;
  add.style.top = `${above > frame.top ? above : frame.top + box.bottom + 6}px`;
  add.style.left = `${Math.min(frame.left + box.left, frame.right - add.offsetWidth - 8)}px`;
}

let planStyles = ""; // read once at boot to keep loadPlan synchronous

function loadPlan(html: string, name: string, label = "") {
  planName = name;
  planPath = label;
  planLabel = label || name;
  comments = [];
  seq = 0;
  active = null;
  hideAdd();

  iframe.onload = () => {
    let loaded: Document | null = null;
    try {
      loaded = iframe.contentDocument;
    } catch {
      // Some browsers throw instead of returning null.
    }
    if (!loaded) {
      fail("Cannot read the plan", "This browser blocks access to the sandboxed frame.");
      return;
    }
    doc = loaded;

    // Scripts are inert under this sandbox, but their source text would
    // otherwise count as document text and shift every offset past it.
    for (const s of doc.querySelectorAll("script")) s.remove();
    doc.querySelector("#width")?.remove();

    // srcdoc has no useful base URL for a stylesheet link.
    const style = doc.createElement("style");
    style.textContent = planStyles;
    doc.head.append(style);

    headings = readHeadings(doc);
    planText = bodyText(doc);
    planHash = hash(planText);
    doc.addEventListener("selectionchange", onSelect);
    doc.addEventListener("click", onPlanClick);
    // Drag events over the frame never bubble out to us.
    for (const [type, fn] of Object.entries(DRAG)) doc.addEventListener(type, fn);

    $("empty").hidden = true;
    $("name").textContent = elide(planLabel);
    $("name").title = planLabel;
    document.title = `${planLabel} — Plan reviewer`;

    const found = readSaved();
    if (found) {
      restore(found.data, found.exact);
    } else {
      render();
      note(storageOk ? "" : "not saved: storage unavailable");
    }
  };

  iframe.srcdoc = html;
}

function fail(title: string, detail: string) {
  const empty = $("empty");
  empty.textContent = "";
  const heading = document.createElement("b");
  heading.textContent = title;
  const sub = document.createElement("span");
  sub.textContent = detail;
  empty.append(heading, sub);
  empty.hidden = false;
}

function openFile(file: File | undefined) {
  if (!file) return;
  const isReview = /\.json$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    if (isReview) importJSON(text);
    else loadPlan(text, file.name);
  };
  reader.readAsText(file);
}

// Keep the selection while clicking Add.
$("add").addEventListener("mousedown", (e) => e.preventDefault());
$("add").addEventListener("click", addComment);
$("openBtn").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => openFile((e.target as HTMLInputElement).files?.[0]));
$("orphanBtn").addEventListener("click", clearOrphans);
$("clearBtn").addEventListener("click", clearComments);
$("jsonBtn").addEventListener("click", saveJSON);
$("exportBtn").addEventListener("click", showExport);
$("mdBtn").addEventListener("click", saveMarkdown);
$("closeBtn").addEventListener("click", () => ($("overlay").hidden = true));
$("overlay").addEventListener("click", (e) => {
  if (e.target === $("overlay")) $("overlay").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("overlay").hidden = true;
});

let dragDepth = 0;
const DRAG: Record<string, (e: Event) => void> = {
  dragenter: (e) => {
    e.preventDefault();
    if (++dragDepth === 1) $("drop").hidden = false;
  },
  dragover: (e) => e.preventDefault(),
  dragleave: () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $("drop").hidden = true;
    }
  },
  drop: (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("drop").hidden = true;
    openFile((e as DragEvent).dataTransfer?.files?.[0]);
  },
};
for (const [type, fn] of Object.entries(DRAG)) window.addEventListener(type, fn);

// Exposed so a browser suite can drive loading without a real drop.
const reviewer = {
  loadPlan,
  importJSON,
  markdown: exportText,
  revealMark,
  comments: () => comments,
};

async function boot() {
  planStyles = await planCss();
  // Only now, so `window.reviewer` appearing means a plan can be loaded.
  window.reviewer = reviewer;

  const plan = new URLSearchParams(location.search).get("plan");
  if (!plan) return;

  const label = shorten(plan);
  try {
    const res = await fetch(`/plan?path=${encodeURIComponent(plan)}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    loadPlan(await res.text(), plan.split("/").pop() ?? plan, label);
  } catch (err) {
    fail(`Could not load ${label}`, `${(err as Error).message} — is \`just serve\` running?`);
  }
}
boot();
