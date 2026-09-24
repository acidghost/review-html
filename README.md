# review-html

Read a Claude Code plan, attach inline comments to highlighted text, export them
as Markdown to forward back to Claude.

No build step to develop: `src/server.ts` imports `src/review.html`, and Bun
bundles its TypeScript and CSS assets when serving the page. `just build` uses
that same HTML-aware entry point to compile the server and UI assets into one
binary under `dist/`.

Nothing ships as a dependency either. Three arrive for development: `typescript`
and `@types/bun` for `just typecheck`, and `playwright` for the browser suite.
Both `mise.toml` and `bunfig.toml` hold new releases back a week before either
will install them.

`mise.toml` covers what has to exist before `bun install` can run — bun itself,
plus `just` and `biome`. Everything else is a `bun install` away.

## Use

    just install
    review-html ~/path/to/repo/.plans/2026-09-08-thing.html

One compiled binary on `$PATH`, run from any directory. It starts a loopback
server if none is listening, hands it that plan, and opens the reviewer on it.
Select text, _Add comment_, type; comments save themselves. _Copy Markdown_ puts
the export on the clipboard, _Save .md_ writes `<plan>.review.md`. _Plans_ lists
registered plans: switch to one, or remove it from the list without deleting its
HTML file or comments. The list survives server restarts.

    review-html          the reviewer with no plan, ready for a dropped file
    review-html serve    run the server in the foreground
    review-html stop     stop it
    review-html status   what is running, and which plans it will serve

Subcommands win the bare word, so a plan named `serve` is reachable as
`./serve`. The port is fixed at 8422: saved reviews are keyed to the origin, and
the port is part of that, so a review made on one port would not be found on
another. Only one server is tracked at a time; stop it before starting on a
different port.

`just review`, `just serve`, `just stop` and `just status` are the same commands
against the working copy, which is what to use while changing this.

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
cannot, and sending it in a custom header puts these requests behind a preflight
that goes unanswered. Shutdown is requested from the server itself; the CLI does
not signal a PID read from the state file.

Be precise about who that stops. A malicious page you visit can _send_ a request
to `127.0.0.1:8422`, but with no `Access-Control-Allow-Origin` coming back it
cannot read the response — the same-origin policy does that work. The allowlist
is what stops a _local_ reader: any other process on the machine can curl
loopback and read whatever it is given, and CORS has nothing to say about that.

Registered plans persist in `~/.cache/review-html/state.json` across restarts;
only the server PID and token are cleared on stop. `/plans` lists registered
paths to the reviewer and `/plans/close` forgets a path (never its file or saved
review). These browser routes are separate from the token-protected `/_…` CLI
control routes. Dropped files have no known absolute path and are not registered.
Set `REVIEW_ROOT` for a hard ceiling on what may be registered or restored;
paths outside the ceiling stay saved but are not listed or served until the
ceiling permits them again. With no ceiling, the allowlist is the whole boundary.

## How comments stay attached

Each comment stores the quoted text, 32 characters of context either side, and a
character offset into the plan's body text. Reopening a revised plan re-finds
every quote: by offset, then by context, then by nearest match. Quotes that have
gone are marked unanchored rather than dropped, so a stale comment is visible
instead of silently lost. Once read, _Clear unanchored_ sweeps them all.

The plan renders in `<iframe sandbox="allow-same-origin">`. Its CSS cannot reach
the reviewer, its scripts do not run, and the parent can still read selections
and paint highlights.

## Layout

| file                | what it holds                                      |
| ------------------- | -------------------------------------------------- |
| `src/review.html`   | HTML entry point for Bun's browser bundler         |
| `src/app/main.ts`   | state and wiring; the only DOM-heavy file          |
| `src/app/anchor.ts` | `locate`, the heading breadcrumb, the hash         |
| `src/app/frame.ts`  | painting and measuring inside the plan's iframe    |
| `src/app/store.ts`  | `localStorage`, keyed by the plan's path           |
| `src/app/*.css`     | reviewer chrome, and what is injected into plans   |
| `src/server.ts`     | Bun HTML route, API routes, and the plan allowlist |
| `src/cli.ts`        | the commands, and the URL to open                  |
| `src/state.ts`      | pid, port, token and registered plans, at `0600`   |

`frame.ts` takes the plan's `document` as an argument and `store.ts` takes the
storage object, so neither reaches for a global — which is what makes them
testable. `anchor.ts` names the comment record the other four share.

`src/app/plan-css.ts` imports `plan.css` as text. Bun includes it in the browser
bundle, where it is injected into the plan's iframe. `src/server.ts` uses Bun's
HTML route in development and in the compiled executable; Bun serves the page
and its generated assets in both cases.

## Develop

    just build     # dist/review-html, the binary; about 60MB of it is bun
    just install   # that binary, into ~/.local/bin

    just test      # everything, under bun test
    just check     # typecheck, then biome
    just fmt       # biome again, with fixes applied
    just typecheck # strict sources, relaxed tests

    just browser   # one-off: download the browser the e2e suite drives
    just e2e       # only the browser suite

`test/e2e.test.ts` drives a real Chromium over the served page, selection,
painting, click-through and re-anchoring paths — the half that pure functions
cannot reach. `test/cli.test.ts` starts and stops real servers. Both skip
themselves, with the reason, where they cannot run: no browser installed, or a
sandbox that will not let a test have a port. So `just test` stays useful in
either.
