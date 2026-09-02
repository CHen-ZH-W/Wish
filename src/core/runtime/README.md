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
- `state.ts`：Run、UserTurn、Step 的 canonical state。
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
捕获不可变快照，并提供绑定到当前 Step 的 Model/Tool 输出通道；pipeline 只能返回
`continue`、`completed`、`failed` 或 `aborted`。`continue` 受 `maxSteps`
硬限制。

完成的 UserTurn 结果可以进入显式 `UserTurnResultPipeline`，用于组合需要
发生在终态提交前的处理阶段；Runtime 不提供通用 hook 注册机制。

## 控制语义

- steer 按接收顺序进入当前 UserTurn 的 next-step inbox，每条最多投递一次。
- Step 执行期间到达的 steer 会在仍有预算时触发下一 Step。
- follow-up 只进入下一 UserTurn，队列同时限制条目数和 UTF-8 字节数。
- `reserveCapacity` 只绕过 follow-up 条目数限制，不绕过字节限制。
- abort 是 Run 级、幂等且保留第一次接受的 reason/source/time。
- UserTurn 终态后到达的 steer 和 Run 终态后的全部控制都会得到拒绝回执。

## 生命周期与事件

`RuntimeLifecycleService` 是持久化 Port。Runtime 在执行工作前调用 open，
在提交状态转换前调用 finish。具体文件、数据库或远端实现位于 Core 外。

`RuntimeTransitionObserver` 按注册顺序执行并 fail-open；observer 失败不能
改变 Runtime 决策。`observe()` 使用独立的异步事件流，停止观察不会取消
Run。终止 Run 必须提交显式 abort control。

## 当前阶段边界

Runtime 双层调度及其状态、控制、快照、生命周期与事件机制已经实现。
Runtime 不依赖默认实现；组合根可以使用 `AgentLoop` 连接 Model、Context 和
Tools，也可以提供遵守同一终态与输出契约的其他显式 `StepPipeline`。
