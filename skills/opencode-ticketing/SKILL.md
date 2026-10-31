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
   `ticket get id=N`, reads the ticket (body + comments) as its full
   instructions, works the plan, and **appends comments** for gate results
   and follow-on findings. It returns a report to the orchestrator — it does
   NOT edit the body, change status, commit, push, open PRs, or poll CI.
   The orchestrator reviews the diff, runs the tests, commits.
6. Closing the todo item closes ticket N automatically. Nothing to do —
   but the mirror only runs where a `todowrite` tool exists. In a session
   without one, close by hand: `ticket update id=N rollout_id=<your uuid>
   status=completed`. (Verified live 2026-10-29, ticket 46.)

## Why tickets

Tickets outlive sessions. A plan written today can be amended over weeks
(`link_md`), handed to another session (`novate`), and read or searched from
any repo (`ticket get id=N`, `ticket list`). That persistence is the primary
value; subagent delegation is secondary.

## Immutability — the body is the spec, comments are the record

The ticket body (`md_content`) is written once when the ticket is created
and is **mostly immutable**. It is the spec — do not edit it in place.

Everything that happens after creation goes into **comments** (appended via
`append_comment`, a new tool action):

- Gate results (check-types, lint, check, test numbers).
- Follow-on work discovered during execution.
- "Blocked / andon / needs-user-decision" reports from subagents.
- Out-of-lane findings and error-of-commission notes.
- Status updates that are not state changes (e.g. "returned to
  orchestrator with report").

`ticket get` renders the body first, then the list of comments
chronologically — like GitHub issues. The body alone is not the full picture.

### When the body genuinely must change

If an agent needs to fundamentally re-scope a ticket (not just append a
comment), it creates a **new** ticket with `parent_id` pointing to the old
one, and marks the old one `superseded` (a terminal closed status, distinct
from `cancelled` which means "abandoned / will not fix"). This should be
very rare — the norm is comments.

`parent_id` also links follow-on tickets to their origin, giving durable
lineage across sessions even when the orchestrator forks, novates, or
reboots.

### Why this matters

The user often interrupts, powers off, reboots, or forks sessions and
novates tickets. Durable state (comments + parent_id linkage) survives
all of those; in-place edits do not. Subagents should never mutate the
ticket body — they append comments (or return reports to the orchestrator,
which appends comments). The ticket body stays as the original spec.

## Delegation — the stack/burndown cycle

Tickets form a **stack**. Follow-on work discovered mid-task is appended at
the bottom, not folded into the current ticket. Real-time burndown is
visible: items completed, never deleted; follow-ups pushed onto the stack.

**The cycle:**

1. Orchestrator pops the next ticket, hands the subagent only the ticket
   number.
2. Subagent calls `ticket get id=N` (body + comments are its full
   instructions), implements, runs the local gate, then **`git add` only
   the touched files**. It returns a report — it does NOT commit, push,
   open PRs, watch/poll CI, or edit the ticket body.
3. Orchestrator, on return: marks the todo done + ticket complete
   (burndown, never delete), then re-runs the gate itself.
   - **Green** → orchestrator commits (and may push).
   - **Red** → orchestrator raises a follow-on todo + ticket, pushes it
     onto the stack, works it next. Iterate until green.
4. No CI monitoring until all tickets are done. AppVeyor orphans ignored.

**Boilerplate reduction.** Every subagent prompt should NOT re-state the
standing rules (no commit/push, no rm/reset/stash, tee clobber files,
bare-env macOS proof, etc.). Instead, the subagent's first action is to
call **`get_delegee_rules`** (a tool provided by this skill's plugin) and
obey the returned rules. The tool is the single source of truth for delegee
rules; the skill references it rather than duplicating it. The subagent
prompt then only needs the ticket number and task-specific context.

## Rules

- Every ticket belongs to a rollout: pass YOUR session uuid (`ses_…`) on
  `add`/`update`/`link_md`. Never another session's; mutations are refused
  outside your namespace and the error names the owner.
- The plan file lives in the repo's gitignored `.tmp/tickets/` scratch: a
  clear-down must never be able to lose a spec, so `md_content` in the
  database is always the record.
- Never read the sqlite file directly — use the `ticket` tool.
- Tickets are never hard-deleted (soft delete only).
- `link_md` refuses a bare `md_path`: it requires `md_content` too. The
  `md_path` is an annotation; the DB copy is the record.
- Reads (`list`, `get`, `list_since`) are unscoped — any session can read
  every ticket; only mutations are namespaced to the owner's uuid.

## Setup (once per environment, with the user's permission)

The `ticket` tool comes from this repo's `plugin/ticket.ts` (+ its store); the
companion `plugin/todo-protocol.ts` owns todo-list mechanics. Install per the
README, then confirm the `ticket` tool exists and `todowrite`'s description
begins "Maintain the session todo list."
