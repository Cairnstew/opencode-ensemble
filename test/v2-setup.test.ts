import { describe, expect, test } from "bun:test"
import { setupEnsemble, type V2SetupContext } from "../src/v2-setup"

/** Mock V2 setup context: hook registry + programmable event intake. */
function mockSetupCtx() {
  const hooks: Record<string, Array<(event: never) => unknown>> = {}
  const hook = (domain: string) => async (_name: string, cb: (event: never) => unknown) => {
    ;(hooks[domain] ??= []).push(cb)
    return { dispose: async () => undefined }
  }
  const ctx = {
    location: { directory: "/tmp/v2-setup-test" },
    options: {},
    session: {
      create: async () => ({ id: "ses_new" }),
      prompt: async () => ({ id: "msg_1" }),
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ id: "ses_x" }),
      context: async () => [],
      active: async () => ({}),
      hook: hook("session"),
    },
    worktree: {
      create: async () => ({ directory: "/wt/x" }),
      remove: async () => undefined,
      list: async () => [],
      refresh: async () => undefined,
    },
    event: {
      subscribe: (_opts?: unknown) => {
        void _opts
        async function* stream(): AsyncGenerator<never> {
          // Tests drive events via handle.dispatch; the live loop drains this.
        }
        return stream()
      },
    },
    tool: {
      hook: hook("tool"),
      transform: async (_cb: (editor: never) => void) => ({ dispose: async () => undefined }),
    },
    shell: { hook: hook("shell") },
  }
  return { ctx: ctx as unknown as V2SetupContext, hooks }
}

function seedLeadAndMember(handle: Awaited<ReturnType<typeof setupEnsemble>>) {
  const now = Date.now()
  handle.db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    ["team1", "alpha", "ses_lead", now, now],
  )
  handle.db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
    ["team1", "alice", "ses_alice", now, now],
  )
  handle.registry.register("team1", "alice", "ses_alice")
}

describe("v2-setup (issue #36)", () => {
  test("dispatched status events flow to member state", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    await handle.dispatch({ type: "session.status", data: { sessionID: "ses_alice", status: "idle" } })
    const row = handle.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as {
      status: string
    }
    expect(row.status).toBe("ready")
    await handle.dispose()
  })

  test("tool execute.before blocks team tools for sub-agents", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    handle.tracker.track("ses_child", "ses_alice")
    const before = hooks["tool"]?.[0]
    expect(before).toBeDefined()
    let blocked: unknown = null
    try {
      await before?.({
        tool: "team_message",
        sessionID: "ses_child",
        input: { to: "lead", text: "hi" },
      } as never)
    } catch (err) {
      blocked = err
    }
    expect(String(blocked)).toContain("sub-agents")
    await handle.dispose()
  })

  test("shell hook is registered (per-session env unavailable on V2 — see OQ-V2-shell)", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const shellHook = hooks["shell"]?.[0]
    expect(shellHook).toBeDefined()
    const event = { sessionID: "ses_lead", env: {} as Record<string, string | undefined> }
    await shellHook?.(event as never)
    expect(event.env["ENSEMBLE_TEAM"]).toBeUndefined()
    await handle.dispose()
  })

  test("session context hook appends team system prompt for team sessions", async () => {
    const { ctx, hooks } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 0 })
    seedLeadAndMember(handle)
    const sessionHooks = hooks["session"] ?? []
    expect(sessionHooks.length).toBeGreaterThan(0)
    const contextHook = sessionHooks[0]
    const event = { sessionID: "ses_lead", system: [] as Array<{ type: string; text: string }> }
    await contextHook?.(event as never)
    expect(event.system.length).toBe(1)
    expect(event.system[0]?.text).toContain("alpha")
    await handle.dispose()
  })

  test("dashboard serves team state on the configured port", async () => {
    const { ctx } = mockSetupCtx()
    const handle = await setupEnsemble(ctx, { dbPath: ":memory:", dashboardPort: 47999 })
    seedLeadAndMember(handle)
    const res = await fetch("http://localhost:47999/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ensemble?: boolean }
    expect(body.ensemble).toBe(true)
    const teams = (await (await fetch("http://localhost:47999/api/state")).json()) as {
      teams?: unknown[]
    }
    expect(teams.teams?.length).toBe(1)
    await handle.dispose()
  })
})
