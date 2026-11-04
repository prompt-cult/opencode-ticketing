# opencode-ticketing

English | [中文](zh-cn.md)

**Jira for your [opencode](https://opencode.ai) agents. One SQLite file.
Every session, every repo.**

A skill + companion plugin pair for [opencode](https://opencode.ai): the
ticket is the centre of attention.

## The idea: tickets are immutable

A ticket's body (`md_content`) is **the spec, written once** at creation.
It is never rewritten — there is no rewrite action.

- **Everything after creation is a comment — and a comment is a SHORT
  go/no-go note**: done / not done / blocked, 1000 chars max, one at a
  time. Long reports NEVER go on the ticket: detail lives in the agent's
  final response (or a gist), outside the ticket world. A delegatee
  needs NO write to start: read the ticket, read the rules, then do the
  work.
- **Status is the only field that ever changes** — and the todo mirror
  writes it automatically: closing the todo item `N: …` closes ticket N.
  `ticket_status` covers the rest (owner-gated), including `superseded`:
  a re-scope is a status change plus a comment naming the replacement.
- **Nothing is ever deleted.** There is no delete action.

Like a Jira issue: the description is the spec; the comment stream is the
history.

## Who does what (delegation)

- The **delegator** (the main agent) creates the ticket:
  `ticket_add rollout_id=<its session id> todo="..."` (+ the plan as
  `md_content`, written once). It owns the session id. It does **not**
  call `ticket_rules` — the rules are not for it. On return it
  reviews the diff, runs the tests, and commits.
- The **delegatee** (the launched subagent) is handed ONLY the ticket
  number. Its first two calls are READS: `ticket_get id=N` (its full
  instructions), then `ticket_rules`. It **never edits the ticket** —
  it reports as comments (`ticket_comment`, its own session) and, when done,
  `ticket_status` with the OWNER's session id.
- Mark-complete vs. drop: a subagent MARKS its item / the ticket done; only
  the **orchestrator** removes todo items. Nothing is ever deleted.

## The tool surface

```
ticket_add rollout_id=<session id> todo="…" [md_content=spec]   create the immutable ticket
ticket_comment id=N content="…"                                 append one SHORT note (1000 max)
ticket_status id=N rollout_id=<OWNER session id> status=…       the only mutation
ticket_get id=N                                                  read the ticket + comments
ticket_list rollout_id=<session id> [status=]                    one session's tickets (all=true: every session's)
ticket_rules / ticket_help                                       the delegatee banner / the whole contract
```

A comment is a short go/no-go note — done / not done / blocked. Long reports
never go on the ticket: they live in the agent's final response (or a gist).

One tool per action — there is no action string to spell wrongly. Each
tool's legal parameters are defined by an [RFC 8927](https://github.com/prompt-cult/json-type-definition-RFC-8927)
(JSON Type Definition) schema and validated before the call runs: unknown
parameters, wrong types and illegal values are rejected outright. Every
failure returns a structured envelope `{code, message, corrected_call}` —
re-emit `corrected_call` verbatim and the call succeeds.

`rollout_id` IS the session id — one id, no other. An agent **must know its
own session id**: `add` and `list` take it by default. A delegator handing
work to a delegatee **names the session id the delegatee must use**. To adopt
another session's tickets, query with that session id. Access is by ticket
number everywhere else. `list` requires it — an agent must know which
session it is querying (`all=true` lists every session's).

Statuses: `pending | in_progress | completed | cancelled | superseded`.
Closing the todo item `N: …` sets ticket N's status automatically (the
plugin mirrors every `todowrite` flush, scoped to the flushing session's
own tickets).

The ticket database lives at
`~/.config/opencode/opencode_ticketing/ticket.db` (`TICKET_DB_HOME`
override): one database in the config tree, every repo points at it.

## What's in this repo

- [`skills/opencode-ticketing/SKILL.md`](https://github.com/prompt-cult/opencode-ticketing/blob/main/skills/opencode-ticketing/SKILL.md) —
  the ticketing workflow: ticket → numbered todo → delegate by ticket
  number → todos close tickets automatically.
- `v2.2.1/` — the current release for **opencode 2.2** (self-contained:
  `ticket.ts` inlines the TicketStore, no `lib/` import; `todo-protocol.ts`
  rewrites the `todowrite` description to the flush/deque protocol).

Install centrally (`~/.config/opencode/plugin/`) and opencode auto-discovers
the plugins in every session. Do not keep copies in a repo's
`.opencode/plugin/` as well: opencode loads both, and the supervisor
disables same-id duplicates.

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

No `plugin` entries in `opencode.jsonc` are needed (and file entries only
log a "configured plugin path must be a directory" warning).

Restart opencode — plugins and skills load once at startup.

Verify: the `ticket` tool is present when the agent can call it, and the first
sentence of the `todowrite` description is "Maintain the session todo list."

## Tests

```sh
bun test v2.2.1/
```

The contract suite: the immutable body, append-only comments, status as the
only mutation (owner-gated), the delegation banner, and the deleted-verb
guard. Tests run against a scratch `TICKET_DB_HOME`, never the real DB.
