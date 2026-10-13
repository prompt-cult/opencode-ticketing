---
name: opencode-subagent-delegation
description: Use when working through a multi-item todo list of non-trivial engineering tasks — delegate each major item to a subagent whose full instructions live in the task_sidecar DB (passed by ID, never by disk path), keep the orchestrator context lean, and gate commits on verified-green work with a wip prefix until the feature set is complete.
---

# Subagent Delegation Process

Major todo items are delegated to subagents to keep the orchestrator's context lean.

## Division of responsibility

The companion `todo-protocol` plugin owns the todo LIST mechanics — the flush
protocol, slug numbering, deque semantics, statuses, footer items — via the
rewritten `todowrite` tool description. This skill owns the WORKFLOW: turning a
plan into numbered tickets in the sidecar DB, delegating each ticket by its DB
id, and gating commits on verified-green work. Where both speak, the tool
description governs list mechanics and this skill governs process.

## Setup (once per environment, with the user's permission)

1. **Companion plugin.** This skill requires the `todo-protocol` plugin
   (`plugin/todo-protocol.ts` in this repository). Verify it is loaded by asking
   the running agent to quote the first sentence of its `todowrite` tool
   description: it must begin "Maintain the session todo list." If it does not:
   copy `plugin/todo-protocol.ts` to `~/.config/opencode/plugin/`, add
   `"plugin": ["./plugin/todo-protocol.ts"]` to
   `~/.config/opencode/opencode.json(c)` (ask before modifying the user's
   config), and restart opencode.
2. **Cold task store (task_sidecar, v0.0.6+).** The sidecar is NOT the todo
   list — the built-in `todowrite` list is the hot, ordered set. The sidecar
   (`plugin/task-sidecar.ts`) is cold blob storage for task detail (the
   living md documents) plus the GLOBAL SEQUENCER: its autoincrement id is
   the only global task number. DB at
   `${VPS_GRAPEVINE_HOME:-~/.vps-grapevine}/task_sidecar_store.db`.
   **Never read the DB directly** — use the tool; its help spells out the
   rules and example call sequences.
   **Every row belongs to a rollout.** `rollout_id` is REQUIRED on `add`,
   `update`, `link_md` and `purge_older_than`: pass YOUR OWN rollout uuid (the
   session id, `ses_…`). `add` returns the handle tuple
   `{"rollout_id": …, "id": …}` — carry that id everywhere. A mutation outside
   the owning namespace is refused and the error names the owner; a subagent
   handed a row id amends/reports by passing the OWNER's uuid (the row records
   who really acted). `purge_older_than` only ever touches your own namespace.
   Reads (`get`/`list`/`list_since`) stay unscoped — you must be able to audit
   other rollouts — and can filter by `rollout_id`.
   **Legacy rows carry `rollout_id` `"0"`.** That is a marker for
   pre-namespacing rows, not an identity. NEVER pass `"0"` as your own uuid and
   never get into the habit of naming the sentinel: a legacy row that is yours
   to work is moved into your namespace with `adopt id=N rollout_id=<your
   uuid>` — one way, and refused for any row that already has a real owner
   (the error names them). Set the correct uuid for your rows; leave the rest
   for the operator. Rows parked in a dead or superseded session are tidied
   with `novate id=N rollout_id=<the row's CURRENT owner> to_rollout_id=<the
   target rollout uuid>` — the general transfer between real rollouts; the
   owner uuid is on the record, the mover is stamped `last_actor`, and the
   record rides along intact.
   Call sequence for each task:
   - `task_sidecar add rollout_id=<your uuid> todo=<one-line blob>` (a record
     passed as `md_content=` IS stored on the row — nothing is silently
     dropped) → returns `{"rollout_id", "id"}`; the id is the permanent number
   - `todowrite`: description of that item starts with **"N: ..."** (the id
     is the item number; the id is creation sequence, not order — ordering
     lives in the built-in list and can be reordered there)
   - `task_sidecar link_md id=N rollout_id=<owner> md_content=<fat record>` —
     the ticket is the
     item's living document, stored **IN THE DB (*md_content*)**: full spec,
     the issue details (the issue body, verbatim where it matters), decisions,
     amendments. Amend by calling `link_md` again; never stuff prose into
     the todo line. `md_path` is optional annotation only — the DB is the
     authoritative record and **no handoff may pass a disk path as the
     transport**: a `.tmp/` clear-down must not be able to lose a spec.
   - closing work: **closing the todo item closes its row automatically** —
     the plugin mirrors every `todowrite` flush onto the sidecar (an item
     whose content starts with `N:` writes its status to row N; `completed`
     closes it, `cancelled` soft-closes it) — and the mirror is scoped to the
     flushing session's own rows, so your list can never close another
     rollout's row. Do NOT call `task_sidecar
     update` for rows in the built-in list — the flush already did it.
     `task_sidecar update id=N rollout_id=<owner> status=completed|cancelled`
     is only for rows
     NOT in the built-in list (parked, other sessions). The record is NEVER
     deleted (lazy soft delete only; `purge_older_than` /
     `list_since(show_deleted)` are the maintenance and recovery views).
   - **Recovery after a crashed session:** `task_sidecar list` shows what
     was pending/in_progress vs completed — rebuild your built-in todo
     list from that.
   This replaces the old repo `.tmp/` scratch folder: a `.tmp` clear-down
   can no longer lose plans or specs, and ids survive across sessions and
   repos. Migration from v0.0.2 `todo_ng.db` is automatic (legacy file is
   left in place).
   **Setup/whitelist:** the store deliberately lives OUTSIDE the opencode
   data dirs (harnesses block or sweep paths that look like the opencode
   folder). Ask the user for permission, then add to
   `~/.config/opencode/opencode.jsonc`:
   ```jsonc
   "permission": {
     "edit": { "~/.vps-grapevine/**": "allow" },
     "bash": { "*task-sidecar-store*": "allow" }
   }
   ```
   and create the folder once: `mkdir -p ~/.vps-grapevine`.

## Process

1. **Break the plan into items.** Decompose the user's plan into todo items.
   For each item, call `task_sidecar add rollout_id=<your uuid>` (the todo line
   starting with its
   task number) and then `link_md id=N rollout_id=<your uuid>
   md_content=<fat record>` to store the
   item's ticket IN the DB — the ticket is the item's living document: full
   spec, issue details, decisions, amendments. The `md_content` must carry
   everything the agent needs; a `.tmp/` path is an annotation at most and
   is never the transport. Use the id returned by `add` as the durable
   handle and as the item number in the todo list. If the ask traces to a
   gh issue or other ticket, the TODO LINE NAMES IT (e.g.
   `N: fix quorum resend (#123)`) and the record carries the ticket id
   verbatim — an item with a ticket behind it must never read as ticketless.
2. Follow the `todowrite` tool description for every list write: construct the
   whole list, flush once, batch status changes at natural boundaries.
   **Standing rule:** any NEW ask goes to the END of the list as (a) a spec
   into the sidecar (`add` + `link_md`), (b) a todo item carrying that id;
   front-jump only when the user says do it next / do it now. Follow-ons
   discovered during a task are appended at the bottom, never folded into
   live items; discovered constraints ("do not do X") become footer items.
3. Launch one agent per ticket. **The handoff is the DB ID, never a file
   path.** The launch prompt tells the agent its `task_sidecar get id=N`
   row IS its full instructions, and the row's `md_content` must be
   self-contained *before* launch: the issue details (title, body, the
   definition of done), the spec, the constraints, the ban list, the
   register rules, the delivery. The delivery names the **PRE-ASSIGNED
   branch**: the orchestrator names the branch BEFORE launch and records it
   in the record, so every attempt and every follow-on for this task lands
   on the same branch — an agent never invents a branch name, and the
   branch name is findable from the sidecar row alone. The delivery also
   states the PR and merge gates. If the record is thin,
   amend it with `link_md` FIRST — never launch on a thin record and never
   paste the spec through the prompt, the path, or `.tmp/`. Each agent must:
- call `task_sidecar get id=N` and read `md_content` as its ticket,
    - implement the work per the ticket,
    - verify its work is green (run the relevant tests/builds),
    - report back on the row by naming the OWNER's rollout uuid
      (`link_md id=N rollout_id=<owner>` to amend the record as it goes) — a
      foreign namespace is refused, and the row keeps the actor's own session
      id as the audit trail,
    - `git add` its changes, but **NEVER `git commit`**.
4. On the agent's return, it reports whether the work was fully done or lists
   follow-on work. The orchestrator must then:
    - mark the todo item done — that flush closes the matching sidecar row
      automatically (the plugin mirrors item statuses onto rows, scoped to
      your own rollout's rows), so never
      follow it with a manual `task_sidecar update`,
    - add any follow-on work as new todo items with their own sidecar rows
      (`add` + `link_md`, both with your rollout uuid),
   - review the diff (`git status`, `git diff --cached`),
   - if the code is green with respect to the current tests (the current TDD bar),
     `git commit`. Use the message prefix `"wip: <summary>"` while the full feature
     set is not yet complete; use a normal message once it is.
   - if the agent amended its own record (decisions taken mid-run), the
     amendments must land back in the DB via `link_md` before the row is
     closed, so the record stays complete.
5. In this manner subagents handle the majority of tool calls, keeping the
   orchestrator's context lean.
6. **No dangling work, ever.** Before each outer commit the orchestrator must
   check for and tear down dangling runs: processes started by cancelled or
   completed agent attempts (smoke servers, clients, simulators still running),
   and hung or wedged processes. Terminate clear orphans deliberately — never
   the operator's own deliberate, long-running jobs. Files produced by
   cancelled attempts move to a `.tmp/attic/` folder inside the workspace; at
   a milestone tidy-up, when the orchestrator asks, attic content moves to
   `/tmp/` to clean up. Nothing may be left: work is in git, in the todo
   list, moved out of the way, or terminated. (Laptop-specific detection
   tooling — brew-installed procs/pgrep scanners etc. — belongs in the
   repository's own tooling per its `AGENTS.md`; never embed laptop-specific
   tooling in this skill.)

## IMPORTANT — Keep the repository's AGENTS.md in sync

The repository's `AGENTS.md` should be updated to include an entry stating that
agents SHOULD prefer to use this skill wherever doing so does not overwrite any
other instructions in that `AGENTS.md` or the user's prior statements of preference.
