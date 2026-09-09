# review-html

Read a Claude Code plan, attach inline comments to highlighted text, export them
as Markdown to forward back to Claude.

No build step to develop: the browser asks for one ES module per file, and
`server.ts` takes the types off each on the way out. Nothing is written to disk
and every import specifier reaches the browser as written — so the sources
under `app/` are what runs. `just bundle` is the one exception, and what it
writes lands in `dist/`.

Nothing ships as a dependency either. Three arrive for development:
`typescript` and `@types/bun` for `just typecheck`, and `playwright` for the
browser suite. Both `mise.toml` and `bunfig.toml` hold new releases back a week
before either will install them.

`mise.toml` covers what has to exist before `bun install` can run — bun itself,
plus `just` and `biome`. Everything else is a `bun install` away.

## Use

    just review ~/path/to/repo/.plans/2026-09-08-thing.html

Starts a loopback server and opens the reviewer pointed at that plan. Select
text, *Add comment*, type; comments save themselves. *Copy Markdown* puts the
export on the clipboard, *Save .md* writes `<plan>.review.md`.

The reviewer and the plans are two namespaces. The reviewer comes off this
checkout at a fixed `/review.html`; plans are read by absolute path through
`/plan`, bounded by a root of their own — your work area by default. Plans
outside it are refused, and only `.html` is served: anything readable under
that root is one loopback GET away, which is why it is not `$HOME`. Set
`REVIEW_ROOT` to move the boundary.

The recipe is a single call to `server.ts --open`, which resolves the plan,
reuses a server already listening on the port, and starts a detached one only
if there is none. So `just review` is safe to run repeatedly.

`just open` starts the same server with no plan loaded, ready for a dropped
file — everything works except the plan's path, which the browser withholds, so
a review is then keyed on the filename alone. `just stop` shuts the server down.

### One file, no server

    just bundle && open dist/review.html

`dist/review.html` is the whole reviewer — modules and both stylesheets
inlined — so it opens from Finder. Drop a plan in and everything works except
loading one by path, which a `file://` page cannot do; a review is then keyed
on the filename alone, the same trade `just open` makes.

The sources say `<script type="module" src=…>`, which does not load over
`file://`. The bundle has no `src` to fetch, which is the whole of the trick.

## How comments stay attached

Each comment stores the quoted text, 32 characters of context either side, and a
character offset into the plan's body text. Reopening a revised plan re-finds
every quote: by offset, then by context, then by nearest match. Quotes that have
gone are marked unanchored rather than dropped, so a stale comment is visible
instead of silently lost.

The plan renders in `<iframe sandbox="allow-same-origin">`. Its CSS cannot reach
the reviewer, its scripts do not run, and the parent can still read selections
and paint highlights.

## Layout

| file            | what it holds                                       |
| --------------- | --------------------------------------------------- |
| `review.html`   | markup only                                         |
| `app/main.ts`   | state and wiring; the only DOM-heavy file           |
| `app/anchor.ts` | `locate`, the heading breadcrumb, the hash          |
| `app/frame.ts`  | painting and measuring inside the plan's iframe     |
| `app/store.ts`  | `localStorage`, keyed by the plan's path            |
| `app/*.css`     | reviewer chrome, and what is injected into plans    |
| `server.ts`     | serves, transpiles, and builds the URL to open       |
| `bundle.ts`     | the same app as one file                            |

`frame.ts` takes the plan's `document` as an argument and `store.ts` takes the
storage object, so neither reaches for a global — which is what makes them
testable. `anchor.ts` names the comment record the other four share.

`app/plan-css.ts` is the one place the served and bundled builds differ: served,
it fetches its sibling `plan.css`; bundled, `bundle.ts` swaps it for a module
returning the same text. Nothing downstream knows which it is running in.

## Develop

    just bundle    # dist/review.html, the single-file reviewer

    just test      # everything, under bun test
    just check     # typecheck, then biome over app/ test/ review.html server.ts
    just fmt       # biome again, with fixes applied
    just typecheck # tsc alone

    just browser   # one-off: download the browser the e2e suite drives
    just e2e       # only the browser suite

`test/e2e.test.js` drives a real Chromium over the selection, painting,
click-through and re-anchoring paths — the half that pure functions cannot
reach. It skips itself, with the reason, when no browser is installed, so
`just test` stays useful without one.
