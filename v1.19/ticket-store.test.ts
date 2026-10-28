// ticket-store.test.ts — bun:test coverage for the ticket database:
// sequencer ids, rollout namespacing (ownership, purge scope, mirror scope),
// soft delete (never hard-delete), purge/list_since, the fat record living IN
// the DB, and transfer between rollouts via novate.
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TicketStore, ticketDbPath } from "../v2.2/lib/ticket-store"
import { Database } from "bun:sqlite"

// raw reaches the store's private database handle for test setup only
// (rewinding created_at etc.); production code never does this.
const raw = (s: TicketStore): Database => (s as unknown as { db: Database }).db

let home: string

const ROLL_A = "ses_rolloutaaaaaaaaaa"
const ROLL_B = "ses_rolloutbbbbbbbbbb"
const ROLL_C = "ses_rolloutcccccccccc"

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ticket-test-"))
  process.env.TICKET_DB_HOME = home
})

afterEach(() => {
  delete process.env.TICKET_DB_HOME
  rmSync(home, { recursive: true, force: true })
})

describe("TicketStore", () => {
  test("add returns globally-unique autoincrement ticket numbers (the sequencer)", () => {
    const s = new TicketStore()
    const a = s.add({ todo: "first", rollout_id: ROLL_A })
    const b = s.add({ todo: "second", rollout_id: ROLL_A })
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    expect(a.status).toBe("pending")
    expect(a.deleted).toBe(0)
    s.close()
  })

  test("ticket numbers continue across store instances (survives restart)", () => {
    const s1 = new TicketStore()
    s1.add({ todo: "one", rollout_id: ROLL_A })
    s1.close()
    const s2 = new TicketStore()
    const b = s2.add({ todo: "two", rollout_id: ROLL_A })
    expect(b.id).toBe(2)
    s2.close()
  })

  test("default db path is ~/.config/opencode/opencode_ticketing/ticket.db", () => {
    delete process.env.TICKET_DB_HOME
    expect(ticketDbPath()).toBe(
      join(process.env.HOME!, ".config", "opencode", "opencode_ticketing", "ticket.db"),
    )
    process.env.TICKET_DB_HOME = home
    expect(ticketDbPath()).toBe(join(home, "ticket.db"))
  })

  test("get/list skip nothing initially, ascending by id", () => {
    const s = new TicketStore()
    s.add({ todo: "a", rollout_id: ROLL_A })
    s.add({ todo: "b", rollout_id: ROLL_A })
    const rows = s.list()
    expect(rows.map((r) => r.todo)).toEqual(["a", "b"])
    s.close()
  })

  test("update patches status and keeps the record (cancelled keeps too)", () => {
    const s = new TicketStore()
    const r = s.add({ todo: "work", rollout_id: ROLL_A })
    s.update(r.id, { rollout_id: ROLL_A, status: "cancelled" })
    expect(s.get(r.id)!.status).toBe("cancelled")
    expect(s.get(r.id)!.todo).toBe("work")
    s.close()
  })

  test("linkMd stores the record IN the DB; content round-trips via get with no file on disk", () => {
    const s = new TicketStore()
    const r = s.add({ todo: "spec", rollout_id: ROLL_A })
    const out = s.linkMd(r.id, "# spec body\n\nincluding the issue details", ROLL_A)
    expect(out!.md_content).toBe("# spec body\n\nincluding the issue details")
    expect(s.get(r.id)!.md_content).toBe("# spec body\n\nincluding the issue details")
    // md_path is optional annotation; nothing is written to disk
    expect(out!.md_path).toBeNull()
    s.close()
  })

  test("linkMd accepts md_path as annotation only and never writes it", () => {
    const s = new TicketStore()
    const r = s.add({ todo: "spec", rollout_id: ROLL_A })
    const p = join(home, "tickets", "007_spec.md")
    const out = s.linkMd(r.id, "# content", ROLL_A, p)
    expect(out!.md_path).toBe(p)
    expect(out!.md_content).toBe("# content")
    expect(existsSync(p)).toBe(false)
    s.close()
  })

  test("add persists md_content supplied by the caller (it is never silently dropped)", () => {
    const s = new TicketStore()
    const record = "#7 spec\n\nthe full fat record handed to add"
    const r = s.add({ todo: "#7 fix add", rollout_id: ROLL_A, md_content: record })
    expect(r.md_content).toBe(record)
    expect(s.get(r.id)!.md_content).toBe(record)
    // link_md amends it in place afterwards
    expect(s.linkMd(r.id, "# amended", ROLL_A)!.md_content).toBe("# amended")
    s.close()
  })

  test("add without md_content leaves it NULL and md_path untouched", () => {
    const s = new TicketStore()
    const r = s.add({ todo: "bare", rollout_id: ROLL_A })
    expect(r.md_content).toBeNull()
    expect(r.md_path).toBeNull()
    s.close()
  })

  test("invalid status/priority rejected", () => {
    const s = new TicketStore()
    expect(() => s.add({ todo: "x", rollout_id: ROLL_A, status: "done" })).toThrow(/status must be one of/)
    expect(() => s.add({ todo: "x", rollout_id: ROLL_A, priority: "urgent" })).toThrow(
      /priority must be one of/,
    )
    s.close()
  })

  describe("rollout namespacing", () => {
    test("add requires a rollout_id and records the owner and the observed session", () => {
      const s = new TicketStore()
      expect(() => s.add({ todo: "x", rollout_id: "" })).toThrow(/requires 'rollout_id'/)
      const r = s.add({ todo: "x", rollout_id: ROLL_A, observed_session: ROLL_A })
      expect(r.rollout_id).toBe(ROLL_A)
      expect(r.observed_session).toBe(ROLL_A)
      expect(r.last_actor).toBe(ROLL_A)
      s.close()
    })

    test("update and linkMd are refused outside the owning namespace, naming the owner", () => {
      const s = new TicketStore()
      const r = s.add({ todo: "mine", rollout_id: ROLL_A })
      expect(() => s.update(r.id, { rollout_id: ROLL_B, status: "completed" })).toThrow(
        new RegExp(`update refused: ticket ${r.id} belongs to rollout "${ROLL_A}"`),
      )
      expect(() => s.linkMd(r.id, "# hijack", ROLL_B)).toThrow(/link_md refused/)
      // refused means untouched
      expect(s.get(r.id)!.status).toBe("pending")
      expect(s.get(r.id)!.md_content).toBeNull()
      s.close()
    })

    test("the owner namespace may mutate; last_actor records who really did it", () => {
      const s = new TicketStore()
      const r = s.add({ todo: "delegated", rollout_id: ROLL_A, observed_session: ROLL_A })
      // a subagent handed the ticket number amends it by naming the OWNER's uuid
      const out = s.linkMd(r.id, "# subagent report", ROLL_A, undefined, ROLL_B)
      expect(out!.md_content).toBe("# subagent report")
      expect(out!.rollout_id).toBe(ROLL_A)
      expect(out!.last_actor).toBe(ROLL_B)
      s.close()
    })

    test("purge_older_than only soft-deletes the caller's own namespace", () => {
      const s = new TicketStore()
      const mine = s.add({ todo: "mine old", rollout_id: ROLL_A })
      const theirs = s.add({ todo: "theirs old", rollout_id: ROLL_B })
      raw(s).run("UPDATE ticket SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [
        mine.id,
        theirs.id,
      ])
      expect(s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)).toBe(1)
      expect(s.get(mine.id)).toBeUndefined()
      expect(s.get(mine.id, { include_deleted: true })!.deleted).toBe(1)
      // the other rollout's ticket is untouched by my purge
      expect(s.get(theirs.id)).toBeDefined()
      expect(() => s.purgeOlderThan("2026-01-01T00:00:00.000Z", "")).toThrow(/requires 'rollout_id'/)
      s.close()
    })

    test("list filters by namespace; reads stay unscoped by default", () => {
      const s = new TicketStore()
      s.add({ todo: "a", rollout_id: ROLL_A })
      s.add({ todo: "b", rollout_id: ROLL_B })
      expect(s.list().length).toBe(2)
      expect(s.list({ rollout_id: ROLL_B }).map((r) => r.todo)).toEqual(["b"])
      s.close()
    })
  })

  describe("novating tickets between rollouts", () => {
    test("novate transfers a ticket to another rollout; the record rides along; the mover is stamped", () => {
      const s = new TicketStore()
      const r = s.add({ todo: "leaked work", rollout_id: ROLL_A, md_content: "# the fat record" })
      // a tidier session names the ticket's CURRENT owner and the target; the
      // mover (ROLL_C) is neither owner nor target and is stamped last_actor
      const out = s.novate(r.id, ROLL_A, ROLL_B, ROLL_C)!
      expect(out.rollout_id).toBe(ROLL_B)
      expect(out.last_actor).toBe(ROLL_C)
      expect(out.todo).toBe("leaked work")
      expect(out.md_content).toBe("# the fat record")
      // the new owner mutates; the old owner is now refused, naming the new one
      expect(s.linkMd(r.id, "# amended by the new owner", ROLL_B)!.md_content).toBe(
        "# amended by the new owner",
      )
      expect(() => s.update(r.id, { rollout_id: ROLL_A, status: "completed" })).toThrow(
        new RegExp(`update refused: ticket ${r.id} belongs to rollout "${ROLL_B}"`),
      )
      s.close()
    })

    test("the transfer is real: the old owner's flush can no longer close the ticket", () => {
      const s = new TicketStore()
      const r = s.add({ todo: "transferred", rollout_id: ROLL_A })
      s.novate(r.id, ROLL_A, ROLL_B, ROLL_C)
      expect(s.syncStatuses([{ content: `${r.id}: transferred`, status: "completed" }], ROLL_A)).toEqual([])
      expect(s.get(r.id)!.status).toBe("pending")
      // and the new owner's flush DOES close it
      expect(s.syncStatuses([{ content: `${r.id}: transferred`, status: "completed" }], ROLL_B)).toEqual([r.id])
      s.close()
    })

    test("novate is refused for a wrong owner, a same-owner target, and missing args", () => {
      const s = new TicketStore()
      const r = s.add({ todo: "owned", rollout_id: ROLL_A })
      expect(() => s.novate(r.id, ROLL_B, ROLL_A)).toThrow(
        new RegExp(`novate refused: ticket ${r.id} belongs to rollout "${ROLL_A}", not "${ROLL_B}"`),
      )
      expect(() => s.novate(r.id, ROLL_A, ROLL_A)).toThrow(/already belongs to rollout/)
      expect(() => s.novate(r.id, "", ROLL_B)).toThrow(/requires 'rollout_id'/)
      expect(() => s.novate(r.id, ROLL_A, "")).toThrow(/requires 'to_rollout_id'/)
      // refused means untouched
      expect(s.get(r.id)!.rollout_id).toBe(ROLL_A)
      s.close()
    })

    test("novate of a soft-deleted ticket is undefined, never a resurrection", () => {
      const s = new TicketStore()
      const r = s.add({ todo: "gone", rollout_id: ROLL_A })
      raw(s).run("UPDATE ticket SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [r.id])
      s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
      expect(s.novate(r.id, ROLL_A, ROLL_B, ROLL_C)).toBeUndefined()
      expect(s.get(r.id, { include_deleted: true })!.rollout_id).toBe(ROLL_A)
      s.close()
    })
  })

  test("purgeOlderThan LAZY soft deletes only older tickets; nothing hard-deleted", () => {
    const s = new TicketStore()
    const old = s.add({ todo: "old", rollout_id: ROLL_A })
    const fresh = s.add({ todo: "fresh", rollout_id: ROLL_A })
    // rewind the old ticket's created_at
    raw(s).run("UPDATE ticket SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [old.id])
    const n = s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
    expect(n).toBe(1)
    expect(s.get(old.id)).toBeUndefined()
    expect(s.get(fresh.id)).toBeDefined()
    // still in the store as a soft-deleted record
    expect(s.get(old.id, { include_deleted: true })!.deleted).toBe(1)
    s.close()
  })

  test("listSince respects soft delete; show_deleted includes them", () => {
    const s = new TicketStore()
    const a = s.add({ todo: "a", rollout_id: ROLL_A })
    const b = s.add({ todo: "b", rollout_id: ROLL_A })
    raw(s).run("UPDATE ticket SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [a.id])
    s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
    const since = s.listSince("2019-01-01T00:00:00.000Z")
    expect(since.map((r) => r.id)).toEqual([b.id])
    const all = s.listSince("2019-01-01T00:00:00.000Z", { show_deleted: true })
    expect(all.map((r) => r.id)).toEqual([a.id, b.id])
    s.close()
  })

  test("update cannot resurrect a soft-deleted ticket", () => {
    const s = new TicketStore()
    const r = s.add({ todo: "x", rollout_id: ROLL_A })
    raw(s).run("UPDATE ticket SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [r.id])
    s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
    expect(s.update(r.id, { rollout_id: ROLL_A, status: "completed" })).toBeUndefined()
    s.close()
  })

  describe("todowrite mirror", () => {
    test("mirrors flushed item statuses onto the flushing session's own 'N:' tickets", () => {
      const s = new TicketStore()
      const a = s.add({ todo: "delegated work", rollout_id: ROLL_A })
      const b = s.add({ todo: "other work", rollout_id: ROLL_A })
      const changed = s.syncStatuses(
        [
          { content: `${a.id}: delegated work`, status: "completed" },
          { content: `${b.id}. other work`, status: "in_progress" },
        ],
        ROLL_A,
      )
      expect(changed).toEqual([a.id, b.id])
      expect(s.get(a.id)!.status).toBe("completed")
      expect(s.get(b.id)!.status).toBe("in_progress")
      s.close()
    })

    test("one session's flush can never close another session's ticket", () => {
      const s = new TicketStore()
      const mine = s.add({ todo: "mine", rollout_id: ROLL_A })
      const theirs = s.add({ todo: "theirs", rollout_id: ROLL_B })
      const changed = s.syncStatuses(
        [
          { content: `${mine.id}: mine`, status: "completed" },
          // a bare id prefix matching a ticket owned by ANOTHER rollout
          { content: `${theirs.id}: not mine to close`, status: "completed" },
        ],
        ROLL_A,
      )
      expect(changed).toEqual([mine.id])
      expect(s.get(mine.id)!.status).toBe("completed")
      expect(s.get(theirs.id)!.status).toBe("pending")
      s.close()
    })

    test("syncStatuses touches only referenced tickets and ignores junk", () => {
      const s = new TicketStore()
      const a = s.add({ todo: "referenced", rollout_id: ROLL_A })
      const b = s.add({ todo: "parked, not in the flush", rollout_id: ROLL_A })
      s.update(b.id, { rollout_id: ROLL_A, status: "in_progress" })
      const changed = s.syncStatuses(
        [
          { content: `${a.id}: referenced`, status: "completed" },
          // no "N:" prefix: slug-style items carry no ticket number
          { content: "item03: legacy slug style", status: "completed" },
          // unknown number: silently ignored
          { content: "999: no such ticket", status: "completed" },
          // invalid status: ignored
          { content: `${a.id}: referenced`, status: "archived" },
          // malformed entries: ignored, never throw
          null as never,
          {},
        ],
        ROLL_A,
      )
      expect(changed).toEqual([a.id])
      expect(s.get(a.id)!.status).toBe("completed")
      // unreferenced ticket untouched
      expect(s.get(b.id)!.status).toBe("in_progress")
      // flushing the same status again changes nothing
      expect(s.syncStatuses([{ content: `${a.id}: referenced`, status: "completed" }], ROLL_A)).toEqual([])
      s.close()
    })

    test("syncStatuses never resurrects soft-deleted tickets", () => {
      const s = new TicketStore()
      const a = s.add({ todo: "already closed", rollout_id: ROLL_A })
      s.update(a.id, { rollout_id: ROLL_A, status: "cancelled" })
      const changed = s.syncStatuses([{ content: `${a.id}: already closed`, status: "completed" }], ROLL_A)
      expect(changed).toEqual([a.id])
      expect(s.get(a.id)!.status).toBe("completed")
      expect(s.get(a.id)!.deleted).toBe(0)
      s.close()
    })

    test("syncStatuses demands the flushing session's rollout id", () => {
      const s = new TicketStore()
      expect(() => s.syncStatuses([{ content: "1: x", status: "completed" }], "")).toThrow(
        /requires the flushing session/,
      )
      s.close()
    })
  })
})
