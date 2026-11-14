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
  executeSession,
  parseEnvelope,
  TicketStore,
  ticketDbPath,
  ADD_INPUT,
  GET_INPUT,
  LIST_INPUT,
  COMMENT_INPUT,
  STATUS_INPUT,
  SESSION_INPUT,
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

// add drives the documented surface: ticket_add takes NO session-id param —
// the owner is the harness-provided context.sessionID (issue #26). The
// OPENCODE_SESSION_ID env var is deliberately never consulted.
async function add(todo: string, owner: string, md_content?: string) {
  const res = await executeAdd({ todo, md_content }, { sessionID: owner })
  return JSON.parse(res.content)
}

// ─── The schemas make misuse unrepresentable ────────────────────────────────

test("each tool's schema declares its required params and rejects junk keys", () => {
  // add: NO session-id param — the owner comes from context.sessionID
  expect(ADD_INPUT.required).toEqual(["todo"])
  expect(ADD_INPUT.additionalProperties).toBe(false)
  expect(ADD_INPUT.properties.rollout_id).toBeUndefined()
  expect(GET_INPUT.required).toEqual(["id"])
  expect(GET_INPUT.additionalProperties).toBe(false)
  // list: all three properties optional in the schema — a top-level oneOf
  // breaks strict upstreams (issue #22), so the "session_id or all" rule is
  // enforced by executeList at runtime, not by the exposed schema.
  expect(LIST_INPUT.type).toBe("object")
  for (const kw of ["oneOf", "anyOf", "allOf", "enum", "const", "not"] as const)
    expect(LIST_INPUT[kw]).toBeUndefined()
  expect(LIST_INPUT.required).toBeUndefined()
  expect(LIST_INPUT.additionalProperties).toBe(false)
  expect(LIST_INPUT.properties.session_id).toBeDefined()
  expect(ADD_INPUT.properties.type).toBeDefined()
  expect(LIST_INPUT.properties.type).toBeDefined()
  expect(LIST_INPUT.properties.types).toBeDefined()
  expect(LIST_INPUT.properties.include_deleted).toBeDefined()
  expect(COMMENT_INPUT.required).toEqual(["id", "content"])
  expect(COMMENT_INPUT.additionalProperties).toBe(false)
  expect(COMMENT_INPUT.properties.content.maxLength).toBe(1000)
  expect(STATUS_INPUT.required).toEqual(["id", "session_id", "status"])
  expect(STATUS_INPUT.additionalProperties).toBe(false)
  expect(STATUS_INPUT.properties.rollout_id).toBeUndefined()
  // session: no params at all
  expect(SESSION_INPUT.additionalProperties).toBe(false)
  expect(SESSION_INPUT.required).toBeUndefined()
})

// ─── The envelope: every failure path, and the verbatim-re-emit acceptance ──

test("the missing-session_id envelope self-heals: corrected_call carries the REAL owner session id; re-emit verbatim succeeds", async () => {
  const created = await add("self-heal test", "ses_ownerX")
  // The call arrives without the owner session id.
  const e1 = envelope((await executeStatus({ id: created.id, status: "completed" }, { sessionID: "ses_delegatee" })).content)
  expect(e1.code).toBe("E_STATUS_MISSING_SESSION_ID")
  expect(e1.message).toContain("ticket_status requires 'session_id'")
  expect(e1.corrected_call.session_id).toBe("ses_ownerX")
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
    (await executeStatus({ id: created.id, session_id: "ses_wrong", status: "superseded" }, { sessionID: "ses_delegatee" })).content,
  )
  expect(e1.code).toBe("E_STATUS_REFUSED")
  expect(e1.message).toContain("refused")
  expect(e1.message).toContain("ses_ownerY")
  expect(e1.corrected_call.session_id).toBe("ses_ownerY")
  const retry = JSON.parse((await executeStatus(e1.corrected_call, { sessionID: "ses_delegatee" })).content)
  expect(retry.status).toBe("superseded")
})

test("every validation failure returns {code, message, corrected_call}; each missing param has its stable code", async () => {
  const created = await add("envelope test", "ses_ownerZ")

  const addNoTodo = envelope((await executeAdd({}, {})).content)
  expect(addNoTodo.code).toBe("E_ADD_MISSING_TODO")
  expect(addNoTodo.corrected_call.todo).toContain("<fill:")
  // ticket_add takes NO owner param: without harness context it fails
  // E_ADD_NO_SESSION_ID.
  const addNoSession = envelope((await executeAdd({ todo: "x" }, {})).content)
  expect(addNoSession.code).toBe("E_ADD_NO_SESSION_ID")

  const getNoId = envelope((await executeGet({}, {})).content)
  expect(getNoId.code).toBe("E_GET_MISSING_ID")
  const getMissing = envelope((await executeGet({ id: 424242 }, {})).content)
  expect(getMissing.code).toBe("E_NO_TICKET")

  const listBare = envelope((await executeList({}, {})).content)
  expect(listBare.code).toBe("E_LIST_MISSING_SESSION_ID")
  expect(listBare.message).toContain("all=true")

  const cmtNoId = envelope((await executeComment({ content: "done" }, {})).content)
  expect(cmtNoId.code).toBe("E_COMMENT_MISSING_ID")
  const cmtNoContent = envelope((await executeComment({ id: created.id }, {})).content)
  expect(cmtNoContent.code).toBe("E_COMMENT_MISSING_CONTENT")
  const cmtMissing = envelope((await executeComment({ id: 424242, content: "x" }, {})).content)
  expect(cmtMissing.code).toBe("E_NO_TICKET")

  const stNoId = envelope((await executeStatus({ session_id: "s", status: "pending" }, {})).content)
  expect(stNoId.code).toBe("E_STATUS_MISSING_ID")
  const stNoStatus = envelope((await executeStatus({ id: created.id, session_id: "ses_ownerZ" }, {})).content)
  expect(stNoStatus.code).toBe("E_STATUS_MISSING_STATUS")
  const stBad = envelope(
    (await executeStatus({ id: created.id, session_id: "ses_ownerZ", status: "bogus" }, {})).content,
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
    expect(c.author_session_id).toBe("ses_commenter")
  }
  const got = (await executeGet({ id: created.id }, { sessionID: "ses_anyone" })).content
  expect(got).toContain('"md_content": "# the spec, written once"')
  expect(got).toContain("--- comments (chronological) ---")
  expect(got.indexOf("done")).toBeLessThan(got.indexOf("blocked on env"))
})

test("list: one session by id, status filter combines, all=true lists every session", async () => {
  await add("list a", "ses_listA")
  await add("list b", "ses_listB")
  const mine = JSON.parse((await executeList({ session_id: "ses_listA" }, {})).content)
  expect(mine.length).toBeGreaterThan(0)
  expect(mine.every((r: { session_id: string }) => r.session_id === "ses_listA")).toBe(true)
  const minePending = JSON.parse((await executeList({ session_id: "ses_listA", status: "pending" }, {})).content)
  expect((minePending as any[]).every((r) => r.status === "pending")).toBe(true)
  const everyone = JSON.parse((await executeList({ all: true }, {})).content)
  expect((everyone as any[]).some((r) => r.session_id === "ses_listA")).toBe(true)
  expect((everyone as any[]).some((r) => r.session_id === "ses_listB")).toBe(true)
})

// ─── The contract text ──────────────────────────────────────────────────────

test("help states the whole contract: tools, doctrine, envelope; no action strings", async () => {
  const content = (await executeHelp()).content
  for (const tool of ["ticket_add", "ticket_session_id", "ticket_get", "ticket_list", "ticket_comment", "ticket_status", "ticket_rules", "ticket_help"]) {
    expect(content).toContain(tool)
  }
  expect(content).toContain("session_id IS the opencode session id")
  expect(content).not.toContain("OPENCODE_SESSION_ID") // the env var is dead
  expect(content).toContain("provided by the harness")
  expect(content).toContain("ticket_add fills it in automatically")
  expect(content).toContain("no owner parameter to spell wrongly")
  expect(content).toContain("milestone")
  expect(content).toContain("default unknown")
  expect(content).toContain("NAME the session id the delegatee must use")
  expect(content).toContain("Too simple to get wrong")
  expect(content).toContain("corrected_call")
  expect(content).toContain("IMMUTABLE record")
  expect(content).toContain("one id, no")
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
  // add: todo required, md_content optional; rollout_id is NO LONGER legal
  expect(jtdValidateAdd({ todo: "t" })).toEqual([])
  expect(jtdValidateAdd({ todo: "t", md_content: "m" })).toEqual([])
  expect(jtdValidateAdd({ todo: "t", type: "milestone" })).toEqual([])
  expect(jtdValidateAdd({ todo: "t", type: "bogus" })[0].schemaPath).toBe("/optionalProperties/type/enum")
  expect(jtdValidateAdd({ todo: "t", junk: 1 })).toEqual([{ instancePath: "/junk", schemaPath: "" }])
  expect(jtdValidateAdd({})).toEqual([{ instancePath: "", schemaPath: "/properties/todo" }])
  expect(jtdValidateAdd({ todo: 7 })).toEqual([{ instancePath: "/todo", schemaPath: "/properties/todo/type" }])
  expect(jtdValidateAdd({ todo: "t", rollout_id: "s" })).toEqual([{ instancePath: "/rollout_id", schemaPath: "" }])
  expect(jtdValidateAdd(null)).toEqual([{ instancePath: "", schemaPath: "/properties" }])
  // get: id required, uint32
  expect(jtdValidateGet({ id: 5 })).toEqual([])
  expect(jtdValidateGet({ id: -1 })).toEqual([{ instancePath: "/id", schemaPath: "/properties/id/type" }])
  expect(jtdValidateGet({ id: 1.5 })).toEqual([{ instancePath: "/id", schemaPath: "/properties/id/type" }])
  // list: all optional individually
  expect(jtdValidateList({})).toEqual([])
  expect(jtdValidateList({ session_id: "s", status: "pending", type: "task", types: ["bug"], include_deleted: true, all: true })).toEqual([])
  expect(jtdValidateList({ types: "oops" })[0].schemaPath).toBe("/optionalProperties/types/elements/type")
  expect(jtdValidateList({ include_deleted: "yes" })[0].schemaPath).toBe("/optionalProperties/include_deleted/type")
  expect(jtdValidateList({ status: "bogus" }))[0]
  expect(jtdValidateList({ status: "bogus" })[0].schemaPath).toBe("/optionalProperties/status/enum")
  // comment: id+content required
  expect(jtdValidateComment({ id: 1, content: "done" })).toEqual([])
  expect(jtdValidateComment({ content: "done" })[0].schemaPath).toBe("/properties/id")
  // status: id+session_id+status required, status enum enforced
  expect(jtdValidateStatus({ id: 1, session_id: "s", status: "superseded" })).toEqual([])
  expect(jtdValidateStatus({ id: 1, session_id: "s", status: "bogus" })[0].schemaPath).toBe("/properties/status/enum")
  expect(jtdValidateStatus({ id: 1, status: "pending" })[0].schemaPath).toBe("/properties/session_id")
  // none: rules/help/session take no params at all
  expect(jtdValidateNone({})).toEqual([])
  expect(jtdValidateNone({ junk: 1 })).toEqual([{ instancePath: "/junk", schemaPath: "" }])
  // an explicitly-undefined key is ABSENT in JSON semantics — never a type error
  expect(jtdValidateAdd({ todo: "t", md_content: undefined })).toEqual([])
  expect(jtdValidateStatus({ id: undefined, session_id: "s", status: "pending" })[0].schemaPath).toBe("/properties/id")
})

test("the RFC 8927 sets and the harness-facing JSON Schema declare the same legal params", () => {
  expect(Object.keys(ADD_JTD.properties).sort()).toEqual(ADD_INPUT.required.slice().sort())
  expect(Object.keys(GET_JTD.properties).sort()).toEqual(GET_INPUT.required.slice().sort())
  expect(Object.keys(COMMENT_JTD.properties).sort()).toEqual(COMMENT_INPUT.required.slice().sort())
  expect(Object.keys(STATUS_JTD.properties).sort()).toEqual(STATUS_INPUT.required.slice().sort())
  expect(Object.keys(ADD_JTD.optionalProperties!).sort()).toEqual(["md_content", "type"])
  expect(Object.keys(LIST_JTD.optionalProperties!).sort()).toEqual(Object.keys(LIST_INPUT.properties).sort())
  expect(STATUS_JTD.properties.status.enum).toEqual(["pending", "in_progress", "completed", "cancelled", "superseded"])
  expect(COMMENT_INPUT.properties.content.maxLength).toBe(1000)
})

test("GREEN TARGET: a junk parameter is rejected before the store — E_ADD_EXTRA_PROPERTY, zero side effects", async () => {
  const before = JSON.parse((await executeList({ all: true }, {})).content).length
  // 'before' is the historic junk param models used to inject
  const e = envelope((await executeAdd({ todo: "t", before: "2020-01-01" }, {})).content)
  expect(e.code).toBe("E_ADD_EXTRA_PROPERTY")
  expect(e.message).toContain("'before' is not a legal parameter")
  const after = JSON.parse((await executeList({ all: true }, {})).content).length
  expect(after).toBe(before) // rejected BEFORE the store: nothing was created
})

test("GREEN TARGET: passing a session id to ticket_add is rejected — the env is the owner (E_ADD_EXTRA_PROPERTY, zero side effects)", async () => {
  const before = JSON.parse((await executeList({ all: true }, {})).content).length
  const e = envelope((await executeAdd({ todo: "t", rollout_id: "ses_handrolled" }, {})).content)
  expect(e.code).toBe("E_ADD_EXTRA_PROPERTY")
  expect(e.message).toContain("'rollout_id' is not a legal parameter")
  const after = JSON.parse((await executeList({ all: true }, {})).content).length
  expect(after).toBe(before) // rejected BEFORE the store: nothing was created
})

test("ticket_add derives the owner from context.sessionID — no owner param", async () => {
  const created = await add("env owner test", "ses_envowner")
  expect(created.session_id).toBe("ses_envowner")
  expect(created.ticket.session_id).toBe("ses_envowner")
  expect(created.id).toBeGreaterThan(0)
})

test("context.sessionID is the sole owner source — the OPENCODE_SESSION_ID env var is dead", async () => {
  process.env.OPENCODE_SESSION_ID = "ses_envghost"
  try {
    // no context -> error even though the env var is set
    expect(envelope((await executeAdd({ todo: "x" }, {})).content).code).toBe("E_ADD_NO_SESSION_ID")
    expect(envelope((await executeSession({}, {})).content).code).toBe("E_SESSION_NO_ID")
    // context wins over any env value
    const created = JSON.parse((await executeAdd({ todo: "env ignored" }, { sessionID: "ses_ctxowner" })).content)
    expect(created.session_id).toBe("ses_ctxowner")
    expect(created.ticket.session_id).toBe("ses_ctxowner")
    const sid = JSON.parse((await executeSession({}, { sessionID: "ses_ctxowner" })).content)
    expect(sid.session_id).toBe("ses_ctxowner")
  } finally {
    delete process.env.OPENCODE_SESSION_ID
  }
})

test("migration: the type column + index exist (idempotent), default 'unknown', explicit set, invalid rejects", () => {
  const store = new TicketStore(ticketDbPath())
  const db = (store as any).db
  const cols = (db.query("PRAGMA table_info(ticket)").all() as any[]).map((r: any) => r.name)
  expect(cols).toContain("type")
  const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ticket' AND name='idx_ticket_type'").get()
  expect(idx).toBeTruthy()
  const a = store.add({ todo: "type-default", rollout_id: "ses_type" })
  expect(a.type).toBe("unknown")
  const b = store.add({ todo: "type-milestone", rollout_id: "ses_type", type: "milestone" })
  expect(b.type).toBe("milestone")
  expect(() => store.add({ todo: "x", rollout_id: "ses_type", type: "bogus" })).toThrow(/type must be one of/)
  // idempotent: a second constructor on the same DB is a no-op
  const store2 = new TicketStore(ticketDbPath())
  store2.close()
  store.close()
})

test("ticket_add optional type: default unknown, explicit stored, bad type → E_ADD_BAD_TYPE", async () => {
  const created = JSON.parse((await executeAdd({ todo: "typed", type: "milestone" }, { sessionID: "ses_type2" })).content)
  expect(created.ticket.type).toBe("milestone")
  const plain = JSON.parse((await executeAdd({ todo: "untyped" }, { sessionID: "ses_type2" })).content)
  expect(plain.ticket.type).toBe("unknown")
  const e = envelope((await executeAdd({ todo: "t", type: "bogus" }, { sessionID: "ses_type2" })).content)
  expect(e.code).toBe("E_ADD_BAD_TYPE")
})

test("ticket_list filters by type and types (multi); combines with status", async () => {
  const typed = async (todo: string, type: string) =>
    JSON.parse((await executeAdd({ todo, type }, { sessionID: "ses_types" })).content)
  await typed("t-milestone", "milestone")
  await typed("t-task", "task")
  await typed("t-bug", "bug")
  const ms = JSON.parse((await executeList({ session_id: "ses_types", type: "milestone" }, {})).content)
  expect(ms.map((r: any) => r.todo)).toEqual(["t-milestone"])
  const multi = JSON.parse((await executeList({ session_id: "ses_types", types: ["task", "bug"] }, {})).content)
  expect(new Set(multi.map((r: any) => r.todo))).toEqual(new Set(["t-task", "t-bug"]))
  const plusStatus = JSON.parse((await executeList({ session_id: "ses_types", types: ["task", "bug"], status: "pending" }, {})).content)
  expect(plusStatus.length).toBe(2)
})

test("migration: the deleted column exists with default 0", () => {
  const store = new TicketStore(ticketDbPath())
  const db = (store as any).db
  const cols = (db.query("PRAGMA table_info(ticket)").all() as any[]).map((r: any) => r.name)
  expect(cols).toContain("deleted")
  const fresh = store.add({ todo: "sd-default", rollout_id: "ses_sd2" })
  expect(fresh.deleted).toBe(0)
  store.close()
})

test("soft delete: superseding marks the old ticket deleted; lists hide it unless include_deleted", async () => {
  const created = await add("supersede-target", "ses_sd")
  const upd = JSON.parse((await executeStatus({ id: created.id, session_id: "ses_sd", status: "superseded" }, {})).content)
  expect(upd.status).toBe("superseded")
  expect(upd.deleted).toBe(1)
  // hidden by default, also under all=true
  const normal = JSON.parse((await executeList({ session_id: "ses_sd" }, {})).content)
  expect(normal.some((r: any) => r.id === created.id)).toBe(false)
  const everything = JSON.parse((await executeList({ all: true }, {})).content)
  expect(everything.some((r: any) => r.id === created.id)).toBe(false)
  // include_deleted reveals it
  const withDeleted = JSON.parse((await executeList({ session_id: "ses_sd", include_deleted: true }, {})).content)
  expect(withDeleted.some((r: any) => r.id === created.id)).toBe(true)
})

test("ticket_session_id returns the current session id from context; without context it fails E_SESSION_NO_ID", async () => {
  const res = JSON.parse((await executeSession({}, { sessionID: "ses_sessionprobe" })).content)
  expect(res.session_id).toBe("ses_sessionprobe")
  const missing = envelope((await executeSession({}, {})).content)
  expect(missing.code).toBe("E_SESSION_NO_ID")
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
  const e = envelope((await executeStatus({ id: created.id, session_id: "ses_enum", status: "bogus" }, {})).content)
  expect(e.code).toBe("E_STATUS_BAD_STATUS")
  expect(e.message).toContain("is not one of the legal values")
  expect(e.message).toContain("pending|in_progress|completed|cancelled|superseded")
  // corrected_call is legal: verbatim re-emit succeeds
  const retry = JSON.parse((await executeStatus(e.corrected_call, { sessionID: "ses_enum" })).content)
  expect(retry.status).toBe("pending")
})

test("GREEN TARGET: a missing required param is rejected by JTD with the stable code — E_STATUS_MISSING_STATUS", async () => {
  const created = await add("jtd missing test", "ses_jtdm")
  const e = envelope((await executeStatus({ id: created.id, session_id: "ses_jtdm" }, {})).content)
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
