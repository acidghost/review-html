/* The stylesheet injected into the plan's iframe, as text.

   Served, it fetches its own sibling. Bundled, there is no sibling to fetch:
   the build replaces this module with one returning the same CSS as a
   literal. A module of its own rather than a branch in main.ts, so nothing
   downstream knows which of the two it is running in. */

export const planCss = async () =>
  (await fetch(new URL("plan.css", import.meta.url))).text();
