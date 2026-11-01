# opencode-ticketing

**Jira for your [opencode](https://opencode.ai) agents. One SQLite file.
Every session, every repo.**

A skill + companion plugin pair for [opencode](https://opencode.ai): the
ticket is the centre of attention. Create a ticket, number the todo item with
it, store the plan in the ticket, then delegate.

Install centrally and opencode auto-discovers the plugins in every session:

```sh
mkdir -p ~/.config/opencode/plugin
cp v2.2.1/ticket.ts v2.2.1/todo-protocol.ts ~/.config/opencode/plugin/
```

- Live site: [https://prompt-cult.github.io/opencode-ticketing/](https://prompt-cult.github.io/opencode-ticketing/)
- Full docs: [docs/src/index.md](docs/src/index.md)
- 中文文档: [README.zh-CN.md](README.zh-CN.md)
