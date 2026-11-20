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
