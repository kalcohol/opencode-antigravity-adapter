# opencode-antigravity-acp-local

A standalone OpenCode V2 **server plugin** that lets OpenCode use Google Antigravity models through the official `agy acp` runtime. It does not modify OpenCode source; it registers a provider through the plugin API, starts the user's own `agy` binary, and speaks ACP over stdio.

This is a local/private plugin, modeled after the `../statusline` local-plugin workflow. It is not affiliated with Google or OpenCode.

---

## Consumer login: the thin-client boundary

There are three different things, and they have different answers:

1. **Bypassing the CLI / impersonating Antigravity.** Extracting or replaying OAuth tokens, reverse-proxying private endpoints, spoofing IDE/API headers, or wrapping `agy -p` in a third-party agent is **not allowed** (the FAQ explicitly says `agy -p` wrapping is not supported on consumer plans).
2. **`agy acp` as a thin client.** Google's Antigravity forum reply (2026-11-20) says launching the unmodified `agy acp` interactively is **permitted in a thin client where Antigravity is the agent**: the human sends raw prompts to `agy acp`, and Antigravity owns its sign-in, system prompt, tools, and session history.
3. **`agy acp` inside an outer harness that injects outer-agent state.** The same reply says wrapping `agy acp` in an outer third-party coding-agent harness (it names OpenCode) that injects system instructions, serialized tool definitions, replayed cross-model context, or automated loops is **not permitted on `oauth-personal`**, even without token extraction. For that shape, the reply recommends `gemini-api-key` (`GEMINI_API_KEY`) or Google Cloud `agent-platform`.

Sources:

- Forum clarification: <https://discuss.ai.google.dev/t/tos-clarification-is-opencode-antigravity-acp-official-agy-acp-in-opencode-permitted-under-the-antigravity-terms-of-service/202970/2>
- FAQ: <https://antigravity.google/docs/faq#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login>
- ACP docs: <https://antigravity.google/docs/ide/extensions/acp>

**Where this plugin sits:** it is deliberately **strict-thin**:

- It clears OpenCode's system prompt and tool schemas (`input.system = []`, `input.tools = {}`).
- It sends only the current user turn; it does **not** replay cross-model history. Antigravity's ACP session owns the conversation history.
- It has **no** MCP relay / Code Mode, no cross-model handoff, no account rotation, no automated prompt loops.
- It never reads/copies OAuth tokens, never reverse-proxies private endpoints, never spoofs headers, and never wraps `agy -p`.
- It marks Antigravity-native tools as `providerExecuted`; OpenCode does not execute them.
- `permission: "ask"` routes Antigravity's own permission requests through OpenCode's permission UI.

That is the closest fit to the forum's "thin client" description. It is still an OpenCode plugin, and the FAQ names OpenCode, so this is a boundary judgment rather than a legal guarantee. `allowConsumerAuth: true` is the explicit acknowledgment that you will keep it strict-thin. If you later add injected system prompts, OpenCode tool schemas, replayed cross-model context, or MCP relay/Code Mode, switch to `GEMINI_API_KEY` or `agent-platform` — those are the paths the forum reply recommends for an outer harness. This is an engineering reading of the public sources, not legal advice.

If you use `GEMINI_API_KEY` or `agent-platform`, the plugin calls ACP `authenticate` explicitly for that method so cached consumer OAuth is not silently reused (per the forum reply). For `oauth-business`/`agent-platform`, if the server only answers "already authenticated" and the plugin cannot verify the effective method, it **fails closed** unless `allowConsumerAuth: true`; run `agy acp --login`/`/logout` or use `GEMINI_API_KEY`. It does not delete or modify your `agy` credentials.

---

## Status

- `bun run typecheck` passes.
- `bun run test` passes (14 unit tests: catalog grouping, model target resolution, prompt extraction, stream mapping, auxiliary-request handling).
- `ANTIGRAVITY_ACP_LIVE=1 bun test live.test.ts` passes against the real local `agy` 1.5.14: `initialize`, `session/new`, real catalog, and `session/set_config_option` model switch. It does **not** send a prompt.
- `bun run test:integration` passes end-to-end with a mock ACP agent: OpenCode loads the provider, selects `antigravity-acp/gemini-3.8-flash`, streams a tool call + text, and exits 0. This test does not touch Antigravity or quota.
- A real Antigravity prompt has **not** been run from this plugin yet; that consumes account quota and is the step where the consumer thin-client boundary applies. Run it only after deciding on the auth path.

## What it does

- Registers an OpenCode provider `antigravity-acp` with the models and reasoning-effort variants reported by the account.
- Spawns `agy acp --stdio --process-per-session` per OpenCode session.
- Uses ACP v1: `initialize`, `session/new` / `session/resume`, `session/set_config_option` (model / thought level / mode), `session/prompt`, `session/cancel`, `session/close`.
- Streams Antigravity text, thoughts, tool calls and tool results as AI SDK `LanguageModelV3` stream parts.
- Marks Antigravity-native tools as `providerExecuted`, so OpenCode displays them but never runs them a second time.
- Routes ACP `session/request_permission` into OpenCode's permission system (`ask`), or auto-allows/denies if configured. In `ask` mode, execute/read/edit/search_web are shown as `shell`/`read`/`edit`/`websearch` with their real command/path/query; built-in agent allows never auto-approve, and headless runs deny when no explicit user rule allows the action.
- Fails the turn if a requested model/effort cannot be confirmed, instead of silently running the previous model.
- Handles title/compaction locally (no ACP turn); stateless `generate` is rejected.
- Caches the model catalog so the picker can show models before `agy` answers; refreshes it in the background.
- Derives a local title instead of spending an ACP turn on title generation.

## Requirements

- OpenCode `2.3.x` (V2 plugin API; `@opencode/plugin` 2.3.2).
- Antigravity CLI `agy` with ACP support. Tested with `agy` / ACP server `1.5.14`.
- `agy` signed in once (`agy` in a terminal), or one of the ACP auth methods configured.
- Linux/macOS/Windows where `agy` runs. The plugin itself is platform-neutral; `agy` must be on `PATH` or set with `command` / `AGY_BIN`.

## Install (local path)

1. Install dependencies and typecheck:

   ```bash
   cd /path/to/opencode-antigravity-adapter
   bun install
   bun run typecheck
   bun run test
   ```

2. Add the plugin to `opencode.jsonc` (**not** `cli.json`; `cli.json` is for TUI-only plugins such as `../statusline`):

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

   A plain string also works with default options, but then `allowConsumerAuth` stays `false`:

   ```jsonc
   {
     "plugins": ["/absolute/path/to/opencode-antigravity-adapter"]
   }
   ```

   `allowConsumerAuth` defaults to **false**. You only need to set it to `true` if you are using an `agy` consumer login (`oauth-personal`) and will keep this plugin strict-thin (no injected system/tools, no cross-model replay, no MCP relay/Code Mode, no automated loops). If you set `GEMINI_API_KEY`, `ANTIGRAVITY_ACP_AUTH_METHOD=oauth-business`, or `agent-platform`, leave it false.

3. Restart OpenCode, open the model picker, and select **Antigravity (ACP)**. The provider has one entry per model; the reasoning effort is a variant (`low` / `medium` / `high` / `xhigh` where the account offers it).

### Alternative: global auto-discovery

Copy or symlink the directory under the OpenCode config directory:

```bash
ln -s /absolute/path/to/opencode-antigravity-adapter ~/.config/opencode/plugins/antigravity-acp
```

OpenCode discovers immediate package directories there. The plugin's `package.json` exports `./src/index.ts` as its entrypoint.

Auto-discovery passes no plugin options, so `allowConsumerAuth` is false. For a consumer `oauth-personal` login, set `ANTIGRAVITY_ACP_ALLOW_CONSUMER=1` in the environment that launches OpenCode, or use the `opencode.json` object form above. API-key/enterprise paths work without that flag.

## Options

| Option | Values | Default | Meaning |
| --- | --- | --- | --- |
| `permission` | `ask` \| `allow` \| `deny` | `ask` | How Antigravity's `session/request_permission` is answered. `ask` shows an informative OpenCode prompt and requires an explicit user rule to auto-allow; headless without one denies. |
| `mode` | `default` \| `accept-edits` \| `auto` \| `plan` | `default` | ACP session mode applied when the ACP session starts. |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` | model default | Fallback reasoning effort when OpenCode sends no variant. |
| `command` | path | `agy` / `AGY_BIN` | The Antigravity CLI binary. |
| `allowConsumerAuth` | `true` \| `false` | `false` | Opt in to the consumer `oauth-personal` login. Without it, consumer auth is refused before any prompt and model discovery is skipped. Also enabled by `ANTIGRAVITY_ACP_ALLOW_CONSUMER=1`. |

Environment:

- `GEMINI_API_KEY` → `gemini-api-key` auth (lower-risk documented path for third-party agents).
- `ANTIGRAVITY_ACP_AUTH_METHOD` → force `oauth-personal`, `oauth-business`, `gemini-api-key` or `agent-platform`.
- `ANTIGRAVITY_ACP_ALLOW_CONSUMER=1` → `allowConsumerAuth` for auto-discovered plugins.
- `AGY_BIN` → binary path if `command` is not set.
- `GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` → `agent-platform` auth.

`agy` is launched with the current environment, except that when the effective auth method is `oauth-personal`/`oauth-business`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GOOGLE_APPLICATION_CREDENTIALS` are removed from the child environment so a stray key does not override the personal login.

## Auth

- Normal consumer flow: run `agy` once in a terminal and sign in. The ACP server reuses the cached credentials.
- SSH / headless: run `agy acp --login` on that machine, then retry. The plugin does not implement ACP `terminal-login` yet.
- API key: export `GEMINI_API_KEY` in the environment that launches OpenCode. Keep it out of shared or committed config files.
- Enterprise: use `ANTIGRAVITY_ACP_AUTH_METHOD=oauth-business` (browser sign-in) or `agent-platform` with ADC.
- If `session/new` returns `Authentication required` (code `-32000`), the plugin tries `authenticate` once with the resolved method, then retries. If that fails, check `agy` manually.
- For any non-consumer method (`gemini-api-key`, `oauth-business`, `agent-platform`), the plugin calls `authenticate` explicitly. If the server reports an existing session instead of confirming the requested method, the plugin fails closed unless `allowConsumerAuth: true`; this prevents silently reusing cached consumer OAuth. Run `agy acp --login`/`/logout` as needed.
- An unknown non-empty `ANTIGRAVITY_ACP_AUTH_METHOD` is rejected instead of silently falling back to `oauth-personal`.

## Permissions and safety

- `permission: "ask"` maps each ACP permission request to `ctx.permission.assert()`. It does **not** trust OpenCode's computed `input.effect`: that value mixes built-in agent policy, user rules, and invisible saved rules. The plugin recomputes the decision from explicit user rules.
- In `ask` mode the useful action mappings are:
  - `execute` → `shell` (TUI shows `Shell command` and `- <command>`)
  - `read` → `read` (`Read /path`)
  - `edit` → `edit` (`Edit /path`; ACP diff is not rendered yet, so the TUI may say `No diff provided`)
  - `search_web` → `websearch` (`Web Search via Antigravity "query"`)
  - `delete` / `move` / `switch_mode` / other kinds stay `antigravity.*` and use the generic prompt.
- The canonical actions can be configured with ordinary OpenCode rules:
  ```jsonc
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "allow" },
    { "action": "edit", "resource": "*", "effect": "ask" },
    { "action": "read", "resource": "*", "effect": "allow" },
    { "action": "websearch", "resource": "*", "effect": "allow" }
  ]
  ```
  `shell` and `websearch` rules are shared with OpenCode's own tools. If you want to scope a grant to Antigravity only, use a legacy rule:
  ```jsonc
  { "permissions": [{ "action": "antigravity.*", "resource": "*", "effect": "allow" }] }
  ```
- Legacy `antigravity.*` rules still work and are matched against the old action/resources (locations or title), so existing `antigravity.execute` / `antigravity.read` rules keep their old meaning. They cannot override a built-in agent deny that OpenCode enforces before the hook; use a canonical `shell`/`edit`/`read` allow for that.
- `shell` allow rules are deliberately conservative:
  - `resource: "*"` allows every command (compound commands included);
  - `resource: "git status"` allows only that exact full command;
  - `resource: "git *"` does **not** auto-allow; it degrades to `ask` because OpenCode's shell parsing is not reimplemented here.
  - `deny` / `ask` rules still apply.
- In `permission: "ask"`, a request with no explicit user rule is `ask` even when an OpenCode built-in agent (for example `explore`) has an allow rule. In headless/CI (`opencode run`, no unattended allow) it is denied. The TUI's saved "Always allow" rules are not visible to the plugin, so they do not bypass this default; the plugin does not pass `save`.
- OpenCode 2.3.2 is the supported version for canonical auto-allow. On an unknown version the plugin still shows informative prompts, but canonical rules stop auto-allowing; legacy `antigravity.*` rules remain the fallback. This fails closed rather than guessing built-in rule layouts.
- Antigravity may auto-approve a tool without sending `session/request_permission` (observed with some `/tmp` writes and `search_web`). The plugin can only gate requests Antigravity actually sends. Do not treat `permission: "ask"` as a sandbox.
- `permission: "allow"` selects an allow option for every request; `"deny"` selects a reject option. Use these deliberately.
- `mode: "auto"` / `"accept-edits"` can make Antigravity stop sending permission requests; OpenCode cannot gate a request the agent never makes. Default mode is `default`. Do not combine `mode: "auto"` with `permission: "ask"` if you expect every native tool action to be reviewed.
- Antigravity-native tools execute inside the `agy` process with your OS privileges. OpenCode's permission gate is a UX/approval layer, not a sandbox. Use `agy`'s own permission settings and `--sandbox` if you need isolation.
- The plugin does not pass `--dangerously-skip-permissions` by default.
- One turn per OpenCode session at a time; interrupt/cancel sends ACP `session/cancel` and closes pending permission requests.
- OpenCode auto-retry is disabled for this provider: a failed turn may already have executed tools, so resend manually rather than risking a duplicate tool run.
- The `agy` child inherits the parent environment (except Google keys on OAuth paths). Do not launch OpenCode with unrelated secrets in the environment; use a dedicated shell/profile if needed.
- A wedged ACP turn has no hard total timeout; interrupt it from OpenCode. Foreground turns can run as long as Antigravity is making progress.

## Limitations (v0.1)

- No MCP relay / Code Mode. Antigravity uses its own tools; OpenCode tools are not exposed to it.
- No `session/list`, `session/load` history replay, `terminal-login`, elicitation forms, or mid-turn steering.
- ACP v1 only; a server that negotiates v2 is rejected.
- One ACP session per OpenCode session; `session/resume` is used after a restart and keeps the stored ACP id/cwd. If resume fails or the cwd changed, a new session starts and prior ACP history is lost.
- When the OpenCode agent is `plan`, the plugin applies ACP `plan` mode and fails the turn if the mode cannot be confirmed. Other agents use the `mode` option.
- Title and compaction are handled locally without an ACP turn. The compaction summary is generic; Antigravity's ACP history remains authoritative. Stateless `generate` requests are rejected.
- All mode changes require confirmation from `configOptions.currentValue` or a matching `current_mode_update`; a bare `{}` from `session/set_config_option`/`session/set_mode` is not accepted as proof. The default-mode fallback also fails closed.
- A model/effort switch that cannot be confirmed aborts the turn instead of silently using the previous model.
- A cold start uses a small fallback catalog until the background `agy acp` discovery finishes; the fallback may be stale or list a model the account cannot use. Selecting an unavailable model fails that turn.
- Windows: `.cmd`/`.bat` spawns use a shell and process-tree kill uses `taskkill /T /F`; a POSIX detached child can still be orphaned if OpenCode is SIGKILLed.
- Model context/output limits are estimates (1M / 64k), not values reported by the account.
- Titles are derived locally from the first user message; no title model turn is spent.
- Inline base64/Uint8Array images are passed through when the ACP server advertises image prompts; image URLs and non-image files are replaced with a text marker **inside the prompt** (not an OpenCode warning), so the agent sees that content was omitted. The marker is not shown as a separate host warning.
- No GUI component. This is a server plugin; the TUI-only `cli.json` workflow does not apply.

## Development

```bash
bun install
bun run typecheck
bun run test          # runs test/ only; the repo contains other tests under ref/
bun run test:integration  # mock ACP + real OpenCode permission hook, no quota
bun run build         # optional dist/ output
```

Optional live checks against the real `agy` (these consume account quota and may cross the consumer thin-client boundary):

```bash
# no prompt: initialize + session/new + real catalog/config switch
ANTIGRAVITY_ACP_LIVE=1 bun test live.test.ts

# one tiny real prompt; consumer login requires the explicit opt-in below
cd test
ANTIGRAVITY_ACP_LIVE_PROMPT=1 ANTIGRAVITY_ACP_ALLOW_CONSUMER=1 bun test live-prompt.test.ts
```

The ACP transport in `src/acp/client.ts` is adapted from [`system1970/opencode-antigravity-acp`](https://github.com/system1970/opencode-antigravity-acp) (MIT). The provider/model design is based on OpenCode PR #65430 and the Pi Antigravity provider's protocol notes. See `ref/README.md` for the full research index, subagent audits and real `agy acp` probe logs.

## License

MIT. See `LICENSE`. Third-party code retains its original MIT attribution; this package is a local, private integration, not an official Google or OpenCode product.
