#!/usr/bin/env bun
/* The compile entrypoint. Everything is in cli.ts; this adds the one thing a
   binary cannot read off the disk — the reviewer itself, embedded as the
   single page `just bundle` produces. */

import { main } from "./cli.ts";
import page from "./dist/review.html" with { type: "text" };

/* bun-types declares every .html import as an HTMLBundle, for the fullstack
   server this is not using; `with { type: "text" }` makes it a string. */
await main({ page: page as unknown as string });
