import type { Database } from "./db"
import { createDb, getDbPath } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import { MemberRegistry as MemberRegistryImpl, DescendantTracker as DescendantTrackerImpl, PendingPurgeApprovals } from "./state"
import { dispatchV2Event, type V2EventLike } from "./v2-events"
import type { V2Context } from "./v2-client"
import { createV2Client } from "./v2-client"
import { registerV2Tools } from "./v2-tools"
import type { ToolDeps } from "./types"
import { ProgressTracker } from "./progress"
import { checkToolIsolation } from "./hooks"
import { findTeamBySession } from "./types"
import { loadConfig } from "./config"
import { TokenBucket } from "./rate-limit"
import { ActivityBuffer, recordFromToolBefore, recordFromToolAfter } from "./activity"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { startDashboard, type DashboardServer } from "./dashboard"
import { isWorktreeInstance } from "./util"
import { log } from "./log"

/** V2 setup context subset (structural, mock-friendly). */
export interface V2SetupContext {
  location: { directory: string }
  options: Record<string, unknown>
  session: V2Context["session"] & {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
  worktree: V2Context["worktree"]
  event: {
    subscribe(opts?: { signal?: AbortSignal }): AsyncIterable<V2EventLike>
  }
  tool: {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
    transform(cb: (editor: never) => void): Promise<{ dispose(): Promise<void> }>
  }
  shell: {
    hook(name: string, cb: (event: never) => unknown): Promise<{ dispose(): Promise<void> }>
  }
}

/** Options for setupEnsemble. */
export interface SetupOptions {
  /** SQLite path. Defaults to the global ensemble.db. */
  dbPath?: string
  /** Dashboard port. Defaults to config; 0 disables. */
  dashboardPort?: number
}

/** Live handle for a V2 ensemble instance. */
export interface EnsembleHandle {
  db: Database
  registry: MemberRegistry
  tracker: DescendantTracker
  /** Dispatch one event (used by the live subscription loop; tests call directly). */
  dispatch(event: V2EventLike): Promise<void>
  /** Stop the event loop and release resources. */
  dispose(): Promise<void>
}

/**
 * Initialize Ensemble on a V2 plugin context: database, registries, event
 * subscription, tool hooks, session hooks, and shell env. Tool registration
 * lands in the next slice.
 */
export async function setupEnsemble(
  ctx: V2SetupContext,
  options: SetupOptions = {},
): Promise<EnsembleHandle> {
  const db = createDb(options.dbPath ?? getDbPath())
  const config = loadConfig(ctx.location.directory)
  const registry: MemberRegistry = new MemberRegistryImpl()
  const tracker: DescendantTracker = new DescendantTrackerImpl()
  const purgeApprovals = new PendingPurgeApprovals()
  const activityBuffer = new ActivityBuffer()
  const progressTracker = new ProgressTracker()
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: 2,
    refillIntervalMs: 1000,
  })
  const controller = new AbortController()

  const dispatch = async (event: V2EventLike): Promise<void> => {
    // State transition only. Wake/nudge glue (needs the full ToolDeps +
    // adapted client) lands with the notification slice.
    dispatchV2Event(db, registry, tracker, event)
  }

  // Live event loop — fire-and-forget; dispose() aborts it.
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await dispatch(event)
      }
    } catch {
      // Aborted on dispose or stream error — nothing to report.
    }
  })()

  await ctx.tool.hook("execute.before", (raw) => {
    const input = raw as unknown as { tool: string; sessionID: string }
    checkToolIsolation(registry, tracker, input.tool, input.sessionID, db)
    if (input.tool.startsWith("team_")) {
      if (!rateLimiter.tryConsume()) {
        return rateLimiter.waitForToken().then(() => undefined)
      }
    }
    recordFromToolBefore({ sessionID: input.sessionID, tool: input.tool }, registry, activityBuffer)
  })

  await ctx.tool.hook("execute.after", (raw) => {
    const event = raw as unknown as {
      tool: string
      sessionID: string
      input: unknown
      status: string
    }
    if (event.tool === "question") {
      purgeApprovals.recordQuestionAnswer(event.sessionID, "", event.input)
    }
    recordFromToolAfter(
      { sessionID: event.sessionID, tool: event.tool },
      {},
      registry,
      activityBuffer,
    )
  })

  await ctx.session.hook("context", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
    }
    if (!event.sessionID) return
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo) return
    const prompt =
      teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId, config)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown")
    log(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`)
    event.system.push({ type: "text", text: prompt })
  })

  await ctx.session.hook("compaction", (raw) => {
    const event = raw as unknown as {
      sessionID: string
      system: Array<{ type: string; text: string }>
    }
    if (!event.sessionID) return
    const teamInfo = findTeamBySession(db, registry, event.sessionID)
    if (!teamInfo) return
    const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName)
    event.system.push({ type: "text", text: context })
  })

  // OQ-V2-shell: the V2 shell hook carries no sessionID, so per-session
  // ENSEMBLE_* env cannot be scoped. Registered as a placeholder until the
  // API gains session scope — team tools and prompts carry identity instead.
  await ctx.shell.hook("create.before", () => undefined)

  const client = createV2Client(ctx)
  const deps: ToolDeps = {
    db,
    registry,
    tracker,
    purgeApprovals,
    client,
    directory: ctx.location.directory,
    config,
    progressTracker,
  }
  await registerV2Tools(ctx.tool, deps)

  // Dashboard mirrors V1: main instance only, skipped when port is 0.
  let dashboard: DashboardServer | null = null
  const dashboardPort = options.dashboardPort ?? config.dashboardPort
  if (dashboardPort !== 0 && !isWorktreeInstance(ctx.location.directory)) {
    dashboard = await startDashboard(db, dashboardPort, { activityBuffer, client }).catch((err) => {
      log(`init:dashboard:failed err=${err instanceof Error ? err.message : String(err)}`)
      return null
    })
  }

  return {
    db,
    registry,
    tracker,
    dispatch,
    dispose: async () => {
      controller.abort()
      dashboard?.stop()
    },
  }
}
