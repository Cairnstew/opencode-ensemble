import { describe, expect, test } from "bun:test"
import {
  createTeammateSession,
  deliverPrompt,
  interruptTeammate,
  type V2SessionPort,
} from "../src/v2-session"

/** Recording mock of the V2 ctx.session subset we use. */
function mockPort() {
  const calls: Array<{ method: string; input: unknown }> = []
  const port: V2SessionPort = {
    create: async (input) => {
      calls.push({ method: "create", input })
      return { id: "ses_child123" }
    },
    prompt: async (input) => {
      calls.push({ method: "prompt", input })
      return { id: "msg_1" }
    },
    interrupt: async (input) => {
      calls.push({ method: "interrupt", input })
      return { aborted: true }
    },
  }
  return { calls, port }
}

describe("v2-session (issue #36, dual support)", () => {
  test("createTeammateSession passes title, agent, parentID and permissions", async () => {
    const { calls, port } = mockPort()
    const id = await createTeammateSession(port, {
      title: "alice (@build teammate)",
      agent: "build",
      parentID: "ses_lead123",
      permissions: [{ action: "team_message", resource: "*", effect: "allow" }],
    })
    expect(id).toBe("ses_child123")
    expect(calls[0]?.input).toMatchObject({
      title: "alice (@build teammate)",
      agent: "build",
      parentID: "ses_lead123",
      permissions: [{ action: "team_message", resource: "*", effect: "allow" }],
    })
  })

  test("createTeammateSession works without optional parentID/permissions", async () => {
    const { calls, port } = mockPort()
    await createTeammateSession(port, { title: "solo", agent: "explore" })
    expect(calls[0]?.input).toMatchObject({ title: "solo", agent: "explore" })
  })

  test("deliverPrompt sends queue delivery so idle sessions wake without stealing focus", async () => {
    const { calls, port } = mockPort()
    await deliverPrompt(port, "ses_child123", "[System: 1 new team message(s) available]")
    expect(calls[0]?.input).toMatchObject({
      sessionID: "ses_child123",
      text: "[System: 1 new team message(s) available]",
      delivery: "queue",
    })
  })

  test("interruptTeammate targets the session", async () => {
    const { calls, port } = mockPort()
    await interruptTeammate(port, "ses_child123")
    expect(calls[0]?.input).toMatchObject({ sessionID: "ses_child123" })
  })
})
