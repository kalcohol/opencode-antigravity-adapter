// Pure permission planning and rule resolution for Antigravity ACP.
//
// The plugin only gates permission requests that Antigravity actually sends.
// This module keeps that logic independent of the ACP process and the OpenCode
// plugin API so it can be tested without spawning `agy`.

import path from "node:path"

export type PermissionEffect = "allow" | "ask" | "deny"

export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: PermissionEffect
}

export interface PermissionLocation {
  readonly path?: string
  readonly line?: number | null
}

/**
 * The subset of an ACP ToolCall that permission handling needs. `rawInput` is
 * deliberately `unknown`: ACP allows any JSON value.
 */
export interface PermissionToolCall {
  readonly toolCallId?: string
  readonly title?: string
  readonly name?: string
  readonly kind?: string
  readonly rawInput?: unknown
  readonly locations?: ReadonlyArray<PermissionLocation>
  readonly rawInputOverflow?: boolean
  readonly locationsOverflow?: boolean
}

/** A patch from tool_call / tool_call_update / request_permission. */
export interface ToolCallPatch {
  readonly kind?: string | null
  readonly name?: string | null
  readonly title?: string | null
  readonly rawInput?: unknown
  readonly locations?: ReadonlyArray<PermissionLocation> | null
}

export interface CachedToolCall {
  readonly kind?: string
  readonly name?: string
  readonly title?: string
  readonly rawInput?: unknown
  readonly rawInputOverflow?: boolean
  readonly locations?: ReadonlyArray<PermissionLocation>
  readonly locationsOverflow?: boolean
}

export interface PermissionTarget {
  readonly requestID?: string
  readonly legacyAction: string
  readonly legacyResources: readonly string[]
  readonly autoAllowThink: boolean
  readonly forceAsk: boolean
}

export interface PermissionPlan {
  readonly requestID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly legacyAction: string
  readonly legacyResources: readonly string[]
  readonly autoAllowThink: boolean
  readonly forceAsk: boolean
  readonly metadata: Record<string, unknown>
}

export interface AntigravityMarker {
  readonly provider: "antigravity-acp"
  readonly version: 1
  readonly requestID: string
  readonly kind?: string
  readonly tool?: string
  readonly legacyAction: string
  readonly autoAllowThink: boolean
  readonly forceAsk: boolean
}

export const MARKER_PROVIDER = "antigravity-acp"
export const MARKER_VERSION = 1
export const MAX_RESOURCE_BYTES = 64 * 1024
export const MAX_TITLE_BYTES = 512
export const MAX_METADATA_QUERY_BYTES = 1024
export const MAX_METADATA_PATH_BYTES = 2048
export const MAX_METADATA_URL_BYTES = 2048
export const MAX_PATHS = 32
export const MAX_CACHED_RAW_INPUT_BYTES = 64 * 1024
export const MAX_CACHED_TOOL_CALLS = 256
export const MAX_LOCATIONS = 32
export const SUPPORTED_OPENCODE_VERSION = "2.3.2"

/** Captured `webfetch` is intentionally disabled until a real frame exists. */
const ENABLE_CAPTURED_WEBFETCH = false

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined

const truncate = (value: string, maxBytes: number): string => {
  if (byteLength(value) <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1
  return `${value.slice(0, end)}…`
}

const boundedResource = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  return byteLength(value) <= MAX_RESOURCE_BYTES ? value : undefined
}

const stringField = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = stringValue(record[key])
    if (value) return value
  }
  return undefined
}

const normalizePath = (value: string, cwd: string): string => {
  const normalized = path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value)
  return normalized
}

const pathKey = (value: string): string => value.replaceAll("\\", "/")

const dedupePaths = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = pathKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/** Extract string locations from a tool call, preserving their original form. */
const locationPaths = (tool: PermissionToolCall): { paths: string[]; overflow: boolean } => {
  const locations = Array.isArray(tool.locations) ? tool.locations : []
  const paths: string[] = []
  for (const location of locations) {
    if (!isRecord(location)) continue
    const value = stringValue(location.path)
    if (value) paths.push(value)
  }
  return { paths, overflow: paths.length > MAX_LOCATIONS }
}

/** Extract path strings from rawInput, only from a plain object. */
const rawPathCandidates = (rawInput: unknown): string[] => {
  if (!isRecord(rawInput)) return []
  const keys = [
    "Path",
    "path",
    "filePath",
    "file_path",
    "FilePath",
    "TargetFile",
    "targetFile",
    "AbsolutePath",
    "absolutePath",
    "target",
  ] as const
  return keys.flatMap((key) => {
    const value = stringValue(rawInput[key])
    return value ? [value] : []
  })
}

const legacyTitle = (tool: PermissionToolCall): string => {
  const title = stringValue(tool.title) ?? stringValue(tool.name) ?? stringValue(tool.kind)
  return title ? truncate(title, MAX_RESOURCE_BYTES) : "Antigravity tool"
}

const legacyAction = (tool: PermissionToolCall): string =>
  `antigravity.${tool.kind ?? tool.name ?? "tool"}`

const commandOf = (rawInput: unknown): string | undefined => {
  if (!isRecord(rawInput)) return undefined
  return stringField(rawInput, [
    "CommandLine",
    "command",
    "commandLine",
    "cmd",
    "cmdline",
    "shellCommand",
  ])
}

const urlOf = (rawInput: unknown): string | undefined => {
  if (!isRecord(rawInput)) return undefined
  return stringField(rawInput, ["url", "Url", "URL", "uri", "Uri", "URI"])
}

const queryOf = (rawInput: unknown): string | undefined => {
  if (!isRecord(rawInput)) return undefined
  return stringField(rawInput, ["query", "Query"])
}

const redactUrl = (value: string): string => {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|sig|auth/i.test(key)) {
        url.searchParams.set(key, "REDACTED")
      }
    }
    return url.toString()
  } catch {
    return value
  }
}

/**
 * ACP v1 patch semantics:
 * - rawInput/rawOutput/name: omitted and null both preserve the old value;
 * - kind/title: preserve on omitted/null (conservative; cannot erase cached data);
 * - locations/content: a concrete array replaces; null clears the collection.
 */
export const mergeToolCall = (
  previous: CachedToolCall | undefined,
  patch: ToolCallPatch,
): CachedToolCall => {
  const next: { -readonly [K in keyof CachedToolCall]: CachedToolCall[K] } = {
    ...(previous ?? {}),
  }

  if (hasOwn(patch, "kind") && typeof patch.kind === "string") next.kind = patch.kind
  if (hasOwn(patch, "name") && typeof patch.name === "string") next.name = patch.name
  if (hasOwn(patch, "title") && typeof patch.title === "string") next.title = patch.title

  if (hasOwn(patch, "rawInput") && patch.rawInput !== null && patch.rawInput !== undefined) {
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(patch.rawInput)
    } catch {
      serialized = undefined
    }
    if (serialized !== undefined && byteLength(serialized) <= MAX_CACHED_RAW_INPUT_BYTES) {
      next.rawInput = patch.rawInput
      next.rawInputOverflow = false
    } else {
      next.rawInput = undefined
      next.rawInputOverflow = true
    }
  }

  if (hasOwn(patch, "locations")) {
    if (patch.locations === null) {
      next.locations = undefined
      next.locationsOverflow = false
    } else if (Array.isArray(patch.locations)) {
      const paths: PermissionLocation[] = []
      for (const location of patch.locations) {
        if (!isRecord(location)) continue
        const value = stringValue(location.path)
        if (value) paths.push({ path: value })
      }
      next.locations = paths.slice(0, MAX_LOCATIONS)
      next.locationsOverflow = paths.length > MAX_LOCATIONS
    }
  }

  return next
}

/**
 * Build the permission request for one ACP tool call. The canonical action is
 * only used when a display/rules-safe parameter exists; otherwise the request
 * stays namespaced and fail-closed.
 */
export const permissionPlan = (
  tool: PermissionToolCall,
  requestID: string,
  cwd: string,
): PermissionPlan => {
  const legacy = legacyAction(tool)
  const title = legacyTitle(tool)
  const locations = locationPaths(tool)
  const overflow = locations.overflow || tool.locationsOverflow === true || tool.rawInputOverflow === true
  const legacyPaths = locations.overflow ? [] : locations.paths
  const legacyResources = legacyPaths.length > 0 ? legacyPaths : [title]

  const rawPathValues = locations.paths.length > 0 ? locations.paths : rawPathCandidates(tool.rawInput)
  const oversizedPath = rawPathValues.some(
    (value) => byteLength(normalizePath(value, cwd)) > MAX_RESOURCE_BYTES,
  )
  const canonicalPaths = dedupePaths(
    rawPathValues
      .map((value) => normalizePath(value, cwd))
      .filter((value) => byteLength(value) <= MAX_RESOURCE_BYTES),
  )
  const pathsOverflow = overflow || oversizedPath || canonicalPaths.length > MAX_PATHS

  let action = legacy
  let resources: readonly string[] = legacyResources
  let forceAsk = overflow
  let autoAllowThink = false
  let query: string | undefined
  let url: string | undefined
  let oversizedTarget = false

  if (!overflow) {
    if (tool.kind === "execute") {
      const rawCommand = commandOf(tool.rawInput)
      const command = boundedResource(rawCommand)
      if (command) {
        action = "shell"
        resources = [command]
      } else if (rawCommand) {
        oversizedTarget = true
      }
    } else if (tool.kind === "read" || tool.kind === "edit") {
      if (canonicalPaths.length > 0) {
        action = tool.kind
        resources = canonicalPaths.slice(0, MAX_PATHS)
      }
    } else if (tool.kind === "search") {
      if (tool.name === "search_web") {
        const rawQuery = queryOf(tool.rawInput)
        const candidate = boundedResource(rawQuery)
        if (candidate) {
          action = "websearch"
          resources = [candidate]
          query = truncate(candidate, MAX_METADATA_QUERY_BYTES)
        } else if (rawQuery) {
          oversizedTarget = true
        }
      }
    } else if (tool.kind === "fetch") {
      // No real Antigravity fetch permission frame has been captured yet.
      // Keep this disabled until a fixture proves the shape; do not guess.
      const rawUrl = urlOf(tool.rawInput)
      const candidate = boundedResource(rawUrl)
      if (candidate) {
        if (ENABLE_CAPTURED_WEBFETCH) {
          action = "webfetch"
          resources = [candidate]
          url = truncate(redactUrl(candidate), MAX_METADATA_URL_BYTES)
        }
      } else if (rawUrl) {
        oversizedTarget = true
      }
    } else if (tool.kind === "think") {
      autoAllowThink = true
    }
  }

  if (pathsOverflow || oversizedTarget) {
    forceAsk = true
    if (action === "read" || action === "edit") {
      action = legacy
      resources = [title]
    }
  }

  // Keep the old namespaced action for known namespaced kinds (legacy rules),
  // but use the stable generic action for unknown/missing kinds.
  if (!KNOWN_NAMESPACED_KINDS.has(tool.kind ?? "")) action = "antigravity.other"

  const marker: Record<string, unknown> = {
    provider: MARKER_PROVIDER,
    version: MARKER_VERSION,
    requestID,
    legacyAction: legacy,
    ...(tool.kind ? { kind: tool.kind } : {}),
    ...(tool.name ? { tool: tool.name } : {}),
    autoAllowThink,
    forceAsk,
  }
  const metadata: Record<string, unknown> = {
    antigravity: marker,
    title: truncate(title, MAX_TITLE_BYTES),
    ...(tool.kind ? { kind: tool.kind } : {}),
    ...(tool.name ? { tool: tool.name } : {}),
    ...(legacyPaths.length > 0
      ? { paths: legacyPaths.slice(0, MAX_PATHS).map((value) => truncate(value, MAX_METADATA_PATH_BYTES)) }
      : {}),
    ...(query ? { query, provider: "antigravity" } : {}),
    ...(url ? { url } : {}),
  }

  return {
    requestID,
    action,
    resources,
    legacyAction: legacy,
    legacyResources,
    autoAllowThink,
    forceAsk,
    metadata,
  }
}

/* -------------------------------------------------------------------------- */
/* Rule resolution                                                            */
/* -------------------------------------------------------------------------- */

/** OpenCode's Wildcard.match, copied to avoid depending on an unexported path. */
export const wildcardMatch = (input: string, pattern: string, ignoreCase = false): boolean => {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp(
    "^" + escaped + "$",
    process.platform === "win32" || ignoreCase ? "si" : "s",
  ).test(normalized)
}

const canonicalRuleAction = (action: string): string => {
  if (action === "bash") return "shell"
  if (action === "write" || action === "patch" || action === "apply_patch") return "edit"
  return action
}

const actionMatches = (ruleAction: string, action: string, aliases: boolean): boolean => {
  if (aliases && ruleAction !== "*") {
    return wildcardMatch(canonicalRuleAction(action), canonicalRuleAction(ruleAction))
  }
  return wildcardMatch(action, ruleAction)
}

const isAliasAction = (action: string): boolean =>
  action === "bash" || action === "write" || action === "patch" || action === "apply_patch"

const isCatchAll = (rule: PermissionRule): boolean =>
  rule.action === "*" && rule.resource === "*"

const sanitizeRules = (rules: ReadonlyArray<unknown>): PermissionRule[] => {
  const out: PermissionRule[] = []
  for (const raw of rules) {
    if (!isRecord(raw)) continue
    const action = stringValue(raw.action)
    const resource = stringValue(raw.resource)
    const effect = raw.effect
    if (!action || !resource) continue
    if (effect !== "allow" && effect !== "ask" && effect !== "deny") continue
    out.push({ action, resource, effect })
  }
  return out
}

const ruleMatches = (
  rule: PermissionRule,
  action: string,
  resource: string,
  aliases: boolean,
): boolean => {
  const pathAction = action === "read" || action === "edit" || action === "external_directory"
  const ignoreCase = process.platform === "darwin" && pathAction
  return (
    actionMatches(rule.action, action, aliases) &&
    wildcardMatch(resource, rule.resource, ignoreCase)
  )
}

const safeShellAllow = (ruleResource: string, resource: string): boolean => {
  if (ruleResource === "*") return true
  if (ruleResource.includes("*") || ruleResource.includes("?")) return false
  return ruleResource === resource
}

interface ResolveOptions {
  readonly shell: boolean
  readonly aliases: boolean
  readonly inputEffect: PermissionEffect
}

/**
 * Evaluate explicit rules per resource with OpenCode's findLast semantics.
 * An allow requires every resource to be covered by an allow; deny/ask on any
 * resource wins. `undefined` means "no complete explicit allow".
 */
export const resolveExplicitRules = (
  rules: ReadonlyArray<PermissionRule>,
  action: string,
  resources: ReadonlyArray<string>,
  options: ResolveOptions,
): PermissionEffect | undefined => {
  if (resources.length === 0) return undefined

  const usable = rules.filter((rule) => {
    if (isCatchAll(rule)) return false
    if (!options.aliases) return true
    // Alias allows may only uphold an allow OpenCode already computed. A
    // user-written alias deny/ask still applies.
    if (rule.effect === "allow" && isAliasAction(rule.action) && options.inputEffect !== "allow") {
      return false
    }
    return true
  })

  let anyDeny = false
  let anyAsk = false
  let allCovered = true
  let allAllow = true

  for (const resource of resources) {
    let matched: PermissionRule | undefined
    for (let index = usable.length - 1; index >= 0; index -= 1) {
      const rule = usable[index]
      if (ruleMatches(rule, action, resource, options.aliases)) {
        matched = rule
        break
      }
    }
    if (!matched) {
      allCovered = false
      allAllow = false
      continue
    }
    let effect = matched.effect
    if (effect === "allow" && options.shell && !safeShellAllow(matched.resource, resource)) {
      effect = "ask"
    }
    if (effect === "deny") anyDeny = true
    else if (effect === "ask") anyAsk = true
    else if (effect !== "allow") allAllow = false
  }

  if (anyDeny) return "deny"
  if (anyAsk) return "ask"
  if (allCovered && allAllow) return "allow"
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Built-in agent rule subtraction                                            */
/* -------------------------------------------------------------------------- */

type BuiltinRule = PermissionRule | {
  readonly action: string
  readonly effect: PermissionEffect
  readonly matches: (rule: PermissionRule) => boolean
}

const BASE_RULES: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]
const QUESTION_ALLOW: PermissionRule = { action: "question", resource: "*", effect: "allow" }
const QUESTION_DENY: PermissionRule = { action: "question", resource: "*", effect: "deny" }
const SUBAGENT_DENY: PermissionRule = { action: "subagent", resource: "*", effect: "deny" }
const EDIT_DENY: PermissionRule = { action: "edit", resource: "*", effect: "deny" }
const DENY_ALL: PermissionRule = { action: "*", resource: "*", effect: "deny" }

const planDirRule: BuiltinRule = {
  action: "edit",
  effect: "allow",
  matches: (rule) => {
    if (rule.action !== "edit" || rule.effect !== "allow") return false
    const normalized = rule.resource.replaceAll("\\", "/")
    return normalized.endsWith("*") && normalized.includes("/.opencode/plan/")
  },
}

const KNOWN_NAMESPACED_KINDS = new Set([
  "delete",
  "move",
  "switch_mode",
  "think",
  "other",
  "read",
  "edit",
  "execute",
  "search",
  "fetch",
])

const BUILTIN_PROFILES: Record<string, readonly BuiltinRule[]> = {
  build: [...BASE_RULES, QUESTION_ALLOW],
  general: [...BASE_RULES, QUESTION_DENY, SUBAGENT_DENY],
  explore: [
    ...BASE_RULES,
    DENY_ALL,
    { action: "shell", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    SUBAGENT_DENY,
    { action: "external_directory", resource: "*", effect: "allow" },
  ],
  plan: [...BASE_RULES, QUESTION_ALLOW, EDIT_DENY, planDirRule],
  title: [...BASE_RULES, DENY_ALL],
  summary: [...BASE_RULES, DENY_ALL],
  compaction: [...BASE_RULES],
}

const ruleEquals = (expected: PermissionRule, actual: PermissionRule): boolean =>
  expected.action === actual.action &&
  expected.resource === actual.resource &&
  expected.effect === actual.effect

const prefixMatches = (
  rules: ReadonlyArray<PermissionRule>,
  prefix: ReadonlyArray<BuiltinRule>,
): boolean => {
  if (rules.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    const expected = prefix[index]
    const actual = rules[index]
    if ("matches" in expected) {
      if (!expected.matches(actual)) return false
    } else if (!ruleEquals(expected, actual)) {
      return false
    }
  }
  return true
}

export const supportsCanonicalRules = (version: string): boolean =>
  version === SUPPORTED_OPENCODE_VERSION || version.startsWith(`${SUPPORTED_OPENCODE_VERSION}+`)

/**
 * Return only rules the user/plugins appended after the known OpenCode built-in
 * prefix. On an unsupported version or a prefix mismatch, return []: canonical
 * auto-allow is disabled, and the normal ask fallback remains.
 */
export const explicitAgentRules = (
  agentID: string | undefined,
  rules: ReadonlyArray<PermissionRule>,
  appVersion: string,
): PermissionRule[] => {
  if (!supportsCanonicalRules(appVersion)) return []
  const safe = sanitizeRules(rules)
  const prefix = BUILTIN_PROFILES[agentID ?? ""] ?? BASE_RULES
  if (!prefixMatches(safe, prefix)) return []
  return safe.slice(prefix.length)
}

export interface ResolvePermissionInput {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly effect: PermissionEffect
  readonly target: PermissionTarget
  readonly agentID?: string
  readonly appVersion: string
  readonly agentRules: ReadonlyArray<PermissionRule>
  readonly sessionRules: ReadonlyArray<PermissionRule>
}

const explicitLegacyRules = (rules: ReadonlyArray<PermissionRule>): PermissionRule[] =>
  rules.filter((rule) => !isCatchAll(rule))

/**
 * Final Antigravity permission effect. Built-in allows never auto-approve;
 * built-in denies are enforced by OpenCode's pre-hook configured-deny path.
 * Only explicit user canonical/legacy rules can allow.
 */
export const resolvePermission = (input: ResolvePermissionInput): PermissionEffect => {
  const agentRules = sanitizeRules(input.agentRules)
  const sessionRules = sanitizeRules(input.sessionRules)
  const canonicalEnabled = !input.action.startsWith("antigravity.")
  const canonicalRules = canonicalEnabled
    ? [
        ...explicitAgentRules(input.agentID, agentRules, input.appVersion),
        ...sessionRules,
      ].filter((rule) => !isCatchAll(rule))
    : []
  const legacyRules = explicitLegacyRules([...agentRules, ...sessionRules])

  const canonical = canonicalEnabled
    ? resolveExplicitRules(canonicalRules, input.action, input.resources, {
        shell: input.action === "shell",
        aliases: true,
        inputEffect: input.effect,
      })
    : undefined
  const legacy = resolveExplicitRules(
    legacyRules,
    input.target.legacyAction,
    input.target.legacyResources,
    { shell: false, aliases: false, inputEffect: "allow" },
  )

  if (canonical === "deny" || legacy === "deny") return "deny"
  if (canonical === "ask" || legacy === "ask") return "ask"
  if (input.target.forceAsk) return "ask"
  if (canonical === "allow" || legacy === "allow") return "allow"
  if (input.target.autoAllowThink && input.action === "antigravity.think") return "allow"
  return "ask"
}

export interface EvaluatePermissionInput {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly effect: PermissionEffect
  readonly metadata?: unknown
  readonly sessionID: string
  readonly agentID?: string
  readonly appVersion: string
  readonly agentRules: ReadonlyArray<PermissionRule>
  readonly sessionRules: ReadonlyArray<PermissionRule>
  readonly pending?: PermissionTarget
}

/**
 * Apply marker/registry identification and resolve one permission event.
 * Returns undefined when the event is not an Antigravity permission request.
 */
export const evaluateAntigravityPermission = (
  input: EvaluatePermissionInput,
): PermissionEffect | undefined => {
  const marker = readAntigravityMarker(input.metadata)
  const markerPresent = hasAntigravityMarker(input.metadata)
  const namespaced = input.action.startsWith("antigravity.")

  if (input.effect === "deny") return "deny"
  if (markerPresent && !marker && !input.pending) return "ask"
  if (!marker && !input.pending && !namespaced) return undefined
  if (!marker && !input.pending) {
    return resolveLegacyOnly(input.action, input.resources, input.agentRules, input.sessionRules)
  }

  const target = input.pending ?? targetFromMarker(marker!, input.metadata, input.resources)
  return resolvePermission({
    action: input.action,
    resources: input.resources,
    effect: input.effect,
    target,
    agentID: input.agentID,
    appVersion: input.appVersion,
    agentRules: input.agentRules,
    sessionRules: input.sessionRules,
  })
}

/** Resolve a namespaced action with no marker/registry metadata. */
export const resolveLegacyOnly = (
  action: string,
  resources: ReadonlyArray<string>,
  agentRules: ReadonlyArray<PermissionRule>,
  sessionRules: ReadonlyArray<PermissionRule>,
): PermissionEffect => {
  const rules = explicitLegacyRules([
    ...sanitizeRules(agentRules),
    ...sanitizeRules(sessionRules),
  ])
  const effect = resolveExplicitRules(rules, action, resources, {
    shell: false,
    aliases: false,
    inputEffect: "allow",
  })
  return effect ?? "ask"
}

export const readAntigravityMarker = (metadata: unknown): AntigravityMarker | undefined => {
  if (!isRecord(metadata)) return undefined
  const marker = metadata.antigravity
  if (!isRecord(marker)) return undefined
  if (marker.provider !== MARKER_PROVIDER || marker.version !== MARKER_VERSION) return undefined
  const requestID = stringValue(marker.requestID)
  const legacyAction = stringValue(marker.legacyAction)
  if (!requestID || !legacyAction) return undefined
  return {
    provider: MARKER_PROVIDER,
    version: MARKER_VERSION,
    requestID,
    ...(stringValue(marker.kind) ? { kind: stringValue(marker.kind) } : {}),
    ...(stringValue(marker.tool) ? { tool: stringValue(marker.tool) } : {}),
    legacyAction,
    autoAllowThink: marker.autoAllowThink === true,
    forceAsk: marker.forceAsk === true,
  }
}

export const hasAntigravityMarker = (metadata: unknown): boolean =>
  isRecord(metadata) && hasOwn(metadata, "antigravity")

/** Rebuild a target from metadata when the in-flight registry entry is gone. */
export const targetFromMarker = (
  marker: AntigravityMarker,
  metadata: unknown,
  fallbackResources: ReadonlyArray<string>,
): PermissionTarget => {
  const record = isRecord(metadata) ? metadata : {}
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((value): value is string => typeof value === "string" && value.length > 0)
    : []
  const title = stringValue(record.title)
  const legacyResources =
    paths.length > 0 ? paths.slice(0, MAX_PATHS) : title ? [truncate(title, MAX_RESOURCE_BYTES)] : [...fallbackResources]
  return {
    requestID: marker.requestID,
    legacyAction: marker.legacyAction,
    legacyResources,
    autoAllowThink: marker.autoAllowThink,
    forceAsk: marker.forceAsk,
  }
}
