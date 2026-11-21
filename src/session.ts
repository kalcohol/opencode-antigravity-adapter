// Session manager for the Antigravity ACP provider.
//
// Adapted from system1970/opencode-antigravity-acp (MIT) for the standalone
// local plugin in this repository. The ACP transport itself lives in
// ./acp/client.ts.

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import {
  AcpProcess,
  buildModelCatalog,
  resolveAcpAuthMethod,
  resolveAcpModelTarget,
  type AcpContentBlock,
  type AcpDiscoveredModel,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpPermissionRequestParams,
  type AcpPromptResult,
  type AcpSessionUpdate,
} from "./acp/client.js"

export type AcpMode = "default" | "accept-edits" | "auto" | "plan"
export type PermissionMode = "ask" | "allow" | "deny"

export interface Options {
  /** Working directory for every ACP session owned by this plugin location. */
  readonly directory: string
  /** `agy` binary; defaults to PATH lookup / AGY_BIN. */
  readonly command?: string
  /** How Antigravity's own tool permission requests are answered. */
  readonly permission: PermissionMode
  /** ACP session mode to apply when a session starts. */
  readonly mode: AcpMode
  /** Default reasoning effort when the selected model has no variant. */
  readonly effort?: string
  /**
   * Acknowledge the consumer `oauth-personal` thin-client boundary. Google's
   * Antigravity forum reply permits unmodified `agy acp` only in a thin client
   * where Antigravity owns the agent; an outer harness that injects system
   * instructions, tool schemas, replayed context, or automated loops needs
   * `gemini-api-key` or `agent-platform`.
   */
  readonly allowConsumerAuth: boolean
}

export interface RunRequest {
  /** OpenCode model id: the base model id without the effort suffix. */
  readonly model: string
  /** OpenCode variant id: low/medium/high/xhigh or a CLI-specific suffix. */
  readonly variant?: string
  readonly prompt: readonly AcpContentBlock[]
}

interface StoredSession {
  readonly acpSessionId?: string
  readonly model?: string
  readonly effort?: string
  readonly mode?: string
}

interface ActiveTurn {
  readonly onUpdate: (update: AcpSessionUpdate) => void
  cancelled: boolean
}

interface SessionState {
  readonly sessionID: string
  proc: AcpProcess
  acpSessionId: string
  catalog: readonly AcpDiscoveredModel[]
  modes: readonly string[]
  model?: string
  effort?: string
  mode?: string
  agent: string
  active?: ActiveTurn
  cancelled: boolean
  readonly permissionCancels: Set<() => void>
  lastError?: string
}

const STORAGE_PREFIX = "session:"

const select = (option: AcpPermissionOption | undefined): AcpPermissionOutcome =>
  option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" }

const cancelPermissions = (state: SessionState) => {
  for (const cancel of [...state.permissionCancels]) cancel()
  state.permissionCancels.clear()
}

const isAuthError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (/auth|login|credential|sign in/i.test(message)) return true
  return (error as { acpCode?: unknown })?.acpCode === -32000 && /auth/i.test(message)
}

export class SessionManager {
  private readonly states = new Map<string, SessionState>()
  private readonly agents = new Map<string, string>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly options: Options,
  ) {}

  /** Remember the OpenCode agent for permission prompts on this session. */
  setAgent(sessionID: string, agent: string): void {
    this.agents.set(sessionID, agent)
    const state = this.states.get(sessionID)
    if (state) state.agent = agent
  }

  /** Run one Antigravity turn. One turn per OpenCode session at a time. */
  async run(
    sessionID: string,
    request: RunRequest,
    onUpdate: (update: AcpSessionUpdate) => void,
    signal: AbortSignal,
  ): Promise<AcpPromptResult> {
    if (this.disposed) throw new Error("Antigravity ACP plugin was disposed")
    if (signal.aborted) throw new Error("Antigravity turn was cancelled before it started")
    if (resolveAcpAuthMethod() === "oauth-personal" && !this.options.allowConsumerAuth) {
      throw new Error(
        "Antigravity consumer login (oauth-personal) needs explicit acknowledgement. " +
          "Google's Antigravity forum reply permits unmodified agy acp only in a thin client where " +
          "Antigravity owns the agent; outer-harness injection (system instructions, tool schemas, " +
          "replayed cross-model context, or automated loops) is not permitted on oauth-personal. " +
          "This plugin is strict-thin. Set plugin option \"allowConsumerAuth\": true to acknowledge that " +
          "boundary, or use GEMINI_API_KEY, oauth-business, or agent-platform.",
      )
    }

    const state = await this.ensure(sessionID)
    if (state.active) throw new Error("Antigravity is already running a turn in this session")

    await this.applyModel(state, request.model, request.variant)

    state.cancelled = false
    const active: ActiveTurn = { onUpdate, cancelled: false }
    state.active = active

    let cleanup = () => {}
    try {
      return await new Promise<AcpPromptResult>((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void) => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const onAbort = () => {
          active.cancelled = true
          state.cancelled = true
          cancelPermissions(state)
          void state.proc.cancel(state.acpSessionId)
          settle(() => reject(new Error("Antigravity turn was cancelled")))
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
        cleanup = () => signal.removeEventListener("abort", onAbort)
        state.proc.prompt(state.acpSessionId, request.prompt).then(
          (result) => settle(() => resolve(result)),
          (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
        )
      })
    } finally {
      cleanup()
      if (state.active === active) state.active = undefined
    }
  }

  /** Cancel the active turn, if any. Safe to call from event handlers. */
  async cancel(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state) return
    state.cancelled = true
    if (state.active) state.active.cancelled = true
    cancelPermissions(state)
    await state.proc.cancel(state.acpSessionId).catch(() => undefined)
  }

  /** Close the ACP session and its process, and remove its persisted binding. */
  async close(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state) return
    this.states.delete(sessionID)
    this.agents.delete(sessionID)
    state.cancelled = true
    cancelPermissions(state)
    await state.proc.closeSession(state.acpSessionId).catch(() => undefined)
    await state.proc.dispose()
    await Effect.runPromise(this.ctx.storage.remove(`${STORAGE_PREFIX}${sessionID}`)).catch(() => undefined)
  }

  /** Close every ACP process owned by this plugin instance. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const states = [...this.states.values()]
    this.states.clear()
    await Promise.allSettled(
      states.map(async (state) => {
        state.cancelled = true
        cancelPermissions(state)
        await state.proc.closeSession(state.acpSessionId).catch(() => undefined)
        await state.proc.dispose()
      }),
    )
  }

  private async ensure(sessionID: string): Promise<SessionState> {
    const existing = this.states.get(sessionID)
    if (existing && !existing.proc.isClosed) return existing
    if (existing) this.states.delete(sessionID)
    return await this.start(sessionID)
  }

  private async start(sessionID: string): Promise<SessionState> {
    const state: SessionState = {
      sessionID,
      proc: undefined as unknown as AcpProcess,
      acpSessionId: "",
      catalog: [],
      modes: [],
      mode: this.options.mode,
      agent: this.agents.get(sessionID) ?? "build",
      cancelled: false,
      permissionCancels: new Set(),
    }

    const proc = new AcpProcess({
      cwd: this.options.directory,
      binaryPath: this.options.command,
      onUpdate: (_acpSessionID, update) => {
        state.active?.onUpdate(update)
      },
      onPermissionRequest: (params) => this.permission(state, params),
      onExit: (_code, _signal, stderrTail) => {
        state.lastError = stderrTail
        state.active = undefined
      },
    })
    state.proc = proc

    try {
      await proc.initialize()
      // The forum clarification recommends explicitly authenticating the
      // selected non-consumer method so cached consumer OAuth is not reused
      // by an outer harness. `authenticate` ignores "already authenticated".
      if (resolveAcpAuthMethod() !== "oauth-personal") {
        await proc.authenticate()
      }
      const stored = await this.readStored(sessionID)
      let session: any
      if (stored?.acpSessionId) {
        try {
          session = await proc.resumeSession({
            sessionId: stored.acpSessionId,
            cwd: this.options.directory,
            mcpServers: [],
          })
        } catch {
          session = await this.newSession(proc)
        }
      } else {
        session = await this.newSession(proc)
      }

      state.acpSessionId = String(session.sessionId)
      state.catalog = buildModelCatalog(session)
      state.modes = Array.isArray(session.modes?.availableModes)
        ? session.modes.availableModes
            .map((mode: any) => (typeof mode?.id === "string" ? mode.id : undefined))
            .filter((id: string | undefined): id is string => Boolean(id))
        : []
      state.model = stored?.model
      state.effort = stored?.effort
      state.mode = stored?.mode ?? this.options.mode

      await this.applyMode(state)
      this.states.set(sessionID, state)
      await this.writeStored(state)
      return state
    } catch (error) {
      await proc.dispose()
      throw error
    }
  }

  private async newSession(proc: AcpProcess): Promise<any> {
    try {
      return await proc.newSession({ cwd: this.options.directory, mcpServers: [] })
    } catch (error) {
      if (!isAuthError(error)) throw error
      // The user normally signs in with `agy` in a terminal. If the ACP server
      // still asks for auth, try the advertised consumer login once.
      await proc.authenticate()
      return await proc.newSession({ cwd: this.options.directory, mcpServers: [] })
    }
  }

  private async applyModel(state: SessionState, model: string, variant?: string): Promise<void> {
    const target = resolveAcpModelTarget(state.catalog, model, variant ?? this.options.effort)
    if (!target) return
    if (state.model === target.baseModelId && state.effort === target.thoughtLevel) return

    try {
      // `configOptions` is the canonical ACP v1 surface. Antigravity exposes
      // model and thought level as two selectors; use the model result to
      // learn which thought levels remain valid before setting the effort.
      const modelResult = await state.proc.setConfigOption(
        state.acpSessionId,
        "model",
        target.baseModelId,
      )
      const options = Array.isArray(modelResult?.configOptions) ? modelResult.configOptions : []
      const thought = options.find((option: any) => option?.id === "thought_level")
      const levels = Array.isArray(thought?.options)
        ? thought.options.map((option: any) => String(option.value))
        : []
      let effort = target.thoughtLevel
      if (effort && levels.length > 0 && !levels.includes(effort)) {
        effort = typeof thought?.currentValue === "string" ? thought.currentValue : undefined
      }
      if (!effort && typeof thought?.currentValue === "string") effort = thought.currentValue
      if (effort) {
        const effortResult = await state.proc.setConfigOption(
          state.acpSessionId,
          "thought_level",
          effort,
        )
        const confirmed = effortResult?.configOptions?.find(
          (option: any) => option?.id === "thought_level",
        )?.currentValue
        if (typeof confirmed === "string") effort = confirmed
      }
      state.model = target.baseModelId
      state.effort = effort
      await this.writeStored(state)
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  private async applyMode(state: SessionState): Promise<void> {
    if (!state.mode) return
    if (state.modes.length > 0 && !state.modes.includes(state.mode)) {
      state.lastError = `Antigravity does not offer mode "${state.mode}"`
      return
    }
    if (state.modes.length === 0) return
    try {
      // The config option returns the complete state; `session/set_mode`
      // returns `{}` and may only confirm via a later notification.
      const result = await state.proc.setConfigOption(state.acpSessionId, "mode", state.mode)
      const confirmed = result?.configOptions?.find((option: any) => option?.id === "mode")?.currentValue
      if (typeof confirmed === "string" && confirmed !== state.mode) {
        state.lastError = `Antigravity confirmed mode "${confirmed}" instead of "${state.mode}"`
      }
    } catch {
      try {
        await state.proc.setMode(state.acpSessionId, state.mode)
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async permission(
    state: SessionState,
    params: AcpPermissionRequestParams,
  ): Promise<AcpPermissionOutcome> {
    if (state.cancelled) return { outcome: "cancelled" }

    const options = params.options ?? []
    const byKind = (kind: string) => options.find((option) => option.kind === kind)
    const allowOnce = byKind("allow_once")
    const allowAlways = byKind("allow_always")
    const rejectOnce = byKind("reject_once")
    const rejectAlways = byKind("reject_always")
    const denyOption = rejectOnce ?? rejectAlways
    const allowOption = this.options.permission === "allow" ? allowOnce ?? allowAlways : allowOnce

    if (this.options.permission === "allow") return select(allowOption)
    if (this.options.permission === "deny") return select(denyOption)
    if (!allowOption) {
      // OpenCode's `assert` only grants a single decision, so do not turn it
      // into an `allow_always` grant. If Antigravity only offers a persistent
      // allow, fail closed.
      state.lastError = "Antigravity offered no one-time allow option; denying the request"
      return select(denyOption)
    }

    const tool = params.toolCall
    const title = String(tool?.title ?? tool?.name ?? tool?.kind ?? "Antigravity tool")
    const resources = (tool?.locations ?? [])
      .map((location) => location.path)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
    if (resources.length === 0) resources.push(title)

    let cancelPermission: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelPermission = () => reject(new Error("Antigravity permission request was cancelled"))
      state.permissionCancels.add(cancelPermission)
    })

    try {
      await Promise.race([
        Effect.runPromise(
          this.ctx.permission.assert({
            sessionID: state.sessionID as any,
            agent: state.agent as any,
            action: `antigravity.${tool?.kind ?? tool?.name ?? "tool"}`,
            resources,
            metadata: {
              tool: tool?.name,
              title,
              rawInput: tool?.rawInput,
            },
          }),
        ),
        cancelled,
      ])
      return state.cancelled ? { outcome: "cancelled" } : select(allowOption)
    } catch {
      return state.cancelled ? { outcome: "cancelled" } : select(denyOption)
    } finally {
      if (cancelPermission) state.permissionCancels.delete(cancelPermission)
    }
  }

  private async readStored(sessionID: string): Promise<StoredSession | undefined> {
    try {
      const value = await Effect.runPromise(this.ctx.storage.get(`${STORAGE_PREFIX}${sessionID}`))
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
      return value as StoredSession
    } catch {
      return undefined
    }
  }

  private async writeStored(state: SessionState): Promise<void> {
    try {
      await Effect.runPromise(
        this.ctx.storage.set(`${STORAGE_PREFIX}${state.sessionID}`, {
          acpSessionId: state.acpSessionId,
          model: state.model,
          effort: state.effort,
          mode: state.mode,
        } as any),
      )
    } catch {
      // Storage is only a convenience for resume; a failure must not fail a turn.
    }
  }
}
