# opencode-ticketing

**给 opencode 代理用的 Jira。一个 SQLite 文件,所有会话所有仓库。**

[opencode](https://opencode.ai) 的 skill + 配套插件：ticket 是关注中心。创建 ticket,给 todo 项编号,把计划存入 ticket,然后委派。

集中安装后，opencode 在每个会话中自动发现插件：

```sh
mkdir -p ~/.config/opencode/plugin
cp v2.2.1/ticket.ts v2.2.1/todo-protocol.ts ~/.config/opencode/plugin/
```

- 在线文档：[https://prompt-cult.github.io/opencode-ticketing/](https://prompt-cult.github.io/opencode-ticketing/)
- 完整文档：[docs/src/zh-cn.md](docs/src/zh-cn.md)
- English: [README.md](README.md)
