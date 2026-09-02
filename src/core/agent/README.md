# Agent facade

`Agent` 是 Wish Core 面向调用方的薄门面，只提供三个动作：

- `startRun(input)`：启动一个 Runtime 拥有的 Run。
- `control(runId, control)`：向活动 Run 提交控制命令。
- `observe(runId, options)`：订阅或续接该 Run 的输出事件。

## 文件职责

- `types.ts`：公开且与传输无关的 DTO，包括 `AgentDefinition`、
  `RunInput`、`RunHandle`、`ObserveOptions` 和 `AgentProtocol`。
- `agent.ts`：参数边界校验、scope 规范化以及到
  `AgentRuntimeService` 的委托。

Agent 不实现主循环，不持有可变 Run 状态，也不决定终态、重试、事件
保留、控制排队或授权。上述行为分别属于后续的 Runtime、Event、Model、
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

## 当前阶段边界

本阶段完成 Agent facade 及公共 DTO，但尚未实现
`runtime/runtime.ts`、`runtime/control.ts` 和 `events/event.ts`。因此这里的
单元可以独立编译和验证委托契约，但完整 Agent Run 暂时不能端到端执行。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm test
```

Agent 验收覆盖 startRun 规范化与透传、control 路由、observe 隔离、公共
参数拒绝，以及 Runtime 错误不被 facade 吞掉或改写。
