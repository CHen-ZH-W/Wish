# Workflow

`src/workflow` 管理持久化的执行 Run、Step、Attempt、预算、失败摘要、恢复决策和两个调度器。
Coordinator 继续负责模式与策略；Subagents 管理子 Agent 身份、进程状态、tmux 目标和保留的输出。
Core Runtime 继续负责通用的对话 Run/Turn/Step 执行。
`workflow-subagent-tools` 由插件管理启停，默认启用。它加载后，普通 `spawn_agent`
通过此调度器派发；停用后，新调用直接使用 Subagents。该适配器依赖基础子 Agent 工具与
Workflow Scheduler，不需要额外环境变量或模式切换。显式批准的任务图仍通过 `workflow_start` 启动。

## 执行与状态

`WorkflowRuntime` 在一次 Storage CAS 中提交完整 Run 快照和只追加的审计事件前缀。
Run 创建和子 Agent 派发使用稳定的幂等键。已经完成的 Attempt 不会被旧 Attempt 的迟到结果覆盖。
Plan 适配器只接纳确切的已批准任务图。

`TaskGraphScheduler` 校验已批准任务图的引用、冻结定义，再提交给 `ChildWorkflowScheduler`，
并将 Attempt 结果投影到 Tasks。子调度器独立通过 Subagents 端口派发就绪的 Step，
绑定 Attempt 与子 Agent ID，观察结构化结果，并通过 Core 的通用 RunContinuation 端口交付结果。
终端输出不会被解析为权威完成结果；子 Agent 输出仍按不可信任务数据处理。

调度并发数默认为 4。共享工作区中具有写能力的任务会排斥其他已调度任务；只读任务可以并行。
这些是调度器准入约束，不是针对用户或独立 Host 调用方的文件系统锁。
Subagents 自身的全局和每个父级限制继续生效。
子 Agent 的工具列表、权限配置和能力上限只能收紧 Host 派生的委派范围。
Permissions 分别捕获直接执行和委派的权限范围：Coordinator 限制自身直接操作，
同时保留 Host 上限内的委派能力。其他策略默认将直接操作限制传递给委派，
除非它们显式提供更窄且受 Host 上限约束的委派投影。只读 Host 不能委派写权限。
派发时重新检查当前 Agent 配置、Workspace 和 Permissions，配置变更可能阻止派发。

Attempt 次数、边调用次数和熔断失败次数没有默认上限，显式提供的兼容预算设置仍受支持。
重试必须显式发起并改变策略；相同错误与策略的重复组合会被拒绝。
重试策略会进入子任务提示词，保持相同标题不会清除尝试计数，也不存在自动 LLM 重试循环。
普通子任务提交和任务图任务都没有默认截止时间；恢复同一 Attempt 时保留显式配置的截止时间。

取消意图与持久化的子 Agent 停止回执（`stoppedAt`）分别记录。
尚未确认停止时会保留父级等待，并阻止移除，直到清理可被验证。
`purge` 确认子 Agent 已关闭后才删除已收尾的 Workflow 账本。
持久化 Run 中包含不受支持的字段时会被拒绝，不会被解释为当前调度器指令。

## 恢复与取消

- 启动时，在对外提供 Storage 服务前，将活跃 Attempt 标记为已中断。
- 已准备的工作可以恢复同一个 Attempt。仍然存在的子 Agent 通过持久化绑定或稳定派发地址重新连接，
  保留 Attempt ID、序号和截止时间。
- 已派发但结果未知的操作、丢失的子 Agent，或没有结构化结果的超时都需要核对，不能盲目重放。
- 人工核对记录操作者和证据，可确认已完成、确认可安全重试，或记录未知/最终阻塞状态。
  模型工具不能调用此决策端口。
- 先持久化取消意图，再停止子 Agent。重启后使用稳定派发地址重试子 Agent 清理。
  卸载调度器后 tmux 进程仍可观察，Host 重启后重新连接。
  父 Run 中止会释放结果等待；随后 Host 收尾流程取消该 Run 派生的 Workflow，
  并在子 Agent 清理完成后删除账本。
- Workflow 连续性不包含旧对话 Run 的重建。`workflow_read` 只读取持久化账本，不依赖调度器。
  依赖调度器的启动和重试路径只向当前 continuation 连接结果交付，进程重启后不重建旧 LLM 轮次。

子调度器关闭时同步封闭子任务准入，并等待已接纳的提交/重试/取消请求、活动调度轮次和待完成结果读取。
任务图调度器独立封闭任务图准入和结果投影，再等待图查询完成。
关闭后才完成的图查询不能新冻结或提交工作。已经开始的冻结可以持久化完成，
但不能迟到提交任务图；已批准的冻结图可以之后显式重新启动。
已经在提交 Workflow 的请求可以为下一代调度器留下已准备工作，但不能由已关闭的实例继续派发。
定时器和订阅会释放，迟到结果不能通过旧调度器追加后续输入。
领域 Runtime 同样关闭读取入口，并在释放 Storage 前等待读取和写入完成。

重建 Workflow Storage Provider 会将活跃 Attempt 标记为已中断；替换后的调度器重新连接已保存的子 Agent，
保留 Attempt ID、序号、派发键和截止时间。
无法重新激活子 Agent 观察时，调度保持不可用，不会重新启动子 Agent。
`WorkflowContinuations` 在独立隔离的 `workflow-continuations` Entry 中管理进程内父级等待和结果接收者。
替换调度器不会释放这些等待：后继实例将已核对的持久化结果交给同一父级，无需再次 `watch()`。
结果进入父 UserTurn 的下一个 Step；UserTurn 在 Step 边界等待全部被观察的 Workflow 收尾。
结果先入队，再释放等待；交付被拒绝时保留等待。
显式取消父级或关闭 continuation Owner 才会释放等待。
没有注入 continuation Owner 的独立调度器保留自身的关闭和释放行为。

Storage/调度器 Provider 及已审核 Consumer 通过可选 Host 接口声明支持代码重载。
Host 先等待 Step 完成，再按 Consumer 到 Provider 的顺序排空工作。
激活时核对保存的 Attempt，但在持久化重载回执前不开始新派发；替换失败不会释放父级等待或恢复派发。
受控停用则会排空已接纳的调度工作，保留持久化 Run、Attempt、外部子 Agent 和父级等待，
交给后续调度器代际继续处理。
continuation Owner 本身是稳定组件，不能进行代码重载；进程重启后不重建父 Run。
自定义部署配置必须包含 `cordis:workflow-continuations`，并隔离 `workflowContinuations`；
默认配置已提供这两项，且不改变已有 Entry ID。

## 接口与配置

`ChildWorkflowScheduler.lifecycleSnapshot(signal)` 读取持久化的 Workflow/Attempt 事实，
以及当前请求、调度轮次和父级等待计数，不推动调度器执行，也不查询子进程。
`TaskGraphScheduler.lifecycleSnapshot()` 还统计尚未创建 Workflow、正在等待 Plan 或 Tasks 的启动操作。
独立的子任务和任务图 Provider 分别向 Host 生命周期检查贡献只读计数，并绑定自身确切的 Fiber。
未收尾工作报告 `drain`，不会隐式取消；取消查询不会取消 Workflow。
这些观察不暴露任务正文、所有者身份或原始失败消息，也不构成执行锁或完整停止协议。

每个 Provider 的停止守卫只暂停自己的准入路径。
停用任务图适配器会等待任务图启动和投影完成，然后分离 Tasks 投影，不停止子任务派发。
停用子调度 Provider 也会通过声明的服务依赖影响任务图 Consumer；
依赖顺序保证在子任务准入关闭前先排空任务图启动。
父级等待和持久化记录继续由各自独立 Owner 持有。
后继实例核对已有 Attempt，不重复派发。提交之前，准入栅栏可以撤销。
这些栅栏是调度器局部接口，不是另一份 Workflow 状态来源。

模型 Consumer 独立管理：`workflow_read` 只依赖持久化 Workflow 状态；
`workflow_retry` 和 `workflow_cancel` 还依赖子调度器；
`workflow_start` 随 Plan/Tasks 任务图适配器单独注册。
稳定的 Subagent 工具 Consumer 可以使用此调度策略创建只有一个 Step 的子 Workflow；
Workflow 适配器不会注册第二套工具。
移除适配器会把 `spawn_agent` 切回直接使用 Subagents，无需替换六个工具；
list/capture/send/stop/collect 始终由 Subagents 提供。
排队会返回持久化 Workflow ID，不能仅因任务正在排队就重复提交子 Agent。
CLI `/review` 展示执行账本和绑定确切 Attempt 的核对操作。
Workflow Run 在执行期间保持持久化，可以在没有 WebUI 视图的情况下后台运行。
没有模型工具时，直接 Host API 仍可用。

活跃、可恢复或结果未确定的 Attempt 会阻止 Session 归档。
所属 Run 完成、失败或停止时，会取消其未完成 Workflow，并在子 Agent 清理后移除对应账本。
删除 Session 前会先取消并移除其剩余 Workflow。
如果一个 `blocked` Run 已经静止且其 Attempt 都已失败，它不会阻止归档。
重试仍须显式发起，调度器不会自行重启被阻塞的 Run。
Session 清理 Entry 依赖持久化 Workflow 状态，需要取消时才解析子调度器。
调度器不可用时，空清理和终态账本删除仍可完成；活跃 Workflow 会继续保留并阻止清理，
直到能够停止并验证其子 Agent。

`WISH_WORKFLOW_ENABLED=0` 停用领域能力；`WISH_WORKFLOW_TOOLS_ENABLED=0` 只隐藏 Workflow 模型控制工具。
已有 Subagent 工具仍由 `WISH_SUBAGENT_TOOLS_ENABLED` 控制。
`WISH_WORKFLOW_MAX_CONCURRENT` 配置 1–256 个调度并发槽位。
子调度器依赖 Workflow 和 Subagents；只有任务图适配器和 `workflow_start` 需要 Plan 与 Tasks。
停用任意一个仍会保留单 Step 的 `spawn_agent` 和其余 Workflow 控制操作。
子 CLI 禁用 Tasks/Workflow 和递归 Subagents，并使用隔离的数据与 Storage 目录。

Storage 数据域 `workflow/runs` 使用单个原子的全局 KV 快照。
终态子记录在子 Agent 清理后，随所属 Run 一起删除。
这是进程内写入基础设施，不是分布式队列；后端负载大小限制继续生效，也不提供多进程主节点选举。
独立 CLI/WebUI 实例必须使用不同的可写数据目录。

验证命令：`npm run test:workflow`、`npm run test:plan`、`npm run test:tasks`、
`npm run test:module-boundaries` 和 `npm run test:state-handoff`。
`npm run test:state-handoff:real` 使用默认 Loader 依赖图、真实 tmux 和 Wish CLI 子 Agent，
配合回环模型测试夹具，验证同一进程内模块卸载/重新激活，以及观察恢复失败时不会重复派发。
该验证使用专用临时数据和 socket 路径，不测试强制 Host 崩溃、外部 Provider、活跃父 Run 的 HMR 或浏览器 UI。
`npm run test:stateful-code-reload:real` 覆盖保留同一真实父 Run 和 tmux 子 Agent 的原生受控代码重载，
包括单个/批量变更、在途命令、稳定的 Coordinator 模式、受控依赖级联停用/重新启用、
激活失败和持久化回执失败。它验证只派发一次、只交付一次结果，并保留子进程 PID、Attempt ID 和截止时间。
全部模型调用都使用确定性的回环测试夹具，不代表外部 Provider 或浏览器验收。
