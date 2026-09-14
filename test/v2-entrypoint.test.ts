import { describe, expect, test } from "bun:test"
import plugin from "../src/index"

/**
 * V2 entrypoint shape (issue #36).
 *
 * Spike results (verified live against opencode v2.0.3 server, 2026-09-14):
 * - session.create accepts parentID + custom permission actions (team_* allow
 *   rules stored verbatim); session list/get echoes parentID back.
 * - session.prompt({ delivery: "queue" }) on an idle session admits instantly
 *   (fire-and-forget safe, same role promptAsync played) and wakes execution.
 * - session.context replaces session.messages; returns user/assistant/idle
 *   markers. session.get exposes outcome + idle timestamps.
 * - DELETE /api/session/:id removes spike sessions (SessionNotFoundError after).
 */
describe("v2 entrypoint (issue #36)", () => {
  test("default export carries a stable V2 plugin id", () => {
    expect((plugin as { id?: unknown }).id).toBe("ensemble")
  })

  test("default export exposes a V2 setup function", () => {
    expect(typeof (plugin as { setup?: unknown }).setup).toBe("function")
  })

  test("default export retains the V1 server function for backwards compat", () => {
    expect(typeof (plugin as { server?: unknown }).server).toBe("function")
  })
})
