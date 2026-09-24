import type { ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty, countBranchCommits } from "./shared"
import type { IsDirtyFn, CommitCountFn } from "./shared"
import { getTeamResourceParts, preserveBranch, preservedBranchName } from "./merge-helper"
import type { PreserveBranchFn } from "./merge-helper"
import { releaseMemberTasks } from "../tasks"
import { notifyLead } from "../notify"
import { log } from "../log"
import { runCommand } from "../process"
import type { ResolvedSpace } from "../config"

/**
 * Check if a directory has unpushed commits relative to its upstream.
 * Unlike checkWorktreeDirty (which treats git failures as "clean"),
 * this treats any failure (including no upstream configured) as "unpushed/unknown".
 * Returns the count of unpushed commits, or -1 if the check itself failed.
 */
async function checkUnpushedCommits(dir: string): Promise<number> {
  try {
    const result = await runCommand(
      ["git", "-C", dir, "rev-list", "@{u}..HEAD", "--count"],
    )
    if (result.exitCode !== 0) return -1 // no upstream or git error
    const n = Number.parseInt(result.stdout.trim(), 10)
    return Number.isNaN(n) ? -1 : n
  } catch {
    return -1
  }
}

/**
 * Execute the team_shutdown tool. Requests a teammate to shut down.
 *
 * Before aborting, preserves the worktree branch to a safe ref so
 * session.abort() cannot destroy the agent's committed work.
 *
 * For space-based members: session.abort() has no filesystem side effect
 * on a directory-scoped session (the directory was not created by OpenCode),
 * so abort always proceeds. However, dirty/unpushed state is always reported
 * to the lead so a human knows to look.
 */
export async function executeTeamShutdown(
  deps: ToolDeps,
  args: { member: string; force?: boolean },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  preserve: PreserveBranchFn = preserveBranch,
  commitCount: CommitCountFn = countBranchCommits,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const member = deps.db.query("SELECT session_id, status, worktree_branch, worktree_dir, space_name, space_dir FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string; worktree_branch: string | null; worktree_dir: string | null; space_name: string | null; space_dir: string | null } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)
  if (member.status === "shutdown") throw new Error(`Teammate "${args.member}" is already shut down`)

  const force = args.force ?? false

  // Second call on an already-requested member → force abort
  if (member.status === "shutdown_requested") {
    if (member.space_name && member.space_dir) {
      await abortSpaceMember(deps, teamInfo.teamId, args.member, member.session_id, member.space_name, member.space_dir)
      const status = await getSpaceStatus(deps, teamInfo.teamId, args.member, member.space_name, member.space_dir, isDirty)
      return `Force shut down "${args.member}".${status}`
    }
    await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, preserve)
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    return `Force shut down "${args.member}".${status}`
  }

  // Determine if member is idle or busy
  let isIdle = false
  try {
    const statuses = await deps.client.session.status()
    const sessionStatus = statuses.data?.[member.session_id]
    isIdle = !sessionStatus || sessionStatus.type === "idle"
  } catch {
    // Status poll failed — assume busy, fall through to graceful path
  }

  if (isIdle || force) {
    if (member.space_name && member.space_dir) {
      await abortSpaceMember(deps, teamInfo.teamId, args.member, member.session_id, member.space_name, member.space_dir)
      const status = await getSpaceStatus(deps, teamInfo.teamId, args.member, member.space_name, member.space_dir, isDirty)
      return `Teammate "${args.member}" has been shut down.${status}`
    }
    await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, preserve)
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    return `Teammate "${args.member}" has been shut down.${status}`
  }

  // Busy + not force → graceful: preserve branch first (worktree) or check dirty state (space),
  // then send shutdown message.
  if (member.worktree_branch) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.member)
    const ok = await preserve(member.worktree_branch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamInfo.teamId, args.member],
      )
      log(`shutdown:branch:preserved-graceful src=${member.worktree_branch} target=${safeBranch}`)
    }
  }

  // Build the shutdown message — extended for space members with dirty/unpushed work
  let shutdownText = `[Shutdown requested]: The lead has requested you shut down. Finish your current task, send your final findings to the lead via team_message, then stop.`
  if (member.space_name && member.space_dir) {
    const dirty = await isDirty(member.space_dir).catch(() => false)
    const unpushed = await checkUnpushedCommits(member.space_dir)
    if (dirty || unpushed !== 0) {
      shutdownText = [
        `[Shutdown requested]: The lead has requested you shut down.`,
        `1. Commit your changes with a meaningful message.`,
        `2. Push to origin if an upstream is configured.`,
        `3. Send your final findings to the lead via team_message, then stop.`,
        ``,
        `IMPORTANT: Your space "${member.space_name}" has ${dirty ? "uncommitted changes" : ""}${dirty && unpushed !== 0 ? " and " : ""}${unpushed !== 0 ? `${unpushed < 0 ? "unknown (no upstream configured)" : `${unpushed} unpushed commit${unpushed !== 1 ? "s" : ""}`} ` : ""}that must be saved before shutdown.`,
      ].join("\n")
    }
  }

  try {
    deps.client.session.promptAsync({
      sessionID: member.session_id,
      parts: [{ type: "text", text: shutdownText }],
    }).catch(() => { /* fire-and-forget */ })
  } catch {
    // promptAsync failed — best effort
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown_requested', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamInfo.teamId, args.member],
  )

  return `Shutdown requested for ${args.member}. They will finish current work and shut down. Call team_shutdown with force: true to abort immediately.`
}

/**
 * Abort a space-based member. Unlike worktree members, there is no branch
 * to preserve — session.abort() has no filesystem side effect on a
 * directory-scoped session (the directory was not created by OpenCode).
 * We always proceed, but loudly report dirty/unpushed state to the lead.
 */
async function abortSpaceMember(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sessionId: string,
  spaceName: string,
  spaceDir: string,
): Promise<void> {
  // Check dirty/unpushed state before abort for reporting
  const dirty = await checkWorktreeDirty(spaceDir).catch(() => false)
  const unpushed = await checkUnpushedCommits(spaceDir)

  // Notify lead about the space state
  if (dirty || unpushed !== 0) {
    const details: string[] = []
    if (dirty) details.push("uncommitted changes")
    if (unpushed === -1) details.push("unpushed commits (no upstream configured)")
    else if (unpushed > 0) details.push(`${unpushed} unpushed commit${unpushed !== 1 ? "s" : ""}`)
    notifyLead(
      deps.client, deps.db, teamId,
      `Space "${spaceName}" (${memberName}) shut down with ${details.join(" and ")}. Check the work at: ${spaceDir}`,
    )
  }

  // Abort the session
  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch {
    // Abort failed — session may already be gone
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamId, memberName],
  )

  // Release any tasks this member was working
  const released = releaseMemberTasks(deps.db, teamId, memberName)
  if (released > 0) log(`shutdown:tasks:released name=${memberName} count=${released}`)
}

/**
 * Preserve the worktree branch, then abort the session and mark shutdown.
 * The branch is copied to ensemble/preserved/{team_id}/{name} BEFORE abort,
 * so session.abort() cannot destroy the agent's committed work.
 */
async function preserveAndAbort(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sessionId: string,
  worktreeBranch: string | null,
  preserve: PreserveBranchFn,
): Promise<void> {
  // Preserve the branch BEFORE aborting — session.abort() may delete the worktree + branch
  if (worktreeBranch && !worktreeBranch.startsWith("ensemble/preserved/")) {
    const resource = getTeamResourceParts(deps.db, teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
    const ok = await preserve(worktreeBranch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamId, memberName],
      )
      log(`shutdown:branch:preserved src=${worktreeBranch} target=${safeBranch}`)
    } else {
      log(`shutdown:branch:preserve-failed src=${worktreeBranch} target=${safeBranch}`)
    }
  }

  // Now safe to abort — the branch is preserved
  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch {
    // Abort failed — session may already be gone
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamId, memberName],
  )

  // Release any tasks this member was working — they are gone now, so their
  // in_progress work must return to the pool for another teammate (issue #27).
  const released = releaseMemberTasks(deps.db, teamId, memberName)
  if (released > 0) log(`shutdown:tasks:released name=${memberName} count=${released}`)
}

/** Build a status line describing a worktree-based teammate's work. */
async function getBranchStatus(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  worktreeDir: string | null,
  isDirty: IsDirtyFn,
  commitCount: CommitCountFn,
): Promise<string> {
  const row = deps.db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { worktree_branch: string | null } | null
  if (!row?.worktree_branch) return ""

  const branch = row.worktree_branch
  const parts: string[] = []

  const commits = await commitCount(branch, deps.directory)
  // Best-effort dirty check — worktree may already be deleted by session.abort() race
  const dirty = worktreeDir ? await isDirty(worktreeDir).catch(() => false) : false

  if (commits > 0 && dirty) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""} and has uncommitted work.`)
  } else if (commits > 0) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""}. Ready to merge.`)
  } else if (dirty) {
    parts.push(`${memberName} has uncommitted changes only — their work may be incomplete.`)
  } else if (commits < 0) {
    parts.push(`Could not determine ${memberName}'s commit status. Merge to check their work.`)
  } else {
    parts.push(`${memberName} made no changes.`)
  }

  parts.push(`Branch: ${branch}`)
  parts.push("Use team_merge to merge their work.")
  return `\n${parts.join("\n")}`
}

/**
 * Build a status line for a space-based teammate's work, reporting
 * dirty/unpushed state relative to origin.
 */
async function getSpaceStatus(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  spaceName: string,
  spaceDir: string,
  isDirty: IsDirtyFn,
): Promise<string> {
  const parts: string[] = []
  const dirty = await isDirty(spaceDir).catch(() => false)
  const unpushed = await checkUnpushedCommits(spaceDir)

  if (dirty && unpushed !== 0) {
    parts.push(`${memberName} has uncommitted changes and ${unpushed === -1 ? "unknown (no upstream)" : `${unpushed} unpushed commit${unpushed !== 1 ? "s" : ""}`} in space "${spaceName}".`)
  } else if (dirty) {
    parts.push(`${memberName} has uncommitted changes in space "${spaceName}".`)
  } else if (unpushed === -1) {
    parts.push(`${memberName}'s space "${spaceName}" has no upstream configured. Check the work at: ${spaceDir}`)
  } else if (unpushed > 0) {
    parts.push(`${memberName} has ${unpushed} unpushed commit${unpushed !== 1 ? "s" : ""} in space "${spaceName}". Push to origin to save work.`)
  } else {
    parts.push(`${memberName}'s space "${spaceName}" is clean and up to date with origin.`)
  }

  // Check for flake-input notification
  const spaceRow = deps.db.query("SELECT space_name FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { space_name: string | null } | null
  if (spaceRow?.space_name) {
    const spaces = deps.config.spaces
    const rawEntry = spaces?.[spaceRow.space_name]
    const spaceConfig: ResolvedSpace | undefined = rawEntry
      ? (typeof rawEntry === "string" ? { path: rawEntry } : rawEntry)
      : undefined

    if (spaceConfig?.flakeInput && !dirty && unpushed === 0) {
      // Clean + pushed: notify about flake input
      let shortSha = ""
      try {
        const shaResult = await runCommand(["git", "-C", spaceDir, "rev-parse", "--short", "HEAD"])
        if (shaResult.exitCode === 0) shortSha = shaResult.stdout.trim()
      } catch { /* best effort */ }

      parts.push(`Flake input "${spaceConfig.flakeInput}" should be updated. Run: nix flake lock --update-input ${spaceConfig.flakeInput}`)

      if (spaceConfig.autoUpdateFlakeInput) {
        // Auto-update the flake input
        log(`shutdown:flake:auto-update input=${spaceConfig.flakeInput}`)
        const nixResult = await runCommand(
          ["nix", "flake", "lock", "--update-input", spaceConfig.flakeInput],
          { cwd: deps.directory },
        )
        if (nixResult.exitCode !== 0) {
          const stderr = nixResult.stderr.trim()
          log(`shutdown:flake:auto-update:failed input=${spaceConfig.flakeInput} err=${stderr}`)
          notifyLead(
            deps.client, deps.db, teamId,
            `Auto-update of flake input "${spaceConfig.flakeInput}" failed: ${stderr || `exit code ${nixResult.exitCode}`}. Run manually: nix flake lock --update-input ${spaceConfig.flakeInput}`,
          )
        } else {
          log(`shutdown:flake:auto-update:done input=${spaceConfig.flakeInput}`)
          notifyLead(
            deps.client, deps.db, teamId,
            `Auto-updated flake input "${spaceConfig.flakeInput}" to ${shortSha || "latest"}. Space "${spaceRow.space_name}" (${memberName}) completed clean.`,
          )
        }
      } else {
        // Manual update required — notify the lead
        notifyLead(
          deps.client, deps.db, teamId,
          `Space "${spaceRow.space_name}" (${memberName}) completed work and pushed to origin (${shortSha || "latest"}). Run: nix flake lock --update-input ${spaceConfig.flakeInput}`,
        )
      }
    }
  }

  return parts.length > 0 ? `\n${parts.join("\n")}` : ""
}
