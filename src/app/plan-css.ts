/* Imported as text so the Bun HTML build embeds it in the browser bundle;
   it is injected into the plan iframe rather than linked from the page. */
import css from "./plan.css" with { type: "text" };

export const planCss = async () => css;
