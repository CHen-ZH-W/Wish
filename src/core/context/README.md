# Context

Context Core 保存从上下文来源到可执行 `ModelRequest` 的稳定主干。它负责不可绕过
的结构规则，只把真正依赖产品或模型的能力留给外部实现。

```text
ContextProvider（并发读取，按注册顺序收集）
→ provider/item 校验与唯一性检查
→ ContextHistoryPolicy（仅选择已有 history/summary）
→ 固定 placement
→ assistant/tool transcript 合法性检查
→ Tool Result：归档完整原文 → 生成模型可见副本
→ 再次检查 transcript 与当前用户消息
→ 构造不可变 ModelRequest
→ ContextBudgetEvaluator
→ ready | rejected(over_budget)
```

这是一条固定 pipeline，不是可在任意位置插入行为的通用 Hook。

## 文件职责

- `context.ts`：Context item、provider、三个窄能力接口和 projection 终态 DTO。
- `projector.ts`：驱动完整 pipeline，执行 placement、校验、归档顺序、预算终态、
  cancellation 检查和不可变提交。

## Core 固定保证

- provider 可以并发读取，但 provider group 始终保持注册顺序。
- provider ID 和最终 item ID 必须唯一；冲突直接 fail closed。需要覆盖或合并时，
  外部 provider 必须在进入 Core 前先形成唯一结果。
- `ContextHistoryPolicy` 只能从 provider 已给出的 history/summary 中选择和排序，
  不能借此重写消息或凭空增加 history。
- 每次投影必须显式给出 `currentUserMessageIndex`。该位置必须是 `user` 消息，且
  投影完成后仍恰好存在一次、正文和结构均未改变。
- 最终 assistant/tool 历史必须配对：Tool Result 不能孤立、重复、错配，也不能在
  未补齐 assistant Tool calls 时插入其他角色消息。
- 如果配置 `ContextToolResultPipeline`，Core 先把完整、不可变的 Tool Result 交给
  `archive` 并等待成功，再调用 `toModelMessage` 生成模型可见副本；归档失败时绝不
  进入裁剪阶段。可见副本必须保留 `role=tool` 和原 `toolCallId`。
- 未配置 Tool Result pipeline 时，Core 保留完整结果，不会在没有归档的情况下
  自行裁剪。
- 预算只评估最终模型可见请求。`over_budget` 不会返回可直接调用 Model 的
  `request`，而是返回 `rejected` 以及仅供后续决策使用的 `candidateRequest`。
- 未配置预算评估器时，结果明确为 `ready + budget.status=unknown`，不伪造 Token
  数量。
- 输入、Port 入参和最终 projection 均使用不可变快照；每个异步边界检查 abort。

## 固定 placement

Projector 只执行 item 已声明的 placement，不分析正文内容：

```text
原始 system/developer 前缀
→ stable_prefix
→ ContextHistoryPolicy 选出的 history
→ 原始请求的其余消息
```

`before_current_user` 位于显式当前用户消息之前。`dynamic_tail` 在当前用户是请求
最后一条消息时位于其前面；进入 Tool 循环、当前用户之后已有 assistant/tool
消息时，它位于请求末尾。

## 外部能力缺口

- `ContextProvider`：读取 history、指令、状态或引用，并直接给出带 authority 和
  placement 的 `ContextItem`。
- `ContextHistoryPolicy`：决定 summary/checkpoint 与原始 history 的选择；默认只
  允许没有 summary 的 history 原样进入。
- `ContextToolResultPipeline`：实现原始结果的持久化，以及具体阈值、head/tail、
  artifact 引用等模型可见策略。Core 只保证调用顺序和配对不变量。
- `ContextBudgetEvaluator`：实现 tokenizer、图片成本、模型窗口和 output reserve
  计算。
- `rejected(over_budget)` 之后的压缩、换模型或结束 Run，由 AgentLoop 或外部组合
  决策负责；Context 不猜测产品策略。

Item 的内容渲染已由 provider 完成；历史合法性、唯一性和当前用户保护不是可替换
策略。因此 Core 不再提供通用 ItemResolver、ItemRenderer、MessageNormalizer 或
AdmissionPolicy。

## 依赖方向

Context Core 只依赖 Model DTO。具体 history、状态、记忆、技能、工作区、存储、
归档和 tokenizer 在 Core 外实现窄 Port；默认 `AgentLoop` 提供 request、provider
集合和 abort signal，并消费 `ready/rejected` 终态。Runtime 仍只依赖通用
`StepPipeline` 契约。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:context
npm run test:agent-loop
```
