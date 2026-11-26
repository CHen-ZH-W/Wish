# Tmux

Tmux 为 Wish 的长时间运行进程提供透明的执行通道。Bash 保持同步，不提供后台任务模式。
模型显式使用 `tmux_start`、`tmux_list`、`tmux_capture`、`tmux_send` 和 `tmux_stop`；
tmux 管理持久终端，模型和用户都可以列出、截取画面、连接、发送输入和停止它。

## 角色与职责

```text
Shell Provider -> prepared sandbox launcher -> Local Tmux Provider -> Tmux Service <- Consumers
                                          private TmuxCommandRunner
```

Service 提供与具体 Provider 无关的会话、目标、终端元数据、画面截取、输入和停止操作。
有界的 CLI 操作使用私有的同步 `TmuxCommandRunner`；供重新发现进程的元数据保存在 tmux 用户选项中。
父子 Agent 身份只属于 Subagents 记录，tmux 不保存这些身份。
浏览器中的用户终端 PTY 由独立的 User Terminal 领域管理，不通过本 Service 连接。

面向模型的启动 Consumer 通过 `process.exec`、文件系统、网络、外部副作用和运行控制能力
声明原始命令。授权后，Shell 消费这份确切的一次性 Grant，准备 Linux 原生沙箱启动器。
Tmux 不接收未经检查的 Shell 字符串。
中央 tmux 服务可以保有窗格，但实际任务通过准备好的启动器执行；真实验收还验证受限窗格
无法借助 tmux socket 创建无沙箱限制的窗口。

## 可观察性

每个已启动任务都返回真实 tmux 目标，以及可复制的连接和画面截取命令。
`list()` 从 tmux 重建运行中和已退出窗格的快照，不依赖进程内任务登记表。
调用方可以保留语义化的 Session 事件和最终结果，但不能隐藏终端地址。

Provider 启用 `remain-on-exit`，使已完成的窗格在显式停止前仍可查看。
画面截取有大小限制，tmux 滚动历史不能替代 Wish Session 的持久化历史。

Linux Native 准备的命令在窗格存在期间保留私有临时目录。目录地址保存在可重建的 tmux 元数据中，
启动失败或显式停止保留终端时会删除。Provider 重载不会仅因进程内 Consumer 被移除就删除目录。

WebUI 会话侧栏在 tmux 视图挂载期间，定期截取可见且仍在运行的窗格。
观察到窗格退出后再进行一次最终截取，并与已退出窗格一起保留；只有用户显式确认后才移除 tmux 会话。
离开侧栏或重载 Provider 都不会触发该清理。

`TmuxCommandRunner` 只接受可执行文件和 argv，并等待命令完成。
它用于本地 Provider 注入和测试，不是 Cordis Service，也不返回后台进程句柄。
只有其他真实 Host 能力也需要相同契约时，才应将其提升为共享能力。

每个任务通过可执行文件、argv、cwd 和经过校验的附加环境变量启动；Service 不接受 Shell 字符串。
本地 Provider 启动时将 Wish 的进程发现字段写入 tmux 用户选项。
后续进程代际中的 `list()` 可直接从配置的 tmux 服务重建相同语义身份。

Cordis Provider 管理请求准入和正在执行的 CLI 请求，保留的终端进程由 tmux 持有。
卸载会同步封闭 API 并等待已接纳的命令完成，不会杀死会话。
重新激活后，旧 Provider 引用仍保持关闭；新 Provider 从同一 socket 重建已有目标。
可选的 Host 生命周期报告只暴露命令计数和停止守卫，不暴露 Agent 身份或任务文本。
已接纳的 CLI 命令报告 `drain`：受控停用会阻止新命令、等待当前命令、卸载旧 Fiber，
之后可以在同一 Host 中重新启用新的 Provider。
仍在运行的依赖能力有各自的停止条件；执行通道空闲不能作为停止活跃 Subagent 或 Workflow 的授权。
代码替换使用独立的 Host 协议：已审核的 Consumer 先排空工作，再由此 Provider 封闭准入并排空命令，
最后新 Provider 重新发现同一 socket。任何未审核的依赖者仍会拒绝整个变更批次。
`npm run test:stateful-code-reload:real` 覆盖真实在途画面截取和父子执行连续性；
它不授权以管理操作关闭仍在运行的子 Agent。

`exitCode` 是可选字段，因为 tmux 3.2 能提供窗格退出状态，却没有可移植的退出码格式字段。
包括 Subagents 在内，需要结构化结果的 Consumer 必须使用自身结果协议，不能从屏幕文本推断。

## 边界

- Session 和窗口名称会规范化为可移植的 tmux 标识符。
- 一个配置的 socket 对应一个 tmux 服务及其权限域。
- 权限上限或 Sandbox 不兼容的任务不能共享同一个 tmux 服务。
- 本地 Provider 是否可用以及真实连接流程属于部署验证，独立于类型检查和模拟执行器验收。

## 配置与验证

默认产品依赖图使用 `WISH_TMUX_SOCKET`；未设置时选择
`<WISH_DATA_DIR>/tmux.sock` 或 `~/.wish/tmux.sock`。
`WISH_TMUX_ENABLED=0` 会同时卸载 tmux Provider、模型工具、提示指引和 WebUI Session 观察功能。
Subagents 及其模型工具 Consumer 有独立开关，不负责控制 tmux 是否可用。

```bash
npm run test:tmux
npm run test:tmux:real
npm run test:tmux:tools-real
npm run test:shell:tmux-real
npm run test:state-handoff
npm run test:state-handoff:real
```
