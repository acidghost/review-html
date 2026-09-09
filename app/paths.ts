/* A dropped file only ever tells us its basename — no browser exposes where it
   came from. `just review` therefore serves the plan and names it in the query
   string: ?plan= is the plan's absolute path, which is all the header needs. */

export const shorten = (path: string) =>
  path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");

export const elide = (s: string, max = 64) =>
  s.length <= max ? s : `${s.slice(0, 14)}…${s.slice(-(max - 15))}`;
