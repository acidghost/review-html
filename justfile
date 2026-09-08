port := "8422"

# A plan and this checkout have to sit under one served root; the directory you
# cloned into is the smallest one that covers both without knowing your layout.
root := env("REVIEW_ROOT", parent_directory(justfile_directory()))

# Open the reviewer with no plan loaded, ready for a dropped file
open:
    just review

# Serve the work area on loopback, so the reviewer can fetch plans by path
serve:
    python3 -m http.server {{ port }} --bind 127.0.0.1 -d "{{ root }}"

# Stop a server left running by `just review`
stop:
    -pkill -f "http.server {{ port }}"

# Review a plan: just review ~/path/to/repo/.plans/2026-09-08-thing.html
review plan="":
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{ root }}"
    under() {
      case "$1" in "$root"/*) ;;
        *) echo "$1 is outside $root; set REVIEW_ROOT to widen" >&2; return 1 ;;
      esac
    }
    # The reviewer is served too: ES modules do not load over file://.
    app="{{ justfile_directory() }}"
    under "$app"
    query=""
    if [[ -n "{{ plan }}" ]]; then
      cd "{{ invocation_directory() }}"
      [[ -f "{{ plan }}" ]] || { echo "no such plan: {{ plan }}" >&2; exit 1; }
      abs="$(cd "$(dirname "{{ plan }}")" && pwd)/$(basename "{{ plan }}")"
      under "$abs"
      enc() { jq -rn --arg s "$1" '$s|@uri'; }
      query="?plan=$(enc "${abs#"$root"/}")&label=$(enc "${abs/#$HOME/\~}")"
    fi
    if ! curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:{{ port }}/"; then
      echo "serving $root on 127.0.0.1:{{ port }} (just stop to shut it down)"
      (python3 -m http.server {{ port }} --bind 127.0.0.1 -d "$root" >/dev/null 2>&1 &)
      sleep 1
    fi
    open "http://127.0.0.1:{{ port }}/${app#"$root"/}/review.html$query"

# Open the bundled fixture plan
demo:
    just review test/fixtures/plan.html

# Everything; the browser suite skips itself unless `just browser` has run
test:
    bun test

fmt:
    biome check --write app test review.html

check:
    biome check app test review.html

# Download the browser the e2e tests need (network: cdn.playwright.dev)
browser:
    playwright install chromium

# Only the browser suite
e2e:
    bun test test/e2e.test.js
