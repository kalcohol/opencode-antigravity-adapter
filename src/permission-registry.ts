// Process-global in-flight permission requests.
//
// The metadata marker is the primary way the evaluate hook recognizes an
// Antigravity request. The registry is a marker-loss fallback and also keeps
// the old-shape legacy resources for compatibility. It intentionally lives on
// globalThis so multiple plugin module instances / reloads share it.

export interface PendingPermission {
  readonly requestID: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly legacyAction: string
  readonly legacyResources: readonly string[]
  readonly autoAllowThink: boolean
  readonly forceAsk: boolean
  readonly createdAt: number
  readonly expiresAt: number
}

const REGISTRY_SYMBOL = Symbol.for("opencode.antigravity.permissionRegistry")
const TTL_MS = 60_000
const MAX_ENTRIES = 128
const RESOURCE_KEY_SEPARATOR = "\u0000"

type Registry = Map<string, PendingPermission>

const registry: Registry =
  ((globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL] as Registry | undefined) ??
  (() => {
    const map = new Map<string, PendingPermission>()
    ;(globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL] = map
    return map
  })()

const prune = (now = Date.now()): void => {
  for (const [key, entry] of registry) {
    if (entry.expiresAt <= now) registry.delete(key)
  }
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next().value
    if (oldest === undefined) break
    registry.delete(oldest)
  }
}

export interface RegisterPermissionInput {
  readonly requestID: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly legacyAction: string
  readonly legacyResources: readonly string[]
  readonly autoAllowThink?: boolean
  readonly forceAsk?: boolean
}

export const registerPermission = (input: RegisterPermissionInput): PendingPermission => {
  prune()
  const now = Date.now()
  const entry: PendingPermission = {
    requestID: input.requestID,
    sessionID: input.sessionID,
    action: input.action,
    resources: [...input.resources],
    legacyAction: input.legacyAction,
    legacyResources: [...input.legacyResources],
    autoAllowThink: input.autoAllowThink === true,
    forceAsk: input.forceAsk === true,
    createdAt: now,
    expiresAt: now + TTL_MS,
  }
  registry.set(entry.requestID, entry)
  prune()
  return entry
}

export const unregisterPermission = (requestID: string): void => {
  registry.delete(requestID)
}

const resourceKey = (resources: readonly string[]): string =>
  resources.join(RESOURCE_KEY_SEPARATOR)

export interface FindPermissionInput {
  readonly requestID?: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
}

/**
 * Look up by requestID first, then by the in-flight key. The fallback is only
 * used when metadata was lost; it deliberately requires the exact same action
 * and resources.
 */
export const findPendingPermission = (input: FindPermissionInput): PendingPermission | undefined => {
  prune()
  if (input.requestID) {
    const exact = registry.get(input.requestID)
    if (exact && exact.expiresAt > Date.now()) return exact
  }
  const wanted = resourceKey(input.resources)
  for (const entry of registry.values()) {
    if (entry.expiresAt <= Date.now()) continue
    if (entry.sessionID !== input.sessionID) continue
    if (entry.action !== input.action) continue
    if (resourceKey(entry.resources) !== wanted) continue
    return entry
  }
  return undefined
}

/** Test helper; production code never needs to clear the process-global map. */
export const clearPermissionRegistry = (): void => {
  registry.clear()
}
