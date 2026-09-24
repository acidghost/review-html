// Embed CSS for injection into the plan iframe.
import css from "./plan.css" with { type: "text" };

export async function planCss() {
  return css;
}
