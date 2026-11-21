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

  async doGenerate(options: LanguageModelV3CallOptions) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    const content: Array<{ type: "text" | "reasoning"; text: string }> = []
    let text = ""
    let reasoning = ""
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
    let usage = emptyUsage()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === "text-delta") text += value.delta
      else if (value.type === "reasoning-delta") reasoning += value.delta
      else if (value.type === "finish") {
        finishReason = value.finishReason
        usage = value.usage
      } else if (value.type === "error") {
        throw value.error
      }
    }

    if (reasoning) content.push({ type: "reasoning", text: reasoning })
    if (text) content.push({ type: "text", text })
    return { content, finishReason, usage, warnings: [] }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const headers = options.headers ?? {}
    const sessionID = String(headers["x-opencode-session-id"] ?? "__default__")
    const variant = String(headers["x-opencode-variant"] ?? "") || undefined
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
        const renderer = new Renderer(controller)
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

/** One stream's block/tool state. ACP updates are incremental; the AI SDK stream is too. */
class Renderer {
  private textOpen = false
  private reasoningOpen = false
  private readonly tools = new Map<string, { name: string }>()
  private readonly finished = new Set<string>()
  private contextUsage: { used: number; size: number } | undefined

  constructor(private readonly controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {}

  update(update: AcpSessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = contentText(update.content)
      if (!text) return
      this.closeReasoning()
      if (!this.textOpen) {
        this.controller.enqueue({ type: "text-start", id: "text" })
        this.textOpen = true
      }
      this.controller.enqueue({ type: "text-delta", id: "text", delta: text })
      return
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      const text = contentText(update.content)
      if (!text) return
      this.closeText()
      if (!this.reasoningOpen) {
        this.controller.enqueue({ type: "reasoning-start", id: "reasoning" })
        this.reasoningOpen = true
      }
      this.controller.enqueue({ type: "reasoning-delta", id: "reasoning", delta: text })
      return
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.closeText()
      this.closeReasoning()
      const call = toolCall(update)
      if (!call.toolCallId) return

      if (!this.tools.has(call.toolCallId)) {
        this.tools.set(call.toolCallId, { name: call.toolName })
        const input = JSON.stringify(call.rawInput ?? {})
        this.controller.enqueue({
          type: "tool-input-start",
          id: call.toolCallId,
          toolName: call.toolName,
          providerExecuted: true,
        })
        this.controller.enqueue({ type: "tool-input-delta", id: call.toolCallId, delta: input })
        this.controller.enqueue({ type: "tool-input-end", id: call.toolCallId })
        this.controller.enqueue({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input,
          providerExecuted: true,
        })
      }

      if ((call.status === "completed" || call.status === "failed") && !this.finished.has(call.toolCallId)) {
        this.finished.add(call.toolCallId)
        this.controller.enqueue({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: this.tools.get(call.toolCallId)?.name ?? call.toolName,
          result: {
            status: call.status,
            title: call.title,
            content: call.content === undefined ? undefined : JSON.stringify(call.content),
          },
          isError: call.status === "failed",
        })
      }
      return
    }

    if (update.sessionUpdate === "usage_update") {
      const used = Number(update.used)
      const size = Number(update.size)
      if (Number.isFinite(used) && Number.isFinite(size)) this.contextUsage = { used, size }
    }
  }

  finish(result: AcpPromptResult): void {
    this.closeText()
    this.closeReasoning()
    this.controller.enqueue({
      type: "finish",
      finishReason: finishReason(result.stopReason ?? "unknown"),
      usage: toUsage(result.usage, this.contextUsage),
    })
  }

  private closeText(): void {
    if (!this.textOpen) return
    this.controller.enqueue({ type: "text-end", id: "text" })
    this.textOpen = false
  }

  private closeReasoning(): void {
    if (!this.reasoningOpen) return
    this.controller.enqueue({ type: "reasoning-end", id: "reasoning" })
    this.reasoningOpen = false
  }
}

/** Extract the current user turn. Antigravity owns conversation history in its ACP session. */
export function promptToBlocks(prompt: LanguageModelV3Prompt): AcpContentBlock[] {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index]
    if (message.role !== "user") continue
    const blocks: AcpContentBlock[] = []
    for (const part of message.content) {
      if (part.type === "text" && part.text.length > 0) {
        blocks.push({ type: "text", text: part.text })
        continue
      }
      if (part.type === "file" && part.mediaType.startsWith("image/")) {
        const data = imageData(part.data)
        if (data) blocks.push({ type: "image", data, mimeType: part.mediaType })
      }
    }
    if (blocks.length > 0) return blocks
  }
  return [{ type: "text", text: "[continue]" }]
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

function toolCall(update: AcpSessionUpdate) {
  return {
    toolCallId: String(update.toolCallId ?? ""),
    toolName: String(update.name ?? update.title ?? "unknown"),
    status: String(update.status ?? "pending"),
    title: typeof update.title === "string" ? update.title : undefined,
    rawInput: update.rawInput ?? update.args,
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
  // are separate) and `outputTokens` as inclusive of thoughts. Use
  // `totalTokens` when it is present to avoid double-counting cache.
  const netInput = reported?.inputTokens
  const output = reported?.outputTokens
  const cacheRead = reported?.cachedReadTokens
  const cacheWrite = reported?.cachedWriteTokens
  const reasoning = reported?.thoughtTokens
  const total = reported?.totalTokens
  const totalInput =
    total !== undefined && output !== undefined
      ? Math.max(0, total - output)
      : netInput !== undefined
        ? netInput + (cacheRead ?? 0) + (cacheWrite ?? 0)
        : context?.used
  const noCache = netInput ?? context?.used
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

export function makeLanguageModel(manager: SessionManager, modelID: string) {
  return new AntigravityLanguageModel(modelID, {
    run: (sessionID, request, onUpdate, signal) => manager.run(sessionID, request, onUpdate, signal),
  })
}
