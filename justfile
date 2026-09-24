port := "8422"
cli := "bun run " + justfile_directory() + "/src/cli.ts --port " + port

# Open the reviewer with no plan loaded, ready for a dropped file
open:
    just review

# Review a plan, resolving relative paths from the caller's directory
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

# Format and lint sources and tests
fmt:
    biome check --write src test

# Type-check and lint sources and tests
check: typecheck
    biome check src test

# Type-check sources strictly and tests with relaxed settings
typecheck:
    node_modules/.bin/tsc
    node_modules/.bin/tsc -p tsconfig.test.json

# Download the browser for e2e tests (requires network access)
browser:
    node_modules/.bin/playwright install chromium

# Only the browser suite
e2e:
    bun test test/e2e.test.ts
