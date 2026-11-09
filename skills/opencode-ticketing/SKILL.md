---
name: opencode-ticketing
description: Use for multi-step or long-lived engineering work — create a ticket to get a ticket number, add a numbered todo item, delegate tickets (with their numbers) to subagents. Tickets survive across sessions and repos.
---

# Ticketing

A ticket is an **immutable record with an append-only comment stream; status
is the only field that ever changes.** The todo list is ephemeral ordering.

## The flow: create, comment, change status

1. New task → `ticket_add rollout_id=<your session id> todo="one-line
   summary" md_content=<the full spec>` → returns the permanent ticket
   number **N**. The body is written ONCE, here — there is no rewrite
   action. The database copy is the record; keep the plan file in the
   repo's gitignored `.tmp/tickets/NNN_slug.md` scratch only while
   drafting.
2. `todowrite` — append item **`N: <descriptive name>`** at the END of the
   list. Front-jump only when the user says "do it next" or gives an
   explicit order. Closing the item closes ticket N automatically.
3. Everything after creation is a comment — and a comment is a SHORT
   go/no-go note: done / not done / blocked, 1000 chars max:
   `ticket_comment id=N content="..."`. Long reports NEVER go on the
   ticket: detail lives in the agent's final response (or a gist). One
   comment at a time.
4. Status is the only mutation: `ticket_status id=N rollout_id=<OWNER session id>
   status=…` (pending|in_progress|completed|cancelled|superseded), or the
   todo mirror does it for you. To supersede: set the status and name the
   replacement ticket in a comment. Nothing is ever deleted.

## Delegation — the stack/burndown cycle

1. Orchestrator creates the ticket (body self-contained before launch),
   pops it, hands the subagent ONLY the ticket number — never a path.
2. Subagent's first two calls are READS: `ticket_get id=N` (body +
   comments are its full instructions), then `ticket_rules` — obey
   every rule it returns. NO write to the ticket is a prerequisite for
   starting work: read, then work; comments are reports, never setup. It
   never edits the ticket. It returns a report — it does NOT commit,
   branch, push, open PRs, watch/poll CI.
3. Orchestrator, on return: marks the todo done + ticket complete
   (burndown, never delete), then re-runs the gate itself.
   - **Green** → orchestrator commits (and may push).
   - **Red** → orchestrator raises a follow-on todo + ticket, pushes it
     onto the stack, works it next. Iterate until green.
4. No CI monitoring until all tickets are done. AppVeyor orphans ignored.

**Boilerplate reduction.** Every subagent prompt should NOT re-state the
standing rules (no commit/push, no rm/reset/stash, tee clobber files,
bare-env macOS proof, etc.). Instead, the subagent's first actions are to
call `ticket_get id=N` and **`ticket_rules`** and obey the returned
rules. The tool is the single source of truth for delegee rules.

## Rules

- rollout_id IS the session id (`ses_…`) — one id, no other. An agent MUST
  know its own session id: `add` and `list` take it by default. A delegator
  handing work to a delegatee NAMES the session id the delegatee must use
  (on `ticket_status` and `ticket_list`). To adopt another session's tickets:
  `list rollout_id=<that session id>`. Access is by ticket number everywhere
  else (`ticket_get id=N`, `ticket_comment id=N`). Mutations outside the owner's
  namespace are refused and the error names the owner.
- `list` requires the session id to query (`list rollout_id=<session id>
  [status=…]`); `all=true` lists every session's. An agent must know which
  session it is querying.
- Comments are short go/no-go notes (done / not done / blocked, 1000 chars
  max) — never essays. Long reports live in the agent's final response
  (or a gist), never on the ticket. Any session may append (the author is
  the calling session, stamped automatically); only the owner may change
  status.
- The body (`md_content`) is written once at `add`; it is never rewritten.
  Comments are the record after that — like a Jira issue: description is
  the spec, comment stream is the history.
- Recovery (crashed session): `ticket_list rollout_id=<your session id>`,
  rebuild the todo list from your pending/in_progress rows (or `all=true`).
- Never read the sqlite file directly — use the `ticket` tools.
- Errors are structured: every failure returns
  `{code, message, corrected_call}` — re-emit `corrected_call` verbatim
  (fill any `<fill: …>` placeholder) and the call succeeds. The legal
  parameter set of each tool is defined by an RFC 8927 (JSON Type
  Definition) schema and validated before the call runs: unknown
  parameters, wrong types and illegal values are rejected outright.

## Setup (once per environment, with the user's permission)

The `ticket` tool comes from this repo's `v2.2.1/ticket.ts`; the companion
`todo-protocol.ts` owns todo-list mechanics. Install per the README, then
confirm the `ticket` tool exists and `todowrite`'s description begins
"Maintain the session todo list."
