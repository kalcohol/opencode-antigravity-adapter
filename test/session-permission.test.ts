import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { SessionManager, type Options } from "../src/session.js"

const fixture = path.join(import.meta.dir, "fixtures", "mock-agy-acp.mjs")

const makeContext = (seen: any[]) => ({
  permission: {
    assert: async (input: any) => {
      seen.push(input)
    },
  },
  storage: {
    get: async () => undefined,
    set: async () => undefined,
    remove: async () => undefined,
  },
})

const makeManager = (seen: any[]) => {
  const options: Options = {
    directory: process.cwd(),
    command: fixture,
    permission: "ask",
    mode: "default",
    allowConsumerAuth: true,
  }
  return new SessionManager(makeContext(seen) as any, options)
}

afterEach(() => {
  delete process.env.MOCK_PERMISSION_KIND
  delete process.env.MOCK_PERMISSION_NO_ALLOW
})

test("permission request uses cached execute arguments and canonical shell action", async () => {
  process.env.MOCK_PERMISSION_KIND = "execute"
  const seen: any[] = []
  const manager = makeManager(seen)
  try {
    const result = await manager.run(
      "session-permission-execute",
      {
        model: "gemini-3.8-flash",
        prompt: [{ type: "text", text: "run it" }],
      },
      () => {},
      new AbortController().signal,
    )
    expect(result.stopReason).toBe("end_turn")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      action: "shell",
      resources: ["printf mock"],
      metadata: {
        antigravity: {
          provider: "antigravity-acp",
          legacyAction: "antigravity.execute",
        },
      },
    })
    expect(seen[0].metadata.rawInput).toBeUndefined()
  } finally {
    await manager.dispose()
  }
})

test("permission request maps read_file with its cached path", async () => {
  process.env.MOCK_PERMISSION_KIND = "read"
  const seen: any[] = []
  const manager = makeManager(seen)
  try {
    await manager.run(
      "session-permission-read",
      {
        model: "gemini-3.8-flash",
        prompt: [{ type: "text", text: "read it" }],
      },
      () => {},
      new AbortController().signal,
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      action: "read",
      resources: ["/tmp/mock.txt"],
      metadata: { antigravity: { legacyAction: "antigravity.read" } },
    })
  } finally {
    await manager.dispose()
  }
})

test("no one-time allow option fails closed without calling assert", async () => {
  process.env.MOCK_PERMISSION_KIND = "execute"
  process.env.MOCK_PERMISSION_NO_ALLOW = "1"
  const seen: any[] = []
  const manager = makeManager(seen)
  try {
    await manager.run(
      "session-permission-no-allow",
      {
        model: "gemini-3.8-flash",
        prompt: [{ type: "text", text: "run it" }],
      },
      () => {},
      new AbortController().signal,
    )
    expect(seen).toHaveLength(0)
  } finally {
    await manager.dispose()
  }
})
