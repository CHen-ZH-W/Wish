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
- `state.ts`：Run、UserTurn、Step 的 canonical state，以及初始身份、层级和
  不可变数据约束。
- `snapshot.ts`：只读 `RunSnapshot`、`UserTurnSnapshot` 和一次性捕获的
  `StepSnapshot`。
- `lifecycle.ts`：终态决策、取消首因、observer pipeline 和持久化 Port。
- `transition.ts`：带不变量检查的纯状态转换。
- `control.ts`：steer inbox、follow-up queue、abort DTO 和明确回执。

`events/event.ts` 提供 Runtime 所需的统一事件 envelope、有界进程内重放和
独立 observer。具体持久化不属于 Core。

## 双层循环

外层循环串行执行初始 UserTurn 和已接受的 follow-up。follow-up 保留
`runId`，但创建新的 `userTurnId`；失败或取消不会因为队列中还有 follow-up
而继续执行。

内层循环只驱动当前 UserTurn 的 Step。`StepPipeline` 是 Model、Context 和
Tool 链路的接入点，默认实现由 `agent-loop/AgentLoop` 提供。每个 Step 开始时
捕获不可变快照，并提供绑定到当前 Step 执行期的 Model/Tool 输出通道；旧 Step
持有的通道在 `execute` 返回后立即失效。pipeline 只能返回 `continue`、
`completed`、`failed` 或 `aborted`，Runtime 会在边界校验 discriminant 及必要
字段。`continue` 受 `maxSteps` 硬限制。

`StepSnapshotProvider` 只提供一次性环境/执行权快照，不执行具体 Context、Model
或 Tool 逻辑。它接收 Run 级 `AbortSignal`，因此 snapshot capture 也处于同一取消
链中。具体的单 Step 执行主干属于 Agent Loop。

完成的 UserTurn 结果可以进入显式 `UserTurnResultPipeline`，用于组合需要
发生在终态提交前的处理阶段；Runtime 不提供通用 hook 注册机制。

## 控制语义

- steer 按接收顺序进入当前 UserTurn 的 next-step inbox，每条最多投递一次。
- Step 执行期间到达的 steer 会在仍有预算时触发下一 Step。
- 最后一个可用 Step 接受了 steer 却无法再创建下一 Step 时，UserTurn 以
  `max_steps_exceeded` 失败，不会把已接受的 steer 静默丢弃。
- follow-up 只进入下一 UserTurn，队列同时限制条目数和 UTF-8 字节数。
- follow-up payload 在入队时建立不可变快照，调用方后续修改不会改变未来
  UserTurn 的输入。
- `reserveCapacity` 只绕过 follow-up 条目数限制，不绕过字节限制。
- abort 是 Run 级、幂等且保留第一次接受的 reason/source/time。
- UserTurn 终态后到达的 steer 和 Run 终态后的全部控制都会得到拒绝回执。

## 生命周期与事件

`RuntimeLifecycleService` 是持久化 Port。Runtime 在执行工作前调用 open，
在提交状态转换前调用 finish。具体文件、数据库或远端实现位于 Core 外。

`RuntimeTransitionObserver` 按注册顺序执行并 fail-open；observer 的失败或阻塞
不能改变 Runtime 决策，也不能延迟 Run completion。`observe()` 使用独立的异步
事件流，停止观察不会取消 Run。终止 Run 必须提交显式 abort control。

`transition.ts` 是可独立调用的纯状态机，因此它自身拒绝越级路径：失败或取消的
Step 后不能再启动 Step，UserTurn 只有在至少一个 Step 完成后才能完成，活动
UserTurn 未收束前不能直接终结 Run，Run 也不能带着 pending work 完成。

Runtime 在入口复制 definition、metadata 和 plain DTO；状态、transition、快照
及 completion 都不依赖调用方继续保持原对象不变。初始化 transition 失败会回收
已占用的 Run ID 和 scope，不留下无法完成的活动 Run。

## 当前阶段边界

进程内 Runtime 主干已经完成：双层调度、canonical state、控制队列、不可变快照、
取消、生命周期 Port、统一事件和终态收束均由 Runtime 所有。Runtime 不依赖默认
实现，也不理解具体 Context、Model 或 Tool；组合根可以使用 `AgentLoop` 完成默认
连接，也可以提供遵守相同 Step 契约的其他显式 `StepPipeline`。持久化和进程重启
恢复需要由 Core 外的 `RuntimeLifecycleService` 实现承担。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:runtime
npm test
```

Runtime 验收覆盖双层循环、Step 序号、steer/follow-up/abort、预算、completion
hold、scope、生命周期、事件重放、不可变边界、端口协议、capture 取消、输出端口
失效、observer 隔离、初始化回收和纯状态机不变量。
