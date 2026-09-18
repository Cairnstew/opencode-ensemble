import { describe, expect, test } from "bun:test"
import { buildArgHint, detectArgFumble, enrichToolError } from "../src/tool-arg-hint"

describe("detectArgFumble (issue #39)", () => {
  test("returns the alias a weak model used instead of the canonical param", () => {
    expect(detectArgFumble("shell", { cmd: "git remote -v", description: "check" })).toBe("cmd")
  })

  test("supports the other documented shell aliases", () => {
    expect(detectArgFumble("shell", { bash: "ls" })).toBe("bash")
    expect(detectArgFumble("shell", { script: "ls" })).toBe("script")
  })

  test("returns null when the canonical param is present", () => {
    expect(detectArgFumble("shell", { command: "ls" })).toBeNull()
  })

  test("returns null when both canonical and alias are present", () => {
    // No fumble to fix — the call would validate as-is.
    expect(detectArgFumble("shell", { command: "ls", cmd: "ls" })).toBeNull()
  })

  test("returns null when the alias is not a non-empty string", () => {
    expect(detectArgFumble("shell", { cmd: 42 })).toBeNull()
    expect(detectArgFumble("shell", { cmd: "" })).toBeNull()
    expect(detectArgFumble("shell", { cmd: null })).toBeNull()
  })

  test("returns null for non-object input", () => {
    expect(detectArgFumble("shell", "git remote -v")).toBeNull()
    expect(detectArgFumble("shell", null)).toBeNull()
    expect(detectArgFumble("shell", undefined)).toBeNull()
    expect(detectArgFumble("shell", ["git remote -v"])).toBeNull()
  })

  test("returns null for tools with no alias table entry", () => {
    expect(detectArgFumble("read", { cmd: "x" })).toBeNull()
    expect(detectArgFumble("team_message", { cmd: "x" })).toBeNull()
  })
})

describe("buildArgHint (issue #39)", () => {
  test("names the tool, the wrong param, and the correct param", () => {
    const hint = buildArgHint("shell", { cmd: "git remote -v" })
    expect(hint).toContain('"shell"')
    expect(hint).toContain('"cmd"')
    expect(hint).toContain('"command"')
  })

  test("returns null for every shape detectArgFumble rejects", () => {
    expect(buildArgHint("shell", { command: "ls" })).toBeNull()
    expect(buildArgHint("shell", "git remote -v")).toBeNull()
    expect(buildArgHint("read", { cmd: "x" })).toBeNull()
  })
})

describe("enrichToolError (issue #39)", () => {
  test("appends the hint to the original validation message, preserving it", () => {
    const original = 'Invalid arguments for tool "shell":\n- command: Missing key'
    const error = { message: original }
    const fired = enrichToolError("shell", error, { cmd: "git remote -v", description: "check" })
    expect(fired).toBe(true)
    expect(error.message).toContain(original)
    expect(error.message).toContain('"cmd"')
    expect(error.message).toContain('"command"')
  })

  test("mutates real Error instances (V2 Tool.Error extends globalThis.Error)", () => {
    const error = new Error('Invalid arguments for tool "shell":\n- command: Missing key')
    expect(enrichToolError("shell", error, { cmd: "git remote -v" })).toBe(true)
    expect(error.message).toContain('"command"')
  })

  test("does not touch the message when there is no fumble", () => {
    const original = 'Invalid arguments for tool "shell":\n- command: Missing key'
    const error = { message: original }
    expect(enrichToolError("shell", error, { command: "ls" })).toBe(false)
    expect(error.message).toBe(original)
  })

  test("returns false without crashing when the error has no message", () => {
    expect(enrichToolError("shell", {}, { cmd: "ls" })).toBe(false)
    expect(enrichToolError("shell", { message: 123 }, { cmd: "ls" })).toBe(false)
  })
})
