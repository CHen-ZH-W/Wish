# Compaction

`src/compaction/` 是 Wish 的独立历史压缩与一次性超限恢复层。它只在 Context 已明确
返回 `context_over_budget` 后工作；Context 本身仍只负责确定性投影与预算准入。

```text
AgentLoop projection
        │
        ├─ ready ─────────────────────────────> Model
        │
        └─ context_over_budget（Model/Tool 前）
                         │
                         v
              ContextOverflowRecoveryPipeline
                         │
             Session snapshot + revision
                         │
                         v
                 Compaction planner
             oldEntries | recentEntries
                         │
            oldEntries only → Summarizer
                         │
               append-only checkpoint
                         │
               同一 Step 最多重新投影一次
```

## 当前实现

```text
src/compaction/
├── README.md
├── index.ts
├── types.ts
├── planner.ts
├── summarizer.ts
├── compaction.ts
├── recovery.ts
└── service.ts          # G6.3 Cordis owner 与 standalone helper
```

- `types.ts`：定义 Session、Summarizer、Compactor 的窄 Port 和结果 DTO。
- `planner.ts`：选择待压缩前缀与近期后缀，不生成摘要、不写 Session。
- `summarizer.ts`：把一份完整 `oldEntries` transcript 发给摘要模型。
- `compaction.ts`：协调一次 read、plan、summarize 和 append。
- `recovery.ts`：在 AgentLoop 外层执行至多一次压缩与同 Step 重投影。
- `service.ts`：注入 Sessions/Models，拥有 summarizer 与 compactor 的生产构造。

## G6.3：Cordis Service

`src/compaction/service.ts` 提供 `compaction` service。它自己的 Schemastery Config
管理 `keepRecentTokens` 和 `summaryMaxOutputTokens`，通过 Sessions 的 compaction view、
Models 的请求栈与 request counter 构造 `ModelCompactionSummarizer → SessionCompactor`。
纯 `CompactionSessionPort`、planner、summarizer、compactor 和 recovery pipeline 都不继承
或导入 Cordis。

AgentLoop service 消费 `compaction.open()` 返回的 `ContextOverflowCompactor`；
Application Service 与 facade 都不看见 compactor，也不选择 summary model
或构造 summarizer/compactor。`createCompactionResources()` 仅是显式 standalone 组合
helper，产品进程使用 service。

## Session 边界

`CompactionSessionPort` 暴露两个操作：

1. `read(sessionId)` 返回规范化 `ContextHistoryRecord[]` 和非空 revision。
2. `appendCheckpoint(...)` 以 `expectedRevision` 原子追加 summary，并由 Session 分配
   新 sequence。

具体 JSONL、数据库事务、锁和 revision 算法都属于 Session adapter。Compaction 不删除、
覆盖或重写旧记录；如果读取后 Session 已变化，append 必须失败，避免 checkpoint 覆盖
未参与摘要的新消息。

追加的 checkpoint 使用 `assistant` role 和 `coveredThroughSequence`，可以直接由现有
`HistoryContextProvider` 与 `LatestCheckpointHistoryPolicy` 消费。旧 user 消息仍保留在
Session 中；Context 会把 coverage 内的历史 user 原话逐字加入模型可见请求，因此摘要
不会取代用户原始约束。

## oldEntries 规划

规划器先规范化 sequence 和最新 checkpoint：

```text
没有 checkpoint：全部 message records
已有 checkpoint：最新 checkpoint + coverage 后的 message records
```

然后从尾部保留至少 `keepRecentTokens` 的历史。Token 数通过
`ModelInputTokenCounter` 对 `model + history messages + tools=[]` 计算；tokenizer 不可用
时返回 `input_token_count_unavailable`，不会用字符数伪造精确值。

切分单位不是单条消息：assistant Tool Call 与紧随其后的匹配 Tool Results 被视为一个
不可拆分单元。当前 `UserTurn` 的记录及其后的所有记录始终位于 recent 区域。如果没有
能够推进 coverage 的旧 message，则返回 `no_compactable_history`，不会调用摘要模型。

## 摘要请求

`ModelCompactionSummarizer` 固定构造一个请求：

- 精确的 summary model；
- 一条 developer 摘要指令；
- 一条包含全部所选 `oldEntries` 的稳定 JSONL transcript；
- `tools=[]`；
- 显式 `maxOutputTokens`。

`recentEntries`、当前用户输入、Agent system instructions、Tool schema、动态 state 和完整
最终 `ModelRequest` 都不会进入 transcript。正常路径只调用一次摘要，不默认分块、不
截断中间内容。摘要模型失败、返回空正文或尝试调用 Tool 时，checkpoint 不会写入。

## 有界恢复

`ContextOverflowRecoveryPipeline` 装饰 AgentLoop 所实现的 `StepPipeline`：

1. 首次执行 delegate。
2. 仅当结果为 `context_over_budget` 时调用 Compactor。
3. checkpoint 成功追加后，以相同 `StepSnapshot`、memory、abort signal 和 output channel
   再执行 delegate 一次。
4. 第二次仍超限时返回 `context_over_budget_after_compaction`，不再循环。

这一安全性依赖 AgentLoop 的现有契约：`context_over_budget` 在模型调用和 Tool 调度之前
产生。`model_context_overflow` 表示 Provider 路径已经开始，不会被恢复器捕获或自动
重放。其他明确终态也原样通过。

压缩不可执行时返回 `context_compaction_not_possible`；读取、摘要、并发 append 等失败
返回 `context_compaction_failed`。abort 会保持 `aborted` 终态。

## 仍在外部的能力

- Session Store 的实际持久化与 revision 事务；
- request tokenizer 的具体 Provider adapter；
- Session ID、Agent model 与可选 summary model 的上层选择；
- 持久化 checkpoint 的 UI 呈现与审计元数据；
- Provider 已开始响应后的 overflow 协调。

因此当前验证证明的是源码、类型和本地组合行为，不是 live Provider、数据库或部署证明。

## 验证

```bash
npm run typecheck
npm run test:compaction
npm run test:cordis-context
npm test
```
