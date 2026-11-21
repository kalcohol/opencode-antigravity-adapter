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
  readonly cwd?: string
  readonly model?: string
  readonly effort?: string
  readonly mode?: string
}

interface ActiveTurn {
  readonly onUpdate: (update: AcpSessionUpdate) => void
  cancelled: boolean
  abort?: () => void
}

interface SessionState {
  readonly sessionID: string
  proc: AcpProcess
  acpSessionId: string
  cwd: string
  catalog: readonly AcpDiscoveredModel[]
  modes: readonly string[]
  supportsImage: boolean
  model?: string
  effort?: string
  mode?: string
  agent: string
  active?: ActiveTurn
  cancelled: boolean
  readonly permissionCancels: Set<() => void>
  readonly modeWaiters: Set<(mode: string) => void>
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
  private readonly starting = new Map<string, Promise<SessionState>>()
  private readonly closing = new Set<string>()
  private fallbackCatalog: readonly AcpDiscoveredModel[] = []
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly options: Options,
  ) {}

  /** Catalog used when a resume response omits models/variants. */
  setCatalog(catalog: readonly AcpDiscoveredModel[]): void {
    this.fallbackCatalog = catalog
  }

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

    const active: ActiveTurn = { onUpdate, cancelled: false }
    state.active = active
    state.cancelled = false

    let cleanup = () => {}
    try {
      await this.applyModel(state, request.model, request.variant)
      await this.applyMode(state, state.agent === "plan" ? "plan" : this.options.mode, true)

      const prompt = state.supportsImage
        ? request.prompt
        : request.prompt.map((block) =>
            block.type === "image"
              ? {
                  type: "text" as const,
                  text: "[image omitted: this ACP server does not advertise image prompt support]",
                }
              : block,
          )

      return await new Promise<AcpPromptResult>((resolve, reject) => {
        let settled = false
        let aborted = false
        const settle = (fn: () => void) => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        if (signal.aborted) {
          state.cancelled = true
          cancelPermissions(state)
          settle(() => reject(new Error("Antigravity turn was cancelled before it started")))
          return
        }
        const raw = state.proc.prompt(state.acpSessionId, prompt)
        const onAbort = () => {
          if (aborted) return
          aborted = true
          active.cancelled = true
          state.cancelled = true
          cancelPermissions(state)
          void state.proc.cancel(state.acpSessionId)
          void (async () => {
            let timedOut = false
            const timer = setTimeout(() => {
              timedOut = true
              state.proc.killImmediate()
            }, 2_000)
            timer.unref?.()
            await raw.catch(() => undefined)
            clearTimeout(timer)
            // Reset the process so late updates/permission requests from the
            // cancelled turn cannot leak into the next turn. The ACP session
            // id stays in storage, so the next turn resumes it in a new process.
            await state.proc.dispose()
            if (this.states.get(sessionID) === state) this.states.delete(sessionID)
            settle(() =>
              reject(
                new Error(
                  timedOut
                    ? "Antigravity turn was cancelled; the ACP process did not acknowledge in time and was reset."
                    : "Antigravity turn was cancelled",
                ),
              ),
            )
          })()
        }
        active.abort = onAbort
        signal.addEventListener("abort", onAbort, { once: true })
        cleanup = () => signal.removeEventListener("abort", onAbort)
        raw.then(
          (result) => {
            if (!aborted) settle(() => resolve(result))
          },
          (error) => {
            if (aborted) return
            if ((error as { acpCode?: unknown })?.acpCode === -32002) {
              void this.close(sessionID)
              settle(() =>
                reject(
                  new Error(
                    "Antigravity session expired; the turn was not retried. Send the message again to start a new ACP session.",
                  ),
                ),
              )
              return
            }
            settle(() => reject(error instanceof Error ? error : new Error(String(error))))
          },
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
    if (state.active?.abort) {
      state.active.abort()
      return
    }
    cancelPermissions(state)
    await state.proc.cancel(state.acpSessionId).catch(() => undefined)
  }

  /** Close the ACP session and its process, and remove its persisted binding. */
  async close(sessionID: string): Promise<void> {
    this.closing.add(sessionID)
    const pending = this.starting.get(sessionID)
    if (pending) {
      await Promise.race([
        pending.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
    const state = this.states.get(sessionID)
    if (!state) return
    this.closing.delete(sessionID)
    this.states.delete(sessionID)
    this.agents.delete(sessionID)
    state.cancelled = true
    cancelPermissions(state)
    // Best-effort: do not block a shared event stream for 5s.
    void state.proc.closeSession(state.acpSessionId).catch(() => undefined)
    await state.proc.dispose()
    await Effect.runPromise(this.ctx.storage.remove(`${STORAGE_PREFIX}${sessionID}`)).catch(() => undefined)
  }

  /** Close every ACP process owned by this plugin instance. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.allSettled(
      [...this.starting.values()].map((start) =>
        Promise.race([
          start.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]),
      ),
    )
    const states = [...this.states.values()]
    this.states.clear()
    this.starting.clear()
    this.closing.clear()
    this.agents.clear()
    await Promise.allSettled(
      states.map(async (state) => {
        state.cancelled = true
        cancelPermissions(state)
        void state.proc.closeSession(state.acpSessionId).catch(() => undefined)
        await state.proc.dispose()
      }),
    )
  }

  private async ensure(sessionID: string): Promise<SessionState> {
    const existing = this.states.get(sessionID)
    if (existing && !existing.proc.isClosed) return existing
    if (existing) this.states.delete(sessionID)
    const inFlight = this.starting.get(sessionID)
    if (inFlight) return inFlight
    this.closing.delete(sessionID)
    const start = this.start(sessionID).finally(() => this.starting.delete(sessionID))
    this.starting.set(sessionID, start)
    return start
  }

  private async start(sessionID: string): Promise<SessionState> {
    if (this.disposed) throw new Error("Antigravity ACP plugin was disposed")
    const state: SessionState = {
      sessionID,
      proc: undefined as unknown as AcpProcess,
      acpSessionId: "",
      cwd: this.options.directory,
      catalog: [],
      modes: [],
      supportsImage: false,
      mode: undefined,
      agent: this.agents.get(sessionID) ?? "build",
      cancelled: false,
      permissionCancels: new Set(),
      modeWaiters: new Set(),
    }

    const proc = new AcpProcess({
      cwd: this.options.directory,
      binaryPath: this.options.command,
      onUpdate: (_acpSessionID, update) => {
        if (update.sessionUpdate === "current_mode_update") {
          const next = (update as { currentModeId?: unknown }).currentModeId
          if (typeof next === "string") {
            state.mode = next
            for (const waiter of [...state.modeWaiters]) waiter(next)
          }
        }
        state.active?.onUpdate(update)
      },
      onPermissionRequest: (params) => this.permission(state, params),
      onExit: (_code, _signal, stderrTail) => {
        state.lastError = stderrTail
        state.cancelled = true
        cancelPermissions(state)
        state.active = undefined
      },
    })
    state.proc = proc

    try {
      await proc.initialize()
      // The forum clarification recommends explicitly authenticating the
      // selected non-consumer method so cached consumer OAuth is not reused
      // by an outer harness. For enterprise methods, fail closed if the server
      // only says "already authenticated" and we cannot verify the method.
      const authMethod = resolveAcpAuthMethod()
      if (authMethod !== "oauth-personal") {
        // Fail closed unless the user explicitly accepts the consumer
        // boundary. "Already authenticated" is not proof that this method is
        // the one in effect.
        await proc.authenticate(undefined, { strict: !this.options.allowConsumerAuth })
      }
      const stored = await this.readStored(sessionID)
      let session: any
      let acpSessionId: string
      if (stored?.acpSessionId && stored.cwd === this.options.directory) {
        try {
          session = await proc.resumeSession({
            sessionId: stored.acpSessionId,
            cwd: this.options.directory,
          })
          // ACP v1 `session/resume` does not return `sessionId`; keep the
          // stored id. Only accept a returned id if it matches.
          const returned = typeof session?.sessionId === "string" ? session.sessionId : undefined
          acpSessionId = returned ?? stored.acpSessionId
        } catch {
          session = await this.newSession(proc)
          acpSessionId = String(session.sessionId)
        }
      } else {
        session = await this.newSession(proc)
        acpSessionId = String(session.sessionId)
      }

      state.acpSessionId = acpSessionId
      state.catalog = this.mergeCatalog(buildModelCatalog(session))
      state.supportsImage = proc.promptCapabilities.image === true
      state.modes = Array.isArray(session.modes?.availableModes)
        ? session.modes.availableModes
            .map((mode: any) => (typeof mode?.id === "string" ? mode.id : undefined))
            .filter((id: string | undefined): id is string => Boolean(id))
        : []
      // Initialize from the actual session response, not from the stored
      // binding. A failed resume creates a fresh session with its own default
      // model; trusting the old cache here would skip applyModel and run the
      // wrong model while persisting the requested one.
      const configOptions = Array.isArray(session.configOptions) ? session.configOptions : []
      const currentModel = configOptions.find((option: any) => option?.id === "model")?.currentValue
      const currentEffort = configOptions.find((option: any) => option?.id === "thought_level")?.currentValue
      state.model = typeof currentModel === "string" ? currentModel : undefined
      state.effort = typeof currentEffort === "string" ? currentEffort : undefined
      // Always honour the current plugin config. A persisted `auto` must not
      // silently outlive a config change back to `default`; applyMode writes
      // the confirmed mode below.

      await this.applyMode(state, this.options.mode)
      if (this.disposed || this.closing.has(sessionID)) {
        await proc.dispose()
        throw new Error("Antigravity ACP session was closed during startup")
      }
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

  private mergeCatalog(discovered: readonly AcpDiscoveredModel[]): readonly AcpDiscoveredModel[] {
    if (discovered.length === 0) return this.fallbackCatalog
    const fallback = new Map(this.fallbackCatalog.map((model) => [model.id, model]))
    return discovered.map((model) => {
      if (model.variants.length > 0) return model
      const known = fallback.get(model.id)
      return known && known.variants.length > 0
        ? { ...model, variants: known.variants, defaultAcpModelId: known.defaultAcpModelId }
        : model
    })
  }

  private async applyModel(state: SessionState, model: string, variant?: string): Promise<void> {
    const target = resolveAcpModelTarget(state.catalog, model, variant ?? this.options.effort)
    if (!target || !target.baseModelId) {
      throw new Error(`Antigravity does not expose model "${model}". Select another model and retry.`)
    }
    // A catalog built from `availableModels` only may use effort-qualified ids.
    // Split them so the strict config-option confirmation matches the server.
    const qualified = /^(.*)-(low|medium|high|xhigh)$/.exec(target.baseModelId)
    const desiredBase = qualified ? qualified[1] : target.baseModelId
    const desiredEffort = target.thoughtLevel ?? qualified?.[2]
    if (state.model === desiredBase && state.effort === desiredEffort) return

    let modelResult: any
    try {
      // `configOptions` is the canonical ACP v1 surface. Antigravity exposes
      // model and thought level as two selectors; use the model result to
      // learn which thought levels remain valid before setting the effort.
      modelResult = await state.proc.setConfigOption(
        state.acpSessionId,
        "model",
        desiredBase,
      )
    } catch (error) {
      throw this.modelError(state, model, error)
    }

    const options = Array.isArray(modelResult?.configOptions) ? modelResult.configOptions : []
    const modelOption = options.find((option: any) => option?.id === "model")
    if (typeof modelOption?.currentValue !== "string" || modelOption.currentValue !== desiredBase) {
      throw this.modelError(
        state,
        model,
        new Error(`the server confirmed "${modelOption?.currentValue ?? "unknown"}"`),
      )
    }

    const thought = options.find((option: any) => option?.id === "thought_level")
    const levels = Array.isArray(thought?.options)
      ? thought.options.map((option: any) => String(option.value))
      : []
    let effort = desiredEffort
    if (effort) {
      if (levels.length === 0) {
        throw this.modelError(state, model, new Error(`the model has no thought-level selector`))
      }
      if (!levels.includes(effort)) {
        throw this.modelError(
          state,
          model,
          new Error(`the model does not offer thought level "${effort}"`),
        )
      }
      try {
        const effortResult = await state.proc.setConfigOption(
          state.acpSessionId,
          "thought_level",
          effort,
        )
        const confirmed = effortResult?.configOptions?.find(
          (option: any) => option?.id === "thought_level",
        )?.currentValue
        if (typeof confirmed !== "string" || confirmed !== effort) {
          throw new Error(`the server confirmed "${confirmed ?? "unknown"}"`)
        }
      } catch (error) {
        throw this.modelError(state, model, error)
      }
    } else if (typeof thought?.currentValue === "string") {
      effort = thought.currentValue
    }

    state.model = desiredBase
    state.effort = effort
    await this.writeStored(state)
  }

  private modelError(state: SessionState, model: string, error: unknown): Error {
    const reason = error instanceof Error ? error.message : String(error)
    state.lastError = reason
    return new Error(
      `Antigravity could not switch to model "${model}": ${reason}. The turn was not sent; ` +
        "pick another model or refresh the model catalog.",
    )
  }

  private async applyMode(
    state: SessionState,
    requested: string | undefined,
    force = false,
  ): Promise<void> {
    const mode = requested ?? this.options.mode
    if (!mode) return
    if (state.mode === mode && !force) return
    if (state.modes.length === 0) {
      if (mode === "default") {
        state.mode = mode
        return
      }
      throw new Error(`Antigravity does not expose session modes; cannot apply "${mode}".`)
    }
    if (!state.modes.includes(mode)) {
      throw new Error(`Antigravity does not offer mode "${mode}".`)
    }

    const waitForMode = (timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        const waiter = (next: string) => {
          if (next !== mode) return
          clearTimeout(timer)
          state.modeWaiters.delete(waiter)
          resolve(true)
        }
        const timer = setTimeout(() => {
          state.modeWaiters.delete(waiter)
          resolve(false)
        }, timeoutMs)
        timer.unref?.()
        state.modeWaiters.add(waiter)
      })

    try {
      const result = await state.proc.setConfigOption(state.acpSessionId, "mode", mode)
      const confirmed = result?.configOptions?.find((option: any) => option?.id === "mode")?.currentValue
      if (typeof confirmed === "string") {
        if (confirmed !== mode) throw new Error(`the server confirmed "${confirmed}"`)
        state.mode = mode
        return
      }
      if (await waitForMode(500)) return
      throw new Error("the server did not confirm the mode")
    } catch (error) {
      if (mode !== "default") {
        throw new Error(
          `Antigravity could not apply mode "${mode}": ${error instanceof Error ? error.message : String(error)}. ` +
            "The turn was not sent.",
        )
      }
      try {
        await state.proc.setMode(state.acpSessionId, mode)
        if (await waitForMode(500)) return
        throw new Error("the server did not confirm the mode")
      } catch (fallback) {
        throw new Error(
          `Antigravity could not confirm mode "default": ` +
            `${fallback instanceof Error ? fallback.message : String(fallback)}. The turn was not sent.`,
        )
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

    if (this.options.permission === "allow") return select(allowOption ?? denyOption)
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
          cwd: state.cwd,
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
