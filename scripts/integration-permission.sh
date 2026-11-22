#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p /tmp/opencode
TMP="$(mktemp -d /tmp/opencode/antigravity-permission-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/config" "$TMP/project" "$TMP/home" "$TMP/xdg-data" "$TMP/xdg-state" "$TMP/xdg-cache"
chmod +x "$ROOT/test/fixtures/mock-agy-acp.mjs"

run_case() {
  local label="$1"
  local kind="$2"
  local expected="$3"
  local rules="$4"
  local agent="${5:-}"

  cat > "$TMP/config/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "permissions": $rules,
  "plugins": [
    {
      "package": "$ROOT",
      "options": {
        "command": "$ROOT/test/fixtures/mock-agy-acp.mjs",
        "permission": "ask",
        "mode": "default",
        "allowConsumerAuth": true
      }
    }
  ]
}
EOF

  local args=(run --model antigravity-acp/gemini-3.8-flash "hello")
  if [[ -n "$agent" ]]; then
    args=(run --agent "$agent" --model antigravity-acp/gemini-3.8-flash "hello")
  fi

  local output
  output="$(
    cd "$TMP/project"
    MOCK_PERMISSION_KIND="$kind" \
    XDG_DATA_HOME="$TMP/xdg-data" \
    XDG_STATE_HOME="$TMP/xdg-state" \
    XDG_CACHE_HOME="$TMP/xdg-cache" \
    OPENCODE_TEST_HOME="$TMP/home" \
    OPENCODE_CONFIG_DIR="$TMP/config" \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    timeout 45s opencode --standalone --log-level warn "${args[@]}" 2>&1
  )"

  if ! grep -q "permission-outcome:$expected" <<<"$output"; then
    echo "FAIL: $label (expected $expected)" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "ok: $label -> $expected"
}

run_case "ask with no rule" execute deny '[]'
run_case "canonical broad shell allow" execute allow '[{ "action": "shell", "resource": "*", "effect": "allow" }]'
run_case "canonical exact shell allow" execute allow '[{ "action": "shell", "resource": "printf mock", "effect": "allow" }]'
run_case "canonical wildcard shell allow downgrades" execute deny '[{ "action": "shell", "resource": "printf *", "effect": "allow" }]'
run_case "legacy antigravity allow" execute allow '[{ "action": "antigravity.*", "resource": "*", "effect": "allow" }]'
run_case "legacy deny beats canonical allow" execute deny '[{ "action": "shell", "resource": "*", "effect": "allow" }, { "action": "antigravity.*", "resource": "*", "effect": "deny" }]'
run_case "explore built-in shell allow does not auto-approve" execute deny '[]' explore
run_case "canonical read allow" read allow '[{ "action": "read", "resource": "*", "effect": "allow" }]'
run_case "canonical edit allow" edit allow '[{ "action": "edit", "resource": "*", "effect": "allow" }]'
run_case "canonical websearch allow" websearch allow '[{ "action": "websearch", "resource": "*", "effect": "allow" }]'

echo "permission integration: all cases passed"
