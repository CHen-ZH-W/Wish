# Agent facade

`Agent` 是 Wish Core 面向调用方的薄门面，只提供三个动作：

- `startRun(input)`：启动一个 Runtime 拥有的 Run。
- `control(runId, control)`：向活动 Run 提交控制命令。
- `observe(runId, options)`：订阅或续接该 Run 的输出事件。

## 文件职责

- `types.ts`：公开且与传输无关的 DTO，包括 `AgentDefinition`、
  `RunInput`、`RunHandle`、`ObserveOptions` 和 `AgentProtocol`。
- `agent.ts`：参数边界校验、scope 规范化、公开 DTO 快照以及到
  `AgentRuntimeService` 的委托。
- `service.ts`：Cordis `agents` Service，拥有默认 Agent 定义、生产构造与生命周期。

Agent 不实现主循环，不持有可变 Run 状态，也不决定终态、重试、事件
保留、控制排队或授权。上述行为分别属于 Runtime、Event、Model、
Context 和 Tool 模块。

## 关键契约

1. `scope` 去除首尾空白后必须非空；活动 scope 的唯一性由 Runtime 保证。
2. Agent、Run 和 Parent Run ID 必须非空且不得带首尾空白。
3. `RunHandle` 是不可变描述符，不暴露 Runtime controller。
4. 停止观察只影响 observer；终止 Run 必须提交显式 abort control。
5. facade 不解释 control、output event 或 completion。它们通过
   `AgentProtocol` 由各自的 Core owning module 定义。
6. Runtime 抛出的活动 scope 冲突、未知 Run、终态拒绝等结果原样返回，
   facade 不吞掉或改写。
7. Agent 在构造和 `startRun` 边界递归复制并冻结 plain object/array DTO，
   防止调用方后续修改 definition、metadata 或 payload，改变已提交语义；
   非 plain object 被视为不透明能力对象，不由 Agent 解释或改写。

## 当前阶段边界

Agent facade 与公共 DTO 已完成，并通过 `AgentRuntimeService` 接入 Runtime。
`agent.ts` 和 `types.ts` 仍只依赖最小契约；同目录 `service.ts` 注入 `runEngine`，调用
当前 Runtime generation 后构造默认 Agent。Agent 实际消费的是同代 `RunGeneration` 的
窄 Runtime surface；`ApplicationFacade` 只消费已经构造好的 Agent，不拥有 Agent
或 Runtime 构造权。

## Cordis 生命周期与配置

Loader stable id 是 `agents`，Context 能力键同样是 `agents`。Config 拥有默认 Agent 的
`agentId` 和单条系统 `agentInstructions`；内置 profile 把兼容环境变量
`WISH_AGENT_ID`、`WISH_AGENT_INSTRUCTIONS` 显式映射到这个条目。

缺少 `runEngine` 时 Agents 保持 PENDING。Runtime 或 Agents generation 更新、禁用或消失
时，`application → surface` 会被释放；旧 `RunGeneration` 关闭准入、取消并排空其
活动 Run 后，才使用新 Agent 定义重新激活。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:agent
npm run test:cordis-agent
npm test
```

Agent 验收覆盖 definition/RunInput 快照、startRun 规范化与透传、control
路由、observe 隔离、公共参数拒绝，以及 Runtime 错误不被 facade 吞掉或
改写。
