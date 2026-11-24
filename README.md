# opencode-antigravity-acp-local

Standalone OpenCode V2 provider plugin for Google Antigravity. It registers an
`antigravity-acp` provider through the OpenCode plugin API, starts the user's
own `agy acp --stdio --process-per-session`, and speaks ACP v1 over NDJSON.
OpenCode source is not modified.

This is a local/private integration, not an official Google or OpenCode
product.

## Compatibility boundary

The plugin is deliberately **strict-thin** for consumer `oauth-personal` use:

- It clears OpenCode's system prompt and tool schemas.
- It sends only the current user turn; Antigravity's ACP session owns the
  conversation history.
- It does not relay MCP tools, run Code Mode, replay cross-model context, or
  run automated prompt loops.
- It never reads or copies OAuth tokens, reverse-proxies private endpoints, or
  wraps `agy -p`.
- Antigravity-native tools are marked `providerExecuted`; OpenCode does not run
  them again.

Consumer auth requires `allowConsumerAuth: true` (or
`ANTIGRAVITY_ACP_ALLOW_CONSUMER=1`). For an outer-harness setup, prefer
`GEMINI_API_KEY`, `oauth-business`, or `agent-platform`.

References:

- <https://discuss.ai.google.dev/t/tos-clarification-is-opencode-antigravity-acp-official-agy-acp-in-opencode-permitted-under-the-antigravity-terms-of-service/202970/2>
- <https://antigravity.google/docs/faq#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login>
- <https://antigravity.google/docs/ide/extensions/acp>

This is an engineering reading of the public sources, not legal advice.

## Requirements

- OpenCode `2.3.2` for canonical permission rules; older/newer versions still
  display prompts but fail closed for canonical auto-allow.
- `agy` with ACP support. Tested with ACP server `1.5.13` and `1.5.14`.
- `agy` signed in, or an API-key/enterprise auth method configured.
- Linux, macOS, or Windows. On Windows the plugin also probes
  `%LOCALAPPDATA%\agy\bin\agy.exe` when the service PATH does not include it.

## Install

```bash
bun install
bun run typecheck
bun run test
```

Add the plugin in `opencode.jsonc` (not `cli.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-antigravity-adapter",
      "options": {
        "permission": "ask",
        "mode": "default",
        "allowConsumerAuth": true
      }
    }
  ]
}
```

Auto-discovery also works: copy or symlink the directory under
`~/.config/opencode/plugins/`. Auto-discovery passes no options, so consumer
auth must be enabled with `ANTIGRAVITY_ACP_ALLOW_CONSUMER=1`.

## Options

| Option | Values | Default | Meaning |
| --- | --- | --- | --- |
| `permission` | `ask` \| `allow` \| `deny` | `ask` | How ACP permission requests are answered. `ask` uses OpenCode's permission UI; headless runs deny unless a rule allows the action. |
| `mode` | `default` \| `accept-edits` \| `auto` \| `plan` | `default` | ACP session mode. |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` | model default | Fallback effort when OpenCode sends no variant. |
| `command` | path | `agy` / `AGY_BIN` | Antigravity CLI binary. |
| `allowConsumerAuth` | `true` \| `false` | `false` | Acknowledge the consumer `oauth-personal` boundary. Also set by `ANTIGRAVITY_ACP_ALLOW_CONSUMER=1`. |

Environment variables:

- `GEMINI_API_KEY` selects `gemini-api-key` auth.
- `ANTIGRAVITY_ACP_AUTH_METHOD` forces `oauth-personal`, `oauth-business`,
  `gemini-api-key`, or `agent-platform`.
- `ANTIGRAVITY_ACP_ALLOW_CONSUMER=1` enables consumer auth for auto-discovery.
- `AGY_BIN` sets the binary path when `command` is not configured.
- `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, and
  `GOOGLE_CLOUD_LOCATION` are used by `agent-platform`.

For OAuth auth methods, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and
`GOOGLE_APPLICATION_CREDENTIALS` are removed from the `agy` child environment
so an unrelated key cannot override the login.

## Auth

- Consumer: run `agy` once in a terminal, then restart OpenCode.
- Headless: run `agy acp --login` on the machine first.
- API key: export `GEMINI_API_KEY` outside shared/committed config.
- Enterprise: use `oauth-business` or `agent-platform` with ADC.
- Non-consumer methods are authenticated explicitly. If the server cannot
  confirm the effective method, the plugin fails closed unless
  `allowConsumerAuth: true`.

## Permissions

`permission: "ask"` maps ACP permission requests to `ctx.permission.assert()`
and recomputes the decision from explicit user rules. OpenCode's computed
`input.effect` is not trusted because it mixes built-in agent policy, user
rules, and saved rules.

Useful mappings in `ask` mode:

| ACP tool kind | OpenCode action | Prompt |
| --- | --- | --- |
| `execute` | `shell` | command |
| `read` | `read` | path |
| `edit` | `edit` | path |
| `search_web` | `websearch` | query |
| `delete`, `move`, `switch_mode`, other | `antigravity.*` | generic |

Example rules:

```jsonc
"permissions": [
  { "action": "shell", "resource": "*", "effect": "allow" },
  { "action": "edit", "resource": "*", "effect": "ask" },
  { "action": "read", "resource": "*", "effect": "allow" },
  { "action": "websearch", "resource": "*", "effect": "allow" }
]
```

`shell` and `websearch` rules are shared with OpenCode's own tools. To scope a
grant to Antigravity only, use a legacy rule:

```jsonc
{ "permissions": [{ "action": "antigravity.*", "resource": "*", "effect": "allow" }] }
```

Behavior notes:

- Legacy `antigravity.*` rules keep their old action/resources and still work.
  They cannot override a built-in agent deny enforced by OpenCode before the
  hook; use a canonical allow for that.
- `shell *` allows every command. An exact command allows only that string.
  Other shell wildcards such as `git *` degrade to `ask`.
- No explicit rule means `ask`; headless requests are rejected. Built-in agent
  allows do not auto-approve.
- TUI saved "Always allow" rules are not visible to the plugin and are not used.
- Antigravity may auto-approve a tool without sending a permission request.
  The plugin can only gate requests Antigravity actually sends.
- `permission: "allow"` / `"deny"` bypass the UI deliberately.

## Limitations

- No MCP relay or Code Mode. OpenCode tools and tool schemas are not exposed to
  Antigravity.
- **Antigravity subagents use Antigravity models only.** `invoke_subagent`'s
  `Model` field is a model name on Antigravity's agent-level endpoint (for
  example Gemini/Claude variants), not an OpenCode provider model. Subagents
  cannot call OpenCode's other models.
- **Subagent results are not guaranteed to return over ACP.** In ACP 1.5.x,
  `invoke_subagent` is asynchronous: it can complete before the child agent
  finishes, and child sessions/results were not exposed even when the client
  advertised the `subagents` capability. The parent turn may end with only a
  "subagent started" message. The plugin renders only ACP updates; it does not
  read Antigravity brain files or inject follow-up prompts. For results needed
  in the same turn, avoid subagents or have them write to the workspace.
- No `session/list`, `session/load` replay, `terminal-login`, elicitation forms,
  or mid-turn steering.
- ACP v1 only; a server that negotiates v2 is rejected.
- One ACP session per OpenCode session. `session/resume` keeps the stored ACP
  id when possible; otherwise a new ACP session starts and prior ACP history is
  lost.
- `plan` agent mode applies ACP `plan` mode and fails closed if it cannot be
  confirmed.
- Title and compaction are local. Compaction writes a fixed explanatory
  summary; OpenCode still shows its compaction divider. Antigravity's ACP
  history remains authoritative.
- Mode/model changes require confirmation from the ACP server or the turn is
  aborted.
- A cold start uses a fallback model catalog until discovery finishes.
- Windows `.cmd`/`.bat` spawns use a shell; process-tree kill uses
  `taskkill /T /F`.
- Context/output limits are estimates (1M / 64K), not account-reported values.
- Image prompts require inline base64/Uint8Array images; image URLs and
  non-image files are replaced with an in-prompt omission marker.
- The permission gate is a UX layer, not a sandbox. Antigravity tools run with
  the user's OS privileges; use `agy`'s own settings and `--sandbox` for
  isolation.
- No GUI component. This is a server plugin, not a TUI plugin.

## Development

```bash
bun run typecheck
bun run test                  # test/ only
bun run test:integration      # mock ACP + real OpenCode permission hook
bun run build                 # optional dist/
```

Optional live checks against the real `agy` (consume quota):

```bash
ANTIGRAVITY_ACP_LIVE=1 bun test live.test.ts

cd test
ANTIGRAVITY_ACP_LIVE_PROMPT=1 ANTIGRAVITY_ACP_ALLOW_CONSUMER=1 bun test live-prompt.test.ts
```

The ACP transport in `src/acp/client.ts` is adapted from
[`system1970/opencode-antigravity-acp`](https://github.com/system1970/opencode-antigravity-acp)
(MIT). See `ref/` for protocol notes and audits.

## License

MIT. See `LICENSE`. Third-party code retains its original MIT attribution.
