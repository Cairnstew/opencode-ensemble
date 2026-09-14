import { describe, expect, test } from "bun:test"
import tui from "../src/tui"

describe("tui companion (issue #36)", () => {
  test("default export carries the companion id and setup", () => {
    const plugin = tui as unknown as { id?: unknown; setup?: unknown }
    expect(plugin.id).toBe("ensemble.tui")
    expect(typeof plugin.setup).toBe("function")
  })
})
