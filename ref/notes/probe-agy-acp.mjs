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

function send(method, params) {
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
    }, 15000)
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

try {
  const initialized = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
    },
    clientInfo: { name: "opencode-probe", version: "0.0.0" },
  })
  console.log("INITIALIZED", JSON.stringify(initialized, null, 2))
  if (initialized?.authMethods?.length) {
    console.log("AUTH METHODS", JSON.stringify(initialized.authMethods, null, 2))
  }
  try {
    const session = await send("session/new", { cwd, mcpServers: [] })
    console.log("SESSION", JSON.stringify(session, null, 2))
  } catch (error) {
    console.error("SESSION FAILED", error.message)
  }
} catch (error) {
  console.error("INITIALIZE FAILED", error.message)
} finally {
  child.stdin.end()
  child.kill("SIGTERM")
  setTimeout(() => child.kill("SIGKILL"), 2000).unref()
}
