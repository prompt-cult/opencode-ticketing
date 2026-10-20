// ticket — the ticketing plugin: a shared SQLite ticket database + global
// ticket-number sequencer exposed as an opencode custom tool. Wraps
// TicketStore (plugin/ticket-store.ts), whose DB lives at
// ~/.config/opencode/opencode_ticketing/ticket.db (TICKET_DB_HOME override).
// THIS IS NOT THE TODO LIST: the built-in todowrite list is the hot, ordered
// set; this is durable ticket detail plus the sequencer. Tickets survive
// sessions, restarts, compaction and repo cleanups; they are never
// hard-deleted — lazy soft delete only.
// v0.1.0: fresh start as opencode-ticketing; novate in, adopt/legacy out.
import { tool } from "@opencode-ai/plugin"
import { TicketStore, ticketDbPath } from "./ticket-store"

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

export default (async () => ({
  // Every todowrite flush mechanically mirrors item statuses onto ticket
  // rows: an item "N: …" carries the ticket number N, and its status
  // (pending/in_progress/completed/cancelled) is written to ticket N. Closing
  // the todo item IS closing the ticket — no model memory involved. Scoped to
  // the flushing session (the harness reports its sessionID): a flush can
  // only close tickets that session owns. Never let a sync failure break the
  // flush.
  "tool.execute.before": async (input: { tool: string; sessionID?: string }, output: { args: any }) => {
    if (input.tool !== "todowrite") return
    try {
      const args = output.args
      const todos = Array.isArray(args) ? args : Array.isArray(args?.todos) ? args.todos : []
      if (todos.length && input.sessionID) getStore().syncStatuses(todos, input.sessionID)
    } catch {
      // the ticket store must never break the todo list's flush
    }
  },
  tool: {
    ticket: tool({
      description: TICKET_DESCRIPTION,
      args: {
        action: tool.schema
          .string()
          .describe("add | list | get | update | link_md | novate | purge_older_than | list_since"),
        rollout_id: tool.schema
          .string()
          .optional()
          .describe("YOUR rollout uuid / session id (REQUIRED on add, update, link_md, purge_older_than; on novate the ticket's CURRENT owning rollout uuid)"),
        to_rollout_id: tool.schema
          .string()
          .optional()
          .describe("TARGET rollout uuid (REQUIRED on novate — the session the ticket is transferred to)"),
        id: tool.schema.number().optional().describe("ticket number (get/update/link_md/novate)"),
        todo: tool.schema.string().optional().describe("one-line summary (add; optional on update)"),
        status: tool.schema.string().optional().describe("pending | in_progress | completed | cancelled"),
        priority: tool.schema.string().optional().describe("high | medium | low"),
        md_path: tool.schema.string().optional().describe("OPTIONAL annotation only — the record lives in the DB (link_md)"),
        md_content: tool.schema.string().optional().describe("living doc content, stored IN the DB (persisted by add and link_md)"),
        before: tool.schema.string().optional().describe("ISO ts — purge_older_than soft-deletes YOUR tickets created before this"),
        since: tool.schema.string().optional().describe("ISO ts — list_since returns tickets created at/after this"),
        show_deleted: tool.schema.boolean().optional().describe("include soft-deleted tickets (list/get/list_since)"),
      },
      async execute(args, context) {
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
              return JSON.stringify(
                {
                  rollout_id: row.rollout_id,
                  id: row.id,
                  uuid_mismatch: uuidMismatch(row.rollout_id, observed),
                  observed_session: observed ?? null,
                  ticket: row,
                },
                null,
                2,
              )
            }
            case "list":
              return JSON.stringify(
                s.list({
                  status: args.status,
                  rollout_id: args.rollout_id,
                  show_deleted: args.show_deleted,
                }),
                null,
                2,
              )
            case "get": {
              if (args.id === undefined) throw new Error("get requires 'id'")
              const row = s.get(args.id, { include_deleted: args.show_deleted })
              if (!row) throw new Error(`no ticket with number ${args.id}`)
              return JSON.stringify(row, null, 2)
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
              return JSON.stringify(row, null, 2)
            }
            case "link_md": {
              if (args.id === undefined || args.md_content === undefined)
                throw new Error("link_md requires 'id' and 'md_content' (the record lives IN the DB)")
              if (!args.rollout_id) throw new Error("link_md requires 'rollout_id' (the owning rollout uuid)")
              const row = s.linkMd(args.id, args.md_content, args.rollout_id, args.md_path, observed ?? null)
              if (!row) throw new Error(`no ticket with number ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "novate": {
              if (args.id === undefined) throw new Error("novate requires 'id'")
              if (!args.rollout_id)
                throw new Error("novate requires 'rollout_id' (the ticket's current owning rollout uuid)")
              if (!args.to_rollout_id)
                throw new Error("novate requires 'to_rollout_id' (the target rollout uuid)")
              const row = s.novate(args.id, args.rollout_id, args.to_rollout_id, observed ?? null)
              if (!row) throw new Error(`no ticket with number ${args.id}`)
              return JSON.stringify(
                {
                  uuid_mismatch: uuidMismatch(args.rollout_id, observed),
                  observed_session: observed ?? null,
                  ticket: row,
                },
                null,
                2,
              )
            }
            case "purge_older_than": {
              if (!args.before) throw new Error("purge_older_than requires 'before' (ISO ts)")
              if (!args.rollout_id) throw new Error("purge_older_than requires 'rollout_id' (your rollout uuid)")
              const n = s.purgeOlderThan(args.before, args.rollout_id)
              return JSON.stringify({ rollout_id: args.rollout_id, soft_deleted: n }, null, 2)
            }
            case "list_since": {
              if (!args.since) throw new Error("list_since requires 'since' (ISO ts)")
              const rows = s.listSince(args.since, { show_deleted: args.show_deleted })
              return JSON.stringify(rows, null, 2)
            }
            default:
              throw new Error(
                `unknown action "${args.action}" (use add|list|get|update|link_md|novate|purge_older_than|list_since)`,
              )
          }
        } catch (e) {
          return `ticket error: ${(e as Error).message}`
        }
      },
    }),
  },
}))
