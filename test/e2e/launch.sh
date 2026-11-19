#!/usr/bin/env bash
# Launch an isolated Positron with this extension in development mode and CDP enabled.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="${E2E_DIR:-/tmp/positron-atlas-e2e}"
PORT="${CDP_PORT:-9333}"
rm -rf "$E2E/user" "$E2E/logs" && mkdir -p "$E2E/user/User" "$E2E/ext" "$E2E/ws"
cat > "$E2E/user/User/settings.json" <<JSON
{
  "python.defaultInterpreterPath": "$ROOT/.venv-e2e/bin/python",
  "workbench.startupEditor": "none",
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "positron.assistant.enable": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "window.restoreWindows": "none"
}
JSON
export ATLAS_E2E_PYTHON="$ROOT/.venv-e2e/bin/python"
export ATLAS_E2E_SCENARIO="${ATLAS_E2E_SCENARIO:-$ROOT/test/e2e/scenario-small.json}"
export ATLAS_E2E_LOG="$E2E/scenario.log"
rm -f "$ATLAS_E2E_LOG" "$ATLAS_E2E_LOG.reloaded"
exec /Applications/Positron.app/Contents/MacOS/Positron \
  --extensionDevelopmentPath="$ROOT" \
  --extensionDevelopmentPath="$ROOT/test/e2e/helper" \
  --user-data-dir="$E2E/user" \
  --extensions-dir="$E2E/ext" \
  --logsPath="$E2E/logs" \
  --remote-debugging-port="$PORT" \
  --disable-workspace-trust \
  --skip-welcome --skip-release-notes \
  "$E2E/ws"
