# ACP client implementation checklist — OpenCode V2 standalone plugin for `agy acp` (Antigravity 1.5.14)

Status: implementation checklist, based on real handshake/config probes (no prompt sent), ACP v1 spec/schema, TypeScript SDK 2.9.1, and two reference providers.

Scope: a standalone OpenCode V2 plugin (`@opencode/plugin`) that registers an `antigravity-acp` provider and implements `LanguageModelV3` by driving a local `agy acp` subprocess over ACP v1 stdio.

Non-goals for Phase 1:

- Do not wrap `agy -p` / print mode.
- Do not read, copy, replay, or proxy Google OAuth tokens.
- Do not use ACP v2 (`protocolVersion: 2`); `agy acp` negotiates v1.
- Do not auto-approve agent-native edits/commands by default.
- Do not forward OpenCode's tool schemas to the ACP model; Antigravity executes its own tools.
- Do not emit a fake `tool-result` for a tool the agent is still running, or a second result for a finished call.

---

## 0. Evidence and the five decisions that shape the implementation

### 0.1 What the probes actually prove

`ref/notes/agy-acp-handshake.log`:

- `initialize` returns `protocolVersion: 1`, `agentInfo.name: "Antigravity ACP Server"`, `agentInfo.version: "1.5.14"` (`:2`).
- Capabilities include `loadSession: true`, `promptCapabilities.image: true`, `promptCapabilities.audio: false`, `promptCapabilities.embeddedContext: true`, and `sessionCapabilities` with `resume`, `close`, `load`, `list`, `additionalDirectories` (`:2`, `:5-37`).
- The same response also contains snake_case aliases: `load_session`, `session_capabilities`. Treat them as compatibility aliases; do not require them.
- `authMethods` has four entries: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` (`:2`, `:43-64`). None has `type: "terminal"` in this probe because the client did not advertise `clientCapabilities.auth.terminal`.
- `session/new {cwd, mcpServers: []}` returns `sessionId`, legacy `models.availableModels` (27 effort-qualified ids), `models.currentModelId: "gemini-4-neon-high"`, `modes`, and canonical `configOptions` (`:88-348`).
- `configOptions` (`:230-338`):
  - `model`: base ids only (`gemini-4-neon`, `gemini-4-carbon`, ..., `gpt-oss-120b-medium`); `currentValue: "gemini-4-neon"`.
  - `thought_level`: `low`, `medium`, `high`, `xhigh`; `currentValue: "high"`.
  - `mode`: `default`, `accept-edits`, `auto`, `plan`; `currentValue: "default"`.
- `_meta.antigravity.tier` is account metadata (`Google AI Ultra`, tier id, upgrade URI); `_meta.antigravity.systemPrompt.append` is an Antigravity extension hint, not the standard `sessionCapabilities.systemPrompt` capability (`:339-347`).

`ref/notes/agy-acp-config.log`:

- Setting `configId: "model"` to `gemini-3.8-flash` returns the complete config state; `thought_level` options shrink from four to three (`xhigh` disappears), while `currentValue` stays `high` (`:11-13`).
- Setting `configId: "thought_level"` to `low` produces a `config_option_update` notification that still says `high` (stale), then a result that says `low` (`:14-17`). **The result is authoritative; notifications can be stale.**
- `session/set_mode {modeId:"plan"}` returns `{}` immediately; a `config_option_update` notification still says `mode: default`, and a `current_mode_update` for `plan` arrives later (`:18-24`). Do not treat `{}` as confirmation, and do not block forever waiting for the notification.
- Setting `configId: "model"` to the effort-qualified id `gemini-3.8-flash-low` is accepted, but the result reports `model.currentValue: "gemini-3.8-flash"` and `thought_level.currentValue: "low"` (`:22-26`). This is non-spec coercion; do not rely on it, but split a qualified id if a user config supplies one.
- `usage_update` `{used: 0, size: 1048576}` is emitted after `session/new` (`:34`). A zero-valued setup update is not an inference and must not be counted as usage.
- `available_commands_update` is emitted three times with the same list (`:33`, `:35`, `:36`); deduplicate.
- `session/close` returns `{}` and still emits `config_option_update` / `available_commands_update` afterwards (`:42-48`). Ignore updates for closed sessions.

`ref/notes/agy-acp-set-model.log`:

- `session/set_model` accepts effort-qualified ids such as `gemini-3.8-flash-low` and returns `{}` (`:6-8`). It is a legacy/extension method: ACP's RFD says the never-stabilized `session/set_model` was removed from protocol artifacts (`ref/agent-client-protocol/docs/rfds/updates.mdx:434`), and it is absent from SDK 2.9.1 bindings. **Use `session/set_config_option`, not `session/set_model`.**
- After `set_model`, `config_option_update` snapshots are stale/deferred (`:13-18`). Do not let them overwrite the last confirmed config state.

### 0.2 Decision 1: protocol surface = ACP v1, `/unstable` types only

- Send `"protocolVersion": 1`; accept only a response with `protocolVersion === 1`. If an agent returns 2, disconnect with a clear error (ACP v1 client cannot speak v2).
- Use `@agentclientprotocol/sdk/unstable` for **types and schema shapes** (it includes `PromptResponse.usage` and other v1 draft fields). Do not import `@agentclientprotocol/sdk/experimental/v2`.
- The SDK 2.9.1 stable v1 entrypoint does not type `PromptResponse.usage`; the unstable entrypoint does (`ref/typescript-sdk/src/v1/unstable/schema/types.gen.ts:3371-3390`). Runtime field may exist regardless.
- Do not enable any v2-only behavior: v2 removes `session/load`, `session/set_mode`, `current_mode_update`, and changes `session/prompt` completion semantics (`ref/agent-client-protocol/docs/protocol/v2/migration.mdx`, "At a glance").
- v2 preview is useful only as a design warning: in v2 the `session/prompt` response acknowledges acceptance rather than ending the turn; `state_update` carries foreground state/stop reason; `tool_call` creation is folded into `tool_call_update`; `request_permission` is restructured; `session/load` is removed; modes become config options. If you accidentally design against v2, `agy` 1.5.14 will not behave that way. Pin v1 and keep the v1 response/update semantics above.

### 0.3 Decision 2: raw NDJSON JSON-RPC client is the pragmatic Phase 1 transport

Reason: Antigravity's `session/new` response includes the non-spec `models` field, and `initialize` includes snake_case aliases. The SDK's generated zod response schemas are plain `z.object(...)`, which strips unknown keys. If you use the SDK app API's built-in `session/new`/`initialize` specs, you will lose `models.availableModels`, which is the only reliable source for per-model effort variants.

Choose one:

- **Recommended Phase 1:** a small raw NDJSON client, modeled on `ref/opencode-antigravity-acp/src/acp-client.ts`:
  - `spawn("agy", ["acp", "--stdio"], { stdio: ["pipe","pipe","pipe"], cwd, shell: false })`
  - line-oriented UTF-8 decoder with a hard 32 MiB frame/partial-line cap (`ref/typescript-sdk/src/core/stream-limits.ts:1`; SDK default is 32 MiB)
  - pending map by numeric id, per-request timeout, server-request handler, notification router
  - use `@agentclientprotocol/sdk/unstable` types for payloads, but do not run generated response validation on `initialize`/`session/new`
- **Alternative:** SDK app API (`acp.client(...).onRequest(...).connectWith(...)`), but then:
  - you will not see `models`; build variants by probing each model's `set_config_option` result (too expensive), or
  - tee/tap the raw NDJSON stream before SDK validation to capture unknown fields, or
  - fork/patch the generated schema to passthrough unknown keys (not recommended).

Either way, use the SDK's `ndJsonStream` or an equivalent 32 MiB-capped line buffer; do not use `readline` with a small default limit.

### 0.4 Decision 3: `configOptions` is canonical; `models` is a legacy supplement

- Model, thought level, and mode selection must be driven by `configOptions` (`id`/`category`, `currentValue`, `options`).
- Use `models.availableModels` only to discover which effort-qualified ids exist, so the OpenCode catalog can expose per-model variants.
- Use `models.currentModelId` only as a fallback when `configOptions` is absent; it is effort-qualified (`gemini-4-neon-high`), while `configOptions.model.currentValue` is the base id (`gemini-4-neon`).
- Prefer `configOptions` over `modes` for mode selection; the spec says config options supersede modes (`ref/agent-client-protocol/docs/protocol/v1/session-config-options.mdx`, "Relationship to session modes").
- Keep `modes` only as a fallback for an older agent that returns no mode config option.

### 0.5 Decision 4: one ACP session per OpenCode session, with resume-first recovery

- Map `OpenCode sessionID -> ACP sessionId` in plugin storage, keyed by provider + workspace.
- On a warm process, reuse the ACP session and send only the current user turn; ACP owns conversation history.
- On plugin restart or process loss, try `session/resume` first (no replay), then `session/load` only if resume is unavailable and you can suppress replay, then `session/new` plus a bounded handoff.
- Do not share one ACP session across all OpenCode sessions; the PR's single-session-per-directory design causes cross-talk and ignores model selection (`ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/antigravity/session.ts:47-68`).

### 0.6 Decision 5: provider-executed tools only in Phase 1

- Send `mcpServers: []`.
- The agent executes its native tools; the plugin reports them as `providerExecuted: true` tool calls/results. Do not dispatch them to OpenCode tools.
- OpenCode's own `read`/`edit`/`bash` tools are not available to the Antigravity model. Clear them from the model context (`input.tools = {}`) and clear the OpenCode system prompt (`input.system = []`); the agent reads `AGENTS.md` and its own instructions. See `ref/opencode-antigravity-acp/src/index.ts:107-121`.
- If OpenCode tools must be available, Phase 2 is an MCP relay (loopback HTTP + token + exact parked-call matching), not ACP prompt injection. Note `mcpCapabilities` is **absent** in the 1.5.14 initialize response, so HTTP/SSE MCP is not advertised; test before relying on it.

---

## 1. `initialize` capabilities and auth flow

### 1.1 Spawn and handshake

- [ ] Spawn exactly `agy acp --stdio` (the CLI help says `--stdio` is the default, but pass it explicitly). `ref/notes/agy-cli-info.txt:3-34`.
- [ ] `shell: false`, `cwd` = absolute workspace, `stdio: ["pipe","pipe","pipe"]`, inherited env only. Do not put secrets in argv.
- [ ] Capture stderr in a bounded ring (16–32 KiB), redact tokens, and keep the tail for startup/exit errors. Always drain stderr so a full pipe cannot block `agy`.
- [ ] Send `initialize` with `protocolVersion: 1`. `clientCapabilities` is optional, but send an explicit posture.
- [ ] Timeout handshake at ~15 s. On timeout/exit, include the stderr tail and the phase (`initialize`) in the error.

Recommended request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": false,
      "auth": { "terminal": false }
    },
    "clientInfo": {
      "name": "opencode-antigravity-acp",
      "title": "Antigravity ACP",
      "version": "0.1.0"
    }
  }
}
```

Notes:

- `fs` and `terminal` false means the plugin does not implement `fs/*` or `terminal/*`. If the agent calls them anyway, answer JSON-RPC `-32601` (method not found), not an empty success. Reference: `ref/opencode-antigravity-acp/src/acp-client.ts:562-582`.
- Do not advertise `plan: {}` unless you implement `plan_update`/`plan_removed`. Antigravity's legacy `plan` update does not require that capability.
- Do not advertise `session.configOptions.boolean: {}`; Antigravity only uses `select` options. Advertising it is unnecessary and may produce option types you do not render.
- `auth.terminal`: set `true` only if the plugin can reproduce the configured `agy acp` invocation in an interactive TTY. In an OpenCode server this is usually false; expose a separate login command instead (see 1.4).
- `clientInfo.version` should be the plugin version, not `0.0.0`.

### 1.2 Validate the initialize response

- [ ] Require `protocolVersion === 1`; otherwise close and report an unsupported-protocol error.
- [ ] Record `agentInfo.name` / `agentInfo.version`; expose in diagnostics. Pin behavior to `1.5.14` but tolerate patch changes.
- [ ] Read capabilities defensively:
  - `agentCapabilities.loadSession` **or** `agentCapabilities.load_session`
  - `agentCapabilities.sessionCapabilities` **or** `session_capabilities`
  - `promptCapabilities.image`, `.audio`, `.embeddedContext`
  - `agentCapabilities.auth.logout`
  - `mcpCapabilities` (absent on 1.5.14; treat absent as no HTTP/SSE)
- [ ] Do not require `agentInfo`, `authMethods`, or `mcpCapabilities`; the spec marks them optional.
- [ ] Persist only non-secret capability metadata; never persist an auth token.

Expected 1.5.14 shape (abridged from `ref/notes/agy-acp-handshake.log:2`):

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "sessionCapabilities": {
      "resume": {}, "close": {}, "load": {}, "list": {}, "additionalDirectories": {}
    },
    "auth": { "logout": {} },
    "_meta": { "antigravity": { "tier": true, "systemPrompt": { "append": true } } }
  },
  "agentInfo": { "name": "Antigravity ACP Server", "version": "1.5.14" },
  "authMethods": [
    { "id": "oauth-personal", "name": "Log in with Google", "description": "Log in with your Google account" },
    { "id": "oauth-business", "name": "Log in with Gemini Enterprise", "description": "Log in with your Gemini Enterprise account" },
    { "id": "gemini-api-key", "name": "Gemini API key", "description": "Use an API key with Gemini Developer API" },
    { "id": "agent-platform", "name": "Gemini Enterprise Agent Platform", "description": "Use ... Application Default Credentials" }
  ]
}
```

### 1.3 Auth method semantics

- [ ] Treat methods with no `type` as `type: "agent"` (protocol default). All four 1.5.14 methods are agent-type; call `authenticate` with their `id`.
- [ ] Do not hardcode the four ids as the only possible ids. Read `authMethods`; match known ids for behavior, but show unknown methods as unsupported with a clear message.
- [ ] `oauth-personal` / `oauth-business`:
  - call `authenticate { methodId }` with a long timeout (OAuth may open a browser); surface a cancellable "waiting for login" state
  - do not retry automatically; do not call on every process start
  - if the server returns "already authenticated"/"already logged in", treat as success
- [ ] `gemini-api-key`:
  - require `GEMINI_API_KEY` (or an explicit user-provided key) before calling
  - call `authenticate { methodId: "gemini-api-key" }`
  - do not send the key in `params` unless Antigravity documents a field; the existing plugin's `_meta.apiKey` is an unverified extension (`ref/opencode-antigravity-acp/src/acp-client.ts:679-710`). If you use `_meta`, mark experimental, keep it in memory, never log it.
- [ ] `agent-platform`:
  - uses Application Default Credentials; call `authenticate { methodId: "agent-platform" }` with no secret input
  - if ADC is missing, map the failure to an actionable auth error
- [ ] `logout`:
  - call only on an explicit user action, after closing active sessions
  - `{ "jsonrpc":"2.0","id":N,"method":"logout","params":{} }` only if `agentCapabilities.auth.logout` is present
  - do not delete `~/.gemini` or any shared credential store
- [ ] Never read or copy OAuth tokens from disk. Never pass tokens in argv/env beyond what the user already set. Never log `authenticate` params.

### 1.4 Terminal auth

1.5.14 advertises `--login` as an `agy acp` flag: "Log in with Google interactively, then exit (ACP terminal auth)" (`ref/notes/agy-cli-info.txt:28`). However, the probe did not advertise a terminal auth method because `clientCapabilities.auth.terminal` was absent.

- [ ] First run a no-prompt probe with `clientCapabilities.auth.terminal: true` and record whether `authMethods` gains an entry with `"type": "terminal"` and `args: ["--login"]` (see test M3).
- [ ] If advertised, implement terminal auth exactly as ACP specifies:
  - derive the command from the configured agent invocation (`agy acp`), append the method's `args`, apply its `env`
  - `shell: false`; pass args as separate argv entries
  - show args/env to the user before launch; reject dangerous env keys (`PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, proxy/TLS trust vars) without explicit approval
  - run with an interactive TTY; exit status 0 = success; non-zero/termination/cancel = failure
  - on success, reconnect and re-run `initialize`
  - **never** call `authenticate` with a terminal method id
- [ ] If not advertised (likely on 1.5.14), expose a login action that runs `agy acp --login` in a terminal-capable surface, or prints the exact command for the user. Do not spawn `stdio: "inherit"` from a headless server.
- [ ] If `session/new` fails with `-32000` and no terminal method is available, tell the user to run `agy acp --login` (or complete the selected auth method), then retry once.

### 1.5 Auth gate strategy

Recommended:

1. Start the process, `initialize`, then try `session/new`.
2. If `session/new` succeeds, ambient auth is valid; do not call `authenticate`.
3. If `session/new` fails with `-32000`:
   - choose the user's configured method, or `oauth-personal` by default
   - if terminal method available and TTY-capable: run terminal flow
   - else call `authenticate { methodId }` once, with a cancellable long timeout
   - retry `session/new` once; if it still fails, surface the auth error and stop
4. Never loop `authenticate`/`session/new`.
5. Treat `-32000` from any later request as an auth failure; do not retry the prompt.

Security:

- `session/new` is the validity check; a cached "logged in" marker is not proof.
- Do not run concurrent `authenticate` calls; use a global login lock.
- Do not auto-select `--dangerously-skip-permissions` or `--sandbox` changes to work around auth.

---

## 2. Session lifecycle: `session/new` vs `session/resume` vs `session/load`

### 2.1 `session/new` — new ACP session for a new OpenCode session

Request (only send `additionalDirectories` if the capability is present):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/absolute/canonical/workspace",
    "mcpServers": [],
    "additionalDirectories": ["/absolute/extra"]
  }
}
```

- [ ] `cwd` MUST be absolute. Canonicalize/resolve it; do not use `process.cwd()` (the OpenCode server may run elsewhere). Prefer the OpenCode session's directory if exposed by `ctx.session.get`; otherwise `ctx.location.directory`.
- [ ] `mcpServers` is required in ACP v1; send `[]` in Phase 1.
- [ ] `additionalDirectories` only if `sessionCapabilities.additionalDirectories` is present. Each must be absolute, deduplicated, and not equal to `cwd`.
- [ ] Do not send `systemPrompt`: Antigravity does not advertise the standard `sessionCapabilities.systemPrompt`. `_meta.antigravity.systemPrompt.append` is not the standard field.
- [ ] Timeout ~30 s. A cold start can be slow.
- [ ] Validate `sessionId` is a non-empty printable string; cap length.
- [ ] Store `{ acpSessionId, cwd, additionalDirectories, processGeneration, agentVersion }`.
- [ ] Parse the response twice if using raw: canonical `configOptions` + legacy `models`. Do not discard unknown fields.

Response (abridged from `ref/notes/agy-acp-handshake.log:88-348`):

```json
{
  "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
  "models": {
    "availableModels": [
      { "modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)" },
      { "modelId": "gemini-4-neon-xhigh", "name": "Gemini 4 Neon (XHigh)" },
      { "modelId": "gemini-3.8-flash-low", "name": "Gemini 3.8 Flash (Low)" },
      { "modelId": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)" }
    ],
    "currentModelId": "gemini-4-neon-high"
  },
  "modes": {
    "currentModeId": "default",
    "availableModes": [
      { "id": "default", "name": "Default" },
      { "id": "accept-edits", "name": "Accept edits" },
      { "id": "auto", "name": "Auto" },
      { "id": "plan", "name": "Plan" }
    ]
  },
  "configOptions": [
    {
      "id": "model",
      "name": "Model",
      "category": "model",
      "type": "select",
      "currentValue": "gemini-4-neon",
      "options": [
        { "value": "gemini-4-neon", "name": "Gemini 4 Neon" },
        { "value": "gemini-3.8-flash", "name": "Gemini 3.8 Flash" }
      ]
    },
    {
      "id": "thought_level",
      "name": "Thinking Level",
      "category": "thought_level",
      "type": "select",
      "currentValue": "high",
      "options": [
        { "value": "low", "name": "Low" },
        { "value": "medium", "name": "Medium" },
        { "value": "high", "name": "High" },
        { "value": "xhigh", "name": "Extra" }
      ]
    },
    {
      "id": "mode",
      "name": "Mode",
      "category": "mode",
      "type": "select",
      "currentValue": "default",
      "options": [
        { "value": "default", "name": "Default" },
        { "value": "accept-edits", "name": "Accept edits" },
        { "value": "auto", "name": "Auto" },
        { "value": "plan", "name": "Plan" }
      ]
    }
  ],
  "_meta": {
    "antigravity": {
      "tier": { "name": "Google AI Ultra", "id": "g1-ultra-lite-tier", "upgradeUri": "https://antigravity.google/g1-upgrade" }
    }
  }
}
```

Important: the SDK's `NewSessionResponse` type does not include `models`; it is an Antigravity extension. The wire `configOptions` includes `category`/`description` even though the current SDK type may omit `category`; treat `category` as an optional semantic hint.

### 2.2 `session/resume` — reconnect without replay

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/resume",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "cwd": "/absolute/canonical/workspace",
    "mcpServers": [],
    "additionalDirectories": ["/absolute/extra"]
  }
}
```

- [ ] Only call if `sessionCapabilities.resume` is present (it is on 1.5.14).
- [ ] Send the **full** intended `additionalDirectories` list again; omitting it does not restore stored roots (`ref/agent-client-protocol/docs/protocol/v1/session-setup.mdx`, "Additional workspace roots").
- [ ] Response has `modes` and `configOptions` but **no `sessionId`** and no legacy `models` per spec. Do not expect `models`; keep the catalog from cache or from a previous `session/new`.
- [ ] No history replay before the response. If an update arrives during resume, treat it as live; do not assume it is replay.
- [ ] Timeout ~20 s.
- [ ] Expected response shape (no `sessionId`, no `models` per spec):

```json
{
  "modes": { "currentModeId": "default", "availableModes": [ /* ... */ ] },
  "configOptions": [ /* full model/thought_level/mode array */ ]
}
```

- [ ] If `-32002` (unknown session), drop the mapping, create a new session, and send a one-time bounded handoff (see 4.3).
- [ ] If `-32601` (method not found), fall back to `session/load` or `session/new` based on capabilities.

### 2.3 `session/load` — replay history (use sparingly)

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/load",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "cwd": "/absolute/canonical/workspace",
    "mcpServers": [],
    "additionalDirectories": ["/absolute/extra"]
  }
}
```

- [ ] Only if `loadSession` / `sessionCapabilities.load` is present.
- [ ] Register the update router **before** sending the request; set `replaying = true` for that session.
- [ ] Consume every `session/update` until the response; do not emit replay chunks into any active `LanguageModelV3` stream. Optionally rebuild a diagnostic transcript.
- [ ] `session/load` replays `user_message_chunk`, `agent_message_chunk`, tool calls, plans, and possibly usage/commands; all are history, not new output.
- [ ] Clear `replaying` on success and on error. On error, do not leave a half-loaded session mapped.
- [ ] Prefer `resume` over `load`: OpenCode already has the visible history; replay would duplicate it. Use `load` only to recover agent context when resume is unavailable.
- [ ] Timeout ~60 s; loading a long session can be slow.

### 2.4 `session/close` and idempotency

Request:

```json
{ "jsonrpc": "2.0", "id": 30, "method": "session/close", "params": { "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92" } }
```

- [ ] Only if `sessionCapabilities.close` is present (it is).
- [ ] `close` cancels ongoing work like `session/cancel` and frees resources.
- [ ] Treat `-32002` as a successful close; closing is idempotent.
- [ ] Timeout ~5 s. The probe shows updates can arrive after the close result (`ref/notes/agy-acp-config.log:42-48`); mark the session closed first and ignore all subsequent updates for it.
- [ ] Do not call `session/delete`; it is not advertised.

### 2.5 Persistence and session mapping

- [ ] Store a map keyed by `(providerID, workspace, openCodeSessionID)`:
  - `acpSessionId`, `cwd`, `additionalDirectories`
  - last confirmed `configOptions` (model, thought_level, mode)
  - last confirmed `capabilities` (for fallbacks)
  - `lastUsedAt`, `agentVersion`
- [ ] Do not store prompts, thoughts, file contents, or auth tokens.
- [ ] On plugin startup, register the provider from cached catalog; lazily start `agy` on first use.
- [ ] If a stored ACP session is stale, `resume` then `new` with handoff. Never reuse a session id from a different cwd.
- [ ] One ACP child process may host multiple sessions; use a per-session queue. If isolation is preferred, spawn one child per OpenCode session (the CLI also has `--process-per-session`, but that flag changes server behavior; test before using).

### 2.6 `session/list` (optional)

- [ ] `session/list` is advertised; response has `sessionId`, `cwd`, `title`, `updatedAt`, `additionalDirectories`.
- [ ] Use it only for diagnostics/recovery UI. It cannot map an ACP session back to an OpenCode session without your own stored mapping.
- [ ] Do not call it on every startup; it starts the agent runtime.

---

## 3. Model, `thought_level`, and mode selection

### 3.1 Read `configOptions` correctly

- [ ] Build a map by `id`; also index by `category` (`model`, `thought_level`, `mode`, `model_config`).
- [ ] The array order is the agent's preferred priority; preserve it for UI.
- [ ] Validate each option:
  - `id`/`currentValue` are bounded printable strings (or boolean for `type: "boolean"`)
  - `options` is a flat array or grouped array; flatten groups for lookup, preserve groups for UI if desired
  - cap options (e.g. 200) and label lengths
  - reject duplicate values
- [ ] If `type` is unknown, ignore the option; the agent continues using `currentValue`.
- [ ] Do not assume `category` exists. Use `id === "model"` / `"thought_level"` / `"mode"` as the primary match, with category as a hint.
- [ ] Do not expect `description` on the SDK type; the wire may include it; render if present.

Canonical 1.5.14 values:

| id | category | current | options |
|---|---|---|---|
| `model` | `model` | `gemini-4-neon` | 11 base ids |
| `thought_level` | `thought_level` | `high` | `low`, `medium`, `high`, `xhigh` (model-dependent) |
| `mode` | `mode` | `default` | `default`, `accept-edits`, `auto`, `plan` |

### 3.2 Build the OpenCode model catalog

Inputs:

- `configOptions.model.options` → base models (id + display name)
- `configOptions.thought_level.options` → global effort levels (id + display name)
- `models.availableModels` → effort-qualified ids + display names
- `models.currentModelId` → fallback only

Algorithm:

1. `levels = thought_level.options.map(o => o.value)`; keep `xhigh` even if the current model lacks it.
2. `available = Map(models.availableModels.map(m => [m.modelId, m.name]))`.
3. For each base model `b`:
   - `variants = levels.filter(l => available.has(`${b}-${l}`)).map(l => ({ id: l, slug: `${b}-${l}`, name: available.get(`${b}-${l}`) }))`
   - if `variants.length === 0` and `available.has(b)`, treat it as a single-variant model with `slug: b`, `id: "default"` (or no variants)
   - if `variants.length === 0` and `available` has no exact match, keep the base id as a fallback variant; log a warning
   - do not infer variants by parsing `(High)` in names when `configOptions` is present; name parsing is only a fallback for older agents (see `ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/antigravity/catalog.ts:44-61`)
4. Deduplicate by base id; cap 200 models and 20 variants per model.
5. `family`: prefix before the first `-` (`gemini`, `claude`, `gpt`, `gpt-oss`), or the base id.
6. `Model.Info`:
   - `id` = base id; `name` = base display name
   - `variants` = `[{ id, settings: { effort: id, slug } }]`
   - `capabilities.tools = true`; `capabilities.input = ["text", "image"]` only if `promptCapabilities.image`, else `["text"]`; `capabilities.output = ["text"]`
   - `limit.context = 1048576` from the probe's `usage_update.size`, or the largest observed size; `limit.output = 65536` as a conservative fallback (unknown)
   - `cost = []` (subscription; do not invent per-token prices)
   - `package = "aisdk:antigravity-acp"`; `activation = "enabled"` or `auto`; `type = "chat"`; `status = "active"`; `enabled = true`
   - `time.released = 0` if required by the schema
- [ ] Cache the catalog (`ctx.storage`) with agent version + timestamp; refresh on first use, on `config_option_update`, or on explicit reload. Do not spawn `agy` on every OpenCode startup.
- [ ] Debounce `ctx.provider.reload()` after catalog changes (e.g. 500–1000 ms) to avoid loops; reference `ref/opencode-antigravity-acp/src/index.ts:59-86`.

Expected 1.5.14 grouping:

- `gemini-4-neon`: low, medium, high, xhigh
- `gemini-4-hydrogen`: low, medium, high, xhigh
- `gemini-4-carbon`, `gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`: low, medium, high
- `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`, `gpt-oss-120b-medium`: single variant

### 3.3 Set model and effort: exact sequence

Use `session/set_config_option` only. Do not use `session/set_model` on 1.5.14.

For each turn, before `session/prompt`, with a per-session config mutex:

1. Resolve the requested OpenCode model id (base) and variant id (effort).
2. If the base model differs from the last confirmed `model.currentValue`:
   - send:

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "session/set_config_option",
  "params": { "sessionId": "...", "configId": "model", "value": "gemini-3.8-flash" }
}
```

   - take the **result** `configOptions` as the new authoritative state
   - verify `model.currentValue === requested base`; if not, retry once, then fail the turn with a "model not applied" error (do not send the prompt with the wrong model)
   - read the new `thought_level.options` and `currentValue`; they may have changed
3. Clamp the requested effort:
   - if requested effort is in the new `thought_level.options`, use it
   - else if the new `currentValue` is in options, keep it
   - else prefer `high`, then `medium`, then the first option
   - if the model has no variants, skip `thought_level`
4. If clamped effort differs from `thought_level.currentValue`:
   - send `session/set_config_option { configId: "thought_level", value: clamped }`
   - apply the result; verify `thought_level.currentValue === clamped`; retry once, then fail closed (do not prompt with an unconfirmed effort, or downgrade to the confirmed current value and warn)
5. If the desired mode differs from `mode.currentValue`, set it (see 3.5). Do this after model/effort because model changes can alter options.
6. Only after all three are confirmed, send `session/prompt`.

Why this order:

- `set_config_option model` returns the full dependent state, including narrowed `thought_level` options (`ref/notes/agy-acp-config.log:11-13`).
- Setting effort before model can send a value the new model does not support.
- Setting mode before model is harmless but may be overwritten by a model-triggered config update; do it last for a stable final state.

Invalid values:

- `-32602` means invalid `configId` or value. Refresh the catalog, fail the turn, and show "model/effort unavailable"; do not retry the same value.
- If the result is missing a required option, treat it as a protocol error; do not guess.

### 3.4 Per-model option changes

Concrete evidence:

- `gemini-4-neon` supports `xhigh`; `gemini-3.8-flash` does not (`ref/notes/agy-acp-config.log:12` vs `:29`).
- Switching from `gemini-3.8-flash` back to `gemini-4-neon` re-adds `xhigh`, while preserving `thought_level: low` if it was valid (`:27-30`).
- Setting a qualified model id `gemini-3.8-flash-low` is coerced to base `gemini-3.8-flash` + effort `low`; the result is authoritative (`:22-26`). Treat this as compatibility behavior only; always send base + separate effort.

Checklist:

- [ ] After every model change, replace the entire `configOptions` cache; never merge only the model entry.
- [ ] Recompute the model's variant list for UI; if it changed, schedule a catalog reload.
- [ ] If the user's selected effort is no longer valid, clamp and persist the clamped value for that OpenCode session; do not silently keep an invalid variant.
- [ ] If `currentValue` is not present in its own `options` (possible during transitions), treat it as invalid and clamp; log a warning.
- [ ] Do not cache `models.currentModelId` as the selected model; it is effort-qualified and can disagree with `configOptions.model.currentValue`.

### 3.5 Mode selection and security

Prefer the config option:

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "session/set_config_option",
  "params": { "sessionId": "...", "configId": "mode", "value": "plan" }
}
```

- [ ] Use `set_config_option {configId:"mode"}` first; it returns the full config state, so you can verify `mode.currentValue`.
- [ ] If it returns `-32601`/`-32602`, fall back to:

```json
{ "jsonrpc": "2.0", "id": 12, "method": "session/set_mode", "params": { "sessionId": "...", "modeId": "plan" } }
```

- [ ] `set_mode` returns `{}` without confirmation, and `current_mode_update` can arrive late (`ref/notes/agy-acp-config.log:18-24`). If you must use it:
  - do not send the prompt until a `current_mode_update` with the requested mode arrives, with a short grace (e.g. 2 s)
  - if it does not arrive, **fail closed** for less-restrictive modes (`auto`, `accept-edits`): downgrade to `default` and warn; for `plan`/`default`, proceeding is acceptable because those are the safer states
  - never treat `{}` as proof that a less-restrictive mode was applied
- [ ] Mode mapping:
  - OpenCode agent `plan` → ACP `plan`
  - OpenCode agent `build` → ACP `default`
  - user config may explicitly select `auto`/`accept-edits`; require opt-in and a visible warning
- [ ] **Security:** ACP `auto`/`accept-edits` can make the agent act without sending `session/request_permission`. OpenCode permissions cannot constrain Antigravity-native tools in those modes. Default to `default`; never enable `auto`/`accept-edits` implicitly, and never use `--dangerously-skip-permissions` by default.
- [ ] `current_mode_update` from the agent:
  - update the local mode cache only
  - do not silently change the OpenCode agent or permission rules
  - if the agent moves to a less-restrictive mode unexpectedly, surface a warning; do not hide it
- [ ] If the agent changes mode mid-turn (e.g. plan → default), apply the new mode for subsequent turns; do not rewrite the current turn's user intent.

### 3.6 Legacy `session/set_model` (fallback only)

- [ ] Do not use on 1.5.14. It is absent from ACP artifacts and SDK 2.9.1 bindings.
- [ ] If supporting an older agent:
  - send `{ sessionId, modelId: "<base>-<effort>" }` or `{ modelId: "<base>" }`
  - if it returns `{}`, immediately read `configOptions` via a subsequent `set_config_option` no-op or a `session/options` call if available; `{}` is not state confirmation
  - never mix `set_model` and `set_config_option` in the same turn without re-reading state
- [ ] If a user config supplies a qualified model id, split it into base + effort using the known option values; do not send the qualified id to `configId:"model"` unless you intentionally rely on the non-spec coercion.

### 3.7 Stale notifications and ordering

Evidence: `set_config_option` can emit `config_option_update` **before** its result, and the notification can contain the previous value (`ref/notes/agy-acp-config.log:15-17`). `current_mode_update` can arrive after the next request (`:23`). `set_model` updates are even more deferred (`ref/notes/agy-acp-set-model.log:13-18`).

Rule:

- [ ] Keep a per-session `configRevision` (monotonic integer) and `pendingMutation` counter.
- [ ] When a mutation starts, increment `pendingMutation`.
- [ ] Apply the mutation **result** as authoritative and bump `configRevision`; decrement `pendingMutation`.
- [ ] While `pendingMutation > 0`, buffer `config_option_update`/`current_mode_update` notifications but do not overwrite confirmed state. After the mutation settles, discard buffered notifications that predate the result; apply later ones only if they are consistent or represent an external change.
- [ ] Without sequence numbers, the simplest safe policy:
  - result wins over any notification received before it
  - after the result, accept a notification only if its `currentValue` differs from the last confirmed value **and** no local mutation is in flight; log the change
  - if a notification contradicts a just-confirmed value, ignore it once and re-read on the next turn; do not immediately revert
- [ ] Never derive the selected model/effort/mode from notifications alone; always keep the last confirmed `configOptions`.
- [ ] If rapid switching returns a stale result (documented risk in `ref/README.md:280`), verify the result's `currentValue` against the request; retry once with the same value, then fail the turn. Do not send the prompt with an unconfirmed model.

### 3.8 OpenCode `model.request` hook: pass selection to `doStream`

`LanguageModelV3CallOptions` does not carry `sessionID` or `variant` directly. Use the OpenCode V2 hook (reference: `ref/opencode-antigravity-acp/src/index.ts:125-135`):

```ts
yield* ctx.session.hook(
  "model.request",
  (input) =>
    Effect.sync(() => {
      input.headers["x-opencode-session-id"] = input.sessionID
      input.headers["x-opencode-antigravity-acp-variant"] = input.model.variant ?? ""
      input.headers["x-opencode-antigravity-acp-kind"] = input.kind
      input.headers["x-opencode-antigravity-acp-agent"] = input.agent
    }),
  { providerID: "antigravity-acp" },
)
```

In `doStream`:

```ts
const headers = options.headers ?? {}
const sessionID = headers["x-opencode-session-id"]
const variant = headers["x-opencode-antigravity-acp-variant"] || undefined
const kind = headers["x-opencode-antigravity-acp-kind"] || "primary"
const agent = headers["x-opencode-antigravity-acp-agent"] || "build"
```

- [ ] If `sessionID` is missing, return a clear error; do not fall back to a shared default session (that breaks concurrency and leaks history).
- [ ] For `kind !== "primary"` (title/compaction/etc.):
  - title: handle locally via `ctx.session.hook("title")`; do not call ACP
  - compaction: do not interleave with a live prompt; either use a separate ephemeral ACP session or return a local, clearly-labeled error/empty result. Document which.
- [ ] Use the OpenCode session's agent (`input.agent`) to choose ACP mode; do not use a global mode.

---

## 4. Prompt content: text, image, resource

### 4.1 What to send on a warm session

- ACP owns the conversation. On a warm session, send only the **current turn's user content**.
- Do not resend prior assistant/user/tool messages; that duplicates history and can confuse the agent.
- Do not send the OpenCode system prompt or tool schemas. The agent has its own instructions and tools; OpenCode's system prompt describes tools the agent does not have.
- If the last user message has no text (only an image/file), add a short neutral text block (e.g. `"See the attached content."`) so the prompt is non-empty; do not add instructions.

### 4.2 Content block mapping

`session/prompt` request shape (`ref/typescript-sdk/src/v1/schema/types.gen.ts:4590`):

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "session/prompt",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "prompt": [
      { "type": "text", "text": "Please review this file." },
      { "type": "image", "data": "iVBORw0KGgo...", "mimeType": "image/png" },
      {
        "type": "resource",
        "resource": {
          "uri": "file:///absolute/workspace/src/a.ts",
          "mimeType": "text/typescript",
          "text": "export const a = 1\n"
        }
      }
    ]
  }
}
```

Mapping table:

| OpenCode/AI SDK part | ACP content | Conditions |
|---|---|---|
| text | `{ "type":"text", "text": string }` | always (baseline) |
| image (Uint8Array/ArrayBuffer/base64/data URL) | `{ "type":"image", "data": base64, "mimeType": "image/png" }` | only if `promptCapabilities.image === true`; normalize to base64; preserve media type |
| image URL (`http(s)`) | fetch and inline as base64, or reject visibly | ACP image has no URL field; `supportedUrls: {}` means the provider must handle it; enforce size/time limits |
| file/text resource (small) | `{ "type":"resource", "resource": { "uri":"file:///abs", "mimeType":"text/...", "text":"..." } }` | only if `promptCapabilities.embeddedContext === true` |
| binary resource | `{ "type":"resource", "resource": { "uri":"file:///abs", "mimeType":"...", "blob": base64 } }` | only if embeddedContext; enforce size caps |
| file link (large/outside) | `{ "type":"resource_link", "uri":"file:///abs", "name":"a.ts", "mimeType":"text/typescript" }` | baseline supported; agent reads it itself |
| audio | none | `promptCapabilities.audio === false`; reject visually, do not silently drop |
| tool result / assistant message | do not send as user prompt | ACP session history; use a one-time handoff only if creating a new session |

Rules:

- [ ] Preserve the order of text/image/resource blocks where meaningful.
- [ ] ACP baseline supports `text` and `resource_link`; `image` and `resource` require the advertised capabilities. If a capability is false, fail the request with a user-visible error; never silently drop content.
- [ ] Base64-encode images/files before writing; do not send raw `Uint8Array`/`ArrayBuffer` in JSON (it serializes as an object).
- [ ] Enforce size limits before spawn/write:
  - max prompt bytes (e.g. 24 MiB total, below the 32 MiB frame cap)
  - max image bytes (e.g. 10 MiB decoded)
  - max embedded resource text (e.g. 256 KiB per file; use `resource_link` for larger)
  - max number of blocks (e.g. 100)
- [ ] Escape control characters in text? Preserve text faithfully; do not rewrite user content. For handoff/diagnostics, bound and escape.
- [ ] Do not fetch arbitrary URLs from workspace content without user consent; SSRF risk. Prefer `resource_link` or a local read.

### 4.3 History handoff when creating a new ACP session

Use only when the OpenCode thread has prior context that the ACP session does not (resume failed, process replaced, model switch to a fresh session).

- [ ] Build a bounded handoff (e.g. 24k characters):
  - role labels (`user`, `assistant`, `tool`)
  - assistant text/thought summaries
  - tool names + bounded inputs + bounded results
  - explicitly mark it as untrusted context and not instructions
- [ ] Prefer `resource` when `embeddedContext` is true:

```json
{
  "type": "resource",
  "resource": {
    "uri": "urn:opencode:antigravity-acp:handoff:<sessionID>:<revision>",
    "mimeType": "text/markdown",
    "text": "# Prior OpenCode conversation (untrusted context)\n..."
  }
}
```

- [ ] Otherwise prepend a clearly delimited text block, followed by the current user text.
- [ ] Send it once per new ACP session; track a revision/hash so a warm session never receives it again.
- [ ] Do not include secrets, full file contents, or the OpenCode system prompt. Truncate tool outputs and mark truncation.
- [ ] Do not include provider-executed tool calls/results as executable structures; render them as text. This also prevents cross-provider serialization errors when switching models (`ref/opencode-antigravity-acp/src/history-sanitizer.ts`).

### 4.4 Prompt request/response example

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "session/prompt",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "prompt": [
      { "type": "text", "text": "Reply with exactly: ok" }
    ]
  }
}
```

Expected response (usage is a draft field; it may be absent):

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "result": {
    "stopReason": "end_turn",
    "usage": {
      "totalTokens": 1234,
      "inputTokens": 1000,
      "outputTokens": 234,
      "thoughtTokens": 0,
      "cachedReadTokens": 0,
      "cachedWriteTokens": 0
    }
  }
}
```

- [ ] `stopReason` is required; `usage` is optional and only typed in `/unstable`.
- [ ] Do not treat a missing `usage` as an error; `usage_update` may be the only source.
- [ ] Do not estimate tokens from text length.

---

## 5. Prompt response usage vs `usage_update`

### 5.1 Semantics (and the open ambiguity)

There are two different measurements:

1. `PromptResponse.usage` (ACP v1 draft, `/unstable`): token counters for the prompt. The SDK comments say "across session"/"across all turns" (`ref/typescript-sdk/src/v1/unstable/schema/types.gen.ts:3415-3440`), but real-world Antigravity 1.5.0 behavior described by the Pi provider is a **per-turn aggregate** across all inference requests in that turn (`ref/pi-antigravity-acp-provider/docs/PROTOCOL-MAPPING.md:221-234`). OpenCode's own ACP server also emits per-turn usage (`ref/opencode-pr-65430/packages/cli/src/acp/translate.ts:165-183`).
2. `usage_update` (ACP v1 session update): `used` = current context occupancy, `size` = context window, optional `cost`. It can arrive multiple times per turn (once per inference) and also outside a turn. The probe shows a zero-valued setup update after `session/new` (`ref/notes/agy-acp-config.log:34`).

**Do not add them together.** They measure different things.

Decision for Phase 1:

- Treat `PromptResponse.usage` as **current-turn aggregate** (the real-world behavior).
- Treat the latest non-zero `usage_update.used` as **context occupancy**.
- Add a config/diagnostic flag `usageMode: "turn" | "cumulative" | "auto"` (default `"turn"`). If a live test proves cumulative behavior, switch the default and delta against the previous turn.
- If `usageMode: "auto"`, detect cumulative only when the second turn's `totalTokens` is >= the first turn's and approximately `first + second`; otherwise keep per-turn. Log the decision; never silently double count.

### 5.2 Mapping to `LanguageModelV3` finish usage

`LanguageModelV3Usage` shape used by the reference plugin (`ref/opencode-antigravity-acp/src/session-bridge.ts:244-266`):

```json
{
  "inputTokens": {
    "total": 53000,
    "noCache": 50000,
    "cacheRead": 3000,
    "cacheWrite": 0
  },
  "outputTokens": {
    "total": 1200,
    "text": 900,
    "reasoning": 300
  }
}
```

Algorithm:

1. If prompt `usage` is present:
   - `inputTotal = usage.inputTokens`
   - `outputTotal = usage.outputTokens`
   - `reasoning = usage.thoughtTokens ?? 0`
   - `cacheRead = usage.cachedReadTokens ?? 0`
   - `cacheWrite = usage.cachedWriteTokens ?? 0`
   - `noCache = max(0, inputTotal - cacheRead - cacheWrite)`
   - `text = max(0, outputTotal - reasoning)`
2. If prompt `usage` is absent:
   - `inputTotal = latestUsageUpdate.used` (if any)
   - `outputTotal = 0`, `reasoning = 0`, `cacheRead/Write = undefined`
   - `noCache = inputTotal` (unknown split; do not pretend)
   - mark `providerMetadata.antigravityAcp.usageSource = "usage_update"`
3. If both are present:
   - use prompt usage for the finish counters
   - expose `contextUsed = latestUsageUpdate.used`, `contextSize = latestUsageUpdate.size` in providerMetadata
   - do not use `contextUsed` to replace the prompt input count unless prompt usage is absent
   - if neither prompt usage nor `usage_update` exists, emit zero counters and mark `usageSource: "unavailable"`; do not estimate
4. Ignore `usage_update` with `used === 0` immediately after `session/new`; it is setup, not inference.
5. `cost`: keep in providerMetadata/diagnostics. Do not map to `Model.Info.cost` per-token pricing; units may be credits or a subscription estimate.
6. Validate all counters: finite, non-negative, safe integers; clamp negative deltas to 0; reject fractional values.
7. Cache the latest context size and use it to update the model's `limit.context` if it is larger than the current value (but do not shrink a known 1,048,576 limit based on a single turn).

### 5.3 `usage_update` example

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "update": {
      "sessionUpdate": "usage_update",
      "used": 53000,
      "size": 1048576,
      "cost": { "amount": 0.045, "currency": "USD" }
    }
  }
}
```

- [ ] Store `used`/`size` per session; emit nothing to the model stream.
- [ ] On `finish`, attach `{ contextUsed, contextSize, cost? }` under providerMetadata.
- [ ] Reset per-turn `usage_update` tracking at the start of each prompt; keep the last known context size across turns.
- [ ] Do not treat a `usage_update` arriving after a prompt response as belonging to the next turn; use a turn generation id.

---

## 6. `session/update` → `LanguageModelV3` mapping

### 6.1 Complete mapping table

| ACP `sessionUpdate` | `LanguageModelV3` action | Notes |
|---|---|---|
| `user_message_chunk` | ignore during live; suppress during replay | history echo, never assistant text |
| `agent_message_chunk` (text) | `text-start` / `text-delta` / `text-end` | one open text block per contiguous run; reset on `messageId` change; close before thought/tool |
| `agent_message_chunk` (image/resource/audio) | diagnostic only; optionally `file` if the installed provider supports it | never cast binary to text; do not dump base64 |
| `agent_thought_chunk` (text) | `reasoning-start` / `reasoning-delta` / `reasoning-end` | thought summary only; do not invent hidden CoT |
| `tool_call` | create provider-executed call: `tool-input-start`/`delta`/`end` + `tool-call` | exactly once per `toolCallId`; do not emit `tool-result` here unless the initial status is already terminal |
| `tool_call_update` | patch call state; on terminal status emit exactly one `tool-result` | `pending`/`in_progress` do not produce a result; `completed` success; `failed`/unknown terminal failure |
| `usage_update` | store; attach to `finish.providerMetadata` | not a stream part; ignore zero setup update |
| `current_mode_update` | update mode cache; optional providerMetadata | do not alter OpenCode agent/permissions |
| `config_option_update` | replace config cache; validate; maybe reload catalog | can be stale; result of mutation wins |
| `available_commands_update` | replace command cache; dedupe | never inject into model output; optional UI/RPC |
| `plan` | replace plan snapshot; attach to `finish.providerMetadata` | legacy checklist; not a LanguageModelV3 part; do not emit as text |
| `plan_update` / `plan_removed` | only if `plan` capability advertised | we do not advertise; ignore defensively |
| `session_info_update` | update OpenCode session title if desired | optional; `ctx.session.update({sessionID,title})` |
| `notice` / `compaction_update` / `compaction_summary_chunk` / `subagent_update` / `session_message*` | ignore + debug log | not advertised by us; agent must not send; ignore safely |
| unknown | ignore + count/log type | forward-compatible |

### 6.2 Message and thought chunks

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "msg_agent_1",
      "content": { "type": "text", "text": "I'll inspect the file." }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "messageId": "msg_thought_1",
      "content": { "type": "text", "text": "Need to check imports first." }
    }
  }
}
```

Rules:

- [ ] If `messageId` changes, close the open block and start a new one with the new id. If absent, use a generated id per contiguous run.
- [ ] Close the open text block before opening reasoning, and vice versa. Do not interleave text/reasoning deltas in one block.
- [ ] Close all open blocks before a tool call and before `finish`.
- [ ] Empty text chunks: ignore; do not emit empty deltas.
- [ ] Preserve text exactly (no trimming) for model output. For diagnostics, bound.

### 6.3 Tool calls: exact state machine (do not duplicate tool-result)

Per-turn map keyed by `toolCallId`:

```ts
type ToolState = {
  toolCallId: string
  toolName: string
  title: string
  kind?: string
  status: "pending" | "in_progress" | "completed" | "failed" | "unknown"
  rawInput?: unknown
  content: unknown[]
  locations: { path: string; line?: number }[]
  callEmitted: boolean
  terminalEmitted: boolean
}
```

First sight of `tool_call`:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call_001",
      "title": "Reading configuration file",
      "name": "read_file",
      "kind": "read",
      "status": "pending",
      "rawInput": { "path": "/absolute/workspace/config.json" },
      "locations": [{ "path": "/absolute/workspace/config.json" }]
    }
  }
}
```

Emit once:

```json
{ "type": "tool-input-start", "id": "call_001", "toolName": "acp_read_file", "providerExecuted": true }
{ "type": "tool-input-delta", "id": "call_001", "delta": "{\"path\":\"/absolute/workspace/config.json\"}" }
{ "type": "tool-input-end", "id": "call_001" }
{ "type": "tool-call", "toolCallId": "call_001", "toolName": "acp_read_file", "input": "{\"path\":\"/absolute/workspace/config.json\"}", "providerExecuted": true }
```

- [ ] Tool name: `name ?? kind ?? title`, sanitized to `[A-Za-z0-9_-]`, prefixed with `acp_` to avoid colliding with OpenCode tools. Keep the same name for the result.
- [ ] `tool-input-start` uses `id` (not `toolCallId`), matching the existing plugin (`ref/opencode-antigravity-acp/src/session-bridge.ts:1756-1778`).
- [ ] `input` is a JSON string; `JSON.stringify(rawInput ?? {})`. Do not pass an object where a string is expected.
- [ ] Do not emit a standalone `tool-result` before the `tool-call` exists. If the initial `status` is already `completed`/`failed`, emit the `tool-call` and then exactly one `tool-result` immediately after it (see below).
- [ ] If a `tool_call_update` arrives before any `tool_call`, synthesize the call from the update (title/name/kind/rawInput) and then apply the update; do not drop the result.

Terminal update:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_001",
      "status": "completed",
      "content": [
        {
          "type": "content",
          "content": { "type": "text", "text": "config.json: 42 lines" }
        }
      ],
      "rawOutput": "config.json: 42 lines"
    }
  }
}
```

Emit exactly once:

```json
{
  "type": "tool-result",
  "toolCallId": "call_001",
  "toolName": "acp_read_file",
  "result": { "status": "completed", "output": "config.json: 42 lines" },
  "isError": false,
  "providerMetadata": { "antigravity-acp": { "acp": true, "kind": "read", "locations": ["/absolute/workspace/config.json"] } }
}
```

Rules:

- [ ] Terminal statuses in ACP v1: `completed`, `failed`. Treat `error`/`cancelled` (Antigravity may send them) as terminal failure with the raw status preserved.
- [ ] Non-terminal: `pending`, `in_progress`; do not emit a result.
- [ ] Result payload preference: `rawOutput` → flattened `content` text → `{ status, title }`.
- [ ] Content types:
  - `type:"content"` → extract the inner `ContentBlock` text; if non-text, include a bounded JSON representation, not raw binary.
  - `type:"diff"` → include `{ path, oldText, newText }` bounded, or a rendered unified diff; never execute it.
  - `type:"terminal"` → include `terminalId` and a note; we did not advertise terminal support, so this should not occur.
  - `type:"session"` → include `sessionId`; display-only.
- [ ] `content` on an update replaces the whole array; `null`/omitted leaves the previous content. Keep the latest array for the final result.
- [ ] If the same `toolCallId` produces multiple terminal updates, ignore all but the first; set `terminalEmitted`.
- [ ] If the prompt ends while calls are still `pending`/`in_progress`:
  - on normal end: emit one result with `{ status: "incomplete" }`, `isError: true`; do not pretend success
  - on cancel: emit one result with `{ status: "cancelled" }`, `isError: true`
  - on process error: emit one result with `{ status: "failed", error: "process exited" }`, `isError: true`
- [ ] Clear the per-turn map at the start of each `session/prompt`; a `toolCallId` reused in a new turn is a new call. Within a turn, a repeated id after terminal is a duplicate; ignore.
- [ ] Never dispatch these calls to OpenCode tools and never emit a second `tool-result` when OpenCode later sends a matching tool result; these are provider-executed, not host-executed.

### 6.4 `usage_update`, `current_mode_update`, `config_option_update`, commands, plan

`current_mode_update`:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": { "sessionUpdate": "current_mode_update", "currentModeId": "plan" }
  }
}
```

- [ ] Update cached mode; no stream part.
- [ ] Do not change OpenCode's agent selection.
- [ ] If the mode becomes less restrictive unexpectedly, warn.

`config_option_update`:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "config_option_update",
      "configOptions": [ /* full array, same shape as session/new */ ]
    }
  }
}
```

- [ ] Replace the full config cache; validate; update model/effort/mode state subject to 3.7.
- [ ] If the model list/variants changed, debounce a catalog reload.
- [ ] Ignore for closed/replaying sessions (except replay handling).

`available_commands_update`:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        { "name": "compact", "description": "Compact the conversation now." },
        { "name": "plan", "description": "Plan carefully before executing a task." }
      ]
    }
  }
}
```

- [ ] Deduplicate by hash; the probe emitted the same list three times.
- [ ] Cap count (e.g. 200) and name/description lengths; strip control characters for display.
- [ ] Do not register arbitrary commands as OpenCode tools at turn time. Optional: expose a read-only list via plugin RPC/GUI.
- [ ] If mapping a command to a prompt, send the literal text only when the user explicitly invokes it; do not auto-run.

`plan`:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "plan",
      "entries": [
        { "content": "Inspect imports", "priority": "high", "status": "in_progress" },
        { "content": "Run tests", "priority": "medium", "status": "pending" }
      ]
    }
  }
}
```

- [ ] Replace the whole plan each time (spec: all entries, current status).
- [ ] Validate `priority` ∈ {high, medium, low}, `status` ∈ {pending, in_progress, completed}; cap entries/content.
- [ ] Do not emit plan entries as assistant text or tool calls. Attach a bounded snapshot to `finish.providerMetadata` and/or render in a plugin UI.
- [ ] `plan_update`/`plan_removed` require the client `plan` capability; we do not advertise it. Ignore if received.

### 6.5 Recommended stream part sequence

```json
{ "type": "stream-start", "warnings": [] }
{ "type": "reasoning-start", "id": "r_1" }
{ "type": "reasoning-delta", "id": "r_1", "delta": "Need to inspect imports." }
{ "type": "reasoning-end", "id": "r_1" }
{ "type": "text-start", "id": "t_1" }
{ "type": "text-delta", "id": "t_1", "delta": "I'll read the file." }
{ "type": "text-end", "id": "t_1" }
{ "type": "tool-input-start", "id": "call_001", "toolName": "acp_read_file", "providerExecuted": true }
{ "type": "tool-input-delta", "id": "call_001", "delta": "{\"path\":\"/abs/a.ts\"}" }
{ "type": "tool-input-end", "id": "call_001" }
{ "type": "tool-call", "toolCallId": "call_001", "toolName": "acp_read_file", "input": "{\"path\":\"/abs/a.ts\"}", "providerExecuted": true }
{ "type": "tool-result", "toolCallId": "call_001", "toolName": "acp_read_file", "result": { "status": "completed", "output": "..." }, "isError": false }
{ "type": "text-start", "id": "t_2" }
{ "type": "text-delta", "id": "t_2", "delta": "The file exports one constant." }
{ "type": "text-end", "id": "t_2" }
{
  "type": "finish",
  "finishReason": { "unified": "stop", "raw": "end_turn" },
  "usage": {
    "inputTokens": { "total": 1000, "noCache": 1000, "cacheRead": 0, "cacheWrite": 0 },
    "outputTokens": { "total": 234, "text": 234, "reasoning": 0 }
  },
  "providerMetadata": {
    "antigravity-acp": { "acp": true, "contextUsed": 53000, "contextSize": 1048576, "mode": "default" }
  }
}
```

- [ ] Emit `stream-start` exactly once.
- [ ] Emit exactly one terminal event: `finish` or `error`.
- [ ] After `finish`/`error`, ignore all late updates for that turn.
- [ ] Do not emit `tool-result` at `tool_call` creation unless the initial status is terminal; in that case emit it immediately after the `tool-call`, once.

### 6.6 Stop reason mapping

| ACP `stopReason` | `finish.finishReason.unified` | Notes |
|---|---|---|
| `end_turn` | `stop` | normal |
| `max_tokens` | `length` | truncated |
| `max_turn_requests` | `length` or `other` | preserve `raw`; distinguish in diagnostics |
| `refusal` | `content-filter` | safety refusal |
| `cancelled` | `other` | user/agent cancel; do not show an alarming error |
| unknown | `other` | preserve `raw` |

- [ ] Set `finishReason.raw` to the exact ACP `stopReason` for diagnostics.
- [ ] Do not map `cancelled` to `error` unless the stream is still open and the agent failed to honor cancellation; prefer a normal finish with `other`/`cancelled`.
- [ ] If tool calls were provider-executed and all results are emitted, `stop` is correct; `tool-calls` is for host-dispatched tools you did not execute.

---

## 7. `session/request_permission` and OpenCode permissions

### 7.1 Request shape

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session/request_permission",
  "params": {
    "sessionId": "7e60f0b3-cca1-4fe3-b614-dea31c0d8e92",
    "toolCall": {
      "toolCallId": "call_001",
      "title": "Run shell command",
      "name": "run_command",
      "kind": "execute",
      "rawInput": { "command": "rm -rf /absolute/workspace/tmp" },
      "locations": [{ "path": "/absolute/workspace" }]
    },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "allow-always", "name": "Always allow this command", "kind": "allow_always" },
      { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" },
      { "optionId": "reject-always", "name": "Always reject this command", "kind": "reject_always" }
    ]
  }
}
```

- [ ] `toolCall` is a `ToolCallUpdate`: only `toolCallId` is guaranteed. Merge it with the cached `tool_call` state by id to recover title/kind/rawInput/locations. If no cache, display the id and whatever is present.
- [ ] Validate:
  - `sessionId` matches a live session
  - `options` is non-empty, unique `optionId`s, known `kind`s; cap count
  - `toolCallId` is non-empty; cap title/locations/rawInput sizes
- [ ] If the request is for a closed/unknown session, respond `cancelled`; never allow.
- [ ] If the turn is not active (stale request), respond `cancelled`.
- [ ] Never auto-select `options[0]`; never infer `kind` from `optionId` strings alone (the agent controls both, but `kind` is the semantic hint; still validate).

### 7.2 Option kinds → OpenCode decision

| ACP `kind` | Meaning | Recommended response |
|---|---|---|
| `allow_once` | allow this operation once | selected after OpenCode approval |
| `allow_always` | allow and remember (agent owns scope/persistence) | selected only on explicit user approval; surface that it persists; otherwise prefer `allow_once` if offered |
| `reject_once` | reject this operation once | selected on denial |
| `reject_always` | reject and remember | selected only on explicit persistent denial; otherwise prefer `reject_once` |

Rules:

- [ ] Map approval through `ctx.permission.assert({ sessionID, agent, action, resources, metadata })`; reference `ref/opencode-antigravity-acp/src/session-bridge.ts:1362-1408` and the API type `ref/opencode-pr-65430/packages/plugin/src/effect/permission.ts`.
- [ ] On success, choose `allow_once` if offered. `ctx.permission.assert` returns only success/failure, not a persistence scope, so do **not** upgrade to `allow_always` just because it is offered. If only `allow_always` is offered, select it only after showing the user that the agent will remember the decision; otherwise respond `cancelled`.
- [ ] On failure/denial, choose `reject_once` if offered. If only `reject_always` is offered, select it only on an explicit persistent-denial choice; otherwise respond `cancelled`.
- [ ] `action` should be stable and namespaced, e.g. `antigravity.execute`, `antigravity.edit`, `antigravity.read`, `antigravity.other`. Include `tool`, `title`, `kind`, `locations`, and a bounded `rawInput` in metadata so the OpenCode permission UI can show the command/path.
- [ ] Show full commands/paths; escape control characters; cap lengths. Do not dump arbitrary raw JSON.
- [ ] If `ctx.permission.assert` is unavailable/headless and throws, deny with `reject_once`/`cancelled`; never fall back to allow.
- [ ] Do not auto-allow based on title/name/option name. A tool named `mcp_oc_*` is not trusted merely by name; if using an MCP relay, require an exact parked-call match.

### 7.3 Responses

Allow:

```json
{ "jsonrpc": "2.0", "id": 7, "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } } }
```

Reject:

```json
{ "jsonrpc": "2.0", "id": 7, "result": { "outcome": { "outcome": "selected", "optionId": "reject-once" } } }
```

Cancel/stale/timeout/no valid option:

```json
{ "jsonrpc": "2.0", "id": 7, "result": { "outcome": { "outcome": "cancelled" } } }
```

- [ ] Respond exactly once per request; guard with a `settled` flag.
- [ ] Use the exact `optionId` offered; never synthesize one.
- [ ] If no option matches the desired decision, use `cancelled` (not an arbitrary option).
- [ ] On `session/cancel`, immediately respond `cancelled` to every pending permission request; do not wait for the agent or for the user.
- [ ] On permission timeout (e.g. 5–10 minutes), respond `cancelled`; do not auto-allow.
- [ ] On process exit/close, respond `cancelled` to all pending requests before failing the turn.
- [ ] Do not reuse a permission response for another request; single-use only.
- [ ] Do not let a stale OpenCode tool result approve a later ACP request; match session, process generation, and request id.

### 7.4 Security notes

- ACP permission requests improve control; they are not an OS sandbox. The agent runs with the user's privileges and can execute native tools.
- `--dangerously-skip-permissions` auto-approves everything; never use by default. If exposed, require explicit opt-in and a visible warning; do not map it to "OpenCode permissions will still apply" because they will not.
- `auto`/`accept-edits` ACP modes may suppress permission requests; default to `default`.
- Do not include secrets from `rawInput` in logs; the permission UI may need the command, but logs should be redacted/bounded.
- Do not trust `title`/`option.name` as authorization; use `kind` + OpenCode evaluation + exact option id.

---

## 8. Cancellation, close, process lifecycle, concurrency, errors, quota

### 8.1 Cancellation

Client-initiated:

```json
{ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": "..." } }
```

- [ ] `session/cancel` is a notification, no response.
- [ ] On `AbortSignal`:
  1. mark the turn `aborting`; stop emitting normal updates
  2. respond `cancelled` to all pending permission requests
  3. send `session/cancel`
  4. wait for the original `session/prompt` to resolve with `stopReason: "cancelled"` (grace ~5 s)
  5. if it resolves, finish with `other`/`cancelled` (or let OpenCode's abort close the stream) and keep the process if healthy
  6. if it does not resolve, send `$/cancel_request` for the prompt request (SDK `cancellationSignal`) or close the session/process, then error `aborted`:

```json
{ "jsonrpc": "2.0", "method": "$/cancel_request", "params": { "requestId": 20 } }
```

  `$/cancel_request` cancels the JSON-RPC request; it is not a substitute for `session/cancel`. Prefer `session/cancel` first because ACP defines a semantic `cancelled` stop reason for it.
- [ ] Do not send a new prompt on the same ACP session until the cancelled prompt settles. If it never settles, replace the session/process.
- [ ] The spec says the client SHOULD preemptively mark non-finished tool calls as cancelled; in our mapping, emit exactly one `tool-result` per open call with `{status:"cancelled"}`, `isError:true`.
- [ ] Late updates after cancel: accept tool-call updates per spec, but do not emit text/reasoning after the abort boundary; ignore after terminal.

Agent-initiated `stopReason: "cancelled"` without a client abort:

- [ ] Finish normally with `other`/`cancelled`; no alarming error.
- [ ] Clear pending permissions and open tool calls with cancelled results.

### 8.2 Close and dispose

Order:

1. Stop accepting new turns for the session; mark it `closing` (not `closed`) so updates cannot mutate confirmed config.
2. If a prompt is active, send `session/cancel`; wait briefly.
3. Send `session/close` with a ~5 s timeout; treat `-32002` as success. Updates may arrive **before** the close result; buffer/discard them while `closing`.
4. After the close result, mark the session `closed`; ignore all subsequent updates.
5. If disposing the process: close stdin, `SIGTERM`, wait ~2 s, `SIGKILL`; kill the process group on POSIX.
6. Fail all pending requests/streams exactly once; clear timers/maps.

- [ ] `session/close` is idempotent; do not throw on a second close.
- [ ] The probe shows post-close updates; ignore them by session state, not by process state.
- [ ] On plugin finalizer (`Effect.addFinalizer`), dispose all sessions/processes; do not leave orphans.
- [ ] Use `detached: true` + `process.kill(-pid)` on POSIX if you need to kill grandchildren; test Windows separately.
- [ ] Do not use `SIGKILL` as the first signal; give the agent a chance to flush/cleanup.
- [ ] If the child exits on its own, reject pending with `agy acp exited (code=..., signal=...)` plus a redacted stderr tail.

### 8.3 Process lifecycle and stderr

- [ ] One child per process (shared sessions) or per session (isolation). Track `processGeneration` and session ownership.
- [ ] `spawn` error (`ENOENT`) → startup error with install/PATH guidance; do not retry in a loop.
- [ ] `exit`/`close` → mark process dead; reject all pending; fail active streams; cancel pending permissions.
- [ ] `stderr`:
  - always drain
  - bounded ring (16–32 KiB)
  - redact `Authorization`, `Bearer`, `api[_-]?key`, `token`, `oauth`, `cookie`, `GEMINI_API_KEY`, `x-goog-*`
  - include only the tail in user-visible startup/exit errors
  - never log full frames/prompts by default; opt-in frame capture must be 0600, size-capped, and sanitized
- [ ] `stdout`:
  - UTF-8 line decoder, handles partial lines and CRLF
  - 32 MiB max frame/partial line; reject oversized and fail the process generation
  - ignore malformed JSON lines with a bounded diagnostic (do not crash the router)
  - do not use a small `readline` limit
- [ ] If `agy` writes a log file (`--log-file`), do not enable it by default; it may contain prompts. If enabled for debugging, warn and redact.

### 8.4 Concurrency and backpressure

- [ ] Per-session mutex: only one `session/prompt` at a time.
- [ ] Per-session config mutex: serialize `set_config_option` with prompt start; do not change model/effort/mode while a prompt is streaming unless the user explicitly requests it (the spec allows it, but Antigravity's notifications are racy).
- [ ] Different sessions may run concurrently; ensure the update router keys by `sessionId` and never crosses streams.
- [ ] `doStream` may be called for title/compaction while a primary turn is active:
  - title: local, no ACP
  - compaction: separate ephemeral session or defer; never interleave two prompts on the same ACP session
- [ ] Bounded queue between notifications and the `ReadableStream` controller:
  - cap buffered parts (e.g. 16 MiB or 10k parts)
  - if exceeded, cancel the turn, send `session/cancel`, and error; do not drop text silently
- [ ] Guard all stream controller calls with `closed`/`cancelled` flags; late notifications must not throw.
- [ ] Exactly one terminal event per turn; use a `finalized` flag.

### 8.5 Error mapping

| Condition | Mapping | Recovery |
|---|---|---|
| `-32000` auth required | auth error | prompt login/authenticate; no retry |
| `-32002` unknown session | session expired | drop mapping; resume/new + handoff once; do not silently resend a potentially side-effecting prompt |
| `-32602` invalid params/config | configuration error | refresh catalog; fail turn; no retry same value |
| `-32601` method not found | unsupported feature | explicit fallback (e.g. set_mode); never guess from message text |
| `-32800` request cancelled | cancellation | finish cancelled; no error |
| `-32603` internal | service failure | surface with stderr tail; no automatic prompt retry |
| child exit/ENOENT | startup/process error | fail pending; reinstall/doctor guidance; no retry loop |
| malformed/oversized frame | protocol error | kill process generation; report versions; no retry |
| permission no valid option | permission error | deny/cancelled; report |
| quota/429 | quota/rate limit | fail fast; no retry/account rotation |
| 403/PERMISSION_DENIED | auth/model access | fail fast; distinguish from transient 429 |
| user abort | aborted | no alarming error; cleanup |

- [ ] Preserve JSON-RPC `code` and `data` in the error object; include a short correlation/request id.
- [ ] Redact prompts, tokens, headers, file contents, and full stderr from user-visible errors.
- [ ] Do not use `try/catch` to swallow protocol errors; log class + phase + durations + byte counts only.

### 8.6 Quota/429 fail-fast

Antigravity often reports upstream failures as **agent message text**, not JSON-RPC errors. The reference plugin detects:

```ts
const API_ERROR_ABORT_PATTERN =
  /API error \(attempt \d+\)|RESOURCE_EXHAUSTED|Individual quota reached|\(code 429\)|\(code 403\)|PERMISSION_DENIED/i
```

(`ref/opencode-antigravity-acp/src/history-sanitizer.ts:11-12`)

- [ ] Scan `agent_message_chunk` text for these patterns **before** emitting it as assistant text.
- [ ] On match:
  - do not emit the error text as normal assistant output (or emit a concise, sanitized status)
  - send `session/cancel` immediately
  - classify:
    - `429` / `RESOURCE_EXHAUSTED` / `quota` → `rate_limit` / `quota`; per-model pool; no account rotation
    - `403` / `PERMISSION_DENIED` → `auth` / `permission`; global; no retry
  - error the stream with `{ retryable: false, code: "quota"|"auth", resetAt? }`
- [ ] Do not auto-retry a prompt after a quota/429 error. Prompts may have side effects; retrying can double-execute tools.
- [ ] Optional: per-model-pool cooldown (Gemini vs Claude/GPT) as in `ref/opencode-antigravity-acp/src/session-bridge.ts:195-208`; surface remaining time. Do not block unrelated pools.
- [ ] Use `ctx.session.hook("retry", ...)` to force `retry: false` for quota/auth errors; do not rely on default retry behavior.
- [ ] Never switch models/accounts automatically on quota; require user action.
- [ ] If the agent itself falls back to another model via `config_option_update`, surface a warning; do not silently change the OpenCode selection.

---

## 9. OpenCode V2 plugin wiring (concrete)

### 9.1 Plugin skeleton

Reference: `ref/opencode-antigravity-acp/src/index.ts:41-190`.

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "antigravity-acp",
  effect: (ctx) =>
    Effect.gen(function* () {
      const bridge = new Bridge(ctx, ctx.location.directory)

      yield* Effect.addFinalizer(() => Effect.promise(() => bridge.disposeAll()))

      const cached = yield* Effect.promise(() => bridge.loadCachedCatalog())

      yield* ctx.provider.transform((editor) => {
        if (editor.get("antigravity-acp")) editor.remove("antigravity-acp")
        editor.add({
          info: {
            id: "antigravity-acp",
            name: "Antigravity (ACP)",
            activation: "enabled",
            package: "aisdk:antigravity-acp",
          },
          models: bridge.toModelInfos(cached),
        })
      })

      // Both hooks are required when the model package is "aisdk:..."
      yield* ctx.aisdk.hook(
        "sdk",
        (input) =>
          Effect.sync(() => {
            input.sdk = { languageModel: (id: string) => bridge.createLanguageModel(id) }
          }),
        { providerID: "antigravity-acp" },
      )

      yield* ctx.aisdk.hook(
        "language",
        (input) =>
          Effect.sync(() => {
            const id = String(input.model.modelID ?? input.model.id)
            input.language = bridge.createLanguageModel(id)
          }),
        { providerID: "antigravity-acp" },
      )

      yield* ctx.session.hook(
        "context",
        (input) =>
          Effect.sync(() => {
            if (input.model.providerID !== "antigravity-acp") return
            // Pure ACP: the agent has its own tools/instructions.
            input.system = []
            input.tools = {}
          }),
        { providerID: "antigravity-acp" },
      )

      yield* ctx.session.hook(
        "model.request",
        (input) =>
          Effect.sync(() => {
            input.headers["x-opencode-session-id"] = input.sessionID
            input.headers["x-opencode-antigravity-acp-variant"] = input.model.variant ?? ""
            input.headers["x-opencode-antigravity-acp-kind"] = input.kind
            input.headers["x-opencode-antigravity-acp-agent"] = input.agent
          }),
        { providerID: "antigravity-acp" },
      )

      yield* ctx.session.hook(
        "title",
        (input) =>
          Effect.sync(() => {
            if (input.result) return
            const text = firstUserText(input.messages)
            if (text) input.result = text.slice(0, 60)
          }),
        { providerID: "antigravity-acp" },
      )

      yield* ctx.session.hook(
        "retry",
        (input) =>
          Effect.sync(() => {
            // `input.error` is a SessionError.Error; use your own type guard/classification.
            // Hook shape: ref/opencode-pr-65430/packages/plugin/src/effect/session.ts:150-157.
            if (isAuthOrQuotaError(input.error)) {
              input.decision = { retry: false }
            }
          }),
        { providerID: "antigravity-acp" },
      )
    }),
})
```

- [ ] Use a namespaced provider id (`antigravity-acp`) to avoid colliding with a future built-in `antigravity` provider.
- [ ] `ctx.provider.transform` adds/updates the provider and model list; call `ctx.provider.reload()` after a catalog change (debounced).
- [ ] Both `ctx.aisdk.hook("sdk")` and `("language")` are required; reference `ref/opencode-antigravity-acp/src/index.ts:88-101`.
- [ ] `ctx.location.directory` is the workspace root; use the session's directory if available. Do not use `process.cwd()`.
- [ ] `input.system = []`, `input.tools = {}` for this provider only; do not mutate other providers.
- [ ] Title hook avoids a live ACP turn for auto-title; if it cannot derive a title, return and let OpenCode handle it.
- [ ] Retry hook must not swallow all transient errors; only quota/auth/protocol errors that must not loop.

### 9.2 `LanguageModelV3` skeleton

Reference: `ref/opencode-antigravity-acp/src/session-bridge.ts:1879-1915` and `ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/language-model/antigravity-language-model.ts:28-78`.

```ts
function createLanguageModel(modelID: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "antigravity-acp",
    modelId: modelID,
    supportedUrls: {},

    async doGenerate(options) {
      // Drain doStream; collect text/reasoning; optionally tool calls/results.
      // Return { content, finishReason, usage, warnings: [] }.
    },

    async doStream(options) {
      const headers = options.headers ?? {}
      const sessionID = headers["x-opencode-session-id"]
      if (!sessionID) throw new Error("Missing OpenCode session id")
      const variant = headers["x-opencode-antigravity-acp-variant"] || undefined
      const kind = headers["x-opencode-antigravity-acp-kind"] || "primary"
      // per-session queue; ensure ACP session; configure model/effort/mode;
      // send session/prompt; map updates; finish/usage.
      return { stream }
    },
  }
}
```

- [ ] `doGenerate` should drain the stream and return text + reasoning + (optionally) provider-executed tool calls/results, `finishReason`, `usage`, `warnings: []`. If a tool turn cannot be represented in `doGenerate`, throw a clear error rather than silently dropping tools.
- [ ] `doStream` should reject missing session id/variant context with an actionable error; do not share a default session.
- [ ] Handle `options.abortSignal`; combine with an internal controller; send `session/cancel` on abort.
- [ ] Do not use `options.temperature`, `topP`, `maxOutputTokens`, `responseFormat`, or `tools`; ACP has no per-request inference parameters in the 1.5.14 surface. Ignore with a warning if non-default.
- [ ] `supportedUrls: {}` because ACP image content is base64; normalize URLs yourself or reject.

### 9.3 Catalog and provider reload

- [ ] On plugin activation, register cached models immediately (no `agy` spawn).
- [ ] On first turn, start `agy`, initialize, create/resume session, refresh catalog, and `ctx.provider.reload()` if it changed.
- [ ] On `config_option_update`, update cached config and schedule a reload if model/variant set changed.
- [ ] On manual reload, clear the cached catalog, restart/reuse a probe session, and refresh.
- [ ] Keep a `catalogSignature` (ids/names/variants/limits) to avoid unnecessary reloads.
- [ ] If `agy` is missing/unauth, keep the provider registered with cached/empty models and a clear status; do not crash the OpenCode server.

---

## 10. Test matrix

### 10.1 No-prompt handshake/config tests (CI-safe, no quota)

These tests may spawn the real `agy acp` but must never call `session/prompt`. Use a temporary workspace and clean up sessions/processes.

| ID | Test | Setup / request | Assertions |
|---|---|---|---|
| M1 | Handshake minimal | `initialize {protocolVersion:1, clientCapabilities:{}}` | response v1; agentInfo 1.5.14; authMethods present; no crash |
| M2 | Handshake full posture | `initialize` with `fs:false`, `terminal:false`, `auth.terminal:false` | same capabilities; no terminal method; prompt image/embeddedContext true |
| M3 | Terminal auth probe | `initialize` with `auth.terminal:true` | record whether a `type:"terminal"` method appears; if yes, assert `args` includes `--login`, do not launch it |
| M4 | Session new | `session/new {cwd:abs, mcpServers:[]}` | sessionId non-empty; `configOptions` has model/thought_level/mode; `models.availableModels` ≈27; `currentModelId` effort-qualified |
| M5 | Catalog grouping | M4 response | 11 base models; neon/hydrogen have xhigh; carbon/argon/3.8/claude have low/medium/high; orchestrators/gpt-oss single; no invalid variant |
| M6 | Model matrix | for each `configOptions.model.options.value`, `set_config_option model` | result model.currentValue == requested; no error; record thought_level options/current |
| M7 | Effort matrix | on one model, set each offered thought_level value | result currentValue == requested; invalid value → `-32602`; options remain complete |
| M8 | Mode via config | `set_config_option {configId:"mode", value:"plan"}` | result mode.currentValue == plan; no stale notification overwrite; restore default |
| M9 | Legacy mode race | `set_mode {modeId:"plan"}` | result `{}`; observe late `current_mode_update`; verify plugin does not treat `{}` as confirmation; restore default |
| M10 | Qualified model id | `set_config_option model {value:"gemini-3.8-flash-low"}` | if accepted, model.currentValue == base and thought_level == low; record as non-spec; restore |
| M11 | Invalid config | unknown configId/value | error `-32602`; state unchanged; no prompt sent |
| M12 | Resume | create session; close process; respawn; initialize; `session/resume {sessionId,cwd,mcpServers:[]}` | response modes/configOptions; no `sessionId` required; no replay; no prompt |
| M13 | Resume unknown | `session/resume` with random id | `-32002`; plugin drops mapping; no crash |
| M14 | Load/replay | create session; if history exists, `session/load` | updates arrive before result; plugin suppresses replay; no model output; clear replay flag on error |
| M15 | Close/idempotent | `session/close` twice | first `{}`; second `{}` or `-32002`; post-close updates ignored |
| M16 | Additional dirs | `session/new` with abs temp dir | accepted; relative path → `-32602`; if capability absent, not sent |
| M17 | Notification ordering | capture updates during M6/M8 | result is applied last; stale notification does not revert state; retry-once logic works |
| M18 | Process exit/stderr | kill child during handshake/session | pending rejects; stderr tail present/redacted; no orphan (`ps`) |
| M19 | Framing | synthetic 32 MiB frame, >32 MiB frame, CRLF, partial line | 32 MiB accepted; >32 MiB rejected; partial reassembled; malformed ignored with diagnostic |
| M20 | Permission unit | synthetic `session/request_permission` with 2 and 4 options | allow/reject/cancel mapping; no first-option fallback; stale session cancelled; exactly one response |
| M21 | Usage unit | synthetic `usage_update` + prompt usage | zero setup ignored; finish usage fields correct; contextUsed/size attached |
| M22 | Quota unit | synthetic agent text with 429/RESOURCE_EXHAUSTED/403 | fail-fast; no retry; correct class; no raw secret text |
| M23 | Concurrency | two OpenCode sessions, two ACP sessions | separate queues; no cross-talk; no duplicate terminal events |

How to run the existing probes:

```bash
cd /data/projects/launcher/antigravity-adapter
node ref/notes/probe-agy-acp.mjs          # handshake + session/new
node ref/notes/probe-agy-acp-config.mjs   # set_config_option/set_mode/close
node ref/notes/probe-agy-acp-set-model.mjs # legacy set_model (reference only)
```

These probes log raw frames. Do not commit new probe output containing prompts, tokens, or workspace paths.

### 10.2 Optional live-prompt tests (manual, gated)

Gate with `ANTIGRAVITY_ACP_LIVE=1`; use a dedicated workspace and a knowingly expendable quota. Never run in default CI.

| ID | Test | Prompt/action | Assertions |
|---|---|---|---|
| L1 | Text prompt | "Reply with exactly: ok" | `stopReason: end_turn`; text chunks; usage or usage_update; no tool calls |
| L2 | Image | small PNG + "Describe this image briefly" | accepted if `promptCapabilities.image`; no protocol error; response text |
| L3 | Embedded resource | small text file as `resource` | accepted if embeddedContext; no error |
| L4 | Resource link | text file as `resource_link` | accepted baseline; agent can read it |
| L5 | Tool call | "Read /abs/workspace/a.txt and summarize" | exactly one `tool_call` and one terminal `tool_call_update`; one `tool-result`; no duplicate; providerExecuted true |
| L6 | Permission allow | mode default; ask to run `echo hi` | permission request arrives; respond allow_once; tool result success; no duplicate result |
| L7 | Permission reject | same, respond reject_once/cancelled | tool result/denial; command not executed; exactly one response |
| L8 | Cancel with pending permission | long command; abort while permission open | permission response `cancelled`; prompt `stopReason: cancelled`; process reusable |
| L9 | Cancel mid-stream | long generation; abort after first text | `session/cancel` sent; stopReason cancelled within grace; exactly one terminal event; next turn works |
| L10 | Resume live | turn 1; close process; resume; turn 2 "What did I say?" | context retained; no replay duplicated; config options present |
| L11 | Model switch | turn with model A+effort; next turn model B+effort | config set before prompt; result verified; no stale overwrite; response succeeds |
| L12 | Usage two turns | two prompts; inspect `usage` and `usage_update` | determine per-turn vs cumulative; finish usage correct; no double count; context size ≈1,048,576 |
| L13 | Plan/commands | ask for a multi-step plan | plan stored, not emitted as text; commands deduped; no fake tool calls |
| L14 | Close during prompt | start long prompt; `session/close` | prompt cancelled; close result; post-close updates ignored; no orphan |
| L15 | Quota path | only if a known quota-exhausted model is safe; otherwise skip | fail-fast, no retry loop; clear message; no account rotation |

### 10.3 Fixtures and harness

- [ ] Replay recorded frames from `ref/notes/agy-acp-handshake.log` / `agy-acp-config.log` into a fake transport to unit-test the parser, pending map, and update router without spawning `agy`.
- [ ] Add synthetic frames for: stale `config_option_update`, late `current_mode_update`, duplicate `available_commands_update`, `tool_call` completed at creation, `tool_call_update` before `tool_call`, unknown update type, post-close update.
- [ ] Add synthetic permission requests with 2, 3, and 4 options; missing `toolCall.title`; unknown option kind; duplicate option ids.
- [ ] Add synthetic usage sequences: one inference, multiple inferences, zero setup update, usage absent.
- [ ] Record for each fixture: CLI version, SDK version, OS, date, expected mapping. Do not include prompts/secrets.
- [ ] Use `bun test`/vitest with a real temp directory and a fake `agy` executable if needed; avoid global mocks. Reference the existing plugin's `test/plugin.test.ts` for patterns.

---

## 11. File reference index

Probe evidence:

- `ref/notes/agy-acp-handshake.log` — initialize, session/new, configOptions, tier.
- `ref/notes/agy-acp-config.log` — set_config_option model/effort, set_mode race, qualified id, commands, usage_update, close.
- `ref/notes/agy-acp-set-model.log` — legacy `session/set_model`, stale config updates.
- `ref/notes/agy-cli-info.txt` — `agy acp` flags (`--login`, `--process-per-session`, `--dangerously-skip-permissions`, `--sandbox`, `--log-file`).
- `ref/notes/probe-agy-acp.mjs`, `probe-agy-acp-config.mjs`, `probe-agy-acp-set-model.mjs` — minimal clients; no prompt.

ACP spec/docs:

- `ref/agent-client-protocol/docs/protocol/v1/initialization.mdx` — client capabilities, auth.terminal, prompt capabilities.
- `ref/agent-client-protocol/docs/protocol/v1/authentication.mdx` — agent vs terminal methods, authenticate/logout, launch safety.
- `ref/agent-client-protocol/docs/protocol/v1/session-setup.mdx` — new/load/resume/close, cwd, additionalDirectories, mcpServers, systemPrompt.
- `ref/agent-client-protocol/docs/protocol/v1/session-config-options.mdx` — configOptions, per-model dependent changes, set_config_option.
- `ref/agent-client-protocol/docs/protocol/v1/prompt-turn.mdx` — prompt, updates, usage_update, stop reasons, cancellation.
- `ref/agent-client-protocol/docs/protocol/v1/tool-calls.mdx` — tool call status/content/permission.
- `ref/agent-client-protocol/docs/protocol/v1/cancellation.mdx` — `$/cancel_request` vs `session/cancel`.
- `ref/agent-client-protocol/docs/protocol/v1/error.mdx` — error codes, unknown sessions.
- `ref/agent-client-protocol/docs/protocol/v1/agent-plan.mdx` — plan/plan_update/plan_removed.
- `ref/agent-client-protocol/docs/protocol/v1/slash-commands.mdx` — available_commands_update.
- `ref/agent-client-protocol/docs/protocol/v2/migration.mdx` — v2 preview differences; why to pin v1.
- `ref/agent-client-protocol/docs/rfds/updates.mdx:434` — `session/set_model` removed from protocol artifacts.

TypeScript SDK 2.9.1:

- `ref/typescript-sdk/src/v1/schema/types.gen.ts` — stable v1 types: `InitializeRequest` :3734, `ClientCapabilities` :3769, `InitializeResponse` :1505, `AuthMethod` :1936, `NewSessionRequest` :4129, `NewSessionResponse` :2094, `ResumeSessionRequest` :4451, `LoadSessionRequest` :4351, `SetSessionConfigOptionRequest` :4548, `PromptRequest` :4590, `PromptResponse` :2526, `SessionUpdate` :2657, `ToolCall` :2756, `ToolCallUpdate` :164, `RequestPermissionRequest` :131, `PermissionOption` :688, `UsageUpdate` :3172, `ConfigOptionUpdate` :3100, `CurrentModeUpdate` :3080, `AvailableCommandsUpdate` :3058, `Plan` :2865.
- `ref/typescript-sdk/src/v1/unstable/schema/types.gen.ts:3371-3440` — `PromptResponse.usage`, `Usage`.
- `ref/typescript-sdk/src/v1/bindings.ts` — app API: `buildSession` :337, `ActiveSession` :738, `prompt` :804, `nextUpdate` :835, `setSessionConfigOption` :1153.
- `ref/typescript-sdk/src/examples/client.ts:122-165` — `client(...).onRequest(...).connectWith(...)`, `buildSession`, `nextUpdate`.
- `ref/typescript-sdk/src/core/stream-limits.ts:1` — 32 MiB default max message.
- `ref/typescript-sdk/MIGRATION_STABLE_UNSTABLE.md` — `/unstable` vs stable; `PromptResponse.usage` requires `/unstable`.

OpenCode V2 reference implementation:

- `ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/antigravity/acp.ts` — spawn, initialize :163-172, newSession :189-192, resume :195-198, prompt :206-245, permission :283-293, update mapping :305-327.
- `ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/antigravity/catalog.ts` — name-based grouping :44-61, model mapping :70-84, slug resolution :93-99.
- `ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/language-model/antigravity-language-model.ts` — LanguageModelV3 :28-78, render :107-134, usage :137-150.
- `ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/antigravity/session.ts` — single-session design (do not copy).
- `ref/opencode-pr-65430/packages/plugin/src/effect/provider.ts` — `ProviderEditor` / `transform`.
- `ref/opencode-pr-65430/packages/plugin/src/effect/aisdk.ts` — `sdk`/`language` hooks.
- `ref/opencode-pr-65430/packages/plugin/src/effect/permission.ts` — `ctx.permission.assert`.
- `ref/opencode-pr-65430/packages/cli/src/acp/translate.ts` — OpenCode as ACP server: per-turn usage :165-183, tool status translation :349-440, stop reasons :521-528.

Closest production plugin:

- `ref/opencode-antigravity-acp/src/index.ts` — provider registration :12-37, transform :67-86, aisdk hooks :88-101, context hook :107-121, model.request :125-135, title :137-149.
- `ref/opencode-antigravity-acp/src/session-bridge.ts` — usage mapping :244-266, permission :1362-1408, update mapping :1605-1810, finalize :1812-1845, LanguageModelV3 :1879-1915, headers :1916-1925.
- `ref/opencode-antigravity-acp/src/acp-client.ts` — raw RPC :604-624, initialize :626-640, newSession :641-647, resume :650-660, setModel :662-664, setMode :666-668, setConfigOption :670-672, authenticate :679-710, prompt :712-714, cancel :716-720, close :743, server-request fallback :562-582.
- `ref/opencode-antigravity-acp/src/history-sanitizer.ts:11-12` — quota/API error regex.

Pi edge-case references:

- `ref/pi-antigravity-acp-provider/docs/PROTOCOL-MAPPING.md` — handshake :7-24, session :28-56, content :58-86, updates :96-148, permission :150-204, usage/stop :206-234, cancellation :260-280, error classification :282-297.
- `ref/pi-antigravity-acp-provider/docs/AUTH-PERMISSIONS-SECURITY.md` — credential model :20-31, login flow :49-74, permission broker :79-125, subprocess hardening :143-156, logging :185-197.

---

## 12. Open questions to resolve by probe/test

These are not blockers, but the implementation must not guess:

1. Does `initialize` with `auth.terminal: true` make 1.5.14 advertise a `type:"terminal"` method, and what are its `args`/`env`?
2. Does `session/set_config_option {configId:"mode"}` work on 1.5.14? If yes, use it; if not, the `set_mode` race must be handled as in 3.5.
3. Does `session/resume` return `models` or `sessionId` on 1.5.14? The spec says no; the PR's parser treats `models` as optional. Build the catalog cache accordingly.
4. What exactly does `authenticate {methodId:"oauth-personal"}` do in a headless server: open a browser, print a URL, or hang? Add a cancellable login command.
5. What permission option ids/names/kinds does 1.5.14 actually send? The probe sent no prompt, so this is unknown; test with a read-only command first.
6. Is `PromptResponse.usage` per-turn aggregate or cumulative across turns on 1.5.14? Test two prompts and compare; default to per-turn, add a cumulative mode if needed.
7. Does 1.5.14 support HTTP/SSE MCP despite not advertising `mcpCapabilities`? Test with a loopback MCP server before promising OpenCode tools.
8. Does `session/load` replay tool calls/plans/usage, and how long does it take? Test only with a disposable session.
9. Are `additionalDirectories` relative paths rejected with `-32602`? Test.
10. Can `session/close` be called while a prompt is active, and does it always settle the prompt? Test; have a kill fallback.

---

## 13. Minimal “definition of done” for Phase 1

- [ ] `agy acp --stdio` starts, initializes v1, and validates agent 1.5.14.
- [ ] Auth: ambient login works; `-32000` produces an actionable login flow; terminal auth is supported only when advertised/TTY-capable.
- [ ] Catalog: 11 base models, correct per-model variants, context limit, image capability.
- [ ] `session/new`, `session/resume`, `session/load` (suppressed replay), `session/close` implemented with timeouts and idempotency.
- [ ] Model/effort/mode applied via `set_config_option`, verified from results, clamped per model; no `set_model` dependency.
- [ ] Text/image/resource prompt mapping with capability checks and size limits; warm sessions send only the current user turn.
- [ ] `session/update` mapping covers message/thought/tool_call/tool_call_update/usage/current_mode/config/commands/plan; exactly one tool-result per terminal call.
- [ ] Permission requests map to `ctx.permission.assert`; default deny; cancel/stale/timeout respond cancelled; no first-option auto-allow.
- [ ] Cancellation sends `session/cancel`, answers pending permissions, waits/forces settlement, and leaves the process usable or cleanly replaced.
- [ ] Process lifecycle: bounded stderr, 32 MiB framing, no orphans, single terminal event per turn, per-session concurrency safety.
- [ ] Quota/429 fail-fast; no retry loops; no automatic account/model rotation.
- [ ] No-prompt test matrix passes in CI; live prompt tests pass manually with a gated account.
- [ ] No secrets, prompts, or raw frames in logs or storage.
