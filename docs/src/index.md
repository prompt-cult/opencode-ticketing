# opencode-ticketing

English | [中文](zh-cn.md)

**Jira for your [opencode](https://opencode.ai) agents. One SQLite file.
Every session, every repo.**

A skill + companion plugin pair for [opencode](https://opencode.ai): the
ticket is the centre of attention.

## The idea: tickets are immutable

A ticket's body (`md_content`) is **the spec, written once** by the
delegator before launch. It is never edited in place.

- **Everything after creation is a comment.** `append_comment` is the only
  write a working agent makes: gate results, follow-on findings, blocker
  reports, status notes that are not state changes. Comments are the
  record — reports made as you go or at the end, **never a prerequisite to
  starting work**. A delegatee needs NO write to start: read the ticket,
  read the rules, then do the work.
- **A fundamental re-scope never edits the body.** The agent creates a NEW
  ticket with `parent_id` pointing at the old one and marks the old one
  `superseded` — a terminal closed status, distinct from `cancelled`
  (abandoned / will-not-fix). `parent_id` gives durable lineage across
  sessions, forks and reboots.
- **Nothing is ever hard-deleted.** `purge_older_than` is a soft delete,
  scoped to the owner's rollout; only the orchestrator calls it. Durable
  state survives interrupts, power-offs and clean-ups — that persistence is
  the primary value.

Like a Jira issue: the description is the spec; the comment stream is the
history.

## Who does what (delegation)

- The **delegator** (the main agent raising the ticket) sets it up:
  `ticket add rollout_id=<its uuid> todo="..."` (+ the plan as
  `md_content`). It owns the rollout uuid that every mutation must carry.
  It does **not** call `get_delegee_rules` — the rules are not for it. On
  return it reviews the diff, runs the tests, and commits.
- The **delegatee** (the launched subagent) is handed ONLY the ticket
  number. Its first two calls are READS: `ticket get id=N` (its full
  instructions), then `get_delegee_rules`. It **never edits the ticket**
  — it reports as comments (`append_comment` with the owner's rollout
  uuid) and marks its item done. `ticket delegate id=N` prints the
  one-line launch prompt.
- Mark-complete vs. drop: a subagent MARKS its todo item / ticket done; only
  the **orchestrator** removes todo items and soft-deletes
  (`purge_older_than`, rollout-scoped). The tool never hard-deletes.

## The loop

1. `ticket add rollout_id=<your session uuid> todo="one-line summary"` →
   returns the permanent ticket number **N**.
2. `todowrite` — append item `N: <descriptive name>` at the END of the list
   (front only when the user says do it next or gives an order).
3. Write the detailed plan to `.tmp/tickets/NNN_slug.md` in the repo's
   gitignored scratch (zero-padded ticket number + short slug).
4. `ticket link_md id=N rollout_id=<your uuid> md_content=<file contents>` —
   the database copy is the record; the file is scratch. This is a
   **delegator** action: it writes the immutable body before launch.
   Handoffs pass the ticket NUMBER, never a disk path.
5. Subagents (optional) read their full instructions with
   `ticket get id=N` — and need no write to start work.
6. Closing the todo item closes ticket N — the plugin mirrors every
   `todowrite` flush, scoped to the flushing session's own tickets.

The ticket database lives at
`~/.config/opencode/opencode_ticketing/ticket.db` (`TICKET_DB_HOME`
override): one database in the config tree, every repo points at it.

## What's in this repo

- [`skills/opencode-ticketing/SKILL.md`](https://github.com/prompt-cult/opencode-ticketing/blob/main/skills/opencode-ticketing/SKILL.md) —
  the ticketing workflow: ticket → numbered todo → plan file → delegate by
  ticket number → todos close tickets automatically.
- `v2.2.1/` — the current release for **opencode 2.2** (self-contained:
  `ticket.ts` inlines the TicketStore, no `lib/` import; `todo-protocol.ts`
  ships unchanged from v2.2):
  - `ticket.ts` — the `ticket` tool: a shared SQLite **ticket database** +
    global ticket-number sequencer. Tickets survive sessions, restarts,
    compaction and repo cleanups; the record grows via comments
    (`append_comment`), a fundamental re-scope supersedes the ticket via
    `parent_id`, and tickets transfer between sessions (`novate`). Nothing
    is hard-deleted.
  - `todo-protocol.ts` — rewrites the `todowrite` description to the
    flush/deque protocol (bottom-default appends, footer items for discovered
    constraints, parallel `in_progress` for parallel subagents) and strips
    the shipped serial-todo prompt bullets.
- `v2.2/` — the split-lib layout kept for history/alternative (the
  Promise plugin API: default export `{ id, setup }`, hooks registered via
  `ctx.tool.transform` / `ctx.tool.hook` / `ctx.session.hook`):
  - `ticket.ts` — imports `TicketStore` from `../lib/ticket-store`.
  - `todo-protocol.ts` — same as above.
  - `lib/ticket-store.ts` — the TicketStore library (bun:sqlite only; loaded
    by `ticket.ts`, never registered as a plugin itself).
- `v1.19/` — the legacy 1.x-era plugin (kept for history; 2.2 replaces it).

Install centrally (`~/.config/opencode/plugin/` + `~/.config/opencode/lib/`)
and opencode auto-discovers the plugins in every session — see Install below.
Do not keep copies in a repo's `.opencode/plugin/` as well: opencode loads
both, and the supervisor disables same-id duplicates.

## Install

Skill — make it discoverable by opencode's skill loader:

```sh
git clone git@github.com:prompt-cult/opencode-ticketing.git
mkdir -p ~/.config/opencode/skills
ln -s "$(pwd)/opencode-ticketing/skills/opencode-ticketing" ~/.config/opencode/skills/
```

(or add the repo to `skills.paths` in `opencode.json(c)`).

Plugin (opencode 2.2) — install centrally. opencode auto-discovers every
`.ts` under `~/.config/opencode/plugin/`. The current release is
self-contained, so only two files are needed:

```sh
mkdir -p ~/.config/opencode/plugin
cp v2.2.1/ticket.ts v2.2.1/todo-protocol.ts ~/.config/opencode/plugin/
```

Alternative (split layout, v2.2):

```sh
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/lib
cp v2.2/ticket.ts v2.2/todo-protocol.ts ~/.config/opencode/plugin/
cp v2.2/lib/ticket-store.ts ~/.config/opencode/lib/
```

No `plugin` entries in `opencode.jsonc` are needed (and file entries only
log a "configured plugin path must be a directory" warning).

Restart opencode — plugins and skills load once at startup.

Verify: the `ticket` tool is present when the agent can call it, and the first
sentence of the `todowrite` description is "Maintain the session todo list."

## Tests

The store's bun:test suite lives with the 1.x-era plugin:

```sh
bun test v1.19/
```

The `v2.2` plugins are exercised by loading them in opencode itself
(`opencode run` picks up the central install from any directory); the
self-contained entry has its own contract suite: `bun test v2.2.1/`.
