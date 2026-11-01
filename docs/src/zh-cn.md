# opencode-ticketing

[English](index.md) | 中文

**给 opencode 代理用的 Jira。一个 SQLite 文件。所有会话,所有仓库。**

opencode 的 skill + 配套插件：ticket 是关注中心。

## 理念：ticket 不可变

Ticket 的正文（`md_content`）是**规格,只在创建时写一次**。它从不被重写 ——
没有重写动作。

- **创建之后的一切都是评论。** `append_comment` 是工作 agent 唯一的写入：
  gate 结果、后续发现、阻塞报告。评论是记录 —— 一次一条,
  **绝不是开始工作的前置条件**。delegatee 开始工作不需要任何写入：
  读 ticket、读规则,然后干活。
- **只有状态会变** —— todo 镜像自动写它：关闭 todo 项 `N: …` 即关闭
  ticket N。`set_status` 覆盖其余情况（仅限所有者），包括 `superseded`：
  重定范围 = 一次状态变更 + 一条指明继任者的评论。
- **从不删除。** 没有删除动作。

就像一个 Jira issue：描述是规格,评论流是历史。

## 谁做什么（委派）

- **delegator**（提出 ticket 的主 agent）创建它：
  `ticket add rollout_id=<它的 uuid> todo="..."`（+ 计划作为
  `md_content`,只写一次）。它拥有 rollout uuid。它**不**调用
  `get_delegee_rules` —— 规则不是给它的。返回后它审查 diff、跑测试、
  提交。
- **delegatee**（被启动的 subagent）只拿到 ticket 编号。它的前两个调用
  都是读取：`ticket get id=N`（完整指令）,然后 `get_delegee_rules`。它
  **从不编辑 ticket** —— 它以评论报告（`append_comment`,用自己的
  uuid）,完成时用**所有者的** uuid 调 `set_status`。
- 标记完成 vs. 移除：subagent **标记**其项 / ticket 完成；只有
  **orchestrator** 移除 todo 项。从不删除任何东西。

## 工具面

```
add rollout_id=<uuid> todo="…" [md_content=spec]   创建不可变 ticket
append_comment id=N rollout_id=<uuid> content="…"  追加一条评论
set_status id=N rollout_id=<所有者 uuid> status=…  唯一的变更
get id=N                                           读 ticket + 评论
list [rollout_id=] [status=]                       恢复用读取
get_delegee_rules / help                           delegatee 横幅 / 完整契约
```

状态：`pending | in_progress | completed | cancelled | superseded`。
关闭 todo 项 `N: …` 会自动设置 ticket N 的状态（插件镜像每次
`todowrite` flush,范围限定为刷新会话自身的 tickets）。

Ticket 数据库位于
`~/.config/opencode/opencode_ticketing/ticket.db`（`TICKET_DB_HOME`
覆盖）：config 树中的一个数据库,所有仓库都指向它。

## 仓库内容

- [`skills/opencode-ticketing/SKILL.md`](https://github.com/prompt-cult/opencode-ticketing/blob/main/skills/opencode-ticketing/SKILL.md) —
  ticketing 工作流：ticket → 编号 todo → 按 ticket 编号委派 →
  todos 自动关闭 ticket。
- `v2.2.1/` — **opencode 2.2** 的当前发布版（自包含：`ticket.ts`
  内联 TicketStore,无 `lib/` 导入；`todo-protocol.ts` 将
  `todowrite` 描述重写为 flush/deque 协议）。

集中安装（`~/.config/opencode/plugin/`）,opencode 在每个会话中自动发现
插件。不要同时在仓库的 `.opencode/plugin/` 中保留副本：opencode 会同时
加载两者,supervisor 会禁用同 id 的重复项。

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

`opencode.jsonc` 中不需要 `plugin` 条目（而文件条目只会记录一条
"configured plugin path must be a directory" 警告）。

重启 opencode —— 插件和 skill 仅在启动时加载一次。

验证：agent 可调用 `ticket` 工具,并且 `todowrite` 描述的第一句是
"Maintain the session todo list."。

## Tests

```sh
bun test v2.2.1/
```

契约套件：不可变正文、追加式评论、状态是唯一变更（仅限所有者）、
委派横幅、以及已删除动词的守卫。测试跑在 scratch `TICKET_DB_HOME`
上,绝不碰真实数据库。
