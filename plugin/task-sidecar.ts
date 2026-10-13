// task-sidecar — the COLD side: durable task detail store + global sequencer
// as an opencode custom tool. Wraps TaskSidecarStore
// (plugin/task-sidecar-store.ts), a SQLite sidecar DB at
// ${VPS_GRAPEVINE_HOME:-~/.vps-grapevine}/task_sidecar_store.db. THIS IS NOT
// THE TODO LIST: the built-in todowrite list is the hot, ordered set; this is
// cold blob storage for task detail (living md docs) plus the global issue
// sequencer. Rows survive sessions, restarts, compaction and repo cleanups;
// rows are never hard-deleted — lazy soft delete only.
// v0.0.6: every row is namespaced to the rollout that owns it (rollout_id);
// update/link_md/purge_older_than are refused outside that namespace, and the
// todowrite mirror closes only the flushing session's own rows.
// v0.0.7: novate — ownership transfer between real rollouts (adopt's general
// form), so rows parked in dead or superseded sessions can be tidied.
import { tool } from "@opencode-ai/plugin"
import { TaskSidecarStore, taskSidecarDbPath } from "./task-sidecar-store"

let store: TaskSidecarStore | undefined
function getStore(): TaskSidecarStore {
  if (!store) store = new TaskSidecarStore(taskSidecarDbPath())
  return store
}

// uuidMismatch reports a claimed rollout_id that disagrees with the session
// the harness actually ran the call in. It is recorded, never fatal: the audit
// trail is the enforcement, and refusing the call would take away a caller who
// legitimately needs to name another namespace (delegation) their only route.
function uuidMismatch(claimed: string, observed: string | undefined): boolean {
  return !!observed && claimed !== observed
}

const TASK_SIDECAR_DESCRIPTION = `Cold task-detail store + global sequencer (SQLite sidecar, global autoincrement ids). THIS IS NOT THE TODO LIST: the built-in todowrite tool is the live, ordered todo list (the hot set). This store is the cold storage of task detail (the "bucket of md") and the global sequencer that assigns task numbers. NEVER read the DB directly; these rules are the API.

NAMESPACING (mandatory): every row belongs to the rollout that made it.
- rollout_id is REQUIRED on add, update, link_md and purge_older_than — pass YOUR OWN rollout uuid (the session id, e.g. ses_xxx), never a guess and never the "0" marker.
- add returns the handle tuple {"rollout_id": ..., "id": ...}: the uuid the row is namespaced to, and the id to carry everywhere.
- A mutation is refused unless the rollout_id you pass equals the row's owner; the error names the owner. Delegation: a subagent handed a row id amends/reports by passing the OWNER's uuid; last_actor records who really did it.
- purge_older_than only ever touches your own namespace.
- Reads (get/list/list_since) are unscoped — auditability means seeing other rollouts — and may filter by rollout_id.
- Rows created before namespacing carry rollout_id "0". That is a legacy marker, not an identity: NEVER pass "0" as your own uuid. If a legacy row is yours to work, ADOPT it — adopt id=N rollout_id=<your uuid> — which moves it out of the marker into your namespace, one way. Adoption is refused for any row that already has a real owner (the error names them).
- Rows parked in a dead or superseded session are tidied with NOVATE — novate id=N rollout_id=<the row's CURRENT owner> to_rollout_id=<the target rollout uuid> — the general transfer between real rollouts. The owner uuid is the namespace key and is on the record; the mover is stamped last_actor; the record rides along intact. Refused for a wrong owner (the error names the true one), a missing target, the legacy marker as target, or target == owner.

Rules:
- Access pattern: INSERT one row, READ one row, LAZY SOFT DELETE. Nothing is ever hard-deleted; superseded work is marked completed/cancelled via update.
- The autoincrement id IS the task number (creation sequence, not order — ordering/reordering lives in the built-in todo list).
- THE DB IS THE RECORD AND THE TRANSPORT. The fat record (md_content) lives IN the DB, never on disk: a link_md with only md_path writes NOTHING. md_path is an optional annotation, never a handoff mechanism.

Call sequence (allocating a new task):
1) task_sidecar add rollout_id=<your uuid> todo=<one-line blob> [md_content=<fat record>] -> returns {"rollout_id", "id"}; the id is the permanent number [the sequencer]
2) todowrite: insert/update the built-in list with description "N: <task>" — the id is the item number
3) task_sidecar link_md id=N rollout_id=<your uuid> md_content=<fat record> — amend the record any time; md_path is optional annotation only

Delegation (handing a task to a subagent):
- Pass the row ID (and the action summary), NOT a file path. The subagent reads its full instructions via task_sidecar get id=N — the record must be self-contained (include the issue details, the spec, the constraints, the do-not list, and the PRE-ASSIGNED branch name: the orchestrator names the branch before launch and records it IN the row, so every attempt for this task lands on the same branch).
- If the task traces to a gh issue or other ticket, the todo line and the record both NAME the ticket (e.g. #123) — never ticketless.
- NEVER pass a .tmp/ or disk path as the spec transport; a .tmp clear-down must not be able to lose a spec.

Later:
- closing a todo item CLOSES its row automatically: the plugin mirrors every todowrite flush onto the sidecar — an item "N: …" flushed completed/cancelled sets row N to completed/cancelled, and only for rows your own rollout owns. Do not call update for that; it already happened.
- task_sidecar update id=N rollout_id=<owner> status=completed|cancelled is only for rows NOT in the built-in todo list (parked, other sessions).

Recovery (crashed session): task_sidecar list, see what is pending/in_progress vs completed, rebuild your built-in todo list from that.

Actions:
- add: new row (todo + rollout_id required; optional status/priority/md_content — a supplied md_content IS persisted). Returns {"rollout_id", "id"}.
- list: rows (optional status/rollout_id filter; show_deleted to include soft-deleted), ascending by id.
- get: one row by id (skips soft-deleted; show_deleted includes). Returns the row INCLUDING md_content — this is how a subagent reads its full instructions.
- update: patch todo/status/priority by id; refused unless rollout_id owns the row.
- link_md: store the task's living document IN the DB (md_content required; md_path optional annotation); refused unless rollout_id owns the row.
- adopt: move a row out of the legacy "0" marker namespace into yours (id + rollout_id required). One-way; refused for any row with a real owner.
- novate: transfer a row to another rollout (id + rollout_id [the row's CURRENT owner] + to_rollout_id required). The general form of adopt — how rows parked in dead or superseded sessions are tidied. Refused for a wrong owner (the error names the true one), the legacy marker as target, or target == owner.
- purge_older_than: LAZY soft delete rows in YOUR namespace created before 'before' (ISO ts). Returns the count.
- list_since: rows created at/after 'since' (ISO ts), ascending, respecting soft delete; show_deleted includes them.
The fat record for a task is its living document; write/amend it via link_md, not by stuffing prose into the todo text.`

export default (async () => ({
  // Every todowrite flush mechanically mirrors item statuses onto the
  // sidecar rows: an item "N: …" carries the global id N, and its status
  // (pending/in_progress/completed/cancelled) is written to row N. Closing
  // the todo item IS closing the row — no model memory involved. Scoped to
  // the flushing session (the harness reports its sessionID): a flush can
  // only close rows that session owns. Never let a sync failure break the
  // flush.
  "tool.execute.before": async (input: { tool: string; sessionID?: string }, output: { args: any }) => {
    if (input.tool !== "todowrite") return
    try {
      const args = output.args
      const todos = Array.isArray(args) ? args : Array.isArray(args?.todos) ? args.todos : []
      if (todos.length && input.sessionID) getStore().syncStatuses(todos, input.sessionID)
    } catch {
      // the cold store must never break the hot list's flush
    }
  },
  tool: {
    task_sidecar: tool({
      description: TASK_SIDECAR_DESCRIPTION,
      args: {
        action: tool.schema
          .string()
          .describe(
            "add | list | get | update | link_md | adopt | novate | purge_older_than | list_since",
          ),
        rollout_id: tool.schema
          .string()
          .optional()
          .describe("YOUR rollout uuid / session id (REQUIRED on add, update, link_md, purge_older_than; on novate/adopt the row's CURRENT owning rollout uuid)"),
        to_rollout_id: tool.schema
          .string()
          .optional()
          .describe("TARGET rollout uuid (REQUIRED on novate — the session the row is transferred to; never the legacy marker)"),
        id: tool.schema.number().optional().describe("task id (get/update/link_md)"),
        todo: tool.schema.string().optional().describe("one-line task blob (add; optional on update)"),
        status: tool.schema.string().optional().describe("pending | in_progress | completed | cancelled"),
        priority: tool.schema.string().optional().describe("high | medium | low"),
        md_path: tool.schema.string().optional().describe("OPTIONAL annotation only — the record lives in the DB; never a handoff path (link_md)"),
        md_content: tool.schema.string().optional().describe("living doc content, stored IN the DB (persisted by add and link_md)"),
        before: tool.schema.string().optional().describe("ISO ts — purge_older_than soft-deletes YOUR rows created before this"),
        since: tool.schema.string().optional().describe("ISO ts — list_since returns rows created at/after this"),
        show_deleted: tool.schema.boolean().optional().describe("include soft-deleted rows (list/get/list_since)"),
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
                  row,
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
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
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
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "link_md": {
              if (args.id === undefined || args.md_content === undefined)
                throw new Error("link_md requires 'id' and 'md_content' (the record lives IN the DB; md_path is optional annotation)")
              if (!args.rollout_id) throw new Error("link_md requires 'rollout_id' (the owning rollout uuid)")
              const row = s.linkMd(args.id, args.md_content, args.rollout_id, args.md_path, observed ?? null)
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "adopt": {
              if (args.id === undefined) throw new Error("adopt requires 'id'")
              if (!args.rollout_id) throw new Error("adopt requires 'rollout_id' (your rollout uuid)")
              const row = s.adopt(args.id, args.rollout_id, observed ?? null)
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "novate": {
              if (args.id === undefined) throw new Error("novate requires 'id'")
              if (!args.rollout_id)
                throw new Error("novate requires 'rollout_id' (the row's current owning rollout uuid)")
              if (!args.to_rollout_id)
                throw new Error("novate requires 'to_rollout_id' (the target rollout uuid)")
              const row = s.novate(args.id, args.rollout_id, args.to_rollout_id, observed ?? null)
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
              return JSON.stringify(
                {
                  uuid_mismatch: uuidMismatch(args.rollout_id, observed),
                  observed_session: observed ?? null,
                  row,
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
                `unknown action "${args.action}" (use add|list|get|update|link_md|adopt|novate|purge_older_than|list_since)`,
              )
          }
        } catch (e) {
          return `task_sidecar error: ${(e as Error).message}`
        }
      },
    }),
  },
}))
