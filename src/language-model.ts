// LanguageModelV3 adapter for Antigravity's ACP runtime.
//
// Antigravity is a full agent: it owns its tools and its own prompt. This
// adapter sends the current user turn, then renders the ACP session updates
// as AI SDK stream parts. Antigravity-native tool calls are marked
// provider-executed so OpenCode never runs them a second time.

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider"
import type {
  AcpContentBlock,
  AcpPromptResult,
  AcpSessionUpdate,
} from "./acp/client.js"
import type { RunRequest, SessionManager } from "./session.js"

export const PROVIDER_ID = "antigravity-acp"

export const COMPACTION_SUMMARY =
  "Antigravity keeps its own ACP conversation history. This OpenCode provider sends only the " +
  "current user turn; no cross-model transcript was replayed for compaction."

export interface Dependencies {
  readonly run: (
    sessionID: string,
    request: RunRequest,
    onUpdate: (update: AcpSessionUpdate) => void,
    signal: AbortSignal,
  ) => Promise<AcpPromptResult>
}

export class AntigravityLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = PROVIDER_ID
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    private readonly dependencies: Dependencies,
  ) {}

  async doGenerate(): Promise<never> {
    throw new Error("Antigravity models only support streaming")
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const headers = options.headers ?? {}
    const sessionHeader = String(headers["x-opencode-session-id"] ?? "")
    const variant = String(headers["x-opencode-variant"] ?? "") || undefined
    const kind = String(headers["x-opencode-request-kind"] ?? "primary")

    // Auxiliary requests must not spend an ACP turn. The title/compaction
    // hooks normally set a local result; these streams are fail-safes.
    if (kind === "generate") {
      throw new Error("Antigravity provider does not support stateless generate requests")
    }
    if (kind === "title") return { stream: localStream("Antigravity session") }
    if (kind === "compaction") return { stream: localStream(COMPACTION_SUMMARY) }
    if (!sessionHeader) {
      throw new Error(
        "Antigravity provider requires an OpenCode session ID. A stateless or header-less call " +
          "cannot be mapped to an ACP session safely.",
      )
    }
    const sessionID = sessionHeader

    const request: RunRequest = {
      model: this.modelId,
      variant,
      prompt: promptToBlocks(options.prompt),
    }

    const abort = new AbortController()
    const signal = options.abortSignal
      ? AbortSignal.any([abort.signal, options.abortSignal])
      : abort.signal
    let cancelled = false
    let task: Promise<void> = Promise.resolve()

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        const renderer = new Renderer(controller, String(++streamSeq))
        controller.enqueue({ type: "stream-start", warnings: [] })
        task = this.dependencies
          .run(sessionID, request, (update) => {
            if (!cancelled) renderer.update(update)
          }, signal)
          .then(
            (result) => {
              if (cancelled) return
              renderer.finish(result)
              controller.close()
            },
            (error) => {
              if (!cancelled) controller.error(error)
            },
          )
      },
      cancel: () => {
        cancelled = true
        abort.abort()
        return task
      },
    })

    return { stream }
  }
}

let streamSeq = 0

/** One stream's block/tool state. ACP updates are incremental; the AI SDK stream is too. */
class Renderer {
  private textOpen = false
  private reasoningOpen = false
  private readonly textID: string
  private readonly reasoningID: string
  private readonly tools = new Map<
    string,
    { name: string; title?: string; input?: unknown; content?: unknown; rawOutput?: unknown }
  >()
  private readonly finished = new Set<string>()
  private contextUsage: { used: number; size: number } | undefined

  constructor(
    private readonly controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    runID: string,
  ) {
    this.textID = `text-${runID}`
    this.reasoningID = `reasoning-${runID}`
  }

  update(update: AcpSessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = contentText(update.content)
      if (!text) return
      this.closeReasoning()
      if (!this.textOpen) {
        this.controller.enqueue({ type: "text-start", id: this.textID })
        this.textOpen = true
      }
      this.controller.enqueue({ type: "text-delta", id: this.textID, delta: text })
      return
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      const text = contentText(update.content)
      if (!text) return
      this.closeText()
      if (!this.reasoningOpen) {
        this.controller.enqueue({ type: "reasoning-start", id: this.reasoningID })
        this.reasoningOpen = true
      }
      this.controller.enqueue({ type: "reasoning-delta", id: this.reasoningID, delta: text })
      return
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.closeText()
      this.closeReasoning()
      const call = toolCall(update)
      if (!call.toolCallId) return

      let tool = this.tools.get(call.toolCallId)
      if (!tool) {
        tool = {
          name: call.name ?? call.title ?? "unknown",
          title: call.title,
          input: call.rawInput,
          content: call.content,
          rawOutput: call.rawOutput,
        }
        this.tools.set(call.toolCallId, tool)
        const input = JSON.stringify(tool.input ?? {})
        this.controller.enqueue({
          type: "tool-input-start",
          id: call.toolCallId,
          toolName: tool.name,
          providerExecuted: true,
        })
        this.controller.enqueue({ type: "tool-input-delta", id: call.toolCallId, delta: input })
        this.controller.enqueue({ type: "tool-input-end", id: call.toolCallId })
        this.controller.enqueue({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: tool.name,
          input,
          providerExecuted: true,
        })
      } else {
        if (call.name) tool.name = call.name
        if (call.title) tool.title = call.title
        if (call.rawInput !== undefined) tool.input = call.rawInput
        if (call.content !== undefined) tool.content = call.content
        if (call.rawOutput !== undefined) tool.rawOutput = call.rawOutput
      }

      if ((call.status === "completed" || call.status === "failed") && !this.finished.has(call.toolCallId)) {
        this.finished.add(call.toolCallId)
        this.controller.enqueue({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: tool.name,
          result: {
            status: call.status,
            title: tool.title,
            input: asJson(tool.input),
            content: tool.content === undefined ? undefined : JSON.stringify(tool.content),
            rawOutput: asJson(tool.rawOutput),
          },
          isError: call.status === "failed",
        })
      }
      return
    }

    if (update.sessionUpdate === "usage_update") {
      const used = Number(update.used)
      const size = Number(update.size)
      // A zero-valued setup update is not context occupancy; ignore it so it
      // cannot overwrite a real value.
      if (Number.isFinite(used) && Number.isFinite(size) && used > 0 && size > 0) {
        this.contextUsage = { used, size }
      }
    }
  }

  finish(result: AcpPromptResult): void {
    this.closeText()
    this.closeReasoning()
    for (const [id, tool] of this.tools) {
      if (this.finished.has(id)) continue
      this.finished.add(id)
      this.controller.enqueue({
        type: "tool-result",
        toolCallId: id,
        toolName: tool.name,
        result: {
          status: result.stopReason === "cancelled" ? "cancelled" : "incomplete",
          title: tool.title,
          input: asJson(tool.input),
          content: tool.content === undefined ? undefined : JSON.stringify(tool.content),
          rawOutput: asJson(tool.rawOutput),
        },
        isError: true,
      })
    }
    this.controller.enqueue({
      type: "finish",
      finishReason: finishReason(result.stopReason ?? "unknown"),
      usage: toUsage(result.usage, this.contextUsage),
    })
  }

  private closeText(): void {
    if (!this.textOpen) return
    this.controller.enqueue({ type: "text-end", id: this.textID })
    this.textOpen = false
  }

  private closeReasoning(): void {
    if (!this.reasoningOpen) return
    this.controller.enqueue({ type: "reasoning-end", id: this.reasoningID })
    this.reasoningOpen = false
  }
}

/** Extract the current user turn. Antigravity owns conversation history in its ACP session. */
export function promptToBlocks(prompt: LanguageModelV3Prompt): AcpContentBlock[] {
  let lastUser = -1
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index].role === "user") {
      lastUser = index
      break
    }
  }
  if (lastUser < 0) return [{ type: "text", text: "[continue]" }]

  const message = prompt[lastUser]
  if (message.role !== "user") return [{ type: "text", text: "[continue]" }]
  const blocks: AcpContentBlock[] = []
  for (const part of message.content) {
    if (part.type === "text" && part.text.length > 0) {
      blocks.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "file") {
      if (!part.mediaType.startsWith("image/")) {
        blocks.push({
          type: "text",
          text: `[file omitted: ${part.filename ?? part.mediaType} is not an inline image]`,
        })
        continue
      }
      const data = imageData(part.data)
      if (data) {
        blocks.push({ type: "image", data, mimeType: part.mediaType })
      } else {
        blocks.push({
          type: "text",
          text: "[image omitted: only inline base64/Uint8Array images are supported]",
        })
      }
    }
  }
  if (blocks.length === 0) return [{ type: "text", text: "[continue]" }]
  if (blocks.some((block) => block.type === "image") && !blocks.some((block) => block.type === "text")) {
    blocks.unshift({ type: "text", text: "See the attached image." })
  }
  return blocks
}

function contentText(content: unknown): string | undefined {
  if (Array.isArray(content)) {
    return content
      .map((part) => contentText(part))
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("")
  }
  if (
    content &&
    typeof content === "object" &&
    (content as { type?: unknown }).type === "text" &&
    typeof (content as { text?: unknown }).text === "string"
  ) {
    return (content as { text: string }).text
  }
  return undefined
}

const asJson = (value: unknown): string | undefined =>
  value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value)

function toolCall(update: AcpSessionUpdate) {
  return {
    toolCallId: String(update.toolCallId ?? ""),
    // `name` is the stable tool name. `title` is only display text; a
    // name-less update must not rename the tool to its title.
    name: typeof update.name === "string" && update.name.length > 0 ? update.name : undefined,
    status: String(update.status ?? "pending"),
    title: typeof update.title === "string" ? update.title : undefined,
    rawInput: update.rawInput ?? update.args,
    rawOutput: update.rawOutput,
    content: update.content,
  }
}

function imageData(data: unknown): string | undefined {
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64")
  if (typeof data !== "string") return undefined
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",")
    return comma >= 0 ? data.slice(comma + 1) : undefined
  }
  if (/^https?:\/\//i.test(data)) return undefined
  return data
}

function finishReason(raw: string): LanguageModelV3FinishReason {
  if (raw === "end_turn") return { unified: "stop", raw }
  if (raw === "max_tokens") return { unified: "length", raw }
  if (raw === "refusal") return { unified: "content-filter", raw }
  return { unified: "other", raw }
}

function toUsage(
  reported: AcpPromptResult["usage"] | undefined,
  context: { used: number; size: number } | undefined,
): LanguageModelV3Usage {
  // Antigravity 1.5.x reports `inputTokens` as net input (cache reads/writes
  // are separate) and `outputTokens` as inclusive of thoughts. Do not derive
  // input from `totalTokens`; the total's cumulative/per-turn meaning is
  // ambiguous across ACP versions. Fall back to context occupancy only for
  // the total, never for per-turn non-cached input.
  const netInput = reported?.inputTokens
  const output = reported?.outputTokens
  const cacheRead = reported?.cachedReadTokens
  const cacheWrite = reported?.cachedWriteTokens
  const reasoning = reported?.thoughtTokens
  const totalInput =
    netInput !== undefined
      ? netInput + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : context?.used
  const noCache = netInput
  const text = output !== undefined ? Math.max(0, output - (reasoning ?? 0)) : undefined
  return {
    inputTokens: { total: totalInput, noCache, cacheRead, cacheWrite },
    outputTokens: { total: output, text, reasoning },
  }
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function localStream(text: string): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      controller.enqueue({ type: "text-start", id: "text" })
      controller.enqueue({ type: "text-delta", id: "text", delta: text })
      controller.enqueue({ type: "text-end", id: "text" })
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "local" },
        usage: emptyUsage(),
      })
      controller.close()
    },
  })
}

export function makeLanguageModel(manager: SessionManager, modelID: string) {
  return new AntigravityLanguageModel(modelID, {
    run: (sessionID, request, onUpdate, signal) => manager.run(sessionID, request, onUpdate, signal),
  })
}
