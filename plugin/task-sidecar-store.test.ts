// task-sidecar-store.test.ts — bun:test coverage for the cold task store:
// sequencer ids, rollout namespacing (ownership, purge scope, mirror scope),
// soft delete (never hard-delete), purge/list_since, the fat record living IN
// the DB, and migration from the legacy v0.0.2 todo_ng.db and v0.0.3/v0.0.5
// schemas.
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { TaskSidecarStore, taskSidecarDbPath, legacyTodoNgDbPath, LEGACY_ROLLOUT } from "./task-sidecar-store"

let home: string

const ROLL_A = "ses_rolloutaaaaaaaaaa"
const ROLL_B = "ses_rolloutbbbbbbbbbb"
const ROLL_C = "ses_rolloutcccccccccc"

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "task-sidecar-test-"))
  process.env.VPS_GRAPEVINE_HOME = home
})

afterEach(() => {
  delete process.env.VPS_GRAPEVINE_HOME
  rmSync(home, { recursive: true, force: true })
})

describe("TaskSidecarStore", () => {
  test("add returns globally-unique autoincrement ids (the sequencer)", () => {
    const s = new TaskSidecarStore()
    const a = s.add({ todo: "first", rollout_id: ROLL_A })
    const b = s.add({ todo: "second", rollout_id: ROLL_A })
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    expect(a.status).toBe("pending")
    expect(a.deleted).toBe(0)
    s.close()
  })

  test("ids continue across store instances (survives restart)", () => {
    const s1 = new TaskSidecarStore()
    s1.add({ todo: "one", rollout_id: ROLL_A })
    s1.close()
    const s2 = new TaskSidecarStore()
    const b = s2.add({ todo: "two", rollout_id: ROLL_A })
    expect(b.id).toBe(2)
    s2.close()
  })

  test("db path is task_sidecar_store.db, NOT todo_ng.db", () => {
    expect(taskSidecarDbPath()).toBe(join(home, "task_sidecar_store.db"))
    expect(legacyTodoNgDbPath()).toBe(join(home, "todo_ng.db"))
  })

  test("get/list skip nothing initially, ascending by id", () => {
    const s = new TaskSidecarStore()
    s.add({ todo: "a", rollout_id: ROLL_A })
    s.add({ todo: "b", rollout_id: ROLL_A })
    const rows = s.list()
    expect(rows.map((r) => r.todo)).toEqual(["a", "b"])
    s.close()
  })

  test("update patches status and keeps the record (cancelled keeps too)", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "work", rollout_id: ROLL_A })
    s.update(r.id, { rollout_id: ROLL_A, status: "cancelled" })
    expect(s.get(r.id)!.status).toBe("cancelled")
    expect(s.get(r.id)!.todo).toBe("work")
    s.close()
  })

  test("linkMd stores the record IN the DB; content round-trips via get with no file on disk", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "spec", rollout_id: ROLL_A })
    const out = s.linkMd(r.id, "# spec body\n\nincluding the issue details", ROLL_A)
    expect(out!.md_content).toBe("# spec body\n\nincluding the issue details")
    expect(s.get(r.id)!.md_content).toBe("# spec body\n\nincluding the issue details")
    // md_path is optional annotation; nothing is written to disk
    expect(out!.md_path).toBeNull()
    s.close()
  })

  test("linkMd accepts md_path as annotation only and never writes it", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "spec", rollout_id: ROLL_A })
    const p = join(home, "tickets", "spec.md")
    const out = s.linkMd(r.id, "# content", ROLL_A, p)
    expect(out!.md_path).toBe(p)
    expect(out!.md_content).toBe("# content")
    expect(existsSync(p)).toBe(false)
    s.close()
  })

  test("add persists md_content supplied by the caller (it is never silently dropped)", () => {
    const s = new TaskSidecarStore()
    const record = "#7 spec\n\nthe full fat record handed to add"
    const r = s.add({ todo: "#7 fix add", rollout_id: ROLL_A, md_content: record })
    expect(r.md_content).toBe(record)
    expect(s.get(r.id)!.md_content).toBe(record)
    // link_md amends it in place afterwards
    expect(s.linkMd(r.id, "# amended", ROLL_A)!.md_content).toBe("# amended")
    s.close()
  })

  test("add without md_content leaves it NULL and md_path untouched", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "bare", rollout_id: ROLL_A })
    expect(r.md_content).toBeNull()
    expect(r.md_path).toBeNull()
    s.close()
  })

  test("invalid status/priority rejected", () => {
    const s = new TaskSidecarStore()
    expect(() => s.add({ todo: "x", rollout_id: ROLL_A, status: "done" })).toThrow(/status must be one of/)
    expect(() => s.add({ todo: "x", rollout_id: ROLL_A, priority: "urgent" })).toThrow(
      /priority must be one of/,
    )
    s.close()
  })

  describe("rollout namespacing", () => {
    test("add requires a rollout_id and records the owner and the observed session", () => {
      const s = new TaskSidecarStore()
      expect(() => s.add({ todo: "x", rollout_id: "" })).toThrow(/requires 'rollout_id'/)
      const r = s.add({ todo: "x", rollout_id: ROLL_A, observed_session: ROLL_A })
      expect(r.rollout_id).toBe(ROLL_A)
      expect(r.observed_session).toBe(ROLL_A)
      expect(r.last_actor).toBe(ROLL_A)
      s.close()
    })

    test("update and linkMd are refused outside the owning namespace, naming the owner", () => {
      const s = new TaskSidecarStore()
      const r = s.add({ todo: "mine", rollout_id: ROLL_A })
      expect(() => s.update(r.id, { rollout_id: ROLL_B, status: "completed" })).toThrow(
        new RegExp(`update refused: row ${r.id} belongs to rollout "${ROLL_A}"`),
      )
      expect(() => s.linkMd(r.id, "# hijack", ROLL_B)).toThrow(/link_md refused/)
      // refused means untouched
      expect(s.get(r.id)!.status).toBe("pending")
      expect(s.get(r.id)!.md_content).toBeNull()
      s.close()
    })

    test("the owner namespace may mutate; last_actor records who really did it", () => {
      const s = new TaskSidecarStore()
      const r = s.add({ todo: "delegated", rollout_id: ROLL_A, observed_session: ROLL_A })
      // a subagent handed the row id amends it by naming the OWNER's uuid
      const out = s.linkMd(r.id, "# subagent report", ROLL_A, undefined, ROLL_B)
      expect(out!.md_content).toBe("# subagent report")
      expect(out!.rollout_id).toBe(ROLL_A)
      expect(out!.last_actor).toBe(ROLL_B)
      s.close()
    })

    test("purge_older_than only soft-deletes the caller's own namespace", () => {
      const s = new TaskSidecarStore()
      const mine = s.add({ todo: "mine old", rollout_id: ROLL_A })
      const theirs = s.add({ todo: "theirs old", rollout_id: ROLL_B })
      s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [
        mine.id,
        theirs.id,
      ])
      expect(s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)).toBe(1)
      expect(s.get(mine.id)).toBeUndefined()
      expect(s.get(mine.id, { include_deleted: true })!.deleted).toBe(1)
      // the other rollout's row is untouched by my purge
      expect(s.get(theirs.id)).toBeDefined()
      expect(() => s.purgeOlderThan("2026-01-01T00:00:00.000Z", "")).toThrow(/requires 'rollout_id'/)
      s.close()
    })

    test("list filters by namespace; reads stay unscoped by default", () => {
      const s = new TaskSidecarStore()
      s.add({ todo: "a", rollout_id: ROLL_A })
      s.add({ todo: "b", rollout_id: ROLL_B })
      expect(s.list().length).toBe(2)
      expect(s.list({ rollout_id: ROLL_B }).map((r) => r.todo)).toEqual(["b"])
      s.close()
    })
  })

  describe("adopting legacy rows", () => {
    test("adopt moves a marker row into the caller's namespace, one way", () => {
      const s = new TaskSidecarStore()
      s.db.run("INSERT INTO task_sidecar (created_at, updated_at, todo, status, md_content) VALUES ('2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','old row','pending','# old record')")
      const legacy = s.list({ rollout_id: LEGACY_ROLLOUT })[0]
      expect(legacy.rollout_id).toBe(LEGACY_ROLLOUT)

      const adopted = s.adopt(legacy.id, ROLL_A, ROLL_A)!
      expect(adopted.rollout_id).toBe(ROLL_A)
      expect(adopted.last_actor).toBe(ROLL_A)
      expect(adopted.observed_session).toBe(ROLL_A)
      // the record survived the transfer and the new owner can now amend it
      expect(adopted.md_content).toBe("# old record")
      expect(s.linkMd(legacy.id, "# amended by the new owner", ROLL_A)!.md_content).toBe(
        "# amended by the new owner",
      )
      s.close()
    })

    test("adopt is refused for a row that already has a real owner, naming them", () => {
      const s = new TaskSidecarStore()
      const r = s.add({ todo: "owned", rollout_id: ROLL_A })
      expect(() => s.adopt(r.id, ROLL_B)).toThrow(new RegExp(`belongs to rollout "${ROLL_A}"`))
      expect(() => s.adopt(r.id, "")).toThrow(/requires 'rollout_id'/)
      expect(s.get(r.id)!.rollout_id).toBe(ROLL_A)
      s.close()
    })
  })

  describe("novating rows between rollouts", () => {
    test("novate transfers a row to another rollout; the record rides along; the mover is stamped", () => {
      const s = new TaskSidecarStore()
      const r = s.add({ todo: "leaked work", rollout_id: ROLL_A, md_content: "# the fat record" })
      // a tidier session names the row's CURRENT owner and the target; the
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
        new RegExp(`update refused: row ${r.id} belongs to rollout "${ROLL_B}"`),
      )
      s.close()
    })

    test("the transfer is real: the old owner's flush can no longer close the row", () => {
      const s = new TaskSidecarStore()
      const r = s.add({ todo: "transferred", rollout_id: ROLL_A })
      s.novate(r.id, ROLL_A, ROLL_B, ROLL_C)
      expect(s.syncStatuses([{ content: `${r.id}: transferred`, status: "completed" }], ROLL_A)).toEqual([])
      expect(s.get(r.id)!.status).toBe("pending")
      // and the new owner's flush DOES close it
      expect(s.syncStatuses([{ content: `${r.id}: transferred`, status: "completed" }], ROLL_B)).toEqual([r.id])
      s.close()
    })

    test("novate from the legacy marker is the general form of adopt", () => {
      const s = new TaskSidecarStore()
      s.db.run(
        "INSERT INTO task_sidecar (created_at, updated_at, todo, status, md_content) VALUES ('2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','marker row','pending','# old record')",
      )
      const legacy = s.list({ rollout_id: LEGACY_ROLLOUT })[0]
      const out = s.novate(legacy.id, LEGACY_ROLLOUT, ROLL_A, ROLL_B)!
      expect(out.rollout_id).toBe(ROLL_A)
      expect(out.md_content).toBe("# old record")
      expect(s.linkMd(legacy.id, "# amended by the new owner", ROLL_A)).toBeDefined()
      s.close()
    })

    test("novate is refused for a wrong owner, the marker target, a same-owner target, and missing args", () => {
      const s = new TaskSidecarStore()
      const r = s.add({ todo: "owned", rollout_id: ROLL_A })
      expect(() => s.novate(r.id, ROLL_B, ROLL_A)).toThrow(
        new RegExp(`novate refused: row ${r.id} belongs to rollout "${ROLL_A}", not "${ROLL_B}"`),
      )
      expect(() => s.novate(r.id, ROLL_A, LEGACY_ROLLOUT)).toThrow(/not an identity/)
      expect(() => s.novate(r.id, ROLL_A, ROLL_A)).toThrow(/already belongs to rollout/)
      expect(() => s.novate(r.id, "", ROLL_B)).toThrow(/requires 'rollout_id'/)
      expect(() => s.novate(r.id, ROLL_A, "")).toThrow(/requires 'to_rollout_id'/)
      // refused means untouched
      expect(s.get(r.id)!.rollout_id).toBe(ROLL_A)
      s.close()
    })

    test("novate of a soft-deleted row is undefined, never a resurrection", () => {
      const s = new TaskSidecarStore()
      const r = s.add({ todo: "gone", rollout_id: ROLL_A })
      s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [r.id])
      s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
      expect(s.novate(r.id, ROLL_A, ROLL_B, ROLL_C)).toBeUndefined()
      expect(s.get(r.id, { include_deleted: true })!.rollout_id).toBe(ROLL_A)
      s.close()
    })
  })

  test("purgeOlderThan LAZY soft deletes only older rows; nothing hard-deleted", () => {
    const s = new TaskSidecarStore()
    const old = s.add({ todo: "old", rollout_id: ROLL_A })
    const fresh = s.add({ todo: "fresh", rollout_id: ROLL_A })
    // rewind the old row's created_at
    s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [old.id])
    const n = s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
    expect(n).toBe(1)
    expect(s.get(old.id)).toBeUndefined()
    expect(s.get(fresh.id)).toBeDefined()
    // still in the store as a soft-deleted record
    expect(s.get(old.id, { include_deleted: true })!.deleted).toBe(1)
    s.close()
  })

  test("listSince respects soft delete; show_deleted includes them", () => {
    const s = new TaskSidecarStore()
    const a = s.add({ todo: "a", rollout_id: ROLL_A })
    const b = s.add({ todo: "b", rollout_id: ROLL_A })
    s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [a.id])
    s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
    const since = s.listSince("2019-01-01T00:00:00.000Z")
    expect(since.map((r) => r.id)).toEqual([b.id])
    const all = s.listSince("2019-01-01T00:00:00.000Z", { show_deleted: true })
    expect(all.map((r) => r.id)).toEqual([a.id, b.id])
    s.close()
  })

  test("update cannot resurrect a soft-deleted row", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "x", rollout_id: ROLL_A })
    s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [r.id])
    s.purgeOlderThan("2026-01-01T00:00:00.000Z", ROLL_A)
    expect(s.update(r.id, { rollout_id: ROLL_A, status: "completed" })).toBeUndefined()
    s.close()
  })

  test("migrates legacy todo_ng.db rows into a fresh store (legacy file untouched)", () => {
    const legacyPath = legacyTodoNgDbPath()
    const legacy = new Database(legacyPath)
    legacy.exec(`CREATE TABLE IF NOT EXISTS todo_ng (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      todo TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      session_id TEXT, md_path TEXT);`)
    legacy.run("INSERT INTO todo_ng (created_at, updated_at, todo, status) VALUES ('2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','legacy task','pending')")
    legacy.close()
    const s = new TaskSidecarStore()
    const migrated = s.get(1)
    expect(migrated!.todo).toBe("legacy task")
    expect(migrated!.deleted).toBe(0)
    // pre-namespacing rows carry the legacy marker, never a real uuid
    expect(migrated!.rollout_id).toBe(LEGACY_ROLLOUT)
    // sequencer continues after migrated max id
    expect(s.add({ todo: "next", rollout_id: ROLL_A }).id).toBe(2)
    // legacy file still on disk
    expect(new Database(legacyPath).query("SELECT COUNT(*) AS n FROM todo_ng").get()).toEqual({ n: 1 })
    s.close()
  })

  test("v0.0.3 store (disk-only records) migrates: md_content column added and backfilled from md_path files", () => {
    // build an OLD-schema DB by hand, the way v0.0.3 left it
    const dbPath = join(home, "task_sidecar_store.db")
    const old = new Database(dbPath)
    old.exec(`CREATE TABLE task_sidecar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        todo TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT, md_path TEXT,
        deleted INTEGER NOT NULL DEFAULT 0);`)
    old.run(
      "INSERT INTO task_sidecar (created_at, updated_at, todo, status, md_path) VALUES ('2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','disk ticket','pending', ?)",
      [join(home, "tickets", "old-spec.md")],
    )
    old.close()
    mkdirSync(join(home, "tickets"), { recursive: true })
    writeFileSync(join(home, "tickets", "old-spec.md"), "# the old fat record")

    // opening with the new store migrates: column added, content backfilled
    const s = new TaskSidecarStore(dbPath)
    const row = s.get(1)!
    expect(row.md_content).toBe("# the old fat record")
    expect(row.rollout_id).toBe(LEGACY_ROLLOUT)
    // and a missing file leaves the row intact with NULL content
    s.linkMd(1, "# amended in place", LEGACY_ROLLOUT)
    expect(s.get(1)!.md_content).toBe("# amended in place")
    s.close()
  })

  test("v0.0.5 store (unnamespaced rows) migrates: rollout columns added, every row marked legacy", () => {
    const dbPath = join(home, "task_sidecar_store.db")
    const old = new Database(dbPath)
    old.exec(`CREATE TABLE task_sidecar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        todo TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT, md_path TEXT, md_content TEXT,
        deleted INTEGER NOT NULL DEFAULT 0);`)
    for (const todo of ["one", "two"]) {
      old.run(
        "INSERT INTO task_sidecar (created_at, updated_at, todo, status, md_content) VALUES ('2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',?,'pending',?)",
        [todo, `# ${todo} record`],
      )
    }
    old.close()

    const s = new TaskSidecarStore(dbPath)
    const rows = s.list()
    expect(rows.map((r) => r.rollout_id)).toEqual([LEGACY_ROLLOUT, LEGACY_ROLLOUT])
    expect(rows.map((r) => r.observed_session)).toEqual([null, null])
    // content survived the migration
    expect(rows[0]!.md_content).toBe("# one record")
    // update never transfers ownership: a marker row stays in the marker until adopt
    expect(() => s.update(1, { rollout_id: ROLL_A, status: "completed" })).toThrow(
      new RegExp(`belongs to rollout "${LEGACY_ROLLOUT}"`),
    )
    expect(s.get(1)!.status).toBe("pending")
    // the marker is a namespace you can name for a read, nothing more
    expect(s.list({ rollout_id: LEGACY_ROLLOUT }).length).toBe(2)
    s.close()
  })

  describe("todowrite mirror", () => {
    test("mirrors flushed item statuses onto the flushing session's own 'N:' rows", () => {
      const s = new TaskSidecarStore()
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

    test("one session's flush can never close another session's row", () => {
      const s = new TaskSidecarStore()
      const mine = s.add({ todo: "mine", rollout_id: ROLL_A })
      const theirs = s.add({ todo: "theirs", rollout_id: ROLL_B })
      const changed = s.syncStatuses(
        [
          { content: `${mine.id}: mine`, status: "completed" },
          // a bare id prefix matching a row owned by ANOTHER rollout
          { content: `${theirs.id}: not mine to close`, status: "completed" },
        ],
        ROLL_A,
      )
      expect(changed).toEqual([mine.id])
      expect(s.get(mine.id)!.status).toBe("completed")
      expect(s.get(theirs.id)!.status).toBe("pending")
      s.close()
    })

    test("syncStatuses touches only referenced rows and ignores junk", () => {
      const s = new TaskSidecarStore()
      const a = s.add({ todo: "referenced", rollout_id: ROLL_A })
      const b = s.add({ todo: "parked, not in the flush", rollout_id: ROLL_A })
      s.update(b.id, { rollout_id: ROLL_A, status: "in_progress" })
      const changed = s.syncStatuses(
        [
          { content: `${a.id}: referenced`, status: "completed" },
          // no "N:" prefix: slug-style items carry no sidecar id
          { content: "item03: legacy slug style", status: "completed" },
          // unknown id: silently ignored
          { content: "999: no such row", status: "completed" },
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
      // unreferenced row untouched
      expect(s.get(b.id)!.status).toBe("in_progress")
      // flushing the same status again changes nothing
      expect(s.syncStatuses([{ content: `${a.id}: referenced`, status: "completed" }], ROLL_A)).toEqual([])
      s.close()
    })

    test("syncStatuses never resurrects soft-deleted rows", () => {
      const s = new TaskSidecarStore()
      const a = s.add({ todo: "already closed", rollout_id: ROLL_A })
      s.update(a.id, { rollout_id: ROLL_A, status: "cancelled" })
      const changed = s.syncStatuses([{ content: `${a.id}: already closed`, status: "completed" }], ROLL_A)
      expect(changed).toEqual([a.id])
      expect(s.get(a.id)!.status).toBe("completed")
      expect(s.get(a.id)!.deleted).toBe(0)
      s.close()
    })

    test("syncStatuses demands the flushing session's rollout id", () => {
      const s = new TaskSidecarStore()
      expect(() => s.syncStatuses([{ content: "1: x", status: "completed" }], "")).toThrow(
        /requires the flushing session/,
      )
      s.close()
    })
  })
})
