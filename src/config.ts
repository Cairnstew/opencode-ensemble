import { readFileSync, statSync } from "node:fs"
import path from "node:path"

/** Resolved space configuration entry. */
export interface ResolvedSpace {
  /** Local directory path (for path-based spaces, or the resolved clone location for url-based spaces). */
  path?: string
  /** Git URL for clone-on-demand. Exactly one of path/url must be set. */
  url?: string
  /** Default agent type for this space (team_spawn arg overrides if explicit). */
  agent?: string
  /** Human-readable description surfaced in tool descriptions. */
  description?: string
  /** Flake input name to update when space work is pushed. */
  flakeInput?: string
  /** Auto-run `nix flake lock --update-input` on clean+pushed completion (default: false). */
  autoUpdateFlakeInput?: boolean
}

/** Raw space entry: plain string (shorthand for { path: string }) or full object. */
export type SpaceEntry = string | ResolvedSpace

/** Plugin configuration shape. All fields optional — defaults applied. */
export interface EnsembleConfig {
  /** Auto-merge worktree branches on cleanup (default: true) */
  mergeOnCleanup?: boolean
  /** Stall detection threshold in ms (default: 180000 = 3 min, 0 to disable) */
  stallThresholdMs?: number
  /** Min steps before token-based stall check (default: 3) */
  stallMinSteps?: number
  /** Output token threshold for stall detection (default: 500) */
  stallTokenThreshold?: number
  /** Hard timeout for busy members in ms (default: 1800000 = 30 min, 0 to disable) */
  timeoutMs?: number
  /** Rate limit capacity (default: 10, 0 to disable) */
  rateLimitCapacity?: number
  /** Dashboard server port (default: 4747, 0 to disable) */
  dashboardPort?: number
  /** Max peer messages per agent per window before nudge (default: 5, 0 to disable) */
  peerMessageLimit?: number
  /** Time window for peer message rate limiting in ms (default: 300000 = 5 min) */
  peerMessageWindowMs?: number
  /** Default model for all agents (e.g. "opencode/zen-sonnet-4-6") */
  defaultModel?: string
  /** Pool of models for rotation/random assignment */
  modelPool?: string[]
  /** Map agent type to specific model e.g. {"build": "anthropic/claude-opus-4-6"} */
  modelsByAgent?: Record<string, string>
  /** How to assign models: "default" | "rotate" | "random" (default: "default") */
  modelAssignment?: "default" | "rotate" | "random"
  /** Lead asks user about model preferences before spawning (default: false) */
  promptForModels?: boolean
  /** Pre-registered agent spaces: name → path, url object, or string shorthand. */
  spaces?: Record<string, SpaceEntry>
  /** Directory for cloning url-based spaces (default: ~/.config/opencode/ensemble-spaces/) */
  spaceCloneDir?: string
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Required<EnsembleConfig> = {
  mergeOnCleanup: true,
  stallThresholdMs: 300_000,
  stallMinSteps: 5,
  stallTokenThreshold: 200,
  timeoutMs: 30 * 60 * 1000,
  rateLimitCapacity: 10,
  dashboardPort: 4747,
  peerMessageLimit: 5,
  peerMessageWindowMs: 300_000,
  defaultModel: "",
  modelPool: [],
  modelsByAgent: {},
  modelAssignment: "default",
  promptForModels: false,
  spaces: {},
  spaceCloneDir: "",
}

/**
 * Resolve a raw space entry (string shorthand or object) into a ResolvedSpace.
 * String form `{ path }` is backward-compatible shorthand.
 */
export function resolveSpace(raw: SpaceEntry): ResolvedSpace {
  if (typeof raw === "string") {
    return { path: raw }
  }
  return { ...raw }
}

/**
 * Validate a ResolvedSpace has exactly one of path/url set.
 * Returns null if valid, or an error message string.
 */
export function validateSpaceEntry(name: string, space: ResolvedSpace): string | null {
  if (space.path && space.url) {
    return `Space "${name}" has both "path" and "url" — exactly one must be set`
  }
  if (!space.path && !space.url) {
    return `Space "${name}" has neither "path" nor "url" — exactly one must be set`
  }
  if (space.url !== undefined && typeof space.url !== "string") {
    return `Space "${name}" "url" must be a string`
  }
  if (space.path !== undefined && typeof space.path !== "string") {
    return `Space "${name}" "path" must be a string`
  }
  if (space.agent !== undefined && typeof space.agent !== "string") {
    return `Space "${name}" "agent" must be a string`
  }
  if (space.description !== undefined && typeof space.description !== "string") {
    return `Space "${name}" "description" must be a string`
  }
  if (space.flakeInput !== undefined && typeof space.flakeInput !== "string") {
    return `Space "${name}" "flakeInput" must be a string`
  }
  if (space.autoUpdateFlakeInput !== undefined && typeof space.autoUpdateFlakeInput !== "boolean") {
    return `Space "${name}" "autoUpdateFlakeInput" must be a boolean`
  }
  return null
}

/** Read a JSON config file, returning an empty object on missing/invalid. */
function readConfigFile(filePath: string): Partial<EnsembleConfig> {
  try {
    const text = readFileSync(filePath, "utf-8")
    const raw = JSON.parse(text) as Record<string, unknown>
    // Validate types — only accept numbers for numeric fields, booleans for boolean fields
    const result: Partial<EnsembleConfig> = {}
    if (typeof raw.mergeOnCleanup === "boolean") result.mergeOnCleanup = raw.mergeOnCleanup
    if (typeof raw.stallThresholdMs === "number") result.stallThresholdMs = raw.stallThresholdMs
    if (typeof raw.stallMinSteps === "number") result.stallMinSteps = raw.stallMinSteps
    if (typeof raw.stallTokenThreshold === "number") result.stallTokenThreshold = raw.stallTokenThreshold
    if (typeof raw.timeoutMs === "number") result.timeoutMs = raw.timeoutMs
    if (typeof raw.rateLimitCapacity === "number") result.rateLimitCapacity = raw.rateLimitCapacity
    if (typeof raw.dashboardPort === "number") result.dashboardPort = raw.dashboardPort
    if (typeof raw.peerMessageLimit === "number") result.peerMessageLimit = raw.peerMessageLimit
    if (typeof raw.peerMessageWindowMs === "number") result.peerMessageWindowMs = raw.peerMessageWindowMs
    if (typeof raw.defaultModel === "string") result.defaultModel = raw.defaultModel
    if (Array.isArray(raw.modelPool) && raw.modelPool.every((m: unknown) => typeof m === "string")) result.modelPool = raw.modelPool as string[]
    if (typeof raw.modelsByAgent === "object" && raw.modelsByAgent !== null && !Array.isArray(raw.modelsByAgent)) {
      const valid = Object.entries(raw.modelsByAgent as Record<string, unknown>).every(([, v]) => typeof v === "string")
      if (valid) result.modelsByAgent = raw.modelsByAgent as Record<string, string>
    }
    if (typeof raw.modelAssignment === "string" && ["default", "rotate", "random"].includes(raw.modelAssignment)) result.modelAssignment = raw.modelAssignment as "default" | "rotate" | "random"
    if (typeof raw.promptForModels === "boolean") result.promptForModels = raw.promptForModels
    if (typeof raw.spaces === "object" && raw.spaces !== null && !Array.isArray(raw.spaces)) {
      const validSpaces: Record<string, SpaceEntry> = {}
      let valid = true
      for (const [k, v] of Object.entries(raw.spaces as Record<string, unknown>)) {
        if (typeof k !== "string") { valid = false; break }
        if (typeof v === "string") {
          validSpaces[k] = v
        } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          const resolved = resolveSpace(v as SpaceEntry)
          const err = validateSpaceEntry(k, resolved)
          if (err) { valid = false; console.warn(`[ensemble] ${err} — skipping`); continue }
          validSpaces[k] = resolved
        } else {
          valid = false; break
        }
      }
      if (valid) result.spaces = validSpaces
    }
    if (typeof raw.spaceCloneDir === "string") result.spaceCloneDir = raw.spaceCloneDir
    return result
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
    console.warn(`[ensemble] Invalid config at ${filePath}, using defaults`)
    return {}
  }
}

/**
 * Load plugin configuration. Merges global → project → env vars.
 * Missing files are silently skipped. Invalid JSON logs a warning.
 */
export function loadConfig(projectDir: string): Required<EnsembleConfig> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const globalPath = path.join(homeDir, ".config", "opencode", "ensemble.json")
  const projectPath = path.join(projectDir, ".opencode", "ensemble.json")

  const global = readConfigFile(globalPath)
  const project = readConfigFile(projectPath)
  const merged = { ...DEFAULT_CONFIG, ...global, ...project }

  // Env vars override everything
  const timeout = process.env.OPENCODE_ENSEMBLE_TIMEOUT
  if (timeout !== undefined) merged.timeoutMs = timeout === "0" ? 0 : (parseInt(timeout, 10) || merged.timeoutMs)

  const rateLimit = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
  if (rateLimit !== undefined) merged.rateLimitCapacity = rateLimit === "0" ? 0 : (parseInt(rateLimit, 10) || merged.rateLimitCapacity)

  const stall = process.env.STALL_THRESHOLD_MS
  if (stall !== undefined) merged.stallThresholdMs = stall === "0" ? 0 : (parseInt(stall, 10) || merged.stallThresholdMs)

  // Resolve default spaceCloneDir from home directory
  if (!merged.spaceCloneDir) {
    merged.spaceCloneDir = path.join(homeDir, ".config", "opencode", "ensemble-spaces")
  }

  // Validate space entries: normalize union type, check directory exists for path-based,
  // validate URL for url-based. Drop invalid entries with a warning.
  if (merged.spaces && Object.keys(merged.spaces).length > 0) {
    const validSpaces: Record<string, ResolvedSpace> = {}
    for (const [name, raw] of Object.entries(merged.spaces)) {
      const space = resolveSpace(raw)
      const validationErr = validateSpaceEntry(name, space)
      if (validationErr) {
        console.warn(`[ensemble] ${validationErr} — skipping`)
        continue
      }

      if (space.url) {
        // URL-based space: skip directory-exists check (clone hasn't happened yet).
        // Validate the URL is a non-empty string.
        if (!space.url.trim()) {
          console.warn(`[ensemble] Space "${name}" has an empty URL — skipping`)
          continue
        }
        // Resolve the deterministic clone path
        space.path = path.join(merged.spaceCloneDir, name)
        validSpaces[name] = space
      } else if (space.path) {
        // Path-based space: keep existing exists/isDirectory/.git checks
        try {
          const stat = statSync(space.path)
          if (!stat.isDirectory()) {
            console.warn(`[ensemble] Space "${name}" path is not a directory: ${space.path} — skipping`)
            continue
          }
          try {
            statSync(path.join(space.path, ".git"))
          } catch {
            console.warn(`[ensemble] Space "${name}" is not a git repository (no .git): ${space.path} — skipping`)
            continue
          }
          validSpaces[name] = space
        } catch {
          console.warn(`[ensemble] Space "${name}" directory does not exist: ${space.path} — skipping`)
        }
      }
    }
    merged.spaces = validSpaces
  }

  return merged
}
