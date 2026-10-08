# Todo

Todo 是一个进程内、按 Session 查询、由单个活动 UserTurn 拥有的整表替换进度视图。
它不是持久 Tasks DAG，不调度工作，也不会跨 UserTurn 继承列表。

## 状态与边界

`TodoState` 绑定精确的 `sessionId`、`runId` 和 `userTurnId`，并携带单调 `revision`。
`TodoService` 从 Runtime 认证过的 `openUserTurn` 边界重置列表；当前 UserTurn 结束后最后一份
列表仍可查看，但下一个 UserTurn 打开时会重置为空。

模型入口 `todo_write` 总是替换完整列表，不提供增量 patch。它从不可变
`WishToolExecutionContext.userTurn` 取得 Run/UserTurn 身份，并与 Permissions subject
复核；旧 Step 或错误身份不能覆盖新 UserTurn 的列表。列表最多 50 项，每项使用稳定非空 ID、
不超过 500 字符的正文，以及 `pending`、`in_progress` 或 `completed` 状态；同时最多一个
`in_progress`。

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
