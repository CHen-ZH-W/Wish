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
- `workspace-write`：只有 path-scoped Linux Native Shell 可启用；仅
  `enter_plan_mode` 与 `exit_plan_mode` 的 Tool 调用请求审批，其余 Tool 调用在能力上限、
  业务策略和 SandboxPolicy 检查通过后自动放行。工作区外路径等不可执行范围仍会被拒绝。
- `full-access`：不审批并退出工作区、网络和环境变量隔离。Native Provider 只在这一个显式
  profile 下绕过 Landlock/seccomp；其他 profile 仍进入强制隔离路径。

WebUI 的权限选择由 Permissions 自己拥有：通用设置保存“之后创建的 Session”的默认值，
新建会话 composer 可在首个 Run 前覆盖它，现有会话 composer 修改该 Session 的持久选择。
Application 在新 Run 入场时把选择固定进 `WishRunPayload`；同一 Run 的后续 UserTurn、引导和
已排队消息继续使用已固定的 profile，只有下一次新 Run 才读取 Session 的新选择。没有持久
选择的历史 Session 继续使用部署时的 Agent/default profile，不会被后来修改的通用默认值
追溯改变。

可选项来自当前 Shell policy，而不是前端常量。Linux Native 只公开 `read-only`、
`approval-required`、具有 path-scoped 强制保护的 `workspace-write`，以及明确标注“无隔离”的
`full-access`。Host Shell 图仍只公开 `full-access`。因此安全档位与逃生档位在界面和执行路径
上保持可区分。

能力上限是 Agent 的硬 ceiling，审批不能越过。`authorityVersion` 绑定 Agent、Session、
Run、UserTurn、Step、工具集合、能力上限、Workspace fingerprint/revision 和 Filesystem
policy version、Shell policy version 和 SandboxPolicy version。

授权顺序固定为：先检查 profile 与 capability ceiling，再调用 SandboxPolicy preflight，
然后匹配 ApprovalRule 或询问当前进程表面。无法由当前 Provider 强制执行的范围不会弹出
审批。批准 `once` 只作用于本次调用；`run/session/workspace` 在 Core 最终 snapshot 检查
之后、Grant 签发之前提交到 ApprovalRuleStore。

规则复用仍会重新 preflight，并精确绑定 profile、policy、Tool、capability digest、Agent、
Workspace，以及 scope 所需的 Run/Session 身份。任何查找、持久化或复核错误都 fail closed。

本模块不扫描文件、不执行命令。Session profile 通过模块自有的 Storage Domain 持久化；
Filesystem/Shell/Web Provider 消费
同一个 Permission Snapshot 和 `CapabilityAuthorizationGrant` 完成执行点校验，不依赖
Tool Core；Tool 只是当前 Grant subject 的一种来源。ApprovalRuleStore 通过独立 Storage
Domain 保存长期规则，相关契约和 Provider 收纳在 `src/permissions/rules/`。
