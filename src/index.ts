// Standalone OpenCode V2 provider plugin for Google Antigravity.
//
// This plugin does not modify OpenCode. It registers a provider in the
// plugin API, spawns the user's own `agy acp` binary, and speaks ACP over
// stdio. Antigravity runs its own tools and owns its own prompt; OpenCode
// only displays the stream.

import { Model, Plugin, Provider } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { AntigravityLanguageModel, COMPACTION_SUMMARY } from "./language-model.js"
import { SessionManager, type AcpMode, type PermissionMode } from "./session.js"
import { discoverAcpModels, FALLBACK_MODELS, resolveAcpAuthMethod, type AcpDiscoveredModel } from "./acp/client.js"

export const PROVIDER_ID = Provider.ID.make("antigravity-acp")
export const PACKAGE = "aisdk:antigravity-acp"
export const PLUGIN_ID = "antigravity-acp"

const CATALOG_KEY = "catalog"
const CONTEXT_LIMIT = 1_048_576
const OUTPUT_LIMIT = 65_536

/** Stable per-location pointer so cached AISDK models follow a plugin reload. */
interface ManagerRef {
  current?: SessionManager
}
// `globalThis` keeps the registry alive across plugin module re-evaluation.
// Without this, a cached AISDK language model from the old module instance
// would look at the old module's Map and could never see the new manager.
const MANAGER_REFS = Symbol.for("opencode.antigravity.managerRefs")
const managerRefs: Map<string, ManagerRef> =
  ((globalThis as Record<symbol, unknown>)[MANAGER_REFS] as Map<string, ManagerRef> | undefined) ??
  (() => {
    const map = new Map<string, ManagerRef>()
    ;(globalThis as Record<symbol, unknown>)[MANAGER_REFS] = map
    return map
  })()

interface Options {
  readonly directory: string
  readonly command?: string
  readonly permission: PermissionMode
  readonly mode: AcpMode
  readonly effort?: string
  readonly allowConsumerAuth: boolean
}

const knownPermissions = new Set<PermissionMode>(["ask", "allow", "deny"])
const knownModes = new Set<AcpMode>(["default", "accept-edits", "auto", "plan"])

function normalizeOptions(ctx: Context): Options {
  const raw = ctx.options ?? {}
  const permission = typeof raw.permission === "string" && knownPermissions.has(raw.permission as PermissionMode)
    ? (raw.permission as PermissionMode)
    : "ask"
  const mode = typeof raw.mode === "string" && knownModes.has(raw.mode as AcpMode)
    ? (raw.mode as AcpMode)
    : "default"
  return {
    directory: ctx.location.directory,
    command: typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : undefined,
    permission,
    mode,
    effort: typeof raw.effort === "string" && raw.effort.trim() ? raw.effort.trim() : undefined,
    allowConsumerAuth:
      raw.allowConsumerAuth === true || process.env.ANTIGRAVITY_ACP_ALLOW_CONSUMER === "1",
  }
}

function toModels(catalog: readonly AcpDiscoveredModel[]): Model.Info[] {
  return catalog.map((model) => {
    const id = Model.ID.make(model.id)
    const base = Model.Info.default(PROVIDER_ID, id)
    return {
      ...base,
      name: model.name,
      family: Model.Family.make(model.family || model.id),
      package: PACKAGE,
      capabilities: {
        ...base.capabilities,
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      variants: model.variants.map((variant) => ({
        id: Model.VariantID.make(variant.id),
        settings: { effort: variant.id, slug: variant.acpModelId },
      })),
      limit: { context: CONTEXT_LIMIT, output: OUTPUT_LIMIT },
    }
  })
}

function isCatalog(value: unknown): value is readonly AcpDiscoveredModel[] {
  return (
    Array.isArray(value) &&
    value.every((raw) => {
      if (!raw || typeof raw !== "object") return false
      const model = raw as AcpDiscoveredModel
      return (
        typeof model.id === "string" &&
        typeof model.name === "string" &&
        (model.family === undefined || typeof model.family === "string") &&
        typeof model.defaultAcpModelId === "string" &&
        Array.isArray(model.variants) &&
        model.variants.every(
          (variant) =>
            variant &&
            typeof variant === "object" &&
            typeof variant.id === "string" &&
            typeof variant.acpModelId === "string" &&
            (variant.thoughtLevel === undefined || typeof variant.thoughtLevel === "string"),
        )
      )
    })
  )
}

const register = Effect.fn("AntigravityACP.register")(function* (
  ctx: Context,
  catalog: readonly AcpDiscoveredModel[],
) {
  const models = toModels(catalog)
  yield* ctx.provider.transform((editor) => {
    const existing = editor.get(PROVIDER_ID)
    if (existing) {
      editor.update(PROVIDER_ID, (provider) => {
        provider.name = "Antigravity (ACP)"
        provider.activation = "enabled"
        provider.package = PACKAGE
      })
      // Preserve user/other-plugin models, but replace our own stale ones.
      const next = new Map(existing.models)
      for (const [id, model] of next) {
        if (model.package === PACKAGE) next.delete(id)
      }
      for (const model of models) next.set(String(model.id), model)
      editor.models.set(PROVIDER_ID, [...next.values()])
      return
    }
    editor.add({
      info: {
        ...Provider.Info.empty(PROVIDER_ID),
        name: "Antigravity (ACP)",
        activation: "enabled",
        package: PACKAGE,
      },
      models,
    })
  })
})

const cached = Effect.fn("AntigravityACP.cached")(function* (ctx: Context) {
  const value = yield* ctx.storage.get(CATALOG_KEY)
  return isCatalog(value) ? value : []
})

const discover = (options: Options) =>
  Effect.tryPromise({
    try: () => discoverAcpModels(options.directory, { binaryPath: options.command }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const remember = Effect.fn("AntigravityACP.remember")(function* (
  ctx: Context,
  catalog: readonly AcpDiscoveredModel[],
) {
  yield* ctx.storage.set(CATALOG_KEY, catalog as any)
})

const titleFromMessages = (messages: ReadonlyArray<unknown>): string | undefined => {
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue
    const message = raw as { role?: unknown; content?: unknown }
    if (message.role !== "user") continue
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim()
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter(
        (part): part is { type: string; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join(" ")
      .trim()
    if (text) return text
  }
  return undefined
}

/**
 * OpenCode's default agent policy is `{ action: "*", resource: "*", effect: "allow" }`.
 * A custom `antigravity.*` action would therefore be allowed silently in a
 * headless `opencode run`. In `permission: "ask"` mode, force a prompt unless
 * the user added a specific rule for `antigravity.*`; the Agent/Session rules
 * are inspected here because the permission hook only receives the computed
 * effect, not the ruleset.
 */
const wildcard = (pattern: string, value: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(value)
}

const ruleMatches = (
  rule: { action: string; resource: string },
  action: string,
  resources: ReadonlyArray<string>,
): boolean =>
  wildcard(rule.action, action) && resources.every((resource) => wildcard(rule.resource, resource))

export default Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      // The CLI/ACP server runs locally; skip remote workspaces where we
      // cannot spawn a local process.
      if (ctx.location.workspaceID !== undefined) return

      const options = normalizeOptions(ctx)
      const manager = new SessionManager(ctx, options)
      const ref = managerRefs.get(options.directory) ?? {}
      managerRefs.set(options.directory, ref)
      ref.current = manager
      const currentManager = () => {
        const current = ref.current
        if (!current) throw new Error("Antigravity ACP plugin is reloading; send a new message")
        return current
      }

      const consumerAuth = resolveAcpAuthMethod() === "oauth-personal"
      if (consumerAuth && !options.allowConsumerAuth) {
        yield* Effect.logWarning(
          "Antigravity consumer login (oauth-personal) needs explicit acknowledgement. " +
            "Google's Antigravity forum reply permits unmodified `agy acp` only in a thin client where " +
            "Antigravity owns the agent: no injected system instructions, serialized tool definitions, " +
            "replayed cross-model context, or automated loops. This plugin is strict-thin: it clears " +
            "OpenCode's system/tools, sends only the current user turn, and has no MCP relay or cross-model " +
            'handoff. Set plugin option "allowConsumerAuth": true to acknowledge that boundary. For a clearly ' +
            "compliant outer-harness path, use GEMINI_API_KEY, oauth-business, or agent-platform. " +
            "Model discovery is skipped until this is enabled.",
        )
      } else if (consumerAuth) {
        yield* Effect.logWarning(
          "Antigravity ACP is using consumer oauth-personal because \"allowConsumerAuth\": true is set. " +
            "Keep this plugin strict-thin: no injected system prompt/tool schemas, no cross-model replay, " +
            "no MCP relay/Code Mode, and no automated loops. If you add any of those, switch to " +
            "GEMINI_API_KEY, oauth-business, or agent-platform. See the forum clarification linked in README.",
        )
      }

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (ref.current === manager) ref.current = undefined
          await manager.dispose()
        }),
      )

      // Register the last known catalog first so the picker has models before
      // `agy` answers. On a cold start, use a small fallback catalog and let
      // the background refresh replace it; blocking plugin activation on
      // `agy acp` can exceed OpenCode's activation deadline.
      const cachedModels = yield* cached(ctx)
      const initialCatalog = cachedModels.length > 0 ? cachedModels : FALLBACK_MODELS
      manager.setCatalog(initialCatalog)
      yield* register(ctx, initialCatalog)

      yield* ctx.aisdk.hook(
        "sdk",
        (event) =>
          Effect.sync(() => {
            // OpenCode strips the `aisdk:` prefix before invoking the hook.
            if (event.package !== "antigravity-acp") return
            event.sdk = {
              languageModel: (modelID: string) => new AntigravityLanguageModel(modelID, {
                run: (sessionID, request, onUpdate, signal) =>
                  currentManager().run(sessionID, request, onUpdate, signal),
              }),
            }
          }),
        { providerID: PROVIDER_ID },
      )

      yield* ctx.aisdk.hook(
        "language",
        (event) =>
          Effect.sync(() => {
            if (String(event.model.providerID) !== String(PROVIDER_ID)) return
            const modelID = String(event.model.modelID ?? event.model.id)
            event.language = new AntigravityLanguageModel(modelID, {
              run: (sessionID, request, onUpdate, signal) =>
                currentManager().run(sessionID, request, onUpdate, signal),
            })
          }),
        { providerID: PROVIDER_ID },
      )

      // Antigravity is a full agent. Do not forward OpenCode's system prompt
      // or tool schemas: they describe tools Antigravity does not have.
      yield* ctx.session.hook(
        "context",
        (input) =>
          Effect.sync(() => {
            if (String(input.model.providerID) !== String(PROVIDER_ID)) return
            input.system = []
            input.tools = {}
          }),
        { providerID: PROVIDER_ID },
      )

      yield* ctx.session.hook(
        "model.request",
        (input) =>
          Effect.sync(() => {
            if (String(input.model.providerID) !== String(PROVIDER_ID)) return
            input.headers["x-opencode-session-id"] = String(input.sessionID)
            input.headers["x-opencode-variant"] = input.model.variant ? String(input.model.variant) : ""
            input.headers["x-opencode-request-kind"] = input.kind
            manager.setAgent(String(input.sessionID), String(input.agent))
          }),
        { providerID: PROVIDER_ID },
      )

      // ACP turns are expensive. Derive a title from the first user message
      // instead of asking Antigravity to generate one.
      yield* ctx.session.hook(
        "title",
        (input) =>
          Effect.sync(() => {
            if (String(input.model.providerID) !== String(PROVIDER_ID)) return
            if (input.result) return
            const text = titleFromMessages(input.messages)
            input.result = text
              ? text.length > 60
                ? `${text.slice(0, 57)}...`
                : text
              : "Antigravity session"
          }),
        { providerID: PROVIDER_ID },
      )

      // Antigravity owns its own ACP conversation history. OpenCode compaction
      // is local; do not spend an ACP turn on it or store Antigravity's reply
      // as a "summary". The next primary turn still sends only the current
      // user message to the existing ACP session.
      yield* ctx.session.hook(
        "compaction",
        (input) =>
          Effect.sync(() => {
            if (String(input.model.providerID) !== String(PROVIDER_ID)) return
            if (input.result) return
            input.result = {
              summary: COMPACTION_SUMMARY,
            }
          }),
        { providerID: PROVIDER_ID },
      )

      // ACP turns are expensive and may have side effects (tool calls). Never
      // let OpenCode auto-retry our provider; the user can resend manually.
      yield* ctx.session.hook(
        "retry",
        (input) =>
          Effect.sync(() => {
            if (String(input.model.providerID) !== String(PROVIDER_ID)) return
            input.decision = { retry: false }
          }),
        { providerID: PROVIDER_ID },
      )

      // OpenCode's default agent policy allows `*` actions. A custom
      // `antigravity.*` action would therefore be allowed silently, especially
      // in headless `opencode run`. In ask mode, force a prompt unless the user
      // configured a specific `antigravity.*` rule.
      yield* ctx.permission.hook(
        "evaluate",
        (input) =>
          Effect.gen(function* () {
            if (options.permission !== "ask") return
            const action = String(input.action)
            if (!action.startsWith("antigravity.")) return
            if (input.effect !== "allow") return

            const agent = input.agent
              ? yield* ctx.agent
                  .get({ agentID: input.agent })
                  .pipe(Effect.catch(() => Effect.succeed(undefined)))
              : undefined
            const session = yield* ctx.session
              .get({ sessionID: input.sessionID })
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            const rules = [
              ...(agent?.data.permissions ?? []),
              ...(session?.permissions ?? []),
            ]
            const matching = rules.filter((rule) => ruleMatches(rule, action, input.resources))
            const last = matching[matching.length - 1]
            if (last && !(last.action === "*" && last.resource === "*")) return
            input.effect = "ask"
          }),
      )

      if (!consumerAuth || options.allowConsumerAuth) {
        yield* Effect.forkScoped(
          discover(options).pipe(
            Effect.flatMap((catalog) =>
              Effect.gen(function* () {
                if (catalog.length === 0) {
                  yield* Effect.logWarning("Antigravity returned no models for this account")
                  return
                }
                yield* remember(ctx, catalog)
                manager.setCatalog(catalog)
                yield* register(ctx, catalog)
                yield* ctx.provider.reload()
              }),
            ),
            Effect.catch((cause) =>
              Effect.logWarning(`Antigravity model discovery failed: ${cause.message}`),
            ),
          ),
        )
      }

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* ctx.event
              .subscribe({
                // Cancellation/interruption already reaches the model through
                // its AbortSignal. Listening to execution.failed/interrupted
                // here can cancel a newer turn from a late event, so only
                // session deletion is handled.
                types: ["session.deleted"],
              })
              .pipe(
                Stream.runForEach((event) => {
                  const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
                  if (typeof sessionID !== "string" || sessionID.length === 0) return Effect.void
                  return Effect.promise(() => manager.close(sessionID))
                }),
                Effect.catch((cause) =>
                  Effect.logWarning(`Antigravity event subscription ended: ${cause}`),
                ),
              )
            yield* Effect.sleep("1 second")
          }
        }),
      )
    }),
})
