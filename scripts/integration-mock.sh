#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p /tmp/opencode
TMP="$(mktemp -d /tmp/opencode/antigravity-mock-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/config" "$TMP/project" "$TMP/home" "$TMP/xdg-data" "$TMP/xdg-state" "$TMP/xdg-cache"
chmod +x "$ROOT/test/fixtures/mock-agy-acp.mjs"

cat > "$TMP/config/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "$ROOT",
      "options": {
        "command": "$ROOT/test/fixtures/mock-agy-acp.mjs",
        "permission": "allow",
        "mode": "default",
        "allowConsumerAuth": true
      }
    }
  ]
}
EOF

cd "$TMP/project"
OUTPUT="$(
  XDG_DATA_HOME="$TMP/xdg-data" \
  XDG_STATE_HOME="$TMP/xdg-state" \
  XDG_CACHE_HOME="$TMP/xdg-cache" \
  OPENCODE_TEST_HOME="$TMP/home" \
  OPENCODE_CONFIG_DIR="$TMP/config" \
  OPENCODE_DISABLE_AUTOUPDATE=true \
  opencode --standalone --log-level warn run --model antigravity-acp/gemini-3.8-flash "hello" 2>&1
)"
printf '%s\n' "$OUTPUT"
grep -q "Hello from mock Antigravity." <<<"$OUTPUT"
