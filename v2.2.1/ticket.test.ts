// ticket.test.ts — the split-tool contract (issue #18): one tool per
// action, per-tool required schemas, and the {code, message,
// corrected_call} envelope on every failure path. The acceptance: a
// corrected_call re-emitted verbatim succeeds. Exercised with bun:test
// without loading opencode; TICKET_DB_HOME points at a gitignored scratch
// dir so the shared ticket DB is never touched.
import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import {
  executeAdd,
  executeGet,
  executeList,
  executeComment,
  executeStatus,
  executeRules,
  executeHelp,
  parseEnvelope,
  TicketStore,
  ticketDbPath,
  ADD_INPUT,
  GET_INPUT,
  LIST_INPUT,
  COMMENT_INPUT,
  STATUS_INPUT,
  ADD_JTD,
  GET_JTD,
  LIST_JTD,
  COMMENT_JTD,
  STATUS_JTD,
  jtdValidateAdd,
  jtdValidateGet,
  jtdValidateList,
  jtdValidateComment,
  jtdValidateStatus,
  jtdValidateNone,
} from "./ticket"

beforeAll(() => {
  process.env.TICKET_DB_HOME = mkdtempSync(join(".tmp", "ticket-test-"))
})

function envelope(content: string) {
  const e = parseEnvelope(content)
  expect(e).not.toBeNull()
  return e!
}

async function add(todo: string, rollout_id: string, md_content?: string) {
  const res = await executeAdd({ todo, rollout_id, md_content }, { sessionID: rollout_id })
  return JSON.parse(res.content)
}

// ─── The schemas make misuse unrepresentable ────────────────────────────────

test("each tool's schema declares its required params and rejects junk keys", () => {
  expect(ADD_INPUT.required).toEqual(["rollout_id", "todo"])
  expect(ADD_INPUT.additionalProperties).toBe(false)
  expect(GET_INPUT.required).toEqual(["id"])
  expect(GET_INPUT.additionalProperties).toBe(false)
  // list: the session id unless all=true forces a search of every session.
  expect(LIST_INPUT.oneOf).toEqual([{ required: ["rollout_id"] }, { required: ["all"] }])
  expect(LIST_INPUT.additionalProperties).toBe(false)
  expect(COMMENT_INPUT.required).toEqual(["id", "content"])
  expect(COMMENT_INPUT.additionalProperties).toBe(false)
  expect(COMMENT_INPUT.properties.content.maxLength).toBe(1000)
  expect(STATUS_INPUT.required).toEqual(["id", "rollout_id", "status"])
  expect(STATUS_INPUT.additionalProperties).toBe(false)
})

// ─── The envelope: every failure path, and the verbatim-re-emit acceptance ──

test("the missing-rollout_id envelope self-heals: corrected_call carries the REAL owner session id; re-emit verbatim succeeds", async () => {
  const created = await add("self-heal test", "ses_ownerX")
  // The call arrives without the owner session id.
  const e1 = envelope((await executeStatus({ id: created.id, status: "completed" }, { sessionID: "ses_delegatee" })).content)
  expect(e1.code).toBe("E_STATUS_MISSING_ROLLOUT_ID")
  expect(e1.message).toContain("ticket_status requires 'rollout_id'")
  expect(e1.corrected_call.rollout_id).toBe("ses_ownerX")
  expect(e1.corrected_call.id).toBe(created.id)
  expect(e1.corrected_call.status).toBe("completed")
  // ACCEPTANCE: re-emit corrected_call verbatim — the call succeeds.
  const retry = await executeStatus(e1.corrected_call, { sessionID: "ses_delegatee" })
  const row = JSON.parse(retry.content)
  expect(row.status).toBe("completed")
  expect(row.last_actor).toBe("ses_delegatee")
})

test("the non-owner refusal envelope self-heals the same way: corrected_call names the owner; verbatim re-emit succeeds", async () => {
  const created = await add("refusal test", "ses_ownerY")
  const e1 = envelope(
    (await executeStatus({ id: created.id, rollout_id: "ses_wrong", status: "superseded" }, { sessionID: "ses_delegatee" })).content,
  )
  expect(e1.code).toBe("E_STATUS_REFUSED")
  expect(e1.message).toContain("refused")
  expect(e1.message).toContain("ses_ownerY")
  expect(e1.corrected_call.rollout_id).toBe("ses_ownerY")
  const retry = JSON.parse((await executeStatus(e1.corrected_call, { sessionID: "ses_delegatee" })).content)
  expect(retry.status).toBe("superseded")
})

test("every validation failure returns {code, message, corrected_call}; each missing param has its stable code", async () => {
  const created = await add("envelope test", "ses_ownerZ")

  const addNoTodo = envelope((await executeAdd({ rollout_id: "ses_x" }, {})).content)
  expect(addNoTodo.code).toBe("E_ADD_MISSING_TODO")
  expect(addNoTodo.corrected_call.todo).toContain("<fill:")
  const addNoOwner = envelope((await executeAdd({ todo: "x" }, {})).content)
  expect(addNoOwner.code).toBe("E_ADD_MISSING_ROLLOUT_ID")

  const getNoId = envelope((await executeGet({}, {})).content)
  expect(getNoId.code).toBe("E_GET_MISSING_ID")
  const getMissing = envelope((await executeGet({ id: 424242 }, {})).content)
  expect(getMissing.code).toBe("E_NO_TICKET")

  const listBare = envelope((await executeList({}, {})).content)
  expect(listBare.code).toBe("E_LIST_MISSING_ROLLOUT_ID")
  expect(listBare.message).toContain("all=true")

  const cmtNoId = envelope((await executeComment({ content: "done" }, {})).content)
  expect(cmtNoId.code).toBe("E_COMMENT_MISSING_ID")
  const cmtNoContent = envelope((await executeComment({ id: created.id }, {})).content)
  expect(cmtNoContent.code).toBe("E_COMMENT_MISSING_CONTENT")
  const cmtMissing = envelope((await executeComment({ id: 424242, content: "x" }, {})).content)
  expect(cmtMissing.code).toBe("E_NO_TICKET")

  const stNoId = envelope((await executeStatus({ rollout_id: "s", status: "pending" }, {})).content)
  expect(stNoId.code).toBe("E_STATUS_MISSING_ID")
  const stNoStatus = envelope((await executeStatus({ id: created.id, rollout_id: "ses_ownerZ" }, {})).content)
  expect(stNoStatus.code).toBe("E_STATUS_MISSING_STATUS")
  const stBad = envelope(
    (await executeStatus({ id: created.id, rollout_id: "ses_ownerZ", status: "bogus" }, {})).content,
  )
  expect(stBad.code).toBe("E_STATUS_BAD_STATUS")
  expect(stBad.message).toContain("is not one of the legal values")

  // every message carries the one-help-call hint
  for (const e of [addNoTodo, getNoId, listBare, cmtNoId, stNoStatus, stBad])
    expect(e.message).toContain("ticket_help")
})

test("a comment over 1000 chars is E_COMMENT_TOO_LONG with the channel-naming message; 1000 exactly lands", async () => {
  const created = await add("cap test", "ses_cap")
  const e1 = envelope((await executeComment({ id: created.id, content: "x".repeat(1001) }, {})).content)
  expect(e1.code).toBe("E_COMMENT_TOO_LONG")
  expect(e1.message).toContain("1000 chars max")
  expect(e1.message).toContain("gist")
  const ok1000 = await executeComment({ id: created.id, content: "y".repeat(1000) }, { sessionID: "ses_cap" })
  expect(JSON.parse(ok1000.content).ticket_id).toBe(created.id)
})

// ─── The happy paths ────────────────────────────────────────────────────────

test("add persists the body once; comments append one at a time; get renders both", async () => {
  const created = await add("happy path", "ses_happy", "# the spec, written once")
  expect(created.id).toBeGreaterThan(0)
  expect(created.ticket.status).toBe("pending")
  for (const text of ["done", "blocked on env"]) {
    const c = JSON.parse((await executeComment({ id: created.id, content: text }, { sessionID: "ses_commenter" })).content)
    expect(c.ticket_id).toBe(created.id)
    expect(c.author_rollout_id).toBe("ses_commenter")
  }
  const got = (await executeGet({ id: created.id }, { sessionID: "ses_anyone" })).content
  expect(got).toContain('"md_content": "# the spec, written once"')
  expect(got).toContain("--- comments (chronological) ---")
  expect(got.indexOf("done")).toBeLessThan(got.indexOf("blocked on env"))
})

test("list: one session by id, status filter combines, all=true lists every session", async () => {
  await add("list a", "ses_listA")
  await add("list b", "ses_listB")
  const mine = JSON.parse((await executeList({ rollout_id: "ses_listA" }, {})).content)
  expect(mine.length).toBeGreaterThan(0)
  expect(mine.every((r: { rollout_id: string }) => r.rollout_id === "ses_listA")).toBe(true)
  const minePending = JSON.parse((await executeList({ rollout_id: "ses_listA", status: "pending" }, {})).content)
  expect((minePending as any[]).every((r) => r.status === "pending")).toBe(true)
  const everyone = JSON.parse((await executeList({ all: true }, {})).content)
  expect((everyone as any[]).some((r) => r.rollout_id === "ses_listA")).toBe(true)
  expect((everyone as any[]).some((r) => r.rollout_id === "ses_listB")).toBe(true)
})

// ─── The contract text ──────────────────────────────────────────────────────

test("help states the whole contract: tools, doctrine, envelope; no action strings", async () => {
  const content = (await executeHelp()).content
  for (const tool of ["ticket_add", "ticket_get", "ticket_list", "ticket_comment", "ticket_status", "ticket_rules", "ticket_help"]) {
    expect(content).toContain(tool)
  }
  expect(content).toContain("rollout_id IS the session id")
  expect(content).toContain("You MUST know your own session id")
  expect(content).toContain("NAME the session id the delegatee must use")
  expect(content).toContain("Too simple to get wrong")
  expect(content).toContain("corrected_call")
  expect(content).toContain("IMMUTABLE record")
  expect(content).toContain("one id, no other")
})

test("the rules banner opens with the division of labour, immutability, no-prereq, and the envelope recovery", async () => {
  const content = (await executeRules()).content
  expect(content.indexOf("WHO YOU ARE")).toBeLessThan(content.indexOf("No commit, no push"))
  expect(content).toContain("you are the DELEGATEE")
  expect(content).toContain("THE TICKET IS IMMUTABLE")
  expect(content).toContain("NO write to the ticket")
  expect(content).toContain("prerequisite for starting work")
  expect(content).toContain("No commit, no push")
  expect(content).toContain("ticket_get id=N")
  expect(content).toContain("ticket_status with the OWNER's session id")
  expect(content).toContain("re-emit corrected_call verbatim")
  expect(content).toContain("STOP calling it")
})

// ─── Red/Green: the RFC 8927 validators gate every handler (issue #18) ──────

test("the RFC 8927 validators: the legal set is exact — unit level", () => {
  // add: rollout_id+todo required, md_content optional, junk rejected
  expect(jtdValidateAdd({ rollout_id: "s", todo: "t" })).toEqual([])
  expect(jtdValidateAdd({ rollout_id: "s", todo: "t", md_content: "m" })).toEqual([])
  expect(jtdValidateAdd({ rollout_id: "s", todo: "t", junk: 1 })).toEqual([{ instancePath: "/junk", schemaPath: "" }])
  expect(jtdValidateAdd({ rollout_id: "s" })).toEqual([{ instancePath: "", schemaPath: "/properties/todo" }])
  expect(jtdValidateAdd({ rollout_id: 7, todo: "t" })).toEqual([{ instancePath: "/rollout_id", schemaPath: "/properties/rollout_id/type" }])
  expect(jtdValidateAdd(null)).toEqual([{ instancePath: "", schemaPath: "/properties" }])
  // get: id required, uint32
  expect(jtdValidateGet({ id: 5 })).toEqual([])
  expect(jtdValidateGet({ id: -1 })).toEqual([{ instancePath: "/id", schemaPath: "/properties/id/type" }])
  expect(jtdValidateGet({ id: 1.5 })).toEqual([{ instancePath: "/id", schemaPath: "/properties/id/type" }])
  // list: all optional individually
  expect(jtdValidateList({})).toEqual([])
  expect(jtdValidateList({ rollout_id: "s", status: "pending", all: true })).toEqual([])
  expect(jtdValidateList({ status: "bogus" }))[0]
  expect(jtdValidateList({ status: "bogus" })[0].schemaPath).toBe("/optionalProperties/status/enum")
  // comment: id+content required
  expect(jtdValidateComment({ id: 1, content: "done" })).toEqual([])
  expect(jtdValidateComment({ content: "done" })[0].schemaPath).toBe("/properties/id")
  // status: id+rollout_id+status required, status enum enforced
  expect(jtdValidateStatus({ id: 1, rollout_id: "s", status: "superseded" })).toEqual([])
  expect(jtdValidateStatus({ id: 1, rollout_id: "s", status: "bogus" })[0].schemaPath).toBe("/properties/status/enum")
  expect(jtdValidateStatus({ id: 1, status: "pending" })[0].schemaPath).toBe("/properties/rollout_id")
  // none: rules/help take no params at all
  expect(jtdValidateNone({})).toEqual([])
  expect(jtdValidateNone({ junk: 1 })).toEqual([{ instancePath: "/junk", schemaPath: "" }])
  // an explicitly-undefined key is ABSENT in JSON semantics — never a type error
  expect(jtdValidateAdd({ rollout_id: "s", todo: "t", md_content: undefined })).toEqual([])
  expect(jtdValidateStatus({ id: undefined, rollout_id: "s", status: "pending" })[0].schemaPath).toBe("/properties/id")
})

test("the RFC 8927 sets and the harness-facing JSON Schema declare the same legal params", () => {
  expect(Object.keys(ADD_JTD.properties).sort()).toEqual(ADD_INPUT.required.slice().sort())
  expect(Object.keys(GET_JTD.properties).sort()).toEqual(GET_INPUT.required.slice().sort())
  expect(Object.keys(COMMENT_JTD.properties).sort()).toEqual(COMMENT_INPUT.required.slice().sort())
  expect(Object.keys(STATUS_JTD.properties).sort()).toEqual(STATUS_INPUT.required.slice().sort())
  expect(Object.keys(ADD_JTD.optionalProperties!).sort()).toEqual(["md_content"])
  expect(Object.keys(LIST_JTD.optionalProperties!).sort()).toEqual(Object.keys(LIST_INPUT.properties).sort())
  expect(STATUS_JTD.properties.status.enum).toEqual(["pending", "in_progress", "completed", "cancelled", "superseded"])
  expect(COMMENT_INPUT.properties.content.maxLength).toBe(1000)
})

test("GREEN TARGET: a junk parameter is rejected before the store — E_ADD_EXTRA_PROPERTY, zero side effects", async () => {
  const before = JSON.parse((await executeList({ all: true }, {})).content).length
  // 'before' is the historic junk param models used to inject
  const e = envelope((await executeAdd({ rollout_id: "ses_junk", todo: "t", before: "2020-01-01" }, {})).content)
  expect(e.code).toBe("E_ADD_EXTRA_PROPERTY")
  expect(e.message).toContain("'before' is not a legal parameter")
  const after = JSON.parse((await executeList({ all: true }, {})).content).length
  expect(after).toBe(before) // rejected BEFORE the store: nothing was created
})

test("GREEN TARGET: a wrong-typed id is rejected by JTD — E_GET_BAD_ID / E_COMMENT_BAD_ID", async () => {
  const e1 = envelope((await executeGet({ id: "seven" }, {})).content)
  expect(e1.code).toBe("E_GET_BAD_ID")
  expect(e1.message).toContain("wrong type")
  const e2 = envelope((await executeComment({ id: "seven", content: "x" }, {})).content)
  expect(e2.code).toBe("E_COMMENT_BAD_ID")
})

test("GREEN TARGET: a bogus status is rejected by the JTD enum — E_STATUS_BAD_STATUS with the legal values; corrected_call re-emitted verbatim succeeds", async () => {
  const created = await add("enum gate test", "ses_enum")
  const e = envelope((await executeStatus({ id: created.id, rollout_id: "ses_enum", status: "bogus" }, {})).content)
  expect(e.code).toBe("E_STATUS_BAD_STATUS")
  expect(e.message).toContain("is not one of the legal values")
  expect(e.message).toContain("pending|in_progress|completed|cancelled|superseded")
  // corrected_call is legal: verbatim re-emit succeeds
  const retry = JSON.parse((await executeStatus(e.corrected_call, { sessionID: "ses_enum" })).content)
  expect(retry.status).toBe("pending")
})

test("GREEN TARGET: a missing required param is rejected by JTD with the stable code — E_STATUS_MISSING_STATUS", async () => {
  const created = await add("jtd missing test", "ses_jtdm")
  const e = envelope((await executeStatus({ id: created.id, rollout_id: "ses_jtdm" }, {})).content)
  expect(e.code).toBe("E_STATUS_MISSING_STATUS")
  expect(e.message).toContain("ticket_status requires 'status'")
})

test("the todowrite mirror is unchanged: flushing 'N: …' closes ticket N for the flushing session only", async () => {
  const created = await add("mirror test", "ses_mirror")
  const store = new TicketStore(ticketDbPath())
  const changed = store.syncStatuses([{ content: `${created.id}: mirror`, status: "completed" }], "ses_mirror")
  expect(changed).toEqual([created.id])
  const row = JSON.parse((await executeGet({ id: created.id }, {})).content)
  expect(row.status).toBe("completed")
  // scoped: another session's flush never touches it
  const changed2 = store.syncStatuses([{ content: `${created.id}: mirror`, status: "in_progress" }], "ses_other")
  expect(changed2).toEqual([])
  store.close()
})
