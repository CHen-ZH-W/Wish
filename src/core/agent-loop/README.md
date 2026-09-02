# Agent Loop

`AgentLoop` 是 Runtime 的默认单 Step 主干。它把已经独立实现的 Context、Model
和 Tools 连接起来，但不接管 Runtime 的双层循环。

```text
Runtime 外层：Run → UserTurn → follow-up UserTurn
Runtime 内层：UserTurn → Step → Step
                              │
                              └─ 每个 Step 调用 AgentLoop.execute

AgentLoop 单 Step：
输入与 steer → Step 环境 → Tool 快照 → Context 投影
→ Model stream → Tool Scheduler → assistant/tool transcript
→ continue 或 completed
```

## 文件职责

- `types.ts`：跨 Step memory、最终结果、输入渲染、Step 环境和 Tool Result
  渲染接口。
- `agent-loop.ts`：默认 `StepPipeline`，按固定顺序驱动一次完整 Step。

## 固定主干

每个 Step 严格执行以下顺序：

1. 首个 Step 将 UserTurn payload 渲染为明确的 `user` 消息；后续 Step 恢复
   Core-owned transcript，并按 Runtime 投递顺序追加 steer。
2. 从不可变 `StepSnapshot` 解析本 Step 的 Context、Tool authority 和请求参数。
3. 首个 Step 固定主模型；同一 UserTurn 后续 Step 不接受外部默认模型漂移。
4. 在模型调用前捕获 Registry version、authority version 和 available Tools
   的不可变执行快照。
5. 用该快照的精确 Tool descriptors 构造请求，再执行完整 Context projection。
6. Context 若返回 `rejected/over_budget` 终态，在调用模型或 Tool 前 fail closed。
7. Model stream 开始前创建 Step-local Tool Scheduler；完整 Tool Call 一到达就
   解析并提交，不等待整段模型输出结束。
8. Model 的全部规范化流事件进入 Runtime 的统一输出流。`start`、`retry`、
   content 和终态顺序由 AgentLoop 校验。
9. 模型终态后封闭 Scheduler，并等待所有已提交调用获得按提交顺序排列的结果。
10. transcript 总是先提交一条 assistant 消息，再为每个调用提交一条带相同
    `toolCallId` 的 tool 消息。
11. 有 Tool Call 返回 `continue`，由 Runtime 决定是否开启下一 Step；没有
    Tool Call 返回 `completed`。AgentLoop 自己不创建 Step，也不推进 UserTurn。

跨 Step usage 由 AgentLoop 累加。必有 token 字段直接求和；缓存读取和缓存创建
只有在每个已计入 Step 都报告时才求和，否则聚合值保持 unknown（省略字段）。
不同来源合并为 `mixed`，价格与费用仍由 Core 外的 Models 层负责。

即使本 Step 已得到普通模型答案，Runtime 在执行期间收到 steer 时仍可强制开启
下一 Step。`completed` 结果因此也携带更新后的 memory，保证下一 Step 能看到刚才
的 assistant 输出和新 steer。

## 明确的外部缺口

- `AgentLoopInputRenderer`：把产品 payload 和 steer 转成规范化 user 消息。
- `AgentLoopEnvironmentResolver`：从 Step snapshot 得到已解析模型、Context
  provider 输入、Tool context、authority version、可用 Tool 和请求参数。
- `Model`：具体服务调用与协议适配。
- `ContextProvider` 及 Context 的窄 Port：history/summary 选择、Tool Result
  归档/可见副本和预算评估。
- `ToolRegistry` 注册项、授权服务、执行生命周期及 Scheduler 的具体组装。
- `AgentLoopToolResultRenderer`：可选的模型可见结果呈现；默认是完整
  `ToolResult` JSON，并强制保留 `role=tool` 和调用 ID 配对。

这些接口对应固定阶段，不是任意时机可插入的通用 Hook。Provider、存储、具体
Tool、审批界面、Sandbox、Workflow、Memory、Skill 和传输层仍位于 Core 外。

## 事件和错误

- Runtime transition、Model stream 和 Tool lifecycle 共用一个 Run 内单调递增
  的 `OutputEvent.sequence`。
- 输出发布是诊断通道，失败不会改变模型或 Tool 的执行决策。
- 权威 Tool lifecycle 仍由 `ToolExecutionLifecycle` 负责，不由输出事件替代。
- 模型 `error` 保留稳定错误码和 retryable；缺少终态、终态前缺少 `start`、
  content 后 retry、重复 Tool Call ID 等协议错误会明确失败。
- AgentLoop 不重试模型，也不重放已 dispatch 的 Tool；模型韧性由 `Model`
  装饰器负责，外部动作恢复由 Tool lifecycle/recovery contract 负责。

## 依赖方向

```text
外部 composition root
  ├─ 实现 Model / ContextProvider / authorization / concrete Tools
  └─ 组装 Runtime(stepPipeline = AgentLoop)

Agent facade → Runtime → StepPipeline contract
                         ↑
AgentLoop → Context + Model + Tools + Runtime DTO + Events channel

Context / Model / Tools / Runtime 不依赖 AgentLoop
```

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:agent-loop
npm test
```
