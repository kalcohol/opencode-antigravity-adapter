# Audit: OpenCode PR #65430 — built-in Google Antigravity provider

**Scope / method.** Read-only review of `ref/opencode-pr-65430` at `0478f5d` (the checkout contains only this commit; no PR description file is present, so the commit body, `specs/v2/antigravity-provider.md`, and the site docs are treated as the PR's claims). All `packages/...`, `specs/...`, and `services/...` paths below are under `ref/opencode-pr-65430/`; `ref/notes/...` are the local `agy 1.5.14` probe logs. Dependencies are not installed in this workspace, so I did not run `bun typecheck`; type observations are from reading the pinned SDK typings.

**Verdict.** Not mergeable as-is. Model/variant selection is entirely unwired (the only production path sends a prompt and nothing else), the tool-call update mapping will defect the OpenCode runner on a normal ACP tool lifecycle, the dynamic model catalog cannot update after the first registration, and one ACP conversation is shared by every OpenCode session in a directory. The ACP transport is a reasonable skeleton, but the provider above it does not yet behave like a provider.

---

## 1. Does model/variant selection actually work?

**No.** The selection is lost at three separate points, so even fixing only one of them is insufficient.

Trace:

| Step | What happens | Evidence |
| --- | --- | --- |
| Catalog | `toModel` creates `Model.Info.default(ID, Model.ID.make(group.id))`; both `id` and `modelID` become the grouped id (for example `gemini-3.8-flash`). Variants carry `settings: { effort, slug }`. | `packages/core/src/plugin/provider/antigravity/antigravity/catalog.ts:70-83`; slug built at `catalog.ts:50` |
| Variant merge | `withVariant` merges the selected variant's settings into `model.settings`; it does **not** change `modelID`. | `packages/core/src/model-resolver.ts:166-194` |
| AISDK language | `AISDK.language` calls `sdk.languageModel(model.modelID ?? model.id)`, so the language-model factory receives the grouped id, never a CLI slug or effort. | `packages/core/src/aisdk.ts:355-368` |
| Antigravity SDK hook | The hook passes only `modelID` into `new Model(...)`; it ignores `evt.model` and `evt.options`, which are where the variant's `effort`/`slug` have already arrived. | `packages/core/src/plugin/provider/antigravity/aisdk.ts:16-33` |
| Language model | `doStream` calls `run({ model: this.modelId, prompt: readPrompt(options) }, ...)`; `providerOptions` (including the variant settings) is ignored. | `packages/core/src/plugin/provider/antigravity/language-model/antigravity-language-model.ts:42-54` |
| Session | `AntigravitySession.run` accepts `Request.model` but discards it: it calls `client.prompt(sessionId, request.prompt, ...)` only. | `packages/core/src/plugin/provider/antigravity/antigravity/session.ts:22-26,63-66` |
| ACP | `Client.prompt` sends `session/prompt` with text and nothing else. There is no `session/set_config_option`, `session/set_model`, `session/set_mode`, or model/effort argument anywhere. | `packages/core/src/plugin/provider/antigravity/antigravity/acp.ts:206-245`; grep finds no `setSessionConfigOption`/`set_model` in the provider |
| Unused mapper | `resolveSlug` is exported and tested, but has no production caller; the only call sites are the tests. | `catalog.ts:93-99`; `packages/core/test/plugin/provider-antigravity.test.ts:64-75` |

Consequence: the ACP session is created with `currentModelId = "gemini-4-neon-high"` (`ref/notes/agy-acp-handshake.log:89,203`) and nothing changes it. Every turn runs that model at its default effort, regardless of what the picker or session says. Choosing `antigravity/gemini-3.8-flash#low` changes only the OpenCode-side label/metadata.

Two important nuances for a fix:

1. Sending `modelID` to the CLI would still be wrong for single-variant groups. `gpt-oss-120b-medium` is registered as id `gpt-oss-120b` with no variants, while the CLI accepts `gpt-oss-120b-medium` (`catalog.ts:44-61,70-78`; test expects `resolveSlug(..., "gpt-oss-120b") === "gpt-oss-120b-medium"` at test lines 72-73; probe list `ref/notes/agy-acp-handshake.log:198-201`). The same is true for `claude-opus-4-6` vs `claude-opus-4-6-thinking`.
2. The ACP 1.6.0 TypeScript SDK exposes `setSessionConfigOption`, but **not** `setSessionModel`. The `session/set_model` method in the probe is an `agy` extension (`ref/notes/agy-acp-set-model.log:6-19`). Use `setSessionConfigOption({ configId: "model", value: <base-or-slot> })` plus `{ configId: "thought_level", value: <effort> }` as the stable path; reserve `session/set_model` for a version-gated fallback.

The `effort`/`slug` values are available in the SDK hook as `evt.options` (the core spreads native settings at `packages/core/src/aisdk.ts:126-134`, and `withVariant` put them into `model.settings`), so this is a wiring omission, not an API limitation.

---

## 2. Catalog correctness

### 2.1 `availableModels` vs `configOptions`

The real session response contains both:

- `models.availableModels`: 27 effort-qualified entries, e.g. `gemini-4-neon-xhigh`, `gemini-pro-orchestrator-neon`, `gpt-oss-120b-medium`.
- `models.currentModelId`: `gemini-4-neon-high`.
- `configOptions`: `model` (11 base/slot values), `thought_level` (low/medium/high, sometimes xhigh), and `mode` (default/accept-edits/auto/plan).

Evidence: `ref/notes/agy-acp-handshake.log:89-338`; `ref/notes/agy-acp-config.log:8-17,34`.

The provider parses only `availableModels` (`acp.ts:116-125,296-302`) and throws away `currentModelId`, `configOptions`, `modes`, and `_meta`. `Session` has no fields for them (`acp.ts:75-80`). That has several consequences:

- It cannot know the CLI's current model/effort at startup.
- It cannot use the authoritative per-model `thought_level` option list; it infers efforts from display-name parentheses.
- It cannot expose `mode` (plan/accept-edits/auto), even though the CLI advertises it.

`configOptions.thought_level` is session-global and changes with the model: `gemini-4-neon` offers xhigh; `gemini-3.8-flash` does not (`ref/notes/agy-acp-config.log:12,19,29,37`). The catalog's per-model variant sets from `availableModels` are mostly a good approximation, but the provider never validates against or applies `thought_level`.

### 2.2 Name-based grouping misclassifies the orchestrator

`group` treats every trailing parenthetical as an effort (`catalog.ts:44-61,102-111`). For the real list:

- `Orchestrator (Neon)` / `Orchestrator (Carbon)` / `Orchestrator (Argon)` become one group `gemini-pro-orchestrator` with variants `neon`, `carbon`, `argon`.
- These are **backend/model slots**, not reasoning efforts. The Carbon slug is the base `gemini-pro-orchestrator` and has no `-carbon` suffix, so `withoutSuffix` leaves it as the group id (`catalog.ts:49,114-117`).
- `defaultVariant` picks the first variant because no `high`/`medium` exists (`catalog.ts:120-126`), so the default group silently means Neon, while the unqualified model value `gemini-pro-orchestrator` is Carbon.
- A fix that applies every variant through `thought_level` would send `thought_level=neon|carbon|argon`, which the CLI does not define as thought levels. A fix that sends `settings.slug` through `set_config_option("model", ...)` is closer, because these slots are separate values in `configOptions.model.options` (`ref/notes/agy-acp-handshake.log:255-265`).

Evidence: probe list `ref/notes/agy-acp-handshake.log:151-161`; config model values `:255-281`.

This directly contradicts the spec's claim that "the CLI's own names make the split unambiguous" (`specs/v2/antigravity-provider.md:35-38`). The test fixture omits the orchestrator entirely (`packages/core/test/plugin/provider-antigravity.test.ts:11-18`), so this is untested.

### 2.3 Single-variant models lose the CLI slug

For a group with one variant, `toModel` deliberately emits no variants and keeps the CLI's name (`catalog.ts:70-78`). The model id remains the stripped `group.id`, so the actual CLI slug is lost. This is harmless only while selection is not implemented; it becomes a bug as soon as selection is wired. `gpt-oss-120b-medium` is the concrete example, and the test's `resolveSlug` assertion proves the author knew the mapping was needed (`test:72-73`).

### 2.4 Default/current model

`SessionPayload` declares `currentModelId` (`acp.ts:122`), but `toSession` drops it (`acp.ts:296-302`). Instead:

- `defaultVariant` claims "the CLI's own default is the highest effort" (`catalog.ts:119-126`). The probe disproves this: `gemini-4-neon` offers xhigh, yet the session's current model is `gemini-4-neon-high` (`ref/notes/agy-acp-handshake.log:89-103`).
- For non-first groups, the first variant is not necessarily the CLI's default; for the orchestrator it is Neon, while the unqualified `gemini-pro-orchestrator` value is Carbon.
- OpenCode's own fallback may pick Antigravity's first registered model (`packages/core/src/model-resolver.ts:552-556`), and Antigravity is registered second in `ProviderPlugins` after Amazon Bedrock (`packages/core/src/plugin/provider.ts:34-37`). Because its `activation` is `auto` with no integration (`antigravity/provider.ts:39-45`) and `Provider.snapshot` marks such records available (`packages/core/src/provider.ts:473-486`), a cached Antigravity model list may become the default model for users who never selected it. This should be verified on a real instance; if confirmed, it is a significant integration regression.

### 2.5 Limits, capabilities, families

- `Model.Info.default` gives every model `limit: { context: 200_000, output: 32_000 }` (`packages/schema/src/model.ts:145-158`), and `toModel` never overrides it (`catalog.ts:70-84`). The CLI reports `usage_update.size = 1_048_576` (1 MiB) (`ref/notes/agy-acp-config.log:34`). OpenCode will compact at 200k even though the CLI has a 1M window; it also ignores the live `used` value.
- `capabilities.input` defaults to `["text", "image"]` (`packages/schema/src/model.ts:151`), but `readPrompt` drops every non-text part (`language-model.ts:87-99`). The provider advertises image input and then silently discards images; an image-only message becomes `"[continue]"`.
- `familyOf` returns only `gemini`, `claude`, `gpt`, or the id prefix (`catalog.ts:129-134`). `Model.small` searches `gpt-luna`, `gemini-flash-lite`, `gemini-flash`, `claude-haiku` (`packages/core/src/model.ts:308-320`), so it never finds a small Antigravity model; title generation falls back to the primary model. That is especially costly here because the same ACP conversation is shared (Section 3.3).
- Cost is empty (`Model.Info.default` `cost: []`), matching the "no cost" docs. Fine.

### 2.6 Variant edge cases

- A group containing a non-effort parenthetical such as `(Preview)`, `(Free)`, or `(Carbon)` is split as an effort; there is no allowlist for `low|medium|high|xhigh|thinking`.
- A base model plus a `(Thinking)` sibling with the same base slug yields variants `default` and `thinking`. `withVariant` treats variant id `"default"` as "no variant" (`packages/core/src/model-resolver.ts:170-171`), so a `default` variant shown in the picker is a no-op and cannot round-trip as an explicit variant. The current `claude-sonnet-4-6` example happens to be single-variant and avoids this, but the grouping logic can create it.
- `defaultVariant` fallback for an unknown effort silently chooses a default (`catalog.ts:93-99`), rather than failing; a config trying an unsupported combination is not rejected.

---

## 3. Auth, permissions, session lifecycle, updates, cancellation, concurrency

### 3.1 Auth / availability

- No authentication is implemented. `initialize` returns `authMethods` (`oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`; `ref/notes/agy-acp-handshake.log:2,43-87`), but `Client.start` stores only `agentInfo` (`acp.ts:161-180`). `authenticate` is never called, and `auth_required` errors are not recognized.
- The provider is registered with `activation: "auto"` and no integration/status (`antigravity/provider.ts:39-45`). It is therefore available even when `agy` is missing or signed out; cached models can be offered that the account cannot use.
- `OPENCODE_ANTIGRAVITY_PATH` is documented (`services/site/src/docs/content/antigravity.mdx:24`; `specs/v2/antigravity-provider.md:15`) but never read. `spawnCLI` hardcodes `options.command ?? "agy"` (`acp.ts:255-260`), and the plugin calls `Client.start({})` (`session.ts:77`). Compare Claude Agent's `OPENCODE_CLAUDE_PATH` + `which("claude")` (`claude-agent/claude/io.ts:23`). The `Options.command`/`args` API exists but is unreachable from the plugin.
- The comment says the CLI starts on first use (`session.ts:13-14`), but the plugin forks `session.refresh()` during plugin activation (`antigravity/index.ts:30-33`), which calls `ensure()` and spawns `agy acp` on every server start. `Effect.forkScoped` starts immediately. This contradicts both the comment and the commit body's "started on first use" claim.
- A rejected `opened` promise is cached forever (`session.ts:48,51-54`). If `agy` is missing or times out once, every later turn fails with the same error until the server restarts; there is no retry/backoff.

### 3.2 Permissions and modes

- `answer` refuses every permission request by default: it selects `reject_once`, or `cancelled` if no reject option exists (`acp.ts:282-293`). The plugin never passes `Options.permission` (`antigravity/index.ts:25,77`), so the host has no way to answer. Every edit/command the CLI asks about is denied. The docs say "a permission request is refused unless the host answers it" (`antigravity.mdx:36-37`; `spec.md:64-65`), but this provider has no host-answer path at all; the default mode is effectively read-only.
- The capability exists (`Options.permission` at `acp.ts:92-99`), and OpenCode exposes `ctx.permission` (`packages/plugin/src/effect/plugin.ts:53`); it is simply not wired. There is no auto-approve switch (`--dangerously-skip-permissions`) and no `setSessionMode`.
- `session/new` returns `modes` and `configOptions` (`ref/notes/agy-acp-handshake.log:205-228`), but `toSession` discards them (`acp.ts:296-302`). `session/set_mode` is never called, so plan/accept-edits/auto are unavailable from OpenCode.

### 3.3 Session lifecycle, history, and side calls

This is the largest architectural problem after model selection.

- `AntigravitySession.make` is per plugin/location and opens **one** ACP session per working directory (`index.ts:25`; `session.ts:47-68`). It does not receive an OpenCode session id. Every OpenCode session, title request, compaction, and `generate` request in that directory shares the same CLI conversation and the same model.
- There is no per-session lock or queue. `Client.prompt` stores a single listener in a `Map<sessionId, ...>` (`acp.ts:212`), and concurrent prompts overwrite it; the first prompt's `finally` then deletes the second prompt's listener (`acp.ts:242-244`). Different OpenCode sessions run concurrently by design (`SessionRunCoordinator`), so this is reachable in normal use, not just a stress case.
- Title generation uses the primary provider when no small model exists (`packages/core/src/session/context.ts:111-146`; `Model.small` at `packages/core/src/model.ts:308-320`), so the title prompt is appended as an ordinary user turn to the user's CLI conversation. Compaction and `generate` do the same. `readPrompt` sends only the last user text (`language-model.ts:87-99`); the `kind` (`primary`/`title`/`compaction`/`generate`) and the side-call system prompt are discarded. Claude Agent handles this with `RequestKind` + a throwaway/side process (`claude-agent/language-model/claude-agent-language-model.ts:42-61`; `claude-agent/claude/sessions.ts:28-41`). Antigravity has no equivalent.
- History divergence: the CLI owns the conversation, while OpenCode reloads and re-sends its own history on each step. Any retry, edit, or regenerate after the CLI already saw a prompt duplicates that turn; any CLI-side compaction is invisible to OpenCode. `readPrompt` also sends `"[continue]"` when the last user message has no text (image-only or system-only), which is a literal instruction to the model.
- `resume` is defined (`acp.ts:194-198`) but never called; nothing persists an ACP session id. Worse, `toSession` requires `sessionId` (`acp.ts:117-125,296-302`), but the ACP `ResumeSessionResponse` has no `sessionId` field (verified in `ref/typescript-sdk/src/v1/schema/types.gen.ts:2446-2464`; `NewSessionResponse` at `:2094-2100` does). So the latent resume path would fail decoding even if wired.
- `Client.close` only kills the child (`acp.ts:247-251`) and is called only when `newSession` fails (`session.ts:81-83`). There is no `session/close`, no plugin finalizer, and no `session.deleted`/`idle` handling. The child and ACP session live for the server process; a reload or workspace change can leave a second process behind. Claude Agent has per-entry close/idle handling and a finalizer (`claude-agent/claude/sessions.ts:119-157`) and reacts to `session.deleted` (`claude-agent/index.ts:37-55`).
- `spawnCLI` swallows post-spawn `error` events (`acp.ts:262-272`), so a crashed CLI is not reported or restarted; pending prompts fail through the stream close, and `opened` remains resolved to a dead client.

### 3.4 Update mapping

`toUpdate` handles only four ACP update kinds (`acp.ts:304-327`); `render` maps them to stream parts (`language-model.ts:107-134`).

- **Tool calls are broken on a normal lifecycle.** ACP sends `tool_call` first and then one or more `tool_call_update` events with the same `toolCallId`. For both kinds, `render` emits a fresh `tool-call` **and** a `tool-result` (`language-model.ts:114-132`). OpenCode's runner dies on a duplicate call or duplicate result: `Duplicate tool call` / `Duplicate tool result` (`packages/core/src/session/runner/publish-llm-event.ts:493-523`, especially `:499,515,522`). Thus the first update after a tool call defects the step. Even with a single event, the provider publishes a successful result for `status: "pending"`/`"in_progress"`, before the tool has run.
- **Tool names change.** `tool_call_update.name` is optional; the code falls back to `update.title` (`acp.ts:317-323`). A later update without `name` therefore changes the tool name from, say, `read_file` to `read /tmp/x`; the runner dies on `Tool call name changed` (`publish-llm-event.ts:497-499`).
- **Arguments and output are lost.** The result is only `{ status, title }` (`language-model.ts:125-130`); `rawOutput`, `content`, diffs, and terminal output are ignored. The initial `rawInput` is often absent and only arrives on an update, in which case it is discarded. Users see no command output or file diff.
- **Ignored updates:** `plan`, `plan_update`, `plan_removed`, `usage_update`, `config_option_update`, `current_mode_update`, `available_commands_update`, `session_info_update`, `notice`, `compaction_update`, `compaction_summary_chunk`, `subagent_update`, and message chunks are all discarded (`acp.ts:304-327`). The probe shows `usage_update`, `config_option_update`, `current_mode_update`, and `available_commands_update` in normal operation (`ref/notes/agy-acp-config.log:15,19,23-25,33-37,43-47`).
- **Finish reason is always `stop`.** `LanguageModelV3` accepts `length`, `content-filter`, `other`, etc. (`@ai-sdk/provider@3.0.19` `LanguageModelV3FinishReason`), but `doStream` always sends `{ unified: "stop", raw: turn.stopReason }` (`language-model.ts:58-62`). `max_tokens` truncation and `refusal` are reported as a clean stop; a `cancelled` stop reason also becomes `stop` (a local abort instead rejects the stream).
- **Usage is unreliable.** `usage()` uses `PromptResponse.usage` fields, treating them as per-turn (`language-model.ts:137-150`), but the ACP `Usage` documentation describes totals "across session". If the CLI sends no prompt usage, all fields become zero. `usage_update`'s `used`/`size` is ignored, so OpenCode cannot see context usage. `noCache` is set to the full input even when `cacheRead`/`cacheWrite` are present, overstating non-cached tokens.
- **Text/reasoning IDs are fixed** (`"text"`, `"reasoning"`; `language-model.ts:108-113`). Core tolerates missing starts and opens fragments on deltas (`packages/core/src/aisdk.ts:760-785,856-877`), but all message chunks are merged into one fragment, so text before and after a tool call is attributed to one part and ordering can be wrong.

### 3.5 Cancellation

- On abort, `Client.prompt` sends `session/cancel` and immediately rejects (`acp.ts:214-228`). It does not await the `session/prompt` response or the CLI's `cancelled` stop reason, and it removes the listener in `finally` (`acp.ts:242-244`). The CLI may still be running; the next prompt can race it. ACP explicitly says clients should keep accepting tool-call updates after cancel; this code drops them.
- The abort listener added at `acp.ts:223` is not removed when the prompt resolves. If the same signal is aborted later (for example during request cleanup), the code sends a `session/cancel` for a turn that has already finished, potentially cancelling the next turn on the shared session.
- `Model.doStream`'s `cancel` aborts and returns `task` (`language-model.ts:70-74`), but there is no timeout if the CLI never acknowledges; `Client.prompt`/`initialize`/`newSession` have no request timeout at all (`acp.ts:161-245`).
- No `session/close` on session deletion or turn teardown; no `closeSession` call anywhere.

### 3.6 Errors and restart behavior

- `spawn` errors are wrapped with a useful message, but only for the initial spawn (`acp.ts:262-272`). JSON-RPC/`auth_required`/invalid-params errors are rethrown raw; `Schema.decodeUnknownSync` failures (`acp.ts:297`) are raw `ParseError`s. There is no mapping to user-facing actions.
- `session.refresh` catches all errors and logs a warning (`index.ts:34-47`); the provider remains registered, possibly with cached models. There is no status/unavailable transition, so the UI cannot tell the user the CLI is missing or signed out.
- A failed `initialize`/`newSession` is cached in `opened` (`session.ts:48,51-54,81-84`); no retry. A crashed child after startup is ignored (`acp.ts:262-272`); no reconnect.
- `Client.close` does not await process exit or escalate to `SIGKILL` (`acp.ts:247-251`), and it never closes the ACP session gracefully.

### 3.7 Concurrency

- One ACP session per directory + no lock + one listener slot = at least three race classes: listener overwrite/loss (`acp.ts:212,242-244`), overlapping `session/prompt` calls (likely rejected or interleaved by the CLI), and model/effort changes from one OpenCode session affecting another (had selection been wired).
- `session.refresh` and `session.run` share `opened` but `run` never updates `groups` from `ready.groups` (`session.ts:58-66`); if a turn starts before refresh completes, any future model mapping that reads `groups()` sees an empty list.
- The catalog refresh/registration race is covered in Section 4.

---

## 4. Tests and PR claims

### 4.1 Test coverage

`packages/core/test/plugin/provider-antigravity.test.ts` exercises only pure functions:

- Catalog grouping and `resolveSlug` (`test:21-76`). The fixture is a fabricated six-entry list (`test:11-18`), not the 27-entry probe list; it omits the orchestrator and xhigh, and there is no `usage_update` test. The test therefore cannot catch the main catalog bug.
- `render` for one message (`test:77-82`), one completed tool call (`test:84-100`), and one lone `tool-call-update` (`test:102-109`). The last test actually enshrines the broken behavior: it expects an update to produce both a call and a result, but does not test the real `tool_call` followed by `tool_call_update` sequence, which the runner rejects as duplicate.
- `readPrompt` for a text-only prompt (`test:112-122`). No image-only, system-only, or side-call (`kind`) coverage.

Nothing tests:

- `Client.start`/`initialize`/`newSession`/`prompt`/`cancel`/`close`, or the ACP update decoding.
- `AntigravitySession.run` forwarding a model/effort; no fake transport is possible because `session.make` hardcodes `Client.start` (`session.ts:47-77`).
- `AntigravityProvider.register`/`cached`/`remember`, first-run empty models, refresh, or `provider.reload`.
- The `aisdk` hook, variant settings, `LanguageModelV3` usage/finish, or `doGenerate`.
- Permissions (refusal/allow), auth errors, cancellation, concurrency, resume, or close.
- `OPENCODE_ANTIGRAVITY_PATH`, missing CLI, or signed-out behavior.

The test layer is heavyweight (`PluginTestLayer`), but the tests never use it for anything but an Effect environment; they do not integrate with provider/model/AISDK state. A standalone-plugin version should add an injected ACP transport (or a `Client` interface) and test the actual sequence of `setSessionConfigOption` calls and stream parts.

### 4.2 PR claims vs code

The checkout has no PR description; the commit body at `0478f5d` and the spec/docs are the available claims.

| Claim | Verdict |
| --- | --- |
| "The model list comes from the account, so it is never written down here." | Production source has no hardcoded list, but the first run registers an empty provider and the refresh cannot update it; the list is only usable after a restart (Section 4.3). |
| "One model is registered per model with the effort levels as variants, the same shape the Claude Agent provider uses." | Mostly true for 8 of 9 real groups, but the orchestrator's Neon/Carbon/Argon are misclassified as efforts; and Claude Agent actually reads `settings.effort` (`claude-agent/language-model/claude-agent-language-model.ts:45-50`), while Antigravity ignores it. |
| "The agent runs its own tools, reported as provider-executed calls." | Intent is implemented (`render` sets `providerExecuted: true`), but the update mapping crashes or loses the result (Section 3.4). |
| "A permission request is refused unless the host answers it." | Requests are refused, but the host has no answer path; the plugin never passes a permission handler (Section 3.2). |
| "The CLI is started on first use." | False: `index.ts:30-33` starts it at plugin activation. |
| "The model list is kept between starts so the picker has the models before the CLI answers." | Only after a prior successful refresh. First run has no models; in-process refresh cannot add them (Section 4.3). |
| Spec: "The CLI can resume a session it already knows, which is what happens after the server restarts." | False: `resume` is unused and would fail decoding; no session id is persisted (`spec.md:53-57`; `acp.ts:194-198,296-302`). |
| Spec: "The CLI's own names make the split unambiguous." | False for the orchestrator (Section 2.2). |
| Docs: `OPENCODE_ANTIGRAVITY_PATH` | Not implemented (Section 3.1). |
| Docs: "The agent's own permission rules govern what it may change." | All permission requests are refused; the agent cannot edit/run unless the CLI is launched with its own bypass, which the provider cannot configure (Section 3.2). |

The workspace README mentions a second ChatGPT commit on the PR branch; this checkout contains only `0478f5d`, so that unrelated change is outside this audit.

### 4.3 The first-run / refresh bug in detail

`AntigravityProvider.register` starts with `if (editor.get(ID)) return` (`antigravity/provider.ts:37-48`). On first run:

1. `index.ts:26-27` reads the cache (empty) and calls `register(ctx, session.groups())`; `session.groups()` is `[]` until `refresh` runs (`session.ts:49`). The provider is added with `models: []`.
2. `index.ts:30-33` forks `session.refresh()`. When it resolves, `index.ts:41-43` calls `remember`, then `register(ctx, groups)`, then `provider.reload()`.
3. The second `register` sees the provider already exists and returns. `provider.reload()` re-runs the transforms in insertion order (`packages/core/src/state.ts:197-211`): the first transform re-adds the empty provider, and the second returns at the `editor.get(ID)` check. The models are never set.
4. The models are saved to storage by `remember` (`provider.ts:58-75`), so the next server start can register them from `cached` (`provider.ts:52-55`). The user must restart once; the docs do not say so.

The same early return means a plan upgrade/downgrade or a newly added Google model never appears in the running process, even though `remember` updates the cache for the next start. A correct implementation should keep a mutable groups reference in one transform and use `editor.models.set`/`update` (available in the public editor at `packages/plugin/src/effect/provider.ts:22-27`), or remove the early return and replace the model list. Claude Agent does the mutable-catalog + `reload` pattern (`claude-agent/provider.ts:50-90`).

---

## 5. Compatibility with OpenCode plugin API / SDK versions

**Plugin API.** The PR uses the current internal plugin shape correctly at the type level:

- `ProviderDomain.transform`/`reload` and `ProviderEditor.models.set/update` are public plugin contracts (`packages/plugin/src/effect/provider.ts:15-32`).
- `AISDKDomain`'s `sdk` hook carries `evt.model` and `evt.options` (`packages/plugin/src/effect/aisdk.ts:5-18`), so the missing variant wiring is not a version limitation.
- `Context` exposes `session` and `permission` domains (`packages/plugin/src/effect/plugin.ts:30-64`), and `SessionHooks["model.request"]` carries `sessionID`, `kind`, and mutable headers (`packages/plugin/src/effect/session.ts:65-90,207-223`). The per-session and side-call fixes are possible without core changes.
- `LanguageModelV3` from `@ai-sdk/provider@3.0.19` matches the shape used: `tool-call.input` is a JSON string, `tool-result.result` is JSON, and `finishReason` is `{unified, raw}`. The implementation is type-valid (subject to the tool-result caveats above).

**ACP SDK.** `@agentclientprotocol/sdk@1.6.0` is a direct core dependency (`packages/core/package.json:109`) and the lockfile pins it. Its 1.6.0 typings expose `initialize`, `newSession`, `resumeSession`, `closeSession`, `setSessionConfigOption`, `setSessionMode`, `authenticate`, `prompt`, and `cancel`. They do **not** expose `setSessionModel`; the probe's `session/set_model` is an `agy` extension. The constructor used here (`ClientSideConnection`) is marked deprecated in 1.6.0 in favor of `client({name}).connectWith(...)`, but it still works; it is a future-compat concern, not a current break.

**Runtime type issue.** `Client.resume` calls `toSession(response)` (`acp.ts:194-198`), whose payload requires `sessionId` (`acp.ts:117-125`). The stable `ResumeSessionResponse` has no `sessionId` (`ref/typescript-sdk/src/v1/schema/types.gen.ts:2446-2464`), so the method would throw `ParseError` even if called. This is latent because `resume` is dead code, but it will bite the first reuse attempt.

**Workerd / edge compatibility.** `acp.ts` statically imports `node:child_process` and `node:stream` (`acp.ts:15-17`), and the plugin is statically imported into core's provider list (`packages/core/src/plugin/provider.ts:2`; `packages/core/src/plugin/internal.ts:119,280`). The runtime guard in `index.ts:17-20` runs only after module evaluation. Claude Agent avoids this with a `workerd` package condition and a throwing stub (`packages/core/package.json:46`; `claude-agent/claude/agent-sdk.workerd.ts`). Antigravity has no equivalent. At minimum, verify the `packages/server/src/workerd.ts` bundle boots; preferably lazy-import the ACP module or add a workerd stub.

**Package/name.** `PACKAGE = "@opencode/antigravity"` (`antigravity/provider.ts:9`) is not a real package; it works only because the `sdk` hook supplies `evt.sdk` before `Provider.loadPackage` is needed (`packages/core/src/aisdk.ts:355-362`). A standalone plugin should use a real package id or a hook-only design with a documented fallback.

No compile errors were apparent from reading, but I did not run the repository's `bun typecheck`/`tsc` because dependencies are not installed.

---

## 6. Prioritized fix list for standalone reuse

### P0 — correctness / blocking

1. **Wire model + effort end to end.**
   - Extend `Session.Request`/`Dependencies.run` with `slug` and `effort` (or a `configValue` + optional `thoughtLevel`).
   - In the `sdk` hook, read `evt.model.settings?.slug`/`effort` (or `evt.options.slug`/`effort`) and bind them into the language-model instance; do not rely on `modelID` alone.
   - Before each prompt, call `setSessionConfigOption({configId:"model", value:<base-or-slot>})` and, for recognized efforts, `{configId:"thought_level", value:<effort>}`. Prefer `configOptions.model.options` as the allowed value set; use the `session/set_model` extension only behind a version check.
   - Preserve the slug for single-variant models (`gpt-oss-120b-medium`, `claude-opus-4-6-thinking`); do not send the stripped group id.
   - Add a fake ACP transport and assert the exact config calls for a multi-effort model, a single-variant model, and an orchestrator slot.
2. **Fix the tool-call state machine.**
   - Emit `tool-call` once on `tool_call`; on `tool_call_update`, emit only the terminal `tool-result` (`completed`/`failed`). Never emit a second call or a second result.
   - Keep a `toolCallId -> name` map so an update without `name` does not fall back to `title`; never change a name mid-call.
   - Map `rawOutput`, `content` (text/diff/terminal), and `rawInput`; do not publish a success result for `pending`/`in_progress`.
   - Test the real sequence `tool_call(status:pending) -> tool_call_update(status:in_progress) -> tool_call_update(status:completed)`, plus a name-less update and a failed update.
3. **Make the catalog update mutable.**
   - Keep a single groups ref and one `provider.transform` that calls `editor.models.set(ID, groups.map(toModel))`; or remove the `editor.get(ID)` early return and replace the models on every refresh.
   - Do not register an empty model list as the final state. Register the cached list if present; otherwise defer or immediately replace it when `refresh` resolves.
   - Remove stale models on plan downgrade, or keep them only if the CLI confirms them.
   - Test first run, cached run, refresh, changed account/plan, and `provider.updated`.
4. **Stop sharing one ACP conversation across all OpenCode sessions.**
   - Use `ctx.session.hook("model.request", ...)` to carry `sessionID` and `kind` into the request (the Claude Agent pattern).
   - Keep a `Map<OpenCode sessionID, ACP session>`; create with `session/new` for primary turns, serialize with a per-session semaphore, and use a throwaway ACP session for title/compaction/generate (or return a different model for those kinds).
   - Persist the ACP session id per OpenCode session and resume it after restart; fix `toSession` to accept the requested id for `ResumeSessionResponse`.
   - Close with `session/close` on `session.deleted`/idle and add a plugin finalizer that closes the client/child.

### P1 — usability / safety

5. **Bridge permissions and modes.**
   - Pass an `Options.permission` handler from the plugin that maps ACP `allow_once`/`reject_once`/`allow_always` to `ctx.permission.ask`/`assert` (or provide an explicit auto-approve config switch). Do not silently refuse every edit/command.
   - Read `modes` from `session/new`, expose them, and call `setSessionMode`; at minimum map OpenCode's plan mode.
6. **Auth, path, status, and retries.**
   - Implement `OPENCODE_ANTIGRAVITY_PATH` with `which("agy")` fallback, or remove the docs claim.
   - Handle `auth_required`/`authMethods` with an actionable error and an optional `agy acp --login`/`authenticate` flow.
   - Add a status/probe like Claude Agent and do not advertise cached models when the CLI is missing or signed out.
   - Replace the sticky `opened` rejection with retry/backoff; report child exit.
7. **Cancellation, timeouts, and cleanup.**
   - Await the prompt's `cancelled` response after `session/cancel`; keep the listener until then.
   - Remove the abort listener in `finally`; guard against a stale cancel.
   - Add request timeouts for `initialize`/`newSession`/`prompt`; close/kill the child on timeout; handle `SIGKILL` fallback.
   - Close ACP sessions on delete/idle and on plugin teardown.
8. **Complete the update mapping.**
   - Map `usage_update` (`used`/`size`) into context/usage; map `config_option_update`/`current_mode_update` into provider state; surface `notice`/`plan` at least as text/reasoning or log them.
   - Map `finishReason`: `max_tokens -> length`, `refusal -> content-filter`, `cancelled -> other`; stop emitting `stop` for everything.
   - Fix usage `noCache` and avoid double-counting `thought`/`output`; handle missing prompt usage.
   - Use distinct text/reasoning ids or close fragments at turn boundaries.
9. **Correct the catalog semantics.**
   - Read `currentModelId` and `configOptions` at session creation; use `thought_level` for efforts and `model` for base/slot values.
   - Keep orchestrator Neon/Carbon/Argon as separate model values or a distinct "backend" variant kind; do not send them as `thought_level`.
   - Override the default 200k/32k limits with the CLI's `usage_update.size`/known limits; advertise image input only if images are forwarded, or drop them from `capabilities.input`.
   - Give `Model.small` a usable family (`gemini-flash`, `gemini-flash-lite`, `claude-haiku`) or accept that titles use the primary model, and isolate side calls regardless.
   - Use an allowlist for effort suffixes; do not treat every parenthetical as effort.

### P2 — polish / portability

10. **Tests, docs, and compatibility.**
    - Add the transport-injection tests above; replace the fabricated catalog fixture with the real 27-entry probe list and add orchestrator/xhigh/1M cases.
    - Update the docs/spec: remove or implement `OPENCODE_ANTIGRAVITY_PATH`, stop claiming resume/picker-before-CLI behavior, and describe the permission limitation accurately.
    - Add a workerd stub or lazy import for `node:child_process`; verify the workerd bundle.
    - Consider migrating off deprecated `ClientSideConnection` to `client({name}).connectWith` when convenient.
    - When extracting to a standalone plugin, replace core-only helpers (`Provider.aisdk`, `Model.Info.default` via core re-export) with `@opencode/schema/*` and a literal `aisdk:` package, and keep only public plugin domains (`provider`, `aisdk`, `session`, `permission`, `storage`, `event`).

---

## Appendix — probe evidence used

- Handshake: `ref/notes/agy-acp-handshake.log:2` (auth methods/capabilities), `:89,203` (`currentModelId = gemini-4-neon-high`), `:151-161` (orchestrator names/slugs), `:205-228` (modes), `:230-338` (configOptions: model 11 values, thought_level, mode).
- Config behavior: `ref/notes/agy-acp-config.log:8-17` (set model base then thought_level), `:22-25` (a qualified `model` value returns a base model; the log is ambiguous about whether the effort was applied, so the stable path is base + `thought_level`), `:34` (`usage_update` 0/1048576), `:15,19,23-25,33-37,43-47` (config/mode/commands updates).
- `set_model` extension: `ref/notes/agy-acp-set-model.log:6-19` (accepts effort-qualified ids; returns `{}`; no configOptions).
- ACP stable types: `ref/typescript-sdk/src/v1/schema/types.gen.ts:2094-2121` (`NewSessionResponse` has `sessionId` + modes/configOptions), `:2446-2464` (`ResumeSessionResponse` has no `sessionId`).
