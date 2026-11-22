import { expect, test } from "bun:test"

// Dev-only contract test against the pinned OpenCode TUI source. `ref/` is not
// part of the published plugin; the test is skipped when the checkout is absent.
const presentationModule = new URL(
  "../../ref/opencode-pr-65430/packages/tui/src/util/permission.ts",
  import.meta.url,
)

const loadPresentation = async () => {
  if (!(await Bun.file(presentationModule).exists())) return undefined
  return (await import(presentationModule.href)) as {
    permissionPresentation: (input: any) => {
      title: string
      lines: readonly string[]
      diff?: string
    }
  }
}

test("real TUI presentation shows shell resources, edit/read paths, and websearch query", async () => {
  const module = await loadPresentation()
  if (!module) return
  const { permissionPresentation } = module

  expect(
    permissionPresentation({ action: "shell", resources: ["printf hi"], metadata: {} }),
  ).toMatchObject({ title: "Shell command", lines: ["- printf hi"] })

  const edit = permissionPresentation({ action: "edit", resources: ["/repo/a"], metadata: {} })
  expect(edit).toMatchObject({ title: "Edit /repo/a", lines: [] })
  expect(edit.diff).toBeUndefined()

  expect(
    permissionPresentation({ action: "read", resources: ["/etc/hostname"], metadata: {} }),
  ).toMatchObject({ title: "Read /etc/hostname" })

  expect(
    permissionPresentation({
      action: "websearch",
      resources: ["OpenCode"],
      metadata: { query: "OpenCode", provider: "antigravity" },
    }),
  ).toMatchObject({ title: 'Web Search via Antigravity "OpenCode"' })
})

test("real TUI presentation keeps generic actions generic", async () => {
  const module = await loadPresentation()
  if (!module) return
  expect(
    module.permissionPresentation({
      action: "antigravity.other",
      resources: ["Title is ignored"],
      metadata: { title: "Title is ignored" },
    }),
  ).toMatchObject({
    title: "Call tool antigravity.other",
    lines: ["Tool: antigravity.other"],
  })
})
