// ticket.test.ts — the simple contract: an immutable ticket, an append-only
// comment stream, and status as the only mutation. Exercised with bun:test
// without loading opencode (the module is import-free outside builtins).
// TICKET_DB_HOME is pointed at a gitignored scratch dir so the shared ticket
// DB is never touched.
import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { execute } from "./ticket"

beforeAll(() => {
  process.env.TICKET_DB_HOME = mkdtempSync(join(".tmp", "ticket-test-"))
})

const ACTIONS = ["add", "get", "list", "append_comment", "set_status", "get_delegee_rules", "help"]

function err(res: { content: string }): string {
  expect(res.content).toStartWith("ticket error: ")
  return res.content
}

test("help prints the whole contract: the idea, every action, delegation, no dead verbs", async () => {
  const res = await execute({ action: "help" }, { sessionID: "ses_test" })
  const content = res.content
  expect(content).toContain("IMMUTABLE record")
  expect(content).toContain("APPEND-ONLY comment stream")
  expect(content).toContain("only field that ever changes")
  for (const action of ACTIONS) {
    expect(content).toContain(action)
  }
  // The deleted verbs are gone from the contract.
  for (const dead of ["link_md", "novate", "purge_older_than", "list_since", "update", "delegate"]) {
    expect(content).not.toContain(`${dead} `)
  }
  expect(content).toContain("no rewrite action")
  expect(content).toContain("delete action")
  expect(content).toContain("SKILL.md")
  expect(content).toContain("This tool is the plugin")
})

test("get_delegee_rules opens with the division of labour, immutability and no-prereq", async () => {
  const res = await execute({ action: "get_delegee_rules" }, { sessionID: "ses_test" })
  const content = res.content
  expect(content.indexOf("WHO YOU ARE")).toBeLessThan(content.indexOf("No commit, no push"))
  expect(content).toContain("you are the DELEGATEE")
  expect(content).toContain("THE TICKET IS IMMUTABLE")
  expect(content).toContain("NO write to the ticket is")
  expect(content).toContain("prerequisite for starting work")
  expect(content).toContain("No commit, no push")
  expect(content).toContain("STOP calling it")
})

test("the happy path: add persists the body once; short comments append one at a time; get renders both", async () => {
  const add = JSON.parse(
    (await execute(
      { action: "add", todo: "happy path", rollout_id: "ses_happy", md_content: "# the spec, written once" },
      { sessionID: "ses_happy" },
    )).content,
  )
  expect(add.id).toBeGreaterThan(0)
  expect(add.ticket.status).toBe("pending")
  for (const text of ["done", "blocked on env"]) {
    const c = JSON.parse(
      (await execute(
        { action: "append_comment", id: add.id, content: text },
        { sessionID: "ses_commenter" },
      )).content,
    )
    expect(c.ticket_id).toBe(add.id)
    expect(c.author_rollout_id).toBe("ses_commenter")
  }
  const got = (await execute({ action: "get", id: add.id }, { sessionID: "ses_anyone" })).content
  expect(got).toContain('"md_content": "# the spec, written once"')
  expect(got).toContain("--- comments (chronological) ---")
  expect(got.indexOf("done")).toBeLessThan(got.indexOf("blocked on env"))
})

test("a comment is a short go/no-go note: essays are refused, the cap echoes the alternative channels", async () => {
  const add = JSON.parse(
    (await execute({ action: "add", todo: "cap test", rollout_id: "ses_cap" }, { sessionID: "ses_cap" })).content,
  )
  const essay = "x".repeat(281)
  const refused = err(await execute({ action: "append_comment", id: add.id, content: essay }, { sessionID: "ses_cap" }))
  expect(refused).toContain("280 chars max")
  expect(refused).toContain("never go on the ticket")
  expect(refused).toContain("gist")
  const ok = await execute(
    { action: "append_comment", id: add.id, content: "DONE: gates green (321/0/0/0), commit abc1234" },
    { sessionID: "ses_cap" },
  )
  expect(JSON.parse(ok.content).ticket_id).toBe(add.id)
  // Exactly 280 is allowed.
  const edge = await execute(
    { action: "append_comment", id: add.id, content: "y".repeat(280) },
    { sessionID: "ses_cap" },
  )
  expect(JSON.parse(edge.content).ticket_id).toBe(add.id)
})

test("set_status is the only mutation, owner-gated; superseded needs no linkage — a comment carries the successor", async () => {
  const add = JSON.parse(
    (await execute({ action: "add", todo: "status test", rollout_id: "ses_ownerA" }, { sessionID: "ses_test" })).content,
  )
  // A non-owner is refused and the error names the owner.
  const refused = err(
    await execute(
      { action: "set_status", id: add.id, rollout_id: "ses_ownerB", status: "completed" },
      { sessionID: "ses_test" },
    ),
  )
  expect(refused).toContain("refused")
  expect(refused).toContain("ses_ownerA")
  // The owner can supersede — no parent linkage required.
  const row = JSON.parse(
    (await execute(
      { action: "set_status", id: add.id, rollout_id: "ses_ownerA", status: "superseded" },
      { sessionID: "ses_ownerA" },
    )).content,
  )
  expect(row.status).toBe("superseded")
  // A bogus status is rejected with the whitelist.
  expect(err(await execute(
    { action: "set_status", id: add.id, rollout_id: "ses_ownerA", status: "bogus" },
    { sessionID: "ses_ownerA" },
  ))).toContain("status must be one of")
})

test("every validation error names the missing param, prints the corrected call, and points at help", async () => {
  const hint = 'ticket {"action":"help"}'
  expect(err(await execute({ action: "add" }, {}))).toContain("add requires 'todo'")
  expect(err(await execute({ action: "add", todo: "x" }, {}))).toContain("add requires 'rollout_id'")
  expect(err(await execute({ action: "add" }, {}))).toContain("the immutable record")
  expect(err(await execute({ action: "get" }, {}))).toContain('the corrected call: ticket {"action":"get"')
  expect(err(await execute({ action: "append_comment", id: 1 }, {}))).toContain("append_comment requires 'content'")
  expect(err(await execute({ action: "append_comment", id: 1 }, {}))).toContain('the corrected call: ticket {"action":"append_comment"')
  expect(err(await execute({ action: "append_comment", content: "x" }, {}))).toContain(
    "append_comment requires 'id'",
  )
  expect(err(await execute({ action: "set_status", id: 1 }, {}))).toContain("set_status requires 'status'")
  expect(err(await execute({ action: "set_status", id: 1 }, {}))).toContain('the corrected call: ticket {"action":"set_status"')
  expect(err(await execute({ action: "set_status", id: 1, status: "completed" }, {}))).toContain(
    "set_status requires 'rollout_id'",
  )
  for (const res of [
    await execute({ action: "add" }, {}),
    await execute({ action: "get" }, {}),
    await execute({ action: "set_status", id: 1, status: "completed" }, {}),
  ])
    expect(res.content).toContain(hint)
})

test("the deleted verbs are really gone: they answer unknown action", async () => {
  for (const dead of ["update", "link_md", "novate", "purge_older_than", "list_since", "delegate"]) {
    const res = await execute({ action: dead, id: 1, rollout_id: "ses_x" }, {})
    expect(res.content).toContain(`unknown action "${dead}"`)
    expect(res.content).toContain("add|get|list|append_comment|set_status|get_delegee_rules|help")
  }
})

test("list requires the session id; all=true lists every session; the row is exactly the contract's columns", async () => {
  await execute({ action: "add", todo: "list a", rollout_id: "ses_listA" }, { sessionID: "ses_listA" })
  await execute({ action: "add", todo: "list b", rollout_id: "ses_listB" }, { sessionID: "ses_listB" })
  // No session id and no all: refused with the corrected call.
  const refused = err(await execute({ action: "list" }, {}))
  expect(refused).toContain("list requires 'rollout_id'")
  expect(refused).toContain("the session id to query")
  expect(refused).toContain('"all":true')
  // One session's tickets: only that session's, in the named columns only.
  const mine = JSON.parse((await execute({ action: "list", rollout_id: "ses_listA" }, {})).content)
  expect(mine.length).toBeGreaterThan(0)
  expect(mine.every((r: { rollout_id: string }) => r.rollout_id === "ses_listA")).toBe(true)
  for (const key of Object.keys(mine[0]))
    expect(["id", "created_at", "updated_at", "todo", "status", "rollout_id", "last_actor", "md_content"]).toContain(key)
  // status filter combines with the session id.
  const minePending = JSON.parse(
    (await execute({ action: "list", rollout_id: "ses_listA", status: "pending" }, {})).content,
  )
  expect((minePending as any[]).every((r) => r.status === "pending")).toBe(true)
  // all=true: every session's tickets.
  const everyone = JSON.parse((await execute({ action: "list", all: true }, {})).content)
  expect((everyone as any[]).some((r) => r.rollout_id === "ses_listA")).toBe(true)
  expect((everyone as any[]).some((r) => r.rollout_id === "ses_listB")).toBe(true)
})

test("the session-id doctrine is stated in help: one id, own session by default, launch prompt names the id", async () => {
  const res = await execute({ action: "help" }, { sessionID: "ses_test" })
  const content = res.content
  expect(content).toContain("rollout_id IS the session id")
  expect(content).toContain("one id, no other")
  expect(content).toContain("ITS OWN session id")
  expect(content).toContain("NAMES the session id to use")
  expect(content).toContain("names the session id to query with")
})

test("add and set_status responses are clean: exactly the contract's shape", async () => {
  const add = JSON.parse(
    (await execute({ action: "add", todo: "clean resp", rollout_id: "ses_clean" }, { sessionID: "ses_other" })).content,
  )
  expect(Object.keys(add).sort()).toEqual(["id", "rollout_id", "ticket"].sort())
  const row = JSON.parse(
    (await execute(
      { action: "set_status", id: add.id, rollout_id: "ses_clean", status: "completed" },
      { sessionID: "ses_other" },
    )).content,
  )
  expect(row.last_actor).toBe("ses_other")
  expect(Object.keys(row).sort()).toEqual(
    ["id", "created_at", "updated_at", "todo", "status", "rollout_id", "last_actor", "md_content"].sort(),
  )
})
