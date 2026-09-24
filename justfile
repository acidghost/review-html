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

# Open the fixture plan
demo:
    just review test/fixtures/plan.html

# Compile the server and its HTML/CSS/TypeScript assets into one executable.
build:
    mkdir -p {{ justfile_directory() }}/dist
    bun build --compile --no-compile-autoload-dotenv \
      --outfile {{ justfile_directory() }}/dist/review-html \
      {{ justfile_directory() }}/src/cli.ts

# Put it on PATH, where it needs neither this checkout nor bun
install: build
    install -m 755 {{ justfile_directory() }}/dist/review-html ~/.local/bin/review-html

# Everything; the browser suite skips itself unless `just browser` has run
test:
    bun test

fmt:
    biome check --write src test

check: typecheck
    biome check src test

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
