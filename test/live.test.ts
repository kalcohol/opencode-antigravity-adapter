import { expect, test } from "bun:test"
import { AcpProcess, buildModelCatalog, resolveAcpModelTarget } from "../src/acp/client.js"

const live = process.env.ANTIGRAVITY_ACP_LIVE === "1" ? test : test.skip

live(
  "real agy acp handshake, catalog and config option",
  async () => {
    const proc = new AcpProcess({ cwd: process.cwd() })
    try {
      const initialized = await proc.initialize()
      expect(initialized.protocolVersion).toBe(1)

      const session = await proc.newSession({ cwd: process.cwd(), mcpServers: [] })
      expect(typeof session.sessionId).toBe("string")
      expect(session.sessionId.length).toBeGreaterThan(0)

      const catalog = buildModelCatalog(session)
      expect(catalog.length).toBeGreaterThan(0)
      const model = catalog.find((entry) => entry.variants.length > 0) ?? catalog[0]
      const variant = model.variants[0]?.id
      const target = resolveAcpModelTarget(catalog, model.id, variant)
      expect(target).toBeTruthy()

      const switched = await proc.setConfigOption(
        session.sessionId,
        "model",
        target!.baseModelId,
      )
      const current = switched?.configOptions?.find((option: any) => option.id === "model")?.currentValue
      expect(current).toBe(target!.baseModelId)

      await proc.closeSession(session.sessionId)
    } finally {
      await proc.dispose()
    }
  },
  60_000,
)
