import { tidy } from "./anchor.js";

/* The export is the whole point of the tool: what gets pasted back to Claude. */
export const markdown = (list, label) => {
  const head = `Review of \`${label}\` — ${list.length} comment${
    list.length === 1 ? "" : "s"
  }`;
  const blocks = list.map((c, i) => {
    const where = c.section ? ` · ${c.section}` : "";
    const tag = c.orphan ? " · unanchored" : "";
    return `## ${i + 1}${where}${tag}\n> ${tidy(c.quote)}\n\n${c.body.trim()}`;
  });
  return `${[head, ...blocks].join("\n\n")}\n`;
};
