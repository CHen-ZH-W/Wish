# Events

`event.ts` 定义 Wish Core 的统一事件 envelope，以及 Runtime 使用的有界
进程内事件流。

## 契约

- 每个 Run 的事件 `sequence` 从 1 单调递增。
- `afterSequence` 只返回指定序号之后的事件。
- 缓冲区有固定上限；游标落后于最早可用事件时明确抛出
  `EventCursorExpiredError`，不会静默丢事件。
- 事件和顶层 payload 均由发布方按只读契约提供。
- observer 使用独立 `AbortSignal`，停止观察不会控制或取消 Run。
- 关闭流后，observer 读完仍保留的事件并正常结束。

`OutputEvent` 统一包含 Runtime transition、规范化 Model stream 和 Tool
lifecycle。Runtime 为每个 Step 绑定 `StepOutputPublisher`，三类事件共享同一个
Run 内 sequence；事件统一不会改变 Runtime 的双层循环职责。
