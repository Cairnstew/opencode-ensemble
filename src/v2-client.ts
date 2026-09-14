import type { PluginClient } from "./types"

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
 */
export function createV2Client(ctx: V2Context): PluginClient {
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
          input["location"] = {
            ...(options.directory ? { directory: options.directory } : {}),
            ...(options.workspaceID ? { workspaceID: options.workspaceID } : {}),
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
      create: async () => {
        throw new Error("worktree.create lands with the worktree slice (issue #36 phase 3)")
      },
      remove: async () => {
        throw new Error("worktree.remove lands with the worktree slice (issue #36 phase 3)")
      },
      list: async () => {
        throw new Error("worktree.list lands with the worktree slice (issue #36 phase 3)")
      },
      reset: async () => {
        throw new Error("worktree.reset lands with the worktree slice (issue #36 phase 3)")
      },
    },
    workspace: {
      create: async () => {
        throw new Error("workspace.create lands with the worktree slice (issue #36 phase 3)")
      },
      remove: async () => undefined,
      list: async () => {
        throw new Error("workspace.list lands with the worktree slice (issue #36 phase 3)")
      },
    },
  } as PluginClient
}
