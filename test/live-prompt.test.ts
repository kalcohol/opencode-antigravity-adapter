import { expect, test } from "bun:test"
import { AcpProcess, buildModelCatalog, resolveAcpAuthMethod } from "../src/acp/client.js"

const enabled = process.env.ANTIGRAVITY_ACP_LIVE_PROMPT === "1"
const consumer = resolveAcpAuthMethod() === "oauth-personal"
const consumerAllowed = !consumer || process.env.ANTIGRAVITY_ACP_ALLOW_CONSUMER === "1"
const live = enabled && consumerAllowed ? test : test.skip

live(
  "real agy acp prompt",
  async () => {
    let text = ""
    const proc = new AcpProcess({
      cwd: process.cwd(),
      onUpdate: (_sessionId, update) => {
        if (update.sessionUpdate !== "agent_message_chunk") return
        const content = update.content
        if (!content || Array.isArray(content)) return
        const block = content as { type?: string; text?: string }
        if (block.type === "text" && typeof block.text === "string") text += block.text
      },
    })
    try {
      const initialized = await proc.initialize()
      expect(initialized.protocolVersion).toBe(1)

      const session = await proc.newSession({ cwd: process.cwd(), mcpServers: [] })
      const catalog = buildModelCatalog(session)
      const model = catalog.find((entry) => entry.id.includes("3.8-flash")) ?? catalog[0]
      await proc.setConfigOption(session.sessionId, "model", model.id)
      await proc.setConfigOption(session.sessionId, "thought_level", "low")

      const result = await proc.prompt(session.sessionId, [
        { type: "text", text: "Reply with exactly OK." },
      ])
      expect(result.stopReason).toBeTruthy()
      expect(text.trim().length).toBeGreaterThan(0)

      await proc.closeSession(session.sessionId)
    } finally {
      await proc.dispose()
    }
  },
  120_000,
)
