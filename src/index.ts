// Standalone OpenCode V2 provider plugin for Google Antigravity.
//
// This plugin does not modify OpenCode. It registers a provider in the
// plugin API, spawns the user's own `agy acp` binary, and speaks ACP over
// stdio. Antigravity runs its own tools and owns its own prompt; OpenCode
// only displays the stream.

import { Model, Plugin, Provider } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { AntigravityLanguageModel } from "./language-model.js"
import { SessionManager, type AcpMode, type PermissionMode } from "./session.js"
import { discoverAcpModels, FALLBACK_MODELS, resolveAcpAuthMethod, type AcpDiscoveredModel } from "./acp/client.js"

export const PROVIDER_ID = Provider.ID.make("antigravity-acp")
export const PACKAGE = "aisdk:antigravity-acp"
export const PLUGIN_ID = "antigravity-acp"

const CATALOG_KEY = "catalog"
const CONTEXT_LIMIT = 1_048_576
const OUTPUT_LIMIT = 65_536

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
    allowConsumerAuth: raw.allowConsumerAuth === true,
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
    value.every(
      (model) =>
        model &&
        typeof model === "object" &&
        typeof (model as AcpDiscoveredModel).id === "string" &&
        typeof (model as AcpDiscoveredModel).name === "string" &&
        typeof (model as AcpDiscoveredModel).defaultAcpModelId === "string" &&
        Array.isArray((model as AcpDiscoveredModel).variants),
    )
  )
}

const register = Effect.fn("AntigravityACP.register")(function* (
  ctx: Context,
  catalog: readonly AcpDiscoveredModel[],
) {
  yield* ctx.provider.transform((editor) => {
    if (editor.get(PROVIDER_ID)) editor.remove(PROVIDER_ID)
    editor.add({
      info: {
        ...Provider.Info.empty(PROVIDER_ID),
        name: "Antigravity (ACP)",
        activation: "enabled",
        package: PACKAGE,
      },
      models: toModels(catalog),
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

export default Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = normalizeOptions(ctx)
      const manager = new SessionManager(ctx, options)

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

      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()))

      // Register the last known catalog first so the picker has models before
      // `agy` answers. On a cold start, use a small fallback catalog and let
      // the background refresh replace it; blocking plugin activation on
      // `agy acp` can exceed OpenCode's activation deadline.
      const cachedModels = yield* cached(ctx)
      yield* register(ctx, cachedModels.length > 0 ? cachedModels : FALLBACK_MODELS)

      yield* ctx.aisdk.hook(
        "sdk",
        (event) =>
          Effect.sync(() => {
            // OpenCode strips the `aisdk:` prefix before invoking the hook.
            if (event.package !== "antigravity-acp") return
            event.sdk = {
              languageModel: (modelID: string) => new AntigravityLanguageModel(modelID, {
                run: (sessionID, request, onUpdate, signal) =>
                  manager.run(sessionID, request, onUpdate, signal),
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
                manager.run(sessionID, request, onUpdate, signal),
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
            if (text) input.result = text.length > 60 ? `${text.slice(0, 57)}...` : text
          }),
        { providerID: PROVIDER_ID },
      )

      // Auth/quota/permission failures are not transient; retrying them burns
      // quota or repeats the same denial.
      yield* ctx.session.hook(
        "retry",
        (input) =>
          Effect.sync(() => {
            if (String(input.model.providerID) !== String(PROVIDER_ID)) return
            if (
              /consumer login|oauth-personal|Authentication required|Antigravity consumer login is disabled|RESOURCE_EXHAUSTED|quota|rate limit|\(code 429\)|\(code 403\)|PERMISSION_DENIED/i.test(
                input.error.message,
              )
            ) {
              input.decision = { retry: false }
            }
          }),
        { providerID: PROVIDER_ID },
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
        ctx.event
          .subscribe({
            types: ["session.execution.interrupted", "session.execution.failed", "session.deleted"],
          })
          .pipe(
            Stream.runForEach((event) => {
              const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
              if (typeof sessionID !== "string" || sessionID.length === 0) return Effect.void
              if (event.type === "session.deleted") {
                return Effect.promise(() => manager.close(sessionID))
              }
              return Effect.promise(() => manager.cancel(sessionID))
            }),
            Effect.catch(() => Effect.void),
          ),
      )
    }),
})
