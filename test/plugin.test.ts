import { describe, expect, test } from "bun:test"
import {
  buildModelCatalog,
  resolveAcpModelTarget,
  type AcpDiscoveredModel,
} from "../src/acp/client.js"
import { AntigravityLanguageModel, promptToBlocks } from "../src/language-model.js"
import type { AcpPromptResult, AcpSessionUpdate } from "../src/acp/client.js"

const session = {
  sessionId: "session-1",
  models: {
    currentModelId: "gemini-4-neon-high",
    availableModels: [
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
      { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  },
  modes: {
    currentModeId: "default",
    availableModes: [{ id: "default" }, { id: "plan" }],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-4-neon",
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra" },
      ],
    },
  ],
}

function collect(stream: ReadableStream<any>) {
  return (async () => {
    const reader = stream.getReader()
    const parts: any[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) return parts
      parts.push(value)
    }
  })()
}

describe("catalog", () => {
  test("groups base models and their effort variants", () => {
    const catalog = buildModelCatalog(session)
    const neon = catalog.find((model) => model.id === "gemini-4-neon")
    expect(neon?.variants.map((variant) => variant.id)).toEqual(["low", "medium", "high", "xhigh"])
    expect(neon?.defaultAcpModelId).toBe("gemini-4-neon-high")

    const flash = catalog.find((model) => model.id === "gemini-3.8-flash")
    expect(flash?.variants.map((variant) => variant.id)).toEqual(["low", "medium", "high"])

    const gpt = catalog.find((model) => model.id === "gpt-oss-120b-medium")
    expect(gpt?.variants).toEqual([])
    expect(gpt?.defaultAcpModelId).toBe("gpt-oss-120b-medium")
  })

  test("returns an empty catalog when the session has no model information", () => {
    expect(buildModelCatalog({})).toEqual([])
  })

  test("resolves the effort-qualified model id for session/set_model", () => {
    const catalog = buildModelCatalog(session)
    expect(resolveAcpModelTarget(catalog, "gemini-3.8-flash", "low")).toMatchObject({
      baseModelId: "gemini-3.8-flash",
      acpModelId: "gemini-3.8-flash-low",
      thoughtLevel: "low",
    })
    expect(resolveAcpModelTarget(catalog, "gemini-4-neon", "xhigh")).toMatchObject({
      acpModelId: "gemini-4-neon-xhigh",
      thoughtLevel: "xhigh",
    })
    expect(resolveAcpModelTarget(catalog, "gpt-oss-120b-medium")).toMatchObject({
      acpModelId: "gpt-oss-120b-medium",
      thoughtLevel: undefined,
    })
  })

  test("falls back to the model default when a variant is unknown", () => {
    const catalog = buildModelCatalog(session)
    expect(resolveAcpModelTarget(catalog, "gemini-3.8-flash", "max")?.acpModelId).toBe(
      "gemini-3.8-flash-high",
    )
  })
})

describe("prompt", () => {
  test("takes the latest user turn and its image", () => {
    const blocks = promptToBlocks([
      { role: "system", content: "ignored" },
      { role: "user", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            data: Uint8Array.from([1, 2, 3]),
          },
        ],
      },
    ])
    expect(blocks).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "AQID", mimeType: "image/png" },
    ])
  })

  test("does not re-send an earlier prompt when the latest turn has no supported content", () => {
    const blocks = promptToBlocks([
      { role: "user", content: [{ type: "text", text: "delete the old logs" }] },
      { role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "x" }] },
    ])
    expect(blocks).toEqual([
      { type: "text", text: "[file omitted: application/pdf is not an inline image]" },
    ])
  })

  test("uses a continuation marker when the user turn has no content", () => {
    expect(promptToBlocks([{ role: "user", content: [] }])).toEqual([
      { type: "text", text: "[continue]" },
    ])
  })
})

describe("stream mapping", () => {
  test("does not spend an ACP turn on title/compaction and rejects stateless generate", async () => {
    let calls = 0
    const model = new AntigravityLanguageModel("gemini-3.8-flash", {
      run: async () => {
        calls += 1
        return { stopReason: "end_turn" }
      },
    })

    const title = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      headers: { "x-opencode-session-id": "s-1", "x-opencode-request-kind": "title" },
    } as any)
    const titleParts = await collect(title.stream)
    expect(titleParts.some((part) => part.type === "text-delta" && part.delta === "Antigravity session")).toBe(true)

    const compaction = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      headers: { "x-opencode-session-id": "s-1", "x-opencode-request-kind": "compaction" },
    } as any)
    const compactionParts = await collect(compaction.stream)
    expect(compactionParts.some((part) => part.type === "text-delta")).toBe(true)

    await expect(
      model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        headers: { "x-opencode-session-id": "s-1", "x-opencode-request-kind": "generate" },
      } as any),
    ).rejects.toThrow("does not support stateless generate")
    expect(calls).toBe(0)
  })

  test("rejects header-less calls instead of merging them into __default__", async () => {
    let calls = 0
    const model = new AntigravityLanguageModel("gemini-3.8-flash", {
      run: async () => {
        calls += 1
        return { stopReason: "end_turn" }
      },
    })
    await expect(
      model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        headers: {},
      } as any),
    ).rejects.toThrow("requires an OpenCode session ID")
    expect(calls).toBe(0)
  })

  test("preserves late tool rawInput and rawOutput", async () => {
    const run = async (
      _sessionID: string,
      _request: unknown,
      onUpdate: (update: AcpSessionUpdate) => void,
    ): Promise<AcpPromptResult> => {
      onUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-late",
        name: "run_command",
        status: "pending",
      })
      onUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-late",
        name: "run_command",
        status: "completed",
        rawInput: { command: "pwd" },
        rawOutput: "raw command output",
      } as any)
      return { stopReason: "end_turn" }
    }
    const model = new AntigravityLanguageModel("gemini-3.8-flash", { run })
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      headers: { "x-opencode-session-id": "s-1" },
    } as any)
    const parts = await collect(stream)
    const result = parts.find((part) => part.type === "tool-result")
    expect(result.result).toMatchObject({
      input: '{"command":"pwd"}',
      rawOutput: "raw command output",
    })
  })

  test("renders text, reasoning, provider-executed tools and usage", async () => {
    const run = async (
      _sessionID: string,
      _request: unknown,
      onUpdate: (update: AcpSessionUpdate) => void,
    ): Promise<AcpPromptResult> => {
      onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } })
      onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })
      onUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        name: "read_file",
        title: "Read file",
        status: "in_progress",
        rawInput: { path: "/tmp/x" },
      })
      onUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        name: "read_file",
        title: "Read file",
        status: "completed",
        content: { type: "text", text: "done" },
      })
      onUpdate({ sessionUpdate: "usage_update", used: 42, size: 1000 } as any)
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          thoughtTokens: 2,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          totalTokens: 15,
        },
      }
    }

    const model = new AntigravityLanguageModel("gemini-3.8-flash", { run })
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      headers: { "x-opencode-session-id": "s-1", "x-opencode-variant": "low" },
    } as any)

    const parts = await collect(stream)
    const types = parts.map((part) => part.type)
    expect(types).toContain("stream-start")
    expect(types).toContain("reasoning-start")
    expect(types).toContain("reasoning-delta")
    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-call")
    expect(types).toContain("tool-result")
    expect(types).toContain("finish")

    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall).toMatchObject({
      toolCallId: "call-1",
      toolName: "read_file",
      providerExecuted: true,
    })
    const toolResult = parts.find((part) => part.type === "tool-result")
    expect(toolResult).toMatchObject({ toolCallId: "call-1", isError: false })

    const finish = parts.find((part) => part.type === "finish")
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "end_turn" })
    expect(finish.usage.inputTokens).toEqual({
      total: 10,
      noCache: 10,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(finish.usage.outputTokens).toEqual({ total: 5, text: 3, reasoning: 2 })
  })
})
