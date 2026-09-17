# Tools

Tools Core 保存从模型 Tool Call 到执行结果的完整机制主干，不包含任何具体
Tool、审批界面、Sandbox、存储或产品策略。

```text
UnparsedToolCall
→ ToolRegistry.parseCall
→ ToolExecutionSnapshot 检查
→ resolveCapabilities
→ ToolAuthorizationService.authorize
→ ToolAuthorizationService.revalidate
→ 再次核对 Registry/Step snapshot
→ Core 签发一次性 ToolAuthorizationGrant
→ lifecycle.markDispatched
→ ToolDefinition.execute
→ ToolResult
```

多调用由 `BoundedToolScheduler` 驱动：

```text
begin
→ submit(call) ...
→ close
→ 按提交顺序返回全部结果
```

## 文件职责

- `tool.ts`：`ToolDefinition`、`ToolCall`、`ToolResult`、错误、执行快照和
  recovery metadata。
- `registry.ts`：注册、注销、稳定顺序查询、输入解析、能力解析和 Step 快照。
- `authorization.ts`：最小能力模型、typed decision、统一 `ToolClock`、执行前
  复核以及 Core 签发的一次性 Grant。
- `executor.ts`：单调用的 prepare、授权、dispatch、execute、finish 和事件生命周期。
- `scheduler.ts`：流式调用接收、有界并发、串行屏障和稳定结果顺序，也是
  `wish/core/tools` 的公共入口。

## Core 不变量

1. Tool 名称在一个 Registry 中唯一，查询顺序等于注册顺序。
2. Tool 参数必须先通过 JSON object 解析和具体 Tool 的 typed parser。
3. 无效或未注册调用也产生一个稳定 `ToolResult`，不会被调度器静默丢弃。
4. 模型只能调用当前 `ToolExecutionSnapshot.availableTools` 中的 Tool。
5. Registry 版本变化会使旧 Step 快照失效；能力扩张必须等到下一 Step。Core
   不只在授权前检查，还会在授权等待结束、Grant 签发前重新检查，并在真正调用
   definition 前校验 Grant 绑定版本。授权期间或 dispatch 边界发生同名替换也不会
   执行新 definition。
6. 每个具体 Tool 必须声明最小 `ToolCapabilityRequest`，不存在静态 risk 到
   全权限的兼容降级。
7. 授权服务必须执行 `authorize` 和 dispatch 前 `revalidate`。策略版本变化
   会 fail closed。
8. Grant 由 Core 签发，绑定 call、Tool、策略版本、authority version 和
   Registry version，只能激活和消费一次。
9. Tool event 时间、Grant 的 `issuedAt/expiresAt` 和激活期间的过期校验共用同一
   `ToolClock`；测试或宿主可以注入时钟，但不能让签发和消费使用不同时间源。
10. `ToolExecutionLifecycle` 是权威 Port；prepare、markDispatched 或 finish
   失败会阻止或失败调用。生产实现由 Runtime-owned
   `core/runtime/durability` authority 提供，因此 Tool 的副作用边界与父 Run 使用
   同一 Journal；Tools Core 不依赖该具体实现。
11. `ToolEventPublisher` 是诊断 Event Port，发布失败不改变执行结果。
12. Scheduler 默认最多并行 8 个 parallel 调用；sequential 调用是前后严格屏障。
13. abort 后不再实际 dispatch 尚未开始的 Tool，但每个已提交调用仍返回结果。
14. 结果顺序始终按模型调用顺序，而不是按完成时间。
15. Core 不自动重放已 dispatch 的调用；`recoveryPolicy` 明确区分
    `retry-safe`、`resumable`、`needs-reconciliation` 和 `terminal-failed`。

## Core 外的能力

- 具体 Tool schema、parser、能力解析和 execute 实现；
- 审批规则、用户交互和规则持久化；
- Sandbox 后端及其真实资源强制；
- Tool lifecycle authority 的 Journal Provider，以及结果归档的文件、数据库或远端实现；
- Tool Result 裁剪、模型消息渲染和用户界面展示；
- Workflow、Memory、Skill 或其他业务 Tool 集合。

外部授权或 Sandbox 实现可以在执行副作用前调用
`assertActiveToolAuthorizationGrant()`，验证 Grant 仍处于本次调用的动态执行范围。

## 模块边界

Tools Core 拥有注册、授权、单调用执行和多调用调度主干。
`agent-loop/AgentLoop` 通过 Step-local Event Port 把 Scheduler 接入 Runtime，
形成 Context → Model → Tools → next Step 的默认闭环；Tools 本身不反向依赖该
组合层。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:tools
```
