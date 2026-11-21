import { spawn } from "node:child_process"

const cwd = "/tmp/opencode/agy-acp-probe-cwd"
await import("node:fs/promises").then((fs) => fs.mkdir(cwd, { recursive: true }))

const child = spawn("agy", ["acp", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd,
})
let buffer = ""
let nextId = 2
const pending = new Map()

function send(method, params, timeout = 15000) {
  const id = nextId++
  const message = { jsonrpc: "2.0", id, method, params }
  console.log(">>>", JSON.stringify(message))
  child.stdin.write(JSON.stringify(message) + "\n")
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }
    }, timeout).unref()
  })
}

child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf("\n")
    if (index < 0) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    console.log("<<<", line)
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  }
})
child.stderr.setEncoding("utf8")
child.stderr.on("data", (chunk) => console.error("stderr:", chunk.toString().trimEnd()))

function configValue(response, configId) {
  return response?.configOptions?.find((option) => option.id === configId)?.currentValue
}

try {
  const initialized = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
    },
    clientInfo: { name: "opencode-probe", version: "0.0.0" },
  })
  console.log("AGENT", initialized.agentInfo?.name, initialized.agentInfo?.version)

  const session = await send("session/new", { cwd, mcpServers: [] })
  const sessionId = session.sessionId
  console.log("SESSION", sessionId)
  console.log("MODELS", session.models?.availableModels?.length)
  for (const option of session.configOptions ?? []) {
    console.log("CONFIG", option.id, "=", option.currentValue, "options:", option.options?.length)
  }

  const switched = await send("session/set_config_option", {
    sessionId,
    configId: "model",
    value: "gemini-3.8-flash",
  })
  console.log("SET_MODEL ->", configValue(switched, "model"))

  const effort = await send("session/set_config_option", {
    sessionId,
    configId: "thought_level",
    value: "low",
  })
  console.log("SET_EFFORT ->", configValue(effort, "thought_level"))

  const mode = await send("session/set_mode", { sessionId, modeId: "plan" })
  console.log("SET_MODE ->", JSON.stringify(mode))

  try {
    const invalid = await send("session/set_config_option", {
      sessionId,
      configId: "model",
      value: "gemini-3.8-flash-low",
    })
    console.log("SET_EFFORT_QUALIFIED_MODEL -> accepted", configValue(invalid, "model"))
  } catch (error) {
    console.log("SET_EFFORT_QUALIFIED_MODEL -> rejected", error.message)
  }

  const restoredModel = await send("session/set_config_option", {
    sessionId,
    configId: "model",
    value: "gemini-4-neon",
  })
  console.log("RESTORE_MODEL ->", configValue(restoredModel, "model"))
  const restoredEffort = await send("session/set_config_option", {
    sessionId,
    configId: "thought_level",
    value: "high",
  })
  console.log("RESTORE_EFFORT ->", configValue(restoredEffort, "thought_level"))
  const restoredMode = await send("session/set_mode", { sessionId, modeId: "default" })
  console.log("RESTORE_MODE ->", JSON.stringify(restoredMode))

  try {
    const closed = await send("session/close", { sessionId })
    console.log("SESSION_CLOSE ->", JSON.stringify(closed))
  } catch (error) {
    console.log("SESSION_CLOSE -> failed", error.message)
  }
} catch (error) {
  console.error("PROBE FAILED", error.message)
} finally {
  child.stdin.end()
  child.kill("SIGTERM")
  setTimeout(() => child.kill("SIGKILL"), 2000).unref()
}
