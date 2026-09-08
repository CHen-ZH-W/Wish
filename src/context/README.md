# Context

`src/context/` 是 Wish Core Context Port 的实际实现层。它读取已经解析、规范化的
外部事实，再交给 `core/context` 的固定 projector 生成最终 `ModelRequest`。

Context 的职责是确定性投影与预算准入，不是上下文压缩：

```text
Session adapter ──规范历史──┐
Workspace/Runtime ──已解析事实──┼─> Context providers/services
Models adapter ──窗口与请求前计数─┘             │
                                                v
                                      core ContextProjector
                                                │
                                      ready | over_budget | unknown
```

`over_budget` 只是一项明确终态。外部组合层之后可以调用独立的 Compaction 模块，
让它针对历史 `oldEntries` 生成 checkpoint，再重新投影一次。Context 不生成摘要、
不修改 Session，也不把整个最终模型请求交给 Compaction。

## 当前进度

六个增量步骤已经完成：集成 Port、History、Instructions、State、History Policy、
Tool Result archive-first admission、请求前 Budget Evaluator，以及可直接交给
AgentLoop 的最终组合入口都已实现。Context 模块不会在超限时自行压缩。

当前契约包括：

- `ContextInput`：一次 Step 的 Run/UserTurn/Step/Session 身份、完整模型身份，以及
  组合层已经解析的 workspace/runtime facts。
- `ContextHistorySource`：按 Session ID 读取规范化记录，不暴露文件路径、JSONL、
  数据库行或其他持久化细节。
- `ContextHistoryRecord`：使用 Session `sequence` 表达普通消息或带
  `coveredThroughSequence` 的 summary；存储与 UI 元数据不会进入该 DTO。
- `ToolResultArchivePort`：在 renderer 丢失结构化信息之前保存完整 Core
  `ToolResult`，并返回稳定的 `locator` 与 `hash`。
- `ModelInputTokenCounter`：只统计最终 `ModelRequest` 的输入 token；模型或 tokenizer
  不可用时返回 `undefined`，Budget Evaluator 会明确报告 `unknown`。
- `ModelContextWindowSource`：按请求中的完整 `provider/model` 身份读取已经配置的
  context window；不让 Context 依赖 Models 配置或 Catalog DTO。
- `ContextConfiguration`：明确 output reserve、单项 Tool Result admission 参数和
  provider 注册顺序。

当前目录：

```text
src/context/
├── README.md
├── context.ts
├── index.ts
├── types.ts
├── providers/
│   ├── history.ts
│   ├── instructions.ts
│   └── state.ts
└── services/
    ├── history-policy.ts
    ├── tool-results.ts
    └── budget.ts
```

## History 投影

`HistoryContextProvider` 从 `ContextHistorySource` 读取完整规范事实，按 Session
`sequence` 检查重复、排序并生成稳定 item ID。它只复制 `role`、`content`、
`contentParts`、`reasoningContent`、`toolCalls` 和 `toolCallId`；时间、存储版本、事件
与 UI 元数据即使出现在运行时对象中也不会进入 `ModelMessage`。

Tool Result 的 archive receipt 是唯一例外，但它不是模型字段：Session adapter 可把
`toolResultArchive` 作为消息记录旁的结构元数据提供；History Provider 只在 Context
内部恢复 receipt，最终 admission 无论是否裁剪都会将其剥离，Provider 请求看不到
内部字段。

属于当前 `userTurnId` 的记录会被排除，因为当前用户输入和本 UserTurn 的活动
transcript 由 AgentLoop 请求本身提供。Session adapter 应在规范记录上保留
`userTurnId`，Context 不依赖 Session 的文件格式来完成这项判断。

中断历史在模型可见副本中按确定性规则修复：

- 孤立或重复的 Tool Result 被丢弃。
- assistant Tool Call 后的结果按调用声明顺序紧邻排列。
- 缺失结果生成带原 `toolCallId` 和 `missing_tool_result` 的确定性 Tool Message。
- assistant Tool Call 与所有结果形成不可拆分单元；checkpoint 不得切开它。

修复不会回写 Session。Core item 的连续 `sequence` 表示修复后的稳定投影顺序；item
ID 继续包含原 Session sequence，保证相同 Session 输入产生相同结果。

`LatestCheckpointHistoryPolicy` 检查重复投影 sequence、非法 coverage、倒退的
checkpoint 和被 checkpoint 切开的 Tool 单元。没有 summary 时选择完整合法历史；
存在 summary 时固定选择：

```text
最新有效 summary
→ coverage 内所有原始 user 消息（正文完全不变）
→ coverage 后的非 summary 历史
```

旧 summary 和 coverage 内的 assistant/tool 历史不会进入最终请求。选择 metadata
会明确列出受保护 user sequence；后续预算实现必须把这些消息视为不可静默删除的
压缩下限。如果它们自身超过窗口，应报告不可继续压缩，而不是丢弃用户约束。

## Instructions 与 State

`InstructionsContextProvider` 固定输出顺序为 Agent 基本指令、workspace 指令。所有
item 都使用 `kind=instruction`、`placement=stable_prefix`，authority 必须明确为
`system` 或 `developer`。Agent 指令由组合根在构造 Provider 时传入并立即复制；
workspace 指令则从每次 `ContextInput` 的已解析快照读取。

Provider 不扫描文件，也不读取 Session、Memory 或 Skill。显式数组顺序具有语义，
不会按正文或文件名重新排序；重复 ID、空正文和不合法 authority 会 fail closed。

`StateContextProvider` 每次 `provide` 都重新读取当前输入，输出一条
`developer/state/dynamic_tail` item，内容只包含：

- cwd 与快照时间；
- Run ID 和 state version；
- UserTurn ID/ordinal；
- Step ID/ordinal。

它不缓存旧状态、不访问 Runtime 对象，也不接受任意 `Record<string, unknown>`。
相同输入得到字节级相同的 JSON 投影；变化后的 Step 输入会产生新的动态状态正文。

Tool Result admission 的默认固定值是：

```text
thresholdChars = 8192
headChars      = 4096
tailChars      = 1024
```

三个数作用于每一个 Tool Result，不是整段历史。完整结果必须先成功归档，再生成模型
可见副本；归档失败时不得裁剪。

## Tool Result archive-first admission

这一阶段由两个明确接缝组成：

```text
完整 Core ToolResult
  → createArchivingToolResultRenderer
  → ToolResultArchivePort（必须成功，接收 abort signal）
  → delegate renderer
  → Tool Message + 内部 archive receipt
  → AgentLoop memory / Session 规范记录
  → ContextToolResultAdmissionPipeline
  → 干净的模型可见 Tool Message
```

renderer decorator 先把仍含完整 `output`、`error`、`artifact` 等结构的结果交给外部
Archive Port；只有取得非空 `locator/hash` 后才调用 Basic Tools 或其他 delegate
renderer。失败或中止会直接阻断渲染，不会制造一个假装已归档的 Tool Message。

receipt 使用 `schemaVersion + toolCallId + locator + hash`，用于跨 AgentLoop Step；
Session adapter 若要在未来 Run 中恢复相同能力，应把它保存到
`ContextHistoryMessageRecord.toolResultArchive`。receipt 不拼入 Tool 正文，也不是
Provider 协议字段。

`ContextToolResultAdmissionPipeline` 对每一条 Tool Message 单独计算：纯文本结果按
`content` 计算；含 `contentParts` 的结果按完整模型可见 payload 的稳定 JSON 计算。
超过 8192 chars 且存在合法 receipt 时，保留前 4096 和后 1024 chars，生成包含
`originalChars`、`retainedChars`、`omittedChars` 与 archive `locator/hash` 的 JSON
正文，并保留原 `toolCallId`。其他消息不受影响。

没有 receipt 的结果即使超过阈值也保持完整，仅剥离未知内部字段。这条 fail-safe
规则保证 Context 不会把“Core 调用了 `archive()` gate”误当成“完整 executor 结果
已经被持久化”。

当前本地组合可使用
`storage/tool-results/file-tool-result-archive.ts`。它在 renderer 裁剪前深复制完整
`ToolResult`，以 Session、调用身份和结果 SHA-256 生成稳定路径，使用 `0600` 临时文件、
`fsync` 和原子 rename 提交。相同调用与相同结果幂等返回同一 receipt；已有文件损坏或
身份不一致时 fail closed。Archive 不追加 Session transcript；组合层仍需把返回的
receipt 与 Tool Message 一起交给 Sessions。

## 请求前预算

`ModelContextBudgetEvaluator` 只评估 Core 完成全部 placement 和 Tool Result admission
后的最终 `ModelRequest`：

```text
request.model（完整 provider/model）
  → ModelContextWindowSource.getContextWindowTokens
最终 ModelRequest
  → ModelInputTokenCounter.count
inputLimit = contextWindowTokens - reservedOutputTokens
  → within_budget | over_budget | unknown
```

Models 的 request-only tokenizer 必须自行覆盖正文、reasoning、Tool Call 参数、Tool
schema、图片等真实 Provider 输入成本；Context 不复制 tokenizer 算法，也不使用字符
数启发式伪造 Token。`estimatedInputTokens <= inputLimitTokens` 是
`within_budget`，超过一 Token 即为 `over_budget`，并由 Core 返回不可直接调用模型的
`rejected` 终态。

模型窗口缺失时返回 `unknown/context_window_unavailable`，该模型的请求前 tokenizer
缺失或不可用时返回 `unknown/input_token_count_unavailable`。两种情况都不伪造数值；
Core 当前保留 `ready + unknown`，由外部产品策略决定是否允许调用。非法窗口、负计数
或 `reservedOutputTokens >= contextWindowTokens` 是契约/配置错误，会 fail closed。

窗口来自 `ConfiguredModel` 已加载的精确 `ModelSpec`，不是请求热路径外的远程 Catalog
同步。计数调用接收同一个 abort signal；中止不会降级成 `unknown`。

## AgentLoop 组合入口

`createContextBundle` 一次组装同一套 Context 能力：

- `ContextProjector`；
- `instructions → history → state` 默认 Provider 注册顺序；
- `LatestCheckpointHistoryPolicy`；
- `ContextToolResultAdmissionPipeline`；
- `ModelContextBudgetEvaluator`；
- archive-first Tool Result renderer decorator。

额外来源继续实现 Core `ContextProvider<ContextInput>`，由
`additionalProviders` 注册；默认追加在内置 Provider 后，也可以通过完整、无重复的
`providerOrder` 显式排序。Provider 注册顺序可观察，但消息最终位置仍由 Core 的
`placement` 规则决定。

组合层对每个 Step 从外部解析 Session ID、精确模型和 workspace facts，再让 bundle
从不可变 `StepSnapshot` 复制 Runtime 身份与版本：

```ts
const context = createContextBundle({
  history,
  agentInstructions,
  archive,
  models,
  counter,
  configuration: { reservedOutputTokens: 8_192 },
});

const loop = new AgentLoop({
  context: context.projector,
  toolResults: context.createToolResultRenderer({
    delegate: basicToolResultRenderer,
    resolveSessionId: ({ snapshot }) => sessionIdFor(snapshot),
  }),
  environment: {
    resolve({ snapshot }) {
      const model = modelFor(snapshot);
      return {
        model,
        context: context.forStep({
          snapshot,
          sessionId: sessionIdFor(snapshot),
          model,
          workspace: workspaceFactsFor(snapshot),
        }),
        tools: toolEnvironmentFor(snapshot),
      };
    },
  },
  // model / tools / toolScheduler / input 由组合根提供
});
```

同一 Step 的 environment 与 Tool Result renderer 必须解析到同一个 Session ID。
`forStep` 会复制并冻结 `model`、workspace instructions 和 Runtime facts，后续外部对象
变化不会改变该 Step 的 Context 输入。Bundle 只提供组合所需对象：它不启动
AgentLoop、不调用模型、不写 Session，也不生成摘要。

## 依赖边界

`src/context` 可以依赖 Core 的 Model、Runtime 和 Tool DTO，并为 Core Context 的窄
Port 提供实现。它不能依赖具体 Session Store、文件系统、数据库、Memory、Skill、
Workflow、Sandbox 或 Provider 协议实现。

事实来源保持单向：

```text
Session / Models / Storage implementation
              │ implements adapters
              v
         src/context
              │ supplies Core ports/items
              v
      src/core/context
```

`ContextWorkspaceFacts` 和 `ContextRuntimeFacts` 使用显式字段，不提供可无限扩张的
`Record<string, unknown>` 隐藏扩展口。每个 Step 由组合层重新构造输入快照，Context
不缓存旧的 cwd、时间或 Runtime 状态。

## 后续边界

`src/context` 的计划能力已经收口。相邻的独立 `src/compaction` 模块现已处理一次有界的
`context_over_budget` 恢复；它通过 Session Port 追加 checkpoint，再让同一 Step 重新
投影一次。Context 仍不导入 Compaction，也不自行生成摘要。

Session Store、Memory、Skill 和 Workflow 不会放进本目录。

## 验证

```bash
npm run typecheck
npm run test:context-history
npm run test:context-providers
npm run test:context-tool-results
npm run test:tool-result-archive
npm run test:context-budget
npm run test:context-bundle
npm test
```
