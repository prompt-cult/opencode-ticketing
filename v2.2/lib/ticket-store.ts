// ticket-store — the ticket database: durable ticket rows backed by SQLite.
// THIS IS NOT A TODO LIST. The built-in todowrite list is the hot, ordered
// todo list. This store is COLD storage: the fat record (living md docs) for
// each ticket, plus the GLOBAL SEQUENCER (its autoincrement id is the only
// global ticket number). Access pattern: insert one row, read one row, lazy
// soft delete — tickets are never hard-deleted. Framework-free (bun:sqlite +
// node:fs) so it can be unit-tested with bun:test without loading opencode.
// The plugin wrapper in ticket.ts is the only consumer.
//
// v0.1.0: fresh start as opencode-ticketing. Every row is NAMESPACED to the
// rollout that owns it (rollout_id, NOT NULL). The destructive actions —
// update, link_md, purge_older_than — are reachable only inside the caller's
// own namespace, and the todowrite mirror closes only the flushing session's
// rows. The plugin stamps observed_session / last_actor from the
// harness-reported sessionID, so the audit trail is ground truth and never
// caller input. novate transfers a row between real rollouts.
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface TicketRow {
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
  parent_id: number | null
  deleted: number
}

export interface TicketComment {
  id: number
  ticket_id: number
  created_at: string
  content: string
  author_rollout_id: string | null
  author_session_id: string | null
}

export interface AddInput {
  todo: string
  rollout_id: string
  status?: string
  priority?: string
  session_id?: string | null
  md_content?: string | null
  observed_session?: string | null
  parent_id?: number | null
}

export interface UpdateInput {
  rollout_id: string
  todo?: string
  status?: string
  priority?: string
  session_id?: string | null
  last_actor?: string | null
  parent_id?: number | null
}

export interface ListFilter {
  rollout_id?: string
  status?: string
  show_deleted?: boolean
}

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled", "superseded"])
const PRIORITIES = new Set(["high", "medium", "low"])

// The ticket database is the shared registry of tickets, so it lives in the
// opencode config tree, NOT in any repo: one database, every repo. Override
// with TICKET_DB_HOME for tests and isolation.
export function ticketDbPath(): string {
  const root = process.env.TICKET_DB_HOME || join(homedir(), ".config", "opencode", "opencode_ticketing")
  return join(root, "ticket.db")
}

export class TicketStore {
  private db: Database

  constructor(dbPath: string = ticketDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        todo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT,
        rollout_id TEXT NOT NULL,
        observed_session TEXT,
        last_actor TEXT,
        md_path TEXT,
        md_content TEXT,
        parent_id INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ticket_comment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        content TEXT NOT NULL,
        author_rollout_id TEXT,
        author_session_id TEXT,
        FOREIGN KEY (ticket_id) REFERENCES ticket(id)
      );
    `)
    // Migration: add parent_id to existing ticket tables.
    try { this.db.exec("ALTER TABLE ticket ADD COLUMN parent_id INTEGER;") } catch { /* already exists */ }
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
  // guessed wrong can see who actually holds the ticket.
  private assertOwner(row: TicketRow, rolloutId: string, action: string) {
    if (row.rollout_id !== rolloutId)
      throw new Error(
        `${action} refused: ticket ${row.id} belongs to rollout "${row.rollout_id}", not "${rolloutId}"`,
      )
  }

  // add is the GLOBAL SEQUENCER: it returns the permanent, globally unique
  // ticket number. Use that number as the item number in the built-in todo
  // list. rollout_id is the owning namespace and is mandatory. md_content is
  // persisted when supplied — the fat record handed to add is stored, never
  // silently dropped (link_md amends it later). md_path stays NULL here: it is
  // an annotation link_md owns.
  add(input: AddInput): TicketRow {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    if (!input.rollout_id) throw new Error("add requires 'rollout_id' (your rollout uuid)")
    if (input.parent_id !== undefined && input.parent_id !== null) {
      const parent = this.get(input.parent_id)
      if (!parent) throw new Error(`add: parent_id ${input.parent_id} does not reference an existing ticket`)
    }
    if (input.status === "superseded" && (input.parent_id === undefined || input.parent_id === null))
      throw new Error("add: status 'superseded' requires parent_id pointing to the replacement ticket")
    const ts = this.now()
    this.db.run(
      `INSERT INTO ticket (created_at, updated_at, todo, status, priority, session_id, rollout_id, observed_session, last_actor, md_path, md_content, parent_id, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
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
        input.parent_id ?? null,
      ],
    )
    return this.get(Number((this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id))!
  }

  get(id: number, opts: { include_deleted?: boolean } = {}): TicketRow | undefined {
    const sql = `SELECT * FROM ticket WHERE id = ? ${opts.include_deleted ? "" : "AND deleted = 0"}`
    return (this.db.query(sql).get(id) as TicketRow | null) ?? undefined
  }

  list(filter: ListFilter = {}): TicketRow[] {
    const where: string[] = []
    const params: string[] = []
    if (!filter.show_deleted) where.push("deleted = 0")
    if (filter.rollout_id !== undefined) {
      where.push("rollout_id = ?")
      params.push(filter.rollout_id)
    }
    if (filter.status !== undefined) {
      where.push("status = ?")
      params.push(filter.status)
    }
    const sql = `SELECT * FROM ticket ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`
    return this.db.query(sql).all(...params) as TicketRow[]
  }

  // listSince returns tickets created at or after the ISO ts, ascending by id,
  // respecting soft delete unless show_deleted is set.
  listSince(since: string, filter: { show_deleted?: boolean } = {}): TicketRow[] {
    const where = ["created_at >= ?"]
    const params: string[] = [since]
    if (!filter.show_deleted) where.push("deleted = 0")
    const sql = `SELECT * FROM ticket WHERE ${where.join(" AND ")} ORDER BY id`
    return this.db.query(sql).all(...params) as TicketRow[]
  }

  update(id: number, input: UpdateInput): TicketRow | undefined {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    const current = this.get(id)
    if (!current) return undefined
    this.assertOwner(current, input.rollout_id, "update")
    if (input.parent_id !== undefined && input.parent_id !== null) {
      const parent = this.get(input.parent_id)
      if (!parent) throw new Error(`update: parent_id ${input.parent_id} does not reference an existing ticket`)
      if (input.parent_id === id) throw new Error(`update: ticket ${id} cannot be its own parent`)
    }
    const newStatus = input.status ?? current.status
    const newParent = input.parent_id !== undefined ? input.parent_id : current.parent_id
    if (newStatus === "superseded" && (newParent === undefined || newParent === null))
      throw new Error("update: status 'superseded' requires parent_id pointing to the replacement ticket")
    this.db.run(
      `UPDATE ticket
          SET todo = ?, status = ?, priority = ?, session_id = ?, last_actor = ?, parent_id = ?, updated_at = ?
        WHERE id = ? AND deleted = 0`,
      [
        input.todo ?? current.todo,
        newStatus,
        input.priority ?? current.priority,
        input.session_id !== undefined ? input.session_id : current.session_id,
        input.last_actor ?? current.last_actor,
        newParent,
        this.now(),
        id,
      ],
    )
    return this.get(id)
  }

  // linkMd stores the ticket's living document IN the DB (md_content) — the
  // record is the database, not a disk file. md_path may be supplied as an
  // optional annotation (e.g. the .tmp/tickets/NNN_slug.md file the plan was
  // drafted in); it is never the transport: handoffs pass the ticket number
  // and read md_content via get.
  linkMd(
    id: number,
    content: string,
    rolloutId: string,
    mdPath?: string,
    actor?: string,
  ): TicketRow | undefined {
    const current = this.get(id)
    if (!current) return undefined
    this.assertOwner(current, rolloutId, "link_md")
    this.db.run(
      "UPDATE ticket SET md_content = ?, md_path = ?, last_actor = ?, updated_at = ? WHERE id = ?",
      [content, mdPath ?? current.md_path, actor ?? current.last_actor, this.now(), id],
    )
    return this.get(id)
  }

  // novate transfers a ticket between ANY two real namespaces. The caller
  // names the ticket's CURRENT owner's uuid (the namespace key, exactly as
  // every other mutation does) and the target rollout the ticket is re-pointed
  // to — this is how tickets parked in dead or superseded sessions are tidied
  // without falsifying provenance: the owner uuid is on the record, the mover
  // is stamped last_actor, and the todo and fat record ride along intact.
  // Refused when the named owner does not own the ticket (the error names the
  // true owner), when the target is missing, or when the target equals the
  // current owner.
  novate(id: number, rolloutId: string, toRolloutId: string, actor?: string): TicketRow | undefined {
    if (!rolloutId)
      throw new Error("novate requires 'rollout_id' (the ticket's current owning rollout uuid)")
    if (!toRolloutId) throw new Error("novate requires 'to_rollout_id' (the target rollout uuid)")
    if (toRolloutId === rolloutId)
      throw new Error(`novate refused: ticket ${id} already belongs to rollout "${rolloutId}"`)
    const current = this.get(id)
    if (!current) return undefined
    this.assertOwner(current, rolloutId, "novate")
    this.db.run(
      "UPDATE ticket SET rollout_id = ?, observed_session = COALESCE(observed_session, ?), last_actor = ?, updated_at = ? WHERE id = ?",
      [toRolloutId, actor ?? null, actor ?? null, this.now(), id],
    )
    return this.get(id)
  }

  // purgeOlderThan LAZY SOFT DELETES every ticket in the caller's own
  // namespace created before the ISO ts. Scoped to rollout_id: no session can
  // soft-delete another namespace's tickets. Returns the number soft-deleted.
  purgeOlderThan(before: string, rolloutId: string): number {
    if (!rolloutId) throw new Error("purge_older_than requires 'rollout_id' (your rollout uuid)")
    return this.db
      .run(
        `UPDATE ticket SET deleted = 1, updated_at = ?
          WHERE rollout_id = ? AND created_at < ? AND deleted = 0`,
        [this.now(), rolloutId, before],
      )
      .changes
  }

  // syncStatuses MIRRORS the built-in todo list onto the ticket rows: every
  // todo item whose content starts with "N:" (or "N.") carries the global
  // ticket number N, and the item's status is written to ticket N. Called
  // mechanically on every todowrite flush (see ticket.ts), so closing a todo
  // item IS closing its ticket — the model cannot forget. SCOPED TO THE
  // FLUSHING SESSION (the harness reports its sessionID): a flush can only
  // close tickets that session owns, so one session's list can never close
  // another's ticket. Tickets not referenced by the flush (parked, other
  // sessions) are never touched. Returns the ids whose status changed.
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

  // appendComment adds an immutable comment to a ticket. Comments are the
  // channel for gate results, follow-on work, blocked/andon reports, and
  // status updates that are not state changes. No owner gate: comments are
  // reports, not mutations — any session may append. The author is stamped
  // from the caller's rollout/session for provenance.
  appendComment(
    ticketId: number,
    content: string,
    authorRolloutId?: string | null,
    authorSessionId?: string | null,
  ): TicketComment {
    const row = this.get(ticketId)
    if (!row) throw new Error(`appendComment: no ticket with number ${ticketId}`)
    const ts = this.now()
    this.db.run(
      `INSERT INTO ticket_comment (ticket_id, created_at, content, author_rollout_id, author_session_id)
       VALUES (?, ?, ?, ?, ?)`,
      [ticketId, ts, content, authorRolloutId ?? null, authorSessionId ?? null],
    )
    return this.db.query("SELECT * FROM ticket_comment WHERE id = ?").get(
      Number((this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id),
    ) as TicketComment
  }

  // getComments returns all comments for a ticket, oldest first.
  getComments(ticketId: number): TicketComment[] {
    return this.db
      .query("SELECT * FROM ticket_comment WHERE ticket_id = ? ORDER BY created_at, id")
      .all(ticketId) as TicketComment[]
  }

  close() {
    this.db.close()
  }
}
