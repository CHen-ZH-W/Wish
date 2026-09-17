# Permissions

Permissions 是 Tool Capability 与具体执行后端之间的策略 seam。Provider 在每个 Step
开始时把 Agent 配置、运行身份和 Workspace Snapshot 解析成一个深冻结的
`PermissionSnapshot`；Core ToolExecutor 通过通用 Capability authority 发放并消费一次性
Grant。

可选业务模块通过 `registerPolicy()` 注册单调策略贡献：Step projection 只能缩小 Tool 与
capability ceiling，调用时策略只能拒绝，不能绕过 profile、SandboxPolicy 或审批。贡献集
generation 和每份领域 revision 都进入 `PermissionSnapshot`；插件卸载或模式状态改变会在
authorize/revalidate/commit 三个执行前检查点 fail closed。Plan 与 Coordinator 使用这条
通用接口实现“收紧立即生效、放宽下一 Step 生效”，Permissions 不导入这些业务模块。

Snapshot 同时提供 `delegation`（委派范围），与当前 Agent 的直接执行范围分开。默认情况下，
每份策略的直接限制也限制委派；策略可显式声明自己的委派投影，但仍只能缩小 Host 基础
Tool/capability 集合，并与所有其他策略取交集。Coordinator 因此可以禁止自身直接写文件，
同时委派 Host 允许的写任务；只读 Host、其他策略和审批边界均不能因此被越过。两种范围
共同进入 `authorityVersion`，业务 Tool 无权自行放宽。

当前内置 Provider：

- `read-only`：自动允许只读能力；只读 scope 的进程命令可审批，write/network/Web/
  external side effect 与 runtime control 是不可由审批越过的硬边界。
- `approval-required`：自动允许普通只读能力，其他能力请求审批。
- `workspace-write`：只有 path-scoped Linux Native Shell 可启用；工作区内普通读写与命令
  自动放行，`web.search` / `web.fetch` 等开放世界 capability 仍请求审批。
- `full-access`：只有显式启用的 Host Shell 可用；默认 Native 图会明确拒绝该 profile。

能力上限是 Agent 的硬 ceiling，审批不能越过。`authorityVersion` 绑定 Agent、Session、
Run、UserTurn、Step、工具集合、能力上限、Workspace fingerprint/revision 和 Filesystem
policy version、Shell policy version 和 SandboxPolicy version。

授权顺序固定为：先检查 profile 与 capability ceiling，再调用 SandboxPolicy preflight，
然后匹配 ApprovalRule 或询问当前进程表面。无法由当前 Provider 强制执行的范围不会弹出
审批。批准 `once` 只作用于本次调用；`run/session/workspace` 在 Core 最终 snapshot 检查
之后、Grant 签发之前提交到 ApprovalRuleStore。

规则复用仍会重新 preflight，并精确绑定 profile、policy、Tool、capability digest、Agent、
Workspace，以及 scope 所需的 Run/Session 身份。任何查找、持久化或复核错误都 fail closed。

本模块不扫描文件、不执行命令，也不直接实现存储。Filesystem/Shell/Web Provider 消费
同一个 Permission Snapshot 和 `CapabilityAuthorizationGrant` 完成执行点校验，不依赖
Tool Core；Tool 只是当前 Grant subject 的一种来源。ApprovalRuleStore 通过独立 Storage
Domain 保存长期规则，相关契约和 Provider 收纳在 `src/permissions/rules/`。
