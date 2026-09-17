# Approval

Approval 是人工审批的 Cordis 生命周期 Hub。它只负责把策略层发出的请求转交给当前
进程表面（CLI、WebUI 或嵌入方），并运输用户选择的 `once/run/session/workspace` scope；
它不决定哪些操作需要审批，也不持久化规则。

- `types.ts`：UI 无关的请求答复 Port 与注册句柄。
- `service.ts`：注册唯一具名进程表面；随调用插件卸载自动注销。同一 surface ID 可显式
  开启 generation replacement：新代暂时覆盖旧代，失败卸载时自动恢复旧 answerer。旧代
  已接收但尚未回答的请求会立即取消；其迟到的 allow 不会跨 generation 生效。
- `errors.ts`：重复注册等生命周期错误。

没有 answerer 时 Hub 明确返回拒绝。审批是否可转化为执行 Grant、是否可复用以及何时
durable commit，由 Permissions、SandboxPolicy、ApprovalRuleStore 和 Core ToolExecutor
继续校验。旧 answerer 省略 scope 时按 `once` 处理。

Hub 为每个在途请求创建内部 AbortSignal。调用方中止时保留原 abort 原因；answerer 被替换或
注销时返回明确 denial，即使具体 UI 忽略 abort 或永不结束，也不会阻塞 Provider 卸载。
