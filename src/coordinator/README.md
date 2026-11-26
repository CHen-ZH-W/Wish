# Coordinator

`src/coordinator` 管理以 Run 为范围的协调模式。它独立于 Plan，子 Agent 的执行能力由 Subagents 提供。

## 契约

- `CoordinatorService` 是可替换的 Cordis 服务定义。
- `CoordinatorRuntime` 只管理 `inactive -> active -> inactive` 的模式状态。
- `DomainCoordinatorStateStore` 通过 Storage KV 为每个父 Run 持久化一条受 CAS 保护的记录。
- Storage Provider 负责持久化 Coordinator 状态。独立的模式适配器提供 Context 和 Permissions
  投影，因此替换这两个基础服务中的任何一个，都不会替换 Coordinator 状态。
- `CoordinatorContextProvider` 引导模型委派任务、观察执行、核对结果，并避免子 Agent 写入重叠文件。
- `createCoordinatorPermissionPolicy` 将激活模式下的 Step 限制为读取、搜索、已有的子 Agent
  控制工具和 Coordinator 控制操作。权限收紧立即生效，放宽在下一个 Step 生效。
- 模型工具由 `src/coordinator/consumers/model-tools` 中的 Consumer 提供：
  `enter_coordinator_mode`、`read_coordinator` 和 `exit_coordinator_mode`。

Subagents 继续负责子 Agent 身份、数量限制、持久化记录、tmux 执行、输入输出观察、取消和完成结果转交。
Coordinator 不启动后台 Bash，也不隐藏子进程。退出协调模式不会隐式停止或删除子 Agent。

Provider 在进入模式时检查 Subagents 当前是否可用，其自身生命周期不绑定到该执行通道。
已有的 Coordinator 状态和权限策略会在 Subagents/tmux 代码替换期间保留；子 Agent 的观察能力恢复前，
读取和退出模式仍然可用。

完成结果转交机制只会为当前进程代际创建的子 Agent 保持父 Run 等待，并在完成后提交后续输入。
持久化记录和 tmux 目标在重启后仍然存在，但需要通过 `list_agents` / `collect_agent` 恢复观察；
本模块不提供跨进程重建原有 continuation 的保证。

当前子 Agent 启动器共享工作区。因此 Context 契约禁止具有写能力的子 Agent 并发修改重叠文件；
这里不提供独立 worktree 隔离。

## 配置与验证

- 设置 `WISH_COORDINATOR_ENABLED=0` 可停用 Coordinator。
- 设置 `WISH_COORDINATOR_TOOLS_ENABLED=0` 可保留 Host 状态能力，同时隐藏模型控制工具。
- 停用 Subagents 会阻止进入新的 Coordinator 模式，但已有状态以及
  `read_coordinator`、`exit_coordinator_mode` 仍然可用。
- 运行 `npm run test:coordinator`，验证状态、持久化、Context、工具和强制权限策略。
