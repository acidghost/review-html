import { CONTEXT, hash, locate, sectionFor, tidy } from "./anchor.js";
import { bodyText, measure, paint, readHeadings, unpaint } from "./frame.js";
import { markdown } from "./markdown.js";
import { elide, labelFor } from "./paths.js";
import { keyFor, read as readStore, write as writeStore } from "./store.js";

const $ = (id) => document.getElementById(id);
const iframe = $("plan");

let doc = null; // the plan's document, inside the iframe
let comments = []; // kept sorted by `start`
let headings = []; // {level, text, start}, for section breadcrumbs
let planName = ""; // basename, all the File API reliably gives us
let planPath = ""; // the path `just review` passed; empty for a dropped file
let planLabel = ""; // planPath, or the basename when that is all we have
let planText = ""; // body text as loaded; painting never alters it
let planHash = "";
let saveTimer = null;
let storageOk = true;
let seq = 0;
let active = null; // id of the comment highlighted on both sides

/* ---------- comments ---------- */

// Orphans first: they need attention and have no place in the document.
const sortComments = () =>
  comments.sort(
    (a, b) => Number(!!b.orphan) - Number(!!a.orphan) || a.start - b.start,
  );

// Removing a focused textarea does not reliably fire blur, so an empty draft
// can outlive the re-render that replaced it.
const pruneEmpty = () => {
  for (const c of comments.filter((x) => !x.body.trim())) unpaint(doc, c.id);
  comments = comments.filter((c) => c.body.trim());
};

const addComment = () => {
  const sel = doc?.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
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
    suffix: planText.slice(
      start + quote.length,
      start + quote.length + CONTEXT,
    ),
    section: sectionFor(headings, start),
    body: "",
  });
  sortComments();

  doc.getSelection().removeAllRanges();
  hideAdd();
  render();
  queueSave();
  const box = document.querySelector(`.card[data-id="${id}"] textarea`);
  box.focus();
  box.scrollIntoView({ block: "nearest" });
};

/* Focusing another card blurs this one, so this runs mid-focus(): drop the one
   card instead of re-rendering, or focus lands on a dead node. */
const dropEmpty = (id) => {
  const c = comments.find((x) => x.id === id);
  if (!c || c.body.trim()) return;
  comments = comments.filter((x) => x.id !== id);
  unpaint(doc, id);
  document.querySelector(`.card[data-id="${id}"]`)?.remove();
  $("none").hidden = comments.length > 0;
  refreshCount();
  queueSave();
};

const deleteComment = (id) => {
  comments = comments.filter((x) => x.id !== id);
  unpaint(doc, id);
  if (active === id) active = null;
  render();
  queueSave();
};

const setActive = (id) => {
  active = id;
  for (const card of $("cards").children) {
    card.classList.toggle("active", card.dataset.id === id);
  }
  for (const m of doc?.querySelectorAll("mark[data-comment]") ?? []) {
    m.classList.toggle("active", m.dataset.comment === id);
  }
};

const revealMark = (id) => {
  setActive(id);
  doc
    ?.querySelector(`mark[data-comment="${id}"]`)
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
};

const focusCard = (id) => {
  setActive(id);
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.querySelector("textarea").focus();
};

const onPlanClick = (e) => {
  const mark = e.target.closest?.("mark[data-comment]");
  if (mark) focusCard(mark.dataset.comment);
  else setActive(null);
};

const render = () => {
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
      if (!c.body.trim() || confirm("Delete this comment?"))
        deleteComment(c.id);
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
      if (!e.target.closest("button")) revealMark(c.id);
    });

    card.append(top, quote, box);
    cards.append(card);
  }
  $("none").hidden = comments.length > 0;
  if (active) setActive(active);
  refreshCount();
};

const written = () => comments.filter((c) => c.body.trim());

const note = (msg) => {
  $("note").textContent = msg ? `· ${msg}` : "";
};

const refreshCount = () => {
  const n = written().length;
  $("count").textContent = doc ? `${n} comment${n === 1 ? "" : "s"}` : "";
  $("exportBtn").disabled = n === 0;
  $("jsonBtn").disabled = n === 0;
};

/* ---------- re-anchoring ---------- */

const restore = (saved, exact = true) => {
  for (const c of comments) unpaint(doc, c.id);

  comments = saved.comments.map((c) => ({ prefix: "", suffix: "", ...c }));
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
      saved.path && planPath && saved.path !== planPath
        ? `saved as ${saved.path}`
        : "",
      saved.name && saved.name !== planName ? `from ${saved.name}` : "",
      saved.hash && saved.hash !== planHash ? "plan has changed since" : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
};

/* ---------- storage ---------- */

const currentKey = () => keyFor(planPath || planName);

const snapshot = () => ({
  name: planName,
  path: planPath,
  hash: planHash,
  savedAt: new Date().toISOString(),
  comments: written().map(
    ({ id, start, quote, prefix, suffix, section, body }) => ({
      id,
      start,
      quote,
      prefix,
      suffix,
      section,
      body,
    }),
  ),
});

const persist = () => {
  if (!storageOk || !planName) return;
  try {
    writeStore(localStorage, currentKey(), snapshot());
  } catch {
    storageOk = false;
    note("not saved: storage unavailable");
  }
};

const queueSave = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
};

const readSaved = () => {
  try {
    return readStore(localStorage, currentKey(), planName);
  } catch {
    storageOk = false;
    return null;
  }
};

/* ---------- export ---------- */

const baseName = () => planName.replace(/\.html?$/i, "");

const exportText = () => markdown(written(), planLabel);

const download = (text, name, type) => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  document.body.append(link); // Safari ignores a click on a detached anchor
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

const saveJSON = () =>
  download(
    JSON.stringify(snapshot(), null, 2),
    `${baseName()}.review.json`,
    "application/json",
  );

const importJSON = (text) => {
  if (!doc) return note("open the plan first, then drop the review");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return note("that file is not valid JSON");
  }
  if (!Array.isArray(data.comments)) return note("no comments in that file");
  restore(data);
  queueSave();
};

/* The picker can put the file next to the plan, so Claude gets a path instead
   of a paste. Chromium only; elsewhere this downloads. */
const saveMarkdown = async () => {
  const name = `${baseName()}.review.md`;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          { description: "Markdown", accept: { "text/markdown": [".md"] } },
        ],
      });
      const stream = await handle.createWritable();
      await stream.write(exportText());
      await stream.close();
      $("status").textContent = `Saved ${handle.name}`;
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
      $("status").textContent = `Could not save: ${err.message}`;
      return;
    }
  }
  download(exportText(), name, "text/markdown");
  $("status").textContent = `Downloaded ${name}`;
};

const showExport = async () => {
  const text = exportText();
  $("md").value = text;
  $("overlay").hidden = false;
  $("status").textContent = "";
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      $("md").select();
      ok = document.execCommand("copy");
    } catch {}
  }
  $("status").textContent = ok ? "Copied to clipboard" : "Select and copy";
  if (!ok) $("md").select();
};

/* ---------- selection ---------- */

const hideAdd = () => {
  $("add").hidden = true;
};

const onSelect = () => {
  const sel = doc.getSelection();
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
};

/* ---------- loading ---------- */

const PLAN_CSS = new URL("plan.css", import.meta.url).href;

const loadPlan = (html, name, label = "") => {
  planName = name; // basename: names the downloads, and the weak match key
  planPath = label; // the stable storage key; empty for a dropped file
  planLabel = label || name;
  comments = [];
  seq = 0;
  active = null;
  hideAdd();

  iframe.onload = () => {
    try {
      doc = iframe.contentDocument;
      if (!doc) throw new Error("no document");
    } catch {
      fail(
        "Cannot read the plan",
        "This browser blocks access to the sandboxed frame.",
      );
      return;
    }

    // Scripts are inert under this sandbox, but their source text would
    // otherwise count as document text and shift every offset past it.
    for (const s of doc.querySelectorAll("script")) s.remove();
    doc.querySelector("#width")?.remove();

    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = PLAN_CSS; // absolute: srcdoc has no useful base URL of its own
    doc.head.append(link);

    headings = readHeadings(doc);
    planText = bodyText(doc);
    planHash = hash(planText);
    doc.addEventListener("selectionchange", onSelect);
    doc.addEventListener("click", onPlanClick);
    // Drag events over the frame never bubble out to us.
    for (const [type, fn] of Object.entries(DRAG))
      doc.addEventListener(type, fn);

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
};

const fail = (title, detail) => {
  const empty = $("empty");
  empty.textContent = "";
  const heading = document.createElement("b");
  heading.textContent = title;
  const sub = document.createElement("span");
  sub.textContent = detail;
  empty.append(heading, sub);
  empty.hidden = false;
};

const openFile = (file) => {
  if (!file) return;
  const isReview = /\.json$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    if (isReview) importJSON(text);
    else loadPlan(text, file.name);
  };
  reader.readAsText(file);
};

/* ---------- wiring ---------- */

$("add").addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
$("add").addEventListener("click", addComment);
$("openBtn").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => openFile(e.target.files[0]));
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
const DRAG = {
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
    openFile(e.dataTransfer?.files?.[0]);
  },
};
for (const [type, fn] of Object.entries(DRAG))
  window.addEventListener(type, fn);

/* Served mode: fetch the plan named in the query string. Relative to the
   server root, so root-anchored rather than page-relative. */
const boot = async () => {
  const params = new URLSearchParams(location.search);
  const plan = params.get("plan");
  if (!plan) return;

  const label = labelFor(plan, params.get("label"));
  const url = `/${plan.split("/").map(encodeURIComponent).join("/")}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    loadPlan(await res.text(), plan.split("/").pop(), label);
  } catch (err) {
    fail(
      `Could not load ${label}`,
      `${err.message} — is \`just serve\` running?`,
    );
  }
};
boot();

// Exposed so a browser suite can drive loading without a real drop.
window.reviewer = {
  loadPlan,
  importJSON,
  markdown: exportText,
  revealMark,
  comments: () => comments,
};
