// todo-protocol — customizes the todowrite tool description (flush/deque protocol)
// and strips the shipped serial-todo bullets from the assembled system prompt.
// No imports on purpose: this file is loaded standalone and must never fail to
// resolve modules; hooks are pure string/field mutations.

const TODOWRITE_DESCRIPTION = `Maintain the session todo list. Every call writes the complete list as one atomic snapshot — the transaction is the harness's; the protocol is what a flush means.

Flush protocol:
- Construct the new list, then flush it in one call. Batch status changes at natural boundaries instead of micro-flushing.
- Each item's content starts with its slug (item00, item01, …; Dewey-decimal insertion files new items between existing ones, e.g. item05.5). The slug is the item's permanent id. Never renumber. Array position is just current order.
- Deque semantics, expressed as the snapshot you flush:
  - New user tasks default to the bottom. Only place elsewhere when the user says do it next / push it.
  - Follow-on work found while completing an item is appended as new items at the bottom — never folded into the old item by editing it.
  - Never rewrite or reorder existing rows to absorb new information. A discovered "do not do X" that applies to remaining work is appended as a footer item at the bottom — done items don't care; future items need fast footers.
- The fat record for an item is its living document — itemNN.md in the plan or the project's gitignored scratch directory — subject to amendment. Read an item's living doc before working it; amend the living doc, not the todo row. The living docs and the stored list survive compaction; if the list state is uncertain, re-derive it from the living docs, then flush.
- Status: pending | in_progress | completed | cancelled. Mark completed on the first non-crashed attempt; follow-on work becomes a new item rather than holding the old one open. Several items may be in_progress at once when work is genuinely parallel (one per running subagent) — never fewer than one while work remains, never stale ones. cancelled keeps the record instead of deleting it.
- Priority: high | medium | low.
- Single writer: only the orchestrator flushes. Subagents report back; the orchestrator updates the list.`

// exact shipped sentences (opencode v1.18.32 prompt files), removed verbatim;
// regex entries for lines with encoding-variable punctuation
const STRIPPED: [string | RegExp, string][] = [
  // anthropic.txt
  [
    "You have access to the TodoWrite tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.",
    "",
  ],
  [
    "It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.",
    "",
  ],
  // beast.txt
  [
    'If the user request is "resume" or "continue" or "try again", check the previous conversation history to see what the next incomplete step in the todo list is. Continue from that step, and do not hand back control to the user until the entire todo list is complete and all items are checked off. Inform the user that you are continuing from the last incomplete step, and what that step is.',
    "",
  ],
  [
    "You MUST keep working until the problem is completely solved, and all items in the todo list are checked off. Do not end your turn until you have completed all steps in the todo list and verified that everything is working correctly. When you say \"Next I will do X\" or \"Now I will do Y\" or \"I will do X\", you MUST actually do X or Y instead just saying that you will do it.",
    "",
  ],
  [
    "Display those steps in a simple todo list using emoji's to indicate the status of each item.",
    "",
  ],
  ["- Create a todo list in markdown format to track your progress.", ""],
  ["- Each time you check off a step, display the updated todo list to the user.", ""],
  [
    "Remember that todo lists must always be written in markdown format and must always be wrapped in triple backticks.",
    "",
  ],
  // copilot-gpt-5.txt
  [" - use the todo tool to track your progress.", "."],
  [
    "- Review and update the todo list, marking completed, skipped (with explanations), or blocked items.",
    "",
  ],
  ["- Create a todo list to track your progress.", ""],
  ["- Each time you check off a step, update the todo list.", ""],
  // meta.txt
  ["# Tool Use – `TodoWrite` Tools", ""],
  [
    "- You have access to the `TodoWrite` tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.",
    "",
  ],
  [/- These tools are also EXTREMELY helpful for planning tasks.*$/gm, ""],
  [
    "- It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.",
    "",
  ],
  ["- Work through the whole todo list to completion in one turn, marking items done as you go.", ""],
]

// 2.2 Promise plugin API: default export { id, setup }; the session context
// event carries mutable `system` parts and the live tool descriptions, so the
// "tool.definition" and "experimental.chat.system.transform" hooks from 1.x
// collapse into one session.hook("context") registration. No imports: the
// file loads standalone.
export default {
  id: "todo-protocol",
  setup: async (ctx) => {
    await ctx.session.hook("context", async (event) => {
      if (event.tools?.todowrite) event.tools.todowrite.description = TODOWRITE_DESCRIPTION
      for (let i = 0; i < event.system.length; i++) {
        let s: any = event.system[i]
        if (typeof s === "string") {
          event.system[i] = rewrite(s)
          continue
        }
        if (typeof s?.text === "string") s.text = rewrite(s.text)
      }
    })
  },
}

function rewrite(s: string): string {
  for (const [needle, replacement] of STRIPPED) s = s.replaceAll(needle, replacement)
  return s.replace(/\n{3,}/g, "\n\n")
}
