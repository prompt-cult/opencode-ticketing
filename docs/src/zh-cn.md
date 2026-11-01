# opencode-ticketing

[English](index.md) | 中文

**给 opencode 代理用的 Jira。一个 SQLite 文件。所有会话,所有仓库。**

opencode 的 skill + 配套插件：ticket 是关注中心。

## 理念：ticket 不可变

Ticket 的正文（`md_content`）是**规格,只写一次**,由 delegator 在启动
委派之前写好。它从不在原地被编辑。

- **创建之后的一切都是评论。** `append_comment` 是工作 agent 唯一的写入：
  gate 结果、后续发现、阻塞报告、非状态变更的状态说明。评论是记录 ——
  随工作进展或结束时提交的报告,**绝不是开始工作的前置条件**。delegatee
  开始工作不需要任何写入：读 ticket、读规则,然后干活。
- **根本性的重定范围也从不编辑正文。** Agent 创建一个新 ticket,
  `parent_id` 指向旧 ticket,并把旧的标记为 `superseded` —— 一个终态的
  关闭状态,区别于 `cancelled`（放弃 / 不会修）。`parent_id` 提供跨会话、
  跨 fork、跨重启的持久谱系。
- **从不硬删除。** `purge_older_than` 是软删除,限定在所有者的 rollout
  范围内；只有 orchestrator 调用它。持久状态在打断、断电和清理中幸存 ——
  这种持久性是首要价值。

就像一个 Jira issue：描述是规格,评论流是历史。

## 谁做什么（委派）

- **delegator**（提出 ticket 的主 agent）负责建立它：
  `ticket add rollout_id=<它的 uuid> todo="..."`（+ 计划作为
  `md_content`）。它拥有所有 mutation 必须携带的 rollout uuid。它
  **不**调用 `get_delegee_rules` —— 规则不是给它的。返回后它审查
  diff、跑测试、提交。
- **delegatee**（被启动的 subagent）只拿到 ticket 编号。它的前两个调用
  都是读取：`ticket get id=N`（完整指令）,然后 `get_delegee_rules`。它
  **从不编辑 ticket** —— 它以评论报告（`append_comment`,带所有者的
  rollout uuid）并标记自己的项完成。`ticket delegate id=N` 打印一行
  启动提示词。
- 标记完成 vs. 移除：subagent **标记**其 todo 项 / ticket 完成；只有
  **orchestrator** 移除 todo 项并软删除（`purge_older_than`,按 rollout
  范围）。工具从不硬删除。

## The loop

1. `ticket add rollout_id=<your session uuid> todo="one-line summary"` →
   返回永久 ticket 编号 **N**。
2. `todowrite` — 在列表末尾追加项 `N: <descriptive name>`（仅当用户说
   "do it next" 或给出明确顺序时才前置）。
3. 将详细计划写入仓库 gitignored scratch 中的 `.tmp/tickets/NNN_slug.md`
   （零填充 ticket 编号 + 短 slug）。
4. `ticket link_md id=N rollout_id=<your uuid> md_content=<file contents>` —
   数据库副本是记录；文件是 scratch。这是 **delegator** 动作：在启动
   委派之前写入不可变正文。交接传递 ticket 编号,绝不传磁盘路径。
5. Subagents（可选）使用 `ticket get id=N` 读取完整指令 —— 开始工作
   不需要任何写入。
6. 关闭 todo 项即关闭 ticket N —— 插件镜像每次 `todowrite` flush,范围
   限定为刷新会话自身的 tickets。

Ticket 数据库位于
`~/.config/opencode/opencode_ticketing/ticket.db`（`TICKET_DB_HOME`
覆盖）：config 树中的一个数据库,所有仓库都指向它。

## 仓库内容

- [`skills/opencode-ticketing/SKILL.md`](https://github.com/prompt-cult/opencode-ticketing/blob/main/skills/opencode-ticketing/SKILL.md) —
  ticketing 工作流：ticket → 编号 todo → 计划文件 → 按 ticket 编号委派 →
  todos 自动关闭 ticket。
- `v2.2.1/` — **opencode 2.2** 的当前发布版（自包含：`ticket.ts`
  内联 TicketStore,无 `lib/` 导入；`todo-protocol.ts` 与 v2.2 一致）：
  - `ticket.ts` — `ticket` 工具：共享 SQLite **ticket 数据库** +
    全局 ticket 编号序列器。Tickets 跨会话、重启、压缩和仓库清理而存续；
    记录通过评论（`append_comment`）增长,根本性重定范围通过
    `parent_id` 使旧 ticket 被 superseded,ticket 可在会话间转移
    （`novate`）。从不硬删除。
  - `todo-protocol.ts` — 将 `todowrite` 描述重写为 flush/deque 协议
    （默认追加到底部、为发现的约束添加 footer 项、并行 subagent 并行
    `in_progress`），并剥离自带的串行 todo 提示条目。
- `v2.2/` — 保留的历史/备选分库布局（Promise 插件 API：默认导出
  `{ id, setup }`,hooks 通过 `ctx.tool.transform` / `ctx.tool.hook` /
  `ctx.session.hook` 注册）：
  - `ticket.ts` — 从 `../lib/ticket-store` 导入 `TicketStore`。
  - `todo-protocol.ts` — 同上。
  - `lib/ticket-store.ts` — TicketStore 库（仅 bun:sqlite；由 `ticket.ts`
    加载,从不作为插件注册）。
- `v1.19/` — 旧版 1.x 插件（保留供历史；2.2 取代它）。

集中安装（`~/.config/opencode/plugin/` + `~/.config/opencode/lib/`），
opencode 在每个会话中自动发现插件——见下文 Install。不要同时在仓库的
`.opencode/plugin/` 中保留副本：opencode 会同时加载两者，supervisor 会
禁用同 id 的重复项。

## Install

Skill — 让 opencode 的 skill 加载器可发现：

```sh
git clone git@github.com:prompt-cult/opencode-ticketing.git
mkdir -p ~/.config/opencode/skills
ln -s "$(pwd)/opencode-ticketing/skills/opencode-ticketing" ~/.config/opencode/skills/
```

（或在 `opencode.json(c)` 中把仓库加入 `skills.paths`）。

Plugin (opencode 2.2) — 集中安装。opencode 自动发现
`~/.config/opencode/plugin/` 下的所有 `.ts`。当前发布版自包含,只需两个
文件：

```sh
mkdir -p ~/.config/opencode/plugin
cp v2.2.1/ticket.ts v2.2.1/todo-protocol.ts ~/.config/opencode/plugin/
```

备选（分库布局，v2.2）：

```sh
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/lib
cp v2.2/ticket.ts v2.2/todo-protocol.ts ~/.config/opencode/plugin/
cp v2.2/lib/ticket-store.ts ~/.config/opencode/lib/
```

`opencode.jsonc` 中不需要 `plugin` 条目（而文件条目只会记录一条
"configured plugin path must be a directory" 警告）。

重启 opencode —— 插件和 skill 仅在启动时加载一次。

验证：agent 可调用 `ticket` 工具，并且 `todowrite` 描述的第一句是
"Maintain the session todo list."。

## Tests

store 的 bun:test 套件随 1.x 时代插件：

```sh
bun test v1.19/
```

`v2.2` 插件通过在 opencode 中加载来验证（`opencode run` 从任意目录
拾取集中安装）；自包含入口有自己的契约套件：`bun test v2.2.1/`。
