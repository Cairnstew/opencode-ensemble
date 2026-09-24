import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadConfig, resolveSpace, validateSpaceEntry, DEFAULT_CONFIG } from "../src/config"
import type { ResolvedSpace, SpaceEntry } from "../src/config"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamShutdown } from "../src/tools/team-shutdown"
import type { PreserveBranchFn, MergeBranchFn, DeleteBranchFn } from "../src/tools/merge-helper"

const noopPreserve: PreserveBranchFn = async () => true
const noopMerge: MergeBranchFn = async () => ({ ok: true })
const noopDelete: DeleteBranchFn = async () => true

describe("config — spaces union type", () => {
  let tmpDir: string
  let originalHome: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ensemble-spaces-"))
    process.env.HOME = path.join(tmpDir, "home")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  test("string shorthand space is resolved to { path: string }", () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })

    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      spaces: { "my-space": spaceDir }
    }))

    const config = loadConfig(tmpDir)
    expect(config.spaces["my-space"]).toEqual({ path: spaceDir })

    rmSync(spaceDir, { recursive: true, force: true })
  })

  test("full object space with path is accepted", () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })

    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      spaces: {
        "infra": {
          path: spaceDir,
          agent: "build",
          description: "Infrastructure code",
          flakeInput: "infra-repo"
        }
      }
    }))

    const config = loadConfig(tmpDir)
    const space = config.spaces["infra"] as ResolvedSpace
    expect(space).toBeDefined()
    expect(space.path).toBe(spaceDir)
    expect(space.agent).toBe("build")
    expect(space.description).toBe("Infrastructure code")
    expect(space.flakeInput).toBe("infra-repo")
    expect(space.url).toBeUndefined()

    rmSync(spaceDir, { recursive: true, force: true })
  })

  test("url space skips directory-exists check and resolves path", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      spaces: {
        "remote": {
          url: "https://github.com/example/repo.git",
          description: "Remote repo"
        }
      }
    }))

    const config = loadConfig(tmpDir)
    const space = config.spaces["remote"] as ResolvedSpace
    expect(space).toBeDefined()
    expect(space.url).toBe("https://github.com/example/repo.git")
    expect(space.path).toBe(path.join(config.spaceCloneDir, "remote"))
    expect(space.description).toBe("Remote repo")
  })

  test("rejects space with both path and url", () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })

    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      spaces: {
        "bad": { path: spaceDir, url: "https://example.com/repo.git" }
      }
    }))

    const config = loadConfig(tmpDir)
    expect(config.spaces["bad"]).toBeUndefined()

    rmSync(spaceDir, { recursive: true, force: true })
  })

  test("rejects space with neither path nor url", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      spaces: {
        "empty": { agent: "build" }
      }
    }))

    const config = loadConfig(tmpDir)
    expect(config.spaces["empty"]).toBeUndefined()
  })

  test("spaceCloneDir defaults to ~/.config/opencode/ensemble-spaces/", () => {
    const config = loadConfig(tmpDir)
    expect(config.spaceCloneDir).toBe(path.join(tmpDir, "home", ".config", "opencode", "ensemble-spaces"))
  })

  test("spaceCloneDir is configurable", () => {
    const configDir = path.join(tmpDir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "ensemble.json"), JSON.stringify({
      spaceCloneDir: "/custom/clone/dir"
    }))

    const config = loadConfig(tmpDir)
    expect(config.spaceCloneDir).toBe("/custom/clone/dir")
  })

  test("resolveSpace normalizes string to { path }", () => {
    expect(resolveSpace("/some/path")).toEqual({ path: "/some/path" })
  })

  test("resolveSpace passes through object", () => {
    const input: ResolvedSpace = { url: "https://example.com", agent: "build" }
    expect(resolveSpace(input)).toEqual(input)
  })

  test("validateSpaceEntry accepts valid path entry", () => {
    expect(validateSpaceEntry("test", { path: "/some/path" })).toBeNull()
  })

  test("validateSpaceEntry accepts valid url entry", () => {
    expect(validateSpaceEntry("test", { url: "https://example.com" })).toBeNull()
  })

  test("validateSpaceEntry rejects both path and url", () => {
    const err = validateSpaceEntry("test", { path: "/p", url: "https://u" })
    expect(err).toContain("both")
  })

  test("validateSpaceEntry rejects neither path nor url", () => {
    const err = validateSpaceEntry("test", { agent: "build" })
    expect(err).toContain("neither")
  })

  test("validateSpaceEntry rejects non-string field types", () => {
    expect(validateSpaceEntry("test", { path: "/p", agent: 123 as any })).toContain("agent")
    expect(validateSpaceEntry("test", { path: "/p", description: 123 as any })).toContain("description")
    expect(validateSpaceEntry("test", { path: "/p", flakeInput: 123 as any })).toContain("flakeInput")
    expect(validateSpaceEntry("test", { path: "/p", autoUpdateFlakeInput: "yes" as any })).toContain("autoUpdateFlakeInput")
  })
})

describe("team_shutdown — space members", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  function insertSpaceMember(name: string, sessionId: string, status: string, spaceName: string, spaceDir: string) {
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, space_name, space_dir, time_created, time_updated) VALUES (?, ?, ?, 'build', ?, ?, ?, ?, ?, ?)",
      ["t1", name, sessionId, status, "running", spaceName, spaceDir, Date.now(), Date.now()]
    )
  }

  test("graceful shutdown of busy space member sends shutdown message", async () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-shutdown-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })
    insertSpaceMember("alice", "sess-alice", "busy", "infra", spaceDir)

    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-alice": { type: "busy" } } }
    }

    // Mock checkWorktreeDirty to return false (clean)
    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", async () => false, noopPreserve)
    expect(result).toContain("Shutdown requested")
    expect(result).toContain("alice")

    // Should send promptAsync but NOT abort
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls.length).toBeGreaterThanOrEqual(1)
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(0)

    rmSync(spaceDir, { recursive: true, force: true })
  })

  test("force shutdown of space member always proceeds (Step 0 finding)", async () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-force-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })
    insertSpaceMember("alice", "sess-alice", "busy", "infra", spaceDir)

    const result = await executeTeamShutdown(deps, { member: "alice", force: true }, "lead-sess", async () => false, noopPreserve)
    expect(result).toContain("shut down")
    expect(result).toContain("alice")

    // Should abort
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)

    // Should be marked as shutdown in DB
    const member = deps.db.query("SELECT status FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice") as { status: string }
    expect(member.status).toBe("shutdown")

    rmSync(spaceDir, { recursive: true, force: true })
  })

  test("force shutdown of dirty space member proceeds and notifies lead", async () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-dirty-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })
    insertSpaceMember("alice", "sess-alice", "busy", "infra", spaceDir)

    // Mock dirty check to return true
    const result = await executeTeamShutdown(deps, { member: "alice", force: true }, "lead-sess", async () => true, noopPreserve)
    expect(result).toContain("shut down")

    // Should notify lead about dirty state (system message persisted + wake promptAsync)
    // The key assertion: abort was called (proceed, not block)
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)

    rmSync(spaceDir, { recursive: true, force: true })
  })

  test("shutdown_requested space member force-aborts on second call", async () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-second-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })
    insertSpaceMember("alice", "sess-alice", "shutdown_requested", "infra", spaceDir)

    const result = await executeTeamShutdown(deps, { member: "alice", force: true }, "lead-sess", async () => false, noopPreserve)
    expect(result).toContain("Force shut down")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)

    rmSync(spaceDir, { recursive: true, force: true })
  })

  test("idle space member is shut down immediately", async () => {
    const spaceDir = mkdtempSync(path.join(os.tmpdir(), "space-idle-"))
    mkdirSync(path.join(spaceDir, ".git"), { recursive: true })
    insertSpaceMember("alice", "sess-alice", "busy", "infra", spaceDir)

    deps.client.session.status = async () => {
      deps.client.calls.push({ method: "session.status", args: [] })
      return { data: {} } // session not found → treated as idle
    }

    const result = await executeTeamShutdown(deps, { member: "alice" }, "lead-sess", async () => false, noopPreserve)
    expect(result).toContain("shut down")

    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)

    rmSync(spaceDir, { recursive: true, force: true })
  })
})
