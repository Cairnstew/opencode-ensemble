import { describe, expect, test } from "bun:test"
import { EnsembleRpc, emitMemberEvent, emitNoticeEvent } from "../src/v2-rpc"

describe("v2-rpc bridge (issue #36)", () => {
  test("contract carries the ensemble id, events, and methods", () => {
    expect(EnsembleRpc.id).toBe("ensemble")
    expect(Object.keys(EnsembleRpc.events ?? {}).sort()).toEqual(["member", "notice", "view"])
    expect(Object.keys(EnsembleRpc.methods ?? {}).sort()).toEqual(["summary", "teamContext"])
  })

  test("emitMemberEvent publishes member transitions", async () => {
    const emitted: Array<{ name: string; data: unknown }> = []
    const registration = {
      events: {
        emit: async (name: string, data: unknown) => {
          emitted.push({ name, data })
        },
      },
    }
    await emitMemberEvent(registration as never, {
      memberName: "alice",
      teamId: "team1",
      from: "busy",
      to: "ready",
    })
    expect(emitted).toEqual([
      { name: "member", data: { memberName: "alice", teamId: "team1", from: "busy", to: "ready" } },
    ])
  })

  test("emitNoticeEvent publishes toast payloads", async () => {
    const emitted: Array<{ name: string; data: unknown }> = []
    const registration = {
      events: {
        emit: async (name: string, data: unknown) => {
          emitted.push({ name, data })
        },
      },
    }
    await emitNoticeEvent(registration as never, {
      title: "Team",
      message: "alice finished",
      variant: "success",
    })
    expect(emitted).toEqual([
      { name: "notice", data: { title: "Team", message: "alice finished", variant: "success" } },
    ])
  })
})
