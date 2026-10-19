# Todo

Todo 是一个进程内、按 Session 查询、由单个活动 UserTurn 拥有的进度视图。模型通过
`todo_write` 替换清单，明确关联的子 Agent 项由 Host 根据执行结果推进。
它不是持久 Tasks DAG，不调度工作，也不会跨 UserTurn 继承列表。

## 状态与边界

`TodoState` 绑定精确的 `sessionId`、`runId` 和 `userTurnId`，并携带单调 `revision`。
`TodoService` 从 Runtime 认证过的 `openUserTurn` 边界重置列表；当前 Run 完成、停止或删除时
清理列表，下一 UserTurn 打开时也会重置为空。

模型入口 `todo_write` 总是替换完整列表，不提供增量 patch。它从不可变
`WishToolExecutionContext.userTurn` 取得 Run/UserTurn 身份，并与 Permissions subject
复核；旧 Step 或错误身份不能覆盖新 UserTurn 的列表。列表最多 50 项，每项使用稳定非空 ID、
不超过 500 字符的正文，以及 `pending`、`in_progress`、`completed`、`failed` 或
`stopped` 状态。并行工作可以让多个项同时处于 `in_progress`；失败和停止不会继续转圈。

`spawn_agent` 可以传 `todoId`，指向当前 UserTurn 已存在的 Todo 项。Host 会在开始分发时
将该项置为进行中，并在子 Agent 返回结果、失败或停止时更新它。若分发先进入
Workflow 队列，则从 Workflow Run 提交时开始跟踪，终态由 Workflow 结果决定。同一个 Todo
项关联多个子 Agent 时，全部成功才标记完成。开始一个后续项时，前面尚未关联执行任务的
进行中项会被标记完成；已有子 Agent 关联的并行项继续按各自结果推进。没有 `todoId` 的
调用不会根据任务文字猜测 Todo 项，仍由模型通过 `todo_write` 管理。

## 产品装配

默认 profile 分别装载：

- `cordis:todo`：状态所有者及 Runtime UserTurn 边界适配；
- `cordis:todo-context`：只把当前 Run/UserTurn 的非空列表放入 Context `dynamic_tail`；
- `cordis:todo-tools`：注册 `todo_write`；
- `cordis:todo-session-feature`：向 CLI/WebUI 提供只读进度视图。

这些入口可分别由 `WISH_TODO_ENABLED`、`WISH_TODO_CONTEXT_ENABLED`、
`WISH_TODO_TOOLS_ENABLED` 和 `WISH_TODO_SESSION_FEATURE_ENABLED` 控制。关闭模型 Tool
不会删除 Host 中仍加载的 Todo 状态；关闭整个能力会按插件生命周期排空并释放进程内状态。

## 验证

```bash
npm run typecheck
npm run test:todo
npm run test:goal-todo-cordis
```

验收覆盖 UserTurn 重置、身份冲突、整表校验、Context 投影、Tool 授权、SessionFeature
以及默认 Cordis 装配。
