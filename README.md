# opencode-ticketing

A skill + companion plugin pair for [opencode](https://opencode.ai): the
ticket is the centre of attention. Create a ticket, number the todo item with
it, store the plan in the ticket, then delegate.

- `skills/opencode-ticketing/SKILL.md` — the ticketing workflow: ticket →
  numbered todo → plan file → delegate by ticket number → todos close tickets
  automatically.
- `v2.2/` — the current plugins for **opencode 2.2** (the Promise plugin API:
  default export `{ id, setup }`, hooks registered via `ctx.tool.transform` /
  `ctx.tool.hook` / `ctx.session.hook`):
  - `ticket.ts` — the `ticket` tool: a shared SQLite **ticket database** +
    global ticket-number sequencer. Tickets survive sessions, restarts,
    compaction and repo cleanups; they can be amended (`link_md`), transferred
    between sessions (`novate`), and searched from any repo. Nothing is
    hard-deleted.
  - `todo-protocol.ts` — rewrites the `todowrite` description to the
    flush/deque protocol (bottom-default appends, footer items for discovered
    constraints, parallel `in_progress` for parallel subagents) and strips
    the shipped serial-todo prompt bullets.
  - `lib/ticket-store.ts` — the TicketStore library (bun:sqlite only; loaded
    by `ticket.ts`, never registered as a plugin itself).
- `v1.19/` — the legacy 1.x-era plugin (kept for history; 2.2 replaces it).

Install centrally (`~/.config/opencode/plugin/` + `~/.config/opencode/lib/`)
and opencode auto-discovers the plugins in every session — see Install below.
Do not keep copies in a repo's `.opencode/plugin/` as well: opencode loads
both, and the supervisor disables same-id duplicates.

## The loop

1. `ticket add rollout_id=<your session uuid> todo="one-line summary"` →
   returns the permanent ticket number **N**.
2. `todowrite` — append item `N: <descriptive name>` at the END of the list
   (front only when the user says do it next or gives an order).
3. Write the detailed plan to `.tmp/tickets/NNN_slug.md` in the repo's
   gitignored scratch (zero-padded ticket number + short slug).
4. `ticket link_md id=N rollout_id=<your uuid> md_content=<file contents>` —
   the database copy is the record; the file is scratch. Handoffs pass the
   ticket NUMBER, never a disk path.
5. Subagents (optional) read their full instructions with
   `ticket get id=N`.
6. Closing the todo item closes ticket N — the plugin mirrors every
   `todowrite` flush, scoped to the flushing session's own tickets.

The ticket database lives at
`~/.config/opencode/opencode_ticketing/ticket.db` (`TICKET_DB_HOME`
override): one database in the config tree, every repo points at it.

## Install

Skill — make it discoverable by opencode's skill loader:

```sh
git clone git@github.com:prompt-cult/opencode-ticketing.git
mkdir -p ~/.config/opencode/skills
ln -s "$(pwd)/opencode-ticketing/skills/opencode-ticketing" ~/.config/opencode/skills/
```

(or add the repo to `skills.paths` in `opencode.json(c)`).

Plugin (opencode 2.2) — install centrally. opencode auto-discovers every
`.ts` under `~/.config/opencode/plugin/`; the lib lives one level up so it is
not mistaken for a plugin:

```sh
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/lib
cp v2.2/ticket.ts v2.2/todo-protocol.ts ~/.config/opencode/plugin/
cp v2.2/lib/ticket-store.ts ~/.config/opencode/lib/
```

No `plugin` entries in `opencode.jsonc` are needed (and file entries only
log a "configured plugin path must be a directory" warning).
```

Restart opencode — plugins and skills load once at startup.

Verify: the `ticket` tool is present when the agent can call it, and the first
sentence of the `todowrite` description is "Maintain the session todo list."

## Tests

The store's bun:test suite lives with the 1.x-era plugin:

```sh
bun test v1.19/
```

The `v2.2` plugins are exercised by loading them in opencode itself
(`opencode run` in this repo auto-loads the `.opencode/` copies).
