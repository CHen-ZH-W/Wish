# Tasks

`src/tasks` 管理版本化任务定义、依赖校验、任务图冻结和任务执行状态转换。
进程启动、重试调度和 Workflow Attempt 由其他能力负责。工具是可选的 Consumer，
领域能力的实现独立于工具注册。

## 契约

- 每个 Session 拥有一组受 CAS 保护的任务图版本。编辑会追加新草稿，已有定义和结果继续保留。
  新版本从待执行状态开始。
- 每张任务图最多包含 100 个任务，任务 ID 必须唯一，依赖必须存在，且不能形成环。
  每个任务都声明角色和只读意图。超时是可选项；显式提供时校验范围为 1 毫秒至 24 小时。
  任务没有默认截止时间。
- `freeze` 检查确切的版本、digest 和批准引用。冻结后的定义不可重写。
  运行时状态转换会拒绝尚未满足依赖的任务和过期 Attempt。
  冻结的任务图携带已批准 Plan 的确切 digest。
- Workflow 拥有权威 Attempt 账本，其调度器将 Attempt 结果幂等投影到 Tasks；
  两次写入之间发生崩溃时，从 Workflow 恢复投影。尚未派发的依赖阻塞和取消使用
  带控制身份的 `projectPending`，不会伪造 Attempt。新任务图版本不会清除旧结果。
- `tasks_read` 是 Tasks 状态的独立 Consumer，在没有 Plan 时仍然可用。
  `tasks_update` 是独立的 Plan 适配器，只在 Plan 模式激活时替换草稿、使待审核请求失效，
  并把确切的任务图附加到已保存 Plan。它不能指定执行状态。
  跨模块写入不构成单个事务：中断后尚未附加到 Plan 的草稿不能通过已批准任务图的准入检查。
- Session Feature 在批准前展示 Plan 所附加的确切任务图，包括执行约束。

## 配置与验证

默认 Storage 数据域是 `tasks/sessions`，使用 KV 和进程内写入者。
任务图版本保留到所属 Session 被删除，删除 Session 会移除整个集合。
版本数量没有固定上限。CLI 和 WebUI 不能同时写入同一个数据目录。

`WISH_TASKS_ENABLED=0` 停用领域能力；`WISH_TASK_TOOLS_ENABLED=0` 只隐藏模型控制工具。
停用 Plan 会移除 `tasks_update`，但保留 `tasks_read`。
Storage Provider 接受 `backendId`，默认配置使用 file 后端。
运行 `npm run test:tasks` 和 `npm run test:workflow`，验证状态与投影行为。
