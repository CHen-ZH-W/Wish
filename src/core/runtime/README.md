# Runtime

Runtime 是 Wish Core 中 `Run → UserTurn → Step` 的唯一状态和调度所有者。

```text
Run 外层循环
└── UserTurn 1
    ├── Step 1
    └── Step 2
└── UserTurn 2（follow-up）
    └── Step 1
```

## 文件职责

- `runtime.ts`：活动 Run 注册、双层驱动循环、scope 唯一性、控制路由与释放。
- `state.ts`：Run、UserTurn、Step 的 canonical state，Runtime 认证的 UserTurn
  provenance，以及初始身份、层级和不可变数据约束。
- `snapshot.ts`：只读 `RunSnapshot`、`UserTurnSnapshot` 和一次性捕获的
  `StepSnapshot`。
- `lifecycle.ts`：终态决策、取消首因、observer pipeline 和持久化 Port。
- `transition.ts`：带不变量检查的纯状态转换。
- `control.ts`：steer inbox、follow-up queue、可抢占自动 follow-up、abort DTO 和明确回执。
- `generation.ts`：跨配置代的 Run 准入、活动 Run 归属、单次取消与诚实排空。
- `../../composition/runtime-service.ts`：Cordis `runEngine` Service，拥有生产环境的 Runtime 构造和生命周期。
- `durability/`：Runtime-owned lifecycle Definition、Journal authority、恢复分类和
  Cordis Provider；它同时实现 Runtime 与 Tool 的权威 lifecycle Port。

`events/event.ts` 提供 Runtime 所需的统一事件 envelope、有界进程内重放和
独立 observer。具体持久化不属于 Core。

`RunGeneration.suspendAdmission()` 同步拒绝新的 `startRun()`，但不退休该代、不 abort
已有 Run，也不改变 canonical Run 状态。返回的幂等撤销函数只释放自己的限制，不能
解除其他所有者的限制或重新开启已退休代。它供 Host 在受控停用前封住旧引用并复查资源，
不是另一套任务调度器。

## 双层循环

外层循环串行执行初始 UserTurn 和已接受的 follow-up。follow-up 保留
`runId`，但创建新的 `userTurnId`；失败或取消不会因为队列中还有 follow-up
而继续执行。

每个 UserTurn 都携带 Runtime 创建并冻结的 `provenance`。初始输入记录
`origin=run_input` 和可信 adapter source；follow-up 记录 `origin=follow_up`、source、
control ID 与接收时间。后续模块只能消费这份身份，不能根据 payload、消息 role 或模型文本
反推人类来源。可信 CLI/WebUI 人工 follow-up 会排到队首，并取消尚未开始且明确标记为
`preemptible` 的策略 follow-up；普通模型或插件来源不能取得该抢占权限。

内层循环只驱动当前 UserTurn 的 Step。`StepPipeline` 是 Model、Context 和
Tool 链路的接入点，默认实现由 `agent-loop/AgentLoop` 提供，生产构造由
`src/composition/runtime-service.ts` 接管。每个 Step 开始时
捕获不可变快照，并提供绑定到当前 Step 执行期的 Model/Tool 输出通道；旧 Step
持有的通道在 `execute` 返回后立即失效。pipeline 只能返回 `continue`、
`completed`、`failed` 或 `aborted`，Runtime 会在边界校验 discriminant 及必要
字段。`continue` 受 `maxSteps` 硬限制。

组合层也可提供 `StepPipelineSource`，在每个 Step 前取得包含完整 pipeline 的 lease。
获取完成后才记录 `step.started`、投递 steering 和捕获快照，等待切换时不会生成虚假 Step。
lease 覆盖环境捕获、模型、审批、Tools、transcript 与 `finishStep` 持久化，之后在 finally
中恰好释放一次。等待获取仍接受 Run 取消；实现选择、暂停和资源绑定属于 composition，
Core 不认识插件名称、Cordis、HMR 或 Registry。

`StepSnapshotProvider` 只提供一次性环境/执行权快照，不执行具体 Context、Model
或 Tool 逻辑。它接收 Run 级 `AbortSignal`，因此 snapshot capture 也处于同一取消
链中。具体的单 Step 执行主干属于 Agent Loop。

完成的 UserTurn 结果可以进入显式 `UserTurnResultPipeline`，用于组合需要
发生在终态提交前的处理阶段；Runtime 不提供通用 hook 注册机制。

组合层还可提供一个窄 `UserTurnContinuationPolicy`。Runtime 在 UserTurn 打开时通知策略，
并且只在 UserTurn 成功、没有取消、没有已排队 follow-up 时请求一次 `afterUserTurn`
决策。策略只能返回 `none` 或一条候选 follow-up，不能直接修改状态或队列；Runtime 负责
验证文本、source、容量和抢占属性，再创建正常的下一 UserTurn。Run 终态通过 `finishRun`
通知策略清理进程内绑定。该 seam 当前供 GoalRoundDriver 使用，不是通用 Hook 或持久任务恢复。

## 控制语义

- steer 按接收顺序进入当前 UserTurn 的 next-step inbox，每条最多投递一次。
- Step 执行期间到达的 steer 会在仍有预算时触发下一 Step。
- 最后一个可用 Step 接受了 steer 却无法再创建下一 Step 时，UserTurn 以
  `max_steps_exceeded` 失败，不会把已接受的 steer 静默丢弃。
- follow-up 只进入下一 UserTurn，队列同时限制条目数和 UTF-8 字节数。
- follow-up payload 在入队时建立不可变快照，调用方后续修改不会改变未来
  UserTurn 的输入。
- `preemptible` 明确标记可以被可信人工输入替换的待执行 follow-up；当前默认产品只让
  Runtime policy 生成这种控制。可信 CLI/WebUI 人工 follow-up 会取消这些待执行项，
  回执原因记录为 `human_input_preempted`。其他 follow-up 保持原有顺序且不会被隐式删除。
- `deferRunCompletion()` 返回显式 completion hold。当前 UserTurn 完成且 follow-up 队列
  暂空时，只要仍有 hold，Run 就保持活动；释放最后一个 hold 后才重新判断终态。
  异步能力可通过通用 `RunContinuation` Port 等待外部结果，再通过正常 follow-up 控制
  创建下一 UserTurn。hold 不修改 Step 或 UserTurn 层级，也不拥有外部任务生命周期。
- `reserveCapacity` 只绕过 follow-up 条目数限制，不绕过字节限制。
- abort 是 Run 级、幂等且保留第一次接受的 reason/source/time。
- UserTurn 终态后到达的 steer 和 Run 终态后的全部控制都会得到拒绝回执。

## 生命周期与事件

`RuntimeLifecycleService` 是持久化 Port。Runtime 在执行工作前调用 open，
在提交状态转换前调用 finish。生产组合中的 `RuntimeLifecycleAuthorityService`
同时实现这个 Port 和 `ToolExecutionLifecycle`，使 Run/UserTurn/Step 与
Tool `prepared → dispatched → terminal` 进入同一条有序 Journal。调用成功返回点
就是所选 Journal Provider 声明的 durability point；权威写入失败会阻止或失败执行。

Journal 事件只保存身份、恢复策略和 payload/result/snapshot 的 SHA-256 指纹，不保存
原始 prompt、Tool input 或 Tool output。`recoverInterrupted()` 是底层恢复操作：它扫描
未终结 Run，把中断 Tool 分类为 `retry-safe`、`resumable`、
`needs-reconciliation` 或 `terminal-failed`，再以一个原子 batch 从 Tool 向父层封口。
它只返回不可变报告，不调用 Tool，也不重建进程内 Run；终态 Tool 永不进入恢复报告。
为避免误伤本进程活动 Run，扫描必须发生在该 authority 接纳任何新 lifecycle 写入前；
一旦已有本进程写入，调用会 fail closed。

产品组合不会把这个时序交给 surface：`runtime-lifecycle-journal` 在 Cordis Fiber 的
`LOADING` 阶段自动执行扫描，完成前通过 availability predicate 隐藏
`runtimeLifecycle`。因此 AgentLoop、Runtime、Agents 和 Application 都保持 `PENDING`；
扫描或解码失败会令 Provider `FAILED`，不能绕过恢复继续接纳 Run。扫描完成后发布
`RuntimeLifecycleStartupSnapshot`：`recovery.runs` 是本次启动刚封口的 Run，
`recordedInterruptedRuns` 是从 Journal 重建的跨重启记录，
`pendingReconciliations` 是精确到 Tool call 的待核对目标，
`reconciliationResolutions` 是已持久化的历史结论，`reconciliationRequiredRuns` 则是按 Run
聚合的兼容视图。

`resolveReconciliation()` 只接受 `needs-reconciliation` Tool，并把人工核对结论作为独立的
`tool.reconciliation_resolved` 事件提交。结论只有 `confirmed-completed`、
`confirmed-not-completed` 和 `accepted-unknown`；它们不会伪造原 Tool 的 completed/failed，
也不会启动重试。调用方必须提供 `resolutionId`，相同 ID 与相同决策可安全重放，不同决策
会冲突；同一目标不能用另一个 ID 重复核销。actor 和 reason 会持久化，原始 evidence 只保留
SHA-256。只有 commit 达到 Journal durability point 后，目标才从 pending 清单消失。
当前仍没有自动重试、续跑或进程内 Run 重建。

`RuntimeTransitionObserver` 按注册顺序执行并 fail-open；observer 的失败或阻塞
不能改变 Runtime 决策，也不能延迟 Run completion。`observe()` 使用独立的异步
事件流，停止观察不会取消 Run。终止 Run 必须提交显式 abort control。

`transition.ts` 是可独立调用的纯状态机，因此它自身拒绝越级路径：失败或取消的
Step 后不能再启动 Step，UserTurn 只有在至少一个 Step 完成后才能完成，活动
UserTurn 未收束前不能直接终结 Run，Run 也不能带着 pending work 完成。

Runtime 在入口复制 definition、metadata 和 plain DTO；状态、transition、快照
及 completion 都不依赖调用方继续保持原对象不变。初始化 transition 失败会回收
已占用的 Run ID 和 scope，不留下无法完成的活动 Run。

## 模块边界

双层调度、canonical state、provenance、控制队列、continuation policy 决策应用、
不可变快照、取消、生命周期 Port、统一事件和终态收束均由 Runtime 所有。Runtime 不依赖默认
实现，也不理解具体 Context、Model 或 Tool；组合根可以使用 `AgentLoop` 完成默认
连接，也可以提供遵守相同 Step 契约的其他显式 `StepPipeline`。持久化和进程重启
恢复分类由 `durability/` 中的具体 authority 承担。`runtime.ts` 与 `generation.ts` 等算法文件仍不依赖
Cordis；`src/composition/runtime-service.ts` 只负责生产构造和依赖 generation，不改变状态机或恢复
不变量。

## Cordis 生命周期与配置

Runtime Service 注入 `launch`、`sessions`、`models` 与 `runtimeLifecycle`，保留稳定 Session
lease 和 Application-facing Models view；每 Step 通过动态 AgentLoop 入口获取当前 pipeline。
它构造一代 Core Runtime 和包裹它的 `RunGeneration`。Cordis 保留 `ctx.runtime` 作为插件 runtime accessor，因此
Wish 的能力键使用 `runEngine`，Loader 名称仍为 `cordis:runtime`。

领域插件可用 `runEngine.registerContinuationPolicy()` 注册当前 generation 可见的
UserTurn 边界策略；Fiber 释放时注销只影响未来调用。组合器按注册顺序通知所有策略，
`afterUserTurn` 采用第一条 follow-up 决策。策略状态仍由所属模块管理，Runtime 不持久化它。

`runtime-lifecycle-journal` Provider 注入选中的 `storageBackend`，要求 Journal 支持
原子 batch 与 `fsync` durability，并持有 Backend lease 直到自身关闭。默认使用全局
namespace `runtime/lifecycle`，因此重启后无需枚举 namespace 即可发现中断 Run；当前代价是
Journal 尚未做 compaction/retention。Provider 初始化、更新或 Backend 重建时都会重新通过
启动扫描；Provider 或 Backend 消失时 AgentLoop、Runtime 和 Application 会沿 Cordis
依赖图转为 PENDING。File Journal 已关闭的 namespace handle 不会跨 Provider generation
复用。

Config 拥有 `maxSteps` 与 `generationDrainTimeoutMs`。稳定依赖缺失时保持 PENDING。
单独 AgentLoop 换代不会销毁 Runtime；缺席时拒绝新 Run 和 Step，而非提供无权限降级执行。
受控实现切换必须先通过 composition 的 Step barrier，详见 [执行切换](../../composition/README.md#execution-replacement)。
Runtime 自身更新／关闭或稳定依赖消失仍依次释放 `runEngine → agents → application → surface`。旧代先永久关闭
新 Run 准入，再向每个仍活动的 Run 发送一次显式 abort，并等待它们原有的 completion；
只有旧代进入 `retired` 后，Cordis 才能激活新 consumer。它不会创建、重试或重放 Run/Tool。

排空超过 deadline 会产生 `run_generation_drain_timeout` 并使 process completion 失败，但
retirement 仍保持 pending，直到真实 completion 到达。这样 timeout 是可见故障，不是绕过
安全边界的“强制清理”；未知 Tool side effect 仍必须保持未知，后续持久化恢复只能走显式
reconciliation。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:runtime-durability
npm run test:runtime
npm run test:cordis-runtime
npm run test:run-generation
npm run test:step-execution
npm run test:goal-round-driver
npm test
```

Runtime 验收覆盖双层循环、Step 序号、steer/follow-up/abort、预算、completion
hold、scope、生命周期、事件重放、不可变边界、端口协议、capture 取消、输出端口
失效、UserTurn provenance、人工输入抢占、continuation policy、observer 隔离、初始化回收
和纯状态机不变量。Generation 验收额外覆盖旧代准入关闭、
单次 abort、原 completion 排空、超时 fail-closed、Cordis 更新先后顺序和零重放。
Durability 验收额外覆盖敏感 payload 只留指纹、四种恢复分类、终态排除、原子中断封口、
启动扫描准入、跨重启 reconciliation 投影、resolution 的持久化/幂等/冲突/证据哈希、
损坏时下游保持 PENDING，以及 Provider 替换/卸载。
