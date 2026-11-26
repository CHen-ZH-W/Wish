# Composition

`src/composition/` 负责 Wish 产品的 Agent 执行装配，将独立于框架的 AgentLoop、Runtime、Agent、
Context、Models、Tools 和能力端口接入 Cordis 服务及其生命周期代际。

- `agent-loop-service.ts`：根据当前注入的能力构建一个 Step 流水线。
- `agent-loop-standalone.ts`：显式的独立使用入口，提供默认 Basic Tool 注册。
  需要隐式默认工具的调用方使用此入口；产品服务要求注入 Registry，不导入具体工具实现。
  因此更新单个工具不会通过未使用的独立回退路径导致 Runtime 重载。
- `runtime-service.ts`：管理进程内 Run 控制器和代际退休。
  只读的 `lifecycleSnapshot()` 汇总实际代际引用，不复制 Run 状态或暴露 Run 身份；
  资源成功释放后才移除引用。可选的 Host 生命周期查询报告活跃/退休中的工作状态，
  查询自身不执行 Run 中止或代际退休。
  `canDispatchBackgroundWork()` 在新 Run 首次模型启动前优先保障前台执行；
  后续流式回复、工具执行和人工输入等待不阻止后台工作准入。
  该标记属于 Runtime 代际，在 Step 替换期间保留。
  独立的受控停止守卫会一起暂停 `open()` 和所有已返回代际的 `startRun()`。
  预检拒绝时只释放这道准入栅栏；批准空闲关闭后，等待代际退休和资源释放。
  活跃 Run 不能通过隐式中止来强行满足管理停用条件，旧引用保持关闭。
- `runtime-service.ts` 还管理活动的 `UserTurnContinuationPolicy` 注册表。
  每个 Core Runtime 代际取得一份组合策略；领域插件拥有各自状态，并通过 Fiber 生命周期注销。
  在 UserTurn 边界，首个要求追加后续输入的策略决策生效。
- `step-execution.ts`：提供每个 Runtime 的 Step 获取/替换屏障。
  它只管理在途租约计数和替换准入，不拥有 Run 状态、队列、插件加载、权限、持久化或重试。
- `agent-service.ts`：管理默认 Wish Agent 定义和门面。
- `agent-scope.ts` 与 `agent-preset.ts`：管理 Agent 局部可见性、父级继承、资源清理和可序列化的子角色契约。
- `tool-context.ts`：固定一个工具执行 Step 的不可变 Wish 产品事实，包括 Runtime 认证的 UserTurn 来源，
  以及仅为可信 GoalRoundDriver 后续输入提供的确切 Goal 轮次身份。
- `coding-tools.ts`：显式装配默认 Coding Tool Consumer，供独立使用。

核心状态机和转换规则保留在 `src/core/`。
本目录不成为 Session、Run、Step、Tool 或 Subagent 状态的权威所有者；
Cordis 在此只负责装配、注入、替换和生命周期清理。

## Agent 独立作用域

Application 注册对所有 Agent 可见。`AgentScope` 增加有序的父子层级：子 Agent 可以按名称替换工具、
Prompt 片段、Context Provider 或 Compaction 策略，而不改变父级或兄弟 Agent。
`Agents.scope` 表示当前进程 Agent 的作用域身份。
作用域注册以提供贡献的 Cordis `ctx` 为第一个参数，例如
`ctx.systemPrompt.registerScoped(ctx, ctx.agents.scope, section)`。
所属 Fiber 或 Agent Scope 任意一方释放时，都会移除该贡献。
AgentLoop 代际在资源释放前持有 Scope 租约。
Scope 释放先通知 Agent 局部后台工作，再等待租约，使正在等待这些工作的 Step 能够完成。
Agent 卸载会同时启动 Scope 释放和 Run 退休，再等待两者完成。
`scope.listen(unsubscribe)` 和 `scope.run(operation)` 管理监听器与可取消工作。
Fiber 卸载前已接纳的作用域工具和 Compaction 调用会先完成，随后才释放 Fiber；
贡献被移除后，保留的回调拒绝新调用。
工具结果渲染器使用当前可见的贡献；如果子 Agent 覆盖了工具却没有提供渲染器，则使用回退渲染。

CLI 子 Agent 是独立进程。`WISH_AGENT_PRESETS_JSON` 定义 Host 选定的角色预设。
Launcher 在创建 Subagent 记录前解析预设，将其工具列表与父级委派上限取交集，
检查已注册工具、运行时功能和能力，并把最终工具列表提交到子记录。
子 Agent 通过 `WISH_AGENT_SCOPE_PRESET` 接收解析后的预设，创建自身 Scope，
安装对应的 Prompt 和 Compaction 设置。`shared` Memory 模式授权只读访问父级当前记忆库；
`none` 还会禁用子 Agent 的 Memory 插件。记录保留所选预设的 digest。
没有配置预设的角色仍然取得经过常规兼容性过滤的工具集合。

部署配置示例：

```json
[
  {"role":"coder","availableTools":["read","grep","write","edit","bash"],"permissionProfile":"workspace-write","prompt":"Implement the assigned change.","compaction":{"keepRecentTokens":3000},"memory":"shared"},
  {"role":"reviewer","availableTools":["read","grep"],"permissionProfile":"read-only","allowedCapabilities":["filesystem.read"],"prompt":"Review the assigned change and report findings.","compaction":{"strategyId":"model-summary-v1","keepRecentTokens":1500},"memory":"none"}
]
```

将上述 JSON 设置为 `WISH_AGENT_PRESETS_JSON`。
指定的工具必须已经在 Application 中注册；工具缺失或子运行时功能不满足时会拒绝启动。
预设的权限配置和能力列表可以收紧父级授权，更宽的权限配置会被拒绝。
所选权限配置和可用审核界面还会将保存的能力上限收紧到子 Agent 实际能够执行的操作。

子 Agent 专用插件可以读取 `ctx.agents.scopePreset?.role`，并使用作用域 API，
向 `ctx.agents.scope` 注册工具、Prompt、Context Provider 或 Compaction 策略。
一个 Compaction Provider 可以在共享服务上注册多个命名策略；
角色预设通过 `compaction.strategyId` 选择其中一个，不影响兄弟 Agent。
这些注册只存在于该子进程中。
如果需要加入父 Application 中不存在的工具，必须在角色的 `localTools` 中声明
`name`、`requires` 和可选的 `requiredCapabilities`，并把名称加入 `availableTools`。
父级在启动前验证该契约；如果子插件没有实际注册工具，子 Agent 会拒绝打开。
工具可见性不授予执行权限，每次调用仍需经过 Permissions、审批和文件系统/Shell 沙箱检查。
子 Agent 装配器还会移除在所选权限配置下需要人工审核、但没有可用审核界面的工具。
例如，只读 CLI 子 Agent 中如果 `bash` 必须经审批才能运行，就不会包含它。
Plan 控制需要 Plan 状态、人工审核和 Session 恢复功能，因此普通执行子 Agent 不能进入无法完成的 Plan 状态。

continuation 注册表是范围明确的产品适配器，不承担第二套调度。
策略不能直接修改 Core 队列；Core 校验决策、创建后续输入并处理人类输入抢占。
同样，工具 Consumer 可以将 `tool-context.userTurn` 用作经过认证的身份，
但仍须请求并验证对应的 Permission Grant。

## 执行实现替换

Runtime 依赖稳定的 `launch`、`sessions`、`models` 和 `runtimeLifecycle` Owner，
不静态依赖可替换的 `agentLoop` 服务。
它为自身 Run 代际固定面向 Application 的 Session 租约和 Models 视图。
`StepPipelineSource` 在每个 Step 前获取当前 AgentLoop 实现及完整执行资源，
Core 在 Step 生命周期结束后释放租约。
AgentLoop 缺失时拒绝新 Run 准入和 Step 获取；Application 的其余接口可用不代表可以执行。
打开新的 Application 代际会等待当前 AgentLoop 激活完成，并支持取消和截止时间。
已有代际不增加静态 AgentLoop 依赖，因此协调后的 Step 替换可以保留 Run 身份，
无需卸载 CLI/WebUI 入口。

可信 Host 调用 `runEngine.execution.replace(update, { signal })` 时，会同步关闭新 Step 准入，
等待该 Runtime 跨代际的全部 Step 完成，再执行范围明确的替换回调。
回调必须等待旧实现清理和新实现激活。成功后，相同 Run 使用新流水线继续执行，
其 ID、记忆、队列、取消状态和完成 Promise 保持不变。
这不是模型工具或自动文件监听入口；工具不能等待其自身 Step 的替换完成。

修改开始前取消或到达截止时间，会重新开放原实现。
一旦开始修改，失败会阻止后续获取和新 Run，直到 Owner 被显式恢复；
不提供自动重试、不安全的重新开放或副作用回滚。
取消信号不会强制中断已经运行的替换回调。
Runtime 自身拆卸仍然退休代际、只中止活跃 Run 一次，并等待原有完成结果。

Tool Registry 的代际检查保持不变。屏障必须覆盖共享正在变更的 Registry 的**全部**执行 Owner。
未经协调的修改仍会使旧 Step 快照失效，包括无关工具的注册变化。
Step 租约不会延后权限或工具撤销，保留的快照不能充当执行许可。

这里保留 Run 身份的替换范围包括默认隔离应用依赖图中的 AgentLoop 和工具贡献。
原生 HMR 适配器对通过可选 Root `codeReload` 接口显式声明的 Owner 使用卸载前屏障。
AgentLoop 和 Read Consumer 声明此契约；Runtime 注册执行边界。
Runtime 自身的代码替换使用下文“Runtime 替换与 Run 清理”中的独立收尾流程，不保留正在运行的 Run。
Root 内包括隔离作用域在内的所有 Runtime 边界都会保守地排空。
未声明支持的 Owner 或依赖者变更会在卸载前被拒绝。
模块通过类型导入使用这一接口，避免注册辅助函数连接各自的实现依赖图。
受控代码 HMR 还会在整个原生批次期间持有管理事务：排空后保存待处理意图，
成功回执持久化后才重新开放 Step 准入。
代码替换或尚未激活模块的导入都不会改变用户的启停偏好。
这个接口不允许把任意 Loader 变更或安全权限撤销包装成代码更新；
状态迁移、调度器接管和 UI 代码替换由各自的 Owner 管理。

验证：`npm run test:step-execution` 覆盖 Core 租约、持久化完成、队列、取消、失败后封闭准入，
以及流式输出、审批和执行期间的真实启动/AgentLoop/工具替换，模型使用本地确定性适配器，
不发起外部 Provider 请求。
`npm run test:code-reload` 还覆盖原生文件编辑、多文件批次、同一 Run 的连续性、自修改验收、
稳定 Owner 拒绝、激活失败和清理截止时间。

## Agent Profile 与实验

版本化 Agent 方案由独立的 [Agent Profiles](../agent-profiles/README.md) 领域拥有，通过 Application execution-profile 端口绑定到 Scope 和 Run。模型、Prompt、工具、权限和 Compaction 是并列成员；[Experiments](../experiments/README.md) 用不可变快照启动隔离的真实 Runtime 做对照评测。

## Runtime 替换与 Run 清理

Runtime 在 canonical Owner 上声明 `prepareBeforeDependents: true`。HMR 已导入候选实现并验证影响范围后，先封住该 Runtime 的新 Run 准入，中止原 Run，等待 Core 终止以及 Application 的 Run 清理；此时 Todo、Workflow、Subagents 等清理适配器和 Provider 仍然可用。随后才按 Consumer 到 Provider 的顺序准备其余 Owner，并进行原生卸载与激活。其他 Owner 的准备顺序保持不变。

`RunGeneration.abortAndDrain()` 不销毁代际；若清理失败，HMR 拒绝替换并释放准入栅栏，旧实现仍可在清理恢复后接受新的 Run。已中止的 Run 不会重放。成功排空后才允许真正退休旧代。此顺序不改变受控停用的忙态检查，也不迁移正在执行的 JavaScript 栈。SessionFeature 缺失或清理失败的检查继续生效。
