/**
 * Node-host runtime smoke check for the SQLite adapter layer.
 *
 * `bun test` only exercises the bun:sqlite branch of src/db.ts. This script runs
 * the real database path (src/db.ts -> src/schema.ts) under Node 24+ so CI also
 * covers the node:sqlite branch used by the desktop/Electron host.
 *
 * Run it under Node: `node test/node-smoke.ts`
 * (Under Bun it exercises the bun:sqlite branch: `bun test/node-smoke.ts`.)
 *
 * Exits non-zero on any failure. Deliberately framework-free — no bun:test
 * import — so it runs under both runtimes without a runner.
 */
import { createDb, getDb } from "../src/db.ts"

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`node-smoke failed: ${message}`)
}

const db = createDb(":memory:")

// 1. All migrations applied
const version = db.query("PRAGMA user_version").get() as { user_version: number }
check(version.user_version > 0, "migrations did not run")

// 2. Write + read through the real team table (FK to project must hold)
const now = Date.now()
db.run(
  `INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated)
   VALUES ('smoke-team', 'smoke', 'default', 'ses_smoke', 'active', 0, ?, ?)`,
  now,
  now,
)
const team = db.query("SELECT id, lead_session_id FROM team WHERE id = 'smoke-team'").get() as {
  id: string
  lead_session_id: string
}
check(team.id === "smoke-team", "team row not readable")
check(team.lead_session_id === "ses_smoke", "team row data mismatch")

// 3. Transaction wrapper: commit path
const insertMember = db.transaction((name: string) => {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, time_created, time_updated)
     VALUES ('smoke-team', ?, ?, 'build', ?, ?)`,
    name,
    `ses_${name}`,
    now,
    now,
  )
})
insertMember("alpha")
const member = db
  .query("SELECT name FROM team_member WHERE team_id = 'smoke-team' AND name = 'alpha'")
  .get() as { name: string }
check(member.name === "alpha", "transaction commit path failed")

// 4. Transaction wrapper: rollback path leaves no row behind
try {
  db.transaction(() => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, time_created, time_updated)
       VALUES ('smoke-team', 'beta', 'ses_beta', 'build', ?, ?)`,
      now,
      now,
    )
    throw new Error("force rollback")
  })()
  throw new Error("rollback path did not throw")
} catch (err) {
  check((err as Error).message === "force rollback", "unexpected error in rollback path")
}
const beta = db.query("SELECT COUNT(*) AS n FROM team_member WHERE name = 'beta'").get() as { n: number }
check(beta.n === 0, "rollback path left a row behind")

// 5. getDb returns the created singleton
check(getDb() === db, "getDb does not return the created instance")

db.close()
console.log(`node-smoke: ok (runtime ${process.versions.bun ? "bun" : "node"})`)
