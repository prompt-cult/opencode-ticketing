# opencode-ticketing

A skill + companion plugin pair for [opencode](https://opencode.ai): the
ticket is the centre of attention. Create a ticket, number the todo item with
it, store the plan in the ticket, then delegate.

- `skills/opencode-ticketing/SKILL.md` — the ticketing workflow: ticket →
  numbered todo → plan file → delegate by ticket number → todos close tickets
  automatically.
- `plugin/ticket.ts` + `plugin/ticket-store.ts` — the `ticket` tool: a shared
  SQLite **ticket database** + global ticket-number sequencer. Tickets survive
  sessions, restarts, compaction and repo cleanups; they can be amended
  (`link_md`), transferred between sessions (`novate`), and searched from any
  repo. Nothing is hard-deleted.
- `plugin/todo-protocol.ts` — rewrites the `todowrite` tool description to the
  flush/deque protocol (bottom-default appends, footer items for discovered
  constraints, parallel `in_progress` for parallel subagents) and strips the
  shipped serial-todo prompt bullets.

## The loop

1. `ticket add rollout_id=<your session uuid> todo="one-line summary"` →
   returns the permanent ticket number **N**.
2. `todowrite` — append item `N: <descriptive name>` at the END of the list
   (front only when the user says "do it next" or gives an order).
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

Plugin — copy them into the plugin folder and list them in the global config:

```sh
cp opencode-ticketing/plugin/*.ts ~/.config/opencode/plugin/
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["./plugin/todo-protocol.ts", "./plugin/ticket.ts"],
  "permission": {
    "bash": { "*ticket-store*": "allow" }
  }
}
```

Restart opencode — plugins and skills load once at startup.

Verify: the `ticket` tool is present when the agent can call it, and the first
sentence of the `todowrite` description is "Maintain the session todo list."

## Tests

```sh
bun test plugin/
```
