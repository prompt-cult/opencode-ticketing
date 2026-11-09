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

## Versioning

This plugin tracks opencode releases: each plugin release is tagged
`v<opencode-version>-<short-commit-sha>` (for example `v2.2.5-abc1234`),
mirroring the opencode version it has been tested against plus this repo's
commit hash, so you can tell at a glance which opencode versions a given
plugin build is known to work with. The short SHA is the commit the tag
points at.

This release was tested against **opencode v2.2.5** (the version running when
the Beam schema fix in issue #22 was verified live).

- Live site: [https://prompt-cult.github.io/opencode-ticketing/](https://prompt-cult.github.io/opencode-ticketing/)
- Full docs: [docs/src/index.md](docs/src/index.md)
- 中文文档: [README.zh-CN.md](README.zh-CN.md)
