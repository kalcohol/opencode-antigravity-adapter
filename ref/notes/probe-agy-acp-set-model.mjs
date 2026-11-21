import { spawn } from "node:child_process"

const cwd = "/tmp/opencode/agy-acp-probe-cwd"
await import("node:fs/promises").then((fs) => fs.mkdir(cwd, { recursive: true }))

const child = spawn("agy", ["acp", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd })
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
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)) }
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
    try { message = JSON.parse(line) } catch { continue }
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

try {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "opencode-probe", version: "0.0.0" },
  })
  const session = await send("session/new", { cwd, mcpServers: [] })
  const sessionId = session.sessionId
  console.log("SESSION", sessionId)
  for (const modelId of ["gemini-3.8-flash-low", "gemini-3.8-flash", "claude-sonnet-5-5-high"]) {
    try {
      const result = await send("session/set_model", { sessionId, modelId })
      console.log("SET_MODEL", modelId, "->", JSON.stringify(result))
    } catch (error) {
      console.log("SET_MODEL", modelId, "-> rejected", error.message)
    }
  }
  const config = await send("session/set_config_option", { sessionId, configId: "model", value: "gemini-4-neon" })
  console.log("RESTORE", JSON.stringify(config.configOptions?.find((o) => o.id === "model")))
  await send("session/close", { sessionId }).catch(() => {})
} catch (error) {
  console.error("PROBE FAILED", error.message)
} finally {
  child.stdin.end()
  child.kill("SIGTERM")
  setTimeout(() => child.kill("SIGKILL"), 2000).unref()
}
