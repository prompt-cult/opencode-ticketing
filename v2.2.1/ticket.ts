// ticket — SELF-CONTAINED entry for opencode 2.2.1 (issue #11):
// 2.2.1 stages the entry file before execution, so relative imports
// resolve against the staging base, not the plugin directory. This
// entry therefore inlines TicketStore — no imports outside bun/node
// builtins. todo-protocol.ts is import-free and ships unchanged.
//
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
  deleted: number
}

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
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `)
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
    const ts = this.now()
    this.db.run(
      `INSERT INTO ticket (created_at, updated_at, todo, status, priority, session_id, rollout_id, observed_session, last_actor, md_path, md_content, deleted)
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
    this.db.run(
      `UPDATE ticket
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

  close() {
    this.db.close()
  }
}

// 2.2 Promise plugin API: default export { id, setup }; hooks registered
// imperatively in setup. No imports: the tool's input/output are hand-written
// JSON Schema, so the file loads standalone.

let store: TicketStore | undefined
function getStore(): TicketStore {
  if (!store) store = new TicketStore(ticketDbPath())
  return store
}

// uuidMismatch reports a claimed rollout_id that disagrees with the session
// the harness actually ran the call in. It is recorded, never fatal: the audit
// trail is the enforcement, and refusing the call would take away a caller who
// legitimately needs to name another namespace (delegation) their only route.
function uuidMismatch(claimed: string, observed: string | undefined): boolean {
  return !!observed && claimed !== observed
}

const TICKET_DESCRIPTION = `Ticket database: durable tickets + global sequencer
(autoincrement ticket numbers), shared across sessions and repos. THIS IS NOT
THE TODO LIST — todowrite is. Never read the DB file directly; the tool is the
API.

Loop for every new task:
1) ticket add rollout_id=<your session uuid> todo="one-line summary" ->
   returns {"rollout_id", "id"}; the id N is the permanent ticket number
2) todowrite — append item "N: <descriptive name>" at the END of the list
   (front only when the user says do it next / gives an order)
3) write the detailed plan to .tmp/tickets/NNN_slug.md, then
   ticket link_md id=N rollout_id=<your uuid> md_content=<file contents> —
   the DB copy is the record; the file is scratch.

Rules:
- rollout_id is REQUIRED on add, update, link_md, purge_older_than: YOUR
  session uuid (ses_…), never a guess. A mutation by another uuid is refused
  and names the owner. A subagent handed ticket N amends it by passing the
  OWNER's uuid (last_actor records who really did it).
- Closing a todo item "N: …" closes ticket N automatically (the plugin mirrors
  every todowrite flush, scoped to the flushing session's own tickets). Manual
  update is only for tickets outside the list (parked, other sessions).
- novate id=N rollout_id=<current owner> to_rollout_id=<target> transfers a
  ticket between sessions (tidying tickets parked in dead sessions).
- Reads (get/list/list_since) are unscoped and may filter by rollout_id.

Delegation (optional but primary for big work): hand the subagent the ticket
NUMBER, never a path — it runs ticket get id=N and reads md_content as its
full instructions; the record must be self-contained before launch.

Recovery (crashed session): ticket list, rebuild the todo list from the
pending/in_progress tickets.`

const TICKET_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: "add | list | get | update | link_md | novate | purge_older_than | list_since",
    },
    rollout_id: {
      type: "string",
      description:
        "YOUR rollout uuid / session id (REQUIRED on add, update, link_md, purge_older_than; on novate the ticket's CURRENT owning rollout uuid)",
    },
    to_rollout_id: {
      type: "string",
      description: "TARGET rollout uuid (REQUIRED on novate — the session the ticket is transferred to)",
    },
    id: { type: "number", description: "ticket number (get/update/link_md/novate)" },
    todo: { type: "string", description: "one-line summary (add; optional on update)" },
    status: { type: "string", description: "pending | in_progress | completed | cancelled" },
    priority: { type: "string", description: "high | medium | low" },
    md_path: {
      type: "string",
      description: "OPTIONAL annotation only — the record lives in the DB (link_md)",
    },
    md_content: {
      type: "string",
      description: "living doc content, stored IN the DB (persisted by add and link_md)",
    },
    before: {
      type: "string",
      description: "ISO ts — purge_older_than soft-deletes YOUR tickets created before this",
    },
    since: { type: "string", description: "ISO ts — list_since returns tickets created at/after this" },
    show_deleted: { type: "boolean", description: "include soft-deleted tickets (list/get/list_since)" },
  },
  required: ["action"],
}

// No declared `output`: the registry validates a declared output at runtime,
// and this tool returns free-form JSON strings as content only.

async function execute(args: any, context: any): Promise<{ content: string }> {
  const s = getStore()
  const observed = context?.sessionID
  try {
    switch (args.action) {
      case "add": {
        if (!args.todo) throw new Error("add requires 'todo'")
        if (!args.rollout_id) throw new Error("add requires 'rollout_id' (your rollout uuid)")
        const row = s.add({
          todo: args.todo,
          rollout_id: args.rollout_id,
          status: args.status,
          priority: args.priority,
          md_content: args.md_content ?? null,
          observed_session: observed ?? null,
        })
        return {
          content: JSON.stringify(
            {
              rollout_id: row.rollout_id,
              id: row.id,
              uuid_mismatch: uuidMismatch(row.rollout_id, observed),
              observed_session: observed ?? null,
              ticket: row,
            },
            null,
            2,
          ),
        }
      }
      case "list":
        return {
          content: JSON.stringify(
            s.list({
              status: args.status,
              rollout_id: args.rollout_id,
              show_deleted: args.show_deleted,
            }),
            null,
            2,
          ),
        }
      case "get": {
        if (args.id === undefined) throw new Error("get requires 'id'")
        const row = s.get(args.id, { include_deleted: args.show_deleted })
        if (!row) throw new Error(`no ticket with number ${args.id}`)
        return { content: JSON.stringify(row, null, 2) }
      }
      case "update": {
        if (args.id === undefined) throw new Error("update requires 'id'")
        if (!args.rollout_id) throw new Error("update requires 'rollout_id' (the owning rollout uuid)")
        const row = s.update(args.id, {
          rollout_id: args.rollout_id,
          todo: args.todo,
          status: args.status,
          priority: args.priority,
          last_actor: observed ?? null,
        })
        if (!row) throw new Error(`no ticket with number ${args.id}`)
        return { content: JSON.stringify(row, null, 2) }
      }
      case "link_md": {
        if (args.id === undefined || args.md_content === undefined)
          throw new Error("link_md requires 'id' and 'md_content' (the record lives IN the DB)")
        if (!args.rollout_id) throw new Error("link_md requires 'rollout_id' (the owning rollout uuid)")
        const row = s.linkMd(args.id, args.md_content, args.rollout_id, args.md_path, observed ?? null)
        if (!row) throw new Error(`no ticket with number ${args.id}`)
        return { content: JSON.stringify(row, null, 2) }
      }
      case "novate": {
        if (args.id === undefined) throw new Error("novate requires 'id'")
        if (!args.rollout_id)
          throw new Error("novate requires 'rollout_id' (the ticket's current owning rollout uuid)")
        if (!args.to_rollout_id) throw new Error("novate requires 'to_rollout_id' (the target rollout uuid)")
        const row = s.novate(args.id, args.rollout_id, args.to_rollout_id, observed ?? null)
        if (!row) throw new Error(`no ticket with number ${args.id}`)
        return {
          content: JSON.stringify(
            {
              uuid_mismatch: uuidMismatch(args.rollout_id, observed),
              observed_session: observed ?? null,
              ticket: row,
            },
            null,
            2,
          ),
        }
      }
      case "purge_older_than": {
        if (!args.before) throw new Error("purge_older_than requires 'before' (ISO ts)")
        if (!args.rollout_id) throw new Error("purge_older_than requires 'rollout_id' (your rollout uuid)")
        const n = s.purgeOlderThan(args.before, args.rollout_id)
        return { content: JSON.stringify({ rollout_id: args.rollout_id, soft_deleted: n }, null, 2) }
      }
      case "list_since": {
        if (!args.since) throw new Error("list_since requires 'since' (ISO ts)")
        const rows = s.listSince(args.since, { show_deleted: args.show_deleted })
        return { content: JSON.stringify(rows, null, 2) }
      }
      default:
        throw new Error(
          `unknown action "${args.action}" (use add|list|get|update|link_md|novate|purge_older_than|list_since)`,
        )
    }
  } catch (e) {
    return { content: `ticket error: ${(e as Error).message}` }
  }
}

export default {
  id: "ticket",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "ticket",
        options: { codemode: false },
        description: TICKET_DESCRIPTION,
        input: TICKET_INPUT,
        execute: (args, context) => execute(args, context),
      })
    })
    // Every todowrite flush mechanically mirrors item statuses onto ticket
    // rows: an item "N: …" carries the ticket number N, and its status is
    // written to ticket N. Closing the todo item IS closing the ticket. Scoped
    // to the flushing session. Never let a sync failure break the flush.
    await ctx.tool.hook("execute.before", async (event: any) => {
      if (event.tool !== "todowrite") return
      try {
        const todos = Array.isArray(event.input) ? event.input : Array.isArray(event.input?.todos) ? event.input.todos : []
        if (todos.length && event.sessionID) getStore().syncStatuses(todos, event.sessionID)
      } catch {
        // the ticket store must never break the todo list's flush
      }
    })
  },
}
