port := "8422"

# A plan and this checkout have to sit under one served root; the directory you
# cloned into is the smallest one that covers both without knowing your layout.
root := env("REVIEW_ROOT", parent_directory(justfile_directory()))

# Open the reviewer with no plan loaded, ready for a dropped file
open:
    just review

# Serve the work area on loopback, so the reviewer can fetch plans by path
serve:
    REVIEW_ROOT="{{ root }}" bun run {{ justfile_directory() }}/server.ts --port {{ port }}

# Stop a server left running by `just review`
stop:
    -pkill -f "server.ts --port {{ port }}"

# Review a plan: just review ~/path/to/repo/.plans/2026-09-08-thing.html
# The cd is what lets a relative plan mean what you typed; --open resolves it,
# starts a server if none is listening, and opens the browser.
review plan="":
    cd {{ quote(invocation_directory()) }} && REVIEW_ROOT="{{ root }}" \
      bun run {{ justfile_directory() }}/server.ts \
      --port {{ port }} --open {{ quote(plan) }}

# Open the bundled fixture plan
demo:
    just review test/fixtures/plan.html

# Everything; the browser suite skips itself unless `just browser` has run
test:
    bun test

fmt:
    biome check --write app test review.html server.ts

check: typecheck
    biome check app test review.html server.ts

# node_modules/.bin rather than bunx, which would reach for the registry if the
# devDependency were missing instead of saying so
typecheck:
    node_modules/.bin/tsc

# Download the browser the e2e tests need (network: cdn.playwright.dev).
# The package ships no postinstall, so this stays an explicit one-off.
browser:
    node_modules/.bin/playwright install chromium

# Only the browser suite
e2e:
    bun test test/e2e.test.js
