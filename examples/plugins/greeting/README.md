# 可管理插件样例

将下面两个入口加入 Wish 的 managed 部署文件（路径相对该文件）：

```yaml
- id: greeting-provider
  name: ./examples/plugins/greeting/provider.mjs
  management:
    manifest: ./examples/plugins/greeting/provider.wish-plugin.json
  config:
    prefix: Hello
- id: greeting-tool
  name: ./examples/plugins/greeting/tool.mjs
  management:
    manifest: ./examples/plugins/greeting/tool.wish-plugin.json
```

外部目录需要能解析本地 Wish 包及其依赖。本仓库示例使用 package exports，
不导入 `dist` 内部实现。部署条目 ID 在整个 managed 配置（含 Include）中必须唯一。
Catalog 外部条目必须通过 `management.manifest` 指向静态 v1 manifest；只写
`management.class: managed` 不再能把未知代码提升为 managed，条目会显示为黄色
`noncompliant`。Host 在导入候选代码前校验 API 版本、实际入口、Config Schema、权限上限、
Sandbox 模式、替换模式和状态兼容声明。manifest 仍不是生命周期安全性的自我证明：活动
Fiber 必须通过 `PluginWorkOwner` 或统一 Owner Registry 注册单次 canonical 声明；分别调用旧
lifecycle/code-reload API 拼接出的 compatibility 记录不能通过 managed 门禁。

Provider 用 `PluginWorkOwner.run()` 包住完整异步工作；同步调用用 `assertOpen()`；
流式工作用 `stream()`；清理资源放入 `close`，它在已接受的工作结束后执行。
取消本模块持有的等待可以用 `beforeDrain`，不能以此强杀其他模块的工作。
数据库状态、进程状态和恢复由业务模块自己维护，不能存进管理器。

Tool 用 `ManagedToolOwner` 注册，依赖写在 `inject`。移除 Provider 时 Tool 自动退出，
恢复 Provider 后重新注册。两者都声明支持代码更新；声明成立的前提是新版本能恢复
自身状态，且旧版本能完整收尾。后台派发要通过 `ctx.root.get("codeReload")?.startWhenReady`
在管理回执保存后启动。这个纯函数样例没有后台派发或需迁移的持久状态。

需要文件、Shell 或网络能力的 Tool 必须同时在 manifest 的 `permissions.capabilities` 声明
上限，并在 `resolveCapabilities` 中按实际输入请求；manifest 不授予权限，最终仍经过
Permissions/Sandbox。v1 插件实现运行在 `trusted-in-process`，不可信代码必须使用未来的
Worker/子进程隔离，不能靠 manifest 变成可信代码。本例仅拼接文本，所以没有权限要求。
输入 schema、parse 和 execute 必须一致。自定义 Group
或独立写配置的载体不属于此模板，不可仅加 `group: true` 绕过管理协议。

Host 会按实际活动 Fiber 聚合两项协议覆盖：安全停用 `stop` 与代码替换 `codeUpdate`。
两项分别只允许 `online`、明确的 `restart`、`missing` 或尚未运行的 `inactive`；缺少安全停用
协议的活动插件会显示黄色“停用协议缺失”，并在写入管理意图和调用清理前被拒绝。
`inactive` 只表示当前无法从运行态检查，不是合规证明。

验证：`node scripts/accept-external-plugin.mjs`（先构建）。覆盖静态 manifest fail-closed、
Config Schema、class-only 不升级、Provider 消失/恢复、旧引用失效、配置替换、工具无重复
注册、依赖未满足时等待、退出后无残留效果。
