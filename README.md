# review-html

Read a Claude Code plan, attach inline comments to highlighted text, export them
as Markdown to forward back to Claude.

No build step to develop: the browser asks for one ES module per file, and
`src/server.ts` takes the types off each on the way out — so the sources under
`src/` are what runs, with every import specifier reaching the browser as
written. The two builds are for shipping, and everything they write lands in
`dist/`: `just bundle` for the single page, `just build` for the binary that
embeds it.

Nothing ships as a dependency either. Three arrive for development:
`typescript` and `@types/bun` for `just typecheck`, and `playwright` for the
browser suite. Both `mise.toml` and `bunfig.toml` hold new releases back a week
before either will install them.

`mise.toml` covers what has to exist before `bun install` can run — bun itself,
plus `just` and `biome`. Everything else is a `bun install` away.

## Use

    just install
    review-html ~/path/to/repo/.plans/2026-09-08-thing.html

One compiled binary on `$PATH`, run from any directory. It starts a loopback
server if none is listening, hands it that plan, and opens the reviewer on it.
Select text, *Add comment*, type; comments save themselves. *Copy Markdown*
puts the export on the clipboard, *Save .md* writes `<plan>.review.md`.

    review-html          the reviewer with no plan, ready for a dropped file
    review-html serve    run the server in the foreground
    review-html stop     stop it
    review-html status   what is running, and which plans it will serve

Subcommands win the bare word, so a plan named `serve` is reachable as
`./serve`. The port is fixed at 8422: saved reviews are keyed to the origin,
and the port is part of that, so a review made on one port would not be found
on another. Only one server is tracked at a time; stop it before starting on a
different port.

`just review`, `just serve`, `just stop` and `just status` are the same
commands against the working copy, which is what to use while changing this.

### What the server will read

The server serves nothing it was not handed. `review-html <plan>` resolves the
path itself — it has your files and your `cwd`, the server needs neither — and
registers that one file; `/plan?path=…` refuses everything else. So a plan may
live anywhere, and `~/.ssh/id_rsa` is refused because nobody opened it as a
plan.

Registering a plan and stopping the server are authenticated operations;
`POST /_open` and `POST /_shutdown` require a token from
`~/.cache/review-html/state.json`, which is `0600` in a `0700` directory. The
status endpoint uses the token too. A local process can read it; a web page
cannot, and sending it in a custom header puts these requests behind a
preflight that goes unanswered. Shutdown is requested from the server itself;
the CLI does not signal a PID read from the state file.

Be precise about who that stops. A malicious page you visit can *send* a
request to `127.0.0.1:8422`, but with no `Access-Control-Allow-Origin` coming
back it cannot read the response — the same-origin policy does that work. The
allowlist is what stops a *local* reader: any other process on the machine can
curl loopback and read whatever it is given, and CORS has nothing to say about
that.

The allowlist is in memory, so restarting the server empties it and a stale
tab's reload gets a 403 saying so. Set `REVIEW_ROOT` for a hard ceiling on
what may be registered at all; unset, the allowlist is the whole boundary.

### One file, no server

    just bundle && open dist/review.html

`dist/review.html` is the whole reviewer — modules and both stylesheets
inlined — so it opens from Finder. Drop a plan in and everything works except
loading one by path, which a `file://` page cannot do; a review is then keyed
on the filename alone, the same trade `review-html` with no plan makes.

The sources say `<script type="module" src=…>`, which does not load over
`file://`. The bundle has no `src` to fetch, which is the whole of the trick.

## How comments stay attached

Each comment stores the quoted text, 32 characters of context either side, and a
character offset into the plan's body text. Reopening a revised plan re-finds
every quote: by offset, then by context, then by nearest match. Quotes that have
gone are marked unanchored rather than dropped, so a stale comment is visible
instead of silently lost. Once read, *Clear unanchored* sweeps them all.

The plan renders in `<iframe sandbox="allow-same-origin">`. Its CSS cannot reach
the reviewer, its scripts do not run, and the parent can still read selections
and paint highlights.

## Layout

| file                | what it holds                                       |
| ------------------- | --------------------------------------------------- |
| `src/review.html`   | markup only                                         |
| `src/app/main.ts`   | state and wiring; the only DOM-heavy file           |
| `src/app/anchor.ts` | `locate`, the heading breadcrumb, the hash          |
| `src/app/frame.ts`  | painting and measuring inside the plan's iframe     |
| `src/app/store.ts`  | `localStorage`, keyed by the plan's path            |
| `src/app/*.css`     | reviewer chrome, and what is injected into plans    |
| `src/server.ts`     | routes, the transpile, and the allowlist            |
| `src/cli.ts`        | the commands, and the URL to open                   |
| `src/state.ts`      | pid, port and token, at `0600`                      |
| `src/binary.ts`     | the compile entrypoint: `src/cli.ts` plus that file |
| `scripts/bundle.ts` | the same app as one file                            |

`frame.ts` takes the plan's `document` as an argument and `store.ts` takes the
storage object, so neither reaches for a global — which is what makes them
testable. `anchor.ts` names the comment record the other four share.

`src/app/plan-css.ts` is the one place the served and bundled builds differ:
served, it fetches its sibling `plan.css`; bundled, `scripts/bundle.ts` swaps it
for a module returning the same text. Nothing downstream knows which it is
running in.

`src/server.ts` has the same shape either way. Compiled it is handed the page
and serves it from memory; from the checkout it serves `src/` off the disk,
which is the only reason the transpile exists.

## Develop

    just bundle    # dist/review.html, the single-file reviewer
    just build     # dist/review-html, the binary; 61MB of it is bun
    just install   # that binary, into ~/.local/bin

    just test      # everything, under bun test
    just check     # typecheck, then biome
    just fmt       # biome again, with fixes applied
    just typecheck # tsc alone

    just browser   # one-off: download the browser the e2e suite drives
    just e2e       # only the browser suite

`test/e2e.test.js` drives a real Chromium over the selection, painting,
click-through and re-anchoring paths — the half that pure functions cannot
reach — and over the bundle from a `file://` URL, which is what keeps the two
builds from drifting apart. `test/cli.test.js` starts and stops real servers.
Both skip themselves, with the reason, where they cannot run: no browser
installed, or a sandbox that will not let a test have a port. So `just test`
stays useful in either.
