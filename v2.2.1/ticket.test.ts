// ticket.test.ts — the self-contained entry's contract, exercised with
// bun:test without loading opencode (the module is import-free outside
// builtins). TICKET_DB_HOME is pointed at a gitignored scratch dir so the
// shared ticket DB is never touched.
import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { execute } from "./ticket"

beforeAll(() => {
  process.env.TICKET_DB_HOME = mkdtempSync(join(".tmp", "ticket-test-"))
})

const HELP_ACTIONS = [
  "add",
  "list",
  "get",
  "update",
  "link_md",
  "novate",
  "purge_older_than",
  "list_since",
  "append_comment",
  "get_delegee_rules",
  "help",
]

function err(res: { content: string }): string {
  expect(res.content).toStartWith("ticket error: ")
  return res.content
}

test("help prints the full contract: every action, the loop, ownership, immutability, mark-complete vs drop", async () => {
  const res = await execute({ action: "help" }, { sessionID: "ses_test" })
  for (const action of HELP_ACTIONS) {
    expect(res.content).toContain(action)
  }
  expect(res.content).toContain("rollout_id")
  expect(res.content).toContain("ORCHESTRATOR")
  expect(res.content).toContain("ever hard-deleted")
  expect(res.content).toContain("superseded")
  expect(res.content).toContain("purge_older_than")
})

test("get_delegee_rules returns the subagent banner", async () => {
  const res = await execute({ action: "get_delegee_rules" }, { sessionID: "ses_test" })
  expect(res.content).toContain("No commit, no push")
})

test("every validation error names the missing param and points at help", async () => {
  const hint = 'ticket {"action":"help"}'
  expect(err(await execute({ action: "add" }, {}))).toContain("add requires 'todo'")
  expect(err(await execute({ action: "add", todo: "x" }, {}))).toContain("add requires 'rollout_id'")
  expect(err(await execute({ action: "get" }, {}))).toContain("get requires 'id'")
  expect(err(await execute({ action: "update", id: 1 }, {}))).toContain("update requires 'rollout_id'")
  expect(err(await execute({ action: "update" }, {}))).toContain("update requires 'id'")
  expect(err(await execute({ action: "link_md", id: 1 }, {}))).toContain("link_md requires 'id' and 'md_content'")
  expect(err(await execute({ action: "link_md", id: 1, md_content: "x" }, {}))).toContain(
    "link_md requires 'rollout_id'",
  )
  expect(err(await execute({ action: "novate", id: 1, rollout_id: "ses_a" }, {}))).toContain(
    "novate requires 'to_rollout_id'",
  )
  expect(err(await execute({ action: "purge_older_than" }, {}))).toContain("purge_older_than requires 'before'")
  expect(err(await execute({ action: "purge_older_than", before: "2020-01-01T00:00:00Z" }, {}))).toContain(
    "purge_older_than requires 'rollout_id'",
  )
  expect(err(await execute({ action: "list_since" }, {}))).toContain("list_since requires 'since'")
  expect(err(await execute({ action: "append_comment", id: 1 }, {}))).toContain("append_comment requires 'content'")
  expect(err(await execute({ action: "append_comment", id: 1, content: "x" }, {}))).toContain(
    "append_comment requires 'rollout_id'",
  )
  for (const content of [
    await execute({ action: "add" }, {}),
    await execute({ action: "update", id: 1 }, {}),
    await execute({ action: "link_md", id: 1, md_content: "x" }, {}),
    await execute({ action: "append_comment", id: 1, content: "x" }, {}),
  ])
    expect(content.content).toContain(hint)
})

test("unknown action names the valid actions and help", async () => {
  const res = await execute({ action: "nope" }, {})
  expect(res.content).toContain('unknown action "nope"')
  expect(res.content).toContain("help")
})

test("a non-owner mutation is refused and the error names the owner", async () => {
  const add = JSON.parse((await execute({ action: "add", todo: "owner test", rollout_id: "ses_ownerA" }, { sessionID: "ses_test" })).content)
  const res = await execute(
    { action: "update", id: add.id, rollout_id: "ses_ownerB", status: "completed" },
    { sessionID: "ses_test" },
  )
  expect(res.content).toContain("refused")
  expect(res.content).toContain("ses_ownerA")
})

test("happy path: add -> update -> get renders the row; add persists md_content", async () => {
  const add = JSON.parse(
    (await execute(
      { action: "add", todo: "happy path", rollout_id: "ses_happy", md_content: "# plan" },
      { sessionID: "ses_happy" },
    )).content,
  )
  expect(add.id).toBeGreaterThan(0)
  const upd = JSON.parse(
    (await execute({ action: "update", id: add.id, rollout_id: "ses_happy", status: "completed" }, { sessionID: "ses_happy" })).content,
  )
  expect(upd.status).toBe("completed")
  const got = JSON.parse((await execute({ action: "get", id: add.id }, { sessionID: "ses_happy" })).content)
  expect(got.md_content).toBe("# plan")
})

test("append_comment adds an immutable comment; get renders it", async () => {
  const add = JSON.parse((await execute({ action: "add", todo: "comment test", rollout_id: "ses_comments" }, { sessionID: "ses_comments" })).content)
  const c = JSON.parse(
    (await execute(
      { action: "append_comment", id: add.id, rollout_id: "ses_comments", content: "gate green" },
      { sessionID: "ses_comments" },
    )).content,
  )
  expect(c.ticket_id).toBe(add.id)
  const got = (await execute({ action: "get", id: add.id }, { sessionID: "ses_comments" })).content
  expect(got).toContain("--- comments (chronological) ---")
  expect(got).toContain("gate green")
})
