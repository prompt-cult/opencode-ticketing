// task-sidecar-store — durable task detail store backed by a SQLite sidecar.
// THIS IS NOT A TODO LIST. The built-in todowrite list is the hot, ordered
// todo list. This store is COLD storage: the fat record (living md docs) for
// each task, plus the GLOBAL SEQUENCER (its autoincrement id is the only
// global task number). Access pattern: insert one row, read one row, lazy
// soft delete — rows are never hard-deleted. Framework-free (bun:sqlite +
// node:fs) so it can be unit-tested with bun:test without loading opencode.
// The plugin wrapper in task-sidecar.ts is the only consumer.
//
// v0.0.4: the fat record's CONTENT lives IN the DB (md_content column).
// md_path is a legacy/annotation field only — the DB is the authoritative
// record and no handoff may pass a disk path as the transport.
//
// v0.0.6: every row is NAMESPACED to the rollout that owns it (rollout_id,
// NOT NULL). The destructive actions — update, link_md, purge_older_than —
// are reachable only inside the caller's own namespace, and the todowrite
// mirror closes only the flushing session's rows. The plugin stamps
// observed_session / last_actor from the harness-reported sessionID, so the
// audit trail is ground truth and never caller input.
//
// v0.0.7: novate — the general ownership transfer between real namespaces
// (adopt's generalisation). Rows parked in dead or superseded rollouts are
// tidied by naming the row's recorded owner uuid and the target rollout;
// the mover is stamped in the audit trail, the record rides along intact.
import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface TaskSidecarRow {
  id: number
  created_at: string
  updated_at: string
  todo: string
  status: string
  priority: string
  session_id: string | null
  rollout_id: string
  observed_session: string | null
  last_actor: string | null
  md_path: string | null
  md_content: string | null
  deleted: number
}

// LEGACY_ROLLOUT is the namespace of every row created before v0.0.6. It is a
// marker, never an identity: pass your real rollout uuid, not this.
export const LEGACY_ROLLOUT = "0"

export interface AddInput {
  todo: string
  rollout_id: string
  status?: string
  priority?: string
  session_id?: string | null
  md_content?: string | null
  observed_session?: string | null
}

export interface UpdateInput {
  rollout_id: string
  todo?: string
  status?: string
  priority?: string
  session_id?: string | null
  last_actor?: string | null
}

export interface ListFilter {
  rollout_id?: string
  status?: string
  show_deleted?: boolean
}

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"])
const PRIORITIES = new Set(["high", "medium", "low"])

export function taskSidecarDbPath(): string {
  const root = process.env.VPS_GRAPEVINE_HOME || join(homedir(), ".vps-grapevine")
  return join(root, "task_sidecar_store.db")
}

export function legacyTodoNgDbPath(): string {
  const root = process.env.VPS_GRAPEVINE_HOME || join(homedir(), ".vps-grapevine")
  return join(root, "todo_ng.db")
}

export class TaskSidecarStore {
  private db: Database

  constructor(dbPath: string = taskSidecarDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const isFresh = !existsSync(dbPath)
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_sidecar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        todo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT,
        rollout_id TEXT NOT NULL DEFAULT '0',
        observed_session TEXT,
        last_actor TEXT,
        md_path TEXT,
        md_content TEXT,
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `)
    // v0.0.3 → v0.0.4 migration: add the md_content column to an existing
    // store, backfilling from md_path files so the DB becomes authoritative.
    const cols = (this.db.query(`PRAGMA table_info(task_sidecar)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    if (!cols.includes("md_content")) {
      this.db.exec("ALTER TABLE task_sidecar ADD COLUMN md_content TEXT")
      const legacy = this.db
        .query("SELECT id, md_path FROM task_sidecar WHERE md_content IS NULL AND md_path IS NOT NULL")
        .all() as Array<{ id: number; md_path: string }>
      for (const row of legacy) {
        try {
          const content = readFileSync(row.md_path, "utf8")
          this.db.run("UPDATE task_sidecar SET md_content = ? WHERE id = ?", [content, row.id])
        } catch {
          // file gone: leave md_content NULL; the row keeps md_path as the hint
        }
      }
    }
    // v0.0.5 → v0.0.6 migration: namespace every row to its owning rollout.
    // Rows that predate the namespace take the LEGACY marker, never a real
    // uuid, so a legacy row can never be mistaken for a live session's work.
    for (const col of ["rollout_id", "observed_session", "last_actor"]) {
      const type = col === "rollout_id" ? "TEXT NOT NULL DEFAULT '0'" : "TEXT"
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE task_sidecar ADD COLUMN ${col} ${type}`)
    }
    this.db.run("UPDATE task_sidecar SET rollout_id = ? WHERE rollout_id IS NULL OR rollout_id = ''", [
      LEGACY_ROLLOUT,
    ])
    if (isFresh) this.migrateLegacy()
  }

  // migrateLegacy ports rows from the old todo_ng.db (v0.0.2) if it exists
  // and this fresh store is empty. The legacy file is left untouched.
  private migrateLegacy() {
    const legacyPath = legacyTodoNgDbPath()
    if (!existsSync(legacyPath)) return
    const legacy = new Database(legacyPath, { readonly: true })
    try {
      const table = legacy
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo_ng'")
        .get() as { name: string } | null
      if (!table) return
      const count = (this.db.query("SELECT COUNT(*) AS n FROM task_sidecar").get() as { n: number }).n
      if (count > 0) return
      const rows = legacy.query("SELECT * FROM todo_ng ORDER BY id").all() as Array<Record<string, unknown>>
      for (const r of rows) {
        this.db.run(
          `INSERT INTO task_sidecar (id, created_at, updated_at, todo, status, priority, session_id, md_path, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [r.id, r.created_at, r.updated_at, r.todo, r.status, r.priority, r.session_id ?? null, r.md_path ?? null],
        )
      }
    } finally {
      legacy.close()
    }
  }

  private now(): string {
    return new Date().toISOString()
  }

  private assertStatus(status?: string) {
    if (status !== undefined && !STATUSES.has(status))
      throw new Error(`status must be one of ${[...STATUSES].join("|")}, got "${status}"`)
  }

  private assertPriority(priority?: string) {
    if (priority !== undefined && !PRIORITIES.has(priority))
      throw new Error(`priority must be one of ${[...PRIORITIES].join("|")}, got "${priority}"`)
  }

  // assertOwner is the namespace gate: a mutation is permitted only inside the
  // caller's own namespace. Refusals name the owning rollout so a caller that
  // guessed wrong can see who actually holds the row.
  private assertOwner(row: TaskSidecarRow, rolloutId: string, action: string) {
    if (row.rollout_id !== rolloutId)
      throw new Error(
        `${action} refused: row ${row.id} belongs to rollout "${row.rollout_id}", not "${rolloutId}"`,
      )
  }

  // add is the GLOBAL SEQUENCER: it returns the permanent, globally unique
  // task id. Use that id as the item number in the built-in todo list.
  // rollout_id is the owning namespace and is mandatory. md_content is
  // persisted when supplied — the fat record handed to add is stored, never
  // silently dropped (link_md amends it later). md_path stays NULL here: it is
  // an annotation link_md owns.
  add(input: AddInput): TaskSidecarRow {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    if (!input.rollout_id) throw new Error("add requires 'rollout_id' (your rollout uuid)")
    const ts = this.now()
    this.db.run(
      `INSERT INTO task_sidecar (created_at, updated_at, todo, status, priority, session_id, rollout_id, observed_session, last_actor, md_path, md_content, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      [
        ts,
        ts,
        input.todo,
        input.status ?? "pending",
        input.priority ?? "medium",
        input.session_id ?? null,
        input.rollout_id,
        input.observed_session ?? null,
        input.observed_session ?? null,
        input.md_content ?? null,
      ],
    )
    return this.get(Number(this.db.query("SELECT last_insert_rowid() AS id").get()!.id))!
  }

  get(id: number, opts: { include_deleted?: boolean } = {}): TaskSidecarRow | undefined {
    const sql = `SELECT * FROM task_sidecar WHERE id = ? ${opts.include_deleted ? "" : "AND deleted = 0"}`
    return (this.db.query(sql).get(id) as TaskSidecarRow | null) ?? undefined
  }

  list(filter: ListFilter = {}): TaskSidecarRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (!filter.show_deleted) where.push("deleted = 0")
    if (filter.rollout_id !== undefined) {
      where.push("rollout_id = ?")
      params.push(filter.rollout_id)
    }
    if (filter.status !== undefined) {
      where.push("status = ?")
      params.push(filter.status)
    }
    const sql = `SELECT * FROM task_sidecar ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`
    return this.db.query(sql).all(...params) as TaskSidecarRow[]
  }

  // listSince returns rows created at or after the ISO ts, ascending by id,
  // respecting soft delete unless show_deleted is set.
  listSince(since: string, filter: { show_deleted?: boolean } = {}): TaskSidecarRow[] {
    const where = ["created_at >= ?"]
    const params: unknown[] = [since]
    if (!filter.show_deleted) where.push("deleted = 0")
    const sql = `SELECT * FROM task_sidecar WHERE ${where.join(" AND ")} ORDER BY id`
    return this.db.query(sql).all(...params) as TaskSidecarRow[]
  }

  update(id: number, input: UpdateInput): TaskSidecarRow | undefined {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    const current = this.get(id)
    if (!current) return undefined
    this.assertOwner(current, input.rollout_id, "update")
    this.db.run(
      `UPDATE task_sidecar
          SET todo = ?, status = ?, priority = ?, session_id = ?, last_actor = ?, updated_at = ?
        WHERE id = ? AND deleted = 0`,
      [
        input.todo ?? current.todo,
        input.status ?? current.status,
        input.priority ?? current.priority,
        input.session_id !== undefined ? input.session_id : current.session_id,
        input.last_actor ?? current.last_actor,
        this.now(),
        id,
      ],
    )
    return this.get(id)
  }

  // linkMd stores the item's living document IN the DB (md_content) — the
  // record is the store, not a disk file. md_path may be supplied as an
  // optional annotation (e.g. a mirror path the user asked for); it is never
  // the transport: handoffs pass the row id and read md_content via get.
  linkMd(
    id: number,
    content: string,
    rolloutId: string,
    mdPath?: string,
    actor?: string,
  ): TaskSidecarRow | undefined {
    const current = this.get(id)
    if (!current) return undefined
    this.assertOwner(current, rolloutId, "link_md")
    this.db.run(
      "UPDATE task_sidecar SET md_content = ?, md_path = ?, last_actor = ?, updated_at = ? WHERE id = ?",
      [content, mdPath ?? current.md_path, actor ?? current.last_actor, this.now(), id],
    )
    return this.get(id)
  }

  // adopt moves a row OUT of the legacy marker namespace and INTO the calling
  // rollout. It applies only to rows still sitting in the marker, and it is a
  // one-way door: once adopted, the row belongs to that rollout and no
  // marker-naming caller can touch it again. Any other source namespace is
  // refused, naming the owner.
  adopt(id: number, rolloutId: string, actor?: string): TaskSidecarRow | undefined {
    if (!rolloutId) throw new Error("adopt requires 'rollout_id' (your rollout uuid)")
    const current = this.get(id)
    if (!current) return undefined
    if (current.rollout_id !== LEGACY_ROLLOUT)
      throw new Error(
        `adopt refused: row ${id} belongs to rollout "${current.rollout_id}", not the legacy marker "${LEGACY_ROLLOUT}"`,
      )
    this.db.run(
      "UPDATE task_sidecar SET rollout_id = ?, observed_session = COALESCE(observed_session, ?), last_actor = ?, updated_at = ? WHERE id = ?",
      [rolloutId, actor ?? null, actor ?? null, this.now(), id],
    )
    return this.get(id)
  }

  // novate is adopt's general form: it transfers a row between ANY two real
  // namespaces. The caller names the row's CURRENT owner's uuid (the namespace
  // key, exactly as every other mutation does) and the target rollout the row
  // is re-pointed to — this is how rows parked in dead or superseded sessions
  // are tidied without falsifying provenance: the owner uuid is on the record,
  // the mover is stamped last_actor, and the todo and fat record ride along
  // intact. Refused when the named owner does not own the row (the error names
  // the true owner), when the target is missing or the legacy marker — the
  // marker is never an identity, nothing moves INTO it — or when the target
  // equals the current owner.
  novate(id: number, rolloutId: string, toRolloutId: string, actor?: string): TaskSidecarRow | undefined {
    if (!rolloutId)
      throw new Error("novate requires 'rollout_id' (the row's current owning rollout uuid)")
    if (!toRolloutId) throw new Error("novate requires 'to_rollout_id' (the target rollout uuid)")
    if (toRolloutId === LEGACY_ROLLOUT)
      throw new Error(
        `novate refused: the legacy marker "${LEGACY_ROLLOUT}" is not an identity — novate to a real rollout uuid`,
      )
    if (toRolloutId === rolloutId)
      throw new Error(`novate refused: row ${id} already belongs to rollout "${rolloutId}"`)
    const current = this.get(id)
    if (!current) return undefined
    this.assertOwner(current, rolloutId, "novate")
    this.db.run(
      "UPDATE task_sidecar SET rollout_id = ?, observed_session = COALESCE(observed_session, ?), last_actor = ?, updated_at = ? WHERE id = ?",
      [toRolloutId, actor ?? null, actor ?? null, this.now(), id],
    )
    return this.get(id)
  }

  // purgeOlderThan LAZY SOFT DELETES every row in the caller's own namespace
  // created before the ISO ts (one-row-at-a-time semantics, batched). Scoped
  // to rollout_id: no session can soft-delete another namespace's rows, and
  // there is no sentinel path — legacy rows are the operator's to clear.
  // Returns the number of rows soft-deleted.
  purgeOlderThan(before: string, rolloutId: string): number {
    if (!rolloutId) throw new Error("purge_older_than requires 'rollout_id' (your rollout uuid)")
    return this.db
      .run(
        `UPDATE task_sidecar SET deleted = 1, updated_at = ?
          WHERE rollout_id = ? AND created_at < ? AND deleted = 0`,
        [this.now(), rolloutId, before],
      )
      .changes
  }

  // syncStatuses MIRRORS the built-in todo list onto the sidecar rows:
  // every todo item whose content starts with "N:" (or "N.") carries the
  // global sidecar id N, and the item's status is written to row N. Called
  // mechanically on every todowrite flush (see task-sidecar.ts), so closing
  // a todo item IS closing its row — the model cannot forget. SCOPED TO THE
  // FLUSHING SESSION (the harness reports its sessionID): a flush can only
  // close rows that session owns, so one session's list can never close
  // another's row. Rows not referenced by the flush (parked, other sessions)
  // are never touched. Returns the ids whose status changed.
  syncStatuses(items: Array<{ content?: unknown; status?: unknown }>, rolloutId: string): number[] {
    if (!rolloutId) throw new Error("syncStatuses requires the flushing session's rollout id")
    const changed: number[] = []
    for (const item of items) {
      if (typeof item?.content !== "string" || typeof item?.status !== "string") continue
      if (!STATUSES.has(item.status)) continue
      const m = item.content.match(/^\s*(\d+)\s*[.:)\]-]/)
      if (!m) continue
      const row = this.get(Number(m[1]))
      if (!row || row.rollout_id !== rolloutId || row.status === item.status) continue
      this.update(row.id, { rollout_id: rolloutId, status: item.status })
      changed.push(row.id)
    }
    return changed
  }

  close() {
    this.db.close()
  }
}
