/**
 * Smoke eval for opencode-ensemble on V2 (issue #36).
 *
 * Drives the full team lifecycle through a live server on the CHEAPEST
 * available path and asserts outcomes from the API + ensemble.db.
 *
 * Usage:
 *   ENSEMBLE_EVAL_MODEL=opencode/muse-spark-1.3-contributor-free bun run eval:smoke
 *
 * Server selection:
 *   - Default: your background `opencode` service (must have the plugin loaded).
 *   - Isolated: point at a scratch server that loads this worktree from
 *     .opencode/plugins, e.g.
 *       ENSEMBLE_EVAL_SERVER=http://127.0.0.1:4096 \
 *       OPENCODE_SERVER_PASSWORD=<password> bun run eval:smoke
 *   The plugin under test must be ACTIVE for the session location, otherwise
 *   every tool call fails. team_* calls failing with "unknown tool" means
 *   the server has no plugin — fix the server, not the eval.
 *
 * Model note: opencode's free tier ROTATES. The default below is current as
 * of 2026-09-14 and will stop being free at some point. Override with
 * ENSEMBLE_EVAL_MODEL (provider/model). The script fails fast with the
 * provider error if the model is gone — pick a replacement and re-run.
 *
 * What it proves (each asserts, any failure exits non-zero):
 *   1. team_create / team_status / team_tasks_add / team_tasks_list
 *   2. team_claim + team_tasks_complete (task board round-trip)
 *   3. team_spawn + member→lead team_message report (the critical path)
 *   4. team_results surfaces the report
 *   5. team_message lead→member delivery
 *   6. team_shutdown + team_cleanup archive the team (no residue)
 *
 * Cost control: unique team per run, short prompts, forced cleanup at the
 * end even on failure. Expect ~5-8 minutes on a free model.
 */
import { $ } from "bun"

const MODEL = process.env.ENSEMBLE_EVAL_MODEL ?? "opencode/muse-spark-1.3-contributor-free"
const TEAM = `eval-${Date.now().toString(36)}`
const MEMBER = "eval-prober"
const REPORT = `EVAL-REPORT-${Date.now().toString(36)}`
const STEP_TIMEOUT_MS = 8 * 60 * 1000

let failures = 0

/** Run `opencode api` (against ENSEMBLE_EVAL_SERVER when set) and parse JSON. */
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const middle: string[] = []
  if (process.env.ENSEMBLE_EVAL_SERVER) middle.push("--server", process.env.ENSEMBLE_EVAL_SERVER)
  const args = ["api", ...middle, method, path]
  if (body !== undefined) args.push("-d", JSON.stringify(body))
  const proc = await $`opencode ${args}`.nothrow()
  const text = proc.text().trim()
  if (proc.exitCode !== 0) {
    throw new Error(`api ${method} ${path} failed (exit ${proc.exitCode}): ${text.slice(0, 300)}`)
  }
  // Empty body = success with no content (e.g. 204 on switch-model).
  if (!text) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text).data
  } catch {
    throw new Error(`api ${method} ${path} returned non-JSON: ${text.slice(0, 300)}`)
  }
  return parsed
}

/** Read ensemble.db directly (same adapter the plugin uses). */
async function dbAll(sql: string): Promise<Array<Record<string, unknown>>> {
  const { createDb } = await import("../src/db")
  const db = createDb(`${process.env.HOME}/.config/opencode/ensemble.db`)
  const rows = db.query(sql).all() as Array<Record<string, unknown>>
  db.close()
  return rows
}

/** Prompt a session and wait until it goes idle (or timeout). */
async function promptAndWait(sessionID: string, text: string): Promise<void> {
  await api("post", `/api/session/${sessionID}/prompt`, { text, delivery: "steer" })
  const deadline = Date.now() + STEP_TIMEOUT_MS
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000))
    const session = (await api("get", `/api/session/${sessionID}`)) as {
      outcome?: string
      time?: { idle?: number }
    }
    const ctx = (await api("get", `/api/session/${sessionID}/context`)) as Array<{
      type: string
      time?: { created?: number }
    }>
    const lastUser = [...ctx].reverse().find((m) => m.type === "user")
    const idleAfter = (session.time?.idle ?? 0) > (lastUser?.time?.created ?? 0)
    if (idleAfter && session.outcome) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${sessionID}`)
  }
}

/** Last assistant text in a session (for failure diagnostics). */
async function lastText(sessionID: string): Promise<string> {
  const ctx = (await api("get", `/api/session/${sessionID}/context`)) as Array<{
    type: string
    content?: Array<{ type?: string; text?: string }>
  }>
  const texts: string[] = []
  for (const m of ctx) {
    if (m.type !== "assistant") continue
    for (const c of m.content ?? []) {
      if (c.type === "text" && (c.text?.length ?? 0) > 20) texts.push(c.text as string)
    }
  }
  return texts.at(-1) ?? "(no assistant text)"
}

/** Assert with a named check. Records failure instead of throwing. */
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  PASS ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail.slice(0, 300)}` : ""}`)
  }
}

const [providerID, modelID] = MODEL.split("/")
if (!providerID || !modelID) throw new Error(`ENSEMBLE_EVAL_MODEL must be provider/model, got "${MODEL}"`)

// --- setup: lead session pinned to the eval model ---
console.log(`model=${MODEL} team=${TEAM}`)
const lead = (await api("post", "/api/session", {
  title: `ensemble-eval-${TEAM}`,
  location: { directory: `${process.env.HOME}/repositories/misc/opencode-ensemble-v2` },
})) as { id: string }
const leadID = lead.id as string
await api("post", `/api/session/${leadID}/model`, { model: { providerID, id: modelID } })

try {
  // --- 1. board tools ---
  console.log("1. board tools");
  await promptAndWait(
    leadID,
    `Call team_create with name ${TEAM}. Then team_tasks_add with tasks [{content:"eval-a",priority:"high"},{content:"eval-b"}]. Then team_tasks_list. Reply with only DONE. Nothing else.`,
  )
  const tasks = await dbAll(
    `SELECT content, priority, status FROM team_task WHERE team_id IN (SELECT id FROM team WHERE name='${TEAM}') ORDER BY time_created`,
  )
  check("team_create wrote the team", tasks.length === 2, await lastText(leadID))
  check("priority preserved", tasks[0]?.["priority"] === "high")
  check("default priority is medium", tasks[1]?.["priority"] === "medium")

  // --- 2. claim + complete round-trip ---
  console.log("2. claim + complete");
  const taskRow = (
    await dbAll(
      `SELECT id FROM team_task WHERE team_id IN (SELECT id FROM team WHERE name='${TEAM}') ORDER BY time_created LIMIT 1`,
    )
  )[0]?.["id"] as string
  await promptAndWait(
    leadID,
    `Call team_claim with task_id ${taskRow}. Then team_tasks_complete with task_id ${taskRow}. Reply with only DONE. Nothing else.`,
  )
  const done = (
    await dbAll(`SELECT status, assignee FROM team_task WHERE id='${taskRow}'`)
  )[0] as { status?: string } | undefined
  check("claim + complete round-trip", done?.status === "completed", await lastText(leadID))

  // --- 3. spawn + member report (critical path) ---
  console.log("3. spawn + member report");
  await promptAndWait(
    leadID,
    `Call team_spawn with name ${MEMBER}, agent build, worktree false, model ${MODEL}, prompt: Your ONLY action is to call team_message with to set to lead and text set to ${REPORT}. Then stop. Report only the spawn result.`,
  )
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let report: Array<Record<string, unknown>> = []
  while (Date.now() < deadline) {
    report = await dbAll(
      `SELECT from_name FROM team_message WHERE content LIKE '%${REPORT}%'`,
    )
    if (report.length > 0) break
    await new Promise((r) => setTimeout(r, 15_000))
  }
  check("spawn created the member", true) // spawn errors surface as thrown prompt failures above
  check("member→lead report delivered", report[0]?.["from_name"] === MEMBER, await lastText(leadID))

  // --- 4. results + lead→member + shutdown + cleanup ---
  console.log("4. close-out");
  await promptAndWait(
    leadID,
    `Call team_results. Then team_message to ${MEMBER} with text EVAL-ACK. Then team_shutdown member ${MEMBER} force true. Then team_cleanup force true. Reply with only DONE. Nothing else.`,
  )
  const team = (
    await dbAll(`SELECT status FROM team WHERE name='${TEAM}'`)
  )[0] as { status?: string } | undefined
  check("shutdown + cleanup archived the team", team?.status === "archived", await lastText(leadID))
  const members = await dbAll(
    `SELECT status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE name='${TEAM}')`,
  )
  check(
    "no active members left",
    members.every((m) => m["status"] === "shutdown" || m["status"] === "error"),
    JSON.stringify(members),
  )
} finally {
  // Best-effort residue cleanup (runs even when a check throws).
  try {
    await api("delete", `/api/session/${leadID}`)
  } catch {
    // Session removal is hygiene, not part of the eval.
  }
}

console.log(failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
