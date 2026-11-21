#!/usr/bin/env node
// Minimal ACP agent used by the plugin's integration test. It speaks ACP v1
// over NDJSON and never touches Antigravity or the network.

import readline from "node:readline"

const rl = readline.createInterface({ input: process.stdin })
const sessionId = "mock-antigravity-session"
let model = "gemini-3.8-flash"
let effort = "high"
let mode = "default"

const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
  },
  {
    id: "thought_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
]

const modes = () => ({
  currentModeId: mode,
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
})

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const result = (id, value) => write({ jsonrpc: "2.0", id, result: value })
const update = (updateValue) =>
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: updateValue },
  })

rl.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: 1,
      agentInfo: { name: "Mock Antigravity ACP", version: "0.0.1" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
        auth: { logout: {} },
      },
      authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
    })
    return
  }

  if (message.method === "session/new") {
    result(message.id, {
      sessionId,
      models: {
        currentModelId: "gemini-3.8-flash-high",
        availableModels: [
          { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
          { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
          { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
        ],
      },
      modes: modes(),
      configOptions: configOptions(),
    })
    return
  }

  if (message.method === "session/resume" || message.method === "session/load") {
    result(message.id, { configOptions: configOptions(), modes: modes() })
    return
  }

  if (message.method === "session/set_config_option") {
    if (message.params.configId === "model") model = message.params.value
    if (message.params.configId === "thought_level") effort = message.params.value
    if (message.params.configId === "mode") mode = message.params.value
    result(message.id, { configOptions: configOptions() })
    return
  }

  if (message.method === "session/set_mode") {
    mode = message.params.modeId
    result(message.id, {})
    return
  }

  if (message.method === "session/prompt") {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "mock thought" } })
    update({
      sessionUpdate: "tool_call",
      toolCallId: "mock-call-1",
      name: "read_file",
      title: "Read a file",
      status: "in_progress",
      rawInput: { path: "/tmp/mock.txt" },
    })
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "mock-call-1",
      name: "read_file",
      title: "Read a file",
      status: "completed",
      content: { type: "text", text: "mock file contents" },
    })
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from mock Antigravity." },
    })
    update({ sessionUpdate: "usage_update", used: 10, size: 1000 })
    result(message.id, {
      stopReason: "end_turn",
      usage: {
        inputTokens: 5,
        outputTokens: 4,
        thoughtTokens: 1,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        totalTokens: 9,
      },
    })
    return
  }

  if (message.method === "session/close") {
    result(message.id, {})
    return
  }

  if (message.method === "session/cancel") {
    return
  }

  if (message.id !== undefined && message.method) {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unsupported mock method: ${message.method}` },
    })
  }
})
