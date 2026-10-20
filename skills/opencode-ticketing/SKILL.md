---
name: opencode-ticketing
description: Use for multi-step or long-lived engineering work — create a ticket to get a ticket number, add a numbered todo item, write the detailed plan to .tmp/tickets/, load it into the ticket, and delegate tickets (with their numbers) to subagents. Tickets survive across sessions and repos.
---

# Ticketing

Tickets are the durable record. The todo list is ephemeral ordering.

## The loop

1. New task → `ticket add rollout_id=<your session uuid> todo="one-line summary"`
   → returns the permanent ticket number **N**.
2. `todowrite` — append item **`N: <descriptive name>`** at the END of the
   list. Front-jump only when the user says "do it next" or gives an explicit
   order. Follow-on work discovered mid-task is a new ticket, appended at the
   bottom.
3. Write the detailed plan to `.tmp/tickets/NNN_slug.md` (zero-padded ticket
   number + short slug). Full spec, constraints, do-not list, definition of
   done.
4. Load it into the ticket: `ticket link_md id=N rollout_id=<your uuid>
   md_content=<file contents>`. The database copy is the record; the file is
   scratch. Never hand a subagent a path — hand it the ticket number.
5. Delegate (optional, for big tickets): the subagent runs
   `ticket get id=N`, reads `md_content` as its full instructions, works the
   plan, and amends the ticket as it goes (passing the OWNER's rollout uuid).
   The orchestrator reviews the diff, runs the tests, commits.
6. Closing the todo item closes ticket N automatically. Nothing to do.

## Why tickets

Tickets outlive sessions. A plan written today can be amended over weeks
(`link_md`), handed to another session (`novate`), and read or searched from
any repo (`ticket get id=N`, `ticket list`). That persistence is the primary
value; subagent delegation is secondary.

## Rules

- Every ticket belongs to a rollout: pass YOUR session uuid (`ses_…`) on
  `add`/`update`/`link_md`. Never another session's; mutations are refused
  outside your namespace and the error names the owner.
- The plan file lives in the repo's gitignored `.tmp/tickets/` scratch: a
  clear-down must never be able to lose a spec, so `md_content` in the
  database is always the record.
- Never read the sqlite file directly — use the `ticket` tool.
- Tickets are never hard-deleted (soft delete only).

## Setup (once per environment, with the user's permission)

The `ticket` tool comes from this repo's `plugin/ticket.ts` (+ its store); the
companion `plugin/todo-protocol.ts` owns todo-list mechanics. Install per the
README, then confirm the `ticket` tool exists and `todowrite`'s description
begins "Maintain the session todo list."
