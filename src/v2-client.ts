import type { PluginClient } from "./types"
import { runCommand } from "./process"

/** V2 plugin context subset Ensemble needs (structural, mock-friendly). */
export interface V2Context {
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>
    prompt(input: Record<string, unknown>): Promise<unknown>
    switchAgent(input: Record<string, unknown>): Promise<unknown>
    interrupt(input: Record<string, unknown>): Promise<unknown>
    get(input: Record<string, unknown>): Promise<unknown>
    context(input: Record<string, unknown>): Promise<unknown[]>
    active(): Promise<Record<string, { type: string }>>
  }
  worktree: {
    create(input: Record<string, unknown>): Promise<{ directory: string }>
    remove(input: Record<string, unknown>): Promise<unknown>
    list(): Promise<Array<{ directory: string }>>
    refresh(): Promise<unknown>
  }
}

/** Prefix marking a workspace id that is really a local directory (see below). */
const DIR_WORKSPACE_PREFIX = "v2dir:"

/** Injectable shell lookups (default to git; overridden in tests). */
export interface V2ClientDeps {
  /** Current branch checked out in a directory, or null when unknown. */
  gitBranch?: (directory: string) => Promise<string | null>
  /** Worktree directory currently on a branch, or null when none. */
  gitDir?: (branch: string) => Promise<string | null>
}

/** Current branch in a directory via git. */
async function gitBranchDefault(directory: string): Promise<string | null> {
  try {
    const result = await runCommand(["git", "branch", "--show-current"], { cwd: directory })
    const branch = result.stdout.trim()
    return result.exitCode === 0 && branch ? branch : null
  } catch {
    return null
  }
}

/**
 * Adapt a V2 plugin context to the shared PluginClient interface so all 14
 * team tools run unchanged on V2 (DRY: one adapter, zero logic forks).
 *
 * Mapping notes (all spike-verified live against v2.0.3 unless marked OQ):
 * - create: V1 `permission` rules become V2 `{action, resource, effect}`;
 *   `workspaceID`/`directory` nest under `location`.
 * - promptAsync: queue delivery wakes idle sessions; `agent` is applied via
 *   switchAgent first (V2 binds the agent at create/admission, and the shared
 *   create signature has no agent slot — only spawn passes one).
 * - abort: interrupt. status: derived from the active set — sessions absent
 *   from it read as idle, which matches the shutdown default (team-shutdown
 *   treats unknown as idle). OQ-V2-status: if V2 ever reports non-running
 *   states here, extend the mapping.
 * - tui.*: no-op. Toasts and session-select move to the CLI (`./tui`) plugin
 *   in a later phase — the server plugin must not depend on a TUI.
 * - worktree.create: V2 reports only the directory, so the branch is read
 *   back via git (falls back to the requested name). OQ-V2-branch.
 * - worktree.list: V2 entries carry directory only; name is the basename
 *   (recovery filters on the `ensemble-` prefix — a non-matching dir is
 *   skipped, never wrongly deleted). reset has no production callers and
 *   maps to refresh. OQ-V2-wtname.
 * - workspace.*: V2 ctx has no workspace domain (workspaces are
 *   provider-based). create bridges a branch to its worktree directory and
 *   returns a `v2dir:<dir>` id; session.create routes that id to
 *   location.directory, preserving worktree isolation with zero tool
 *   changes. list returns [] and remove resolves — the DB workspace_id
 *   column stays the source of truth and is still nulled by cleanup.
 */
export function createV2Client(ctx: V2Context, deps: V2ClientDeps = {}): PluginClient {
  const gitBranch = deps.gitBranch ?? gitBranchDefault
  return {
    session: {
      create: async (options) => {
        const input: Record<string, unknown> = { title: options.title }
        if (options.parentID) input["parentID"] = options.parentID
        if (options.permission) {
          input["permissions"] = options.permission.map((rule) => ({
            action: rule.permission,
            resource: rule.pattern,
            effect: rule.action,
          }))
        }
        if (options.workspaceID ?? options.directory) {
          if (options.workspaceID?.startsWith(DIR_WORKSPACE_PREFIX)) {
            input["location"] = {
              directory: options.workspaceID.slice(DIR_WORKSPACE_PREFIX.length),
            }
          } else {
            input["location"] = {
              ...(options.directory ? { directory: options.directory } : {}),
              ...(options.workspaceID ? { workspaceID: options.workspaceID } : {}),
            }
          }
        }
        const created = await ctx.session.create(input)
        return { data: { id: created.id } }
      },
      promptAsync: async (options) => {
        if (options.agent) {
          await ctx.session.switchAgent({ sessionID: options.sessionID, agent: options.agent })
        }
        const text = options.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        return ctx.session.prompt({ sessionID: options.sessionID, text, delivery: "queue" })
      },
      abort: async (options) => ctx.session.interrupt({ sessionID: options.sessionID }),
      status: async () => {
        const active = await ctx.session.active()
        const data: Record<string, { type: string }> = {}
        for (const sessionID of Object.keys(active)) data[sessionID] = { type: "busy" }
        return { data }
      },
      messages: async (options) => {
        const messages = await ctx.session.context({ sessionID: options.sessionID })
        return { data: messages as Array<{ info: unknown; parts: unknown[] }> }
      },
      get: async (options) => {
        const data = await ctx.session.get({ sessionID: options.sessionID })
        return { data }
      },
    },
    tui: {
      showToast: async () => undefined,
      selectSession: async () => undefined,
    },
    worktree: {
      create: async (options) => {
        const name = (options.worktreeCreateInput as { name?: string } | undefined)?.name ?? "ensemble-worktree"
        const created = await ctx.worktree.create({ name })
        const branch = (await gitBranch(created.directory)) ?? name
        return { data: { name, branch, directory: created.directory } }
      },
      remove: async (options) => {
        const directory = (options.worktreeRemoveInput as { directory: string }).directory
        return ctx.worktree.remove({ directory, force: false })
      },
      list: async () => {
        const entries = await ctx.worktree.list()
        return {
          data: entries.map((entry) => ({
            name: entry.directory.split("/").pop() ?? entry.directory,
            branch: "",
            directory: entry.directory,
          })),
        }
      },
      reset: async () => ctx.worktree.refresh(),
    },
    workspace: {
      create: async (options) => {
        const branch = (options as { branch?: string }).branch ?? ""
        const directory = await deps.gitDir?.(branch)
        if (!directory) throw new Error(`V2 workspace bridge: no worktree found on branch "${branch}"`)
        return {
          data: {
            id: `${DIR_WORKSPACE_PREFIX}${directory}`,
            type: "local",
            branch,
            directory,
            projectID: "",
          },
        }
      },
      remove: async () => undefined,
      list: async () => ({
        data: [] as Array<{
          id: string
          type: string
          branch: string | null
          directory: string | null
          projectID: string
        }>,
      }),
    },
  } as PluginClient
}
