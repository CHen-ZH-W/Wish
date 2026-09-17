# SandboxPolicy

`src/sandbox/` 是审批前的可执行性检查 seam。它不执行 Tool，也不向用户请求审批；它把
Tool 声明的 capability、当前 `WorkspaceSnapshot` / `PermissionSnapshot` 与实际
Filesystem、Shell Provider 的策略组合成一份深冻结的
`EffectiveSandboxCallPolicy`。

```text
Tool capability request
  -> Permission profile / capability ceiling
  -> SandboxPolicy.preflight()
  -> retained ApprovalRule or process-surface approval
  -> SandboxPolicy.revalidate()
  -> Core one-shot Grant
  -> Filesystem / Shell / Web Provider enforcement
```

这样，Provider 无法强制执行的请求会在弹出审批框之前失败。人的批准只表达同意，不能把
一个不可执行或无法隔离的范围变成可执行。

## 文件职责

- `types.ts`：Provider-neutral policy descriptor、preflight 结果和有效策略证明。
- `errors.ts`：SandboxPolicy 错误基类。
- `service.ts`：Cordis `sandboxPolicy` Service Definition。
- `providers/default.ts`：组合当前 `filesystem` 与 `shell` 的默认 Provider。

## 固定语义

- 每次 preflight 校验 Workspace、Permission、Filesystem、Shell 和 SandboxPolicy
  generation 是否一致。
- 纯文件请求通过 `Filesystem.preflight()` 解析，仍执行路径边界、保护名称和符号链接检查。
- 进程请求必须声明精确命令；命令、cwd、timeout、文件 scope 和网络开关通过
  `Shell.preflight()` 固定。
- Linux Native Shell 的网络权限只支持一次调用 all-or-none；hostname 级请求明确拒绝。
- 没有 `process.exec` 的 `network.connect` 请求会拒绝，因为当前 Provider 没有独立网络
  执行后端。
- `web.search` / `web.fetch` 是由受信 Service Provider 在真实 IO 边界消费 Grant 的语义
  权限，不能替代成通用 `network.connect`；两者必须同时声明 `openWorld`。
- 审批等待后及规则 durable commit 前都会重新 preflight；路径或 Provider generation
  变化时不签发 Grant。
- 有效策略证明只能由创建它的 Provider generation 使用，不能伪造或跨 Provider 复用。

SandboxPolicy 证明“当前 Provider 能否强制执行声明的最小权限”，不替代 Linux Native
Landlock/seccomp，也不拥有审批规则或 Permission profile。

显式 Host Shell 是例外的逃生口：它只接受 `full-access` profile，不把
`approval-required` 的批准误当成文件或网络隔离。选择该 profile 表示调用本身拥有宿主级
访问；默认产品图不会启用它。

## 验证

```bash
npm run typecheck
npm run test:sandbox
npm run test:permissions
npm test
```
