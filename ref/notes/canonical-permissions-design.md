# 设计：把 ACP tool kind 映射到 OpenCode canonical permission action

状态：design v3.2 + implementation，三路代码评审 **CONVERGED**（GLM-5.3 / DeepSeek-1017 / Kimi-K3.1-Pro，2026-11-22）。
目标版本：`opencode-antigravity-acp-local` 后续版本；不改 OpenCode 源码。

## 1. 问题

当前 `SessionManager.permission()` 把 ACP `session/request_permission` 映射成：

```text
action = "antigravity." + (tool.kind ?? tool.name ?? "tool")
resources = tool.locations[*].path，否则 [title]
metadata = { tool, title, rawInput }
```

例子：Antigravity 想执行命令，`action = "antigravity.execute"`。OpenCode TUI 的
`permissionPresentation` 不认识这个自定义 action，走 generic fallback：

```text
⚙ Call tool antigravity.execute
Tool: antigravity.execute
```

用户看不到真实命令/路径，只能盲批；为了减少弹窗只能用很粗的
`antigravity.* allow`。

## 2. 目标与非目标

目标：

1. TUI 显示有意义的标题和参数：
   - `Shell command` + 命令行
   - `Edit /path`
   - `Read /path`
   - `Web Search via Antigravity "query"`
   - `WebFetch URL`（如果 Antigravity 实际发出 fetch permission）
2. 用户可以使用 OpenCode 已有规则，例如：

```jsonc
"permissions": [
  { "action": "shell", "resource": "*", "effect": "allow" },
  { "action": "edit", "resource": "*", "effect": "ask" }
]
```

3. 保持安全语义：
   - 插件 `permission: "ask"` 下，没有显式用户规则时仍然 ask；headless 无人应答时 reject。
   - `permission: "allow"` / `"deny"` 行为不变。
   - 旧 `antigravity.*` 规则继续生效；旧 ask/deny 优先于新 canonical allow。
   - 内建 agent 的 allow 规则不能被当成用户规则而自动放行。
4. 只改变 permission 的 action/资源/展示，不伪造工具执行。

非目标：

- 不做 OS 级 sandbox。
- 不绕过 Antigravity 自己的 permission/policy。
- 不实现 OpenCode `save` /“Always allow”；当前 plugin API 不暴露 saved rules。
- 不做 shell 命令解析/分段；MVP 只支持 `*` 或精确整条命令。
- 不改变 `agy -p`、token、反代等合规边界。

## 3. Action 映射（fail closed）

ACP ToolKind（v1 schema）：

```text
read | edit | delete | move | search | execute | think | fetch | switch_mode | other
```

| ACP kind | OpenCode action | TUI 展示 | resources |
| --- | --- | --- | --- |
| `read` | `read` | `Read /path` | 路径 |
| `edit` | `edit` | `Edit /path` | 路径 |
| `execute` | `shell` | `Shell command` | command |
| `search` + `name: search_web` + query | `websearch` | `Web Search via Antigravity "query"` | query |
| `search`（其他） | `antigravity.search` | generic | 旧 resources |
| `fetch` + URL | `webfetch`（fixture-gated） | `WebFetch URL` | URL |
| `fetch`（无 URL） | `antigravity.fetch` | generic | 旧 resources |
| `think` | `antigravity.think` + auto-allow | 通常不弹 | title |
| `delete` | `antigravity.delete` | generic | 旧 resources |
| `move` | `antigravity.move` | generic | 旧 resources |
| `switch_mode` | `antigravity.switch_mode` | generic | 旧 resources |
| `other` / unknown | `antigravity.other` | generic | 旧 resources |

重要细节：

- 只有提取到必需参数时才使用 canonical action：
  - execute 没有 command → `antigravity.execute`；
  - edit/read 没有 path → `antigravity.edit` / `antigravity.read`；
  - search 不是 `search_web` 或没有 query → `antigravity.search`；
  - fetch 没有 URL → `antigravity.fetch`。
  这样 `shell * allow` / `edit * allow` 不会因为缺少参数而放行未知目标。
- `delete` / `move` **不**归到 `edit`。否则用户的 `edit * allow` 会顺带允许删除/移动。
- `think` 没有副作用；`permission: "ask"` 下仍走一次 `ctx.permission.assert`，由 hook 自动
  allow，除非用户显式配置了 `antigravity.think` 的 deny/ask。`permission: "deny"` 下拒绝。
  如果没有 `allow_once` 选项，think 也必须 reject，不能选 `allow_always` 来绕过一次性语义。
- `switch_mode` 改变 agent 行为，保持 namespaced ask。
- `delete` / `move` / `switch_mode` / `other` 走 TUI generic fallback。TUI 对 generic action
  只显示 `Call tool <action>` / `Tool: <action>`，不显示 title 或 resources；这是接受的
  展示限制，不声称这些 kind 有 informative display。
- 规则解析接受历史别名：`bash` → `shell`，`write` / `patch` / `apply_patch` → `edit`。
  新代码只 emit canonical 名。

## 4. 参数规范化

新增 `src/permission-policy.ts`：

```ts
export interface PermissionPlan {
  readonly action: string
  readonly resources: readonly string[]
  readonly legacyAction: string
  readonly legacyResources: readonly string[]
  readonly metadata: Record<string, unknown>
}

export function permissionPlan(tool: ToolCall, requestID: string): PermissionPlan
```

### 4.1 tool-call cache（D3）

ACP `session/request_permission.toolCall` 只保证 `toolCallId`；`kind`、`rawInput`、
`locations` 可能来自之前的 `session/update`。

`SessionState` 增加：

```ts
toolCalls: Map<string, {
  kind?: string
  name?: string
  title?: string
  rawInput?: unknown
  locations?: Array<{ path?: string }>
}>
```

规则：

- `tool_call` / `tool_call_update` 到达时，**先更新 cache，再转发给 active renderer**。
- cache 按 `toolCallId` 合并，遵循 ACP v1 patch 语义：
  - `rawInput` / `rawOutput` / `name`：字段不存在或为 `null` 都保留旧值（ACP 文档明确
    omission/null 等价；不能因为一次只有 `toolCallId` 的 permission 请求清空参数）。
  - `kind` / `title`：为保守起见，字段不存在或为 `null` 也保留旧值；只有具体字符串才覆盖。
  - `locations` / `content`：具体数组整体替换；`null` 表示清空集合。
  - 初始 `tool_call` 中不存在/null 的字段就是“暂无值”。
- permission 请求的 `params.toolCall` 按同样规则 overlay 到 cache，再生成 plan。
  `{toolCallId}` 或 `{toolCallId, kind}` 不得擦除缓存中的 `rawInput`/`locations`/`title`。
- cache 值有界：
  - `rawInput` 序列化后超过 64 KiB 则丢弃（保留“过大”标记），后续用 title/namespaced
    fallback，不把截断值当成命令/路径。
  - `locations` 最多 32 条；超过则设置 `overflow`，permission plan 强制 namespaced + ask，
    不做 canonical auto-allow。
  - 不缓存 `content` / `rawOutput`（permission 提取不需要）。
- 每个 session 最多 256 条，LRU；每次 `run` 开始时清空，`close`/`dispose` 清理。
- 未知/已 evict 的 `toolCallId`：如果 permission 请求只有 ID，按 title → `antigravity.other`
  处理；没有 title 则 `antigravity.other` + `["Antigravity tool"]`，仍可 ask，不伪造命令/路径。
- `kind`/`name` 都缺失或不是已知 ToolKind → `antigravity.other`；如果 `kind` 是 `execute` 但
  没有 command，则 `antigravity.execute`，不是 `shell`。
- 非 conforming 的 permission 请求（没有 `params.toolCall` 或没有 `toolCallId`）→ 返回
  `{ outcome: "cancelled" }`，不进入 permission UI。
- 这是 execute/edit/fetch 能显示真实参数的前提。

### 4.2 rawInput 类型、路径和大小

ACP `rawInput` 是任意 JSON 值（对象、数组、字符串、数字、布尔、null）。提取规则：

- 只有 **plain object** 的 `rawInput` 才按 key 提取；数组/字符串/数字/布尔/null 一律视为
  没有可用字段，不能 `JSON.stringify` 后猜命令/路径。
- 命令、路径、URL、pattern 必须是 **非空 string**；number/boolean/array/object 一律视为缺失。
- 路径规范化：
  - 绝对路径：保留并做 `path.normalize`；
  - 相对路径：用 `path.resolve(state.cwd, value)`（ACP location 应为绝对路径，rawInput 可能不是）；
  - 展示和 legacy matching 保留规范化后的字符串；Windows 分隔符由 `Wildcard.match` 归一化。
- 路径去重：按规范化后的字符串去重；最多 32 条，超过则 `overflow`，强制 namespaced + ask。
- 命令/URL/pattern 超过 64 KiB 视为缺失（namespaced fallback），**绝不把截断后的值**
  放进 canonical resources 做精确 allow。
- 空字符串/纯 whitespace 的 command/path/URL/pattern 视为缺失。

### 4.3 execute

命令提取顺序：

```text
rawInput.CommandLine
rawInput.command
rawInput.commandLine
rawInput.cmd
rawInput.cmdline
rawInput.shellCommand
```

只有 string 值有效。没有命令、命令超过 64 KiB、或 cache `overflow` → `antigravity.execute`
（namespaced fallback）。有命令：

```text
action = "shell"
resources = [command]          // 只放命令，不追加 locations
```

不把 locations 追加到 resources，否则“精确命令 allow”会因为第二个 resource 不匹配而失效。
locations 仍放进 legacyResources，供旧 `antigravity.*` 规则使用。

### 4.4 edit / read / delete / move

路径提取顺序：

```text
tool.locations[*].path
rawInput.Path
rawInput.path
rawInput.filePath
rawInput.file_path
rawInput.FilePath
rawInput.TargetFile
rawInput.targetFile
rawInput.AbsolutePath
rawInput.absolutePath
rawInput.target
```

- 只有 string 值有效；相对路径按 4.2 规范化。
- `edit` / `read`：去重、非空路径作为 resources；没有路径或 `overflow` 则 namespaced fallback。
- `delete` / `move`：保持 namespaced，resources 用旧 resources（locations 或 title）。
  `move` 的 source/destination 不映射到 `edit`，避免 TUI 只显示 `Edit source` 而隐藏 destination；
  TUI 会走 generic fallback，这是明确的展示限制。需要精细规则时用 `antigravity.move` legacy 规则。

### 4.5 search

真实 Antigravity 工具清单里没有本地 grep/glob；唯一搜索工具是 `search_web`：

```text
name = "search_web"
kind = "search"
rawInput.query = "..."
title = "\"...\" on Web"
```

如果收到 `kind: "search"` 且 `name: "search_web"` 且有 string `query`：

```text
action = "websearch"
resources = [query]
metadata.query = query
metadata.provider = "antigravity"
```

TUI 会显示 `Web Search via Antigravity "query"`。其他 `kind: "search"`（没有 capture 证明的
shape）走 `antigravity.search` namespaced fallback，不猜 grep/glob。

### 4.6 fetch

只有收到带 string URL 的 `kind: "fetch"` 才映射 `webfetch`。当前 Antigravity 1.5.14 的
工具清单没有独立 fetch 工具；在拿到真实 permission frame 之前，这条 mapping 是
implementation-gated：没有 fixture 就保持 `antigravity.fetch` namespaced ask。

### 4.7 旧 resources（legacy matching 关键，D1b）

旧版插件用：

```text
legacyAction = "antigravity." + (tool.kind ?? tool.name ?? "tool")
legacyResources = tool.locations[*].path，否则 [title]
```

新旧 action/resources 必须**同时保留**：

| 用途 | action | resources |
| --- | --- | --- |
| TUI / canonical 规则 | `shell` / `edit` / ... | command / path / URL / pattern |
| 旧 `antigravity.*` 规则 | `antigravity.execute` / ... | 旧 locations / title |

否则旧规则 `antigravity.execute` + `/workspace/*` deny 会因为 resources 变成 command 而失效。

### 4.8 metadata 最小化

不传完整 `rawInput`。只传：

```json
{
  "antigravity": {
    "provider": "antigravity-acp",
    "version": 1,
    "requestID": "...",
    "kind": "execute",
    "tool": "run_command",
    "legacyAction": "antigravity.execute",
    "autoAllowThink": false
  },
  "tool": "run_command",
  "title": "Run command",
  "kind": "execute",
  "paths": ["/workspace/a"],
  "query": "optional websearch query",
  "provider": "antigravity",
  "url": "https://example.com/path?token=REDACTED"
}
```

- 截断：title 512 B、path 2 KiB、paths 最多 32 条、URL 2 KiB、query 1 KiB。
- **只截断 metadata 展示值；canonical resources 使用完整值**（受 4.2 的 64 KiB/32 条上限）。
  如果完整值超过上限，直接 namespaced fallback + ask，绝不用截断后的字符串做精确 allow。
- `metadata.url` 仅用于 TUI 展示；对 query 中 `token|key|secret|password|sig|auth`
  一类参数做 redaction。resources 里保留真实 URL 供规则匹配。
- shell 命令只放在 `resources`；TUI 的 shell fallback 会显示 `- <command>`。
- `metadata.antigravity` 是识别标记，不是安全边界；同用户插件可以伪造。
- `requestID` 用于 marker 丢失时的 in-flight 关联。

### 4.9 真实 Antigravity 1.5.14 frame 校准

已用 `agy acp --stdio --process-per-session` + `oauth-personal` 捕获真实 permission：

| kind | tool | 关键 rawInput / 其他字段 | permission |
| --- | --- | --- | --- |
| execute | `run_command` | `rawInput.CommandLine`、`WaitMsBeforeAsync`、`toolSummary`；无 locations | 有，`allow_once`/`reject_once` |
| read | `read_file` | `rawInput.Path`；`locations[].path` | 有 |
| edit | `write_file` | `rawInput.Path`、`Content`、`Overwrite`；`locations`；`content:[{type:"diff",...}]` | 仓库内文件有；`/tmp` 文件被 Antigravity 自动放行，未发 permission |
| search | `search_web` | `rawInput.query`；kind `search` | 自动放行，未发 permission |
| fetch | 无独立工具 | 未捕获 | n/a |

结论：

- `Path`（大写 P）必须加入 path 提取；execute 的 `CommandLine` 已确认。
- edit 的 `content` diff 当前不渲染，TUI 显示 `No diff provided`；这是 MVP 接受的限制。
  以后可以合成 bounded unified diff 放进 `metadata.files[0].patch`，但不是本设计的前置条件。
- `search_web` 映射到 `websearch`，不是 `grep`。Antigravity 没有本地 grep/glob 工具。
- **Antigravity 自己的策略可能不请求 permission**（例如 `/tmp` write、`search_web`）。插件只能
  gate 它收到的 `session/request_permission`；自动放行的工具不在插件控制范围内。这是
  “permission 是 UX gate，不是 sandbox”的具体含义。
- canonical mapping 的启用范围：execute / read / edit / search_web（已有真实 toolCall 或
  permission frame）。fetch、edit_file、invoke_subagent、run_workflow 等没有真实 frame 的
  类型保持 namespaced；不凭猜测启用。
- `fetch`/`webfetch` mapping 在拿到真实 permission frame 前保持 namespaced。

## 5. Hook 识别：marker + 进程级 pending registry

### 5.1 为什么需要 registry

正常路径下 `ctx.permission.assert` 的 metadata 会原样到 hook。但为了 marker 丢失
（其他插件改写、未来 API 变化）时不误判成 OpenCode 自己的 shell/edit，增加一个
in-flight registry。

`src/permission-registry.ts` 使用：

```ts
Symbol.for("opencode.antigravity.permissionRegistry")
```

挂在 `globalThis`，跨 plugin 重载/多实例共享：

```ts
interface PendingPermission {
  requestID: string
  sessionID: string
  action: string
  resources: readonly string[]
  legacyAction: string
  legacyResources: readonly string[]
  expiresAt: number
}
```

- `permission()` 在 `ctx.permission.assert` 前注册，`finally` 注销。
- TTL 60 秒，最多 128 条，注册/注销时清理过期项。
- hook 查找顺序：
  1. `metadata.antigravity.requestID` 精确命中；
  2. 否则按 `sessionID + action + resources` 找未过期的 pending；
  3. 否则如果 marker 存在，用 marker + `metadata.paths`/`title` 重建；
  4. 否则如果 action 以 `antigravity.` 开头，按 legacy-only 处理；
  5. 否则不是 Antigravity 请求，hook 不干预。
- marker 存在但格式非法，或 canonical action 在 registry 中找不到：**强制 ask**，不静默放行。
- registry 不是安全边界，只用于关联同一用户进程内的请求。

### 5.2 为什么忽略 `input.effect`

OpenCode 传给 hook 的 `input.effect` 已经混合了：

- 内建 agent 规则（例如 explore 的 `shell * allow`）；
- 用户 agent/session 规则；
- 不可见的 saved rules。

直接相信它会把内建 allow 当作用户授权（GLM BD-1(a)），也无法区分 saved allow。
因此 hook **不直接采用** `input.effect`；它从 agent/session 规则中按来源重新计算
canonical 和 legacy 两组显式用户规则。

## 6. 规则解析

### 6.1 提取显式用户 canonical 规则（GLM BD-1(a)）

OpenCode 的 agent 规则顺序是：

```text
Agent.Info.default 基线
  + 内建 agent 附加规则（plugin/agent.ts、plugin/plan.ts）
  + 全局 config permissions
  + 该 agent 的 config permissions
```

`ctx.agent.get()` 返回合并后的数组，没有 provenance。设计采用**已知版本 + 已知前缀
精确匹配**：

- 仅当 `ctx.app.version` 是受支持版本（当前 `2.3.2`）时启用 canonical auto-allow。
- 每个已知 agent 维护完整内建前缀：
  - 所有 agent 的基线：
    `[*/* allow, read *.env ask, read *.env.* ask, read *.env.example allow]`
  - `build`: 基线 + `question * allow`
  - `general`: 基线 + `question * deny` + `subagent * deny`
  - `explore`: 基线 + `* * deny` + `shell/grep/glob/webfetch/websearch/read * allow`
    + `read *.env ask` + `read *.env.* ask` + `read *.env.example allow`
    + `subagent * deny` + `external_directory * allow`
  - `plan`: 基线 + `question * allow` + `edit * deny` + `edit <planDir>/* allow`
  - `title` / `summary`: 基线 + `* * deny`
  - `compaction`: 基线
  - 未知 agent ID：基线
- 只有 `rules.slice(prefix.length)` 才算用户显式规则。
- 前缀不匹配、版本未知、或 `ctx.agent.get` 失败 → 用户 canonical 规则视为空；
  **canonical auto-allow 关闭**，只保留 legacy 规则和默认 ask。
- session permissions 全部视为显式用户/运行时规则（它们不包含内建基线）。
- 旧 `antigravity.*` 规则不需要这个前缀匹配，直接从全部规则中按 action 过滤。

这样：

- explore 的内建 `shell * allow` 不会被当成用户 allow；
- plan 的内建 `edit <planDir>/* allow` 也不会；
- 新版本如果改了内建规则，最坏结果是“canonical 规则不生效、回到 ask”，不是静默放行。

### 6.2 两组规则的 effect

规则匹配使用 OpenCode `Wildcard.match` 的精确语义（复制实现，不依赖未公开导出）：
`\` 归一化为 `/`、`*`、`?`、dotall、Windows 大小写、结尾 `" .*"` 特例。

**Canonical 组**：

```ts
resolveExplicit(canonicalRules, canonicalAction, canonicalResources)
```

- 每个 resource 取最后一条匹配规则（`findLast`）。
- 任一 resource 命中 `deny` → deny。
- 任一 resource 命中 `ask` → ask。
- 所有 resource 都有匹配且都是有效 `allow` → allow。
- 有 resource 没有匹配，或没有有效 allow → `undefined`（不算显式允许）。
- shell 的 allow 额外限制（见 6.3）。
- 别名规则：`bash`/`write`/`patch`/`apply_patch` 参与匹配；别名 allow 只在
  `input.effect === "allow"` 时算有效，避免把 OpenCode 本来会 ask 的请求升级成 allow。
- catch-all `*/*` **不**算显式规则；全局 `* allow` 不能 auto-allow，全局 `* ask` 也不会
  压过更具体的 canonical allow。这与 OpenCode 的 `findLast` 一致：更具体的后置规则胜出。
- saved rules 不在 agent/session 规则里，因此不会出现在 `canonicalRules`；它们只能通过
  `input.effect` 影响别名 allow 的判断，不能让 canonical allow 生效。默认 fail closed。

**Legacy 组**：

```ts
resolveExplicit(legacyRules, legacyAction, legacyResources)
```

- 使用旧 resources/action。
- `deny` / `ask` 同上。
- allow 必须覆盖**所有**旧 resources，才可 auto-allow。
- 旧 `antigravity.* allow` 保持旧版 broad allow 语义；文档建议迁移。
- 旧规则里的 catch-all `*/*` 不算显式规则。

### 6.3 Shell 安全（D2）

`resources = [command]` 只用于展示和匹配。canonical `shell` allow 规则：

- `resource === "*"` → 显式 broad allow；
- resource 不含 `*`/`?` 且与当前 command **完全相等** → allow；
- 其他含通配符的 allow（如 `git *`）→ **降级为 ask**；
- `deny` / `ask` 规则不受此限制，照常生效。

结果：

```text
shell * allow                 -> 允许（用户显式接受 compound command 风险）
shell "git status" allow      -> 只允许完全相等的命令
shell "git *" allow           -> 不自动放行，转 ask
shell "rm *" deny             -> 只匹配整条命令等于/符合该模式的请求；
                                 不会解析 "git status && rm -rf /"
```

MVP 不解析命令分段。文档明确：`shell * allow` 等于信任 Antigravity 的 shell；
细粒度 allow 只支持 `*` 或精确整条命令。

### 6.4 最终判定

```ts
const canonical = resolveExplicit(canonicalRules, action, resources, { shell: action === "shell" })
const legacy = resolveExplicit(legacyRules, legacyAction, legacyResources, { shell: false })

if (canonical === "deny" || legacy === "deny") return "deny"
if (canonical === "ask" || legacy === "ask") return "ask"
if (canonical === "allow" || legacy === "allow") return "allow"
if (marker.autoAllowThink && action === "antigravity.think") return "allow"
return "ask"  // 没有显式用户规则：默认 ask，headless 由 assert 拒绝
```

注意：

- `autoAllowThink` 只对 `antigravity.think` 生效；显式 `antigravity.think` deny/ask 仍然优先。
- OpenCode core 在 hook **之前**执行 configured-deny fast-path：如果 canonical action 在任一
  resource 上最终为 deny，hook 根本不会被调用。因此内建 deny 仍然生效：
  - explore 的 `* deny` 会让没有 built-in allow 的 canonical action（如 `edit`）直接 deny；
  - title/summary 的 `* deny` 直接 deny；
  - plan 的 `edit * deny` 对 plan 目录外的 edit 直接 deny。
- 内建 allow 不会 auto-allow；它只会让 hook 看到 allow，然后由本设计强制 ask（除非有显式
  用户规则）。所以 explore 不是“所有 kind 都 ask”：`shell`/`read`/`websearch` 等有 built-in
  allow 的 kind 会 ask；`edit` 等只有 `* deny` 的 kind 会 upstream deny。
- canonical 用户 allow 如果 appended 在内建 deny 之后，OpenCode core 会 allow，hook 可正常允许。
  legacy `antigravity.* allow` 匹配的是旧 action，不匹配 canonical action，因此**不能**覆盖
  内建 canonical deny；需要覆盖时用 canonical allow 或 `permission: "allow"`。这是明确的
  兼容性取舍。
- 旧 `antigravity.*` ask/deny 与 canonical ask/deny 同权，按 deny > ask > allow 合并。
- 旧 `antigravity.* allow` 与 canonical allow 同权；但任何一方的 deny/ask 都胜出。
- saved rules 不可见；TUI “Always allow” 不会绕过默认 ask（插件不传 `save`）。

## 7. 兼容性

- 旧 `antigravity.*` 规则继续生效，且使用旧 action/resources 匹配。
- 旧 ask/deny 优先于新 canonical allow。
- `permission: "allow"` / `"deny"` 不变。
- `permission: "ask"` 下无显式规则仍 ask；headless reject。
- 规则解析接受 `bash`/`write`/`patch`/`apply_patch` 别名。
- 新 canonical 规则只在受支持的 OpenCode 版本上启用 auto-allow；未知版本 fail closed。
- README 更新：
  - 推荐 `shell`/`edit`/`read`/`websearch` 规则；`grep`/`glob`/`webfetch` 仅在真实工具/fixture
    出现时使用，不推荐给当前 Antigravity 1.5.14。
  - 旧 `antigravity.*` 规则仍兼容，并使用旧 resources；
  - `shell` 通配符限制：`*` 或精确命令，其他通配转 ask；
  - `shell allow` / `websearch allow` 同时影响 OpenCode 自己的对应工具；
  - 未知 OpenCode 版本上 canonical 规则只展示、不 auto-allow；
  - `delete`/`move` 不归入 `edit`；
  - 插件只能 gate Antigravity **实际发出的** permission；auto-approve 的工具不在 gate 内。

## 8. 安全 / UX 取舍

- `shell allow` 是跨 provider 的：允许 OpenCode shell 也允许 Antigravity shell。
- `websearch allow` 同样跨 provider：允许 OpenCode websearch 也允许 Antigravity `search_web`。
- Antigravity 可能对 `write_file`（如 `/tmp`）或 `search_web` 自动放行而不发 permission；
  插件只能 gate 收到的请求，不能把 auto-approve 变成 ask。
- `metadata.antigravity` 不是安全边界；同用户插件可伪造。最坏结果是 ask/deny，不是静默 allow。
- canonical action 只改善 TUI 展示，不改变 Antigravity 原生工具以用户 OS 权限执行的事实。
- 内建 agent 规则不参与最终 gating；默认 ask 是安全基线。
- `think` 通常自动 allow，但显式 `antigravity.think` ask/deny 仍生效。
- 不传完整 `rawInput`；metadata 有界并 redact URL secrets。
- saved “Always allow” 不可见；不实现。
- `delete`/`move` 保持 namespaced，避免 `edit allow` 扩大为删除/移动。

## 9. 测试计划

### 9.1 单元：映射与 cache

- `permissionPlan` 对 10 种 kind 的 action/resources/legacyAction/legacyResources/metadata。
- execute 命令提取所有 key；缺失 → `antigravity.execute`。
- edit/read 路径提取 locations/rawInput；去重；缺失 → namespaced。
- search 的 `search_web` + query → `websearch`；其他 search → namespaced。
- move 保持 namespaced。
- fetch 无真实 fixture 时保持 namespaced；有 URL fixture 才测试 `webfetch`。
- 非 object/错误类型的 rawInput 不产生 command/path/URL/pattern。
- 相对路径按 cwd 规范化；Windows 分隔符；重复路径去重。
- delete/move/switch_mode/other → namespaced。
- tool-call cache：permission 只有 `toolCallId` 时从之前的 `tool_call_update` 提取参数。
- cache overlay：`{toolCallId}` / `{toolCallId, kind}` 不清空 `rawInput`/`locations`；`rawInput:null` 保留；
  `locations:null` 清空；LRU 256；超过 32 locations → overflow。
- 字符串截断、paths 去重、URL redaction；超过 64 KiB 的 command/path/URL/pattern → namespaced ask。
- 真实 frame fixtures：在实现前用临时捕获（redacted）采集 Antigravity 1.5.14 的 execute/edit/read/search/fetch
  permission frames，放到 `test/fixtures/antigravity-1.5.14/`；每个 key 矩阵都要有真实样例。
  捕获不到的类型保持 namespaced fallback，不声称 canonical display。

### 9.2 单元：内建前缀与规则解析

- `build` 基线 + `question allow` + 无用户规则 → execute/read/edit/fetch/websearch 全部 ask。
- `explore` 内建规则集 + 无用户规则：
  - `shell`/`read`/`websearch` 等有 built-in allow 的 kind → hook 看到 allow，但无显式规则 → ask；
  - `edit` 等只有 `* deny` 的 kind → OpenCode core 在 hook 前直接 deny（不是 ask）。
  - 两种结果都不是 auto-allow；headless 均 reject。
- `plan` 内建 `edit <planDir>/* allow` 不算用户 allow；plan 目录外 edit → core deny。
- 未知版本 + 内建规则 + 无用户规则 → ask 或 upstream deny（取决于 built-in deny），都不是 allow。
- 未知版本 + 用户 `shell * allow` → canonical auto-allow 关闭，ask；legacy allow 仍可 allow。
- 自定义 agent（基线 + 用户 `shell * allow`）→ allow。
- 前缀不匹配（模拟未来内建规则）→ canonical auto-allow 关闭。

### 9.3 单元：规则语义

- canonical `shell * allow` → allow。
- canonical `shell "git status" allow` + command 完全相等 → allow。
- canonical `shell "git *" allow` → ask。
- canonical `edit deny` / `edit ask` → deny / ask。
- canonical `websearch * allow` → allow；`websearch query` 规则按 resources 匹配。
- 多 resource：`edit /a allow` + resources `[/a, /b]` → ask；`[/a, /a2]` 都有规则 → allow。
- 多规则同一 resource：最后一条生效。
- 全局 `*/* allow` 与 `*/* ask` 都不算显式规则：无其他规则 → ask；有 `shell "git status" allow` → allow。
- saved allow 模拟：`input.effect=allow` 但 agent/session 无显式规则 → ask；插件不传 `save`。
- 别名 `bash`/`write`/`patch`/`apply_patch`；别名 allow 不把 `input.effect=ask` 升级为 allow。
- 旧 `antigravity.* allow` → allow。
- 旧 `antigravity.execute "/workspace/*" deny` + 新 command resource → 仍按旧 locations deny。
- 旧 `antigravity.execute ask` + canonical `shell * allow` → ask。
- 旧 `antigravity.* allow` + canonical `shell * deny` → deny。
- 旧 `antigravity.* allow` + canonical `shell * ask` → ask。
- explore + 仅 legacy `antigravity.* allow` + edit → OpenCode core 先 deny，hook 不运行（兼容性限制）。
- explore + canonical `edit * allow` appended 在内建 deny 之后 + edit → allow（core 不 fast-deny）。
- 只有 `*/* allow` → ask。
- 非 Antigravity canonical action 且无 marker/registry → hook 不干预。

### 9.4 marker / registry

- marker 丢失但 registry 命中 → 仍按 Antigravity 规则解析，不静默 allow。
- marker 格式非法 → 强制 ask。
- registry 过期/超过 128 条 → 清理；找不到时 canonical action 强制 ask。
- 另一个插件的普通 `shell` 请求无 marker/registry → 不干预。

### 9.5 mock ACP 集成

mock 分别发 execute/edit/read/search/fetch/think permission：

- 断言 `ctx.permission.assert` 的 action/resources/metadata。
- execute resources 只含 command；edit/read 含 path；search_web 含 query；fetch 仅在真实 fixture 存在时含 URL。
- allow 时选择 `allow_once`；deny 时 `reject_once`。
- permission 只有 `toolCallId` 时仍能从 cache 提取参数。
- headless 无规则时 reject；有显式 legacy allow 时 allow。
- `think` 无规则时不弹；有 `antigravity.think ask` 时弹；没有 `allow_once` 时 reject，不选 `allow_always`。
- `permission: "allow"` / `"deny"` 对每个 kind 行为不变。
- prompt 期间取消 → `cancelled`，不误选 allow。
- `permission: "ask"` + allow-only 选项缺失 → reject（现有逻辑）。

### 9.6 TUI presentation contract

用 pin 在 `ref/opencode-pr-65430` 的真实 `permissionPresentation`（dev-only；不进入发布包）测试
插件实际会发出的 permission request shape，**不带 tool source input**：

- `shell` + resources `[command]` → title `Shell command`，lines `["- <command>"]`（不是 `$`）。
- `edit` + resources `[path]` → title `Edit <path>`；无 diff 时 TUI 显示 `No diff provided`，不伪造 diff。
  真实 ACP `content` diff 暂不渲染；future enhancement。
- `read` + resources `[path]` → title `Read <path>`。
- `websearch` + resources `[query]` + `metadata.query`/`metadata.provider` → `Web Search via Antigravity "query"`。
- `webfetch` + resources `[url]` + `metadata.url` → `WebFetch <url>`，使用 redacted url；仅在真实 fixture 存在时启用。
- `antigravity.other` / `antigravity.move` → `Call tool <action>` / `Tool: <action>`；不声称 title 可见。
- 另外保留一个 copied fixture 版本，使 CI 不依赖 `ref/` checkout。

### 9.7 真实 prompt

1. execute 显示 `Shell command` + 命令，不再是 `antigravity.execute`。
2. edit/read 显示 path；search_web 显示 query；fetch 仅在真实 fixture 后显示 URL。
3. `shell * allow` 后 execute 不弹；`edit ask` 仍弹。
4. 旧 `antigravity.* allow` 仍生效；旧 deny 仍优先。
5. `shell "git *" allow` 不自动放行。
6. explore 上无用户规则 → 弹 ask；headless reject。
7. 对 `/tmp` write、`search_web` 这类 Antigravity 自动放行的工具，确认插件不会伪造 permission；
   记录“未发 permission 即不在 gate 内”的已知限制。

## 10. 实施步骤

1. 新增 `src/permission-policy.ts`：映射、提取、内建前缀、Wildcard、resolver、redaction。
2. 新增 `src/permission-registry.ts`：global pending registry。
3. 捕获/整理真实 Antigravity permission frames 到 `test/fixtures/antigravity-1.5.14/`；
   捕获不到的类型保持 namespaced fallback。
4. `src/session.ts`：
   - tool-call cache（ACP omitted/null preserve、locations null clear、LRU 256、overflow）；
   - `permission()` 使用 `permissionPlan`；
   - 注册/注销 pending；
   - `think` 走 auto-allow assert；
   - canonical action 传给 `ctx.permission.assert`。
5. `src/index.ts`：hook 改为 marker/registry + `resolvePermission(...)`；导出纯函数供测试。
6. 更新 `test/permission-policy.test.ts`、`test/plugin.test.ts`、TUI presentation contract、mock fixture。
7. 更新 README / `ref/README.md` 的权限说明和配置示例。
8. 跑 typecheck/unit/mock integration；三路代码/设计复审。
9. 更新已安装的 `~/.config/opencode/plugins/opencode-antigravity-adapter` 快照。

## 11. 已解决问题

- ~~canonical 优先于 legacy~~ → deny > ask > allow，legacy ask/deny 胜出。
- ~~`git * allow` 放行 compound command~~ → 只允许 `*` 或精确命令，其他通配转 ask。
- ~~permission 只有 toolCallId~~ → tool-call cache + ACP correct omitted/null preserve。
- ~~metadata 传完整 rawInput~~ → 有界字段 + URL redaction。
- ~~think 绕过 deny~~ → `permission: "deny"` 下拒绝；ask 下默认 auto-allow，但显式 think ask/deny 生效。
- ~~search 只能 grep~~ → 真实工具是 `search_web`，映射 `websearch`；其他 search namespaced。
- ~~edit frame 未捕获~~ → 已捕获 `write_file`：`rawInput.Path` + locations + content diff；diff 暂不渲染。
- ~~read frame 未捕获~~ → 已捕获 `read_file`：`rawInput.Path` + locations。
- ~~execute frame 未捕获~~ → 已捕获 `run_command`：`rawInput.CommandLine`。
- ~~fetch/workflow 等未知工具~~ → 没有真实 permission frame 的保持 namespaced ask。
- ~~move 映射 edit 隐藏 destination~~ → 保持 namespaced generic，不映射 edit。
- ~~rawInput 可能是任意 JSON~~ → 只接受 plain object + string 字段；错误类型视为缺失。
- ~~截断值可能成为精确 allow 凭证~~ → resources 用完整值；超限则 namespaced ask。
- ~~内建 allow 被当作用户规则~~ → 受支持版本 + 已知内建前缀精确匹配；未知版本 canonical auto-allow 关闭。
- ~~legacy 规则用新 resources~~ → 旧 action/resources 单独保留。
- ~~多 resource 只匹配一个就 allow~~ → 每个 resource 都必须有有效 allow。
- ~~`delete`/`move` 归入 edit~~ → 保持 namespaced，避免扩大 `edit allow`。

## 12. 待评审问题

1. 内建 deny 由 OpenCode core 在 hook 前执行，legacy allow 不能覆盖；内建 allow 不 auto-allow，
   只会变成 ask。这个兼容性取舍是否可接受？
2. 未知 OpenCode 版本关闭 canonical auto-allow 是否可接受？legacy 规则仍可用。
3. `shell * allow` 的 compound command 风险只文档化、不解析，是否可接受？
4. `think` ask 下默认 auto-allow、显式 think ask/deny 生效，是否足够？
5. `search_web`/`write_file`/`read_file`/`run_command` 已用真实 frame 校准；`fetch`、`edit_file`、
   `invoke_subagent`、`run_workflow` 等仍无 permission frame，是否接受这些类型保持 namespaced ask？
6. `delete`/`move` 保持 namespaced 是否可接受，还是希望映射到 `edit` 并接受扩大？
7. saved “Always allow” 不可见；是否接受该限制。
8. 真实 Antigravity 1.5.14 permission frames 的捕获是否必须作为实现的前置条件？
   本设计已把未知 key 的 fallback 设为 namespaced + ask。

## 13. 验收标准

- TUI 上 execute 显示 `Shell command` + `- command`；edit/read 显示 path；search_web 显示 query。
- TUI presentation contract 用真实 `permissionPresentation` 验证；generic action 不声称显示 title。
- 用户可用 `shell * allow` / `shell "git status" allow` / `edit ask` / `read allow` / `websearch allow` 等规则。
- `shell "git *" allow` 不自动放行，转 ask。
- 旧 `antigravity.*` 规则继续工作，且旧 ask/deny 优先。
- 内建 explore/plan 的 allow 不会 auto-approve；内建 deny 在 hook 前由 core 执行，行为与测试一致。
- legacy `antigravity.* allow` 不能覆盖 core 的 built-in canonical deny；canonical allow 可以。
- 无显式规则 headless 仍 reject；`permission: "ask"` fail closed。
- permission 只有 toolCallId 时参数仍正确；omitted/null cache 语义符合 ACP。
- marker 丢失时仍不会静默 allow。
- 截断/超限值不会成为精确 allow 凭证。
- Antigravity 自动放行、未发 permission 的工具不在插件 gate 内，文档明确。
- typecheck、unit、mock integration 全绿。
- Kimi / GLM / DeepSeek 三路对 v3.2 设计给出 CONVERGED。

## 14. 实施状态

- `src/permission-policy.ts`：映射、ACP patch merge、内建前缀、Wildcard、resolver、marker 决策。
- `src/permission-registry.ts`：进程级 pending registry。
- `src/session.ts`：per-session tool-call cache、canonical assert、think auto-allow marker。
- `src/index.ts`：permission evaluate hook。
- `test/permission-policy.test.ts`：映射、cache、规则、marker/registry、hook 决策。
- `test/session-permission.test.ts`：mock ACP execute/read permission、only-ID cache、no-allow fail-closed。
- `test/presentation.test.ts`：真实 pinned `permissionPresentation` contract（`ref/` 存在时运行）。
- `test/fixtures/mock-agy-acp.mjs`：`MOCK_PERMISSION_KIND` / `MOCK_PERMISSION_NO_ALLOW`；返回值包含实际 `permission-outcome`。
- `scripts/integration-permission.sh`：真实 `opencode --standalone run` + mock ACP，覆盖 no-rule reject、canonical/legacy allow、wildcard downgrade、legacy deny、explore built-in、read/edit/websearch；已接入 `bun run test:integration`。
- 最终代码评审：GLM / DeepSeek / Kimi 均 **CONVERGED**（DeepSeek 的 T-1 自动化真实 hook 覆盖已修复）。
- 手动 e2e（OpenCode 2.3.2 + mock ACP）：
  - build + no rule → `permission requested ... auto-rejecting`；
  - build + `shell * allow` → 允许；
  - build + `antigravity.* allow` → 允许；
  - build + `shell "printf *" allow` → 降级 ask / auto-reject；
  - explore + no rule → 内建 `shell * allow` 不 auto-approve，仍 ask / auto-reject。
