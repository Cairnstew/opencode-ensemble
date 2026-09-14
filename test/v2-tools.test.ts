import { describe, expect, test } from "bun:test"
import { createDb } from "../src/db"
import { MemberRegistry, DescendantTracker, PendingPurgeApprovals } from "../src/state"
import { DEFAULT_CONFIG } from "../src/config"
import { ProgressTracker } from "../src/progress"
import { createV2Client } from "../src/v2-client"
import { registerV2Tools, normalizePriority, type V2ToolDef } from "../src/v2-tools"
import type { ToolDeps } from "../src/types"

const TOOL_NAMES = [
  "team_create",
  "team_spawn",
  "team_message",
  "team_broadcast",
  "team_tasks_list",
  "team_tasks_add",
  "team_tasks_complete",
  "team_claim",
  "team_results",
  "team_shutdown",
  "team_cleanup",
  "team_merge",
  "team_status",
  "team_view",
]

function mockDeps() {
  const client = createV2Client({
    session: {
      create: async () => ({ id: "ses_new" }),
      prompt: async () => ({ id: "msg_1" }),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ id: "ses_x" }),
      context: async () => [],
      active: async () => ({}),
    },
    permission: {
      rules: async () => undefined,
    },
    worktree: {
      create: async () => ({ directory: "/wt/x" }),
      remove: async () => undefined,
      list: async () => [],
      refresh: async () => undefined,
    },
  })
  const deps: ToolDeps = {
    db: createDb(":memory:"),
    registry: new MemberRegistry(),
    tracker: new DescendantTracker(),
    purgeApprovals: new PendingPurgeApprovals(),
    client,
    directory: "/tmp/v2-tools-test",
    config: { ...DEFAULT_CONFIG },
    progressTracker: new ProgressTracker(),
  }
  return deps
}

function mockToolDomain() {
  const defs: V2ToolDef[] = []
  return {
    defs,
    domain: {
      transform: async (cb: (editor: { add(def: V2ToolDef): void }) => void) => {
        cb({ add: (def) => defs.push(def) })
        return { dispose: async () => undefined }
      },
    },
  }
}

async function run(defs: V2ToolDef[], name: string, input: unknown, sessionID: string) {
  const def = defs.find((d) => d.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def.execute(input, { sessionID })
}

describe("v2-tools (issue #36, DRY: same execute fns as V1)", () => {
  test("all 14 tools register with descriptions and input schemas", async () => {
    const { defs, domain } = mockToolDomain()
    await registerV2Tools(domain, mockDeps())
    expect(defs.map((d) => d.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.input).toMatchObject({ type: "object" })
    }
  })

  test("create → tasks_add (no priority) → list defaults priority to medium", async () => {
    const { defs, domain } = mockToolDomain()
    const deps = mockDeps()
    await registerV2Tools(domain, deps)
    const created = await run(defs, "team_create", { name: "alpha" }, "ses_lead")
    expect(created.content).toContain("alpha")
    await run(
      defs,
      "team_tasks_add",
      { tasks: [{ content: "do work" }] },
      "ses_lead",
    )
    const list = await run(defs, "team_tasks_list", {}, "ses_lead")
    expect(list.content).toContain("do work")
    const taskRow = deps.db.query("SELECT priority FROM team_task").get() as { priority: string }
    expect(taskRow.priority).toBe("medium")
    const status = await run(defs, "team_status", {}, "ses_lead")
    expect(status.content).toContain("alpha")
  })

  test("plan approval for an unspawned recipient is rejected", async () => {
    const { defs, domain } = mockToolDomain()
    await registerV2Tools(domain, mockDeps())
    await run(defs, "team_create", { name: "alpha" }, "ses_lead")
    let error: unknown = null
    try {
      await run(defs, "team_message", { to: "ghost", text: "hi", approve: true }, "ses_lead")
    } catch (err) {
      error = err
    }
    expect(String(error)).toContain("ghost")
  })

  test("priority enum is declared and invalid values are rejected", async () => {
    const { defs, domain } = mockToolDomain()
    await registerV2Tools(domain, mockDeps())
    const add = defs.find((d) => d.name === "team_tasks_add")
    const tasks = (add?.input.properties as Record<string, unknown>)["tasks"] as {
      items: { properties: { priority: unknown } }
    }
    expect(tasks.items.properties.priority).toMatchObject({ enum: ["high", "medium", "low"] })
    expect(normalizePriority(undefined)).toBe("medium")
    expect(normalizePriority("high")).toBe("high")
    await run(defs, "team_create", { name: "alpha" }, "ses_lead")
    let error: unknown = null
    try {
      await run(defs, "team_tasks_add", { tasks: [{ content: "x", priority: "urgent" }] }, "ses_lead")
    } catch (err) {
      error = err
    }
    expect(String(error)).toContain('Invalid priority "urgent"')
  })
})
