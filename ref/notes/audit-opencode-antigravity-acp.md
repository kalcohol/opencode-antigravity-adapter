# Audit: `opencode-antigravity-acp` v0.2.0 (system1970)

Audit date: 2026-11-22  
Target: `ref/opencode-antigravity-acp` (MIT, v0.2.0, single commit `58ec40b`)  
Environment: OpenCode 2.3.2, `@opencode/plugin` 2.3.2, `effect` 4.1.0, `agy` 1.5.14  
Method: read-only source audit, comparison with `ref/opencode-antigrvity` v0.6.5 and
`ref/pi-antigravity-acp-provider`, plus local ACP probes against the installed `agy`.
No plugin was installed and no OpenCode/agy configuration file was changed. The probes
created and closed ACP sessions; one tiny prompt was sent to verify MCP tool naming and
usage fields (it consumed a small amount of quota).

**Verdict:** this is the best available *prototype* to fork for an OpenCode 2.3.2 plugin, but it is
not production-ready. Its OpenCode integration, thin-ACP posture, model/effort catalog, resume
handling, MCP relay, and GUI are substantial assets. Its default Auto mode auto-approves
Antigravity-native tools outside OpenCode's permission system, its usage accounting is wrong for
`agy` 1.5.14, and it does not implement compaction/generate request handling. Treat it as a
fork-and-harden base, not as a drop-in dependency.

---

## 1. Architecture map

### 1.1 Entrypoints and package

| Piece | Location | Notes |
|---|---|---|
| Server plugin | `src/index.ts:53` | `Plugin.define({ id: "antigravity-acp", effect })` |
| Provider id | `src/history-sanitizer.ts:7` | `antigravity-acp`; deliberately distinct from OpenCode's built-in `antigravity` provider |
| AISDK package | `src/index.ts:76` | `aisdk:antigravity-acp`; both `sdk` and `language` hooks are registered |
| GUI bundle | `package.json:28`, `src/gui.tsx` | `./gui-experimental` → `dist/gui-experimental.cjs`; SolidJS + `@opencode/plugin/gui` |
| RPC definition | `src/rpc.ts:59` | `Rpc.define({ id: "antigravity-acp", methods: ... })` |
| ACP transport | `src/acp-client.ts:443` | raw NDJSON JSON-RPC, no ACP SDK |
| Session bridge | `src/session-bridge.ts:322` | one bridge session per OpenCode session |
| MCP relay | `src/mcp-relay.ts:41` | loopback HTTP MCP server, optionally attached as `oc` |
| History policy | `src/history-sanitizer.ts` | thin prompt, text-only handoff, cross-provider sanitization |

The package exports TypeScript source (`"exports": { ".": "./src/index.ts" }`). OpenCode's Bun
runtime can load it directly; `@opencode/plugin` and `effect` are host-provided runtime modules.
The GUI is a prebuilt CommonJS bundle.

### 1.2 Provider registration

`src/index.ts:67-80` removes and re-adds the provider on every transform:

```ts
info: {
  id: "antigravity-acp",
  name: "Antigravity (ACP)",
  activation: "enabled",
  package: "aisdk:antigravity-acp",
}
models: buildModelEntries(bridge.getModels())
```

`buildModelEntries` (`src/index.ts:12-36`) emits OpenCode `Model.Info`-shaped objects:

- `id`/`modelID`: base model id, e.g. `gemini-4-neon`
- `family`: base id, so effort variants are grouped under one picker row
- `variants`: `{ id: "low" | "medium" | "high" | "xhigh" }`, no per-variant settings
- `capabilities`: `tools: true`, text + image input, text output
- `limit`: hardcoded `context: 1_048_576`, `output: 65_536`
- `cost: []`, `status: "active"`, `enabled: true`, `time.released: 0`
- an extra `package` field per model that is not part of `Model.Info` (harmless at runtime but redundant)

`activation: "enabled"` means the provider is always listed, even if `agy` is missing or
unauthenticated. A stale fallback catalog is then shown (`FALLBACK_MODELS`), and the first turn
fails or falls back to a different model.

### 1.3 AISDK hooks

`src/index.ts:83-102` registers both required hooks:

- `sdk`: returns `{ languageModel: (id) => bridge.createLanguageModel(id) }`
- `language`: returns `bridge.createLanguageModel(modelID)`

`SessionBridgeManager.createLanguageModel` (`src/session-bridge.ts:1879-2309`) implements
`LanguageModelV3`:

- `doGenerate` drains `doStream` and returns reasoning/text content.
- `doStream` reads `x-opencode-session-id`, `x-opencode-variant`, and implicitly relies on
  `x-opencode-request-kind` being set by the `model.request` hook, but never reads the kind.
- One `ActiveTurn` per bridge session; ACP `session/prompt` is started from the stream's `start`
  callback, and ACP updates are translated into AI SDK V3 stream parts.
- Tool-call continuation uses a second `doStream` call: `dispatchedCallIds` matches OpenCode's
  tool results, resolves the parked HTTP MCP call, and continues the same turn.

The `model.request` hook (`src/index.ts:126-136`) is the side channel that carries session id,
request kind, agent, and variant into `doStream` as headers. This works on OpenCode 2.3.2 but is
fragile: if the hook is skipped or headers are dropped, `doStream` silently falls back to the
shared `__default__` session (`src/session-bridge.ts:1925-1928`), which would mix histories.

### 1.4 Session context hook

`src/index.ts:108-123` runs for every provider:

```ts
if (input.model.providerID === "antigravity-acp") {
  sanitizeForAcpModel(input.messages)
  bridge.updateContextSnapshot(input.sessionID, {
    systemText: "",
    agent: input.agent,
    tools: input.tools,
  })
  input.system = []
  input.tools = {}
} else {
  sanitizeForNonAcpModel(input.messages)
}
```

Consequences:

- The ACP model receives **no** OpenCode system prompt and **no** OpenCode tool schemas.
  Antigravity uses its own agent instructions and native tools.
- The live OpenCode tool catalog is snapshotted **before** it is cleared, for the optional Code
  Mode MCP relay.
- For every non-ACP request, ACP provider-executed tool calls/results are rewritten to text so
  Anthropic/OpenAI serializers do not reject `acp_*` tools. This mutates shared history in place.
- The hook is unscoped; it runs for all providers, not just the ACP provider.

`src/index.ts:139-148` also registers a `title` hook that derives a title from the first user
message, avoiding a quota-consuming ACP title turn.

### 1.5 ACP spawn and transport

`AcpProcess` (`src/acp-client.ts:443-766`):

- Binary resolution: `AGY_BIN`, then `PATH`, then common install paths
  (`~/.local/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, `/opt/Antigravity/bin/agy`,
  `/usr/bin/agy`) at `src/acp-client.ts:30-67`.
- Spawn args: `["acp", "--stdio", "--process-per-session"]`, plus optional
  `--dangerously-skip-permissions` and repeated `--add-dir` (`src/acp-client.ts:452-459`).
  The bridge always passes `dangerouslySkipPermissions: false`; `extraDirs` is never populated.
- Spawn: inherited env minus selected Google keys, `cwd`, `stdio: ["pipe","pipe","pipe"]`
  (`src/acp-client.ts:461-466`).
- NDJSON: `StringDecoder` + newline split; no frame-size cap (`src/acp-client.ts:468-476`).
- Pending map by numeric id; per-request optional timeout; server requests handled only for
  `session/request_permission`; other client methods return `-32601`
  (`src/acp-client.ts:520-584`).
- Methods: `initialize`, `session/new`, `session/resume`, `session/set_model`,
  `session/set_mode`, `session/set_config_option`, `authenticate`, `session/prompt`,
  `session/cancel`, `session/close` (`src/acp-client.ts:626-744`).
- `session/prompt` is sent with **no timeout** (`src/acp-client.ts:711-713`); a hung turn hangs
  the OpenCode request until the user aborts.

### 1.6 Auth

`resolveAcpAuthMethod` (`src/acp-client.ts:393-400`):

1. `ANTIGRAVITY_ACP_AUTH_METHOD` if one of `oauth-personal`, `oauth-business`, `gemini-api-key`,
   `agent-platform`
2. `GEMINI_API_KEY` → `gemini-api-key`
3. default `oauth-personal`

`buildAgySpawnEnv` (`src/acp-client.ts:422-441`) scrubs `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and
`GOOGLE_APPLICATION_CREDENTIALS` only for OAuth methods; keeps them for API-key/agent-platform.

`AcpProcess.authenticate` (`src/acp-client.ts:682-708`) calls `authenticate({ methodId })` after
`initialize` on every new process, with a **10 second** timeout. It treats "method not found /
unsupported" and "already authenticated/logged in/signed in" as success; everything else throws.
`apiKey` support sends `_meta.apiKey` (`:697-700`), which is not the documented field; no caller
uses it.

The plugin never reads or copies OAuth tokens. That is its strongest security property.

### 1.7 Catalog discovery

`discoverAcpModels` (`src/acp-client.ts:768-784`) starts a process, initializes, creates a
session with `mcpServers: []`, builds the catalog, closes the session, and disposes.

`buildModelCatalog` (`src/acp-client.ts:240-325`):

- Base models come from `sessionResult.configOptions[id="model"].options` (11 base ids on 1.5.14).
- Effort levels come from `configOptions[id="thought_level"].options` (low/medium/high/xhigh).
- Effort-qualified ids come from `models.availableModels` (27 ids on 1.5.14).
- Variants are matched as `${base}-${level}`; unmatched available ids become additional variants
  or standalone models.
- `defaultAcpModelId` prefers the bare base id, then `medium`, then `high`, then the first variant.
- `FALLBACK_MODELS` (`src/acp-client.ts:144-234`) is a hardcoded 9-family / 23-target list. It
  does **not** include `gemini-4-carbon`, `gemini-pro-orchestrator-argon`, or the actual
  `gemini-pro-orchestrator` Carbon id. If discovery fails, the picker exposes models the account
  may not have.

Catalog caching (`src/session-bridge.ts:166-169`, `388-473`):

- `antigravity-acp:model-catalog:v1` in plugin storage; 6h TTL.
- `sharedCatalog` / `sharedCatalogUpdatedAt` / `sharedDiscoveryPromise` are **module globals**,
  not scoped by account, auth method, executable, or workspace.
- `loadCachedModels` accepts any non-empty array matching a shallow shape; no account scope.
- `refreshModels` de-duplicates concurrent discovery and persists the result.

### 1.8 Model and effort selection

`resolveAcpModelTarget` (`src/acp-client.ts:327-355`) maps OpenCode `(base, variant)` to the ACP
model id:

- If the base is known and the variant exists: use the variant's `acpModelId`.
- If the variant is missing: use `defaultAcpModelId`.
- If the base is unknown: use `baseModelId` or `${baseModelId}-${variant}`.

`doStream` (`src/session-bridge.ts:2124-2142`) calls `session/set_model` with the combined id
(e.g. `gemini-4-neon-high`). If that throws, it falls back to
`session/set_config_option("model", base)` then `set_config_option("thought_level", level)`.
It caches `s.lastModelId` even if both operations failed, so the next turn will not retry.

Live probe: `session/set_model {"modelId":"claude-sonnet-5-5-high"}` returned `{}`; a later
`config_option_update` (after the next request) showed `model=claude-sonnet-5-5`,
`thought_level=high`. `set_config_option("model","gemini-4-neon")` then showed
`model=gemini-4-neon`, `thought_level=high`. The notification is deferred/stale, so the result
is the only reliable confirmation. The legacy method works on 1.5.14, but it is removed from
current ACP artifacts and should not be the primary path.

### 1.9 Modes and permissions

Local mode type: `"auto" | "accept-edits" | "default" | "plan"` (`src/rpc.ts:3`).
`getOrCreateSession` defaults to `mode: "auto"` (`src/session-bridge.ts:575-583`).
`ensureAcpSession` applies the mode with `session/set_mode` only when it is not `"default"`
(`src/session-bridge.ts:1266-1269`). Modes are **not persisted**; after an OpenCode restart or a
new bridge instance, a user's Ask/Plan choice becomes Auto again.

Permission handling (`src/session-bridge.ts:1352-1413`):

1. Choose `allowOpt` = first `allow_once` / `allow_always` / option id containing "allow",
   otherwise `opts[0]`.
2. If the tool name starts with `mcp_oc_`, immediately select `allowOpt` (OpenCode is expected to
   enforce permissions when it executes the relayed tool).
3. If local mode is `"auto"`, immediately select `allowOpt`.
4. Otherwise call `ctx.permission.assert({ sessionID, agent, action: "antigravity.<kind>",
   resources, metadata })`; on success select `allowOpt`, on failure select `denyOpt` or cancel.

The GUI (`src/gui.tsx:26-46`) labels Auto as "Approves edits and shell commands automatically",
Accept edits as "Approves file edits; prompts before shell commands", Ask as "Prompts before file
edits and shell commands", and Plan as "Creates a plan before executing changes".

### 1.10 Session lifecycle, resume, warm pool

- Mapping: OpenCode `sessionID` → ACP `sessionId` in
  `antigravity-acp:session:<sessionID>` storage (`src/session-bridge.ts:166`, `1041-1062`).
- `ensureAcpSession` (`src/session-bridge.ts:1064-1314`) serializes starts with `startLock`,
  waits for `resetLock`, reads the stored ACP id, tries `session/resume`, falls back to
  `session/new`, applies model/mode, and persists the new id.
- `resetSession` (`src/session-bridge.ts:833-894`) increments `startGeneration`, interrupts,
  closes the ACP session, disposes the process, and removes storage.
- Warm pool: `MAX_IDLE_WARMED_SESSIONS = 2` (`:176`); `warmSession` pre-starts a session or a
  spare process; LRU eviction disposes only the process and preserves the stored ACP id
  (`:732-776`).
- Circuit breakers: global plus `claude-gpt` / `gemini` / `other` pools, 60s persisted cooldown
  (`src/session-bridge.ts:178-208`, `540-571`).
- `session.deleted`, `session.execution.interrupted`, and `session.execution.failed` events
  interrupt/reset the bridge (`src/index.ts:193-220`).

### 1.11 MCP relay / Code Mode

`McpRelayServer` (`src/mcp-relay.ts:41-305`):

- Binds `127.0.0.1:0`; per-plugin random 24-byte bearer token.
- URL: `http://127.0.0.1:<port>/mcp/<url-encoded-openCode-sessionID>`.
- `initialize` echoes `protocolVersion`, advertises `tools.listChanged = true`.
- `tools/list` builds descriptors from `SessionContextSnapshot.mcpDescriptors`, strips
  `tools.opencode.*` / `session_move` lines from descriptions, normalizes `type: "object"`.
- `tools/call` parks the call in `PendingMcpCall`; `handleIncomingMcpCall`
  (`src/session-bridge.ts:1415-1459`) emits a normal OpenCode `tool-call`
  (`providerExecuted: false`) and waits for OpenCode's tool result on a continuation
  `doStream`.
- `tryFlushToolCalls` (`src/session-bridge.ts:1469-1521`) emits tool-call parts + `finish`
  with `finishReason: "tool-calls"` and closes the stream. The next `doStream` resolves the parked
  HTTP call from `extractToolResultsFromPrompt`.
- `NATIVE_SHADOWED_TOOLS` (`src/session-bridge.ts:57-69`) excludes `read`, `write`, `edit`,
  `multiedit`, `apply_patch`, `bash`, `shell`, `grep`, `glob`, `ls`, `list` from the relay, so
  those remain Antigravity-native tools.
- Code Mode is toggled by `setCodeMode`, which resets the ACP session to force a fresh
  `tools/list` (`src/session-bridge.ts:815-831`). The relay is started lazily on first Code Mode
  session (`:1131-1135`), but is **not stopped** when the last Code Mode session turns off.

Live probe: with a relay attached via `session/resume`, `agy` 1.5.14 sent `server/discover`,
`initialize` (MCP protocol `2025-11-25`), and `tools/list`; a prompt then called the relayed tool
as `mcp_oc_oc_read` and `tools/call` reached the relay successfully. HTTP MCP works on 1.5.14
despite `mcpCapabilities` being absent from the ACP initialize response.

### 1.12 GUI and RPC

`AcpRpc` (`src/rpc.ts:59-121`) exposes `getState`, `setMode`, `setCodeMode`, `resetSession`,
`warmSession`, `reloadModels`. The GUI (`src/gui.tsx`) uses:

- `ComposerPill` with status dot, mode grid, Pure ACP / + Code Mode toggle, model count,
  cooldown, last error.
- `Command` slash commands `/agy-reset` and `/agy-reload`.
- `ctx.client.rpc(AcpRpc)` with per-session generation tracking and starting-state polling.
- Pre-warm on model selection (`warmSession`).

`onStateChanged` is `undefined` in `src/index.ts:57`; the GUI relies on RPC polling and returned
state, so process exits/cooldowns can look stale until the next call.

### 1.13 Cross-model handoff

`buildThinAcpPromptBlocks` (`src/history-sanitizer.ts:431-466`) sends only the latest human
message text + image attachments. `buildTextOnlyHandoffPromptBlocks` (`:566-645`) sends only
`[Historical user]` / `[Historical assistant]` text, capped at 16k, followed by the latest prompt.
`hasUnseenNonAcpAssistantHistory` (`:517-537`) detects a switch away from ACP and back, triggering
`resetSession` + text handoff. Local status/cooldown replies are marked `localStatus` and skipped.
`sanitizeForNonAcpModel` rewrites ACP provider-executed tool calls/results to text when switching
to a normal model.

---

## 2. Compatibility with OpenCode 2.3.2 and `agy` 1.5.14

### 2.1 OpenCode plugin API — verified surface

The following APIs used by the plugin exist in `@opencode/plugin` 2.3.2:

- `Plugin.define` (`@opencode/plugin/effect`)
- `ctx.provider.transform` / `ctx.provider.reload`
- `ctx.aisdk.hook("sdk" | "language")`
- `ctx.session.hook("context" | "model.request" | "title")`
- `ctx.session.get` / `ctx.session.update`
- `ctx.permission.assert`
- `ctx.rpc.register` and `Rpc.define` (`@opencode/plugin/rpc`)
- `ctx.storage.get/set/remove`
- `ctx.event.subscribe({ types })`
- GUI `Plugin.define({ setup })`, `ComposerPill`, `Command`, `Style`
- GUI bundle module allowlist includes `@opencode/plugin/rpc` and `solid-js`

`SessionContext.system` and `.tools` are mutable in 2.3.2, so `input.system = []` /
`input.tools = {}` compiles and works. `SessionTitle.result` exists. `AcpRpc`'s JSON schemas match
the RPC API. `dist/gui-experimental.cjs` appears in sync with `src/gui.tsx` (same feature strings).

Risks:

- **Header side channel.** `doStream` depends on headers set by `model.request`. If OpenCode
  changes hook ordering or header propagation, the `__default__` fallback silently mixes sessions.
  Missing session id should be a hard error.
- **`request.kind` ignored.** The hook sets `x-opencode-request-kind` (`src/index.ts:131`), but
  `doStream` reads only session and variant (`src/session-bridge.ts:1925-1928`). Compaction and
  `generate` requests therefore run as full ACP turns on the main session.
- **GUI is experimental.** `@opencode/plugin/gui` is explicitly experimental; the package pins
  `^2.3.2` but a 2.4 GUI change can break the prebuilt bundle. The server/plugin API is more stable.
- **`activation: "enabled"`** lists the provider even when `agy` is missing/unauthenticated, with
  fallback models. OpenCode has no health signal before the first turn.
- **Duplicate provider.** OpenCode 2.3.2 ships a built-in `antigravity` provider
  (`ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/provider.ts:8-47`).
  `antigravity-acp` is a distinct id, so no collision, but users see two Antigravity entries. The
  built-in one has one session per directory, no model switching, no resume, no permission handler
  (it denies all native requests), and no GUI. The third-party plugin adds real value, but should
  explain the difference in its install docs.

### 2.2 `agy` 1.5.14 — live protocol evidence

Handshake (`ref/notes/agy-acp-handshake.log:2`, re-checked):

- `protocolVersion: 1`
- `agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" }`
- `loadSession: true`, `promptCapabilities: { image: true, audio: false, embeddedContext: true }`
- `sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} }`
- `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`
- `session/new`: 27 effort-qualified `availableModels`, `currentModelId: "gemini-4-neon-high"`,
  11 base `configOptions.model` values, `thought_level` low/medium/high/xhigh, modes
  default/accept-edits/auto/plan.

Live checks run for this audit:

| Check | Result |
|---|---|
| `authenticate({methodId:"oauth-personal"})` when already signed in | returns in ~2.3s with tier metadata; no browser observed |
| `session/set_model` with `claude-sonnet-5-5-high` | accepted `{}`; later config update shows model/effort applied |
| `set_config_option("model","gemini-4-neon")` | accepted; result shows base model + current effort |
| `session/resume` with extra `mcpServers` | accepted; relay received `server/discover`, `initialize`, `tools/list` |
| MCP tool call naming | `mcp_oc_oc_read`, title `Run mcp_oc_oc_read`; relay `tools/call` received `oc_read` |
| Prompt usage | `inputTokens: 11212`, `cachedReadTokens: 6884`, `outputTokens: 162`, `thoughtTokens: 110`, `totalTokens: 18258` |
| HTTP MCP despite absent `mcpCapabilities` | works on 1.5.14; `session/resume` attaches the relay |

### 2.3 ACP spec drift

| Issue | Evidence | Impact |
|---|---|---|
| `session/set_model` is not in ACP v1 artifacts | `ref/agent-client-protocol/schema/v1/meta.json` lists only `session/set_mode` / `session/set_config_option`; RFD removed the never-stabilized API | Works on 1.5.14, but it is a legacy extension. Use `set_config_option` as primary. |
| `session/resume` request has no `mcpServers` field | ACP v1 `ResumeSessionRequest` has `sessionId`, `cwd`, `additionalDirectories`, `_meta` | `agy` 1.5.14 accepts and uses it, but future agents may reject/ignore; `session/load` is the documented way to reattach MCP servers. |
| `initialize.clientCapabilities` is `{}` | `src/acp-client.ts:630-634` | No explicit `fs`/`terminal`/`auth.terminal` posture; terminal auth method is never offered. `agy` works, but this is below the Pi checklist baseline. |
| Initialize response is not validated | `src/acp-client.ts:626-636` | Protocol version, agent version, `loadSession`, image capability, `authMethods`, and MCP capability are ignored. A v2 or enterprise server would be spoken to as v1. |
| Auth methods hardcoded | `src/acp-client.ts:381-400` | Works on 1.5.14, but a new method id or `terminal` method is unsupported. `terminal-login` / `agy acp --login` is not handled. |
| `authenticate` timeout 10s | `src/acp-client.ts:702` | OAuth/browser login can exceed 10s. First-time login may fail; already-signed-in returns quickly. |
| `apiKey` `_meta` field | `src/acp-client.ts:697-700` | Uses `_meta.apiKey`, not a documented field; unused by callers. |
| `session/set_mode` primary | `src/session-bridge.ts:1266-1269`, `800-812` | Works, but ACP recommends `set_config_option("mode")`; `set_mode` returns `{}` without confirmation and notifications can be stale. |
| `usage` net vs gross | live probe + Pi `PROTOCOL-MAPPING.md:223-232` | ACP 1.5 reports net input (excluding cache) and output inclusive of thoughts. The code assumes gross input. |

### 2.4 Package and runtime resolution

- `peerDependencies`: `@opencode/plugin ^2.3.2`, `effect ^4.1.0`. OpenCode's runtime loader
  supplies both for local and npm plugins (`packages/plugin/src/runtime-modules.ts`), so the
  missing peer install is usually fine.
- Server entry is TypeScript (`./src/index.ts`). OpenCode 2.3.x runs on Bun and can import it; a
  Node-only host would fail on the `.js` → `.ts` specifiers.
- `@ai-sdk/provider` is type-only and erased; no runtime dependency.
- `dist/gui-experimental.cjs` is included and loaded by the desktop app; package `files` includes
  `src`, `dist`, README, LICENSE.
- `@opencode/plugin` is both a dev dependency (2.3.2) and a peer; the package does not vendor a
  copy. This is correct for a host-provided plugin API.
- No runtime downloads, no native modules, no `koffi`. Supply-chain surface is small compared to
  `opencode-antigrvity`.

### 2.5 Behavioral gaps

1. **Compaction / generate.** `title` is handled locally, but `compaction` and `generate` are not.
   OpenCode sends them with `kind: "compaction"` / `"generate"`; `doStream` ignores the kind and
   prompts the main ACP session. Compaction can burn a full ACP turn, interleave with a live
   prompt, and produce a summary from the wrong prompt shape. `generate` (structured output) has
   the same problem. `src/session-bridge.ts:1925-1928`; `src/index.ts:131`.
2. **OpenCode agent/instructions lost.** `input.system = []` and `input.tools = {}` mean the
   selected OpenCode agent (build/plan/custom), AGENTS.md-derived instructions, skills, and
   OpenCode tool definitions never reach Antigravity. The agent field is stored only for
   `permission.assert` (`src/index.ts:112-118`, `src/session-bridge.ts:1393-1403`). `x-opencode-agent`
   is set but never used to pass `--agent` to `agy`. Antigravity reads its own project instructions
   and uses its default agent; OpenCode custom agents are effectively ignored.
3. **Steering is cancel + restart.** If a new prompt arrives while a turn is active and no tool
   calls are dispatched, `doStream` calls `handleInterrupt("Superseded by new prompt")` rather
   than sending a steering prompt (`src/session-bridge.ts:1976-1980`). `agy` supports steering;
   this plugin does not expose it.
4. **Mode and Code Mode are not persisted.** Modes reset to Auto after a bridge restart;
   `codeModeEnabled` resets to false. `setMode`/`setCodeMode` do not write storage
   (`src/session-bridge.ts:800-831`).
5. **Multi-root workspaces.** `--add-dir` is never populated; `session/new`/`resume` do not send
   `additionalDirectories` (`src/acp-client.ts:457-459`, `638-660`).
6. **Fallback catalog is stale.** If discovery fails, `FALLBACK_MODELS` omits current 1.5.14
   models (`gemini-4-carbon`, `gemini-pro-orchestrator-argon`, actual Carbon Orchestrator id).
7. **Fixed limits.** All models advertise 1M context / 64k output. Third-party Claude/GPT models
   may have smaller effective windows; compaction may overfill them.
8. **Ambient discovery at startup.** `src/index.ts:185-191` forks
   `refreshModelsInBackground()` whenever the 6h cache is stale. That spawns `agy acp` and creates
   a discovery session even if no ACP model is ever used, contradicting the README's "start lazily
   only when an antigravity-acp model is invoked" claim.
9. **Code Mode tool catalog timing.** `session/new`/`resume` can happen during a warm before the
   first `context` hook populates `mcpDescriptors`; the relay then returns an empty `tools/list`.
   The relay advertises `tools.listChanged: true` but never sends a `notifications/tools/list_changed`
   notification (`src/mcp-relay.ts:240`, `src/session-bridge.ts:622-632`). A warm Code Mode session
   can therefore start with no relayed tools until it is reset.

---

## 3. Security and compliance

### 3.1 System/tool clearing vs OpenCode permissions

Clearing `input.system` and `input.tools` is coherent for a "thin ACP" adapter: Antigravity owns
its own agent loop, tools, and instructions. It also means **OpenCode's permission rules cannot
constrain Antigravity-native tools**. The only bridge is `session/request_permission`:

- In `default` / `accept-edits` / `plan`, the plugin calls `ctx.permission.assert` and maps the
  result to an ACP option.
- In `auto`, it skips OpenCode entirely and selects `allowOpt`.
- ACP `auto` / `accept-edits` modes may themselves suppress permission requests for edits, so the
  plugin never sees them. The plugin's local mode cache and the agent's actual mode can diverge
  after resume or a failed `set_mode`.

The `action` strings are `antigravity.<kind>` (`src/session-bridge.ts:1396`). Typical OpenCode
rules use `bash`, `edit`, `read`, `webfetch`, `mcp`; a user cannot write an `antigravity.execute`
rule through the normal UI without knowing the convention. This is a usability gap, not a direct
bypass.

### 3.2 Default auto-approval — the headline risk

`getOrCreateSession` defaults to `mode: "auto"` (`src/session-bridge.ts:579`), and
`handlePermissionRequest` auto-selects the allow option in Auto (`:1376-1379`). On a fresh
session, the user gets:

- ACP mode `auto` set on the process (unless `default`), so Antigravity itself approves edits and
  safe commands.
- Any remaining ACP permission request auto-approved by the plugin.

That is effectively `--dangerously-skip-permissions` behavior without the flag. It is more
permissive than `agy`'s own Auto mode, which still asks before commands that leave the sandbox
unless its review clears them. It contradicts the Pi security baseline ("no automatic approval";
`AUTH-PERMISSIONS-SECURITY.md:9-18`) and the checklist's "default to default, never enable auto
implicitly" (`acp-plugin-checklist.md:580`). For a production plugin, default must be `default`
/ Ask, with Auto an explicit, visible opt-in.

### 3.3 Permission option handling

`allowOpt` falls back to `opts[0]` (`src/session-bridge.ts:1357-1363`; also
`src/acp-client.ts:586-596`). If the agent offers only reject options, Auto/`mcp_oc_` can select
`opts[0]` as if it were an allow. More commonly, if `allow_once` is absent but `allow_always` is
present, the plugin selects `allow_always`, silently persisting a broader scope. The same applies
to `denyOpt` / `reject_always`. The Pi broker explicitly forbids `options[0]` fallback and
persistent choices without user intent (`PROTOCOL-MAPPING.md:150-204`, `AUTH-PERMISSIONS-SECURITY.md:121-125`).

The `mcp_oc_` fast path is functionally reasonable because OpenCode executes the relayed tool and
enforces its own permissions. But it trusts the tool name prefix. Live 1.5.14 names relayed tools
`mcp_oc_<tool>`, so it works today; a future naming change would either bypass the fast path
(leading to a generic permission prompt) or, worse, match a native tool by coincidence. Check
`params.toolCall._meta.mcp.server` and the `Run call_mcp_tool?` dispatcher title as fallbacks
(cf. `opencode-antigrvity/src/acp-process.ts:604-620`).

### 3.4 Token handling

System1970 is clean:

- Never reads Antigravity auth databases or tokens.
- Never passes OAuth tokens; relies on `agy`'s cached login.
- Scrubs `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `GOOGLE_APPLICATION_CREDENTIALS` for OAuth modes.
- Passes `GEMINI_API_KEY` via inherited env for `gemini-api-key`, which is the documented ACP path.

Risks:

- **Environment inheritance.** `buildAgySpawnEnv` copies the entire `process.env`, including
  unrelated secrets (`AWS_*`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, etc.). The Antigravity agent can
  read them via shell/tools. Use an allowlist or scrub known secret keys, and document that
  Antigravity runs with the user's full environment.
- **stderr.** `AcpProcess` keeps a 40-line stderr ring (`src/acp-client.ts:478-485`), and
  `handleProcExit` stores the last stderr line in `lastError` (`src/session-bridge.ts:1334`).
  OAuth URLs/device codes or request IDs could appear there and surface in the UI. Redact
  `token`, `Bearer`, `api[_-]?key`, `oauth`, `cookie`, `GEMINI_API_KEY`, `x-goog-*` as the Pi
  checklist recommends (`AUTH-PERMISSIONS-SECURITY.md:185-197`, `acp-plugin-checklist.md:1334-1339`).
- **Authenticate** is called eagerly on every spawn with a 10s timeout. For an unauthenticated
  user it may start an OAuth flow and time out; the error path is not mapped to an actionable
  login message. `agy acp --login` / terminal auth is not exposed.

### 3.5 MCP relay hardening

Strengths:

- Binds only `127.0.0.1`, ephemeral port.
- 24-byte random bearer token per plugin instance.
- Per-session path; token required before body parsing.
- Parked calls are single-use and tied to an active turn.
- Tool descriptions are scrubbed of `tools.opencode.*` / `session_move`.

Gaps:

- Token comparison is `auth !== "Bearer " + token`, not constant-time
  (`src/mcp-relay.ts:180`). Loopback and a 24-byte random token make timing attacks impractical,
  but the Pi baseline calls for constant-time comparison.
- No request-body size cap (`src/mcp-relay.ts:209-213`). A local process with the token could send
  an unbounded body; add a 1–8 MiB cap.
- `GET` always returns 405 (`:196-200`). `agy` 1.5.14 tolerates it for OAuth discovery and uses
  POST request/response, so Code Mode works; SSE-based MCP clients would not.
- The relay is not stopped when Code Mode is disabled; `setCodeMode(false)` resets the ACP session
  but leaves the listener alive (`src/session-bridge.ts:815-831`; `McpRelayServer.stop` is only
  called from `disposeAll`). The security note "only while an ACP session is active" is not
  accurate.
- No `notifications/tools/list_changed` despite advertising `listChanged: true`
  (`src/mcp-relay.ts:240`). Tool catalog changes are not pushed; a reset is needed.
- Tool argument schemas are passed through with only `type: "object"` normalization; no
  projection/rejection of unsupported JSON Schema constructs. Pi warns that Gemini-compatible
  function schemas reject unions, `$ref`, pattern properties, etc.
  (`PROTOCOL-MAPPING.md:299-312`). Complex OpenCode/MCP tool schemas may fail one whole Code Mode
  session.
- Relayed tool arguments are not re-validated against the original OpenCode schema before
  execution. OpenCode may validate in its tool layer, but the Pi baseline requires validation at
  the bridge boundary.

### 3.6 Process and sandbox

- No `--sandbox`; the agent runs with the user's full privileges. `--sandbox` is a documented
  `agy acp` flag; at minimum expose it as an option and document the default.
- No process group / detached spawn, no `process.kill(-pid)` on POSIX, no Windows job object
  (`src/acp-client.ts:462-466`, `724-765`). With `--process-per-session`, `agy` can spawn worker
  processes; killing only the front process can leave workers or tool grandchildren.
- `dispose()` sends SIGTERM and SIGKILL after 1.5s, but if the process already exited the
  `once("exit")` listener is added too late; the timer resolves after 1.5s. Bounded, but sloppy.
- `resolveAgyBinary` can return `agy.cmd` on Windows (`src/acp-client.ts:34`); Node's `spawn`
  cannot execute `.cmd` without `shell: true`. Windows may fail even though `agy` is on PATH.
- `write()` silently returns when stdin is not writable (`src/acp-client.ts:599-602`); a request
  with no timeout (`session/prompt`) can then hang forever. Reject the pending request instead.

### 3.7 Terms of service and quota

The plugin's technical approach is the lowest-risk one available:

- Drives the official local `agy acp` binary.
- No OAuth token extraction, no spoofed IDE/API headers, no private HTTP endpoint replay.
- Uses the documented `authenticate` methods and `session/resume`.
- Shares the user's real Antigravity quota.

But Antigravity's FAQ explicitly names third-party clients such as OpenCode as restricted
(linked from the README), while the ACP docs say "any editor that supports ACP" can use `agy acp`.
The README cites a community ToS clarification, not a Google policy statement. Treat this as a
compliance risk the user accepts, not a guaranteed permitted integration. Enterprise plans may
have additional admin controls; the plugin does not surface them.

The `--process-per-session` architecture is documented and required for HTTP MCP servers, so it
is defensible. The default Auto mode is not: it effectively auto-approves native actions and
increases both safety and ToS/abuse risk.

---

## 4. Comparison with the other references

### 4.1 `opencode-antigrvity` v0.6.5 (rasyidrafi)

Architecture:

- Registers provider id `antigravity` with package `aisdk:antigravity`
  (`src/constants.ts:1`, `src/index.ts:28-30`, `164-196`).
- Creates an integration `antigravity`, auto-connects a **non-secret** local key sentinel
  (`opencode-antigravity-local`) so the provider appears configured; real auth is the CLI's.
- Uses the official `@agentclientprotocol/sdk` `ClientSideConnection` / `ndJsonStream`.
- Model catalog probes `session/new`, scopes cache by executable + auth + args, stores under
  `~/.local/share/opencode-antigravity/model-catalogs` with mode 0600, 10-minute TTL
  (`src/model-catalog.ts:41-182`).
- Session pool: max 128 sessions, per-session queue max 1, 15-minute idle eviction, LRU;
  per-session receipts/idempotency, file locks, and a durable `session-store` with history
  fingerprints (`src/session-pool.ts:134-373`).
- Opens ACP sessions with `session/load` when `loadSession` is true, otherwise `session/new`;
  reconstructs bounded history if not resumed (`src/acp-process.ts:350-374`).
- Disables Antigravity built-ins with `_meta.agy.enabledTools = []` and, for some versions,
  `antigravity.disabledTools: ["run_workflow"]` (`src/acp-process.ts:342-348`). This is verified
  against 1.3.0 profiles, not 1.5.14; the current default agent may ignore the empty enabled-tools
  list. All OpenCode tools are exposed through a host MCP bridge.
- Native permissions default to **deny** (`OPENCODE_ANTIGRAVITY_ACP_PERMISSION` allow opt-in);
  own-MCP calls are allowed because OpenCode gates them (`src/acp-process.ts:604-620`).
- Handles `compaction` / `title` / `generate` with a one-shot utility ACP call
  (`src/language-model.ts:130-137`).
- Uses `BROWSER` blocker to prevent ACP from launching a real browser during auth
  (`src/acp-process.ts:289-296`).

Strengths to borrow:

- Official SDK typing and stream handling.
- Session pool and receipts/idempotency (prevents duplicate side effects after crashes).
- Utility request routing for title/compaction/generate.
- Host-tool bridge with explicit native-tool disabling and default-deny native permissions.
- Process supervisor and browser blocker.
- Researched model metadata and per-model limits.

Blocking problems for reuse:

- **Provider id collision.** `antigravity` is the id of OpenCode 2.3.x's built-in provider
  (`ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/antigravity/catalog.ts:7-8`,
  `provider.ts:8-47`). `editor.add` overwrites by id, so loading both can replace the built-in
  catalog or be replaced by it, and both plugins' `providerID`-scoped hooks apply to the same
  provider. Rename to `antigravity-cli` or `antigravity-acp` before forking.
- **Token extraction / config mutation.** `src/auth-bridge.ts:61-90` reads the CLI's refresh token
  (including a Windows keyring PowerShell path) and writes `~/.gemini/antigravity-acp/acp_token.json`
  with a hardcoded OAuth client id/secret, and rewrites `settings.json` to
  `auth.type = "oauth-personal"`. This is exactly the token-copy pattern system1970 avoids, and it
  violates the Pi credential-ownership baseline (`AUTH-PERMISSIONS-SECURITY.md:20-29`). It also
  mutates user settings, which Pi explicitly says not to do.
- **Pinned to the standalone ACP server 1.3.0, not `agy acp` 1.5.14.** `src/acp-compatibility.ts:7-20`
  has SHA-256 profiles for 1.3.0 and refuses unknown binaries; `src/acp-detect.ts` resolves
  `agy_acp_server.par` / `agy_acp_server.exe`, not `agy acp`. It will not work with 1.5.14 without
  new profiles and install logic.
- **Bun-only.** Depends on `Bun.serve`, `koffi`, and `engines.bun >= 1.4.4` (`package.json:48-63`).
  OpenCode's CLI is Bun-based, but the desktop/server may run under Node; this narrows portability.
- **Older plugin API.** Depends on `@opencode/plugin` 2.0.22; needs a 2.3.2 port and verification.
- **Large surface.** 40+ source files, session store, file locks, telemetry, workspace registry,
  browser blocker, install logic. High maintenance cost for a launcher plugin.

Verdict on rasyid: excellent **reference** for session pool/idempotency/host-tool isolation and
utility request handling; poor **fork base** because of the token bridge, provider id collision,
1.3.0 pinning, and Bun-only complexity.

### 4.2 Pi provider docs (protocol/security reference)

Useful edge cases that system1970 misses:

- 32 MiB NDJSON frame/partial-line cap (`PROTOCOL-MAPPING.md:26`).
- Validate `protocolVersion`, agent info, capabilities, `authMethods`; don't hardcode method ids
  (`PROTOCOL-MAPPING.md:24`, `AUTH-PERMISSIONS-SECURITY.md:49-71`).
- Permission broker: opaque ids, single-use, reject stale/replayed results, no `options[0]`
  fallback, no persistent allow without explicit intent, always deny on timeout/unknown session
  (`PROTOCOL-MAPPING.md:150-204`, `AUTH-PERMISSIONS-SECURITY.md:79-125`).
- ACP 1.5 usage: net input excluding cache, output inclusive of thoughts; reconcile with
  `usage_update.used` as context occupancy, not aggregate usage (`PROTOCOL-MAPPING.md:223-232`).
- Tool schema projection for Gemini-compatible function declarations; reject unsupported
  constructs rather than silently widening (`PROTOCOL-MAPPING.md:299-312`).
- Cancellation: cancel → grace → kill; never send a new prompt on a cancelled session until it
  settles (`PROTOCOL-MAPPING.md:260-280`).
- Subprocess hardening: process group/parent-death supervisor, bounded stderr, no shell, env
  allowlist, no secrets in logs (`AUTH-PERMISSIONS-SECURITY.md:143-157`).
- MCP bridge: loopback only, high-entropy token, constant-time check, bounded bodies, namespace
  bridged tools, validate args, close on abort (`AUTH-PERMISSIONS-SECURITY.md:173-183`).
- Release blockers include automatic edit/execute approval by default, cross-session leakage, and
  duplicate execution (`AUTH-PERMISSIONS-SECURITY.md:210-223`). system1970 violates the first by
  default and has a possible duplicate-tool path if MCP naming changes.

Pi's own current Antigravity implementation defaults to `yolo` at the user's request
(`ANTIGRAVITY-MIGRATION.md:36-38`), so its docs are a design baseline, not a claim about its
current default. The checklist and security doc are still the right edge-case reference.

### 4.3 OpenCode's built-in Antigravity provider

`ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity` already does:

- Provider id `antigravity`, package `@opencode/antigravity`, `activation: "auto"`.
- `session/new` per working directory, one ACP session, native tool calls as
  `providerExecuted: true`.
- Latest-user-text prompt only; no system prompt.
- No model/effort switching after session open, no resume across restart, no per-OpenCode-session
  mapping, no permission handler (undefined `permission` means every native request is refused),
  no MCP/Code Mode, no GUI.

This is why a third-party plugin is still useful. It is also why forking system1970 is better than
trying to wrap the built-in: the built-in's session model is too coarse for per-OpenCode-session
resume and model switching.

---

## 5. Code-level bugs

Severity: **P0** = security/correctness blocker; **P1** = significant behavior/compat;
**P2** = polish/edge. Line numbers are for the audited checkout.

| # | Sev | Location | Issue | Fix |
|---|---|---|---|---|
| 1 | P0 | `src/session-bridge.ts:579`, `1376-1379` | New sessions default to `mode: "auto"`; Auto auto-selects allow for every native ACP permission request. This bypasses OpenCode permissions and is more permissive than `agy` Auto. | Default to `"default"`; require explicit opt-in for Auto; never auto-allow native `edit`/`execute` requests. |
| 2 | P0 | `src/session-bridge.ts:1357-1363` | `allowOpt` falls back to `opts[0]`; if no allow option exists it can select a reject or arbitrary option. It also selects `allow_always` when `allow_once` is absent. | Filter by `kind` only; if no matching allow kind, cancel. Prefer `allow_once`; never select `allow_always` without explicit user intent. |
| 3 | P0 | `src/session-bridge.ts:244-268` | Usage math assumes gross input. `agy` 1.5.14 reports net input (live probe: 11212 input + 6884 cache + 162 output = 18258 total). Code sets `total: 11212`, `noCache: 4328`, losing 6884 cached tokens. | `noCache = inputTokens`; `total = inputTokens + cacheRead + cacheWrite` (or use `totalTokens` when present); keep `cacheRead`/`cacheWrite` separate. |
| 4 | P0 | `src/session-bridge.ts:1925-1928` | `x-opencode-request-kind` is set but ignored. Compaction/generate requests run as full ACP turns on the main session, burning quota and interleaving with live prompts. | Read the kind; handle `title` locally (already), route `compaction`/`generate` to a separate one-shot ACP session or a local deterministic result; never prompt the main session. |
| 5 | P0 | `src/acp-client.ts:702`, `src/session-bridge.ts:2101-2119` | Eager `authenticate` has a 10s timeout; OAuth login can exceed it. Auth errors (`-32000`) are not classified; `ensureAcpSession` rethrows them, so OpenCode may retry. | Validate `authMethods`; call `authenticate` only after `session/new` fails with `-32000`; use a long/cancellable timeout; map `-32000` to a non-retryable login message. |
| 6 | P0 | `src/acp-client.ts:468-476`, `599-620`, `711-713` | No stdout frame cap; `write()` silently no-ops when stdin is not writable; `session/prompt` has no timeout. A wedged/closed process can hang a request forever or exhaust memory on a huge line. | 32 MiB frame/partial-line cap; reject requests on write failure; add a stall timeout for prompts and a bounded buffer. |
| 7 | P0 | `src/acp-client.ts:462-466`, `724-765` | No process group/detached spawn, no tree kill; Windows `.cmd` may not spawn without a shell; shutdown adds an `exit` listener after exit and relies on a 1.5s timer. | `detached` on POSIX + `process.kill(-pid)`; Windows job object/taskkill; handle already-exited process; `windowsHide`. |
| 8 | P1 | `src/session-bridge.ts:1806-1822` | `finalizeTurnStop` clears `activeTurn` without resolving `pendingMcpCalls`. If OpenCode returns only some tool results (or none) after a prompt settles, parked HTTP calls never resolve. | Resolve every remaining pending call with an `isError`/`cancelled` result before clearing the turn. |
| 9 | P1 | `src/session-bridge.ts:1660-1662` | `API_ERROR_ABORT_PATTERN` is tested against every `agent_message_chunk`, including normal assistant text. A user asking "what is PERMISSION_DENIED?" or a code sample with `(code 429)` trips the circuit breaker and aborts the turn. | Only classify structured ACP errors or a dedicated error notice; do not pattern-match arbitrary assistant text. |
| 10 | P1 | `src/session-bridge.ts:1925-1928` | Missing session header silently falls back to `"__default__"`, sharing one bridge session across all requests. | Throw a clear invalid-request error if `x-opencode-session-id` is absent. |
| 11 | P1 | `src/session-bridge.ts:575-583`, `800-812`, `1266-1269` | Mode is not persisted; new bridge defaults to Auto; `setMode` changes local state even if `set_mode` fails; `ensureAcpSession` skips applying `"default"`, so a resumed server-side Auto session can remain Auto while the plugin believes Ask. | Persist per-session mode; always set/confirm the mode on start (including default) or read `currentModeId`; fail closed if a less-restrictive mode cannot be confirmed. |
| 12 | P1 | `src/session-bridge.ts:57-69`, `283-303` | Code Mode excludes `read`/`write`/`edit`/`bash` etc. from the relay, leaving those as Antigravity-native tools outside OpenCode permissions. | If Code Mode is meant to give OpenCode permission parity, expose those tools and disable Antigravity built-ins; otherwise document the limitation prominently. |
| 13 | P1 | `src/session-bridge.ts:210-218`, `388-432` | `sharedCatalog`, cooldown keys, and catalog storage are global, not scoped by account/auth method/executable/workspace. Multiple accounts or an account switch can show the wrong models and apply the wrong cooldown. | Scope catalog/cooldown by a hash of auth method + executable path/version + account/tier; store account scope with the catalog. |
| 14 | P1 | `src/index.ts:185-191` | Stale cache triggers background model discovery on plugin load, spawning `agy acp` and creating a discovery session even when no ACP model is used. README claims fully lazy startup. | Defer discovery until first ACP model selection/first turn, or make the background probe explicit/opt-in; update README. |
| 15 | P1 | `src/session-bridge.ts:1543-1557` | If `abortSignal` is already aborted, `onAbort()` runs before `onStart`, closing the controller, then `onStart` still calls `proc.prompt`. | Return an aborted stream immediately; do not prompt after an abort. |
| 16 | P1 | `src/session-bridge.ts:2127-2140` | If `set_model` and both `set_config_option` fallbacks fail, `lastModelId` is still cached, so the next turn silently runs with the previous/agent-default model. | Only cache after a confirmed result; retry/read `configOptions`; fail the turn if the requested model cannot be confirmed. |
| 17 | P1 | `src/session-bridge.ts:1455` | MCP abort listener is added but never removed; if the signal is already aborted, the promise can wait forever. | Remove listener on resolve; check `signal.aborted` before parking. |
| 18 | P1 | `src/mcp-relay.ts:180`, `209-213`, `196-200` | Token compare not constant-time; unbounded request body; GET always 405 (SSE unsupported); no body cap. | `crypto.timingSafeEqual`; cap body; implement SSE or document POST-only; cap header/body. |
| 19 | P1 | `src/mcp-relay.ts:240`, `src/session-bridge.ts:622-632` | Advertises `tools.listChanged: true` but never sends `notifications/tools/list_changed`; a warm Code Mode session can cache an empty tool list. | Send list_changed or ensure descriptors exist before `session/new`; reset Code Mode session if the snapshot changes. |
| 20 | P1 | `src/session-bridge.ts:697-700` | `_meta.apiKey` is not a documented ACP field; unused but misleading. | Remove or use the documented API-key field/`GEMINI_API_KEY` env only. |
| 21 | P1 | `src/session-bridge.ts:206-208` | `isGlobalBreakerError` only treats 403/PERMISSION_DENIED as global; 401/UNAUTHENTICATED/`Authentication required` is classified as a per-pool quota error and gets a 60s cooldown instead of a login prompt. | Add auth codes (`-32000`, 401, UNAUTHENTICATED) to global/auth classification; surface a login action. |
| 22 | P2 | `src/session-bridge.ts:1809-1821` | At prompt end, still-active native tools get a synthetic `{status:"completed"}` success result. This misreports incomplete/cancelled tools. | Emit `{status:"incomplete"}` / `cancelled`, `isError: true`; never fake success. |
| 23 | P2 | `src/session-bridge.ts:1035-1039`, `src/index.ts:57` | `onStateChanged` is never supplied; GUI state changes (proc exit, cooldown) are not pushed, only polled. | Wire `onStateChanged` to an RPC event or add a state event stream. |
| 24 | P2 | `src/session-bridge.ts:2227-2229` | `finalizeTurnStop` is only called when `dispatchedCallIds.size === 0 && controller`; if the controller was closed by a tool flush and OpenCode never continues, the turn lingers. | Add a continuation timeout / cleanup on no tool results. |
| 25 | P2 | `src/acp-client.ts:746-765` | `dispose()` adds `once("exit")` after the process may already have exited; always waits the 1.5s timer. | Check `exitCode`/`signalCode` before waiting. |
| 26 | P2 | `src/acp-client.ts:34` | `agy.cmd` is a spawn candidate on Windows, but `.cmd` needs `shell: true` on Node. | Resolve `agy.exe` first; use `cmd.exe /c` explicitly or reject `.cmd`. |
| 27 | P2 | `src/acp-client.ts:478-505`, `src/session-bridge.ts:1334` | Stderr ring stores raw lines and last line in `lastError`; may leak OAuth URLs/tokens. | Redact secret patterns; cap line length; expose only a sanitized tail. |
| 28 | P2 | `src/acp-client.ts:626-636` | Initialize response is ignored; no protocol version check, no capability recording. | Validate `protocolVersion === 1`; record agent version/capabilities; reject v2. |
| 29 | P2 | `src/session-bridge.ts:638-660` | `resumeSession` sends `mcpServers`, which is not in the ACP v1 `ResumeSessionRequest`; works on 1.5.14 but is non-standard. | Prefer `session/load` for MCP reattachment, or treat the extra field as a version-gated extension. |
| 30 | P2 | `src/history-sanitizer.ts:11-12`, `src/session-bridge.ts:2237` | Error pattern includes `API error (attempt \d+)`; `agy` 1.5.13+ silences retries and only shows the final error, and the agent may retry internally before emitting anything. README's "fail-fast attempt #1" is not enforceable. | Use structured ACP error codes; hook `ctx.session.hook("retry")` to force `retry:false` for auth/quota; update README. |

Additional lower-severity observations:

- `history-sanitizer.ts:9` only strips `session_move` and `tools.opencode.`; other OpenCode
  internals can appear in MCP descriptions. The `stripInternalOpencodeNamespace` /
  `extractSafeAcpContext` helpers are dead code.
- `history-sanitizer.ts:598-611` budget math is off by the header newline (minor).
- `buildTextOnlyHandoffPromptBlocks` caps only prior history, not the latest user prompt; a huge
  latest prompt can exceed the ACP frame/limit.
- `Spawn env` inherits all secrets (see §3.4).
- `NATIVE_SHADOWED_TOOLS` includes `multiedit`/`apply_patch`/`shell`, which may not be the actual
  OpenCode 2.3 tool names; the filter can leave duplicates or miss native shadows.
- `McpRelayServer` `initialize` advertises `tools.listChanged` without support; see #19.
- `setCodeMode` resets the ACP session and uses a text handoff, so "conversation preserved" is
  text-only, not native tool state. This is documented in the README but easy to overread.
- `getState`/GUI `cooldownUntil` uses `lastModelId`; after a failed model switch, the wrong pool
  can be shown.
- `start()` in `SessionBridgeManager` (`:373-382`) is unused.

---

## 6. Fork vs build recommendation

### Recommendation: fork `opencode-antigravity-acp` v0.2.0, harden it, do not ship as-is

Why this base:

- It is MIT-licensed, small (7 core files), and already aligned with `agy` 1.5.14 and
  OpenCode 2.3.2.
- It solves the hard OpenCode integration: provider registration, `aisdk` hooks, per-session
  mapping, model/effort catalog, resume, warm pool, MCP relay, RPC, GUI.
- It has the cleanest auth posture of the three references: no token extraction, no settings
  mutation, official `agy acp` only.
- Its raw NDJSON client is a reasonable Phase 1 choice because Antigravity's non-spec `models`
  field carries the effort-qualified ids; a strict ACP SDK response schema would strip them
  (`acp-plugin-checklist.md:58-74`). Keep the raw client, add ACP SDK types and limits.

Why not fork rasyid:

- Token extraction + settings mutation (`src/auth-bridge.ts:61-90`) is a security/compliance
  regression and directly conflicts with the project's stated no-token-extraction boundary.
- Provider id `antigravity` collides with OpenCode 2.3.x's built-in provider; model/catalog and
  hooks can interfere.
- Pinned to standalone ACP server 1.3.0 with SHA profiles (`src/acp-compatibility.ts:7-20`), not
  `agy acp` 1.5.14; it will refuse the installed binary.
- Bun-only (`Bun.serve`, `koffi`, `engines.bun`) and 40+ modules; high maintenance for a launcher.
- Use it as a reference for the session pool, receipts/idempotency, host-tool isolation, utility
  request routing, and process supervisor.

Why not build from scratch:

- The OpenCode 2.3.2 provider/AISDK/GUI/RPC plumbing is already implemented and tested in
  system1970. Rebuilding it delays the security fixes that matter.
- A clean-room build is justified only if you need first-class host-tool parity, durable
  idempotency, or multi-account isolation; in that case use `@agentclientprotocol/sdk` +
  rasyid's session-store concepts, and budget 3–4 weeks.

### Minimal change list if forking

**P0 — ship blockers (security/correctness)**

1. **Default mode `default`.** Change `getOrCreateSession` default from `"auto"` to `"default"`
   (`src/session-bridge.ts:579`). Persist mode per OpenCode session. Require explicit opt-in for
   `auto` / `accept-edits`; show a warning that native tools bypass OpenCode permissions.
2. **Remove Auto auto-approval.** In `handlePermissionRequest`, never auto-select allow for
   native `edit`/`execute`; route through `ctx.permission.assert` unless the user opted into Auto.
   For Auto, at most auto-allow read/search kinds; never `execute`/`edit`.
3. **Fix option selection.** No `opts[0]` fallback; only match `kind`; prefer `allow_once`
   (`reject_once` on denial); require explicit user intent for `allow_always`/`reject_always`;
   respond `cancelled` if no exact match (`src/session-bridge.ts:1357-1366`,
   `src/acp-client.ts:586-596`).
4. **Fix usage.** `noCache = inputTokens`; `total = inputTokens + cacheRead + cacheWrite` (or
   `totalTokens`); keep output `text = output - reasoning`. Add `usage_update.used/size` as
   context occupancy in provider metadata, not aggregate usage (`src/session-bridge.ts:244-268`).
5. **Handle request kinds.** Read `x-opencode-request-kind`; route `compaction`/`generate` to a
   separate one-shot ACP session (or a local, clearly labeled result), never the main session.
   Keep `title` local (`src/session-bridge.ts:1925-1928`, `src/index.ts:131`).
6. **Auth gate.** Validate `protocolVersion` and `authMethods`; call `session/new` first; only on
   `-32000` call `authenticate` with a long/cancellable timeout; map `-32000` to a non-retryable
   login message; optionally support `agy acp --login`/terminal auth
   (`src/acp-client.ts:626-708`, `src/session-bridge.ts:2101-2119`).
7. **Transport hardening.** 32 MiB frame/partial-line cap; request timeout for `session/prompt`;
   reject on `write()` failure; bounded buffered stream parts; process group/tree kill on POSIX,
   `windowsHide`, `.cmd` handling; redact stderr (`src/acp-client.ts:468-476`, `599-620`,
   `711-713`, `462-466`, `724-765`).
8. **Hard error on missing session id.** Remove the `__default__` fallback
   (`src/session-bridge.ts:1925-1928`).

**P1 — compatibility/behavior**

9. Use `session/set_config_option("model", base)` + `("thought_level", level)` as primary, with
   `session/set_model` only as a version-gated fallback; verify the result's `currentValue` before
   prompting; refresh the full `configOptions` after a model change
   (`src/session-bridge.ts:2124-2142`).
10. Use `set_config_option("mode", value)` first, `set_mode` fallback; read
    `current_mode_update`; fail closed if a less-restrictive mode cannot be confirmed.
11. Resolve `compaction`/`generate` and implement `ctx.session.hook("retry")` to force
    `retry: false` for auth/quota (`src/session-bridge.ts:2237`).
12. Fix `finalizeTurnStop` to resolve pending MCP calls; cap/cleanup tool-result continuation
    timeouts (`src/session-bridge.ts:1806-1822`).
13. Scope catalog/cooldown by auth method + executable + account/tier; avoid module-global
    `sharedCatalog` (`src/session-bridge.ts:210-218`, `388-432`). Update/replace
    `FALLBACK_MODELS` with the real 1.5.14 set or mark fallback models unavailable.
14. Stop background discovery at plugin load; defer until first ACP model selection/turn
    (`src/index.ts:185-191`).
15. Code Mode: if retaining, expose the core tools (`read/write/edit/bash`) or explicitly document
    that native tools remain outside OpenCode permissions; add schema projection, argument
    validation, body caps, constant-time token, `tools/list_changed`, and stop the relay when the
    last Code Mode session ends (`src/session-bridge.ts:57-69`, `815-831`; `src/mcp-relay.ts`).
16. Add `--sandbox` as an option; do not default to `--dangerously-skip-permissions`; document
    that `auto`/`accept-edits` can suppress ACP permission requests.
17. Redact stderr/lastError; use an env allowlist or scrub known secrets; add a `BROWSER` blocker
    for headless/no-browser auth paths (borrow from rasyid).

**P2 — polish**

18. OpenCode agent integration: decide whether to preserve the selected OpenCode agent's system
    prompt/instructions (Pi/rasyid style) or keep strict thin mode. If strict thin, document that
    custom OpenCode agents/skills do not apply; remove unused `x-opencode-agent`.
19. Add per-model limits/metadata rather than one 1M/64k limit; use observed `usage_update.size`
    for context.
20. Wire `onStateChanged` to an RPC event; avoid GUI polling gaps.
21. Pin `@opencode/plugin`/GUI exactly for the release; add a CI matrix for 2.3.2 and the next
    minor; rebuild `dist/gui-experimental.cjs` in CI.
22. Remove dead code (`buildAcpPromptBlocks`, `extractSafeAcpContext`, unused `start()`), fix
    budget off-by-one, and document the `mcp_oc_` naming assumption.

---

## 7. Verification plan

**Unit / fake ACP**

- Default mode is `default`; Auto requires explicit opt-in; `ask`/deny paths never select
  `allow_always` or `opts[0]`.
- `zeroUsage` with live 1.5.14 numbers: input 11212, cacheRead 6884, output 162, thought 110
  → total 18258, noCache 11212, text 52.
- `doStream` with `kind: "compaction"` / `"generate"` never calls `session/prompt` on the main
  ACP session.
- Missing session header throws; no `__default__` mixing.
- `finalizeTurnStop` resolves all pending MCP calls; partial tool results do not hang.
- `allowOpt` with only reject options returns `cancelled`; `allow_always` only after explicit
  intent.
- `authenticate` only after `-32000`; 10s timeout replaced with a controllable/long timeout.
- Frame >32 MiB fails the process generation; stdin write failure rejects pending requests.
- Mode persistence across `resetSession`/plugin restart.

**Live contract (agy 1.5.14)**

- `initialize` → protocol 1, 4 auth methods, 27 available models, 11 base models.
- `session/set_config_option("model")` + `("thought_level")` confirms model/effort; `set_mode`
  confirms mode via `current_mode_update`.
- `session/resume` reattaches MCP relay; `tools/list` returns descriptors; a prompt calls
  `mcp_oc_<tool>` and `tools/call` reaches the relay.
- Usage fields match the net-input formula; `usage_update` zero is ignored, nonzero used is
  context occupancy.
- Permission request for `execute`/`edit` in `default` reaches OpenCode; in Auto it is explicit
  and warned.
- Cancel mid-turn settles `session/prompt` with `cancelled`; next prompt waits/tears down safely.
- Plugin disable/reload leaves no `agy` or worker processes (`ps` check).

**OpenCode 2.3.2 integration**

- Provider/model picker shows one Antigravity (ACP) entry with base models and effort variants.
- Selecting a variant sends the right model/effort; switching between ACP and normal models does
  not lose history or replay tools.
- Session resume after OpenCode restart restores the ACP conversation (or text handoff if resume
  fails).
- Compaction and title do not consume ACP turns/quotas.
- Code Mode (if retained) exposes only intended tools; OpenCode permission decisions apply.
- GUI bundle loads; `/agy-reset` and `/agy-reload` work; state transitions
  Standby → Starting → Connected render.

**Security review**

- No OAuth token read/copy; no settings mutation.
- `agy` child env contains no unrelated secrets; stderr is redacted.
- Relay binds loopback only, constant-time token, body cap, stops with Code Mode.
- Auto mode cannot be reached without explicit user action; native `execute`/`edit` never
  auto-approved by default.

---

## 8. Appendix — probe evidence

Commands/probes used (all against installed `agy` 1.5.14):

- `ref/notes/probe-agy-acp.mjs`, `probe-agy-acp-config.mjs`, `probe-agy-acp-set-model.mjs`
  (existing).
- New probes in `/tmp/opencode` (not part of the repo):
  - handshake + `session/new` + `set_model` + `set_config_option`
  - `session/resume` with an HTTP MCP relay; captured `server/discover`, `initialize`
    (MCP `2025-11-25`), `tools/list`, `tools/call`
  - one tiny prompt calling `oc_read`; tool name `mcp_oc_oc_read`; usage fields as above
  - `authenticate({methodId:"oauth-personal"})` when already signed in; ~2.3s, tier metadata

No plugin install, no OpenCode config change, no `~/.config/opencode` writes. The probes created
and closed ACP sessions in `agy`'s own data directory; the single prompt used a small amount of
account quota. Delete those sessions if desired; the plugin itself has no cleanup command for
probe-created sessions.

---

## 9. Bottom line

- **Architecture:** a competent thin-ACP adapter with good OpenCode 2.3.2 integration, clean auth,
  real model/effort discovery, per-session resume, optional MCP Code Mode, and a useful GUI.
- **Blocking problems:** default Auto auto-approval of native tools, wrong usage accounting,
  no compaction/generate routing, fragile auth/transport/process handling, and Code Mode
  permission gaps.
- **Fork decision:** fork system1970; harden the P0/P1 list above. Use rasyid and Pi docs as
  references for session pool/idempotency/host-tool isolation and protocol/security edge cases,
  not as the base. Do not ship the default Auto behavior.
