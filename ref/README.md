# Antigravity × OpenCode ACP 调研资料

调研时间：2026-11-22。当前环境：OpenCode `v2.3.2`，Antigravity CLI / ACP Server `1.5.14`，Google AI Ultra 账号，Linux x86_64。

这个目录是给“在官方内置 provider 落地前，先做一个独立 OpenCode 插件，通过 ACP 调用 Antigravity”准备的参考资料。所有仓库都是浅克隆（`--depth 1`），只用于阅读和试验，不是可直接发布的源码树。

## 0. 合规边界：thin ACP vs 反代/冒充（先读）

你的理解基本正确，但需要加一个关键限定：**不是“ACP 一律允许”，而是“unmodified `agy acp` 在 thin client 里允许”**。Google Antigravity 论坛在 2026-11-20 有一个直接针对 OpenCode 的 ToS clarification，原文（节选）：

> **Consumer `oauth-personal` Boundary:** Launching unmodified `agy acp` interactively is permitted only in a thin client where **Antigravity is the agent**—meaning the human sends raw prompts directly to `agy acp` and Antigravity owns its sign-in, system prompt, tools, and session history. Wrapping `agy acp` inside an outer third-party coding agent harness (such as OpenCode) that injects system instructions, serialized tool definitions, replayed cross-model context, or automated loops is **not** permitted on `oauth-personal`—even without extracting OAuth tokens—and risks automated enforcement or suspension.
>
> **Compliant Path:** For an outer agent harness, authenticate via `gemini-api-key` (`GEMINI_API_KEY`) or Google Cloud `agent-platform` … passing explicit ACP `authenticate` or running `/logout` so cached consumer OAuth is not reused.

Source: <https://discuss.ai.google.dev/t/tos-clarification-is-opencode-antigravity-acp-official-agy-acp-in-opencode-permitted-under-the-antigravity-terms-of-service/202970/2>

把它拆成三类：

| 形态 | 结论 |
| --- | --- |
| 提取/重放 OAuth token、反代私有端点、伪造 IDE/API header、把 `agy -p` 包进第三方 agent | **不允许**。FAQ 明确说 `agy -p` 在 consumer plan 下不支持；Section 6 也覆盖“第三方软件访问 Service”。 |
| unmodified `agy acp`，thin client，Antigravity 是 agent，人类把 raw prompt 直接发给它，Antigravity 拥有 sign-in/system prompt/tools/session history | **允许**（论坛回复原文）。 |
| `agy acp` 包在 outer harness 里，且注入 system instructions、serialized tool definitions、replayed cross-model context 或 automated loops | **consumer `oauth-personal` 不允许**；OpenCode 被点名。outer harness 应改用 `gemini-api-key` 或 `agent-platform`。 |

所以你的总结“反代/冒充不允许，ACP 允许”方向是对的；准确说法是“**thin ACP 允许，outer-harness 注入不允许**”。FAQ 的宽泛措辞仍然点名 OpenCode；论坛回复是更具体的澄清，但它不是 Terms/FAQ 正文，属于官方论坛答复，仍有解释空间。

PR #65430 引用的“unmodified `antigravity-acp` + `oauth-personal` 是 compliant”其实是这个论坛回复的转述，不是 FAQ 原文；PR 省略了“thin client / 不得注入 outer harness 状态”的条件，所以不能直接拿来当无条件许可。

本项目的定位是 **strict-thin**：清空 OpenCode 的 system/tools，只发当前 user turn，不做 cross-model replay，不做 MCP relay/Code Mode，不做 automated loops，不读 token、不反代、不伪造 header、不包 `agy -p`。按论坛回复的措辞，这落在“thin client”一侧；但因为 OpenCode 被点名，插件仍要求显式 `allowConsumerAuth: true` 作为边界确认。若以后加 MCP relay/Code Mode/cross-model handoff，就应切到 `gemini-api-key` 或 `agent-platform`。

## 目录索引

| 目录 | 内容 | 版本 / commit |
| --- | --- | --- |
| `opencode-pr-65430/` | OpenCode PR #65430 的 head 分支，内置 `antigravity` provider 的完整实现 | `0478f5d`，2026-11-21 |
| `agent-client-protocol/` | ACP 官方协议仓库：v1 稳定规范、v2 preview、JSON Schema、文档 | `5633156`，2026-11-21 |
| `typescript-sdk/` | ACP 官方 TypeScript SDK | `2.9.1`，`ab16fb0` |
| `acp-registry/` | ACP Agent 注册表，含 `antigravity-acp` 的官方二进制分发信息 | `d47c621`，2026-11-21 |
| `antigravity-cli/` | Google 官方 Antigravity CLI 仓库（**只有 README / CHANGELOG / examples，没有源码**） | `b9f5bf4`，2026-11-21 |
| `antigravity-sdk-python/` | Google 官方 Python Antigravity SDK 源码（Apache-2.0，但运行时是闭源二进制 wheel） | `97c5c53`，2026-11-18 |
| `opencode-antigravity-acp/` | 第三方 OpenCode 插件，已发布 npm，直接驱动 `agy acp` | `58ec40b`，v0.2.0，2026-11-21 |
| `opencode-antigrvity/` | 另一套 OpenCode V2 provider 适配器，ACP SDK 1.4.0，212 个测试 | `2d1894f`，v0.6.5，2026-11-16 |
| `pi-antigravity-acp-provider/` | Pi 的 Antigravity ACP provider，协议/权限/认证/配额处理非常完整 | `6d6135d`，2026-11-21 |
| `notes/` | 本机对 `agy acp` 的真实握手/配置探测脚本和日志 | 见下 |

## 1. PR #65430 的情况

- 链接：https://github.com/anomalyco/opencode/pull/65430
- 标题：`feat(core): add the Google Antigravity provider`
- 作者：`AKOrojo`，分支 `AKOrojo:feat/antigravity-provider`，head `0478f5d793dd12ba5b67694f71f9323841e9c1f4`
- 目标：`anomalyco:dev`
- 状态：**open + draft**，`mergeable: true` / `mergeable_state: blocked`，`+1288 / -52`，17 个文件，**0 review、0 comment**（截至 2026-11-22）
- 分支上有 **2 个 commit**：`0478f5d`（Antigravity provider）+ `683bb48`（`fix(core): make the ChatGPT model sync additive instead of subtractive`）。第二个是 ChatGPT 相关改动，PR 里也带了 `chatgpt.ts` / `provider-chatgpt.test.ts` 的修改；虽然可能是作者基于该 commit 开发，但和 Antigravity 无直接关系，PR checklist 却写了“没有无关改动”，这点值得在 review 时拆开。
- 关联 issue：#65419（内置 Antigravity ACP provider 提案）、#28889（早先的 Antigravity CLI connector 请求，已 closed as not planned）
- 时间线：2026-11-21 先开 #65419，机器人回复“等 maintainer 决定后再做 PR”；同日作者直接开了 draft PR。目前没有 maintainer 明确接受。

### 它做了什么

在 `packages/core/src/plugin/provider/antigravity/` 增加一个**内置 provider**（不是外部插件）：

- `index.ts`：注册 provider，启动时先用缓存 catalog 注册模型，再后台 `session.refresh()` 拉取账号模型。
- `provider.ts`：`ctx.provider.transform` 注册 `Google Antigravity`，`package: "aisdk:@opencode/antigravity"`，把模型 catalog 存入 `ctx.storage`。
- `aisdk.ts`：通过 `ctx.aisdk.hook("sdk", ...)` 提供 `LanguageModelV3`。
- `antigravity/acp.ts`：用 `@agentclientprotocol/sdk@1.6.0` 的 `ClientSideConnection` 启动 `agy acp`，实现 `initialize`、`session/new`、`session/resume`、`session/prompt`、`session/cancel`、`close`。
- `antigravity/catalog.ts`：把 CLI 的 `models.availableModels` 按显示名里的 `(High)/(Medium)/(Low)` 分组成模型 + variants。
- `antigravity/session.ts`：每个工作目录一个 ACP session，首次使用时才启动 CLI。
- `language-model/antigravity-language-model.ts`：把 ACP `session/update` 映射成 `LanguageModelV3` 的 `text-delta`、`reasoning-delta`、`tool-call`、`tool-result`、`finish`。
- 测试：`packages/core/test/plugin/provider-antigravity.test.ts`，8 个测试，主要覆盖 catalog 分组、`resolveSlug`、文本/工具渲染。
- 设计文档：`specs/v2/antigravity-provider.md`；用户文档：`services/site/src/docs/content/antigravity.mdx`。

### 它做对的地方

- 走 `agy acp`，不碰 `agy -p`。PR 引用的“FAQ 允许 unmodified antigravity-acp + oauth-personal”其实是 Google 论坛回复的转述，不是 FAQ 原文；而且 PR 省略了 thin-client / 不注入 outer harness 状态的条件。见第 0 节。
- 模型列表来自账号 `session/new`，不是硬编码。
- 不转发 OpenCode 的 system prompt / tools，避免把 OpenCode 的工具描述注入给 Antigravity（“thin ACP”思路）。
- CLI 懒启动，catalog 缓存，pickpicker 不用等 CLI。
- provider-executed tool call 的总体方向正确：Antigravity 自己执行工具，OpenCode 只展示，不重复执行。

### 关键问题 / 审阅发现

1. **模型选择没有真正生效（最大的功能 bug）**
   - `AntigravitySession.run()` 收到 `request.model`，但调用 `client.prompt()` 时**完全没有使用它**：`antigravity/session.ts:63-66`。
   - `AntigravityCatalog.resolveSlug()` 只在测试里出现，生产路径没有调用。
   - 结果：无论用户在 OpenCode 里选哪个模型/variant，`session/prompt` 都用 ACP session 的当前默认模型。本机实测默认是 `gemini-4-neon-high`。
   - 本机验证：`session/set_model` 可以接受 effort-qualified ID 并返回 `{}`；`session/set_config_option` 的 `model` 只接受 base ID，`thought_level` 单独设置。见 `notes/agy-acp-set-model.log`。
2. **用显示名解析 effort，会把不同模型误合并**
   - 真实 catalog 里有 `Orchestrator (Neon)`、`Orchestrator (Carbon)`、`Orchestrator (Argon)`。PR 的 `splitName()` 会把括号里的 `Neon/Carbon/Argon` 当成 reasoning effort，最终合并成一个 `gemini-pro-orchestrator` 模型，三个不同后端变成 variants。
   - 真实 `session/new` 已经返回了规范的 `configOptions`：`model`（base model）+ `thought_level`（low/medium/high/xhigh）+ `mode`。应该以 `configOptions` 为准，而不是解析显示名。
   - 而且 `thought_level` 的可选值会随模型变化：切到 `gemini-3.8-flash` 时 `xhigh` 消失，切回 `gemini-4-neon` 又出现。PR 静态分组会给出无效 variant。
3. **没有认证流程**
   - 只依赖用户已经 `agy` 登录；没有 `authenticate`，没有 `agy acp --login`，没有处理 `auth_required`，没有 logout。
   - 真实 `initialize` 会返回 `oauth-personal`、`oauth-business`、`gemini-api-key`、`agent-platform` 四种 authMethods。
4. **没有权限集成**
   - `answer()` 默认拒绝所有 `session/request_permission`（`acp.ts` 末尾），所以 Antigravity 默认不能改文件/跑命令。PR 文档也明确写了“refused by default”。
   - 对“在 OpenCode 里用 Antigravity 写代码”来说，这基本不可用；需要把 ACP permission 映射到 OpenCode 的 permission/模式，或至少提供 `--dangerously-skip-permissions` 的显式开关。
5. **session/update 映射太薄**
   - 只处理 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`。
   - 忽略 `usage_update`、`current_mode_update`、`config_option_update`、`available_commands_update`、`plan`、`subagent_update` 等。
   - `render()` 对每个 `tool_call`/`tool_call_update` 都同时发 `tool-call` + `tool-result`，pending/in_progress 也发 result，容易重复/错序；应该在开始发 tool-call，完成/失败时只发一次 tool-result。
   - 不支持 image / embedded context，虽然 Antigravity 的 `promptCapabilities` 明确支持 image + embeddedContext。
6. **一个目录一个 session，且没有恢复**
   - `AntigravitySession.make({ directory })` 每个工作目录只开一个 ACP session，所有 OpenCode session 共用；`resume()` 方法存在但从未使用。
   - OpenCode server 重启后直接 `session/new`，不恢复旧 ACP session；对话历史会丢。
   - 文档写“One CLI session per working directory”，对单用户简单场景可以，但和 OpenCode 的 session 语义不一致。
7. **prompt 只取最后一条 user 文本**
   - `readPrompt()` 只取最后一条 user message 的 text part，丢弃图片/附件；不转发历史，靠 ACP session 自己保存上下文。
   - 这是有意的“thin ACP”，但对图片、文件附件、跨 session 切换不完整。
8. **没有在真实 OpenCode server 里验证**
   - PR body 自己说：“what is not tested is the provider inside a running opencode server, which needs a build of this branch.”
   - 测试只覆盖 catalog 和 render，没有覆盖“选模型后真的切换”“permission 流程”“真实 prompt”。
9. **SDK 版本偏旧**
   - PR 用 `@agentclientprotocol/sdk@1.6.0`（和 `packages/cli` 一致）；当前 SDK 已到 `2.9.1`，Antigravity 1.5.14 也暴露了 `sessionCapabilities`、`configOptions` 等新能力。
   - 如果只是最小实现，1.6.0 够用；但要做 auth/config/permission，建议用 2.x 的 `/unstable` 入口或像 `opencode-antigravity-acp` 一样直接实现 NDJSON JSON-RPC。
10. **PR 前景**
    - draft、无 review、无 maintainer 表态；此前 ACP client mode / Claude Code ACP runtime 的 PR 和 issue 大多被关闭或自动关闭（见第 4 节）。
    - 因此“等官方内置”不现实，独立插件是合理路线。

## 2. Antigravity 有没有源码可以拉？

**结论：没有可用的 Antigravity CLI / ACP Server 源码。** 官方只开源了文档仓库和一个 Python SDK 的外壳。

| 仓库 | 是否有源码 | 说明 |
| --- | --- | --- |
| `google-antigravity/antigravity-cli` | ❌ | 只有 `README.md`、`CHANGELOG.md`、`examples/statusline`、`examples/title`。无 LICENSE，CLI 本体闭源。 |
| `google-antigravity/antigravity-sdk-python` | ⚠️ 部分 | Apache-2.0 Python SDK 源码；但 README 明确说运行时是平台相关的编译二进制，只在 PyPI wheel 里，克隆仓库不能直接跑。不是 ACP server 源码。 |
| ACP 的 `antigravity-acp` 条目 | ❌ | ACP registry 只提供 Google 的闭源 `agy_acp_server.par` / `.exe` 下载地址、sha256 和启动参数。 |

本机 `agy` 是一个约 261 MB 的 stripped ELF；调研过程中它从 `1.5.7` 自动更新到了 `1.5.14`，`agy acp` 的 `agentInfo.version` 也是 `1.5.14`。`agy acp --help` 的关键参数见 `notes/agy-cli-info.txt`，包括：

- `--stdio`（默认）
- `--process-per-session`（每个 session 独立 worker 进程，推荐）
- `--login`（ACP terminal auth，交互式 Google 登录后退出）
- `--sandbox`
- `--dangerously-skip-permissions`
- `--app-data-dir` / `--gemini-dir` / `--log-file`
- `--ide-mcp-port`（host IDE tools MCP，需要 `nc`）

ACP registry 里的 `antigravity-acp` 分发信息（`acp-registry/antigravity-acp/agent.json`）：

- 版本：`1.5.2`（registry 的版本比本机 `agy acp` 旧）
- 许可：`proprietary`
- Linux：`agy_acp_server.par`，启动参数 `--uid=`
- macOS：`agy_acp_server.par`
- Windows：`agy_acp_server.exe`
- 下载源：`https://dl.google.com/agy-extensions/releases/...`

如果插件只支持“已安装并登录的 `agy`”，直接用 `agy acp` 最省事。如果想支持没装 CLI 的用户，可以像 `opencode-antigrvity` 一样从 ACP registry 下载 `agy_acp_server.par`，但要注意版本、`localharness_external` 伴随二进制、sha256、可执行权限和 ToS。

## 3. ACP 协议规范 / SDK

### 已拉下来的仓库

- `agent-client-protocol/`：官方协议仓库，Apache-2.0。
  - 稳定协议版本：`protocolVersion: 1`；v2 是 preview。
  - JSON Schema：`schema/v1/schema.json`、`schema/v1/schema.unstable.json`、`schema/v2/*`。
  - 文档：`docs/protocol/v1/*.mdx`（initialization、authentication、session-setup、prompt-turn、tool-calls、file-system、terminals、session-config-options、session-modes、cancellation、session-list/delete、subagents 等）。
- `typescript-sdk/`：官方 TypeScript SDK，Apache-2.0，`2.9.1`。
  - 默认入口是稳定 ACP v1；`@agentclientprotocol/sdk/unstable` 包含 draft 字段（如 `PromptResponse.usage`）。
  - `client({ name }).connectWith(stream, ...)` 是新 API；老 API 是 `ClientSideConnection` + `ndJsonStream`。
  - 示例：`src/examples/client.ts`、`src/examples/agent.ts`。
- `acp-registry/`：ACP Agent 注册表，含 `antigravity-acp` 分发条目。

### 关键方法

ACP 是 JSON-RPC 2.0，stdio 上用 NDJSON（一行一个 JSON）。

Client → Agent：

- `initialize`
- `authenticate` / `logout`
- `session/new`、`session/load`、`session/resume`
- `session/prompt`
- `session/set_mode`
- `session/set_config_option`
- `session/cancel`（notification）
- `session/close`、`session/delete`、`session/list`
- `session/request_permission`（Agent → Client 的 request）
- `fs/read_text_file`、`fs/write_text_file`（Agent → Client，需 client capability）
- `terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/kill`、`terminal/release`（Agent → Client，需 client capability）

Agent → Client 的 `session/update` 常见 variant：

- `agent_message_chunk`
- `agent_thought_chunk`
- `tool_call` / `tool_call_update`
- `usage_update`
- `current_mode_update`
- `config_option_update`
- `available_commands_update`
- `plan` / `plan_update`
- `session_info_update`
- `subagent_update` 等

### 本机真实探测结果

脚本和完整日志在 `notes/`：

- `probe-agy-acp.mjs` / `agy-acp-handshake.log`：只做 `initialize` + `session/new`，不发 prompt，不消耗推理配额。
- `probe-agy-acp-config.mjs` / `agy-acp-config.log`：验证 `set_config_option`、`set_mode`、`session/close`。
- `probe-agy-acp-set-model.mjs` / `agy-acp-set-model.log`：验证 `session/set_model` 接受 effort-qualified ID。
- `agy-cli-info.txt`：`agy --version` + `agy acp --help`。

实测结果（`agy` 1.5.14，Google AI Ultra）：

`initialize`：

- `protocolVersion: 1`
- `agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" }`
- `agentCapabilities`：
  - `loadSession: true`
  - `promptCapabilities: { image: true, audio: false, embeddedContext: true }`
  - `sessionCapabilities: { resume, close, load, list, additionalDirectories }`
  - `auth: { logout: {} }`
  - `_meta.antigravity: { tier: true, systemPrompt: { append: true } }`
- `authMethods`：
  - `oauth-personal`（Log in with Google）
  - `oauth-business`（Gemini Enterprise）
  - `gemini-api-key`
  - `agent-platform`（Vertex / Gemini Enterprise Agent Platform）

`session/new`（`cwd` + `mcpServers: []`）：

- 返回 `sessionId`、`models.availableModels`（27 条，effort-qualified）、`models.currentModelId`（`gemini-4-neon-high`）
- `modes`：`default`、`accept-edits`、`auto`、`plan`
- `configOptions`：
  - `model`：11 个 base model，例如 `gemini-4-neon`、`gemini-4-carbon`、`gemini-4-argon`、`gemini-4-hydrogen`、`gemini-pro-orchestrator-neon`、`gemini-3.8-flash`、`claude-opus-5-5`、`claude-sonnet-5-5`、`gpt-oss-120b-medium`
  - `thought_level`：`low`、`medium`、`high`、`xhigh`（随模型变化）
  - `mode`：`default`、`accept-edits`、`auto`、`plan`
- `_meta.antigravity.tier`：`{ name: "Google AI Ultra", id: "g1-ultra-lite-tier", upgradeUri: ... }`

配置切换：

- `session/set_config_option { configId: "model", value: "gemini-3.8-flash" }` → 成功，`currentValue` 变为 `gemini-3.8-flash`；同时 `thought_level` 选项从 4 个变成 3 个（`xhigh` 消失）。
- `session/set_config_option { configId: "thought_level", value: "low" }` → 成功。
- `session/set_config_option { configId: "model", value: "gemini-3.8-flash-low" }` → **静默忽略**，`currentValue` 仍是 `gemini-3.8-flash`。所以不能把 effort-qualified ID 传给 `configOptions.model`。
- `session/set_model { modelId: "gemini-3.8-flash-low" }` → 返回 `{}`（接受）。这是 Antigravity 的旧/扩展方法，不在当前稳定 schema 里；`opencode-antigravity-acp` 就是先试 `set_model`，失败再回退到 `set_config_option`。
- `session/set_mode { modeId: "plan" }` → 返回 `{}`。
- `session/close` → 返回 `{}`。

> 没有在探测里发 `session/prompt`，避免消耗账号配额。`PromptResponse.usage` 是 ACP v1 draft 字段（`response.usage`），同时还有 `usage_update` 通知；实现时要两者都兼容。

## 4. 可参考的仓库 / 提交

### 4.1 最接近“独立插件”的现成实现

**`system1970/opencode-antigravity-acp`**（`ref/opencode-antigravity-acp/`）

- MIT，npm `opencode-antigravity-acp@0.2.0`，要求 OpenCode `>= 2.3.2`。
- 使用 `@opencode/plugin/effect`，provider id 是 `antigravity-acp`。
- 直接 spawn `agy acp --stdio --process-per-session`，自己实现 NDJSON JSON-RPC，不依赖 ACP SDK。
- 支持：
  - `authenticate`（`oauth-personal` 默认；`GEMINI_API_KEY` 走 `gemini-api-key`；可显式指定 `oauth-business`/`agent-platform`）
  - 动态 catalog（`availableModels` + `configOptions`，带 TTL 缓存）
  - `set_model` 优先、`set_config_option` 回退，支持 `thought_level`
  - ACP modes（auto / accept-edits / default / plan）
  - `ctx.permission.assert()` 权限集成
  - 可选 Code Mode MCP relay（默认 Pure ACP，`mcpServers: []`）
  - `session/resume`、进程/会话清理、GUI popover、`/agy-reset`、`/agy-reload`
- 安装：
  ```bash
  opencode plugin add opencode-antigravity-acp
  opencode service restart
  ```
  或 clone 到 `~/.config/opencode/plugins/`。
- 注意：
  - 它是第三方插件，不是 Google/OpenCode 官方；README 自己也写了 ToS 风险。
  - 默认 Pure ACP 会清空 OpenCode 的 system prompt/tools；Antigravity 原生工具不受 OpenCode permission 完全约束。
  - **审计发现（v0.2.0）**：新 session 默认 `mode: "auto"`，会 auto-approve 原生 ACP tool 权限，等于绕过 OpenCode 规则；usage 计算假设 gross input（实际 1.5.14 是 net input）；compaction/generate 请求没有被正确路由，会跑完整 ACP turn；`allowOpt` 会回退到 `opts[0]`，有错误放行风险；transport 缺少 frame/body cap 和 process-group cleanup。详见 `notes/audit-opencode-antigravity-acp.md`。
  - 适合作为“最快可用”的基线，或 fork 后按自己的需求改；不要直接把它当成生产安全实现。

**`rasyidrafi/opencode-antigrvity`**（`ref/opencode-antigrvity/`）

- MIT，`@rasyid_rafi/opencode-antigravity@0.6.5`。
- 使用 Promise plugin API（`@opencode/plugin` 的 `Plugin.define`），`@agentclientprotocol/sdk@1.4.0`，`LanguageModelV3` provider。
- 自动从 ACP registry 下载 `agy_acp_server.par`（1.3.0），不要求全局 `agy`；支持 `session/load`、session pool、模型 catalog 缓存、认证桥、host MCP tools、上下文 telemetry。
- 有 212 个测试，架构和测试覆盖很好，适合参考。
- 但它针对 OpenCode plugin `2.0.22`、ACP runtime `1.3.0`，比当前 OpenCode `2.3.2` / Antigravity `1.5.14` 旧；直接用可能需要升级和适配。它的 provider id 是 `antigravity`，和 PR #65430 的内置 provider 相同，不要和内置版/其他占用同一 id 的插件同时装。

### 4.2 最好的协议/边界条件参考

**`zacbemis/pi-antigravity-acp-provider`**（`ref/pi-antigravity-acp-provider/`）

- Pi 的 provider，ACP SDK 2.6.0。
- 文档非常完整，尤其：
  - `docs/PROTOCOL-MAPPING.md`：ACP → Pi 的 handshake、session、prompt、update、permission、tool 映射。
  - `docs/AUTH-PERMISSIONS-SECURITY.md`、`docs/RUNTIME-UPDATES.md`、`docs/ARCHITECTURE.md`。
- 关键经验：
  - 不要把 Antigravity 已执行的 native tool 映射成宿主可执行的 tool call，否则会重复执行。
  - 权限请求要保留 offered `optionId`，取消时返回 `{ outcome: "cancelled" }`。
  - `PromptResponse.usage` 可能是 draft；还要处理 `usage_update`。
  - 对 429/quota 要 fail-fast，不要紧循环重试。
  - 长 turn 用 inactivity watchdog，不要用固定总时长。
  - ACP v1 的 `session/load` 会 replay 历史；要抑制 replay 更新，避免旧消息当新生成。
- 它不是 OpenCode 插件，但协议层最值得抄。

### 4.3 OpenCode 的历史提交 / 讨论

- #65430：当前内置 Antigravity provider（draft）。
- #65419：内置 Antigravity ACP provider 提案；机器人让作者等 maintainer。
- #28889：早先 Antigravity CLI connector / Google OAuth 请求；maintainer 回复“not allowed”，后来作者用 ACP 重新解释。
- #60643、#47020、#58143：相关 Antigravity/Gemini 订阅接入请求，均关闭。
- #51646：ACP client mode（让 OpenCode 驱动外部 ACP agent，如 Codex/Claude Code），因模板问题自动关闭；被列为重复的 #28991、#5182、#24038、#18106、#35550 也都关闭/未实现。
- #41904 / #41901：Claude Code ACP runtime 的 draft PR，已关闭；作者说 standalone build 能列模型但真实 prompt 报 `ACP connection closed`。这是一个很好的“坑”参考。
- #46092：OpenCode 自己作为 ACP server 时 `PromptResponse.usage` 只报告最后一个 LLM request 的 token；说明 usage 语义要小心。
- #60316：OpenCode ACP server 的 `set_config_option` 在快速连续切换时可能返回上一个选择；客户端要能容忍/校验。
- OpenCode 现有 ACP server 实现在 `ref/opencode-pr-65430/packages/cli/src/acp/`，是 update/permission/session 翻译的好参考；`@agentclientprotocol/sdk` 已经是 `packages/cli` 的依赖（1.6.0）。

### 4.4 本目录的子报告

- [`notes/antigravity-official-docs.md`](./notes/antigravity-official-docs.md)：官方 ACP 页面、FAQ、ToS、CHANGELOG 的逐条抽取；**合规风险必读**。
- [`notes/audit-pr-65430.md`](./notes/audit-pr-65430.md)：PR #65430 的逐行审计（模型选择、tool 重复、首次启动空模型、session 共享、权限等）。
- [`notes/acp-plugin-checklist.md`](./notes/acp-plugin-checklist.md)：ACP v1 实现清单（initialize/auth、session、configOptions、update/permission、取消/配额、测试矩阵）。
- [`notes/audit-opencode-antigravity-acp.md`](./notes/audit-opencode-antigravity-acp.md)：现成插件 `system1970/opencode-antigravity-acp` 的架构/compat/安全审计（如果该文件已生成）。

### 4.5 不推荐的路线

- `opencode-antigravity-auth` / `opencode-agy-auth` / 各类 “Antigravity OAuth” 插件：走 OAuth token 提取或本地反向代理，不是 ACP；PR 和社区都指出这类做法容易违反 ToS/触发风控。这个项目的目标是 ACP，不要混用。
- `agy -p` 包装器：Google FAQ 明确说第三方 agent 包裹 print mode 在 consumer plan 下不支持，可能违反 Section 6。不要做。
- 各种 `antigravity-acp` wrapper（如 `shubzkothekar/antigravity-acp`、`simonepri/refined-antigravity-acp`）：需要逐个确认它们到底包的是 `agy acp` 还是 `agy -p`；如果是后者，不要用。

## 5. 如果自己糊一个独立插件，建议的架构

> 以下按当前环境的 OpenCode V2 / `@opencode/plugin` 2.3.x 写；V1 的 provider 注册 API 不同，不能直接照搬。

### 5.1 入口和 provider 注册

用 `@opencode/plugin/effect`（或 Promise API）：

```ts
import { Plugin } from "@opencode/plugin/effect"

export default Plugin.define({
  id: "antigravity-acp",
  effect: (ctx) => Effect.gen(function* () {
    // 1. 读缓存 catalog，先注册 provider，保证 picker 有模型
    // 2. 后台启动 agy acp，initialize + session/new，刷新 catalog
    // 3. ctx.provider.transform 注册 provider + models
    // 4. ctx.aisdk.hook("sdk") / ctx.aisdk.hook("language") 提供 LanguageModelV3
  }),
})
```

关键点：

- `package` 用自定义标识（如 `"aisdk:antigravity-acp"`），不要和内置 provider 冲突。
- `ctx.provider.transform` 的 `editor.add({ info, models })` 可以动态注册；`ctx.provider.reload()` 刷新。
- `ctx.aisdk.hook("sdk", ...)` 返回 `{ languageModel: (id) => new Model(...) }`；`language` hook 也要提供，二者都注册更稳（`opencode-antigravity-acp` 就是这么做的）。
- 通过 `ctx.session.hook("context", ...)` 清空/裁剪 OpenCode 的 system/tools（thin ACP），或只保留安全的 `AGENTS.md` 文本。
- 通过 `ctx.session.hook("model.request", ...)` 把 OpenCode `sessionID`、variant、request kind 放进 headers，供 `LanguageModelV3.doStream` 使用（插件 API 里没有直接传 sessionID 的参数）。
- 通过 `ctx.permission.assert()` 把 ACP permission 请求接到 OpenCode 的权限系统。
- 通过 `ctx.event.subscribe()` 监听 `session.execution.interrupted` / `failed` / `deleted`，取消/关闭 ACP turn 和进程。

### 5.2 ACP 客户端

- 启动：`spawn("agy", ["acp", "--stdio", "--process-per-session"], { cwd, stdio: ["pipe","pipe","pipe"] })`。
  - `--process-per-session` 让每个 ACP session 独立 worker，隔离更好。
  - 传 `cwd` 给 spawn；1.5.13 修复了“shell 命令在启动目录而不是 session 目录执行”的问题，但显式传更稳。
  - stderr 要持续读取，避免 pipe 满；保留最后 N KB 作为诊断。
- 传输：NDJSON，一行一个 JSON。建议用 `@agentclientprotocol/sdk`（2.9.1 的 `/unstable` 入口）或自己实现请求/通知/取消。
  - 自己实现的好处：不依赖 SDK 版本，和 `agy` 的扩展方法（如 `session/set_model`）兼容。
  - 用 SDK 的好处：类型、schema、client app、NDJSON 流、取消处理现成。
- `initialize`：
  - `protocolVersion: 1`
  - `clientCapabilities` 只声明你真正实现的：`fs.readTextFile` / `fs.writeTextFile` / `terminal`（如果做）；不做就不要声明。
  - `clientInfo: { name: "opencode-antigravity-acp", version }`。
- 认证：
  - 优先使用已登录的 `agy`；如果 `session/new` 返回 `auth_required`，调用 `authenticate({ methodId: "oauth-personal" })`。
  - 或者提供 `/agy-login` 命令，运行 `agy acp --login`（terminal auth）；SSH/headless 场景一定要支持。
  - 不要自己读 OAuth token / 伪造 header。
- `session/new`：
  - `{ cwd: absolutePath, mcpServers: [] }`（可选 MCP relay）。
  - 保存 `sessionId`、`configOptions`、`modes`。
  - 用 `configOptions.model` + `configOptions.thought_level` 构造 catalog；`models.availableModels` 只作为 fallback/补充。
- 模型/effort：
  - 优先 `session/set_config_option { configId: "model", value: baseModel }` + `{ configId: "thought_level", value: effort }`。
  - 如果 `agy` 接受 `session/set_model { modelId: effortQualifiedId }`，可以先试它（`opencode-antigravity-acp` 的顺序），失败再回退 config option。
  - 每次切模型后重新读 response 的 `configOptions`，因为 `thought_level` 可选值会变。
- `session/prompt`：
  - `{ sessionId, prompt: [{ type: "text", text }, ...] }`；图片用 `{ type: "image", data, mimeType }`（如果 `promptCapabilities.image`）。
  - 不要发 OpenCode 的 system prompt / tool schemas；Antigravity 自己读 `AGENTS.md`。
  - 只发当前 user turn，历史由 ACP session 保存；跨 session/重启用 `session/resume` 或 `session/load`，并处理 replay。
- 取消：
  - `session/cancel` notification；同时把 pending 的 permission 请求回 `{ outcome: { outcome: "cancelled" } }`。
  - 关闭：`session/close` + 杀进程；进程退出要 fail 所有 pending。
- 错误：
  - `auth_required` → 提示登录，不要无限重试。
  - 429/quota → fail-fast，显示 reset 时间；不要自动重试。
  - `ACP connection closed` → 收集 stderr，提示 `agy` 版本/日志。
  - 处理 `agy` 自动更新导致的版本变化，记录 `agentInfo.version`。

### 5.3 流映射

- `agent_message_chunk` → `text-delta`（同一条消息用稳定 id；跨 step 要正确关闭/重开）。
- `agent_thought_chunk` → `reasoning-delta`。
- `tool_call` → `tool-call`，`providerExecuted: true`；不要发可执行的 `tool-call` 给 OpenCode。
- `tool_call_update`：
  - `status: completed/failed` 时才发 `tool-result`；
  - `in_progress` 只更新 UI/状态，不要重复发 result；
  - diff/terminal content 可按需展示，但不要重复执行。
- `usage_update` → 上下文占用/成本；`PromptResponse.usage`（draft）→ finish usage；两者都兼容。
- `current_mode_update` / `config_option_update` → 更新本地 session 状态，不要当普通文本。
- `available_commands_update` / `plan` → 可选展示，不要盲目注册成 OpenCode 命令/工具。
- `subagent_update` → 可选；不要把它当普通 assistant 文本。

### 5.4 Session 生命周期

- 一个 OpenCode session ↔ 一个 ACP session（不要一个工作目录共用一个）。
- 持久化 `acpSessionId`（`ctx.storage` 或自己的 store），server 重启后：
  - 先 `session/resume`（不 replay）或 `session/load`（replay，需抑制旧消息）；
  - 失败再 `session/new`，并做 plain-text handoff（参考 `opencode-antigravity-acp` 的 `buildTextOnlyHandoffPromptBlocks`）。
- OpenCode `session.deleted` → `session/close` + 清理持久化。
- 中断/失败 → `session/cancel`，清理 pending permission/tool。
- 并发 turn：一个 ACP session 同时只能有一个 `session/prompt`；如果 OpenCode 发第二个，排队或拒绝。

### 5.5 打包

- `package.json`：
  - `"type": "module"`
  - `exports: { ".": "./src/index.ts" }`（OpenCode 目录插件会探测 `index`）
  - `peerDependencies: { "@opencode/plugin": "^2.3.2", "effect": "^4.1.0" }`
  - `dependencies`: `@agentclientprotocol/sdk`（如果使用）
- 安装：
  - npm 发布后：`opencode plugin add <package>`
  - 本地开发：放到 `~/.config/opencode/plugins/<name>/`，`opencode service restart`
- 不要 bundle `effect`；OpenCode 会注入 host runtime。
- README 里写清楚 ToS/安全边界：只驱动 `agy acp`，不读 token，不伪造 header，不包 `agy -p`。

## 6. 建议的下一步

**当前仓库已经有一个独立插件实现**（根目录 `src/`，不改 OpenCode 源码）：

- `src/acp/client.ts`：raw NDJSON ACP 客户端（initialize/new/resume/set_config_option/prompt/cancel/close、权限请求、协议 v1 校验、32 MiB frame cap、process group cleanup、Windows taskkill、write 失败即失败、stderr 脱敏）。
- `src/session.ts`：每个 OpenCode session 一个 ACP session；resume 保留原 ACP id/cwd；per-session turn lock；configOptions 模型/effort/mode；模型或 mode 切换失败会中止 turn；`plan` agent 映射 ACP `plan`；`ctx.permission.assert` 权限；取消时回滚 pending permission；start/dispose/close 生命周期处理。
- `src/language-model.ts`：LanguageModelV3 流映射；只取最后一条 user turn；text/thought/tool/usage；tool-result 只在终态发一次，pending tool 在 finish 时补 incomplete；usage 按 net input 处理；title/compaction 本地处理、generate 拒绝；缺 session header 直接报错；图片 URL/非图片文件给出可见 text note。
- `src/index.ts`：provider 注册、aisdk hooks、context/model.request/title/compaction/retry hooks、`antigravity.*` 强制 ask 的 permission hook、catalog 缓存 + fallback + 后台刷新、consumer auth gate、auto-discovery 的 `ANTIGRAVITY_ACP_ALLOW_CONSUMER`、ManagerRef 支持插件 reload、远程 workspace 跳过。
- 测试：`bun run test`（13 个单元测试）、`bun run test:integration`（mock ACP，端到端）、`ANTIGRAVITY_ACP_LIVE=1 bun test live.test.ts`（真实 handshake/config，无 prompt）。

接下来的路线：

1. **先用 API key / enterprise 或在明确接受风险后开启 `allowConsumerAuth`，跑一次真实 prompt**，验证真实 Antigravity 的 text/tool/permission 流。命令见根目录 README 的 Development 一节。
2. **补 v0.1 未做的能力**：`session/list`、`session/load` replay、`terminal-login`、elicitation、mid-turn steering、MCP relay/Code Mode、按模型动态更新 effort 选项、quota/429 fail-fast 的文本识别。
3. **或者 fork `system1970/opencode-antigravity-acp`**：它功能更全，但有默认 auto 模式、auto-approve、usage 计算、compaction 路由等审计问题；见 `notes/audit-opencode-antigravity-acp.md`。如果 fork，先修这些再使用。
4. **不要**从 PR #65430 直接抄生产路径：它的模型选择没有生效、tool-result 会重复、首次启动模型为空、session 共享；见 `notes/audit-pr-65430.md`。

如果目标是“今天就能在 OpenCode 里用 Antigravity”，并且接受 consumer ToS 风险，当前实现已经可以试；如果目标是“长期可维护、低风险”，建议先把 auth path 切到 API key/enterprise，再补上面第 2 条的能力。

## 7. 复现探测

```bash
cd ref/notes
node probe-agy-acp.mjs            # initialize + session/new，不发 prompt
node probe-agy-acp-config.mjs     # set_config_option / set_mode / close
node probe-agy-acp-set-model.mjs  # session/set_model，effort-qualified ID
```

这些脚本会启动本机 `agy acp --stdio`，只做握手和配置，不消耗推理配额；但会创建/关闭 ACP session。日志里的账号 tier、模型列表来自本机账号，贴出去前注意脱敏。

仓库默认只跟踪 `notes/*.md`、`notes/*.txt` 和 `probe-*.mjs`；`notes/*.log`、`notes/*.html`、`notes/*.json` 是本地快照，已被 `.gitignore` 忽略。需要复现时运行上面的 probe 脚本重新生成。审计报告里对 `.log` 的行号引用是本地验证记录，克隆仓库后没有这些日志文件。

## 8. 合规提醒

- **不允许**：提取/重放 OAuth token、反代私有端点、伪造 IDE/API header、把 `agy -p` 包进第三方 agent、account rotation。FAQ 明确说 `agy -p` 在 consumer plan 下不支持；Section 6 覆盖“第三方软件访问 Service”。
- **允许（consumer `oauth-personal`）**：unmodified `agy acp` 在 thin client 中运行，Antigravity 是 agent，人类把 raw prompt 直接发给它，Antigravity 拥有 sign-in、system prompt、tools、session history。
- **不允许（consumer `oauth-personal`）**：把 `agy acp` 包在 outer harness 中并注入 system instructions、serialized tool definitions、replayed cross-model context 或 automated loops；论坛回复点名 OpenCode。outer harness 应使用 `gemini-api-key` 或 `agent-platform`。
- 本项目的实现是 strict-thin；`allowConsumerAuth: true` 是对 thin-client 边界的显式确认。若以后加 MCP relay/Code Mode/cross-model handoff，应切到 `gemini-api-key`/`agent-platform`。
- 论坛回复不是 Terms/FAQ 正文，仍有解释空间；最终以 Google 的 Antigravity Terms / FAQ / 官方答复为准。这份笔记只是技术调研，不是法律意见。

详细证据：[`notes/antigravity-official-docs.md`](./notes/antigravity-official-docs.md)；论坛澄清：<https://discuss.ai.google.dev/t/tos-clarification-is-opencode-antigravity-acp-official-agy-acp-in-opencode-permitted-under-the-antigravity-terms-of-service/202970/2>。
