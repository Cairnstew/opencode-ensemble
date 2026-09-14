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
  }
  return { calls, ctx }
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
})
