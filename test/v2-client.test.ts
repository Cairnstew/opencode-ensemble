import { describe, expect, test } from "bun:test"
import { createV2Client } from "../src/v2-client"

/** Minimal mock of the V2 ctx domains Ensemble uses. Records calls. */
function mockCtx() {
  const calls: Array<{ domain: string; method: string; input: unknown }> = []
  const sessions: Record<string, { id: string; parentID?: string }> = {}
  const ctx = {
    session: {
      create: async (input: Record<string, unknown>) => {
        calls.push({ domain: "session", method: "create", input })
        const id = "ses_new123"
        sessions[id] = { id }
        return { id }
      },
      prompt: async (input: Record<string, unknown>) => {
        calls.push({ domain: "session", method: "prompt", input })
        return { id: "msg_1" }
      },
      switchAgent: async (input: Record<string, unknown>) => {
        calls.push({ domain: "session", method: "switchAgent", input })
        return undefined
      },
      switchModel: async (input: Record<string, unknown>) => {
        calls.push({ domain: "session", method: "switchModel", input })
        return undefined
      },
      interrupt: async (input: Record<string, unknown>) => {
        calls.push({ domain: "session", method: "interrupt", input })
        return { aborted: true }
      },
      get: async (input: Record<string, unknown>) => {
        calls.push({ domain: "session", method: "get", input })
        return { id: input["sessionID"] }
      },
      context: async (input: Record<string, unknown>) => {
        calls.push({ domain: "session", method: "context", input })
        return [{ id: "msg_1", type: "user" }]
      },
      active: async () => {
        calls.push({ domain: "session", method: "active", input: {} })
        return { ses_busy1: { type: "running" } }
      },
    },
    worktree: {
      create: async (input: Record<string, unknown>) => {
        calls.push({ domain: "worktree", method: "create", input })
        return { directory: "/wt/ensemble-proj-team-alice" }
      },
      remove: async (input: Record<string, unknown>) => {
        calls.push({ domain: "worktree", method: "remove", input })
        return undefined
      },
      list: async () => {
        calls.push({ domain: "worktree", method: "list", input: {} })
        return [{ directory: "/wt/ensemble-proj-team-alice" }, { directory: "/wt/other" }]
      },
      refresh: async () => {
        calls.push({ domain: "worktree", method: "refresh", input: {} })
        return undefined
      },
    },
  }
  return { calls, ctx }
}

/** Fake git branch lookup: dir → branch. */
function mockGit(map: Record<string, string | null>) {
  return async (directory: string) => map[directory] ?? null
}

describe("v2-client adapter (issue #36, DRY: reuses all tool logic)", () => {
  test("session.create maps parentID/title/permissions to V2 shape", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    const result = await client.session.create({
      parentID: "ses_lead",
      title: "alice (@build teammate)",
      permission: [{ permission: "team_message", pattern: "*", action: "allow" }],
    })
    expect(result.data?.id).toBe("ses_new123")
    expect(calls[0]?.input).toMatchObject({
      title: "alice (@build teammate)",
      parentID: "ses_lead",
      permissions: [{ action: "team_message", resource: "*", effect: "allow" }],
    })
  })

  test("session.promptAsync maps to queue-delivery prompt", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    await client.session.promptAsync({
      sessionID: "ses_child",
      parts: [{ type: "text", text: "hello" }],
      agent: "build",
    })
    expect(calls[0]).toMatchObject({
      domain: "session",
      method: "switchAgent",
      input: { sessionID: "ses_child", agent: "build" },
    })
    expect(calls[1]?.input).toMatchObject({
      sessionID: "ses_child",
      text: "hello",
      delivery: "queue",
    })
  })

  test("session.promptAsync applies the model via switchModel first", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    await client.session.promptAsync({
      sessionID: "ses_child",
      parts: [{ type: "text", text: "hello" }],
      model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
    })
    expect(calls[0]).toMatchObject({
      domain: "session",
      method: "switchModel",
      input: {
        sessionID: "ses_child",
        model: { providerID: "opencode", id: "muse-spark-1.3-contributor-free" },
      },
    })
    expect(calls[1]?.input).toMatchObject({ sessionID: "ses_child", delivery: "queue" })
  })

  test("session.abort maps to interrupt", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    await client.session.abort({ sessionID: "ses_child" })
    expect(calls[0]).toMatchObject({ domain: "session", method: "interrupt" })
  })

  test("session.status derives busy/idle from the active set", async () => {
    const { ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    const status = await client.session.status()
    expect(status.data?.["ses_busy1"]?.type).toBe("busy")
    // Absent key reads as idle — team-shutdown treats unknown as idle.
    expect(status.data?.["ses_idle1"]).toBeUndefined()
  })

  test("tui calls resolve without a server round-trip (toasts live in the CLI plugin)", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    await client.tui.showToast({ title: "Team", message: "hi" })
    await client.tui.selectSession({ sessionID: "ses_child" })
    expect(calls.length).toBe(0)
  })

  test("worktree.create discovers the branch via git (V2 reports directory only)", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never, {
      gitBranch: mockGit({ "/wt/ensemble-proj-team-alice": "ensemble-proj-team-alice" }),
    })
    const result = await client.worktree.create({ worktreeCreateInput: { name: "ensemble-proj-team-alice" } })
    expect(calls[0]?.input).toMatchObject({ name: "ensemble-proj-team-alice" })
    expect(result.data).toMatchObject({
      name: "ensemble-proj-team-alice",
      branch: "ensemble-proj-team-alice",
      directory: "/wt/ensemble-proj-team-alice",
    })
  })

  test("worktree.create falls back to the requested name when git lookup fails", async () => {
    const { ctx } = mockCtx()
    const client = createV2Client(ctx as never, { gitBranch: mockGit({}) })
    const result = await client.worktree.create({ worktreeCreateInput: { name: "ensemble-x" } })
    expect(result.data?.branch).toBe("ensemble-x")
  })

  test("worktree.remove/list/reset map to V2 remove/list/refresh", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    await client.worktree.remove({ worktreeRemoveInput: { directory: "/wt/ensemble-x" } })
    expect(calls[0]?.input).toMatchObject({ directory: "/wt/ensemble-x", force: false })
    const list = await client.worktree.list()
    expect(list.data?.[0]).toMatchObject({ directory: "/wt/ensemble-proj-team-alice" })
    await client.worktree.reset({ worktreeResetInput: { directory: "/wt/ensemble-x" } })
    expect(calls[calls.length - 1]).toMatchObject({ domain: "worktree", method: "refresh" })
  })

  test("session.create routes a v2dir workspace id to location.directory", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    await client.session.create({ title: "t", workspaceID: "v2dir:/wt/ensemble-x" })
    expect(calls[0]?.input).toMatchObject({ location: { directory: "/wt/ensemble-x" } })
  })

  test("workspace.create bridges branch to directory (no workspace domain on V2 ctx)", async () => {
    const { ctx } = mockCtx()
    const client = createV2Client(ctx as never, {
      gitDir: async (_branch: string) => "/wt/ensemble-x",
    })
    const result = await client.workspace.create({ branch: "ensemble-x" })
    expect(result.data?.id).toBe("v2dir:/wt/ensemble-x")
  })

  test("workspace.list is empty and workspace.remove resolves (DB is the source of truth)", async () => {
    const { calls, ctx } = mockCtx()
    const client = createV2Client(ctx as never)
    const list = await client.workspace.list()
    expect(list.data).toEqual([])
    await client.workspace.remove({ id: "v2dir:/wt/ensemble-x" })
    expect(calls.length).toBe(0)
  })
})
