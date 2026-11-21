# Positron Atlas development tasks. Run `just` to list them.

positron := env("POSITRON", "/Applications/Positron.app/Contents/Resources/app/bin/code")
root := justfile_directory()

_default:
    @just --list

# Build the extension (extension host + webview)
build:
    npm run build

# Create or update the Python environment for the example notebooks
examples-env *groups:
    cd examples && uv sync {{ groups }}

# Start Positron with the extension in development mode, opened on examples/
examples *args: build examples-env
    "{{ positron }}" --new-window --extensionDevelopmentPath="{{ root }}" {{ args }} "{{ root }}/examples"

# Same, but in a fresh, throwaway Positron profile (no settings or extensions of your own)
examples-isolated *args: build examples-env
    rm -rf /tmp/positron-atlas-dev
    "{{ positron }}" --new-window --extensionDevelopmentPath="{{ root }}" \
        --user-data-dir=/tmp/positron-atlas-dev/user --extensions-dir=/tmp/positron-atlas-dev/ext \
        {{ args }} "{{ root }}/examples"

# Run the unit tests (TypeScript and Python) and type checks
test:
    npm run check
    npm test
    npm run test:py

# Run the end-to-end tests in an isolated Positron
e2e: build
    npm run test:e2e

# Build the .vsix package
package:
    npm run package

# Open the webview in a browser, without Positron (scenario: small, tags, mnist, ... or a JSON path; port 0: any free port)
harness scenario="small" theme="dark" port="0": build
    #!/usr/bin/env bash
    set -euo pipefail
    s="{{ scenario }}"
    [[ -f "$s" ]] || s="test/harness/scenario-$s.json"
    [[ -f "$s" ]] || { echo "No such scenario: {{ scenario }} (try: $(ls test/harness/scenario-*.json | sed 's/.*scenario-//; s/\.json$//' | paste -sd ' ' -))"; exit 1; }
    log=$(mktemp "${TMPDIR:-/tmp}/atlas-harness.XXXXXX")
    uv run --project python python test/harness/server.py "$s" --port {{ port }} > >(tee "$log") &
    server=$!
    cleanup() { kill $server 2>/dev/null; wait $server 2>/dev/null; rm -f "$log"; }
    trap cleanup EXIT
    trap 'exit 130' INT TERM HUP
    # The scenario's setup runs before the server listens (MNIST downloads once): wait for it.
    until url=$(grep -o 'http://127.0.0.1:[0-9]*/' "$log"); do
        kill -0 $server 2>/dev/null || exit 1
        sleep 0.5
    done
    rm -f "$log"
    url="${url}?theme={{ theme }}"
    echo "Opening $url (Ctrl-C to stop)"
    open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || true
    wait $server
