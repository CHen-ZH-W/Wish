# Context

Context Core 保存从上下文来源到最终 `ModelRequest` 的完整主干，但不内置容易
变化的业务策略。

```text
ContextProvider
→ ContextProviderGroup
→ ContextItemResolver
→ ContextHistoryPolicy
→ ContextItemRenderer
→ placement projection
→ ContextMessageNormalizer
→ ContextAdmissionPolicy
→ ContextBudgetPolicy
→ ContextProjection
```

这些阶段是固定的类型化调用链，不是通用 Hook。外部模块替换某个 Policy 或
Service 即可改变该阶段行为，不需要修改 Core。

## 文件职责

- `context.ts`：Context item、provider、各阶段 Policy/Service Port、pipeline
  输入和最终 projection DTO。
- `projector.ts`：按固定顺序驱动完整 pipeline，执行结构校验、显式 placement、
  cancellation 检查和不可变结果提交。

## Core 保留的机制

- provider 可以并发读取，但结果组始终保持注册顺序。
- provider ID 和最终 item ID 必须唯一；默认 resolver 对冲突 fail closed。
- `ContextHistoryPolicy` 是 history 与 summary 进入模型上下文的唯一决策点。
- item 渲染、跨消息规范化、单消息准入和预算评估各有独立接口。
- admission 严格按最终消息顺序执行，允许外部实现先归档再裁剪。
- budget 只在最终准入后的请求上评估。
- 每个异步阶段之间检查 abort。
- 输入请求和最终 projection 都不会被外部策略原地修改。

## 固定 placement

Projector 只执行 item 已经声明的 placement，不分析正文内容：

```text
原始 system/developer 前缀
→ stable_prefix
→ ContextHistoryPolicy 选出的 history
→ 原始请求的其余消息
```

`before_current_user` 放在显式 `currentUserMessageIndex` 之前。`dynamic_tail`
在当前用户是请求最后一条消息时位于其前面；进入工具循环、当前用户之后已经有
assistant/tool 消息时，它位于请求末尾。Projector 不通过角色或正文猜测哪条是
当前 UserTurn 输入。

## 外部策略负责的内容

- history checkpoint、summary 选择和用户原话保护；
- 重复 item 的覆盖、合并或优先级；
- marker 或其他模型可见包装格式；
- assistant/tool 历史的修复、补全或拒绝；
- 工具结果归档和 head/tail admission；
- tokenizer、图片成本、模型窗口和 reserve；
- over-budget 后压缩、换模型或失败的决策。

默认实现只支持无 summary 的 history 直通、item 原文渲染、消息直通和 admission
直通。出现 summary 时必须显式提供 `ContextHistoryPolicy`，避免 Core 猜测压缩
语义。未配置 `ContextBudgetPolicy` 时 projection 不伪造 Token 估值。

## 依赖方向

Context Core 只依赖 Model DTO。具体 history、状态、记忆、技能、工作区、存储、
归档和 tokenizer 实现在 Core 外实现这些 Port；默认 `AgentLoop` 负责为本 Step
提供 request、provider 集合和 abort signal，Runtime 仍只依赖通用
`StepPipeline` 契约。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:context
```
