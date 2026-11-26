# Subagent 模型工具 Consumer

本模块把 `SubagentsService` 的语义能力暴露为六个职责明确的模型工具：
`spawn_agent`、`list_agents`、`capture_agent`、`send_agent`、`stop_agent` 和 `collect_agent`。

一个稳定的 Consumer 管理全部六个工具注册。`spawn_agent` 通过 `subagentToolDispatch` 派发：
Workflow 适配器 `workflow-subagent-tools` 默认启用，由插件管理控制，不需要额外环境变量。
适配器加载时接入持久化调度；停用后，新调用直接使用 `Subagents.spawn`，
无需替换工具 Consumer，也不改变模型可见的工具集合。

此 Consumer 由 Subagents 领域维护，不属于 `src/tools`。
`WISH_SUBAGENT_TOOLS_ENABLED=0` 可独立卸载它。
停用或删除 Consumer 会保留 Subagents 领域能力。

模型提供任务、角色、可选的已配置模型、权限配置和工具允许列表。
可执行文件、tmux socket、数据根目录、执行 Provider、父级身份和工作区根目录由 Host 启动器
与不可变的 Step 上下文确定，不能由模型选择。
未显式指定模型时，子 Agent 继承当前 Step 的有效模型及不含凭据的 Models 配置。

无论直接派发还是通过 Workflow 调度，在启动子 Agent 前，Host 都会根据父级委派上限、
当前已注册工具、已委派能力和所选子运行时的功能组装工具集合。
工具 Consumer 可以在注册时声明所需运行时功能和能力，资源 Provider 则声明其子资源可提供的功能。
未显式选择工具时，会排除所需功能不可用的工具贡献；显式请求这类工具时，
会在启动前失败并报告缺少的功能名称。
当前 CLI 子 Agent 是一次性执行，不提供 Plan 审核或 Session 恢复功能，
因此其组装后的工具集合不包含 Plan 控制工具。
解析后的集合会作为子 Agent 的显式允许列表传入，并继续接受正常的执行授权检查。

读取操作需要 `runtime.read`；创建、发送输入和停止需要 `runtime.control`，
经过正常的 Permissions 决策，并在派发前立即检查有效的一次性 Grant。
子 Agent 的生命周期由 `SubagentsService` 管理，不是 Bash 的后台执行模式；
实际进程仍可通过返回的终端目标独立观察。

每次操作都会把当前 Agent、Session、Run 和 Workspace 身份传给 `SubagentsService`。
领域 Runtime 负责归属校验，对不属于调用方的 ID 返回未找到，避免泄露其存在。

`spawn_agent` 在启动前通过 Core 的通用 `RunContinuation` 端口取得 UserTurn 完成等待。
领域 Runtime 监测执行 Provider 并发布结构化生命周期事件，`subagents/adapters` 中的结果桥接器
订阅这些事件。在完成、失败、保留的进程已退出但没有结果，或超时时，
它提交一次内部的下一 Step continuation，并释放等待。
需要等待的子 Agent 尚未结束时，父级不会发起下一次模型请求，也不会完成当前 UserTurn。
多个子 Agent 可以并行运行，已接纳的结果进入同一个 UserTurn。
Session 来源信息和 WebUI 会区分这些 Host 提交的数据与可见用户输入。
结果转交器关闭时释放等待，但不会杀死可独立观察的终端执行。
它先订阅事件再重新读取子 Agent 记录，确保派发后、订阅前已经结束的子 Agent 也能被观察到。

## 验证

```bash
npm run test:subagent-tools
npm run test:runtime
npm run test:subagent:runtime-real
```
