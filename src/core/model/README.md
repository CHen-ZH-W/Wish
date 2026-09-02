# Model

Model 是 Wish Core 的模型调用边界，只表达规范化请求、流式事件、最终输出和
可序列化错误。它不包含任何具体网络协议或服务实现。

## 文件职责

- `types.ts`：`ModelRequest`、`ModelStreamEvent`、`ModelOutput`、
  `ModelError`，以及消息、工具 schema、usage 和模型引用 DTO。
- `model.ts`：流式 `Model` Port 和与服务无关的 `RetryingModel` 韧性装饰器。

## 流协议

一次调用由 `start` 开始，并以 `done` 或 `error` 结束。中间可以产生：

- `reasoning_delta`：增量推理内容；
- `text_delta`：增量正文；
- `tool_call`：完整、带稳定 ID 的工具调用；
- `retry`：失败尚未成为终态，调用将在等待后重试或切换候选。

`start` 明确报告实际模型、developer role 的处理模式和是否发生 authority
降级。调用方不得从模型名称或协议种类推断这些信息。`done` 携带完成原因和
usage；消费方可以据流事件构造 `ModelOutput`。

## 重试与候选切换不变量

`RetryingModel` 使用有上限的指数退避和 jitter：

1. 只有 `retryable: true` 的失败才会重试同一模型。
2. `context_overflow` 不重试同一模型，但可以切换到下一个候选。
3. 其他不可重试失败不会切换候选。
4. 一旦已经发出推理、正文或工具调用，失败立即成为终态；不得自动重放。
5. 失败若被重试或候选切换吸收，对外发出 `retry`，不先发出终态 `error`。
6. `retryCount` 在整次逻辑调用内单调递增，切换候选时不会重置。
7. 重复候选按完整 `provider/model` 身份去重，顺序保持不变。
8. abort 会终止当前调用或退避等待，不会继续下一次尝试。

模型选择应在 Run 开始时解析并固定到 `ModelRequest.model`。已经开始的 Run
不会因为外部默认值变化而改变主模型；候选切换只能使用该调用显式配置的有序
列表。

## Core 边界

以下能力位于 Core 外，通过组合根提供实现：

- 具体服务协议适配和网络请求；
- endpoint、凭据、headers 与环境配置；
- 模型目录发现、能力探测、价格与持久化；
- Context 投影、Tool 执行与授权；
- 面向用户的错误文案和传输层事件转换。

依赖方向是：外部 adapter 实现 `Model`；Context 和 Tools 生成
`ModelRequest` 所需的规范化视图；默认 `AgentLoop` 作为 Runtime 的
`StepPipeline` 组合这些能力。
Model 本身不依赖 Runtime、Context、Tools 或任何具体基础设施。
`events/event.ts` 只把规范化流事件包进统一输出 envelope，不反向参与模型
调用或重试决策。

## 验证

在 Wish 根目录运行：

```bash
npm run typecheck
npm run test:model
```
