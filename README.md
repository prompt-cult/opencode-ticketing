# opencode-subagent-delegation

A skill + companion plugin pair for [opencode](https://opencode.ai): delegate
major todo items to subagents while keeping the orchestrator's context lean.

- `skills/opencode-subagent-delegation/SKILL.md` — the delegation workflow:
  break a plan into numbered ticket files, delegate each ticket to a subagent,
  gate commits on verified-green work (`wip:` prefix until the feature set is
  complete).
- `plugin/todo-protocol.ts` — rewrites the `todowrite` tool description to the
  flush/deque protocol (slug ids `item00`, Dewey-decimal insertion `item05.5`,
  bottom-default appends, footer items for discovered constraints, parallel
  `in_progress` for parallel subagents) and strips the shipped serial-todo
  prompt bullets.

## Division of responsibility

The plugin owns todo **list mechanics** (what a write means, how items are
identified and ordered). The skill owns **process** (plan → tickets →
delegation → commit gating). Where both speak, the tool description governs
list mechanics and the skill governs workflow.

## Install

Skill — make it discoverable by opencode's skill loader:

```sh
git clone https://github.com/prompt-cult/opencode-subagent-delegation
mkdir -p ~/.config/opencode/skills
ln -s "$(pwd)/opencode-subagent-delegation/skills/opencode-subagent-delegation" ~/.config/opencode/skills/
```

(or add the repo to `skills.paths` in `opencode.json(c)`).

Plugin — copy them into the plugin folder and list them in the global config:

```sh
cp opencode-subagent-delegation/plugin/*.ts ~/.config/opencode/plugin/
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["./plugin/todo-protocol.ts", "./plugin/task-sidecar.ts"]
}
```

Restart opencode — plugins and skills load once at startup.

Verify: ask the running agent to quote the first sentence of its `todowrite`
tool description. It must begin "Maintain the session todo list." If it does
not, the plugin is not loaded. The `task_sidecar` tool is present when the
agent can call it.

## Scratch convention

v0.0.3+: the sidecar is NOT a todo list — the built-in `todowrite` list is
the hot, ordered set. The sidecar (`task_sidecar` custom tool) is COLD
storage: task detail (living md docs) plus the GLOBAL SEQUENCER (its
autoincrement id is the only global task number). DB at
`${VPS_GRAPEVINE_HOME:-~/.vps-grapevine}/task_sidecar_store.db`. Access
pattern: insert one row, read one row, lazy soft delete — nothing is ever
hard-deleted.

v0.0.4: the statuses are MIRRORED, mechanically. The plugin hooks every
`todowrite` flush: an item whose content starts with `N:` carries the global
sidecar id, and the flush sets row N's status to the item's status
(`completed` closes the row, `cancelled` soft-closes it). Models cannot
forget to close rows — closing the todo item IS closing the row. Rows not
referenced by the flush (parked, other sessions) are never touched.
Manual `task_sidecar update status=...` is only for rows outside the
built-in list. See the skill's setup step for the opencode.jsonc permission
whitelist and the call sequence. The old repo `.tmp/` convention below is
retained only for cancelled-attempt files (`.tmp/attic/`); `.tmp/*` is
gitignored; `.tmp/keep` keeps the folder in git. Nothing in scratch is
history: work belongs in git, in the todo list, or moved out of the way.

v0.0.5: the fat record lives IN THE DB. `md_content` on a row is the task's
living document — full spec, issue details, decisions, amendments — and it is
what a delegated subagent reads via `task_sidecar get id=N`. `md_path` is a
legacy annotation only: a handoff that passes a disk path can lose the spec
to a `.tmp` clear-down.

v0.0.6: every row is NAMESPACED to the rollout that owns it. `rollout_id` is
mandatory on `add`, `update`, `link_md` and `purge_older_than`, and `add`
returns the handle tuple `{"rollout_id", "id"}`. Mutations outside the owning
namespace are refused (a subagent amends a row it was handed by naming the
owner's uuid); `purge_older_than` only touches the caller's own namespace;
the `todowrite` mirror closes only the flushing session's rows, so one
session's list can never close another's row. The plugin stamps
`observed_session` and `last_actor` from the harness-reported session id, so
the audit trail is ground truth. Reads stay unscoped — auditing other
rollouts must be possible — and can filter by `rollout_id`. Rows predating
the namespace carry the `rollout_id` marker `"0"`, which is a marker and not
an identity: never pass `"0"` as your own uuid. A legacy row is moved into a
real namespace only by `adopt id=N rollout_id=<your uuid>` — one way, and
refused for a row that already has an owner.

v0.0.7: `novate id=N rollout_id=<the row's CURRENT owner>
to_rollout_id=<the target rollout uuid>` transfers a row between ANY two real
rollouts — adopt's general form. This is how rows parked in dead or
superseded sessions are tidied without falsifying provenance: the owner uuid
is the namespace key and is on the record, the mover is stamped `last_actor`,
and the todo and fat record ride along intact. Refused for a wrong owner
(the error names the true one), a missing target, the legacy marker as
target, or target == owner.
