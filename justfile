port := "8422"
cli := "bun run " + justfile_directory() + "/src/cli.ts --port " + port

# Open the reviewer with no plan loaded, ready for a dropped file
open:
    just review

# Review a plan: just review ~/path/to/repo/.plans/2026-09-08-thing.html
# The cd is what lets a relative plan mean what you typed.
review plan="":
    cd {{ quote(invocation_directory()) }} && {{ cli }} {{ quote(plan) }}

# Serve in the foreground; `just review` starts a detached one of these
serve:
    {{ cli }} serve

# Stop the server `just review` left running
stop:
    {{ cli }} stop

# What is running, and which plans it will serve
status:
    {{ cli }} status

# Open the bundled fixture plan
demo:
    just review test/fixtures/plan.html

# Build dist/review.html: the whole reviewer in one file, openable from Finder
bundle:
    bun run {{ justfile_directory() }}/scripts/bundle.ts

# Compile the standalone binary. ~60MB of it is the bun runtime.
build: bundle
    bun build --compile --outfile {{ justfile_directory() }}/dist/review-html \
      {{ justfile_directory() }}/src/binary.ts

# Put it on PATH, where it needs neither this checkout nor bun
install: build
    install -m 755 {{ justfile_directory() }}/dist/review-html ~/.local/bin/review-html

# Everything; the browser suite skips itself unless `just browser` has run
test:
    bun test

fmt:
    biome check --write src scripts test

check: typecheck
    biome check src scripts test

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
