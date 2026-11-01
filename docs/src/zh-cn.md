# opencode-ticketing

[English](index.md) | 中文

**给 opencode 代理用的 Jira。一个 SQLite 文件。所有会话,所有仓库。**

opencode 的 skill + 配套插件：ticket 是关注中心。创建 ticket,给 todo 项编号,把计划存入 ticket,然后委派。

- [`skills/opencode-ticketing/SKILL.md`](https://github.com/prompt-cult/opencode-ticketing/blob/main/skills/opencode-ticketing/SKILL.md) —
  ticketing 工作流：ticket → 编号 todo → 计划文件 → 按 ticket 编号委派 →
  todos 自动关闭 ticket。
- `v2.2.1/` — **opencode 2.2** 的当前发布版（自包含：`ticket.ts`
  内联 TicketStore,无 `lib/` 导入；`todo-protocol.ts` 与 v2.2 一致）：
  - `ticket.ts` — `ticket` 工具：共享 SQLite **ticket 数据库** +
    全局 ticket 编号序列器。Tickets 跨会话、重启、压缩和仓库清理而存续；
    可修订（`link_md`）、在会话间转移（`novate`）、从任意仓库搜索。从不
    硬删除。
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

## The loop

1. `ticket add rollout_id=<your session uuid> todo="one-line summary"` →
   返回永久 ticket 编号 **N**。
2. `todowrite` — 在列表末尾追加项 `N: <descriptive name>`（仅当用户说
   "do it next" 或给出明确顺序时才前置）。
3. 将详细计划写入仓库 gitignored scratch 中的 `.tmp/tickets/NNN_slug.md`
   （零填充 ticket 编号 + 短 slug）。
4. `ticket link_md id=N rollout_id=<your uuid> md_content=<file contents>` —
   数据库副本是记录；文件是 scratch。交接传递 ticket 编号,绝不传磁盘路径。
5. Subagents（可选）使用 `ticket get id=N` 读取完整指令。
6. 关闭 todo 项即关闭 ticket N —— 插件镜像每次 `todowrite` flush,范围
   限定为刷新会话自身的 tickets。

Ticket 数据库位于
`~/.config/opencode/opencode_ticketing/ticket.db`（`TICKET_DB_HOME`
覆盖）：config 树中的一个数据库,所有仓库都指向它。

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

## Mark-complete vs. drop

Subagent **标记**其 todo 项 / ticket 完成（`status: completed`）；从不
移除任何东西。只有 **orchestrator** 从列表中移除 todo 项,也只有
orchestrator 软删除 tickets（`purge_older_than` 是软删除,按 rollout
范围；ticket 工具从不硬删除）。todo 镜像在 flush 时关闭 tickets,范围
限定为刷新会话自身的 tickets；手动 `ticket update` 仅用于不在活跃列表
中的 tickets。

## Tests

store 的 bun:test 套件随 1.x 时代插件：

```sh
bun test v1.19/
```

`v2.2` 插件通过在 opencode 中加载来验证（`opencode run` 从任意目录
拾取集中安装）。
