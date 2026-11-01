// ticket — SELF-CONTAINED entry for opencode 2.2.1:
// 2.2.1 stages the entry file before execution, so relative imports
// resolve against the staging base, not the plugin directory. This
// entry therefore inlines TicketStore — no imports outside bun/node
// builtins. todo-protocol.ts is import-free and ships unchanged.
//
// THE CONTRACT: a ticket is an IMMUTABLE record with an APPEND-ONLY
// comment stream, and STATUS is the only field that ever changes. You
// create a ticket (add), you append comments one at a time
// (append_comment), and you change its status (set_status — or the
// todo mirror does it for you). That is the whole surface. Nothing
// else mutates: there is no body rewrite, no transfer, no delete, no
// priority, no parent linkage — if you need to say "superseded by
// ticket 243", you set the status and say it in a comment.
//
// The built-in todowrite list is the hot, ordered todo list. This store
// is COLD storage: the durable ticket rows (the spec + the comment
// record) plus the GLOBAL SEQUENCER (its autoincrement id is the only
// global ticket number). Framework-free (bun:sqlite + node:fs) so it
// can be unit-tested with bun:test without loading opencode. The plugin
// wrapper in ticket.ts is the only consumer. Every row is NAMESPACED to
// the rollout that owns it (rollout_id, NOT NULL): the one mutation
// (set_status) is reachable only inside the owner's namespace, and the
// todowrite mirror closes only the flushing session's rows. The plugin
// stamps observed_session / last_actor from the harness-reported
// sessionID, so the audit trail is ground truth and never caller input.
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
  rollout_id: string
  observed_session: string | null
  last_actor: string | null
  md_content: string | null
}

export interface TicketComment {
  id: number
  ticket_id: number
  created_at: string
  content: string
  author_rollout_id: string | null
  author_session_id: string | null
}

// add creates the immutable record: todo is the one-line summary,
// md_content the spec written ONCE at creation (the body is never
// rewritten — comments are the record after this).
export interface AddInput {
  todo: string
  rollout_id: string
  md_content?: string | null
  observed_session?: string | null
}

// setStatus is the ONLY mutation: status is the only mutable field.
export interface SetStatusInput {
  rollout_id: string
  status: string
  last_actor?: string | null
}

export interface ListFilter {
  rollout_id?: string
  status?: string
}

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled", "superseded"])

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
        rollout_id TEXT NOT NULL,
        observed_session TEXT,
        last_actor TEXT,
        md_content TEXT
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
  }

  private now(): string {
    return new Date().toISOString()
  }

  private assertStatus(status?: string) {
    if (status !== undefined && !STATUSES.has(status))
      throw new Error(`status must be one of ${[...STATUSES].join("|")}, got "${status}"`)
  }

  // assertOwner is the namespace gate: the one mutation (set_status) is
  // permitted only inside the caller's own namespace. Refusals name the
  // owning rollout so a caller that guessed wrong can see who holds it.
  private assertOwner(row: TicketRow, rolloutId: string, action: string) {
    if (row.rollout_id !== rolloutId)
      throw new Error(
        `${action} refused: ticket ${row.id} belongs to rollout "${row.rollout_id}", not "${rolloutId}"`,
      )
  }

  // add is the GLOBAL SEQUENCER: it returns the permanent, globally unique
  // ticket number. Use that number as the item number in the built-in todo
  // list. rollout_id is the owning namespace and is mandatory. md_content is
  // persisted when supplied — the spec is written ONCE, here; there is no
  // body rewrite action. Status starts pending; the todo mirror or
  // set_status moves it after that.
  add(input: AddInput): TicketRow {
    if (!input.todo) throw new Error("add requires 'todo' (the one-line summary)")
    if (!input.rollout_id) throw new Error("add requires 'rollout_id' (your rollout uuid)")
    const ts = this.now()
    this.db.run(
      `INSERT INTO ticket (created_at, updated_at, todo, status, rollout_id, observed_session, last_actor, md_content)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [ts, ts, input.todo, input.rollout_id, input.observed_session ?? null, input.observed_session ?? null, input.md_content ?? null],
    )
    return this.get(Number((this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id))!
  }

  get(id: number): TicketRow | undefined {
    return (this.db.query("SELECT * FROM ticket WHERE id = ?").get(id) as TicketRow | null) ?? undefined
  }

  list(filter: ListFilter = {}): TicketRow[] {
    const where: string[] = []
    const params: string[] = []
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

  // setStatus is the ONLY mutation on an otherwise immutable ticket.
  // Owner-gated: only the rollout that owns the ticket may change its
  // status. superseded is the re-scope verb: set it and name the
  // replacement ticket in a comment (comments are the record).
  setStatus(id: number, input: SetStatusInput): TicketRow | undefined {
    this.assertStatus(input.status)
    const current = this.get(id)
    if (!current) return undefined
    this.assertOwner(current, input.rollout_id, "set_status")
    this.db.run(
      `UPDATE ticket SET status = ?, last_actor = ?, updated_at = ? WHERE id = ?`,
      [input.status, input.last_actor ?? current.last_actor, this.now(), id],
    )
    return this.get(id)
  }

  // syncStatuses MIRRORS the built-in todo list onto the ticket rows: every
  // todo item whose content starts with "N:" (or "N.") carries the global
  // ticket number N, and the item's status is written to ticket N. Called
  // mechanically on every todowrite flush (see the plugin hook), so closing a
  // todo item IS closing its ticket — the model cannot forget. SCOPED TO THE
  // FLUSHING SESSION (the harness reports its sessionID): a flush can only
  // change tickets that session owns, so one session's list can never touch
  // another's ticket. Tickets not referenced by the flush are never touched.
  // Returns the ids whose status changed.
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
      this.setStatus(row.id, { rollout_id: rolloutId, status: item.status })
      changed.push(row.id)
    }
    return changed
  }

  // appendComment adds an immutable comment to a ticket. Comments are the
  // channel for gate results, follow-on work, blocked/andon reports, and
  // status notes that are not state changes. No owner gate: comments are
  // reports, not mutations — any session may append, one at a time. The
  // author is stamped from the caller's rollout/session for provenance.
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

const TICKET_DESCRIPTION = `Ticket database: durable tickets + global sequencer (autoincrement ticket
numbers), shared across sessions and repos. THIS IS NOT THE TODO LIST —
todowrite is. A ticket is an IMMUTABLE record with an APPEND-ONLY comment
stream; STATUS is the only field that ever changes. Never read the DB file
directly; the tool is the API.

The flow: create, comment, change status.
1) ticket add rollout_id=<your session uuid> todo="one-line summary"
   [md_content=the spec, written ONCE here] -> returns {"rollout_id","id"};
   the id N is the permanent ticket number
2) todowrite — append item "N: <descriptive name>" at the END of the list
   (front only when the user says do it next / gives an order)
3) Everything after creation is a comment: append_comment id=N
   rollout_id=<your uuid> content="..." — gate results, findings, blockers,
   reports. One at a time. A delegatee needs NO write to start work: it reads
   the ticket (get), reads get_delegee_rules, then works — comments are
   reports, never a prerequisite. The body is never rewritten; there is no
   rewrite action.
4) Status is the only mutation: set_status id=N rollout_id=<OWNER uuid>
   status=pending|in_progress|completed|cancelled|superseded. Closing the
   todo item "N: …" does it automatically (the mirror writes every todowrite
   flush, scoped to the flushing session's own tickets). To supersede: set
   status=superseded and name the replacement ticket in a comment.
5) Recovery (crashed session): ticket list, rebuild the todo list from the
   pending/in_progress rows.

Delegation: the DELEGATOR (main agent) creates the ticket (body self-contained
before launch) and hands the subagent ONLY the ticket number. The DELEGATEE's
first two calls are READS: ticket get id=N, then get_delegee_rules (the rules
are for THE DELEGATEE, not the delegator). The delegatee reports via comments;
the DELEGATOR reviews the diff, runs the tests, commits.

Actions: add | get | list | append_comment | set_status | get_delegee_rules |
help (help prints the full contract in one call).`

const TICKET_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: "add | get | list | append_comment | set_status | get_delegee_rules | help",
    },
    rollout_id: {
      type: "string",
      description:
        "YOUR rollout uuid / session id (add, append_comment; on set_status the ticket's OWNING rollout uuid)",
    },
    id: { type: "number", description: "ticket number (get/append_comment/set_status)" },
    todo: { type: "string", description: "one-line summary (add)" },
    md_content: {
      type: "string",
      description: "the spec, written ONCE at creation — the immutable body (add)",
    },
    content: { type: "string", description: "comment text (append_comment)" },
    status: {
      type: "string",
      description: "pending | in_progress | completed | cancelled | superseded (set_status; list filter)",
    },
  },
  required: ["action"],
}

// No declared `output`: the registry validates a declared output at runtime,
// and this tool returns free-form JSON strings as content only.

// The full contract in one string. This is the ONE-call recovery for an agent
// that lost the tool's shape: every validation error points here, and this
// text alone is enough to make every correct call shape.
function helpText(): string {
  return `ticket — the simple contract (one call to recover it)

A ticket is an IMMUTABLE record with an APPEND-ONLY comment stream; STATUS is
the only field that ever changes. That is the whole idea.

Actions and their required params:
- add rollout_id=<your session uuid> todo="one-line summary" [md_content=spec]
  -> creates the ticket; returns {"rollout_id","id"}; id N is the permanent
  ticket number. The body (md_content) is written ONCE, here — never after.
- get id=N  -> the row + its comments (chronological)
- list [rollout_id=<uuid>] [status=<status>]  -> recovery reads
- append_comment id=N rollout_id=<your uuid> content="..."
  -> the ONLY write after creation: reports, one comment at a time. Any
  session may append (the author is stamped for provenance). A comment is a
  report — never a prerequisite for starting work.
- set_status id=N rollout_id=<OWNER uuid> status=<pending|in_progress|
  completed|cancelled|superseded>  -> the ONLY mutation. Owner-gated.
- get_delegee_rules  -> the DELEGATEE's banner (its second call, after get)
- help  -> this text

Status: the todo mirror writes ticket N's status automatically whenever the
todo item "N: …" changes (closing the item closes the ticket). set_status is
for everything the list does not cover: superseded (name the replacement
ticket in a comment — comments are the record), cancelled, tickets outside
the live list.

WHO DOES WHAT (delegation):
- The DELEGATOR (main agent) creates the ticket — body self-contained before
  launch — and hands the subagent ONLY the ticket number. It owns the rollout
  uuid. It does NOT call get_delegee_rules.
- The DELEGATEE (subagent) first two calls are READS: ticket get id=N, then
  get_delegee_rules. It NEVER edits the ticket — there is no rewrite action.
  It needs NO write to start work. It reports via comments (append_comment,
  its own uuid) and, when done, set_status with the OWNER's uuid.
- The DELEGATOR reviews the diff, runs the tests, commits.

Mark-complete vs drop: a subagent MARKS its todo item / the ticket done; only
the ORCHESTRATOR removes todo items. Nothing is ever deleted — there is no
delete action. Never read the SQLite file directly — the tool is the API.`
}

// Appended to every validation error: the error names the violated clause and
// the fix; the hint routes the recovery through ONE help call.
const HELP_HINT = " — recover with one call: ticket {\"action\":\"help\"}"

export async function execute(args: any, context: any): Promise<{ content: string }> {
  const s = getStore()
  const observed = context?.sessionID
  try {
    switch (args.action) {
      case "add": {
        if (!args.todo)
          throw new Error("add requires 'todo' (the one-line summary) — add creates the immutable record: pass rollout_id (your uuid) + todo (+ md_content for the spec)")
        if (!args.rollout_id)
          throw new Error("add requires 'rollout_id' (your uuid) — add creates the immutable record: pass rollout_id (your uuid) + todo (+ md_content for the spec)")
        const row = s.add({
          todo: args.todo,
          rollout_id: args.rollout_id,
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
            }),
            null,
            2,
          ),
        }
      case "get": {
        if (args.id === undefined) throw new Error("get requires 'id'")
        const row = s.get(args.id)
        if (!row) throw new Error(`no ticket with number ${args.id}`)
        const comments = s.getComments(args.id)
        const rendered = comments.length
          ? `${JSON.stringify(row, null, 2)}\n\n--- comments (chronological) ---\n${comments
              .map((c) => `[${c.created_at}] ${c.content}`)
              .join("\n")}`
          : JSON.stringify(row, null, 2)
        return { content: rendered }
      }
      case "append_comment": {
        if (args.id === undefined) throw new Error("append_comment requires 'id'")
        if (!args.content) throw new Error("append_comment requires 'content'")
        if (!args.rollout_id) throw new Error("append_comment requires 'rollout_id' (your uuid — the author is stamped for provenance)")
        const c = s.appendComment(args.id, args.content, args.rollout_id, observed ?? null)
        return { content: JSON.stringify(c, null, 2) }
      }
      case "set_status": {
        if (args.id === undefined) throw new Error("set_status requires 'id'")
        if (!args.status) throw new Error("set_status requires 'status' (pending|in_progress|completed|cancelled|superseded)")
        if (!args.rollout_id) throw new Error("set_status requires 'rollout_id' (the ticket's OWNING rollout uuid)")
        const row = s.setStatus(args.id, {
          rollout_id: args.rollout_id,
          status: args.status,
          last_actor: observed ?? null,
        })
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
      case "get_delegee_rules": {
        return {
          content: `WHO YOU ARE: you are the DELEGATEE — a subagent launched by the main agent
(the DELEGATOR), which created the ticket and handed you ONLY its number. The
rules below are for YOU; the delegator does not read them. Your first two
calls: ticket get id=N (your instructions), then this read (you are doing it
now). THE TICKET IS IMMUTABLE: the body was written once by the delegator
before your launch — there is no rewrite action, and NO write to the ticket is
a prerequisite for starting work: read the ticket, read these rules, then DO
THE WORK. Your only writes are append_comment reports (progress, gate
results, extra findings — pass your own session uuid; any session may
append) and, when the work is done, set_status with the OWNER's rollout uuid
(named in the ticket row and the launch prompt). Comments are reports as you
go or at the end — never a prerequisite. The DELEGATOR reviews the diff, runs
the tests, and commits — you do not.

Subagent (delegee) rules — obey all of them:
- Read the repo's AGENTS.md if it exists and obey it.
- No commit, no push, no PR creation, no watch/poll of CI.
- Only run tests and \`git add\`.
- No rm/reset/stash — mv to .tmp; no /tmp.
- No issue numbers in committed files, messages, docs, comments.
- EN/CN doc parity for any doc touched.
- Tee all command output to .tmp/clobber_me_NN.txt (incrementing).
- bare-env macOS proof: env -u HOMEBREW_PREFIX -u PKG_CONFIG_PATH.
- AppVeyor checks are orphaned (ignore).
- When extra work is discovered, record it in the ticket (append a comment) — do not chase it.
- Mark your todo item/ticket done when the work is done (set_status with the
  OWNER's uuid); the ORCHESTRATOR removes todo items — never you. If the same
  ticket call fails twice with the same error, STOP calling it: state the
  blocker in your final report; never retry a third time.`,
        }
      }
      case "help": {
        return { content: helpText() }
      }
      default:
        throw new Error(
          `unknown action "${args.action}" (use add|get|list|append_comment|set_status|get_delegee_rules|help)`,
        )
    }
  } catch (e) {
    // Contract-echoing: every error names its violated clause (the throw site)
    // and routes recovery through ONE help call.
    return { content: `ticket error: ${(e as Error).message}${HELP_HINT}` }
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
