import { beforeEach, describe, expect, test } from "bun:test"
import {
  MAX_RESOURCE_BYTES,
  evaluateAntigravityPermission,
  explicitAgentRules,
  mergeToolCall,
  permissionPlan,
  readAntigravityMarker,
  resolveExplicitRules,
  resolveLegacyOnly,
  resolvePermission,
  targetFromMarker,
  wildcardMatch,
  type PermissionRule,
} from "../src/permission-policy.js"
import {
  clearPermissionRegistry as clearRegistryForTests,
  findPendingPermission,
  registerPermission,
  unregisterPermission,
} from "../src/permission-registry.js"

const cwd = "/repo"

const baseRules: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

const buildRules = (...extra: PermissionRule[]): PermissionRule[] => [
  ...baseRules,
  { action: "question", resource: "*", effect: "allow" },
  ...extra,
]

const exploreRules = (...extra: PermissionRule[]): PermissionRule[] => [
  ...baseRules,
  { action: "*", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "allow" },
  ...extra,
]

const generalRules = (...extra: PermissionRule[]): PermissionRule[] => [
  ...baseRules,
  { action: "question", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  ...extra,
]

const titleRules = (...extra: PermissionRule[]): PermissionRule[] => [
  ...baseRules,
  { action: "*", resource: "*", effect: "deny" },
  ...extra,
]

const planRules = (...extra: PermissionRule[]): PermissionRule[] => [
  ...baseRules,
  { action: "question", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "edit", resource: "/home/me/.opencode/plan/*", effect: "allow" },
  ...extra,
]

const executeTarget = {
  requestID: "req-1",
  legacyAction: "antigravity.execute",
  legacyResources: ["printf hi"],
  autoAllowThink: false,
  forceAsk: false,
} as const

const resolveShell = (
  agentRules: PermissionRule[],
  options: {
    sessionRules?: PermissionRule[]
    extraRules?: PermissionRule[]
    action?: string
    resources?: string[]
    effect?: "allow" | "ask" | "deny"
    agentID?: string
  } = {},
): string =>
  resolvePermission({
    action: options.action ?? "shell",
    resources: options.resources ?? ["printf hi"],
    effect: options.effect ?? "allow",
    target: executeTarget,
    agentID: options.agentID ?? "build",
    appVersion: "2.3.2",
    agentRules: [...agentRules, ...(options.extraRules ?? [])],
    sessionRules: options.sessionRules ?? [],
  })

describe("permission plan", () => {
  test("maps the captured run_command frame to shell with only the command", () => {
    const plan = permissionPlan(
      {
        toolCallId: "call-1",
        kind: "execute",
        name: "run_command",
        title: "printf hi",
        rawInput: { CommandLine: "printf hi", WaitMsBeforeAsync: 5000 },
        locations: [{ path: "/repo" }],
      },
      "req-1",
      cwd,
    )
    expect(plan.action).toBe("shell")
    expect(plan.resources).toEqual(["printf hi"])
    expect(plan.legacyAction).toBe("antigravity.execute")
    expect(plan.legacyResources).toEqual(["/repo"])
    expect(plan.metadata).toMatchObject({
      title: "printf hi",
      paths: ["/repo"],
      antigravity: { provider: "antigravity-acp", requestID: "req-1" },
    })
    expect(JSON.stringify(plan.metadata)).not.toContain("WaitMsBeforeAsync")
  })

  test("maps the captured read_file frame", () => {
    const plan = permissionPlan(
      {
        toolCallId: "call-2",
        kind: "read",
        name: "read_file",
        title: "File /etc/hostname",
        rawInput: { Path: "/etc/hostname" },
        locations: [{ path: "/etc/hostname" }],
      },
      "req-2",
      cwd,
    )
    expect(plan.action).toBe("read")
    expect(plan.resources).toEqual(["/etc/hostname"])
    expect(plan.legacyAction).toBe("antigravity.read")
    expect(plan.legacyResources).toEqual(["/etc/hostname"])
  })

  test("maps the captured write_file frame", () => {
    const plan = permissionPlan(
      {
        toolCallId: "call-3",
        kind: "edit",
        name: "write_file",
        title: "File .capture",
        rawInput: { Path: "/repo/.capture", Content: "hello", Overwrite: true },
        locations: [{ path: "/repo/.capture" }],
      },
      "req-3",
      cwd,
    )
    expect(plan.action).toBe("edit")
    expect(plan.resources).toEqual(["/repo/.capture"])
  })

  test("maps search_web to websearch, not grep", () => {
    const plan = permissionPlan(
      {
        toolCallId: "call-4",
        kind: "search",
        name: "search_web",
        title: '"OpenCode" on Web',
        rawInput: { query: "OpenCode" },
      },
      "req-4",
      cwd,
    )
    expect(plan.action).toBe("websearch")
    expect(plan.resources).toEqual(["OpenCode"])
    expect(plan.metadata).toMatchObject({ query: "OpenCode", provider: "antigravity" })
  })

  test("leaves delete/move/unknown kinds namespaced", () => {
    expect(
      permissionPlan(
        { toolCallId: "d", kind: "delete", title: "Delete file", locations: [{ path: "/repo/a" }] },
        "r",
        cwd,
      ).action,
    ).toBe("antigravity.delete")
    expect(
      permissionPlan(
        { toolCallId: "m", kind: "move", title: "Move file", locations: [{ path: "/repo/a" }] },
        "r",
        cwd,
      ).action,
    ).toBe("antigravity.move")
    expect(
      permissionPlan({ toolCallId: "o", kind: "other", title: "Other" }, "r", cwd).action,
    ).toBe("antigravity.other")
  })

  test("fails back to namespaced when a required parameter is missing", () => {
    const execute = permissionPlan(
      { toolCallId: "e", kind: "execute", name: "run_command", title: "Run" },
      "r",
      cwd,
    )
    expect(execute.action).toBe("antigravity.execute")
    expect(execute.resources).toEqual(["Run"])

    const read = permissionPlan(
      { toolCallId: "r", kind: "read", title: "Read" },
      "r",
      cwd,
    )
    expect(read.action).toBe("antigravity.read")
    expect(read.resources).toEqual(["Read"])
  })

  test("does not stringify non-object rawInput", () => {
    const plan = permissionPlan(
      { toolCallId: "x", kind: "execute", title: "Run", rawInput: ["printf hi"] },
      "r",
      cwd,
    )
    expect(plan.action).toBe("antigravity.execute")
    expect(plan.resources).toEqual(["Run"])
  })

  test("normalizes relative paths against the session cwd", () => {
    const plan = permissionPlan(
      { toolCallId: "p", kind: "read", title: "Read", rawInput: { Path: "src/a.ts" } },
      "r",
      cwd,
    )
    expect(plan.action).toBe("read")
    expect(plan.resources).toEqual(["/repo/src/a.ts"])
  })

  test("forces ask when locations overflow", () => {
    const locations = Array.from({ length: 33 }, (_, index) => ({ path: `/repo/${index}` }))
    const plan = permissionPlan(
      { toolCallId: "o", kind: "read", title: "Read", locations },
      "r",
      cwd,
    )
    expect(plan.forceAsk).toBe(true)
    expect(plan.action).toBe("antigravity.read")
    expect(plan.resources).toEqual(["Read"])
  })

  test("leaves a captured-but-disabled fetch namespaced without forceAsk", () => {
    const plan = permissionPlan(
      {
        toolCallId: "fetch",
        kind: "fetch",
        name: "read_url",
        title: "Fetch",
        rawInput: { url: "https://example.com/a" },
      },
      "r",
      cwd,
    )
    expect(plan.action).toBe("antigravity.fetch")
    expect(plan.forceAsk).toBe(false)
  })

  test("rejects an oversized path as a canonical resource", () => {
    const plan = permissionPlan(
      {
        toolCallId: "bigpath",
        kind: "read",
        title: "Read",
        rawInput: { Path: `/repo/${"x".repeat(MAX_RESOURCE_BYTES + 1)}` },
      },
      "r",
      cwd,
    )
    expect(plan.action).toBe("antigravity.read")
    expect(plan.forceAsk).toBe(true)
  })

  test("bounds metadata title and path display values without truncating resources", () => {
    const longPath = `/repo/${"a".repeat(3000)}`
    const plan = permissionPlan(
      {
        toolCallId: "bounds",
        kind: "read",
        title: "t".repeat(1000),
        locations: [{ path: longPath }],
      },
      "r",
      cwd,
    )
    expect(plan.resources).toEqual([longPath])
    expect((plan.metadata.title as string).length).toBeLessThan(1000)
    expect(((plan.metadata.paths as string[])[0] ?? "").length).toBeLessThan(longPath.length)
  })

  test("rejects an oversized command as a canonical resource", () => {
    const plan = permissionPlan(
      {
        toolCallId: "big",
        kind: "execute",
        title: "Run",
        rawInput: { CommandLine: "x".repeat(MAX_RESOURCE_BYTES + 1) },
      },
      "r",
      cwd,
    )
    expect(plan.action).toBe("antigravity.execute")
    expect(plan.forceAsk).toBe(true)
  })
})

describe("tool-call cache", () => {
  test("omitted and null rawInput preserve cached arguments", () => {
    const first = mergeToolCall(undefined, {
      kind: "read",
      rawInput: { Path: "/a" },
      locations: [{ path: "/a" }],
    })
    expect(mergeToolCall(first, { title: "Renamed" }).rawInput).toEqual({ Path: "/a" })
    expect(mergeToolCall(first, { rawInput: null }).rawInput).toEqual({ Path: "/a" })
    expect(mergeToolCall(first, { rawInput: undefined }).rawInput).toEqual({ Path: "/a" })
    expect(mergeToolCall(first, { rawInput: null }).locations).toEqual([{ path: "/a" }])
  })

  test("a concrete locations array replaces; null clears", () => {
    const first = mergeToolCall(undefined, { locations: [{ path: "/a" }] })
    expect(mergeToolCall(first, { locations: [{ path: "/b" }] }).locations).toEqual([{ path: "/b" }])
    expect(mergeToolCall(first, { locations: null }).locations).toBeUndefined()
  })

  test("oversized rawInput is dropped and marked overflow", () => {
    const merged = mergeToolCall(undefined, { rawInput: { command: "x".repeat(70 * 1024) } })
    expect(merged.rawInput).toBeUndefined()
    expect(merged.rawInputOverflow).toBe(true)
  })
})

describe("rule resolution", () => {
  test("build agent with no explicit rule asks", () => {
    expect(resolveShell(buildRules())).toBe("ask")
  })

  test("a canonical shell allow is honored", () => {
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "shell", resource: "*", effect: "allow" }],
      }),
    ).toBe("allow")
  })

  test("exact shell command is honored; wildcard allow downgrades to ask", () => {
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "shell", resource: "printf hi", effect: "allow" }],
      }),
    ).toBe("allow")
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "shell", resource: "printf *", effect: "allow" }],
      }),
    ).toBe("ask")
  })

  test("an explicit canonical deny wins", () => {
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "shell", resource: "*", effect: "deny" }],
      }),
    ).toBe("deny")
  })

  test("legacy allow still works and legacy deny beats canonical allow", () => {
    expect(
      resolveShell(buildRules(), {
        extraRules: [
          { action: "antigravity.*", resource: "*", effect: "allow" },
          { action: "shell", resource: "*", effect: "allow" },
        ],
      }),
    ).toBe("allow")
    expect(
      resolveShell(buildRules(), {
        extraRules: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "antigravity.execute", resource: "*", effect: "deny" },
        ],
      }),
    ).toBe("deny")
    expect(
      resolveShell(buildRules(), {
        extraRules: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "antigravity.*", resource: "*", effect: "ask" },
        ],
      }),
    ).toBe("ask")
  })

  test("catch-all rules and saved allows do not create an allow", () => {
    expect(
      resolveShell(buildRules({ action: "*", resource: "*", effect: "ask" })),
    ).toBe("ask")
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "*", resource: "*", effect: "allow" }],
      }),
    ).toBe("ask")
    expect(
      resolvePermission({
        action: "shell",
        resources: ["printf hi"],
        effect: "allow",
        target: executeTarget,
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules(),
        sessionRules: [],
      }),
    ).toBe("ask")
  })

  test("aliases only uphold an allow OpenCode already computed", () => {
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "bash", resource: "*", effect: "allow" }],
      }),
    ).toBe("allow")
    expect(
      resolveShell(buildRules(), {
        effect: "ask",
        extraRules: [{ action: "bash", resource: "*", effect: "allow" }],
      }),
    ).toBe("ask")
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "write", resource: "*", effect: "deny" }],
        action: "edit",
        resources: ["/repo/a"],
      }),
    ).toBe("deny")
    expect(
      resolveShell(buildRules(), {
        extraRules: [{ action: "bash", resource: "*", effect: "deny" }],
      }),
    ).toBe("deny")
    expect(
      resolveShell(buildRules(), {
        action: "edit",
        resources: ["/repo/a"],
        extraRules: [{ action: "apply_patch", resource: "*", effect: "allow" }],
      }),
    ).toBe("allow")
  })

  test("multi-resource edit requires explicit coverage of every resource", () => {
    expect(
      resolveShell(buildRules(), {
        action: "edit",
        resources: ["/a", "/b"],
        extraRules: [{ action: "edit", resource: "/a", effect: "allow" }],
      }),
    ).toBe("ask")
    expect(
      resolveShell(buildRules(), {
        action: "edit",
        resources: ["/a", "/a2"],
        extraRules: [
          { action: "edit", resource: "/a", effect: "allow" },
          { action: "edit", resource: "/a2", effect: "allow" },
        ],
      }),
    ).toBe("allow")
    expect(
      resolveShell(buildRules(), {
        action: "edit",
        resources: ["/a", "/a2"],
        extraRules: [
          { action: "edit", resource: "/a", effect: "allow" },
          { action: "edit", resource: "/a2", effect: "deny" },
        ],
      }),
    ).toBe("deny")
  })

  test("built-in explore allows never become explicit user allows", () => {
    expect(resolveShell(exploreRules(), { agentID: "explore" })).toBe("ask")
  })

  test("general, title and compaction built-in prefixes leave no user allow", () => {
    expect(explicitAgentRules("general", generalRules(), "2.3.2")).toEqual([])
    expect(explicitAgentRules("title", titleRules(), "2.3.2")).toEqual([])
    expect(explicitAgentRules("compaction", baseRules, "2.3.2")).toEqual([])
    expect(resolveShell(generalRules(), { agentID: "general" })).toBe("ask")
    expect(resolveShell(titleRules(), { agentID: "title" })).toBe("ask")
  })

  test("built-in plan allows never become explicit user allows", () => {
    expect(
      resolveShell(planRules(), {
        agentID: "plan",
        action: "edit",
        resources: ["/home/me/.opencode/plan/a.md"],
      }),
    ).toBe("ask")
  })

  test("unknown OpenCode versions disable canonical auto-allow", () => {
    expect(
      resolvePermission({
        action: "shell",
        resources: ["printf hi"],
        effect: "allow",
        target: executeTarget,
        agentID: "build",
        appVersion: "9.9.9",
        agentRules: buildRules({ action: "shell", resource: "*", effect: "allow" }),
        sessionRules: [],
      }),
    ).toBe("ask")
  })

  test("prefix mismatch disables canonical auto-allow", () => {
    const rules: PermissionRule[] = [
      ...baseRules,
      { action: "question", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "allow" },
    ]
    expect(explicitAgentRules("build", rules, "2.3.2")).toEqual([])
    expect(resolveShell(rules)).toBe("ask")
  })

  test("auto-allow think only when there is no explicit ask/deny", () => {
    const target = {
      legacyAction: "antigravity.think",
      legacyResources: ["Thinking"],
      autoAllowThink: true,
      forceAsk: false,
    }
    expect(
      resolvePermission({
        action: "antigravity.think",
        resources: ["Thinking"],
        effect: "allow",
        target,
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules(),
        sessionRules: [],
      }),
    ).toBe("allow")
    expect(
      resolvePermission({
        action: "antigravity.think",
        resources: ["Thinking"],
        effect: "allow",
        target,
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules({ action: "antigravity.think", resource: "*", effect: "ask" }),
        sessionRules: [],
      }),
    ).toBe("ask")
  })

  test("forceAsk prevents auto-allow", () => {
    const target = { ...executeTarget, forceAsk: true }
    expect(
      resolvePermission({
        action: "shell",
        resources: ["printf hi"],
        effect: "allow",
        target,
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules({ action: "shell", resource: "*", effect: "allow" }),
        sessionRules: [],
      }),
    ).toBe("ask")
  })

  test("legacy-only resolution keeps old action/resources", () => {
    const rules = buildRules({ action: "antigravity.execute", resource: "/workspace/*", effect: "deny" })
    expect(resolveLegacyOnly("antigravity.execute", ["/workspace/file"], rules, [])).toBe("deny")
    expect(resolveLegacyOnly("antigravity.execute", ["/other"], rules, [])).toBe("ask")
  })

  test("wildcard matches OpenCode semantics", () => {
    expect(wildcardMatch("foo/bar", "foo/*")).toBe(true)
    expect(wildcardMatch("foo/bar", "foo/?ar")).toBe(true)
  })

  test("resolveExplicitRules handles no-resource and uncovered resources", () => {
    const rules: PermissionRule[] = [{ action: "shell", resource: "*", effect: "allow" }]
    expect(resolveExplicitRules(rules, "shell", [], { shell: true, aliases: true, inputEffect: "allow" })).toBeUndefined()
    expect(
      resolveExplicitRules(rules, "shell", ["a", "b"], {
        shell: true,
        aliases: true,
        inputEffect: "allow",
      }),
    ).toBe("allow")
  })
})

describe("evaluate hook decision", () => {
  const markerMetadata = {
    antigravity: {
      provider: "antigravity-acp",
      version: 1,
      requestID: "req-1",
      legacyAction: "antigravity.execute",
      autoAllowThink: false,
      forceAsk: false,
    },
    title: "printf hi",
  }

  test("ignores ordinary OpenCode canonical actions", () => {
    expect(
      evaluateAntigravityPermission({
        action: "shell",
        resources: ["echo hi"],
        effect: "allow",
        metadata: {},
        sessionID: "s-1",
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules(),
        sessionRules: [],
      }),
    ).toBeUndefined()
  })

  test("a valid marker with no explicit rule asks", () => {
    expect(
      evaluateAntigravityPermission({
        action: "shell",
        resources: ["printf hi"],
        effect: "allow",
        metadata: markerMetadata,
        sessionID: "s-1",
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules(),
        sessionRules: [],
      }),
    ).toBe("ask")
  })

  test("a marker plus explicit shell allow is allowed", () => {
    expect(
      evaluateAntigravityPermission({
        action: "shell",
        resources: ["printf hi"],
        effect: "allow",
        metadata: markerMetadata,
        sessionID: "s-1",
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules({ action: "shell", resource: "*", effect: "allow" }),
        sessionRules: [],
      }),
    ).toBe("allow")
  })

  test("a lost marker is recovered from the pending registry target", () => {
    expect(
      evaluateAntigravityPermission({
        action: "shell",
        resources: ["printf hi"],
        effect: "allow",
        metadata: {},
        sessionID: "s-1",
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules({ action: "shell", resource: "*", effect: "allow" }),
        sessionRules: [],
        pending: {
          requestID: "req-1",
          legacyAction: "antigravity.execute",
          legacyResources: ["printf hi"],
          autoAllowThink: false,
          forceAsk: false,
        },
      }),
    ).toBe("allow")
  })

  test("a malformed marker fails closed", () => {
    expect(
      evaluateAntigravityPermission({
        action: "shell",
        resources: ["printf hi"],
        effect: "allow",
        metadata: { antigravity: { provider: "not-us" } },
        sessionID: "s-1",
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules({ action: "shell", resource: "*", effect: "allow" }),
        sessionRules: [],
      }),
    ).toBe("ask")
  })

  test("namespaced requests without a marker use legacy rules", () => {
    expect(
      evaluateAntigravityPermission({
        action: "antigravity.execute",
        resources: ["printf hi"],
        effect: "allow",
        metadata: {},
        sessionID: "s-1",
        agentID: "build",
        appVersion: "2.3.2",
        agentRules: buildRules({ action: "antigravity.*", resource: "*", effect: "allow" }),
        sessionRules: [],
      }),
    ).toBe("allow")
  })
})

describe("marker and registry", () => {
  beforeEach(() => {
    clearRegistryForTests()
    clearRegistryForTests()
  })

  test("reads a valid marker and rebuilds a legacy target", () => {
    const metadata = {
      antigravity: {
        provider: "antigravity-acp",
        version: 1,
        requestID: "req-1",
        legacyAction: "antigravity.execute",
        autoAllowThink: false,
        forceAsk: false,
      },
      title: "Run",
      paths: ["/repo"],
    }
    const marker = readAntigravityMarker(metadata)
    expect(marker?.requestID).toBe("req-1")
    expect(targetFromMarker(marker!, metadata, ["fallback"])).toMatchObject({
      legacyAction: "antigravity.execute",
      legacyResources: ["/repo"],
    })
    expect(readAntigravityMarker({ antigravity: { provider: "other" } })).toBeUndefined()
  })

  test("registry matches by requestID, then by session/action/resources", () => {
    registerPermission({
      requestID: "req-1",
      sessionID: "s-1",
      action: "shell",
      resources: ["printf hi"],
      legacyAction: "antigravity.execute",
      legacyResources: ["printf hi"],
    })
    expect(findPendingPermission({ requestID: "req-1", sessionID: "s-1", action: "shell", resources: ["printf hi"] })?.requestID).toBe("req-1")
    expect(findPendingPermission({ sessionID: "s-1", action: "shell", resources: ["printf hi"] })?.requestID).toBe("req-1")
    expect(findPendingPermission({ sessionID: "s-1", action: "shell", resources: ["other"] })).toBeUndefined()
    unregisterPermission("req-1")
    expect(findPendingPermission({ requestID: "req-1", sessionID: "s-1", action: "shell", resources: ["printf hi"] })).toBeUndefined()
  })
})
