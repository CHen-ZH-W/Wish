# Goal

Goal 拥有一个 Session-scoped 的持久长目标。持久阶段为 `active`、`paused`、`blocked` 和
`complete`；对已有 Goal 的模型或人工修改都必须携带精确 `(id, revision)` CAS 引用。
同一 Session 不能同时存在两个未完成 Goal。

## 持久状态与激活

目标正文、阶段、阻塞原因、已开始轮次、轮次上限及版本写入 Storage KV Domain。
默认轮次上限为 8，可在创建时覆盖。`activation` 不持久化：它只表示当前进程是否允许该目标
自动续轮，Provider 重启后始终为 `disarmed`。因此恢复出的 `active` Goal 不会在没有明确
重新激活的情况下自行继续。

`create` 与 `resume` 会 arm Goal；`pause`、`complete`、`block`、`clear` 以及 Run 收尾会按
各自契约 disarm。`admitRound()` 只负责以 CAS 记录一个连续轮次，不负责创建 UserTurn。

## GoalRoundDriver

`GoalRoundDriver` 是独立的 Runtime continuation policy。当前 UserTurn 正常完成、Goal 仍为
`active + armed`、没有待处理 Plan review、没有已排队 follow-up 且不存在其他 completion
hold 时，它返回一个带可信 provenance 的、可抢占的 goal-round follow-up，并用 completion
hold 保持同一 Run。

轮次在对应 UserTurn 真正打开时才由 `admitRound()` 提交。达到 `maxGoalRounds` 会把 Goal
转为 `blocked`；等待其他异步工作时不会并行制造续轮。CLI/WebUI 提交的可信人工 follow-up
可以抢占尚未开始的自动 goal-round follow-up。GoalRoundDriver 卸载或 Run 结束时会释放 hold
并 disarm；取消正在执行的 goal round 会暂停 Goal。

## 模型与人工入口

- `get_goal`：读取当前 Session 的 Goal 和精确 CAS 引用；
- `create_goal`：仅允许直接、顶层的人类 UserTurn 创建并激活 Goal；
- `update_goal`：支持 `edit`、`pause`、`resume`、`complete` 和 `blocked`；编辑和暂停/恢复要求
  直接人类权限，自动 goal round 只能凭精确的 Goal-round provenance 完成或报告阻塞；
- Context Consumer 在 `dynamic_tail` 投影同 Session Goal，并明确区分持久 phase 与进程内
  activation；
- SessionFeature 提供带 `(goalId, revision)` 凭证的暂停、恢复、完成与清除操作。删除 Session
  前必须先完成或清除当前 Goal。

自动 round 报告 `blocked` 默认至少需要 3 个已接纳轮次，避免把暂时困难误报为持久阻塞。

## 产品配置

默认 profile 使用 Storage Backend `file`，并装载 Goal Provider、Context、Tools、
GoalRoundDriver 和 SessionFeature。可使用：

- `WISH_GOAL_ENABLED`：关闭整个 Goal 能力；
- `WISH_GOAL_MAX_ROUNDS`：设置默认轮次上限；
- `WISH_GOAL_CONTEXT_ENABLED`、`WISH_GOAL_TOOLS_ENABLED`、
  `WISH_GOAL_SESSION_FEATURE_ENABLED`：分别控制各 Consumer；
- `WISH_GOAL_AUTO_CONTINUE_ENABLED`：只关闭 GoalRoundDriver；
- `WISH_GOAL_BLOCKED_AFTER_ROUNDS`：设置自动 round 报告阻塞所需的最少轮次。

关闭自动续轮不会删除持久 Goal；关闭 Tool 也不会赋予其他入口修改权限。

## 验证

```bash
npm run typecheck
npm run test:goal
npm run test:goal-round-driver
npm run test:goal-todo-cordis
```

验收覆盖持久状态/CAS、激活边界、轮次接纳、权限来源、人工输入抢占、completion hold、
SessionFeature 及默认 Cordis 装配。
