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
  "delegate",
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

test("help states the delegator/delegatee contract up top, before the action list (issue #15)", async () => {
  const res = await execute({ action: "help" }, { sessionID: "ses_test" })
  const content = res.content
  // The contract paragraph is unmissable: it sits between the title and the
  // action list, and names both roles with their duties.
  expect(content.indexOf("WHO DOES WHAT")).toBeGreaterThan(-1)
  expect(content.indexOf("WHO DOES WHAT")).toBeLessThan(content.indexOf("Actions and their required params"))
  expect(content).toContain("DELEGATOR")
  expect(content).toContain("DELEGATEE")
  expect(content).toContain("SETS IT UP")
  expect(content).toContain("ONLY the ticket NUMBER")
  expect(content).toContain("FIRST TWO calls")
  expect(content).toContain("reviews the diff, runs the tests, commits")
  expect(content).toContain("does NOT call")
})

test("get_delegee_rules opens with the division of labour, then the rules (issue #15)", async () => {
  const res = await execute({ action: "get_delegee_rules" }, { sessionID: "ses_test" })
  const content = res.content
  expect(content).toContain("you are the DELEGATEE")
  expect(content).toContain("handed you ONLY its number")
  expect(content).toContain("first two")
  // The roles paragraph comes BEFORE the rules list.
  expect(content.indexOf("WHO YOU ARE")).toBeLessThan(content.indexOf("No commit, no push"))
  expect(content).toContain("No commit, no push")
  expect(content).toContain("OWNER's rollout uuid")
})

test("every validation error names the missing param and points at help", async () => {
  const hint = 'ticket {"action":"help"}'
  expect(err(await execute({ action: "add" }, {}))).toContain("add requires 'todo'")
  expect(err(await execute({ action: "add", todo: "x" }, {}))).toContain("add requires 'rollout_id'")
  // A malformed add names the role, not just the param (issue #15).
  expect(err(await execute({ action: "add" }, {}))).toContain("DELEGATOR action")
  expect(err(await execute({ action: "add", todo: "x" }, {}))).toContain("DELEGATOR action")
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

test("delegate prints the launch prompt naming the ticket and the OWNER's rollout uuid (issue #15)", async () => {
  const add = JSON.parse((await execute({ action: "add", todo: "hand-off test", rollout_id: "ses_ownerD" }, { sessionID: "ses_ownerD" })).content)
  const res = await execute({ action: "delegate", id: add.id }, { sessionID: "ses_anyone" })
  expect(res.content).toContain(`ticket ${add.id}`)
  expect(res.content).toContain("get_delegee_rules")
  expect(res.content).toContain(`rollout_id=${"ses_ownerD"}`)
  expect(res.content).toContain("report back")
  // Read-only: any session may ask, and nothing mutated.
  const got = JSON.parse((await execute({ action: "get", id: add.id }, { sessionID: "ses_anyone" })).content)
  expect(got.status).toBe("pending")
})

test("delegate without id errors with the contract echo; delegate on a missing ticket names it", async () => {
  expect(err(await execute({ action: "delegate" }, {}))).toContain("delegate requires 'id'")
  expect(err(await execute({ action: "delegate" }, {}))).toContain('ticket {"action":"help"}')
  expect(err(await execute({ action: "delegate", id: 424242 }, {}))).toContain("no ticket with number 424242")
})
