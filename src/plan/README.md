# Plan

`src/plan` 管理 Session 范围的规划状态和模式边界。它是一项独立的业务能力，
模型工具和 Workflow 通过各自的适配器使用它。

## 契约

- `PlanService` 是可替换的 Cordis 服务定义。
- `PlanRuntime` 管理 Session 模式、文档版本和持久化的人工审核。
- `DomainPlanStateStore` 通过 Storage KV 为每个 Session 持久化一条受 CAS 保护的记录；
  Plan 数据不编码成伪造的聊天消息。
- Storage Provider 负责持久化 Plan 状态。独立的模式适配器插件提供 Context 和 Permissions
  投影，因此替换这两个基础服务中的任何一个，都不会替换 Plan 状态。
- `PlanContextProvider` 在每个 Step 投影当前模式的指令。
- 只读分析可以直接通过助手回复交付，同时保持 Plan 模式。只有需要人工审核的实施计划
  才需要保存 Plan 并请求审核；完成一次分析回复不要求走审核流程。
- `createPlanPermissionPolicy` 只能收紧 Permissions。进入 Plan 模式会立即阻止旧的写入/bash
  调用；退出模式后，更宽的工具权限在下一个 Step 恢复。
- 模型工具由 `src/plan/consumers/model-tools` 中的 Consumer 提供：
  `enter_plan_mode`、`read_plan`、`update_plan` 和 `exit_plan_mode`。

`exit_plan_mode` 请求审核已保存文档的确切版本，**不会**批准计划或退出模式。
请求会持久化 `reviewId`、文档版本和 digest，然后立即返回。模型应结束回复并等待人工反馈。
之后的普通人类消息会使待审核请求失效，并继续规划。用户也可以选择 `keep-planning` 或 `cancel`，
两者都会保留 Plan 模式；再次提交前必须修改文档。只有匹配当前审核请求的人工 `approve` 决策
才会退出 Plan，更宽的工具权限在下一个 Step 生效。

CLI `/review` 展示文档、产物引用和绑定确切令牌的操作。WebUI 通过通用 Session Feature 适配器
使用同一个仅供 Host 调用的 `decide` 端口。模型工具不能提交人工决策。兼容的 Host `approve`
方法只接受尚未提交审核的文档，不能绕过已有审核请求。

Plan 保存不透明的版本化产物引用；TaskGraph 定义和执行状态由对应模块管理。
Task Consumer 将不可变的任务图版本附加到文档，修改附件会创建新的文档版本。
批准计划不会启动执行。独立的 Workflow 准入流程会在执行前校验批准记录和任务图引用。
`registerModeControl` 允许可选 Consumer 提供范围受限的规划控制操作，
其具体实现无需加入 Plan 或 Core。

## 配置与验证

- 设置 `WISH_PLAN_ENABLED=0` 可停用 Provider 及其常规产品接线。
- 设置 `WISH_PLAN_TOOLS_ENABLED=0` 可保留 Host 能力，同时隐藏模型控制工具。
- 运行 `npm run test:plan`，验证状态、持久化、Context、工具和强制权限策略。
