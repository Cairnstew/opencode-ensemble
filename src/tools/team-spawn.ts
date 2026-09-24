import { statSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { ToolDeps, PermissionRule } from "../types"
import { validateMemberName } from "../util"
import { requireLead } from "./shared"
import { claimTask } from "./team-claim"
import { notifyLead } from "../notify"
import { releaseMemberTasks } from "../tasks"
import { parseModelId } from "../member-model"
import { log } from "../log"
import type { EnsembleConfig, ResolvedSpace } from "../config"
import { getTeamResourceParts, teamWorktreeName } from "./merge-helper"
import { runCommand } from "../process"
import { checkWorktreeDirty } from "./shared"

/** Tracks consecutive spawn failures per team for circuit breaker. */
export const spawnFailures = new Map<string, { count: number; lastError: string }>()

/**
 * Resolve which model to use for a spawned agent.
 * Priority: explicit arg > modelsByAgent > rotation/random > defaultModel > undefined.
 */
export function resolveModel(
  explicitModel: string | undefined,
  agentType: string,
  teamMemberCount: number,
  config: Required<EnsembleConfig>,
): string | undefined {
  if (explicitModel) return explicitModel
  if (config.modelsByAgent[agentType]) return config.modelsByAgent[agentType]
  if (config.modelAssignment === "rotate" && config.modelPool.length > 0) {
    return config.modelPool[teamMemberCount % config.modelPool.length]
  }
  if (config.modelAssignment === "random" && config.modelPool.length > 0) {
    return config.modelPool[Math.floor(Math.random() * config.modelPool.length)]
  }
  if (config.defaultModel) return config.defaultModel
  return undefined
}

/** Timeout for worktree.create and session.create to prevent hanging on git lock contention. */
function getSpawnTimeout(): number {
  return Number(process.env.SPAWN_TIMEOUT_MS) || 120_000
}

/** Returns true if the directory is already inside an OpenCode worktree. */
function isWorktreeDirectory(dir: string): boolean {
  return dir.includes("/opencode/worktree/")
}

/** Race a promise against a timeout. Throws if the timeout fires first. Cleans up timer on resolution. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

/**
 * Validate a space directory at use-time: exists, is a directory, and is a git repo.
 * The spike confirmed session.create({ directory }) silently falls back to the global
 * project on bad paths — this is the loud guard that prevents silent mis-scoping.
 * Called immediately before session.create, after config-load-time validation.
 */
function validateSpaceDirectory(spaceName: string, spaceDir: string): void {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(spaceDir)
  } catch {
    throw new Error(`Space "${spaceName}" directory no longer exists: ${spaceDir}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`Space "${spaceName}" path is not a directory: ${spaceDir}`)
  }
  try {
    statSync(path.join(spaceDir, ".git"))
  } catch {
    throw new Error(`Space "${spaceName}" is not a git repository (no .git): ${spaceDir}`)
  }
}

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 * By default, each teammate gets their own git worktree for file isolation.
 * Pass worktree: false for read-only agents that don't need isolation.
 * Pass space: "<name>" to spawn into a predetermined agent space (separate repo).
 * Pass plan_approval: true to require the teammate to send a plan before writing.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: { name: string; agent?: string | null; prompt: string; model?: string; claim_task?: string; worktree?: boolean; plan_approval?: boolean; space?: string },
  sessionId: string,
): Promise<string> {
  const nameError = validateMemberName(args.name)
  if (nameError) throw new Error(nameError)

  const teamInfo = requireLead(deps, sessionId)

  // Circuit breaker — stop retrying after 3 consecutive failures
  const failures = spawnFailures.get(teamInfo.teamId)
  if (failures && failures.count >= 3) {
    throw new Error(`Spawn circuit breaker tripped for team "${teamInfo.teamName}": 3 consecutive failures. Last error: ${failures.lastError}. Investigate before retrying — the circuit breaker resets on the next successful spawn.`)
  }

  // Check duplicate name
  const existing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.name)
  if (existing) throw new Error(`Teammate "${args.name}" already exists in team "${teamInfo.teamName}"`)

  // Resolve space if specified
  let spaceName: string | null = null
  let spaceDir: string | null = null
  let spaceConfig: ResolvedSpace | null = null

  if (args.space) {
    // Mutually exclusive with worktree
    if (args.worktree !== false) {
      throw new Error(
        `Cannot use both "space" and "worktree" on the same spawn. ` +
        `Space-based spawns operate in an independent repository, not a worktree. ` +
        `Set worktree: false when using space.`
      )
    }

    const spaces = deps.config.spaces
    if (!spaces || !spaces[args.space]) {
      const validNames = spaces ? Object.keys(spaces) : []
      throw new Error(
        `Unknown agent space "${args.space}". ` +
        `Valid spaces: ${validNames.length > 0 ? validNames.join(", ") : "(none configured)"}`
      )
    }

    spaceName = args.space
    const raw = spaces[args.space]!
    // Resolve the union type: string shorthand → { path: string }, or pass through object
    spaceConfig = typeof raw === "string" ? { path: raw } : { ...raw }
    spaceDir = spaceConfig.path!
    log(`spawn:space name=${args.name} space=${spaceName} dir=${spaceDir}`)
  }

  // Normalize agent: the tool schema defaults to "build", but Zod's .default()
  // only fires on undefined — an explicit null slips through and would violate
  // the team_member.agent NOT NULL constraint (issue #28).
  // Space config's agent field is the fallback when no explicit arg is provided.
  const agent = args.agent ?? spaceConfig?.agent ?? "build"

  const isReadOnly = agent === "plan" || agent === "explore"
  const useWorktree = !spaceDir && args.worktree !== false && !isReadOnly && !isWorktreeDirectory(deps.directory)
  const usePlanApproval = args.plan_approval === true

  log(`spawn:start name=${args.name} agent=${agent} worktree=${useWorktree} space=${spaceName ?? "none"}`)

  // Create worktree if enabled (only when not using a space)
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null

  if (useWorktree) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
    const worktreeName = teamWorktreeName(resource.projectName, resource.teamName, resource.teamId, args.name)
    try {
      log(`spawn:worktree:start name=${args.name}`)
      const result = await withTimeout(
        deps.client.worktree.create({ worktreeCreateInput: { name: worktreeName } }),
        getSpawnTimeout(), `worktree.create for "${args.name}"`
      )
      if (result.data) {
        worktreeDir = result.data.directory
        worktreeBranch = result.data.branch
      }
      log(`spawn:worktree:done name=${args.name} dir=${worktreeDir}`)
    } catch (err) {
      log(`spawn:worktree:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      try {
        await deps.client.tui.showToast({
          title: "Team",
          message: `Worktree creation failed for ${args.name}, using shared directory`,
          variant: "warning",
          duration: 4000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  // Create workspace from worktree branch — links session to worktree directory.
  // OQ-workspace: assumes workspace.create({ branch }) auto-links to the worktree at that branch.
  let workspaceId: string | null = null
  if (worktreeDir && worktreeBranch) {
    try {
      log(`spawn:workspace:start name=${args.name}`)
      const wsResult = await withTimeout(
        deps.client.workspace.create({ branch: worktreeBranch }),
        getSpawnTimeout(), `workspace.create for "${args.name}"`
      )
      if (wsResult.data) {
        workspaceId = wsResult.data.id
      }
      log(`spawn:workspace:done name=${args.name} id=${workspaceId}`)
    } catch (err) {
      log(`spawn:workspace:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      // Non-fatal — prompt-based CWD instruction is the fallback
    }
  }

  // Permission rules on session.create are the hard gate (server-enforced).
  // For read-only agents, deny write tools and explicitly allow team tools.
  // For all agents with worktrees or spaces, allowlist the working path for edit/bash.
  // The 9 member-accessible tools per the documented tool table: the 6 worker
  // tools plus the 3 inspection tools (team_results/team_status/team_view —
  // any member). Caught live 2026-09-15: teammates could not read each
  // other's messages because team_results was missing from this list.
  const TEAM_TOOLS = [
    "team_message",
    "team_broadcast",
    "team_tasks_list",
    "team_tasks_add",
    "team_tasks_complete",
    "team_claim",
    "team_results",
    "team_status",
    "team_view",
  ] as const
  const permission: PermissionRule[] = []

  if (spaceDir) {
    // Space: allow edit only within the space directory (confirmed by spike:
    // permission matching is pure pattern-based, no project relationship needed)
    permission.push(
      { permission: "edit", pattern: `${spaceDir}/**`, action: "allow" },
    )
    if (!isReadOnly) {
      permission.push({ permission: "bash", pattern: "*", action: "allow" })
    }
  } else if (worktreeDir) {
    permission.push(
      { permission: "edit", pattern: `${worktreeDir}/**`, action: "allow" },
    )
    if (!isReadOnly) {
      permission.push({ permission: "bash", pattern: "*", action: "allow" })
    }
  }

  if (isReadOnly) {
    permission.push(
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    )
  }

  permission.push(
    ...TEAM_TOOLS.map(t => ({ permission: t, pattern: "*", action: "allow" as const })),
  )

  // Code Mode is the invocation path for plugin tools on V2 — without this,
  // read-only agents (deny-all policies like explore's) cannot reach any
  // team tool. Safe: nested calls inside execute still enforce their own
  // permissions, so explore stays read-only.
  permission.push({ permission: "execute", pattern: "*", action: "allow" })

  // For url-based spaces, ensure the clone exists and is up to date before
  // validating the directory. Clone-on-demand: first spawn clones, subsequent
  // spawns fetch + fast-forward if safe.
  if (spaceConfig?.url && spaceDir) {
    const fs = await import("node:fs")
    const cloneExists = fs.existsSync(path.join(spaceDir, ".git"))

    if (!cloneExists) {
      // First spawn: clone the repository
      log(`spawn:clone:start name=${args.name} space=${spaceName} url=${spaceConfig.url}`)
      // Ensure the parent directory exists
      const parentDir = path.dirname(spaceDir)
      try { mkdirSync(parentDir, { recursive: true }) } catch { /* may already exist */ }

      const cloneResult = await runCommand(
        ["git", "clone", spaceConfig.url, spaceDir],
        { cwd: parentDir },
      )
      if (cloneResult.exitCode !== 0) {
        const stderr = cloneResult.stderr.trim()
        throw new Error(
          `Failed to clone agent space "${spaceName}" from ${spaceConfig.url}: ${stderr || `exit code ${cloneResult.exitCode}`}. ` +
          `Check that the URL is correct and that network access and authentication are available in the plugin process environment.`
        )
      }
      log(`spawn:clone:done name=${args.name} space=${spaceName}`)
    } else {
      // Subsequent spawns: fetch and attempt fast-forward
      log(`spawn:fetch:start name=${args.name} space=${spaceName}`)
      const fetchResult = await runCommand(["git", "-C", spaceDir, "fetch", "origin"])
      if (fetchResult.exitCode !== 0) {
        const stderr = fetchResult.stderr.trim()
        log(`spawn:fetch:failed name=${args.name} space=${spaceName} err=${stderr}`)
        // Non-fatal: proceed with spawn using the clone as-is, notify the lead
        notifyLead(
          deps.client, deps.db, teamInfo.teamId,
          `Space "${spaceName}" fetch failed: ${stderr}. Proceeding with the existing clone at ${spaceDir}.`,
        )
      } else {
        // Determine default branch
        let defaultBranch = ""
        const symRef = await runCommand(
          ["git", "-C", spaceDir, "symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        )
        if (symRef.exitCode === 0 && symRef.stdout.trim()) {
          defaultBranch = symRef.stdout.trim().replace(/^origin\//, "")
        } else {
          const headResult = await runCommand(
            ["git", "-C", spaceDir, "rev-parse", "--abbrev-ref", "HEAD"],
          )
          if (headResult.exitCode === 0 && headResult.stdout.trim()) {
            defaultBranch = headResult.stdout.trim()
          }
        }

        if (defaultBranch) {
          // Check if working tree is dirty
          const dirty = await checkWorktreeDirty(spaceDir)
          if (dirty) {
            log(`spawn:fetch:dirty name=${args.name} space=${spaceName}`)
            notifyLead(
              deps.client, deps.db, teamInfo.teamId,
              `Space "${spaceName}" has uncommitted changes at ${spaceDir} — skipping fast-forward. Proceeding with the existing clone as-is.`,
            )
          } else {
            // Check if fast-forward is possible
            const isAncestor = await runCommand(
              ["git", "-C", spaceDir, "merge-base", "--is-ancestor", "HEAD", `origin/${defaultBranch}`],
            )
            if (isAncestor.exitCode === 0) {
              // Safe to fast-forward
              const ffResult = await runCommand(
                ["git", "-C", spaceDir, "merge", "--ff-only", `origin/${defaultBranch}`],
              )
              if (ffResult.exitCode !== 0) {
                log(`spawn:fetch:ff-failed name=${args.name} space=${spaceName} err=${ffResult.stderr.trim()}`)
                notifyLead(
                  deps.client, deps.db, teamInfo.teamId,
                  `Space "${spaceName}" fast-forward failed: ${ffResult.stderr.trim()}. Proceeding with the existing clone.`,
                )
              } else {
                log(`spawn:fetch:ff-done name=${args.name} space=${spaceName}`)
              }
            } else {
              // Diverged or local is ahead — do not touch the clone
              log(`spawn:fetch:diverged name=${args.name} space=${spaceName}`)
              notifyLead(
                deps.client, deps.db, teamInfo.teamId,
                `Space "${spaceName}" has diverged from origin at ${spaceDir} — needs manual attention. Proceeding with the existing clone.`,
              )
            }
          }
        }
      }
    }
  }

  // Validate space directory immediately before session.create.
  // The spike confirmed session.create({ directory }) silently falls back to
  // the global project on bad paths — this is the loud guard.
  if (spaceDir) {
    validateSpaceDirectory(spaceName!, spaceDir)
  }

  // Create child session — bind to workspace if available (server-enforced CWD isolation),
  // or to space directory for predetermined agent spaces.
  // Falls back to no workspace binding if workspace.create failed.
  let childSessionId: string | undefined
  try {
    log(`spawn:session:start name=${args.name}`)
    const createResult = await withTimeout(
      deps.client.session.create({
        parentID: sessionId,
        title: `${args.name} (@${agent} teammate)`,
        permission,
        ...(workspaceId ? { workspaceID: workspaceId } : {}),
        ...(spaceDir ? { directory: spaceDir } : {}),
      }),
      getSpawnTimeout(), `session.create for "${args.name}"`
    )
    childSessionId = createResult.data?.id
    log(`spawn:session:done name=${args.name} sessionId=${childSessionId}`)
  } catch (err) {
    log(`spawn:session:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
    // Track failure for circuit breaker
    const errMsg = err instanceof Error ? err.message : String(err)
    const prev = spawnFailures.get(teamInfo.teamId)
    spawnFailures.set(teamInfo.teamId, { count: (prev?.count ?? 0) + 1, lastError: errMsg })
    // Rollback workspace and worktree if session creation failed
    // (Space directories are config-managed — never removed on rollback)
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error(`Failed to create session for teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!childSessionId) {
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error("Failed to create teammate session")
  }

  // Register in DB
  const planApproval = usePlanApproval ? "pending" : "none"
  const now = Date.now()
  // Resolve model before DB insert so the stored value matches what promptAsync uses
  const memberCount = (deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(teamInfo.teamId) as { c: number }).c
  const resolvedModel = resolveModel(args.model, agent, memberCount, deps.config)
  if (resolvedModel) log(`spawn:model name=${args.name} model=${resolvedModel}`)

  deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, workspace_id, plan_approval, space_name, space_dir, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamInfo.teamId, args.name, childSessionId, agent, resolvedModel ?? null, args.prompt, worktreeDir, worktreeBranch, workspaceId, planApproval, spaceName, spaceDir, now, now]
  )

  // Row is inserted as 'busy' directly -- there is no ready->busy status-event
  // transition for a fresh spawn, so the watchdog's usual hook point never fires.
  // Record the baseline here instead, or a member stalled on its first action
  // is invisible to checkStalled() until its first step-finish event lands.
  deps.progressTracker.recordBusyStart(childSessionId)

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Auto-claim a task for this teammate when claim_task is provided (issue #27).
  // Claims atomically so a task is never double-assigned when the lead hands out
  // more tasks than there are teammates. Read-only agents cannot claim tasks.
  let claimedTaskContent: string | null = null
  let claimWarning: string | null = null
  if (args.claim_task && !isReadOnly) {
    try {
      claimedTaskContent = claimTask(deps.db, teamInfo.teamId, args.claim_task, args.name)
      log(`spawn:claim:ok name=${args.name} task=${args.claim_task}`)
    } catch (err) {
      claimWarning = err instanceof Error ? err.message : String(err)
      log(`spawn:claim:failed name=${args.name} task=${args.claim_task} err=${claimWarning}`)
    }
  }

  // Build teammate context message
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${agent}".`,
  ]

  // Show other teammates so this agent knows who to message
  const otherMembers = deps.db.query(
    "SELECT name FROM team_member WHERE team_id = ? AND name != ? AND status NOT IN ('shutdown', 'error')"
  ).all(teamInfo.teamId, args.name) as Array<{ name: string }>
  if (otherMembers.length > 0) {
    context.push(`Other teammates: ${otherMembers.map(m => m.name).join(", ")}`)
  }

  // Space-specific context: independent repository, own git history
  if (spaceDir && spaceName) {
    context.push(
      `You are working in a predetermined agent space "${spaceName}".`,
      `Your working directory is: ${spaceDir}`,
      `This is an independent git repository — manage its git history directly.`,
      `Your changes are isolated from the main project and from other teammates.`,
    )
    if (spaceConfig?.description) {
      context.push(`Space description: ${spaceConfig.description}`)
    }
  } else if (worktreeBranch && worktreeDir && !workspaceId) {
    // Workspace binding failed — fallback to prompt-based CWD instruction
    context.push(
      `You are working on branch "${worktreeBranch}" in your own worktree at: ${worktreeDir}`,
      `Your changes are isolated from other teammates.`,
      `IMPORTANT: All file operations and shell commands MUST target your worktree directory.`,
      `Before running shell commands, cd to: ${worktreeDir}`,
    )
  } else if (worktreeBranch && worktreeDir) {
    // Workspace binding active — server handles CWD
    context.push(
      `You are working on branch "${worktreeBranch}" in your own isolated worktree.`,
      `Your changes are isolated from other teammates.`,
    )
  } else if (worktreeBranch) {
    context.push(`You are working on branch "${worktreeBranch}". Your changes are isolated from other teammates.`)
  }

  // Plan approval mode — teammate must send plan before writing
  if (usePlanApproval) {
    context.push(
      "",
      "IMPORTANT: You are in PLAN MODE.",
      "Read and explore the codebase, then send your implementation plan to the lead via team_message.",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation.",
    )
  }

  if (isReadOnly) {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
    )
  } else {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
      "- team_tasks_add: add tasks to the shared board",
      "- team_tasks_complete: mark a task complete on the shared board",
      "- team_claim: claim a pending task from the shared board",
    )
  }

  // Collaboration guidance for peer-to-peer communication
  if (otherMembers.length > 0) {
    context.push(
      "",
      "Collaboration:",
      "- Check team_tasks_list to see what other teammates are working on.",
      "- If you need information another teammate has, message them directly via team_message.",
      "- If you discover something relevant to another teammate's task, share it with them.",
      "- Use team_broadcast for updates that affect the whole team.",
      "- Keep peer messages focused and actionable — coordinate, don't chat.",
    )
  }

  context.push("", "When you finish your task:")
  if (!isReadOnly && (worktreeBranch || spaceDir)) {
    context.push(`1. Commit your changes: git add -A && git commit -m "your summary"`)
    context.push("2. If you claimed a task, mark it complete using team_tasks_complete.")
    context.push(
      "3. Send ONE message to the lead using team_message with this format:",
    )
  } else if (!isReadOnly) {
    context.push("1. If you claimed a task, mark it complete using team_tasks_complete.")
    context.push(
      "2. Send ONE message to the lead using team_message with this format:",
    )
  } else {
    context.push(
      "1. Send ONE message to the lead using team_message with this format:",
    )
  }
  context.push(
    "<task-result>",
    "<status>completed or failed</status>",
    "<summary>One-line summary of what you did</summary>",
    "<details>Full findings or changes made</details>",
  )
  if (worktreeBranch) {
    context.push(`<branch>${worktreeBranch}</branch>`)
  }
  if (spaceDir) {
    context.push(`<space>${spaceName}</space>`)
  }
  context.push("</task-result>")
  const lastStep = !isReadOnly && (worktreeBranch || spaceDir) ? "4" : !isReadOnly ? "3" : "2"
  context.push(
    `${lastStep}. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.`,
    "",
    "If you are blocked:",
    "- Send ONE message to the lead via team_message describing the specific blocker.",
    "- Do NOT attempt workarounds or make assumptions. Wait for the lead's response.",
    "",
    "Your plain text output is NOT visible to the team. You MUST use team_message to communicate.",
  )

  context.push(
    "",
    "Your task:",
    args.prompt,
  )

  if (claimedTaskContent) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`)
  }

  const contextStr = context.join("\n")

  // Model was already resolved before DB insert — just parse for promptAsync
  const modelParam = resolvedModel ? parseModelId(resolvedModel) : undefined
  if (resolvedModel && !modelParam) {
    log(`spawn:model:invalid name=${args.name} model=${resolvedModel} — expected "provider/model" format, falling back to default`)
  }

  // Fire-and-forget: send prompt to teammate session.
  log(`spawn:promptAsync:fire name=${args.name} sessionId=${childSessionId}`)
  deps.client.session.promptAsync({
    sessionID: childSessionId,
    parts: [{ type: "text", text: contextStr }],
    agent,
    ...(modelParam ? { model: modelParam } : {}),
  }).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err)
    log(`spawn:promptAsync:failed name=${args.name} err=${errMsg} — rolling back`)
    try {
      deps.db.run("DELETE FROM team_member WHERE team_id = ? AND session_id = ?", [teamInfo.teamId, childSessionId])
      deps.registry.unregister(childSessionId)
      // Release any task auto-claimed for this teammate so it returns to the pool.
      if (claimedTaskContent) {
        deps.db.run(
          "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND assignee = ? AND status = 'in_progress'",
          [Date.now(), args.claim_task, args.name]
        )
      }
      deps.client.session.abort({ sessionID: childSessionId }).catch(() => { /* best effort */ })
      if (workspaceId) {
        deps.client.workspace.remove({ id: workspaceId }).catch(() => { /* best effort */ })
      }
      if (worktreeDir) {
        deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }).catch(() => { /* best effort */ })
      }
      // Space directories are config-managed — never removed on rollback
      const modelInfo = resolvedModel ? ` (model: ${resolvedModel})` : ""
      deps.client.tui.showToast({
        title: "Team",
        message: `Teammate "${args.name}" failed to start${modelInfo}: ${errMsg}`,
        variant: "error",
        duration: 8000,
      }).catch(() => { /* TUI may not be available */ })
      notifyLead(
        deps.client,
        deps.db,
        teamInfo.teamId,
        `Teammate "${args.name}" failed to start and was removed${modelInfo}. Error: ${errMsg}. You may retry the spawn.`,
      )
    } catch { /* rollback failed — watchdog will clean up stale member */ }
  })

  const spaceInfo = spaceDir ? ` (space: ${spaceName})` : ""
  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : ""
  const planInfo = usePlanApproval ? " [plan mode — will send plan for approval]" : ""
  const claimInfo = claimedTaskContent
    ? ` (claimed task: ${args.claim_task})`
    : claimWarning ? ` (could not claim task: ${claimWarning})` : ""
  // Reset circuit breaker on success
  spawnFailures.delete(teamInfo.teamId)
  log(`spawn:done name=${args.name} sessionId=${childSessionId}`)
  return `Teammate "${args.name}" spawned (agent: ${agent})${spaceInfo}${branchInfo}${planInfo}${claimInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
}
