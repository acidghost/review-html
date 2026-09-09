/* A dropped file only ever tells us its basename — no browser exposes where it
   came from. `just review` therefore serves the plan and names it in the query
   string: ?plan= is relative to the server root, and ?label= is how it should
   read on screen. */

export const shorten = (path: string) =>
  path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");

export const elide = (s: string, max = 64) =>
  s.length <= max ? s : `${s.slice(0, 14)}…${s.slice(-(max - 15))}`;

// `label` comes straight off the query string, so null is its natural empty.
export const labelFor = (plan: string, label: string | null) =>
  label || (plan.startsWith("/") ? shorten(plan) : `~/${plan}`);
