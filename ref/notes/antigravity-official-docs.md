# Google Antigravity: official ACP, CLI, and ToS constraints

Reference extraction for the standalone OpenCode ACP plugin project.

- **Extracted:** 2026-11-22
- **Primary inputs (saved snapshots):**
  - `ref/notes/antigravity-acp-docs.html` — official page [Other editors (ACP)](https://antigravity.google/docs/ide/extensions/acp/)
  - `ref/notes/antigravity-faq.html` — official [FAQ](https://antigravity.google/docs/faq/)
  - `ref/antigravity-cli/CHANGELOG.md` — official CLI changelog
  - `ref/antigravity-cli/README.md` — official CLI README
- **Cross-check:** the live `.md` versions of the ACP and FAQ pages were fetched on the same date. Their substantive text is identical to the saved HTML; differences were formatting only (tabs, list markers, image alt text). Quotes below therefore match both.
- **Local version observed:** `agy` 1.5.14 (`ref/notes/agy-cli-info.txt`, `ref/notes/agy-acp-handshake.log`).
- **Scope:** factual extraction, not legal advice. Where the official sources conflict, §6 says so rather than resolving it.
- **Update 2026-11-22 — forum clarification:** a Google Antigravity forum reply directly addresses the OpenCode case and draws a **thin-client vs outer-harness** boundary. See §6.11. The FAQ still names OpenCode; the forum reply permits unmodified `agy acp` only in a thin client where Antigravity is the agent, and says an outer harness that injects system instructions/tool schemas/replayed cross-model context/automated loops is not permitted on `oauth-personal`.

---

## 0. TL;DR for the plugin project

1. The official CLI programmatic surface is **`agy acp`**: an ACP v1 server speaking JSON-RPC over stdio, launched by the client as a subprocess. It identifies itself as `Antigravity ACP Server`. Do **not** build on `agy -p`.
2. Authentication is either (a) the credentials already cached by an interactive `agy` login, or (b) an explicit ACP `authenticate` call with one of the documented method IDs. Do **not** read, copy, or replay OAuth tokens.
3. The ACP page says **“any ACP client can launch Antigravity CLI.”** The FAQ separately says using third-party software (it names **OpenCode**) with an Antigravity login violates the ToS. A Google Antigravity forum reply (2026-11-20) narrows this to a **thin-client vs outer-harness** boundary: unmodified `agy acp` is permitted in a thin client where Antigravity is the agent; an outer harness that injects system instructions, serialized tool definitions, replayed cross-model context, or automated loops is not permitted on `oauth-personal`. See §6.11. Treat consumer-OAuth use from an outer harness as high risk; a strict-thin client is the intended permitted case.
4. `agy -p` is officially for **direct scripting and CI**. Wrapping `agy` inside third-party coding agents/apps, or automating account rotation, is **“not supported under consumer plans.”**
5. For a third-party coding agent using Gemini, the FAQ recommends a **Gemini Enterprise or Google AI Studio API key** — not an Antigravity consumer login.
6. The ACP server exposes models and thinking level as session config options, four modes (`default`, `accept-edits`, `auto`, `plan`), permission requests, session load/resume/list/close, additional workspace folders, images/embedded context, steering, and context-window usage updates.
7. `--process-per-session` is documented as **required for HTTP MCP servers configured by the editor**. It is absent from the 1.5.x changelog but present in `agy acp --help` 1.5.14.
8. Never put `GEMINI_API_KEY` in a shared/committed editor settings file; pass it through the spawned process environment.
9. `--dangerously-skip-permissions` is documented for **sandboxed or disposable environments only**. It is not a safe default for an editor plugin.
10. The OpenCode PR #65430 adapter is incomplete: it lists models but never applies the selected model, has no ACP auth, no modes, no session load/list/close, and refuses every permission request by default. The `system1970/opencode-antigravity-acp` plugin is much closer but still omits several documented ACP features (§5).

---

## 1. Official ACP page, read as text

Source: <https://antigravity.google/docs/ide/extensions/acp/>

### 1.1 What it is

> Use Antigravity in any editor that supports the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Antigravity CLI includes an ACP server, `agy acp`, so any editor can run it and chat with the agent in its own panel. Zed, JetBrains IDEs, Android Studio, and Xcode support ACP natively. VS Code needs a community extension.

> `agy acp` starts an ACP server that talks JSON-RPC over `stdin` and `stdout`. Your editor launches it as a subprocess, sends prompts, and renders the agent’s replies, tool calls, file diffs, and permission requests in its native UI. The agent, its tools, and your settings come from Antigravity CLI, so the agent behaves the same in the editor as it does in the terminal.

The page includes a video demo of ACP configuration in Zed (not reproduced here).

### 1.2 Before you begin

- Install Antigravity CLI and confirm `agy` is on `PATH`:

  ```bash
  agy --version
  ```

- Sign in once with an interactive `agy` session, or run `agy acp --login`. `agy acp` reuses the cached credentials. To authenticate from the editor instead, use the ACP `authenticate` methods in §1.8.
- Find the absolute path to `agy`. Some editors launch agents without your shell’s `PATH`:

  ```bash
  which agy
  ```

### 1.3 Connect your editor

> Every client except Android Studio registers the same command: `agy` with the single argument `acp`.

#### VS Code

VS Code does not support ACP natively. Install the community [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client) extension, then add Antigravity to the user `settings.json`:

```json
{
  "acp.agents": {
    "Antigravity": {
      "command": "agy",
      "args": ["acp"]
    }
  }
}
```

Start a session by opening the ACP Client view from the activity bar, running **ACP: Connect to Agent** from the Command Palette, choosing Antigravity, and typing a prompt.

> **Note:** The ACP Client extension is maintained by the community, not by Google. For the official Antigravity extension for VS Code, refer to the VS Code page.

#### Zed

Add Antigravity as a custom agent server in Zed’s `settings.json` (`zed: open settings file`):

```json
{
  "agent_servers": {
    "Antigravity": {
      "type": "custom",
      "command": "agy",
      "args": ["acp"]
    }
  }
}
```

Open the Agent Panel, click `+`, and choose Antigravity under **External Agents**.

#### JetBrains IDEs

JetBrains IDEs (IntelliJ IDEA, PyCharm, GoLand, WebStorm, and others) run ACP agents in the **AI Chat** tool window, which comes with the AI Assistant plugin. The IDE reads custom agents from `~/.jetbrains/acp.json`; open it with **Add Custom Agent** or create it:

```json
{
  "agent_servers": {
    "Antigravity": {
      "command": "/absolute/path/to/agy",
      "args": ["acp"]
    }
  }
}
```

Use the absolute path from `which agy`; JetBrains IDEs do not always inherit the shell’s `PATH`.

#### Android Studio

Antigravity is available through the **ACP Registry**. The page points to a dedicated Android Studio guide for installation, setup, and authentication; it does not repeat the command here.

#### Xcode

1. Open **Xcode > Settings > Intelligence**.
2. Under **Agents**, click **Add an Agent**.
3. Set **Command** to the absolute path from `which agy`; Xcode does not expand `~` or read the shell’s `PATH`.
4. Set **Arguments** to `acp`, then click **Add**.

#### Other clients

> Any ACP client can launch Antigravity CLI. Configure it to run this command with the project directory as the working directory:

```bash
agy acp
```

> The server speaks ACP protocol version 1 over `stdio` and identifies itself as `Antigravity ACP Server`.

### 1.4 Work with the agent

After connecting, the editor shows each step of a turn:

- **Tool calls** appear as they run, with the command or file they touch.
- **Edits** stream back as diffs, so a change can be reviewed in the editor.
- **Permission requests** pause the turn until the user allows or denies the action.
- **Slash commands** that Antigravity CLI supports appear in the client’s command menu.
- **Conversation titles** update automatically as the session progresses.
- **Images and embedded resources:** paste images or attach files as prompt context.
- **Questions:** when the agent asks a question, clients that support ACP elicitation forms show a native form; other clients show the question in chat.
- **Steering:** sending a prompt while a turn is running steers that turn instead of starting a new one.
- **Cancel:** cancelling a turn ends open tool calls and abandons pending permission requests.

### 1.5 Models and thinking level

The server exposes two session options that clients show as pickers:

| Option | Values |
| --- | --- |
| Model | The models available to your account |
| Thinking level | `Low`, `Medium`, `High`, `Extra`, `Max` |

> Gemini models are available in every client. Third-party models are only offered to JetBrains IDEs (including JetBrains Air), Android Studio, Android Performance Analyzer, Zed, and Xcode.

**Documentation conflict:** CHANGELOG 1.5.1 says `agy acp` now offers **every model available to the account to every ACP client**, and the 1.5.14 handshake on this machine offered Claude Opus/Sonnet and GPT-OSS to a non-listed `opencode-probe` client. See §6.1. Do not rely on non-Gemini model access as a stable, documented entitlement.

### 1.6 Permissions

> When the agent wants to run a command or change a file, the client shows a permission request with Allow and Deny options. Your [permission rules](https://antigravity.google/docs/permissions) still apply: actions that your rules already allow or deny don’t prompt.

> To skip prompts entirely, add `--dangerously-skip-permissions` to the agent’s `args`. Only do this in a [sandboxed](https://antigravity.google/docs/sandbox) or disposable environment.

### 1.7 Sessions

> The server supports loading, resuming, listing, and closing sessions. Clients that support these ACP features can reopen a previous Antigravity conversation instead of starting a new one. Resuming a session reopens the conversation without replaying its history. Editors with multi-root workspaces, such as Zed, can also send extra workspace folders.

### 1.8 Authentication

> `agy acp` uses the credentials you cached with an interactive `agy` session. If no credentials are available, requests fail with the error `Authentication required` (code `-32000`), and the client can ask you to sign in with one of these methods:

| Method | ID | Notes |
| --- | --- | --- |
| Log in with Google | `oauth-personal` | Opens a browser sign-in for a personal Google account |
| Log in with Gemini Enterprise | `oauth-business` | Opens a browser sign-in for a Gemini Enterprise account |
| Gemini API key | `gemini-api-key` | Reads `GEMINI_API_KEY` from the agent’s environment |
| Gemini Enterprise Agent Platform | `agent-platform` | Formerly Vertex AI. Uses Application Default Credentials with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, or `gcp.project` and `gcp.location` in `settings.json` |
| Log in from the terminal | `terminal-login` | Signs in with a Google account by pasting a code in a terminal. Works over SSH. Only offered to clients that support ACP terminal authentication |

To pass an API key through the editor, set it in the agent’s environment. Zed example:

```json
{
  "agent_servers": {
    "Antigravity": {
      "type": "custom",
      "command": "agy",
      "args": ["acp"],
      "env": { "GEMINI_API_KEY": "<your-api-key>" }
    }
  }
}
```

> **Caution:** Editor settings files are stored in plain text and are often synced or shared. Don’t commit a settings file that contains an API key. Where possible, sign in with `agy` instead, or export `GEMINI_API_KEY` in the environment that launches your editor.

### 1.9 Flags

Add flags after `acp` in the client’s `args` list, for example `["acp", "--sandbox"]`.

| Flag | Default | Description |
| --- | --- | --- |
| `--add-dir` | — | Add a directory to the workspace. Repeat for more directories. |
| `--agent` | — | Agent to use for ACP sessions (refer to `agy agents`). |
| `--sandbox` | `false` | Run with terminal sandbox restrictions enabled. |
| `--dangerously-skip-permissions` | `false` | Auto-approve all tool permission requests. |
| `--process-per-session` | `false` | Serve each session from an isolated worker process. Required for HTTP MCP servers that your editor configures. |
| `--ide-mcp-port` | — | Port of the editor’s MCP server to expose its tools to the agent. Requires `nc` on `PATH`. |
| `--login` | `false` | Sign in with Google interactively in the terminal by pasting a code, then exit. Works over SSH. |
| `--log-file` | — | Write the ACP server log to this path. |
| `--disable-telemetry` | `false` | Disable telemetry for this server. |

The local 1.5.14 `agy acp --help` lists more (undocumented/internal) flags; see Appendix A.

### 1.10 Troubleshooting

- **The agent doesn’t start.** Run `agy acp --help` in a terminal to confirm the installed version includes ACP. If it works in the terminal but not in the editor, replace `agy` with the absolute path from `which agy`.
- **Requests fail with `Authentication required`.** Run `agy` interactively once to sign in, or pass credentials through the agent’s environment as shown in §1.8.
- **Sign-in fails over SSH or without a browser.** Run `agy acp --login` on that machine, then retry; alternatively use a Gemini API key.
- **More detail is needed.** The server writes logs to `~/.gemini/antigravity-cli/log/acp-*.log`. Use `--log-file` to choose another path.

### 1.11 Supported-client and ToS caveats on the ACP page

- Zed, JetBrains IDEs, Android Studio, and Xcode support ACP natively.
- VS Code requires a **community** ACP Client extension, explicitly **not maintained by Google**.
- Android Studio distribution goes through the **ACP Registry**.
- “Any ACP client” may launch `agy acp` with the project directory as cwd.
- The ACP page itself does **not** discuss the FAQ’s third-party-software restriction or ToS compliance. It only cautions about API keys in editor settings. The binding constraints are in the FAQ and the Additional Terms (§2).

---

## 2. FAQ: exact answers that govern third-party use

Source: <https://antigravity.google/docs/faq/>

### 2.1 Third-party software with an Antigravity login

**Question (anchor `#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login`):**

> Why can’t I use third-party software (such as Claude Code, OpenClaw, or OpenCode) with my Antigravity login?

**Answer, verbatim:**

> Using third-party software, tools, or services to access Antigravity is a violation of our [Terms of Service](https://antigravity.google/terms) and severely degrades the experience for legitimate product users. Such actions can result in suspension or termination of your account. To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key.

Exact URL:

<https://antigravity.google/docs/faq#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login>

**What it says, precisely:**

- The prohibition is tied to **“my Antigravity login”** and to **“access Antigravity”** — not merely to the ACP wire protocol.
- It names **OpenCode** explicitly.
- It calls this a **violation of the Terms of Service**, not merely “unsupported.”
- Consequences include **suspension or termination** of the account.
- The recommended alternative for a **third-party coding agent with Gemini** is a **Gemini Enterprise or Google AI Studio API key**.
- It does **not** say that any ACP client is exempt, nor that using `agy acp` from a third-party agent is automatically permitted.

### 2.2 `agy -p` headless mode and account switching

**Question (anchor `#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching`):**

> Can I use Antigravity CLI headless mode in third-party coding agents or automate account switching?

**Answer, verbatim:**

> Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans.

Exact URL:

<https://antigravity.google/docs/faq#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching>

**What it says, precisely:**

- `agy -p` is intended for **direct scripting and CI workflows**.
- Two separate practices are called out: (a) **wrapping `agy` inside third-party coding agents or applications**, and (b) **automating account rotation**.
- Both are **“not supported under consumer plans.”**
- It does **not** say “prohibited”; the qualifier **“under consumer plans”** leaves enterprise/API-key arrangements unaddressed.
- It does **not** grant permission for enterprise plans; it only declines to state support for consumer plans.
- It does **not** mention ACP. `agy acp` is a different surface, documented separately.

### 2.3 Consumer vs enterprise / API-key paths

The two answers above are often quoted as if they were one rule. They are not. The official material distinguishes these paths:

| Path | Auth method in ACP | What the official sources say | Practical implication for an OpenCode plugin |
| --- | --- | --- | --- |
| Personal Google account (free, Google AI Pro/Ultra) | `oauth-personal` | ACP page says any ACP client can launch `agy acp`; FAQ says third-party software with an Antigravity login violates the ToS and names OpenCode; `agy -p` wrapping is unsupported on consumer plans. | Highest-risk path. The two official pages conflict; the FAQ is explicit and enforcement-oriented. Do not assume ACP transport makes consumer OAuth safe. |
| Gemini Enterprise | `oauth-business` | ACP page supports browser sign-in; enterprise admin must assign a license and may need to enable AI developer tools. FAQ recommends Gemini Enterprise for a third-party coding agent with Gemini. | Enterprise/administrator terms apply. Respect admin permission policy; do not bypass it. |
| Gemini API key (Google AI Studio / Gemini Developer API) | `gemini-api-key` | ACP page reads `GEMINI_API_KEY` from the agent environment; FAQ recommends an AI Studio API key for third-party coding agents with Gemini. | Key-based path avoids an Antigravity consumer login, but uses API-key quota/terms, not Antigravity subscription quota. Keep the key in the environment, never in shared settings. |
| Gemini Enterprise Agent Platform (formerly Vertex AI) | `agent-platform` | ACP page uses ADC plus `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` or `gcp.project`/`gcp.location`. | Enterprise/cloud terms apply; ADC must be provisioned outside the plugin. |
| Terminal login over SSH | `terminal-login` | ACP page: paste a code in a terminal; only offered to clients that support ACP terminal authentication. | An authentication mechanism, not a separate licensing path. It still signs in a Google account. |

**Important distinction:** the FAQ’s recommendation of “a Gemini Enterprise or Google AI Studio API key” is phrased as the way to use **a third-party coding agent with Gemini**. It is not an explicit statement that an API key authorizes driving the **Antigravity agent/quota** through `agy`. The ACP `gemini-api-key` method does exactly that technically; whether it satisfies the Antigravity terms is not spelled out. Treat it as the documented low-risk route, not a legal safe harbor.

### 2.4 The Additional Terms clause

Source: <https://antigravity.google/terms> — **Google Antigravity Additional Terms of Service**.

Verbatim (paragraph beginning “You must not abuse…”):

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.

Also verbatim, the enterprise/API-key preamble:

> If you are accessing the Service through Gemini Enterprise (Google Cloud), Gemini Enterprise for Business or a Google Workspace subscription on the Google Cloud Pre-GA Offering Terms, or with an API Key in Gemini for business, then you are subject to the terms of use accepted or signed by your administrator applicable to such service (including its applicable terms for downloadable software).

Notes:

- The example is **“using OpenClaw with Antigravity OAuth”** — i.e. third-party software plus Antigravity OAuth credentials. This is the fact pattern the clause targets.
- The clause is broad (“software, tools, or services to access the Service”), not limited to token extraction.
- The saved Terms page does not expose numbered sections in its rendered text. A PR document’s citation to “section 6” cannot be verified from the saved page; cite the paragraph, not a section number.

### 2.5 Related account constraints

These are not ACP-specific but affect which auth path a plugin can offer:

- **Age:** Antigravity is unavailable to users under 18.
- **Geography:** The FAQ lists supported countries/territories; an account must be associated with one.
- **Workspace accounts:** Google Workspace plans do **not** currently include Antigravity plans, higher rate limits, or AI credits. By default, a Workspace account signed in with “Continue with Google” gets a limited starter quota, unless the administrator has disabled individual access. Options are a personal account, the organization’s own Google Cloud project (Pay As You Go), or Gemini Enterprise.
- **Enterprise sign-in surfaces:** Enterprise sign-in works in the Antigravity App, Antigravity CLI, and Antigravity IDE extensions, **but not in the standalone Antigravity IDE**.
- **Data collection:** “Refer to the Terms of Service. You can opt out of data collection at any point from the Settings panel.”
- **CLI README:** “By using Antigravity CLI, you agree to help improve the product by allowing Google to collect and use your Interactions data, subject to the Google Terms of Service and Google Privacy Policy. You can choose to opt out at any time via your settings.”
- **CLI security warning:** “AI coding agents are known to have certain security risks, including autonomous code execution, data exfiltration, prompt injection, and supply chain risks. Ensure that you monitor and verify all actions taken by the agent.”

## 3. CHANGELOG: ACP changes from 1.5.0 onward

Source: `ref/antigravity-cli/CHANGELOG.md`. ACP was introduced in **1.5.0**; the top of the saved changelog is **1.5.14**. Entries below are limited to ACP behavior and to changes that directly affect an ACP client (auth, models, config options, permissions, session lifecycle). General TUI changes are omitted.

### 3.1 Version-by-version

| Version | ACP-relevant change |
| --- | --- |
| **1.5.14** | No bullet names ACP. The Auto-mode permission change still applies to ACP sessions that use `auto`: reading files outside the workspace no longer asks; writing/editing outside still asks. |
| **1.5.13** | Fixed `agy acp` running shell commands in the editor’s launch directory (e.g. home) instead of the session’s project folder. Fixed `agy acp` ignoring editor-attached file contents (e.g. unsaved changes in Zed); the agent now sees the editor’s copy. Fixed enterprise-gateway model pickers showing `MODEL_PLACEHOLDER_...` IDs and duplicate names; each model is listed once under its model ID, with the ID shown when names collide. Fixed per-retry `API error (attempt N)` messages appearing in the editor chat; retries are silent unless every attempt fails. |
| **1.5.12** | No ACP-specific entry. Adds Gemini 4 Neon for `GEMINI_API_KEY` connections (relevant to the `gemini-api-key` ACP path). |
| **1.5.11** | No ACP-specific entry. |
| **1.5.10** | Fixed `agy acp` withholding post-turn activity: when a background task/subagent finishes and wakes the agent, replies, tool calls, and permission requests now reach the editor immediately. Fixed cancel/close leaving subagents and background tasks (e.g. dev servers) running; cancel/close now stops them, including close with no prompt running. Fixed a rare `trajectory not found` race when an editor refreshed its session list while a conversation was being created. |
| **1.5.9** | Fixed several `agy acp` issues: after `agy acp --login`, a session no longer fails with `Authentication required` when `settings.json` names an auth method with no credential (e.g. `gemini-api-key` without `GEMINI_API_KEY`); the CLI falls back to the saved login. ACP prompts no longer fail when a client-supplied MCP server name contains spaces/special characters. A failed turn reports the specific model/quota error instead of `Agent execution terminated due to error.` Edit diffs no longer carry an extra trailing newline in `oldText`/`newText`. Also fixed BOM-prefixed `settings.json` so `agy acp` loads settings and auth options instead of defaults. |
| **1.5.8** | Added **context-window usage updates** to `agy acp` sessions, so editors such as JetBrains AI Chat can show context usage. The value is sent when a session starts or is reloaded, after each model call, and after a model or thinking-level change. |
| **1.5.7** | Changed the default `Agent Mode` from Default to Auto for sessions with no saved mode, **including headless `-p` runs**; `strict` Tool Permission now takes precedence over Auto and accept-edits. Do not assume this changes ACP: the observed 1.5.14 `session/new` still reports `currentModeId: "default"`, and ACP has its own `modes` selector. |
| **1.5.6** | No ACP-specific entry. Pay-as-you-go Google Cloud accounts using ADC get the same permission settings as other PAYG accounts (Auto becomes available); Gemini Enterprise accounts keep admin-controlled permission settings and are **not** offered Auto. |
| **1.5.5** | No ACP-specific entry. |
| **1.5.4** | Added **Auto mode** to `agy acp` sessions, so editors can switch a session to `auto` wherever the CLI offers Auto. Auto approves edits inside the workspace and runs commands in the terminal sandbox, but still asks before commands that would leave the sandbox unless Auto’s review clears them. Fixed ACP sessions dropping back to `default` when an editor reloaded/resumed an open session; accept-edits no longer starts asking again. Fixed ACP turns hanging when a tool call needed a second permission approval; the editor now receives a new permission request. |
| **1.5.3** | Fixed `agy acp` sessions exiting before the agent backend finished shutting down when the client closed the connection, which could interrupt saving conversation data. |
| **1.5.2** | Changed `--dangerously-skip-permissions` so commands on the system command denylist are **blocked** instead of approved, while every other command still runs without asking. Changed `agy -p --dangerously-skip-permissions` so headless runs deny terminal commands/file access outside the workspace that a Gemini Enterprise administrator requires to be reviewed. Fixed the `/` menu in `agy acp` sessions listing a default agent’s commands/skills instead of the session’s actual agent (including custom agents). |
| **1.5.1** | Changed `agy acp` to offer **every model available to the account to every ACP client**, where previously only a fixed list of editors was offered models other than Gemini. Fixed ACP session bugs: close/reload/resume during a running prompt now ends that prompt as `cancelled` instead of hanging; cancelling a prompt no longer stops the next prompt; `session/update` notifications no longer arrive after the `session/prompt` reply for that prompt; permission requests and question forms close when answered elsewhere or when their prompt ends. |
| **1.5.0** | Introduced `agy acp` (see exact entry below): ACP server over stdio; images and embedded file context; steering; `default`, `accept-edits`, and `plan` modes; `session/resume` without history replay; per-session model and thinking level; terminal Google sign-in via `agy acp --login`. |

### 3.2 The 1.5.0 introduction, verbatim

> Added `acp` to `agy --help`: `agy acp` runs the CLI as an Agent Client Protocol (ACP) server over stdio, so editors can use it as their agent, with images and embedded file context in prompts, steering a running turn by sending another prompt, `default`, `accept-edits`, and `plan` session modes, `session/resume` restoring a session without replaying its history, each session keeping its own model and thinking level, and Google sign-in from a terminal with `agy acp --login` for editors connected over SSH or without a browser.

### 3.3 Auth timeline

- **1.5.0:** `agy acp --login` added for terminal Google sign-in (SSH/no browser). Cached interactive credentials are the default.
- **1.5.9:** If `settings.json` selects an auth method with no usable credential (e.g. `gemini-api-key` without a key), ACP falls back to the saved login instead of failing after `--login`. BOM-prefixed settings/auth load correctly.
- **1.5.12:** Gemini 4 Neon available with `GEMINI_API_KEY`.
- **1.5.13:** Enterprise model gateway model IDs are cleaned up in ACP model pickers; Gemini 4 Neon available with ADC (`AGY_ADC_AUTH`).
- **1.5.4 (general):** Fixed enterprise plan loss / permission errors when the stored sign-in outgrew Windows Credential Manager or macOS Keychain; affected sign-ins repair on next load. Also fixed the “Sign-in update needed” warning not appearing in `--remote-agent` sessions.
- **Not ACP-specific but relevant:** 1.5.9 keychain failure falls back to file storage for the rest of the session; 1.5.7 fixed dual-stack browser sign-in callbacks on Windows.

### 3.4 Models, thinking, and config options

- **1.5.0:** each ACP session keeps its own **model and thinking level**.
- **1.5.1:** every model available to the account is offered to every ACP client (superseding the earlier fixed editor list).
- **1.5.4:** Auto mode added to ACP; mode persists across reload/resume.
- **1.5.8:** context-window usage updates, including after model/thinking-level changes.
- **1.5.13:** enterprise-gateway model pickers deduplicated; internal `MODEL_PLACEHOLDER_...` IDs hidden; model ID shown when names collide.
- **Observed 1.5.14:** `session/new` returns `models.availableModels`, `modes.availableModes`, and `configOptions` for `model`, `thought_level`, and `mode`. `session/set_config_option` changes model/thinking; `session/set_mode` changes mode. See Appendix B.

### 3.5 Permissions and modes

- **1.5.0:** modes `default`, `accept-edits`, `plan`.
- **1.5.2:** `--dangerously-skip-permissions` no longer overrides the system command denylist; enterprise admin review requirements are honored in `-p`; explicit deny rules still apply.
- **1.5.4:** `auto` mode added to ACP; permission prompts can arrive more than once for a tool call; mode survives reload/resume.
- **1.5.6:** Gemini Enterprise accounts keep admin-controlled permission settings, including `unsandboxed(...)` deny/ask rules, and are **not** offered Auto. PAYG ADC accounts get the same permission settings as other PAYG accounts (Auto available).
- **1.5.7:** `strict` takes precedence over Auto and accept-edits; Auto becomes the default **CLI Agent Mode** where available. ACP sessions still advertise their own mode selector; the observed 1.5.14 `session/new` defaults to `default`.
- **1.5.14:** Auto mode allows reading files outside the workspace without approval; writing/editing outside still asks; explicit `ask`/`deny` rules, protected config files, other projects’ conversations, and organization policies still apply.

### 3.6 Sessions, lifecycle, and process isolation

- **1.5.0:** `session/resume` restores a session **without replaying its history**; each session keeps its own model and thinking level.
- **1.5.1:** close/reload/resume during a running prompt ends it as `cancelled`; cancel does not affect the next prompt; no `session/update` after the `session/prompt` reply; permission/question forms close when answered elsewhere.
- **1.5.3:** ACP close waits for backend shutdown so conversation data is saved.
- **1.5.4:** mode persists across reload/resume.
- **1.5.8:** context usage sent on session start/reload.
- **1.5.10:** background task/subagent completion is delivered immediately; cancel/close stops subagents/background tasks; session-list refresh race fixed.
- **1.5.13:** ACP shell commands run in the **session’s project folder**, not the editor launch directory; attached editor buffers are honored.
- **`--process-per-session`:** documented on the ACP page as “Serve each session from an isolated worker process. Required for HTTP MCP servers that your editor configures.” It is **not announced in any 1.5.x changelog entry**; `agy acp --help` 1.5.14 confirms it, and also exposes an internal `--worker` flag. `--ide-mcp-port` is likewise documented on the ACP page but absent from the changelog.

### 3.7 Known ACP bugs fixed (useful regression checklist)

| Version | Bug |
| --- | --- |
| 1.5.1 | Close/reload/resume during a prompt left it hanging; cancel also stopped the next prompt; `session/update` arrived after the prompt reply; permission/question forms blocked later prompts. |
| 1.5.3 | Client disconnect could exit before conversation data was saved. |
| 1.5.4 | Mode reset to default on reload/resume; second permission approval hung the turn. |
| 1.5.9 | Auth failed after `--login` when settings named a credential-less method; MCP server names with spaces broke prompts; generic error text hid model/quota errors; edit diffs had a trailing newline; BOM settings loaded defaults. |
| 1.5.10 | Post-turn background activity was withheld until the next prompt; subagents/background tasks survived cancel/close; `trajectory not found` race on session-list refresh. |
| 1.5.13 | Commands ran in the wrong directory; editor-attached unsaved buffers were ignored; model pickers showed placeholder IDs/duplicates; retry noise appeared in chat. |

### 3.8 What the 1.5.x changelog never mentions

The following are documented on the ACP page or visible in `agy acp --help`, but have no dedicated 1.5.x changelog entry. Do not infer their introduction version from the changelog; probe capabilities at runtime:

- `session/load`, `session/list`, `session/close` as named ACP methods. (The changelog mentions “closing, reloading, or resuming” and “session list” in bug fixes, but does not announce load/list.)
- `--process-per-session`, `--ide-mcp-port`, `--add-dir`, `--sandbox`, `--agent`, `--disable-telemetry`, `--log-file`.
- `terminal-login` as a named auth method (the changelog only announces `agy acp --login`).
- Additional workspace folders / `additionalDirectories`.
- ACP `logout`.
- Slash-command discovery, elicitation forms, and steering as formal capabilities (1.5.0 mentions steering and images, but not the method names).

---

## 4. Statements that matter for compliance and design

> This section is an engineering reading of the cited text, not legal advice. Where the sources conflict, §6 records the conflict.

Citation note: “ACP page §1.x” below means the corresponding subsection of §1 of this document; the canonical URL is in §7. “CHANGELOG 1.5.x” means the version entry in `ref/antigravity-cli/CHANGELOG.md`.

### 4.1 Hard constraints stated by the official sources

| # | Statement | Source | Design implication |
| --- | --- | --- | --- |
| 1 | `agy acp` is the documented ACP server: JSON-RPC over stdio, protocol v1, launched as a subprocess with the project directory as cwd. | ACP page §1.1, §1.3 | Use `agy acp` as the backend. Do not invent a private HTTP transport or emulate the agent. |
| 2 | `agy -p` is intended for direct scripting/CI; wrapping `agy` inside third-party coding agents/apps or automating account rotation is **not supported under consumer plans**. | FAQ Q2 | Do not implement a `-p` backend. Do not ship account-rotation features. |
| 3 | Using third-party software, tools, or services to access Antigravity with an Antigravity login is a **ToS violation**; it can lead to suspension/termination. OpenCode is named. | FAQ Q1; Additional Terms | Consumer `oauth-personal` + OpenCode is the highest-risk configuration. Require explicit user acknowledgement and document the API-key/enterprise alternatives. |
| 4 | For a third-party coding agent with Gemini, use a **Gemini Enterprise or Google AI Studio API key**. | FAQ Q1 | Support `oauth-business`, `gemini-api-key`, and `agent-platform` auth paths; document them as the recommended third-party routes. |
| 5 | Enterprise/Workspace/API-key access is subject to the terms accepted or signed by the administrator. | Additional Terms preamble | Do not override admin permission policy, managed settings, or review requirements. |
| 6 | `agy acp` reuses cached interactive credentials; if none, requests fail with `Authentication required` (`-32000`), and the client may start one of the documented auth methods. | ACP page §1.8 | Implement auth-method discovery and a fallback to cached credentials; surface `-32000` as “sign in required,” not a generic failure. |
| 7 | Auth methods are `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`, and `terminal-login` (the last only for clients that advertise terminal auth). | ACP page §1.8 | Use ACP `authenticate`; do not scrape keychains/token files. Advertise terminal capability if you want `terminal-login`. |
| 8 | API keys in editor settings are plain text and often synced/shared; don’t commit them. Prefer `agy` sign-in or an environment variable. | ACP page §1.8 Caution | Inject `GEMINI_API_KEY` into the child environment only; never persist it in plugin config or logs. |
| 9 | Permission rules still apply; allowed/denied actions do not prompt. `--dangerously-skip-permissions` is only for sandboxed/disposable environments. | ACP page §1.6 | Default to permission prompts. Make the skip flag an explicit, warned opt-in; never enable it automatically. |
| 10 | `--dangerously-skip-permissions` blocks the system command denylist and honors enterprise admin review; explicit deny rules still apply. | CHANGELOG 1.5.2 | Even with the flag, do not assume universal auto-approval. Surface denials. |
| 11 | Enterprise admin permission settings (including `unsandboxed(...)` deny/ask rules) are not overridden by Auto; as of 1.5.6, enterprise accounts are not offered Auto. | CHANGELOG 1.5.6 | Detect enterprise/ADC and hide or disable Auto where the CLI does not offer it. |
| 12 | `strict` Tool Permission takes precedence over Auto and accept-edits. | CHANGELOG 1.5.7 | Treat the CLI’s permission policy as authoritative; do not re-implement a weaker policy. |
| 13 | Resuming a session reopens the conversation **without replaying its history**. | ACP page §1.7; CHANGELOG 1.5.0 | Prefer `session/resume`/`session/load`; do not resend chat history or tool state. |
| 14 | The server supports loading, resuming, listing, and closing sessions; multi-root editors can send extra workspace folders. | ACP page §1.7 | Implement all four lifecycle methods and `additionalDirectories`; don’t reduce resume to “new session + replay.” |
| 15 | `--process-per-session` is required for HTTP MCP servers configured by the editor. | ACP page §1.9 | Enable it when bridging HTTP MCP; otherwise make it configurable. Do not confuse it with authentication isolation. |
| 16 | Cancel/close must stop subagents and background tasks; closing must save conversation data. | CHANGELOG 1.5.10, 1.5.3 | Send `session/cancel` and `session/close`; on dispose, terminate the child and its process group. |
| 17 | Context-window usage updates are sent at session start/reload, after model calls, and after model/thinking changes. | CHANGELOG 1.5.8 | Handle `usage_update`; use it for UI, not billing claims. |
| 18 | `agy acp` logs to `~/.gemini/antigravity-cli/log/acp-*.log`; `--log-file` overrides. | ACP page §1.10 | Treat logs as sensitive (prompts/tool output). Offer a private log path and redact secrets. |
| 19 | Google collects and uses Interactions under the Terms/Privacy Policy; users can opt out in settings. `--disable-telemetry` disables telemetry “for this server.” | CLI README; FAQ; ACP flags | Show a privacy notice. Do not claim `--disable-telemetry` stops all Google-side collection. |
| 20 | AI coding agents carry autonomous execution, data exfiltration, prompt-injection, and supply-chain risks; monitor actions. | CLI README | Default to least privilege; show tool calls/diffs; make permission prompts visible; support sandbox mode. |
| 21 | ACP was added in 1.5.0; features such as context usage (1.5.8), Auto mode (1.5.4), and model dedupe (1.5.13) arrived later. | CHANGELOG | Gate on `agy --version`; feature-detect capabilities; degrade gracefully on older CLIs. |
| 22 | VS Code support is a **community** extension, not Google-maintained. | ACP page §1.3 | Do not present the VS Code integration as official Google support. |
| 23 | Docs say third-party models are only offered to a named editor list, but 1.5.1 says every model goes to every ACP client. | ACP page §1.5 vs CHANGELOG 1.5.1 | Do not hardcode a model allowlist; discover at runtime. If policy requires Gemini-only, filter client-side and document why. |

### 4.2 Design anti-patterns to avoid

These follow directly from the sources but are worth stating explicitly for the plugin:

1. **Do not read `~/.gemini` OAuth databases, keychains, or `acp_token.json`.** Use the ACP `authenticate` methods or the already-authenticated `agy` process. The ToS example is “third-party software … with Antigravity OAuth”; copying/replaying those credentials falls squarely within that pattern.
2. **Do not write/repair ACP credential files from CLI credentials.** That is still token extraction/duplication, even if the file is chmod 600 and never logged. It also bypasses the documented auth flow.
3. **Do not wrap `agy -p`** as a fallback when ACP fails. The FAQ specifically calls this out for consumer plans.
4. **Do not implement account rotation** or automatic switching between Google accounts to evade quota. The FAQ names this alongside `-p` wrapping.
5. **Do not spoof IDE headers, user-agent strings, or private Cloud Code endpoints.** The documented surface is the local ACP server; `--override_user_agent_name` exists in `--help` but is not part of the documented ACP contract.
6. **Do not auto-approve permissions** to make the integration smoother. Use `--dangerously-skip-permissions` only when the user explicitly opts in and the environment is sandboxed/disposable.
7. **Do not replay conversation history** into a resumed session. ACP resume is explicitly “without replaying its history”; replaying foreign turns/tool calls also creates model-switch and signature bugs.
8. **Do not put API keys in plugin settings files** that are synced or committed. Use the child process environment.
9. **Do not claim official Google support** for a community plugin. The ACP page itself labels the VS Code client as community-maintained.

## 5. What the official ACP docs specify that the PR / third-party plugins do not implement

Implementations reviewed:

- **OpenCode PR #65430** — `ref/opencode-pr-65430/packages/core/src/plugin/provider/antigravity/` (draft provider; ACP adapter in `antigravity/acp.ts`, `antigravity/session.ts`, `antigravity/catalog.ts`, `language-model/`).
- **`system1970/opencode-antigravity-acp` v0.2.0** — `ref/opencode-antigravity-acp/` (npm `opencode-antigravity-acp`).
- **`rasyidrafi/opencode-antigrvity` v0.6.5** — `ref/opencode-antigrvity/` (ACP Registry server + host-tool bridge).

Legend: **Yes** = implemented; **Partial** = works only in a subset of cases; **No** = absent.

| Official ACP feature | PR #65430 | system1970 v0.2.0 | rasyidrafi v0.6.5 |
| --- | --- | --- | --- |
| Backend is the documented `agy acp` | Yes | Yes (`agy acp --stdio --process-per-session`) | No — drives the official ACP Registry binary `agy_acp_server.par`, not the `agy` CLI |
| ACP protocol v1 over stdio | Yes | Yes | Yes |
| ACP `authenticate` for all documented methods | **No** | **Partial** — 4 of 5; no `terminal-login` | **No** — bridges CLI refresh token instead |
| Reuses cached `agy` credentials | Yes (implicitly) | Yes, plus explicit `authenticate` | Yes, but copies/repairs them into ACP storage |
| Dynamic model catalog | Yes (lists) | Yes | Yes |
| Applies the selected model | **No** — `run()` ignores `request.model` | Yes (`session/set_config_option` / `session/set_model`) | Yes |
| Thinking level / effort | **No** | Yes (`thought_level`) | Yes |
| Modes (`default`, `accept-edits`, `auto`, `plan`) | **No** | Yes (all 4) | Partial — maps `accept-edits` to ACP `auto_edit` and `plan` to `default`; does not expose `auto` |
| Permission request bridge | **No** — refuses every request by default, no callback wired | Yes | Yes |
| `session/resume` | **Partial** — client method exists but is never called; no persisted session ID | Yes | No — uses `session/load` |
| `session/load` | **No** | **No** | Yes |
| `session/list` | **No** | **No** | **No** |
| `session/close` | **No** (process kill only, not ACP close) | **Partial** — sends `session/close` in some paths, but disposal mainly kills the process | **No** |
| Extra workspace folders / `additionalDirectories` | **No** | **Partial** — only explicit `--add-dir`; does not send ACP additional dirs | **No** |
| Images / embedded context | **No** — text-only prompt | Yes (images; not embedded resource blocks) | Yes (text/image attachments) |
| Slash-command discovery (`available_commands_update`) | **No** | **No** | **Partial** — turns the update into a text notice, not a command menu |
| Elicitation / question forms | **No** | **No** | **No** |
| Steering (prompt during a running turn) | **No** | **No** — a new prompt supersedes/interrupts the active turn | **No** direct ACP steering |
| Context-window `usage_update` | **No** | **No** | Yes |
| `--process-per-session` | **No** | Yes (always) | Not applicable (registry binary) |
| `--ide-mcp-port` (host IDE tools) | **No** | **No** | **No** — uses its own host-tool bridge/`_meta.agy.enabledTools` |
| `--sandbox` / `--agent` | **No** | **No** | **No** |

**Absent from all three implementations:** `session/list`, `terminal-login`, `--ide-mcp-port`, ACP elicitation forms, and ACP `additionalDirectories`. `session/load` is present only in the registry-binary provider; `session/close` is partial at best. These are the clearest “official docs say it, none of the reviewed code does it” gaps.

### 5.1 PR #65430: specific gaps

1. **Model selection is cosmetic.** `AntigravitySession.run()` accepts `request.model` but never uses it; `Client.newSession()` sends only `cwd` and `mcpServers: []`. There is no `session/set_model` or `session/set_config_option` call. The model picker can change the UI while the agent stays on the session’s initial model.
2. **No authentication flow.** There is no `authenticate` call, no auth-method discovery, and no mapping of `Authentication required` / `-32000` to a sign-in action. It relies entirely on cached `agy` credentials.
3. **No modes.** `session/set_mode` is never called; `session/new`’s `modes` payload is ignored. The provider always runs whatever default the CLI picked.
4. **Every permission request is refused.** `answer()` in `acp.ts` selects `reject_once` when the host supplies no permission callback; the language model never supplies one. The agent therefore cannot edit files or run commands that require approval — it is effectively read-only unless the CLI’s own rules auto-allow an action.
5. **No session persistence.** `Client.resume()` exists, but `Session` never calls it and never stores the returned `sessionId`; after an OpenCode restart a new CLI session is created.
6. **No `session/load`, `session/list`, or `session/close`.** Closing the client kills the child process rather than sending ACP close.
7. **Update handling is minimal.** `toUpdate()` handles only `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, and `tool_call_update`. It ignores `plan`, `usage_update`, `available_commands_update`, `current_mode_update`, `config_option_update`, and `session_info_update` (titles).
8. **Text-only prompts.** No image or embedded-resource content blocks.
9. **No `additionalDirectories`.** One cwd per session.
10. **No `--process-per-session`, `--sandbox`, `--agent`, `--ide-mcp-port`, or terminal auth.**
11. **Spec cites a FAQ statement that is not in the saved FAQ.** `specs/v2/antigravity-provider.md` says “Google’s FAQ names the unmodified `antigravity-acp` runtime with native `oauth-personal` sign-in as usable for single-user interactive development.” The current FAQ contains no such sentence; it says third-party software with an Antigravity login is a ToS violation and recommends an API key/enterprise path. Do not reuse that justification without locating a source.

### 5.2 `system1970/opencode-antigravity-acp` v0.2.0: specific gaps

Strengths relative to the PR: real ACP auth (4 methods), live model/effort discovery via `configOptions`, all four modes, permission bridging, `session/resume`, `session/close` in some paths, image prompts, and an optional single Code Mode MCP server. It also pins `--process-per-session`, matching the docs’ requirement for editor-configured HTTP MCP.

Gaps against the official ACP page:

1. **No `session/load` or `session/list`.** It stores/resumes one ACP session ID per OpenCode session, but cannot enumerate or load arbitrary server-side sessions.
2. **No `terminal-login`.** `KNOWN_AUTH_METHODS` contains only `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`. It also never advertises ACP terminal capability, so the server would not offer terminal auth to it.
3. **No `usage_update` handling.** It reads `usage` from the `session/prompt` result (token accounting) but ignores `sessionUpdate: "usage_update"` (context-window occupancy). The 1.5.8 feature is therefore invisible.
4. **No `available_commands_update` handling.** Antigravity’s slash commands/skills never reach an OpenCode command menu.
5. **No elicitation/question forms.** It does not advertise or handle ACP elicitation; questions are not surfaced natively.
6. **No steering.** A new prompt while a turn is active calls `handleInterrupt(..., "Superseded by new prompt")`; it replaces the turn instead of steering it.
7. **No `--ide-mcp-port`.** It cannot expose the editor’s own MCP server to the agent; it only relays OpenCode tools through its own MCP server.
8. **No `--sandbox` / `--agent` controls.** It exposes only `--dangerously-skip-permissions` and `--add-dir`.
9. **No ACP `additionalDirectories`.** Extra dirs are passed via CLI `--add-dir` at process start, not per-session as the protocol allows.
10. **ACP close is not consistently used on dispose.** It calls `session/close` in some paths, but disposal primarily kills the process (`dispose()` / `killImmediate()`), so the 1.5.3 “wait for backend shutdown” guarantee is not consistently used.

### 5.3 `rasyidrafi/opencode-antigrvity` v0.6.5: specific gaps and compliance concern

This provider is architecturally different: it discovers/downloads the **official ACP Registry** binary (`agy_acp_server.par` / `.exe`) and talks ACP to it directly, rather than spawning `agy acp`.

Functional gaps against the ACP page:

1. **No `session/list` or `session/close`.** It creates `session/new` or loads one remembered ID via `session/load`; it does not enumerate or explicitly close server-side sessions.
2. **No `terminal-login`.** Auth is either inherited from a bridged CLI token or an API key; it does not implement the ACP terminal auth method.
3. **No `--process-per-session`, `--sandbox`, `--agent`, or `--ide-mcp-port`** (it does not launch the `agy` CLI).
4. **No native slash-command menu or elicitation forms**; `available_commands_update` is translated to a text notice.

Compliance concern (important for this project):

- `src/auth-bridge.ts` reads the CLI’s refresh token (`resolveCliRefreshToken`), decodes an embedded OAuth client ID/secret, and writes `~/.gemini/antigravity-acp/acp_token.json`, then forces `settings.auth.type = "oauth-personal"`. The comment says the CLI source file is left alone and the token never enters logs, but this is still **copying/replaying Antigravity OAuth credentials into another program’s storage**. It falls squarely within the pattern the ToS example (“third-party software … with Antigravity OAuth”) and FAQ Q1 target, and it bypasses the documented ACP `authenticate` flow.
- Recommendation for the standalone plugin: do **not** copy this approach. Use `authenticate` / cached `agy` login / `GEMINI_API_KEY` as documented.

### 5.4 Minimum feature set implied by the docs

If the goal is “implement what the official ACP page advertises,” the plugin needs at least:

1. Spawn `agy acp` with the project directory as cwd (absolute `agy` path configurable).
2. `initialize` with protocol v1 and parse `agentCapabilities`, `authMethods`, `promptCapabilities`.
3. Auth: prefer cached credentials; on `-32000`, offer the documented methods (including terminal auth if supported); never scrape tokens.
4. `session/new` or `session/load`/`session/resume`; preserve session IDs across restarts; implement `session/list` and `session/close`.
5. Apply `configOptions` for model and thinking level; apply `modes` (`default`, `accept-edits`, `auto`, `plan`).
6. Bridge permission requests to the editor UI; respect allow/deny rules; never auto-approve by default.
7. Stream tool calls, diffs, plans, titles, `usage_update`, and `available_commands_update`.
8. Support images and embedded context; support `additionalDirectories`.
9. Support cancel/steering semantics: `session/cancel` stops open tool calls and pending permission prompts; a new prompt during a turn should steer, not silently start a second turn.
10. Clean shutdown: `session/close`, then terminate the child/process group; ensure background tasks/subagents stop.
11. Pass `GEMINI_API_KEY`/ADC only through the child environment; never persist secrets.
12. Version-gate and feature-detect; 1.5.0 is the ACP floor, but 1.5.8/1.5.10/1.5.13 fixes matter.

---

## 6. Contradictions, stale docs, and open questions

Do not silently resolve these in code. Record the behavior you observe and make it configurable.

### 6.1 Third-party model allowlist vs “every model to every ACP client”

- **ACP page:** “Gemini models are available in every client. Third-party models are only offered to JetBrains IDEs (including JetBrains Air), Android Studio, Android Performance Analyzer, Zed, and Xcode.”
- **CHANGELOG 1.5.1:** “Changed `agy acp` to offer every model available to your account to every ACP client, where previously only a fixed list of editors were offered models other than Gemini.”
- **Observed 1.5.14 handshake** (`ref/notes/agy-acp-handshake.log`): a client identifying as `opencode-probe` received 27 models including `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, and `gpt-oss-120b-medium`.

**Reading:** the docs’ allowlist appears stale relative to the 1.5.1 change, or describes a policy not enforced by the 1.5.14 build. For product design, discover models from `session/new` rather than hardcoding. If the project wants to stay conservative, offer Gemini models by default and require an explicit opt-in for third-party models, with a note that the docs restrict them to named editors.

### 6.2 “Any ACP client” vs “OpenCode with an Antigravity login is a ToS violation”

- **ACP page:** “Any ACP client can launch Antigravity CLI.”
- **FAQ Q1:** “Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service … [OpenCode is named] … can result in suspension or termination.”
- **Additional Terms:** “Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement.”

**Possible reconciliations** (none is stated by Google):

1. ACP is the sanctioned transport for **editors**, and the FAQ targets **credential-extraction/OAuth-replay** tools that impersonate first-party clients; an ACP client that launches the real `agy acp` binary is different.
2. The FAQ is broader and applies to **any** third-party coding agent, including ACP clients; the ACP page is written for editors and does not carve out an exception.

The FAQ names OpenCode specifically, so interpretation 1 cannot be assumed for this project. The safest engineering stance:

- Make the auth path explicit: `oauth-personal` (consumer) vs `gemini-api-key`/`agent-platform` (API/enterprise).
- Show the FAQ/ToS warning before first use of consumer OAuth from OpenCode.
- Provide a documented “API key / enterprise only” mode for users who need a clearly recommended third-party path.
- Do not claim that ACP support equals ToS permission.

### 6.3 The PR spec’s FAQ citation is unsupported

`ref/opencode-pr-65430/specs/v2/antigravity-provider.md` says the FAQ “names the unmodified `antigravity-acp` runtime with native `oauth-personal` sign-in as usable for single-user interactive development.” The saved FAQ (and the live FAQ on 2026-11-22) contains no such sentence. The PR may be referring to an older FAQ, a forum post, or the ACP Registry listing. Treat the claim as unverified.

### 6.4 `session/load`, `session/list`, `session/close`, and `--process-per-session` are not in the 1.5.x changelog

The ACP page and the ACP Registry protocol matrix say the server supports `loadSession`, `session/list`, and `session/resume`. The changelog announces `session/resume` in 1.5.0 and mentions “closing, reloading, or resuming” and “session list” in bug fixes, but never announces `session/load` or `session/list` as new methods. `--process-per-session` and `--ide-mcp-port` are also absent from the changelog. Do not infer that these features exist on every 1.5.x build; probe `initialize.agentCapabilities` and handle `-32601`/unsupported methods.

### 6.5 `terminal-login` is conditional

The ACP page lists five auth methods. The observed 1.5.14 `initialize` response offered only four; the probe client did not advertise terminal authentication, and the docs say `terminal-login` is “only offered to clients that support ACP terminal authentication.” If the plugin wants it, it must advertise the terminal capability and implement the terminal auth flow; otherwise it will never see the method.

### 6.6 Thinking-level labels differ

- ACP page: `Low`, `Medium`, `High`, `Extra`, `Max`.
- Observed 1.5.14 `thought_level` options: `low`, `medium`, `high`, `xhigh` (name “Extra”). No `Max` was observed for that model.
- The available set changes by model (e.g. setting a model can remove `xhigh`; see `ref/notes/agy-acp-config.log`).

**Reading:** do not hardcode the five labels. Read `configOptions` and render the server’s current values; preserve the value IDs, not the display names.

### 6.7 Two official distribution surfaces, two credential stories

- `agy acp` uses the credentials cached by the CLI (keyring/file under the CLI’s data dir), per the ACP page.
- The ACP Registry ships a separate `agy_acp_server.par`/`.exe` binary for Android Studio and similar clients. The registry entry is official Google (`authors: ["Google LLC"]`, `license: "proprietary"`, version 1.5.2 in the saved snapshot), but the ACP page does not describe its credential storage.
- The `rasyidrafi` provider’s code assumes the registry server keeps `~/.gemini/antigravity-acp/acp_token.json`, separate from the CLI, and bridges the CLI refresh token into it. That is a third-party observation, not official documentation.

**Open question for the standalone plugin:** if it targets `agy acp` only, use the CLI’s cached credentials. If it ever targets the registry binary, do not assume the CLI’s credentials are visible to it; implement the documented `authenticate` flow rather than copying token files.

### 6.8 `--dangerously-skip-permissions` is not absolute

The ACP page describes it as “Auto-approve all tool permission requests.” CHANGELOG 1.5.2 says commands on the system denylist are still blocked, enterprise admin review still applies, and explicit deny rules still apply. Treat the flag as “skip prompts where policy allows,” not “disable all policy.”

### 6.9 ACP docs do not state a minimum version

ACP was added in 1.5.0, but the docs do not say “requires 1.5.0.” Features cited in the docs (context usage, Auto mode, model dedupe, `--process-per-session`) arrived at different times. Gate on `agy --version` and capability detection, not just “ACP exists.”

### 6.10 The ACP page does not discuss the FAQ/ToS conflict

The page’s only caution is about API keys in editor settings. A reader of the ACP page alone would conclude that any ACP client is fine. A reader of the FAQ alone would conclude that OpenCode with an Antigravity login is prohibited. The plugin should link both and not present a one-sided claim.

---

## 7. Source map

| Topic | Saved path | Canonical URL |
| --- | --- | --- |
| ACP setup, clients, auth, flags, sessions | `ref/notes/antigravity-acp-docs.html` | <https://antigravity.google/docs/ide/extensions/acp/> |
| ACP authentication section | same | <https://antigravity.google/docs/ide/extensions/acp/#authentication> |
| ACP sessions section | same | <https://antigravity.google/docs/ide/extensions/acp/#sessions> |
| ACP permissions section | same | <https://antigravity.google/docs/ide/extensions/acp/#permissions> |
| ACP flags table | same | <https://antigravity.google/docs/ide/extensions/acp/#flags> |
| FAQ third-party software | `ref/notes/antigravity-faq.html` | <https://antigravity.google/docs/faq#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login> |
| FAQ `agy -p` / account switching | same | <https://antigravity.google/docs/faq#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching> |
| FAQ Workspace / enterprise sign-in | same | <https://antigravity.google/docs/faq#can-i-use-antigravity-with-my-google-workspace-account>, <https://antigravity.google/docs/faq#why-cant-i-sign-in-with-my-enterprise-account> |
| Additional Terms of Service | fetched live 2026-11-22 | <https://antigravity.google/terms> |
| CLI changelog (ACP introduced 1.5.0; current 1.5.14) | `ref/antigravity-cli/CHANGELOG.md` | (repository file) |
| CLI README (auth, data use, security warning) | `ref/antigravity-cli/README.md` | (repository file) |
| Headless mode (`agy -p`) | fetched live for context | <https://antigravity.google/docs/cli/headless> |
| CLI flag reference | fetched live for context | <https://antigravity.google/docs/cli/reference> |
| Local `agy acp --help` 1.5.14 | `ref/notes/agy-cli-info.txt` | local observation |
| Local ACP handshake / config probe | `ref/notes/agy-acp-handshake.log`, `ref/notes/agy-acp-config.log` | local observation |
| ACP Registry entry for Google Antigravity (1.5.2, proprietary, Google LLC) | `ref/acp-registry/antigravity-acp/agent.json` | <https://github.com/agentclientprotocol/registry> (snapshot) |
| ACP Registry protocol matrix (1.5.2: loadSession, session/list, session/resume) | `ref/acp-registry/.protocol-matrix/latest.md` | registry snapshot |

---

### 6.11 Forum clarification (2026-11-20) — thin client vs outer harness

A Google Antigravity forum reply directly answers the OpenCode question. It is a forum post, not the Terms/FAQ text, but it is the most specific official-forum statement available and it explicitly cites Section 6, the FAQ, and the ACP page.

Source: <https://discuss.ai.google.dev/t/tos-clarification-is-opencode-antigravity-acp-official-agy-acp-in-opencode-permitted-under-the-antigravity-terms-of-service/202970/2>

Verbatim (post 2, author `Rebbanpalli_Naveen`, 2026-11-20T13:13:30Z):

> Under Section 6 of the [Google Antigravity Terms](https://antigravity.google/terms), the [FAQ](https://antigravity.google/docs/faq#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login), and [Other editors (ACP)](https://antigravity.google/docs/ide/extensions/acp):
>
> - **Consumer `oauth-personal` Boundary:** Launching unmodified `agy acp` interactively is permitted only in a thin client where **Antigravity is the agent**—meaning the human sends raw prompts directly to `agy acp` and Antigravity owns its sign-in, system prompt, tools, and session history. Wrapping `agy acp` inside an outer third-party coding agent harness (such as OpenCode) that injects system instructions, serialized tool definitions, replayed cross-model context, or automated loops is **not** permitted on `oauth-personal`—even without extracting OAuth tokens—and risks automated enforcement or suspension.
> - **Compliant Path:** For an outer agent harness, authenticate via `gemini-api-key` (`GEMINI_API_KEY`) or Google Cloud `agent-platform` ([ACP Authentication](https://antigravity.google/docs/ide/extensions/acp#authentication)), passing explicit ACP `authenticate` or running `/logout` so cached consumer OAuth is not reused. For your README, please link the [Terms](https://antigravity.google/terms), [FAQ](https://antigravity.google/docs/faq), and [ACP docs](https://antigravity.google/docs/ide/extensions/acp).

The thread is specifically about `system1970/opencode-antigravity-acp`, which bridges workspace context/MCP tools and does cross-model handoff. Later replies ask whether T3 Code would also be affected; there is no further official answer in the thread as of 2026-11-22.

What this resolves and what it leaves open:

- **Resolves the main ambiguity:** the prohibited pattern is not merely “ACP from a third-party client.” The reply distinguishes (a) direct/bypassing access (token extraction, reverse proxy, impersonation, `agy -p` wrapping) from (b) unmodified `agy acp` in a thin client.
- **Adds a crucial condition:** consumer `oauth-personal` thin-client permission requires Antigravity to be the agent and the human to send raw prompts directly to `agy acp`; the outer harness must not inject system instructions, serialized tool definitions, replayed cross-model context, or automated loops.
- **Names OpenCode:** the reply gives OpenCode as an example of an outer harness that injects those things. If an OpenCode plugin is strictly thin (clears OpenCode system/tools, sends only the current user turn, no cross-model replay, no MCP relay/Code Mode, no automated loops), it is closer to the permitted thin-client case; but because OpenCode is named, this is still a boundary judgment, not a guaranteed exemption.
- **Compliant outer-harness path:** `gemini-api-key` or `agent-platform`, with explicit ACP `authenticate` (or `/logout`) so cached consumer OAuth is not reused.
- **PR #65430 attribution:** its spec quotes “the FAQ names the unmodified `antigravity-acp` runtime with native `oauth-personal` sign-in as usable for single-user interactive development.” That sentence is not in the FAQ; it is a paraphrase of this forum reply. The PR also omits the thin-client/no-injection condition, so it cannot be used as an unconditional permission.
- **Our standalone plugin:** designed strict-thin; `allowConsumerAuth: true` is an explicit acknowledgment of the thin-client boundary. If MCP relay/Code Mode/cross-model handoff is added later, switch to `gemini-api-key`/`agent-platform`.

---

## Appendix A: `agy acp --help` 1.5.14 vs the docs

From `ref/notes/agy-cli-info.txt`:

```text
Usage: agy acp [flags]

Start the Agent Client Protocol (ACP) stdio server
```

Documented flags (ACP page): `--add-dir`, `--agent`, `--sandbox`, `--dangerously-skip-permissions`, `--process-per-session`, `--ide-mcp-port`, `--login`, `--log-file`, `--disable-telemetry`.

Additional flags visible in 1.5.14 help but **not** in the ACP page:

| Flag | Meaning / note |
| --- | --- |
| `--stdio` | Use stdio JSON-RPC transport (default). Harmless; redundant. |
| `--app-data-dir`, `--app_data_dir` | Path where application data is stored (default `antigravity-cli`). |
| `--cli_dir_name` | Subdirectory under `app_data_dir` for CLI settings/logs. |
| `--cli_log_file` | Override ACP log file path (same description as `--log-file`; likely an alias). |
| `--cloud_code_endpoint` | CCPA API URL (default `https://daily-cloudcode-pa.googleapis.com`). |
| `--gemini-dir`, `--gemini_dir` | Path where Gemini files are stored (default `.gemini`). |
| `--include-default-customizations` | Include default customizations (default true). |
| `--is_google3_workspace` | Whether running in Google environment. |
| `--is_google_internal` | Deprecated: use `is_google3_workspace`. |
| `--override_user_agent_name` | Override user-agent name for HTTP requests. |
| `--use_stubby_auth` | Use LOAS auth. |
| `--worker` | Serve a single session for an ACP front process (**internal**). |

**Guidance:** use only the documented flags for the supported contract. `--stdio` is the default; `--worker` is internal; `--override_user_agent_name` and `--cloud_code_endpoint` are not part of the documented ACP integration and should not be used to spoof or redirect traffic. `--app-data-dir`/`--gemini-dir` can be useful for test isolation, but are undocumented.

---

## Appendix B: observed 1.5.14 ACP capabilities

Source: `ref/notes/agy-acp-handshake.log`, `ref/notes/agy-acp-config.log`. These are local observations, not official docs.

`initialize` result:

- `protocolVersion: 1`
- `agentInfo.name: "Antigravity ACP Server"`, `agentInfo.version: "1.5.14"`
- `agentCapabilities.loadSession: true`
- `agentCapabilities.sessionCapabilities`: `resume`, `close`, `load`, `list`, `additionalDirectories` (with snake_case duplicates in the same payload)
- `agentCapabilities.promptCapabilities`: `image: true`, `audio: false`, `embeddedContext: true`
- `agentCapabilities.auth.logout: {}`
- `_meta.antigravity.tier: true`, `_meta.antigravity.systemPrompt.append: true`
- `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` (no `terminal-login`; the probe did not advertise terminal auth, consistent with the docs’ condition)

`session/new` result:

- 27 `availableModels`, including Gemini 4 Neon/Carbon/Argon/Hydrogen, Gemini 3.8 Flash, Orchestrator, Claude Opus 5.5, Claude Sonnet 5.5, and GPT-OSS 120B.
- `modes.availableModes`: `default`, `accept-edits`, `auto`, `plan` (`currentModeId: default`).
- `configOptions`: `model` (11 values at model-family level), `thought_level` (`low`, `medium`, `high`, `xhigh`), `mode` (4 values).
- `_meta.antigravity.tier`: Google AI Ultra.

Observed notifications/methods:

- `session/set_config_option` with `configId: "model"` and `"thought_level"` works; the server emits `config_option_update`.
- `session/set_mode` works; the server emits `current_mode_update`.
- `available_commands_update` lists `goal`, `compact`, `schedule`, `browser`, `plan`, `grill-me`, `teamwork`, `learn`, `boost`, `agy-customizations`, `antigravity-guide`, `run-workflow`, `swarm`.
- `usage_update` reports `used` / `size` (context window; 1,048,576 in the probe).

Design takeaway: prefer `configOptions`/`modes` over hardcoded model IDs. The server changes the available option set after a model change (e.g. `xhigh` disappears for some models), so re-read `config_option_update` rather than assuming a fixed matrix.

---

## Appendix C: practical checklist for the standalone plugin

- [ ] Spawn an **absolute** `agy` path (configurable via env), args `["acp"]`, cwd = project directory.
- [ ] `initialize` protocol v1; store `agentInfo`, `authMethods`, `agentCapabilities`, `promptCapabilities`.
- [ ] Auth: cached credentials first; on `-32000`, present the documented methods; call `authenticate`; never read token files.
- [ ] `session/new`; apply `configOptions` (model, thought_level) and `modes`; re-read on updates.
- [ ] Persist `sessionId`; on restart use `session/resume` or `session/load`; implement `session/list`/`session/close`.
- [ ] Permission bridge: show tool/command/path; honor allow/deny/ask; default to refuse/ask, never auto-approve.
- [ ] Stream message/thought/tool/diff/plan/title updates; handle `usage_update` and `available_commands_update`.
- [ ] Images and embedded context; `additionalDirectories` for multi-root workspaces.
- [ ] Cancel and steering semantics; close stops subagents/background tasks and saves conversation.
- [ ] API key/ADC only through the child environment; no secrets in config/logs.
- [ ] Version/capability gate; degrade gracefully on pre-1.5.8/pre-1.5.10 builds.
- [ ] Show the FAQ/ToS warning for consumer `oauth-personal`; document the API-key/enterprise alternative.
- [ ] Tests: mock JSON-RPC for lifecycle; live smoke only with an authenticated disposable account; never commit credentials.

