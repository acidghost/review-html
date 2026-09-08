/* A dropped file only ever tells us its basename — no browser exposes where it
   came from. `just review` therefore serves the plan and names it in the query
   string: ?plan= is relative to the server root, and ?label= is how it should
   read on screen. */

export const shorten = (path) =>
  path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");

export const elide = (s, max = 64) =>
  s.length <= max ? s : `${s.slice(0, 14)}…${s.slice(-(max - 15))}`;

export const labelFor = (plan, label) =>
  label || (plan.startsWith("/") ? shorten(plan) : `~/${plan}`);
